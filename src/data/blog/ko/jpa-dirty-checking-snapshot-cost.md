---
author: 김면수
pubDatetime: 2026-05-04T11:00:00.000Z
modDatetime: 2026-05-05T01:00:00.000Z
title: "@Transactional(readOnly = true) 한 줄이 응답시간을 132배 줄인 이야기 — JPA Dirty Checking 의 정체 해부"
featured: true
draft: false
depth: deep-dive
tags:
  - JPA
  - Hibernate
  - Spring
  - DirtyChecking
  - DynamicUpdate
  - ReadOnly
  - BulkJPQL
  - Performance
  - Backend
description: |
  JPA dirty checking 비용을 1만 row UPDATE 6 시나리오로 분해. 비교의 *기준* 을 분리해서 읽어야 한다 — S1(일반) vs S2(readOnly SELECT) ≈ 132× 는 *readOnly 가 빠진 메서드가 부담하는 비용*, S4(@DynamicUpdate) vs S6(raw JDBC) ≈ 68× 는 *@DynamicUpdate 만으로는 dirty checking dominant 비용을 못 줄인다* 는 의미, S4 vs S5(bulk JPQL) ≈ 50× 는 *모델 자체를 dirty checking 에서 bulk 로 바꿨을 때* 효과, S5 vs S6 ≈ 1.32× 는 JPA 추상화 오버헤드 30% 수준. @DynamicUpdate 는 변경 컬럼 조합마다 SQL string 이 달라져 batch_update 효과를 약화시킬 수 있고 Query Plan Cache 압박을 일으킬 수 있어 *국지적 도구*. loadedState / FlushMode MANUAL / SPR-16956 / bytecode enhancement 까지 Hibernate 6 내부 구조와 함께, 단정 표현은 톤다운한 결론으로 정리한 v2 [실측 — Java/Spring Stage 2, EXP-13].
---

## Table of contents

> **TL;DR** (모두 동일 작업 = 1만 row `retry_count + 1`, 단일 측정 환경 / 단일 스레드)
> - **S1 dirty checking 3,450ms vs S2 readOnly SELECT 26ms = 132×** — *단, S2 는 SELECT only 이므로 "쓰기 비용" 이 아니라 "dirty checking 부재 시 1만 row 로드 + flush 의 한계 비용"* 비교
> - **S4 @DynamicUpdate 2,123ms vs S6 raw JDBC 31ms = 68×** — `@DynamicUpdate` 만으로는 dirty checking dominant 비용을 못 줄임
> - **S3 일반 entity 3,117ms vs S4 @DynamicUpdate 2,123ms = 1.5×** — `@DynamicUpdate` 자체의 SET 절 축소 효과
> - **S5 bulk JPQL 41ms vs S6 raw JDBC 31ms = 1.32×** — JPA 추상화 오버헤드는 30% 수준
>
> 흔히 "은총알" 로 알려진 `@DynamicUpdate` 는 SET 절을 줄이지만 *Hibernate batch_update 를 깨뜨릴 수 있는* 함정이 있다. 이 글은 dirty checking 이 *정확히* 어떻게 구현되어 있는지, 메모리에서 어떻게 차지하는지, 그리고 4 가지 우회법(readOnly / @DynamicUpdate / @Modifying / raw JDBC)의 비용을 측정값과 함께, **각 비교의 기준을 분리해서** 풀어낸다.

---

## 0. 시작 — 흔한 운영 사고 시나리오 {#intro}

> **[가상의 이슈 보고서]** "어제 저녁부터 `/orders/recent` 응답시간 p99 가 평소 80ms 에서 3,400ms 로 튀었다. 트래픽은 그대로. 직전 배포에 어떤 코드가 들어갔는지 봤더니 — 새 메서드 하나가 추가됐고, `@Transactional` 만 붙어 있고 `readOnly = true` 가 빠져 있었다. 그 한 줄을 추가하니 26ms 로 떨어졌다."

이 글은 그 *132배* 가 **왜** 그렇게 큰지를 1만 row 실측 데이터와 Hibernate 내부 구조로 풀어낸다.

---

## 1. Dirty Checking 이란 무엇인가 — 마법이 아닌 알고리즘

JPA 를 처음 배울 때 다음 코드를 보고 한 번쯤 갸우뚱한다:

```java
@Transactional
public void incrementRetry(Long id) {
    ReplyRequest r = repo.findById(id).orElseThrow();
    r.setRetryCount(r.getRetryCount() + 1);
    // save() 호출 안 했는데 트랜잭션 종료 시 UPDATE 가 나간다.
}
```

이 *자동 UPDATE* 가 **dirty checking (변경 감지)** 이다. Hibernate 가 트랜잭션 commit 직전에 다음 3 단계를 돈다.

### 1.1 알고리즘 — 3 단계

**(a) Snapshot 생성** — 엔티티 로드 시점
> `repo.findById(id)` 한 줄 안쪽에서 실제로 일어나는 일을 풀어보면 다음 흐름이다:
>
> ```
> repo.findById(id)
>   └─ Spring Data JPA → Hibernate Session
>        └─ SELECT … FROM reply_request WHERE id = ?  (JDBC PreparedStatement)
>             └─ JDBC 가 DB 응답을 ResultSet (=row 커서) 으로 돌려줌
>                  └─ Hibernate 가 ResultSet 의 컬럼 값들을 읽어 ReplyRequest 인스턴스로 변환 (= "hydrate")
>                       └─ 그 직후 같은 컬럼 값들을 한 번 더 복사해서 Object[] 에 보관 → loadedState (= snapshot)
> ```
>
> 즉 `findById` 한 번에 *(1) 엔티티 본체 `ReplyRequest` + (2) 그것과 똑같은 값을 담은 `Object[]` 두 덩어리* 가 동시에 영속성 컨텍스트에 들어간다. 이 두 번째 사본이 **loadedState** (=흔히 말하는 *snapshot*) 이다. *실제로 어떤 필드가 복사되는지는 매핑(@Transient / 컬렉션 / lazy 프록시 / @Formula 등) 에 따라 다르며, 본 글은 단순 컬럼 매핑 기준으로 설명한다.*

**(b) Flush 시 비교** — 트랜잭션 commit 직전
> 영속성 컨텍스트(=1차 캐시)에 들어 있는 *managed 상태의 엔티티* 들에 대해 현재 값과 snapshot 을 비교 (= **diff-based dirty checking**). 차이가 있는 엔티티에 "dirty" 마킹.

**(c) UPDATE 발사** — dirty 엔티티마다 1 SQL
> dirty 한 엔티티에 대해 `UPDATE … WHERE id = ?` SQL 을 만들어 발사. 기본 동작은 *변경된 컬럼만이 아니라 매핑된 모든 컬럼* 을 SET 절에 넣는다 (`@DynamicUpdate` 미사용 시).

**비용 공식** (Vlad Mihalcea 의 anatomy 글에서 인용):

> N = Σ(p_k), where n = managed entities, p_k = properties of entity k

핵심은 "*변경된 게 한 개뿐이어도 Hibernate 는 managed 상태의 엔티티 전부를 비교 대상으로 삼는다*"는 점.

**그래서 "얼마나" 비싸냐 — 본 측정 (Hibernate 6, MySQL 8, 1만 row × 10 컬럼) 기준 감 잡기**:

| 영속성 컨텍스트 size | 비교 횟수 (대략) | 측정값 (참고) |
|---|---:|---|
| 1 entity × 10 컬럼 | 10 | 비교 자체는 µs 단위 — *체감 0ms*, 트랜잭션 전체로도 ms 한 자릿수 |
| 1만 entity × 10 컬럼 | 10만 | **flush + 1만 UPDATE 발사 합쳐 3,450ms** (2 절의 S1) |
| 같은 1만 entity, readOnly = 비교 생략 | 0 | **26ms** (2 절의 S2) |

차이 = 약 **3,400ms**. 그런데 *이 3,400ms 의 대부분은 컬럼 비교 loop 자체가 아니라*, 비교 결과 dirty 로 마킹된 엔티티마다 발사된 **1만 UPDATE round-trip** 이다 (PropertyAccess 호출 1 회는 sub-µs ~ µs 단위라, 10만 회 비교의 순수 CPU 는 보통 수십 ms 수준).

즉 "dirty checking 이 비싸다" 의 진짜 의미는 *비교 loop CPU* 가 아니라 ***그 결과로 발사되는 UPDATE 폭주*** — 그래서 entity 수가 늘어나면 비용은 *비교 횟수에 비례* 가 아니라 *UPDATE 횟수 × round-trip latency* 에 비례해서 폭증한다. 이 점이 2 절의 6 시나리오에서 그대로 드러난다.

---

### 1.2 왜 이렇게 설계됐나 — JPA 가 dirty checking 을 택한 3 가지 의도

1.1 절 끝의 "1만 entity = 3,450ms" 를 보고 자연스럽게 떠오르는 질문 — *"이렇게 비싼 줄 알면서 왜 이런 모델인가?"*. JPA / Hibernate 가 snapshot + dirty checking 을 채택한 데는 분명한 설계 의도가 있다. 뿌리는 ORM 의 두 핵심 설계 패턴 — *Identity Map* 과 *Unit of Work* — 이고, 그 위에 JPA spec 이 ***managed entity*** 라는 개념을 올렸다. managed 상태의 entity 가 트랜잭션 안에서 변경되면 commit / flush 시점에 DB 에 반영되도록 — *그 자동 반영을 어떻게 구현할 것인가* 의 답으로 JPA / Hibernate 가 택한 방식이 dirty checking 이다.

#### (1) Transparent persistence — JDBC 의 "수동 update" 를 없애기 위해

JPA / Hibernate 의 1차 설계 목표는 *영속성 메커니즘이 도메인 객체에 침투하지 않도록* 한다 — 즉 entity 가 일반 POJO 처럼 동작해야 한다. JDBC 시대엔 모든 변경마다 다음을 직접 작성·호출했다:

```java
// JDBC 시대
PreparedStatement ps = conn.prepareStatement(
    "UPDATE reply_request SET retry_count = ? WHERE id = ?");
ps.setInt(1, r.getRetryCount() + 1);
ps.setLong(2, id);
ps.executeUpdate();
```

JPA 는 이걸 없애기 위해 만들어졌다. `r.setRetryCount(…)` *한 줄로 끝나려면* 누군가가 *변경을 알아채고* *commit 시점에 자동으로 UPDATE 를 발사* 해야 한다 — 그 "누군가" 가 dirty check loop 이고, *변경 전 상태* 를 비교 기준으로 들고 있어야 하니 snapshot 이 필요하다. transparent persistence 라는 약속을 지키면서 변경을 알아내는 *가장 보편적인 방식* 이 — entity 본체를 직접 수정하지 않고 *별도 메모리에 비교 기준을 두는* 것이다 (다른 방식으로 bytecode enhancement / 이벤트 기반 추적도 가능하며, Hibernate 도 옵션으로 제공한다 — 1.5 절).

#### (2) Write-behind — Unit of Work 패턴의 직접 구현

만약 setter 호출마다 즉시 UPDATE 를 발사한다면:

- 같은 row 가 트랜잭션 내에서 N 번 변경되면 N 번의 round-trip
- rollback 시 보상 SQL 이 필요 — 트랜잭션 의미 자체가 깨짐
- **batch flush / SQL 의존성 정렬 / @Version 검사 묶기** 같은 최적화가 전부 불가능

대신 Hibernate 는 ORM 영역의 고전 패턴인 ***Unit of Work*** 를 그대로 구현했다 — *commit 시점까지 변경을 영속성 컨텍스트(= Identity Map) 에 모아두고 한 번에 flush*. 이걸 가능하게 하려면 commit 시점에 *무엇이 바뀌었는지* 를 알아야 → 다시 snapshot. Hibernate 공식 문서는 이 동작을 *transactional write-behind* 라고 부른다. 트랜잭션이 끝날 때 (또는 AUTO flush 정책에선 query 발사 직전) 영속성 컨텍스트의 `ActionQueue` 가 INSERT → UPDATE → DELETE 순으로 정렬되어 한꺼번에 flush 된다.

write-behind 가 없으면 batch_size / @DynamicUpdate / 2nd-level cache write-through 같은 핵심 최적화의 *작동 공간 자체가 크게 줄어든다*. snapshot 은 그 최적화들이 깔리는 기준점이다.

#### (3) snapshot 은 dirty check 만의 비용이 아니다 — 여러 ORM 기능의 공통 기준점

가장 자주 놓치는 포인트. snapshot 은 *dirty check 한 가지를 위한* 메모리가 아니라 **여러 핵심 기능이 같은 데이터를 기준점으로 삼는다**:

| 기능 | snapshot 의 역할 |
|---|---|
| **Optimistic locking (`@Version`)** | flush 시 *snapshot 의 version* 을 WHERE 절에 박아 stale write 검출 — `UPDATE … WHERE id=? AND version=?` 형태 |
| **`@DynamicUpdate`** | "변경된 컬럼만 SET" 을 하려면 결국 *snapshot vs current 비교* 가 선행되어야 함 |
| **2nd-level cache 일관성** | invalidation 또는 write-through 시 *어떤 컬럼이 바뀌었는지* 를 snapshot 으로 식별 |
| **Hibernate event listener (`PreUpdateEventListener` 등)** | listener 가 받는 *old state vs current state* 가 그대로 snapshot 에서 나옴 (JPA 표준 `@PreUpdate` 는 entity 만 받지만, Hibernate native event 는 `getOldState()` 로 변경 전 값을 노출) |
| **Audit / history (Hibernate Envers 등)** | 변경 *전후* 값을 모두 알아야 변경 이력 row 를 기록 가능 |

즉 snapshot 은 dirty checking 한 가지를 위한 메모리가 아니라 *버전 검증 / SQL 생성 최적화 / 2차 캐시 연동 / 변경 이벤트 추적* 등 여러 ORM 기능의 *기준점* 으로 쓰인다. 단일 기능이 아니라 ORM 전체 동작의 공통 기반이라서 — 그 비용이 *기능 한 묶음 어치* 라고 보는 게 정확하다.

#### 그래서 왜 *메모리* 에 두나 — 설계 선택지와 그 비용

변경 사실을 *어떻게 알아낼지 + 알아낸 변경을 언제 DB 에 반영할지* — 두 축의 설계 선택지와 그 비용을 정리하면:

| 설계 선택지 | 비용 / 단점 |
|---|---|
| flush 시 DB 에서 원본 row 를 *재 SELECT* 후 비교 | 매 flush 마다 round-trip 1 회 추가 — DB 부하 폭증, JPA 의 추상화 이득이 사라짐 |
| setter 호출마다 *즉시 UPDATE* 발사 | 위 (2) 의 write-behind 이점 전부 상실 — N 번 변경 시 N round-trip + 트랜잭션 rollback 시 보상 SQL 필요 |
| **Bytecode enhancement** 로 setter 안 변경 추적 (1.5 절 참조) | CPU 비교 비용은 줄지만 *모든 entity 가 빌드 시 변환* 필요 + JPA spec default 가 아님 + snapshot 도 매핑에 따라 여전히 일부 보관 |
| **메모리에 snapshot 보관 (Hibernate 의 default 선택)** | 메모리 약 2 배 — 그러나 *DB round-trip 0 + 빌드 단순 + 위 (3) 의 기능들이 모두 같은 기준점 위에서 동작* |

JPA spec 이 정해진 시점 (EJB 3.0 / JSR 220, 2006) 의 trade-off 는 명확했다 — *DB round-trip 은 ms 단위, 메모리 접근은 ns 단위*. 메모리 2 배 비용은 round-trip 1 회보다 *수만 배 쌌다*. 지금은 RAM 가격 / GC 비용 / heap fragmentation 등 환경이 달라졌지만, *spec 이 결정된 시점* 의 합리적 결정이었고, 이후 고비용 워크로드를 위한 보완책으로 *bytecode enhancement* (1.5 절) 와 *bulk JPQL / raw JDBC 우회* (5 절) 가 따로 마련됐다.

#### 정리 — 왜 비용을 내고 사는가

> snapshot 은 dirty checking 뿐 아니라 *버전 검증 / SQL 생성 최적화 / 2차 캐시 연동 / 변경 이벤트 추적* 등 여러 ORM 기능의 **기준점** 역할을 한다. 즉 단일 기능이 아니라 ORM 전체 동작의 공통 기반이라서 그 비용이 생긴다. 그래서 본 글의 결론은 "버려라" 가 아니라 — **"지금 이 작업이 그 기능들을 다 필요로 하는가"** 를 묻고, 아니면 3 절부터 5 절까지의 우회법으로 *국지적으로* 빠진다.

---

### 1.3 내부 구현 — 어느 클래스가 무엇을 하나

Hibernate 6.x 기준 핵심 클래스들:

| 역할 | 클래스 | 무엇을 보관/수행하나 |
|---|---|---|
| 영속성 컨텍스트 | `org.hibernate.engine.internal.StatefulPersistenceContext` | 1차 캐시 (entity 본체) + EntityEntry 매핑 |
| 엔티티 단위 메타데이터 | `org.hibernate.engine.spi.EntityEntry` | 엔티티의 *상태* (LOADING/MANAGED/DELETED), version, **loadedState (= snapshot Object[])** |
| Snapshot 생성 | `org.hibernate.persister.entity.EntityPersister#hydrate(...)` | ResultSet → Object[] 변환 |
| Flush 시 비교 | `org.hibernate.event.internal.DefaultFlushEntityEventListener` | dirty check loop 실행 |
| UPDATE 발사 | `org.hibernate.persister.entity.AbstractEntityPersister#update(...)` | SQL 만들어 JDBC 로 실행 |

### 1.4 메모리 레이아웃 — Snapshot 은 정확히 무엇인가

EntityEntry 의 핵심은 `loadedState` 라는 `Object[]` 다. 컬럼 N 개짜리 엔티티 하나를 로드하면 메모리에 다음이 동시에 산다:

```
[Entity 본체]                          [EntityEntry]
┌─────────────────┐                   ┌──────────────────────┐
│ id           = 1│                   │ status = MANAGED     │
│ ownerId      =99│                   │ version = null       │
│ requestStatus="P"│                  │ loadedState = ───────┐
│ payload      ="…"│                  │ rowId   = …          │
│ retryCount   = 0│                   └──────────┬───────────┘
│ ...10개 필드   │                              │
└─────────────────┘                              ▼
                                       Object[] {  // = snapshot
                                         99,          // ownerId
                                         "PENDING",   // requestStatus
                                         "…(500B)…",  // payload
                                         0,           // retryCount
                                         ... 10개 슬롯
                                       }
```

**메모리 비용**:
- 엔티티 본체 1 개
- snapshot Object[] 1 개 (모든 컬럼 값을 *값으로* 복사 — String / BigDecimal / Instant 등 모두 별도 참조로 저장)
- EntityEntry 인스턴스 1 개 (대략 60~100 bytes 의 자체 overhead + state 필드들)

> Vlad Mihalcea 의 글: *"the persistence context requires twice as much memory as all managed entities would normally occupy."* — 영속성 컨텍스트는 매니지드 엔티티가 정상적으로 차지할 메모리의 **2 배** 가 필요하다.

본 프로젝트의 측정에서 **1만 entity insert 시 +21.5 MB heap 증가** 가 그대로 이를 보여준다. 평균 *2.15 KB/entity* (본체 + snapshot + EntityEntry).

### 1.5 Diff-based dirty checking vs Bytecode Enhancement

기본 dirty checking 은 **diff-based** — flush 시점에 Hibernate 가 각 엔티티의 *현재 값을 꺼내서* (구현 세부는 reflection 또는 PropertyAccess 추상을 통한 접근) snapshot 과 비교한다. "모든 getter 를 reflection 으로 호출" 이라기보다는 *Hibernate 가 등록한 PropertyAccess 가 필드/메서드 단위로 값을 읽어와 비교* 하는 게 더 정확하다 (Hibernate 6.x 에선 LambdaMetafactory 기반 최적화도 들어 있다).

어쨌든 entity 수 × 필드 수 만큼의 **읽기·비교 작업** 이 발생하므로 큰 영속성 컨텍스트에선 비용이 누적된다. 그래서 Hibernate 는 **bytecode enhancement** 라는 대안을 제공한다 (Vlad Mihalcea — *How to enable Bytecode Enhancement Dirty Checking*):

```java
// 원본
public class ReplyRequest {
    private int retryCount;
    public void setRetryCount(int v) { this.retryCount = v; }
}

// bytecode enhanced (Hibernate Maven plugin 적용 후)
public class ReplyRequest {
    private int retryCount;
    @Transient private DirtyTracker $$_hibernate_tracker;   // 추가됨
    public void setRetryCount(int v) {
        if (this.retryCount != v) {                          // 비교 후
            $$_hibernate_trackChange("retryCount");          // 변경 추적
        }
        this.retryCount = v;
    }
    public boolean $$_hibernate_hasDirtyAttributes() { ... } // 추가됨
    public String[] $$_hibernate_getDirtyAttributes() { ... } // 추가됨
}
```

엔티티가 *스스로* 어느 필드가 dirty 인지 기억하므로 flush 시 비교 비용을 줄일 수 있다. 다만 **snapshot 보관 여부는 옵션 / 매핑 / Hibernate 설정에 따라 달라진다** — versionless optimistic locking, `@SelectBeforeUpdate`, partial update 등이 필요한 경우엔 여전히 보관된다. 일반적인 표현으로 정리하면 **CPU 비교 비용은 확실히 줄지만 메모리는 항상 동일하게 줄어든다고 단정할 수 없다** (자세한 동작은 Hibernate 공식 문서의 *bytecode enhancement* 챕터 참고).

> **본 프로젝트는 enhancement 미적용 (default diff-based)** — 측정값은 그 기준의 비용이다.

---

## 2. 그래서 *얼마나* 비싼가 — 1만 row 6 시나리오 측정

같은 의미의 작업 (1만 row 의 `retry_count + 1`) 을 6 가지 전략으로 수행. **테이블은 의도적으로 컬럼 10 개** — 전 컬럼 SET 의 효과를 부각시키기 위함.

> **표 읽는 법**: `S6 대비` 컬럼은 *S6 raw JDBC = 1.0×* 기준 배수. 단 *S2 는 SELECT only 라 의미상 비교 대상이 다름* — 같은 "1만 row 로드 + (변경 없음 / 변경 있음)" 구도에서 dirty checking 유무가 만드는 차이를 보여주는 시나리오다.

| 시나리오 | 무엇을 | elapsedMs | S6 대비 |
|---|---|---:|---:|
| **S1** dirty checking (`@Transactional`, readOnly 없음) | 1만 entity 로드 → setter → commit | **3,450** | **111×** |
| **S2** `@Transactional(readOnly = true)` (SELECT only) | 1만 row 로드, 변경 안 함 | **26** | *비교축 다름* |
| **S3** `@DynamicUpdate` 없음 (S1 재측정) | S1 과 동일 entity | **3,117** | **101×** |
| **S4** `@DynamicUpdate` 적용 entity | 변경 컬럼만 SET | **2,123** | **68×** |
| **S5** `@Modifying` bulk JPQL | `UPDATE … WHERE owner_id=?` 한 줄 | **41** | **1.32×** |
| **S6** raw JDBC `JdbcTemplate.update()` | 같은 SQL, baseline | **31** | **1.0×** |

```
S1 ████████████████████████████████████████████████████ 3,450ms
S3 █████████████████████████████████████████████        3,117ms
S4 ███████████████████████████████                      2,123ms
S5 ▌                                                       41ms
S6 ▌                                                       31ms
S2 ▌                                                       26ms (SELECT 만)
```

**1차 관찰** (각 비교의 *기준* 을 분리해서 읽는다):

| 비교 | 배수 | 의미 |
|---|---:|---|
| **S1 vs S2** | **132×** (3,450 / 26) | 1만 row 로드 후, *dirty checking + commit flush* 가 있을 때 vs 없을 때. *쓰기 작업 비교가 아님* — readOnly 가 없는 메서드가 사실상 read-only 트랜잭션이어야 했을 때 부담하는 비용 |
| **S3 vs S4** | **1.5×** (3,117 / 2,123) | 같은 entity 매핑에 `@DynamicUpdate` 만 켰을 때의 SET 절 축소 효과 |
| **S4 vs S6** | **68×** (2,123 / 31) | `@DynamicUpdate` 를 켜도 *여전히* raw JDBC 와 이만큼 차이 — dirty checking 자체가 dominant |
| **S5 vs S6** | **1.32×** (41 / 31) | bulk JPQL 의 JPA 추상화 오버헤드는 30% 수준 |
| **S4 vs S5** | **약 50×** (2,123 / 41) | "row 별 UPDATE" → "WHERE 한 번에 매치" 로 모델을 바꿨을 때의 효과 |

**왜 S5 와 S6 가 거의 동급인가**: 둘 다 `UPDATE … WHERE owner_id = ?` *한 줄* 만 발사한다. WHERE 가 1만 row 를 매치하므로 DB 가 한 번에 처리. **발사 횟수와 round-trip 횟수가 모두 1**. 반면 S1/S3/S4 는 *엔티티마다* `UPDATE … WHERE id = ?` 가 발사되어 1만 statement 가 만들어진다 (batch_size 켜져 있어도 statement 자체는 그대로).

---

## 3. `@Transactional(readOnly = true)` 가 *정확히* 무엇을 하는가

여기가 가장 흥미로운 부분이다. "Hibernate 의 개입 없이 그냥 SELECT 만 하나?" 라고 오해하기 쉬운데, **Hibernate 는 여전히 SQL 생성·hydrate·1차 캐시 저장을 다 한다**. 다만 *최적화 모드* 로 동작한다.

### 3.1 4 가지 동시 효과

Spring 이 `readOnly = true` 를 만나면 다음을 *동시에* 수행한다:

**(1) Hibernate Session 에 `setDefaultReadOnly(true)` 호출**
- 이 세션에서 로드되는 모든 엔티티가 read-only 로 표시됨
- *Spring 5.1+ (2018-09) 부터 자동* (이전엔 수동 옵션이었음)
- read-only 로 표시된 엔티티는 **dirty checking 대상에서 제외** (Hibernate 공식 문서)

**(2) read-only 엔티티는 메모리 / 처리 비용이 줄어드는 경향** (Spring 5.1+)
- read-only 로 표시된 엔티티에 대해선 Hibernate 가 *dirty check 경로를 단축하고, 영속성 컨텍스트가 들고 있어야 할 부수 정보(snapshot 포함) 의 비중이 낮아진다*. 정확히 어떤 항목이 어떻게 생략·축소되는지는 **Hibernate 버전 / 매핑(versionless optimistic, lazy 컬렉션, `@SelectBeforeUpdate` 등) / 설정에 따라 다르다** — "loadedState 가 항상 0 바이트가 된다" 로 읽으면 위험하다.
- 독자에게 의미 있는 결론은 두 가지: *(a) dirty check 대상에서 제외, (b) 같은 작업에서 영속성 컨텍스트의 메모리 점유가 줄어드는 경향*. 본 프로젝트의 1만 entity 로드 측정에서도 readOnly 케이스가 일반 케이스보다 뚜렷이 가벼웠다.

**(3) `FlushMode` 가 `MANUAL` 로 바뀐다**
- 일반 모드는 `AUTO` — 쿼리 발사 직전마다 dirty check + flush
- MANUAL 모드는 *명시적 flush 호출 없으면 자동 flush 가 일어나지 않음*
- Commit 시점의 자동 flush 도 꺼짐 → 1.1 절의 (b) 단계가 통째로 생략됨

**(4) JDBC `Connection.setReadOnly(true)`**
- 일부 드라이버는 read replica 라우팅 힌트로 해석 (예: MySQL Connector/J 의 replication URL)
- MVCC overhead 일부 감소 가능

### 3.2 SPR-16956 — 역사적 배경

Spring 5.0 까지 `readOnly = true` 는 사실상 **FlushMode 만 바꿨다**. 즉 dirty check 트리거는 막았지만 *Hibernate Session 차원의 read-only 처리* 는 적용되지 않았다. Spring 5.1 에서 [SPR-16956](https://github.com/spring-projects/spring-framework/issues/21494) 이 머지되면서 *Hibernate Session 까지 readOnly 가 전파* 되어 read-only 엔티티 처리(=Snapshot 보관 최적화 포함)가 자동으로 활성화됐다. **본 프로젝트의 Spring Boot 3.4 는 5.1+ 동작이 적용되어 있어 메모리 + CPU 양쪽 이득을 받는다**.

### 3.3 만약 readOnly 메서드에서 entity 를 변경하면?

`setDefaultReadOnly(true)` + FlushMode `MANUAL` 인 트랜잭션에서는 *명시적 flush / 새 트랜잭션 / propagation 이 다른 호출* 같은 변수가 없다면 **일반적으로 UPDATE 가 발사되지 않는다** — flush 자체가 일어나지 않기 때문이다. 다만 이 동작은 다음 조건이 깨지면 달라질 수 있다:

- 메서드 안에서 `EntityManager.flush()` 를 명시적으로 부르는 경우
- 같은 트랜잭션 안에서 `propagation = REQUIRES_NEW` 같은 다른 트랜잭션이 끼어드는 경우
- 일부 매핑(detach 후 merge, native query 직접 실행 등)이 다른 경로로 변경을 반영하는 경우

따라서 "readOnly 메서드에서 변경하면 UPDATE 가 절대 나가지 않는다" 라기보다는 **"기본 흐름에선 silent 하게 무시되며, 그래서 더 위험하다"** 가 정확한 표현이다. 운영에선 read 전용 메서드와 write 메서드를 *클래스 단위* 로 분리해 두는 게 안전.

---

## 4. `@DynamicUpdate` — 함정인가 도구인가

표면적으로 *변경된 컬럼만 SET 절에 넣는* 단순한 어노테이션이다. 그런데 측정값은 그게 *부수적* 임을 보여준다 (S4 = 2,123ms, raw JDBC 대비 *여전히 68배 느림*).

### 4.1 잃는 것 4 가지

**(1) Hibernate batch_update 효과가 약화될 수 있다** ⚠️ 가장 큼

`hibernate.jdbc.batch_size = 50` 으로 켜두면 일반적으론 *같은 SQL string* 50 개를 JDBC `addBatch()` + `executeBatch()` 로 묶어 round-trip 을 줄인다. 그러나 `@DynamicUpdate` 는 변경 컬럼 조합마다 SQL string 이 달라진다:

```
[retry_count 만 변경] → "UPDATE r SET retry_count=? WHERE id=?"
[retry_count + status 변경] → "UPDATE r SET retry_count=?, request_status=? WHERE id=?"
```

JDBC 드라이버 입장에선 *다른 prepared statement* 가 되어 같은 batch 안에 묶이지 않을 수 있다. 결과적으로 *변경 컬럼 조합이 row 마다 다른 워크로드* 에선 batch 효율이 무너지며, 극단적으로는 1만 statement 가 round-trip 단위로 흩어질 수도 있다. **실제로 얼마나 깨지는지는 드라이버 / `rewriteBatchedStatements` 옵션 / flush 순서 / SQL 동일성 비율에 따라 달라지므로, 도입 전엔 자체 측정이 필수**.

**(2) JDBC / MySQL prepared statement cache 효율 저하**
- 같은 SQL 이어야 prepared statement 가 재사용된다
- 매 변경 조합이 다른 SQL → cache hit ratio 가 떨어지거나, 사용 안 하는 SQL 이 cache 슬롯을 차지할 수 있다

**(3) Hibernate Query Plan Cache 압박**
- `hibernate.query.plan_cache_max_size` (기본 2048) 에 변경 컬럼 조합 별로 plan 이 누적될 수 있다
- 적절히 튜닝되지 않으면 *메모리 점유가 누적되며, 장시간 운영 시 GC 압박이나 OOM 유발 사례* 가 보고됨 ([Vlad Mihalcea — Tuning Hibernate query plan cache](https://vladmihalcea.com/hibernate-query-plan-cache/))
- "영구 leak" 이라기보다는 *상한이 충분히 작지 않으면 누적되는 캐시 압박* 으로 이해하는 게 안전

**(4) flush 시 SQL string 조립 CPU 비용**
- 일반 entity: 부트 타임에 SQL 한 개 만들어 둠 → flush 때 바인딩만
- `@DynamicUpdate`: 매 flush 마다 SET 절을 *새로 조립*

### 4.2 얻는 것

| 얻는 것 | 가치 있는 케이스 |
|---|---|
| SET 절 작아짐 → 네트워크 / binlog 바이트 감소 | 컬럼 많고 *대부분 안 바뀌는* 경우 (특히 LOB / TEXT / JSON 컬럼) |
| 변경 안 된 컬럼에 *유령 트리거* 안 발생 | 컬럼별 trigger / audit log 가 있을 때 |
| binlog row image 작아짐 | replication 트래픽 절감 (binlog_row_image=FULL 인 경우 효과 큼) |

### 4.3 결론 — `@DynamicUpdate` 는 *국소적 도구*

> **"무조건 붙이는 어노테이션"** 이 아니라 **"특정 entity 의 특정 사정에 맞춰 *예외적으로* 적용하는 도구"** 다. JSON/TEXT 컬럼이 있고 안 바뀌는 케이스, 또는 컬럼별 trigger 가 있는 entity 에만 국지적으로.

---

## 5. 진짜 답은 *그 위 단계* — bulk JPQL & raw JDBC

S5 (`@Modifying` bulk JPQL) 와 S6 (raw JDBC) 가 S4 대비 **50배** 빠르다. 이건 어노테이션 한 줄로 받을 수 있는 차이가 아니라 **dirty checking 모델 자체를 우회** 한 결과다.

### 5.1 `@Modifying` bulk JPQL

```java
public interface ReplyRequestRepository extends JpaRepository<ReplyRequest, Long> {
    @Modifying(clearAutomatically = true)
    @Query("UPDATE ReplyRequest r SET r.retryCount = r.retryCount + 1 WHERE r.ownerId = :ownerId")
    int bulkIncrementRetry(@Param("ownerId") Long ownerId);
}
```

특징:
- 영속성 컨텍스트를 *완전히 우회* — entity hydrate 도, snapshot 비교도 없다
- WHERE 한 번에 1만 row 매치 → SQL 1 발사
- **함정**: 영속성 컨텍스트의 같은 row 는 stale 됨 → `clearAutomatically = true` 또는 명시적 `em.clear()` 필수

### 5.2 raw JDBC

```java
@Transactional
public int updateAllJdbcRaw(Long ownerId) {
    return jdbc.update(
        "UPDATE reply_request_dc SET retry_count = retry_count + 1, "
      + "updated_at = CURRENT_TIMESTAMP(6) WHERE owner_id = ?", ownerId);
}
```

가장 빠르지만 — 영속성 컨텍스트와의 동기화 책임이 *전부 개발자에게* 있다. 같은 트랜잭션에서 그 row 를 다시 다루지 않는 *one-shot* 작업에 적합.

### 5.3 한계

**bulk JPQL** 한 줄로는 "row 별로 *다른 값* 으로 UPDATE" 를 표현할 수 없다. WHERE 가 매치한 모든 row 에 대해 *같은 SET 표현식* 만 적용된다. row 마다 다른 값이 필요하면:

- **raw JDBC `batchUpdate(List<Object[]>)`** — row 별 다른 값을 배치로 묶어 round-trip 절감 가능 (raw JDBC 자체는 "다른 값 UPDATE" 를 충분히 표현한다, 다만 *한 줄 SQL* 은 아님)
- saveAll + batch_size + (IDENTITY 가 아니라) `SEQUENCE` generator — JPA 영역에서 row 별 다른 값을 다룰 때
- `CASE WHEN id = ? THEN ?` 같은 조건부 UPDATE 한 줄 — 표현은 가능하나 row 수가 늘면 SQL 이 비대해짐

또한 bulk JPQL 사용 시:

- **`clearAutomatically = true`** — bulk 발사 *직후* 영속성 컨텍스트의 같은 entity 를 전부 detach. 이후 코드에서 `findById` 가 stale 결과를 반환하는 사고를 막는다.
- **`flushAutomatically = true`** — bulk 발사 *직전* 영속성 컨텍스트의 변경을 DB 에 먼저 반영. 같은 트랜잭션에서 setter 로 변경한 row 가 bulk WHERE 에 영향을 줄 때 필요하다.

같은 트랜잭션에서 그 row 들을 *다시 다루지 않는* 케이스라면 두 옵션의 효과가 약하지만, *섞이는 케이스* 에선 둘 다 켜는 게 안전하다.

---

## 6. 메모리 — 영속성 컨텍스트가 어떻게 차지하나

### 6.1 1만 entity insert 시 측정값

| 패턴 | heap 증가 | 절감 |
|---|---:|---:|
| `clear()` 없음 | **+21,530 KB ≈ 21 MB** | — |
| 50 마다 `flush() + clear()` | **+15,454 KB ≈ 15 MB** | **-28%** |

평균 2.15 KB/entity (본체 + snapshot + EntityEntry). clear 패턴으로 -28%.

### 6.2 왜 clear 가 28% 만 줄였나

snapshot 메모리만 단순 계산하면 더 큰 절감이 나올 것 같지만, 실측은 28% 였다. 이유는 *영속성 컨텍스트 메모리는 snapshot 한 가지가 아니라 여러 항목의 합* 이기 때문이다:

1. clear() 직전까지는 *batch 단위(50 개) 만큼은 그대로 살아 있음* — flush + clear 사이의 부하
2. JVM heap 측정 자체가 GC 타이밍에 따라 노이즈가 큼 (Used vs Committed, Young vs Old 영역 등)
3. `em.persist()` 시 ID 생성, JDBC ResultSet 처리, 임시 객체 (StringBuilder, Tuple 등) 부수 메모리
4. 엔티티 본체와 EntityEntry 인스턴스 자체의 메모리 — clear 가 함께 회수하지만, GC 시점이 측정 구간과 어긋날 수 있음

요약하면 **"snapshot 만의 이론값 ≠ 실측 heap" 은 자연스러운 결과** 이며, 실측 28% 는 "여러 부수 비용을 평균한 결과로 받아들인다" 가 정확한 해석이다.

### 6.3 운영 패턴

```java
@Transactional
public void persistMany(List<Entity> items) {
    int batchSize = 50;
    for (int i = 0; i < items.size(); i++) {
        em.persist(items.get(i));
        if (i % batchSize == 0 && i > 0) {
            em.flush();   // 변경 DB 반영
            em.clear();   // 영속성 컨텍스트 비움
        }
    }
    em.flush();
    em.clear();
}
```

또는 *대량 작업은 아예 영속성 컨텍스트를 안 쓴다* — `JdbcTemplate.batchUpdate()` 를 직접.

---

## 7. 자가진단 — 내 코드는 어떤가

본 글의 함정에 빠져 있는지 *5 단계* 로 점검:

### 7.1 Hibernate SQL 로그 켜기

```yaml
logging:
  level:
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.jdbc.bind: TRACE     # 바인딩 값 확인
    org.hibernate.stat: DEBUG               # 통계
spring:
  jpa:
    properties:
      hibernate:
        generate_statistics: true
```

### 7.2 한 트랜잭션에서 같은 SQL 이 N 번 발사되나

```
UPDATE reply_request SET ... WHERE id=?  ← 같은 SQL 이
UPDATE reply_request SET ... WHERE id=?  ← 1초 안에
UPDATE reply_request SET ... WHERE id=?  ← 수백 번
```

이게 보이면 dirty checking 으로 row 별 발사 중. → bulk JPQL 또는 raw JDBC 검토.

### 7.3 SELECT 만 하는 메서드에 readOnly 가 있나

```bash
# 1차 후보 추출 — 클래스 단위 @Transactional, 옵션 표현, 멀티라인 어노테이션은 못 잡으니 어디까지나 출발점
grep -rn "@Transactional" src/main/java | grep -v "readOnly"
```

표면 검색의 한계가 있으므로 (클래스 레벨 어노테이션, 멀티라인 옵션, AOP 프록시 우회 등) **IDE 의 Find Usages / Spring Inspections / Sonar 룰 / 정적 분석기 + 테스트 커버리지** 와 병행. 실제 후보를 좁힌 뒤 메서드 본문에 변경 코드(`save`, `setXxx`, JPQL UPDATE 등)가 없는 것만 추린다.

### 7.4 Hibernate Statistics 로 flush 횟수 / UPDATE 발사 수 측정

```java
@PersistenceContext EntityManager em;

Statistics stats = em.unwrap(Session.class).getSessionFactory().getStatistics();
long flushCount       = stats.getFlushCount();           // 누적 flush 횟수
long entityUpdateCount = stats.getEntityUpdateCount();   // 누적 UPDATE 발사 수
long entityFetchCount  = stats.getEntityFetchCount();    // 누적 SELECT 후 hydrate 수
```

운영 환경에서 `getEntityUpdateCount()` 가 비정상적으로 크면 dirty checking 폭주 신호. *주의: 이 값들은 "시간" 이 아니라 "횟수" 다.* 응답시간 자체를 보려면 별도 타이머가 필요하다 (예: Micrometer `@Timed` + `hibernate.SQL` 로그).

### 7.5 heap dump 에서 EntityEntry 개수 *(예시)*

```bash
# 운영 환경에서 즉시 따라하지 말 것 — 분석용 환경 / off-peak 에서 시도
$ jcmd <pid> GC.heap_info
$ jmap -histo:live <pid> | grep -i 'EntityEntry\|StatefulPersistenceContext'
```

`EntityEntry` 인스턴스가 수만 ~ 수십만 개 보이면 영속성 컨텍스트가 비대화된 상태. (`jmap -histo` 자체가 STW 를 유발할 수 있어 운영에선 *flight recorder / async-profiler / heap dump 후 오프라인 분석* 등 가벼운 경로를 권장.)

---

## 8. 의사결정 매트릭스

| 상황 | 권장 |
|---|---|
| 단일 row READ 만 | `@Transactional(readOnly = true)` (132× 효과) |
| 단일 row UPDATE (자주, hot path 아님) | dirty checking 그대로 사용 |
| 단일 row UPDATE (hot path) | `@DynamicUpdate` *없이* + batch_size + dirty checking. *@DynamicUpdate 는 batch 깨뜨림 주의* |
| 대량 row 같은 의미 변경 | `@Modifying` bulk JPQL (50×) |
| 대량 row *다른 값* 변경 | raw JDBC `batchUpdate` |
| 대량 INSERT | `SEQUENCE` generator + `saveAll` + batch_size, 또는 raw JDBC. *IDENTITY 는 batch 비활성화* |
| 컬럼이 많고 LOB/JSON 가 안 바뀜 | `@DynamicUpdate` 국지적용 |
| 컬럼별 trigger / audit | `@DynamicUpdate` 국지적용 |
| 대량 SELECT 후 메모리 압박 | `flush() + clear()` 50 단위, 또는 영속성 컨텍스트 우회 |

---

## 9. 한계와 FAQ

### 9.1 본 측정의 한계

- single-thread, local Docker MySQL — concurrency / network latency 효과 미반영
- batch_size 미지정 (default = 0 → batch 비활성). batch 켜진 환경에선 S1/S3/S4 가 더 좋아질 수 있음
- 컬럼 10 개 / 단순 타입. JSON/TEXT 컬럼이 있는 wide table 에서는 `@DynamicUpdate` 의 이득이 더 클 수 있음
- MySQL InnoDB 에서의 측정 — Postgres / Oracle 은 dialect 차이가 있음

### 9.2 FAQ

**Q. `@Transactional` 안 붙이면 어떻게 되나?**
A. Spring Data JPA 메서드는 자체 트랜잭션을 연다. `findById` 는 그 짧은 시점에 entity 를 *detached* 상태로 반환 — 그 다음 setter 를 호출해도 영속성 컨텍스트가 닫혀 있어 *UPDATE 안 나감*. 흔히 일어나는 silent 버그.

**Q. `@Transactional(readOnly=true)` 쓰는데 메서드 안에서 다른 service 의 write 메서드를 부르면?**
A. 트랜잭션 전파 정책에 따라 다르다. 기본 `REQUIRED` 면 같은 트랜잭션이 *readOnly 로* 이어져 — write 가 silent 하게 무시될 수 있다. write 가 필요하면 `@Transactional(propagation = REQUIRES_NEW)` 또는 readOnly 메서드 안에서 write 안 부르기.

**Q. `@DynamicUpdate` 와 `batch_size` 를 같이 쓰면 정말 batch 가 다 깨지나?**
A. *변경 컬럼 조합이 같은 row 들끼리만* 묶일 수 있다. 운영에선 row 마다 변경되는 컬럼이 다른 경우가 많아서 *사실상 거의 깨진다*. JOL/JMH 로 직접 검증해 보길 권장.

**Q. Bytecode Enhancement 는 운영에 권장되나?**
A. dirty check *비교 비용* 은 분명히 줄어든다 (필드 단위 in-line dirty tracking 사용). 다만 **snapshot 보관 여부는 옵션 / 매핑 / Hibernate 설정에 따라 달라지므로** "메모리도 같이 줄어든다" 라고 단정하긴 어렵다. 빌드 파이프라인 복잡도 증가 vs 이득의 균형 — Vlad Mihalcea 도 "persistence context 가 작으면 효과 미미" 라고 명시한다. 본 프로젝트는 도입하지 않았다.

**Q. `clearAutomatically = true` 와 `flushAutomatically = true` 의 차이?**
A. `flushAutomatically = true` 는 bulk JPQL *발사 전* 영속성 컨텍스트의 변경을 DB 에 먼저 반영해서, 같은 트랜잭션의 setter 변경이 bulk WHERE 에 반영되도록 한다. `clearAutomatically = true` 는 bulk JPQL *발사 후* 영속성 컨텍스트의 같은 entity 들을 detach 시켜, 이후 코드가 stale 한 1차 캐시 값을 보지 않도록 한다. **트랜잭션이 bulk 외에도 같은 row 를 다룬다면 둘 다 켜는 게 안전**, 그렇지 않다면 의미 없는 조합이다.

---

## 10. 요약 — 결정 우선순위

각 배수 옆에 *어떤 시나리오 vs 어떤 시나리오* 비교인지 함께 적었다.

```
① "이 작업을 dirty checking 으로 할까 bulk 로 뺄까"
    ── S4(@DynamicUpdate, 2,123ms) vs S5(bulk JPQL, 41ms) ≈ 50× 차이

② "읽기 전용 메서드에 readOnly=true 를 빠뜨리지 않았는가"
    ── S1(dirty checking, 3,450ms) vs S2(readOnly SELECT, 26ms) ≈ 132× 차이
       (단, S2 는 SELECT only — "쓰지 않을 작업이 쓰기 비용을 내고 있는가" 의 비교)

③ "특정 entity 에만 @DynamicUpdate 를 국지적용할까"
    ── S3(일반, 3,117ms) vs S4(@DynamicUpdate, 2,123ms) ≈ 1.5× 차이
```

**결정 순서가 거꾸로 가면 손해 본다**. `@DynamicUpdate` 부터 손대면 batch_update 가 약해져 *오히려* 느려질 수 있다 (특히 변경 컬럼 조합이 row 마다 다른 워크로드). 먼저 **bulk 로 뺄 수 있는가** 를 묻고, 그게 안 되면 **readOnly 가 빠진 곳이 있는가** 를 점검하고, 마지막에 entity 단위 어노테이션을 만진다.

가장 큰 교훈:
> **JPA 의 편리함은 *추상화* 의 결과다. 추상화는 반드시 비용을 가진다 — 그리고 그 비용을 *측정* 하지 않으면 운영에서 갑자기 청구된다.**

---

## 참고 자료

### 설계 의도 / 패턴의 근거 (1.2 절의 설계 배경 설명을 뒷받침)
- **Martin Fowler — *Patterns of Enterprise Application Architecture*** (Addison-Wesley, 2002): **Identity Map** 패턴 (영속성 컨텍스트의 개념적 기반) + **Unit of Work** 패턴 (write-behind flush 의 개념적 기반) — Hibernate 가 ORM 구현으로 그대로 가져옴
- **Christian Bauer / Gavin King / Gary Gregory — *Java Persistence with Hibernate, 2nd ed*** (Manning, 2015): ch.1 "Understanding object/relational persistence" (transparent persistence 철학), ch.10 "Managing data" (자동 dirty 감지 / Unit of Work / write-behind)
- **JPA Specification (JSR 338)** §3.2 "Entity Instance's Life Cycle Management" — managed entity 의 변경이 commit / flush 시점에 DB 에 반영되어야 한다는 spec 요구사항 정의
- [Hibernate ORM User Guide — Flushing](https://docs.jboss.org/hibernate/orm/6.6/userguide/html_single/Hibernate_User_Guide.html#flushing) — *transactional write-behind* 와 ActionQueue 가 flush 단위로 묶이는 메커니즘
- **Vlad Mihalcea — *High-Performance Java Persistence*** (Apress, 2nd ed, 2018), ch.4 "Persistence Context" — Identity Map 위에 dirty checking + write-behind + optimistic lock + cache 가 layered 되는 구조

### Hibernate / Spring 공식
- [Hibernate ORM User Guide — Persistence Context](https://docs.jboss.org/hibernate/orm/6.6/userguide/html_single/Hibernate_User_Guide.html#pc)
- [Hibernate ORM — query.plan_cache_max_size 설정](https://docs.jboss.org/hibernate/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#configurations)
- [StatefulPersistenceContext (Hibernate Javadocs)](https://docs.hibernate.org/orm/5.0/javadocs/org/hibernate/engine/internal/StatefulPersistenceContext.html)
- [Spring Framework SPR-16956 — readOnly propagation to Hibernate Session](https://github.com/spring-projects/spring-framework/issues/21494)
- [Spring Data JPA — Transactionality](https://docs.spring.io/spring-data/jpa/reference/jpa/transactions.html)

### Vlad Mihalcea (canonical)
- [The anatomy of Hibernate dirty checking mechanism](https://vladmihalcea.com/the-anatomy-of-hibernate-dirty-checking/)
- [Spring read-only transaction Hibernate optimization](https://vladmihalcea.com/spring-read-only-transaction-hibernate-optimization/)
- [How to enable Bytecode Enhancement Dirty Checking in Hibernate](https://vladmihalcea.com/how-to-enable-bytecode-enhancement-dirty-checking-in-hibernate/)
- [How to customize Hibernate dirty checking mechanism](https://vladmihalcea.com/how-to-customize-hibernate-dirty-checking-mechanism/)
- [The best way to do batch processing with JPA and Hibernate](https://vladmihalcea.com/the-best-way-to-do-batch-processing-with-jpa-and-hibernate/)
- [Hibernate StatelessSession JDBC Batching](https://vladmihalcea.com/hibernate-statelesssession-jdbc-batching/)
- [Tuning Hibernate Query Plan Cache](https://vladmihalcea.com/hibernate-query-plan-cache/)

### Baeldung
- [How Hibernate Dirty Checking Mechanism Works](https://www.baeldung.com/java-hibernate-entity-dirty-check)
- [JPA/Hibernate Persistence Context](https://www.baeldung.com/jpa-hibernate-persistence-context)
- [Spring Data JPA @DynamicUpdate](https://www.baeldung.com/spring-data-jpa-dynamicupdate)
- [Using Transactions for Read-Only Operations](https://www.baeldung.com/spring-transactions-read-only)
- [Batch Insert/Update with Hibernate/JPA](https://www.baeldung.com/jpa-hibernate-batch-insert-update)
- [Spring Data JPA Batch Inserts](https://www.baeldung.com/spring-data-jpa-batch-inserts)

### 한국어 자료
- [우아한형제들 기술블로그 — JPA 강의 소감과 적용 사례](https://woowabros.github.io/woowabros/2018/12/29/woowahan-jpa1.html) (도입 동기 / 코드 라인 감소 사례)
- [tech-interview-for-developer — Spring Data JPA Dirty Checking](https://github.com/gyoogle/tech-interview-for-developer/blob/master/Web/Spring/%5BSpring%20Data%20JPA%5D%20%EB%8D%94%ED%8B%B0%20%EC%B2%B4%ED%82%B9%20(Dirty%20Checking).md)
- [JPA 더티 체킹 사용 시 주의점 (brunch)](https://brunch.co.kr/@purpledev/32)

### 외부 사례 / 측정
- [Improving Spring Data JPA/Hibernate Bulk Insert Performance by more than 100 times](https://shekhargulati.com/2020/05/11/improving-spring-data-jpa-hibernate-bulk-insert-performance-by-more-than-100-times/)
- [Spring Boot: Boost JPA Bulk Insert Performance by 100x](https://amrutprabhu.medium.com/spring-boot-jpa-bulk-insert-performance-by-100-times-14ec10fa682b)
- [Inserting Millions of Records in Java: Strategies and Benchmarks](https://tarkalabs.com/blogs/inserting-millions-of-records-in-java/)

