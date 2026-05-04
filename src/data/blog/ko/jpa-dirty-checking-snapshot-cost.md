---
author: 김면수
pubDatetime: 2026-05-04T11:00:00.000Z
title: "JPA Dirty Checking 의 진짜 비용 — readOnly / @DynamicUpdate / Query Plan Cache 누수"
featured: true
draft: false
tags:
  - JPA
  - Hibernate
  - Spring
  - DirtyChecking
  - DynamicUpdate
  - QueryPlanCache
  - Performance
  - Backend
description: |
  Hibernate 의 dirty checking 은 entity load 시점에 *snapshot 메모리 복사* + flush 시 *모든 managed entity 의 현재 상태 vs snapshot 비교* + 변경된 row 만 UPDATE. 1만 row update 에서 readOnly=true 가 snapshot 안 만들어 메모리 절감, @DynamicUpdate 는 변경 컬럼만 SET 하지만 *Query Plan Cache 사용량 증가* (plan_cache_max_size 안 잡으면 영구 heap leak), bulk JPQL @Modifying 은 가장 빠르지만 *영속성 컨텍스트 비일관* — clearAutomatically=true 가 표준. 1만 insert 시 clear() 50마다 패턴이 메모리 일정 유지의 정석. JPA 의 함정은 기능 한 줄이 아니라 *flush + cache + snapshot* 의 lifecycle 상호작용입니다.
---

## Table of contents

## 들어가며 {#intro}

JPA 를 처음 쓰는 개발자가 가장 신기해하는 것 — **set 만 하면 자동으로 UPDATE 된다**:

```java
@Transactional
void update(Long id) {
    Order o = repo.findById(id).orElseThrow();
    o.setStatus(CONFIRMED);   // ← 이거 한 줄
    // 메서드 끝나면 UPDATE SQL 알아서 발사
}
```

마법처럼 보이는 이 동작이 **dirty checking**. 그런데 *마법이 어떻게 동작하는지* 모르면 — 1만 row update 시 *왜 느린지*, *왜 메모리가 부족한지*, *왜 UPDATE SQL 에 모든 컬럼이 들어가는지* 답을 못 합니다.

이 글은 dirty checking 의 *진짜 비용* 을 측정값으로 풀어봅니다. 6 시나리오 — readOnly / @DynamicUpdate / bulk JPQL / raw JDBC / clear() 패턴. 그리고 그 위에 *Query Plan Cache 메모리 누수* 라는 시니어 영역의 함정까지.

---

## 1. dirty checking 의 내부 메커니즘 {#mechanism}

가장 단순한 설명:

```
[entity load (findById)]
    ↓
[영속성 컨텍스트에 entity 등록]
    ↓
[snapshot 메모리 복사 — entity 의 모든 컬럼 값을 *그대로* 보관]
    ↓
... (애플리케이션이 entity 의 setter 호출) ...
    ↓
[flush 시점 — 트랜잭션 commit 또는 명시적 em.flush()]
    ↓
[모든 managed entity 의 *현재 상태* vs *snapshot* 비교]
    ↓
[변경된 entity 의 변경된 컬럼 → UPDATE SQL 발사]
```

핵심: **snapshot 보유** + **flush 시 비교** = dirty checking 의 비용. 1만 entity 면 1만 snapshot, flush 시 1만 비교.

[Vlad Mihalcea — Anatomy of Hibernate Dirty Checking](https://vladmihalcea.com/the-anatomy-of-hibernate-dirty-checking/) 가 이 메커니즘을 깊게 정리.

---

## 2. 측정 환경 {#environment}

```
DB:       MySQL 8.0.44 (Docker, 3307)
테이블:   reply_request_dc (10 컬럼)
초기:     1만 row seed (JDBC batchUpdate)
시나리오: 같은 update 를 6 전략으로
도구:     Java 21 + Spring Boot 3.4 + Hibernate 6.6
실행:     ./gradlew :runExpW4DirtyChecking
```

---

## 3. 6 시나리오 결과 {#results}

**[실측 — Java/Spring Stage 2 / 2026-05-04 23:00 KST]** 10000 row update:

| Scenario | elapsedMs | vs S6 baseline | UPDATE SQL | snapshot? |
|---|---:|---:|---|---|
| **S1 dirty checking (readOnly=false)** | **3450** | **111x** | 모든 컬럼 SET | ✅ |
| **S2 readOnly=true** | **26** | 0.84x | (UPDATE 없음) | ❌ |
| **S3 no @DynamicUpdate** | **3117** | **101x** | 모든 컬럼 SET | ✅ |
| **S4 @DynamicUpdate** | **2123** | **68x** | 변경 컬럼만 SET | ✅ + Plan Cache 증가 |
| **S5 @Modifying bulk JPQL** | **41** | 1.32x | 1 SQL | ❌ |
| **S6 raw JDBC (baseline)** | **31** | 1.0x | 1 SQL | ❌ |

**S7 메모리 (1만 entity insert)**:

| 패턴 | heap 증가 | 절감 |
|---|---:|---:|
| clear 없음 | **+21,530 KB** | — |
| clear() 50마다 | **+15,454 KB** | **-28%** |

> **핵심 발견**: dirty checking 자체가 dominant 비용. S1 vs S2 = **132x** (3450→26ms) — readOnly 면 snapshot 안 만들고 flush 도 안 함. `@DynamicUpdate` 1.5x 향상 (S3 → S4) 이지만 raw JDBC 대비 여전히 68x 느림. bulk update 면 `@Modifying` JPQL 이 raw JDBC 와 동급 (41 vs 31ms) — 단 영속성 컨텍스트 비일관 위험으로 `clearAutomatically=true` 필수.

---

## 4. S2 — `readOnly=true` 의 *진짜* 절약량 {#readonly}

흔히 "readOnly=true 는 단순 hint" 로 오해. 실제 동작:

```java
@Transactional(readOnly = true)
public void readMany(...) {
    List<Entity> rows = repo.findAll();  // SELECT
    // entity 자체는 영속성 컨텍스트에 들어가지만 *snapshot 안 만듦*
    // FlushMode = MANUAL → flush 안 발생 → dirty 비교 안 함
}
```

[Vlad Mihalcea — Spring Read-Only Transaction Hibernate Optimization](https://vladmihalcea.com/spring-read-only-transaction-hibernate-optimization/) 의 핵심:

1. **`Session.setDefaultReadOnly(true)`** — entity load 시 *snapshot 안 만듦*. 메모리 절약.
2. **`FlushMode.MANUAL`** — 자동 flush 안 발생. CPU 절약.

→ 1만 row read 시 readOnly=true 면 *snapshot 1만 개 안 만듦*. 대략 entity 크기 × 2 → 약 50% 메모리 절감.

운영 처방: **모든 read 메서드에 readOnly=true**. 카카오페이의 [JPA Transactional 잘 알고 쓰고 계신가요?](https://tech.kakaopay.com/post/jpa-transactional-bri/) 가 이 룰의 정석.

---

## 5. S4 — `@DynamicUpdate` 의 트레이드오프와 Query Plan Cache 누수 {#dynamic-update}

`@DynamicUpdate` 는 *변경된 컬럼만* SET:

```java
@Entity @DynamicUpdate
class Entity { /* ... */ }
```

```sql
-- @DynamicUpdate 없음
UPDATE entity SET col1=?, col2=?, col3=?, ..., col10=? WHERE id=?
-- @DynamicUpdate 있음
UPDATE entity SET col3=? WHERE id=?
```

장점: SQL 짧음 + DB 의 binlog 짧음 + ROW format replication 부담 감소.

단점 — 시니어 영역의 함정:

### 5.1 SQL 매번 새로 생성 → Query Plan Cache 사용량 증가

`@DynamicUpdate` 는 *런타임에 변경된 컬럼 조합* 으로 SQL 생성. 변경 패턴이 N 가지면 SQL 도 N 가지. Hibernate 의 `QueryPlanCacheStandardImpl` 가 모두 보관.

`hibernate.query.plan_cache_max_size` (기본 2048) 를 안 잡으면 — 동적 쿼리 폭발 시 *영구 Heap leak*. Old gen 차곡차곡 쌓여서 *full GC 가 무용지물*.

### 5.2 본 프로젝트의 안전망

application.yml:

```yaml
spring:
  jpa:
    properties:
      hibernate:
        query.plan_cache_max_size: 2048
```

→ LRU 로 동작. 2048 개 넘으면 오래된 plan eviction.

<details>
<summary><b>(심도) Hibernate Query Plan Cache 의 두 가지</b> (펼치기)</summary>

Hibernate 6 의 plan cache 는 사실 *두 종류*:

1. **`QueryPlanCacheStandardImpl`** — JPQL / HQL 쿼리의 parsed AST 캐시. `hibernate.query.plan_cache_max_size`.
2. **`QueryPlanCache.parameterMetadataReferenceCache`** — 파라미터 metadata 캐시. `hibernate.query.plan_parameter_metadata_max_size` (기본 128).

둘 다 LRU. 모니터링: Hibernate Statistics 의 `getQueryPlanCacheHitCount()` / `getQueryPlanCacheMissCount()`.

운영에서 plan cache miss 비율이 증가 → 동적 쿼리 폭발 신호 → cache size 늘리거나 정적 쿼리로 리팩토링.

</details>

---

## 6. S5 — `@Modifying` bulk JPQL + 영속성 컨텍스트 비일관 {#bulk-jpql}

```java
@Modifying
@Query("UPDATE ReplyRequestDc r SET r.retryCount = r.retryCount + 1 WHERE r.ownerId = :ownerId")
int bulkIncrementRetry(@Param("ownerId") Long ownerId);
```

장점: *DB 가 직접 처리*. 1 SQL. 1만 row 도 DB 가 한 번에. Hibernate dirty checking 우회. 가장 빠름.

함정: **영속성 컨텍스트의 entity 와 DB 가 비일관**.

```java
@Transactional
public void problematic(Long ownerId) {
    List<Entity> rows = repo.findAll();        // entity 들이 영속성 컨텍스트에 등록
    repo.bulkIncrementRetry(ownerId);           // DB 만 갱신, entity 는 stale
    rows.get(0).getRetryCount();               // ← 옛날 값 반환 (caches stale)
}
```

해결: `@Modifying(clearAutomatically = true)` — JPQL UPDATE 후 자동 `em.clear()`. 단 *모든* managed entity 가 detach 됨. 정밀 제어 필요시 명시적 `em.clear()` + 다시 findById.

→ 운영 처방: `@Modifying` 은 *batch 업데이트* (관리자 작업, 야간 배치) 에서만. 일반 트랜잭션 안에서는 위험.

---

## 7. S7 — 1만 entity insert 의 `clear()` 패턴 {#clear-pattern}

```java
// 안티패턴: clear() 없음
@Transactional
public void insertMany(int count) {
    for (int i = 0; i < count; i++) {
        em.persist(new Entity(...));
        // 영속성 컨텍스트에 entity + snapshot 누적
    }
    em.flush();
    // 1만 entity + 1만 snapshot 메모리에 보관 → flush 시 비교 1만 번
}
```

운영에서 자주 보는 OOM 의 원인. 영속성 컨텍스트가 *1만 entity 보관* — 메모리 + flush 비교 cost 모두 폭증.

표준 패턴 — *50 마다 flush + clear*:

```java
@Transactional
public void insertManyWithBatch(int count, int batchSize) {
    for (int i = 0; i < count; i++) {
        em.persist(new Entity(...));
        if (i % batchSize == 0 && i > 0) {
            em.flush();
            em.clear();  // ← 핵심 — 영속성 컨텍스트 비우기
        }
    }
    em.flush();
    em.clear();
}
```

→ 메모리 일정 유지. flush 비교도 50 entity 만.

`hibernate.jdbc.batch_size=50` 설정 시 — JDBC level batch 도 같이 동작. 단 IDENTITY 전략은 *batch 비활성화* (다음 글의 P4 EXP-14 주제).

---

## 8. 운영 룰 — JPA 의 lifecycle 5 변수 정리 {#operational-rules}

| 시나리오 | 추천 |
|---|---|
| 단순 read | `@Transactional(readOnly = true)` |
| 1~10 row update | dirty checking + `@DynamicUpdate` (변경 컬럼만 SET) |
| 1만 row update | `@Modifying` JPQL UPDATE + clear() |
| 1만 row insert | `em.persist()` + flush + `clear()` 50마다 |
| 동적 쿼리 자주 | `query.plan_cache_max_size` 명시적 설정 |

→ 함정: "JPA 가 알아서 해줘" 가 *대부분* 의 시간엔 옳지만, *데이터 양이 늘어나면* lifecycle 의 비용이 급격히 증가.

---

## 9. 결론 — JPA 의 진짜 함정은 *상호작용* {#conclusion}

이 글이 측정으로 보여준 것은 — **dirty checking 의 비용은 entity 수에 비례**. 1 entity 는 무료, 1만 entity 는 OOM. readOnly / @DynamicUpdate / @Modifying / clear() — 모두 *같은 lifecycle 의 다른 부분* 을 다루는 도구. 어느 하나만 알아선 부족하고 *조합* 을 알아야 함.

다음 글은 [JPA N+1 + JOIN FETCH 깊이 함정 4종](/posts/jpa-n-plus-1-entity-graph-deep-dive/) 의 6 시나리오 측정.

---

## References {#references}

### 공식 문서
- [Hibernate ORM — Persistence Context](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#persistence-context)
- [Hibernate ORM — @DynamicUpdate](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#mapping-DynamicUpdate)
- [Spring Data JPA — @Modifying](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)

### Vlad Mihalcea
- [Anatomy of Hibernate Dirty Checking](https://vladmihalcea.com/the-anatomy-of-hibernate-dirty-checking/)
- [Spring Read-Only Transaction Hibernate Optimization](https://vladmihalcea.com/spring-read-only-transaction-hibernate-optimization/)
- [How to enable Bytecode Enhancement Dirty Checking](https://vladmihalcea.com/how-to-enable-bytecode-enhancement-dirty-checking-in-hibernate/)

### 외부 사례
- [카카오페이 — JPA Transactional 잘 알고 쓰고 계신가요?](https://tech.kakaopay.com/post/jpa-transactional-bri/) — readOnly 운영 룰
- [카카오페이 — Spring Batch 성능](https://tech.kakaopay.com/post/spring-batch-performance/) — clear() 패턴
- [Baeldung — @DynamicUpdate](https://www.baeldung.com/spring-data-jpa-dynamicupdate)

### 자매글
- [JPA 낙관락 + retry stampede](/posts/jpa-optimistic-lock-lost-update/) — 본 시리즈 P1
- [JPA Spring Mastery #1 — Persistence Context Flush](/posts/jpa-spring-mastery-01-persistence-context-flush/)
