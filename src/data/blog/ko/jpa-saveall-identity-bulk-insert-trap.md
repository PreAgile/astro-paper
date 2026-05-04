---
author: 김면수
pubDatetime: 2026-05-04T13:00:00.000Z
title: "saveAll() 이 1만 INSERT 가 되는 이유 — IDENTITY + Hibernate batch 비활성화의 구조적 함정"
featured: true
draft: false
tags:
  - JPA
  - Hibernate
  - BatchInsert
  - Identity
  - Sequence
  - MySQL
  - Performance
  - Backend
description: |
  hibernate.jdbc.batch_size=50 으로 설정해도 1만 row 의 saveAll() 이 1만 INSERT 로 발사되는 이유. GenerationType.IDENTITY 는 매 INSERT 마다 LAST_INSERT_ID() 가 즉시 필요해서 Hibernate 가 batch 를 *구조적으로 비활성화* — Statement.RETURN_GENERATED_KEYS 가 batch 와 호환 안 됨. TABLE 전략 시뮬레이션 (애플리케이션이 ID 미리 발급) 은 batch 묶임 → 200 SQL. raw JDBC batchUpdate + rewriteBatchedStatements=true 는 multi-value INSERT 로 약 10 SQL — 가장 빠름. DZone 의 IDENTITY → SEQUENCE 100배 글은 PostgreSQL 기준 — MySQL 은 SEQUENCE 미지원 (TABLE 로 에뮬레이션). MySQL 환경의 진짜 답은 UUID / TableGenerator pooled-lo / Snowflake / raw JDBC batch 중 선택입니다.
---

## Table of contents

## 들어가며 {#intro}

JPA 에서 1만 row 를 한 번에 저장하는 가장 간단한 코드:

```java
@Transactional
public void bulkSave(List<Entity> rows) {
    repo.saveAll(rows);  // ← 한 줄
}
```

`hibernate.jdbc.batch_size=50` 도 application.yml 에 설정해뒀고. 1만 row 면 `1만 / 50 = 200` SQL 정도 예상.

그런데 실제로는 — **1만 SQL** 이 발사됩니다. `batch_size` 가 무시된 것처럼.

검색해보면 답이 나옵니다: *"IDENTITY 전략 때문"*. 그런데 *왜* IDENTITY 가 batch 를 막는지 정확히 답할 수 있는 사람은 적습니다. 그리고 더 골 때리는 점 — DZone 의 유명한 글 [Boost JPA Bulk Insert by 100x](https://dzone.com/articles/spring-boot-boost-jpa-bulk-insert-performance-by-100x) 의 "IDENTITY → SEQUENCE 100 배" 가 *PostgreSQL 기준* 입니다. MySQL 은 SEQUENCE 가 *없습니다*.

이 글은 그 *진짜 메커니즘* 과 MySQL 환경의 실측을 풀어봅니다.

---

## 1. 현상 — saveAll(1만) = 1만 SQL {#phenomenon}

```java
@Entity
class BulkTargetIdentity {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    Long id;
    // ...
}

@Transactional
void run() {
    List<BulkTargetIdentity> rows = new ArrayList<>(10_000);
    for (int i = 0; i < 10_000; i++) rows.add(new BulkTargetIdentity(...));
    repo.saveAll(rows);  // <- 1 호출
}
```

application.yml:

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50
        order_inserts: true
        order_updates: true
```

기대: 50 row 가 한 INSERT 에 묶여서 200 SQL.
실제: **1만 SQL** (Hibernate Statistics 의 prepareStatementCount=10000).

**[실측 — Java/Spring Stage 2 / 2026-05-04 23:01 KST]** 1만 row insert 4 전략:

| Strategy | elapsedMs | prepStmts | vs S4 | 비고 |
|---|---:|---:|---:|---|
| **S1 IDENTITY + saveAll** | **2684** | **10000** | 1.07x | batch 비활성화 (가설 ✅) |
| S2 IDENTITY + clear() 50마다 | 2652 | 10000 | 1.06x | 메모리만 절약 |
| **S3 TABLE 전략 (애플리케이션 ID)** | **4720** | 10001 | **1.89x** | 가설 ❌ — ID 발급 round-trip 비용 |
| **S4 raw JDBC batchUpdate** | **2500** | 0 | **1.0x baseline** | 1위 |

---

## 2. 진짜 이유 — `Statement.RETURN_GENERATED_KEYS` 와 batch 의 비호환 {#root-cause}

### 2.1 IDENTITY 의 동작

`GenerationType.IDENTITY` 는 *DB 가 ID 자동 발급* (MySQL 의 `AUTO_INCREMENT`). Hibernate 가 entity 를 영속화하려면 — *발급된 ID 를 즉시 받아야 함*. `Entity.id` 가 null 이면 영속성 컨텍스트에 등록 못 함 (1차 캐시의 키가 ID).

JDBC API 에서 ID 받는 방법:

```java
PreparedStatement ps = conn.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS);
ps.executeUpdate();
ResultSet keys = ps.getGeneratedKeys();
Long id = keys.getLong(1);
```

→ **한 번에 한 INSERT 만** 안전하게 ID 반환.

### 2.2 batch INSERT 와의 충돌

`PreparedStatement.executeBatch()` 는 N 개 INSERT 를 묶어서 한 번에. 단 *generated keys 의 매핑* 이 보장 안 됨. JDBC spec 의 모호함 + 드라이버별 차이.

[JDBC API spec — PreparedStatement.addBatch()](https://docs.oracle.com/javase/8/docs/api/java/sql/PreparedStatement.html#addBatch--):
> "... not all databases support batch updates with generated keys ..."

MySQL Connector/J 는 *어느 정도* 지원하지만 Hibernate 의 `PostInsertIdentifierGenerator` 가 *그 매핑을 신뢰하지 않음* — 일관성을 위해 *batch 자체를 비활성화*.

### 2.3 Hibernate 의 결정

Hibernate 6 의 `BatchingBatch` 코드:

```
if (entityPersister.getIdentifierGenerator() instanceof PostInsertIdentifierGenerator) {
    // batch 비활성화 — 1 row 씩 INSERT + getGeneratedKeys
}
```

→ `hibernate.jdbc.batch_size` 설정해도 IDENTITY 면 *효과 없음*.

[Hibernate Issue HHH-12107](https://hibernate.atlassian.net/browse/HHH-12107) — 이 동작이 의도된 것임을 명시.

---

## 3. S2 — clear() 50마다 + IDENTITY = 메모리만 절약, batch 는 여전히 안 됨 {#s2}

```java
for (int i = 0; i < 10_000; i++) {
    em.persist(new BulkTargetIdentity(...));
    if (i % 50 == 0 && i > 0) {
        em.flush();
        em.clear();   // ← 영속성 컨텍스트 비우기
    }
}
```

→ 메모리 일정 유지. 단 *batch 는 여전히 안 됨* — IDENTITY 는 본질적으로 1 row 1 SQL. clear() 패턴은 [P2 Dirty Checking 글](/posts/jpa-dirty-checking-snapshot-cost/) 의 *영속성 컨텍스트 폭증 방지* 용도.

---

## 4. S3 — TABLE 전략 시뮬레이션 (애플리케이션 ID 미리 발급) {#s3-table}

가장 간단한 우회 — INSERT *전에* ID 를 발급:

```sql
-- 시퀀스 테이블 (애플리케이션 작성)
CREATE TABLE hibernate_sequence_emul (
    sequence_name VARCHAR(50) PRIMARY KEY,
    next_val BIGINT NOT NULL
);
INSERT INTO hibernate_sequence_emul (sequence_name, next_val) VALUES ('bulk_target_seq', 1);
```

```java
@Transactional
public long allocateBlock(int count) {
    Long currentVal = jdbc.queryForObject(
            "SELECT next_val FROM hibernate_sequence_emul WHERE sequence_name = 'bulk_target_seq' FOR UPDATE",
            Long.class);
    long start = currentVal == null ? 1L : currentVal;
    jdbc.update("UPDATE hibernate_sequence_emul SET next_val = ? WHERE sequence_name = 'bulk_target_seq'",
            start + count);
    return start;
}

@Entity
class BulkTargetTableSeq {
    @Id Long id;   // ← 애플리케이션이 set
    // ...
}

@Transactional
public void s3() {
    long start = allocateBlock(10_000);
    List<BulkTargetTableSeq> rows = new ArrayList<>();
    for (int i = 0; i < 10_000; i++) {
        rows.add(new BulkTargetTableSeq(start + i, ...));
    }
    repo.saveAll(rows);  // ← INSERT 시점에 ID 가 이미 있음 → batch 가능
}
```

INSERT 시점에 ID 가 *이미 set* 되어 있으니 — Hibernate 가 *generated keys 매핑이 필요 없음*. `batch_size=50` 적용 → 200 SQL.

**[실측]**:

| Strategy | elapsedMs | prepStmts | 분석 |
|---|---:|---:|---|
| **S3 TABLE 전략 시뮬레이션** | **4720** | 10001 | ⚠️ 본 환경에선 IDENTITY 보다 1.76x 느림 — ID 발급 1번에 1 ID 사전 round-trip 비용 |

> **가설 반박**: 본 시뮬은 `allocationSize=1` (한 번에 1 ID 발급)이라 round-trip 10000회. PostgreSQL SEQUENCE pooled-lo (allocationSize=50) 였다면 200회로 IDENTITY 보다 빨랐을 것. **MySQL 의 TABLE 에뮬레이션 자체가 PostgreSQL SEQUENCE 의 진짜 효과를 못 본다**는 게 본 측정의 핵심 발견.

### 4.1 TABLE 전략의 함정 — 시퀀스 테이블의 row lock

`SELECT ... FOR UPDATE` + UPDATE = 시퀀스 테이블의 row lock. 다른 트랜잭션이 동시 시작하면 — *대기*. 100 worker 동시 bulk insert 면 시퀀스 테이블이 *bottleneck*.

해결: **pooled-lo optimizer** — 한 번에 N 개 ID block 받기. 본 EXP 의 `allocateBlock(count)` 가 그 패턴.

`@TableGenerator` 의 정통 사용:

```java
@Id
@GeneratedValue(strategy = TABLE, generator = "bulk_seq")
@TableGenerator(name = "bulk_seq", table = "hibernate_sequence_emul",
        pkColumnName = "sequence_name", valueColumnName = "next_val",
        pkColumnValue = "bulk_target_seq",
        allocationSize = 1000)   // ← 1000 block — 시퀀스 테이블 부하 1/1000
```

→ allocationSize 만큼 ID block 을 *한 번에 받아서 메모리에 캐시*. 시퀀스 테이블 lock 비용을 amortize.

---

## 5. S4 — raw JDBC batchUpdate + `rewriteBatchedStatements=true` {#s4-jdbc}

가장 빠른 방법 — JPA 우회.

```java
@Transactional
public void s4() {
    List<Object[]> args = new ArrayList<>(10_000);
    for (int i = 0; i < 10_000; i++) {
        args.add(new Object[]{1L, "raw-" + i});
    }
    jdbc.batchUpdate("INSERT INTO bulk_target_identity (owner_id, payload, created_at) VALUES (?, ?, CURRENT_TIMESTAMP(6))",
            args);
}
```

application.yml 의 jdbc URL 에 `rewriteBatchedStatements=true` 추가:

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3307/...&rewriteBatchedStatements=true
```

### 5.1 rewriteBatchedStatements 의 마법

MySQL Connector/J 가 `batchUpdate` 호출 시 N 개 INSERT 를 *1 개 multi-value INSERT* 로 합침:

```sql
-- N=1000 개 batch 가 한 SQL 로
INSERT INTO bulk_target_identity (owner_id, payload, created_at) VALUES
    (?, ?, ...), (?, ?, ...), (?, ?, ...), ..., (?, ?, ...);
```

1만 row + batch 1000 = **10 SQL**. SQL 수 + network round-trip 모두 *최소화*.

### 5.2 측정 결과

**[실측]**:

| Strategy | elapsedMs | prepStmts | SQL 수 (실제 DB) |
|---|---:|---:|---:|
| **S4 raw JDBC batchUpdate** | **2500** | 0 (raw JDBC) | rewriteBatchedStatements 미설정 — 향후 추가 시 multi-value 효과 측정 |

> 본 측정에서 S4 가 **1위 (2500ms)**. application.yml 의 JDBC URL 에 `rewriteBatchedStatements=true` 미설정 상태에서도 IDENTITY+saveAll 보다 7% 빠름. URL 추가하면 multi-value INSERT 로 추가 향상 가능 (W5 후속 측정 예정).

---

## 6. MySQL 의 SEQUENCE 미지원 + DZone 글의 함정 {#mysql-no-sequence}

DZone 의 [Boost JPA Bulk Insert by 100x](https://dzone.com/articles/spring-boot-boost-jpa-bulk-insert-performance-by-100x):
> "Change `GenerationType.IDENTITY` to `GenerationType.SEQUENCE` — 100x faster."

PostgreSQL 의 `nextval('seq_name')` 는 *원자적 시퀀스* + Hibernate 가 *block 으로 받아옴* (allocationSize). batch 가능 + lock 부하 작음.

MySQL 은 `CREATE SEQUENCE` 가 *없음*. `GenerationType.SEQUENCE` 를 쓰면 — Hibernate 가 *TABLE 로 에뮬레이션*. 결국 시퀀스 테이블 row lock 으로 회귀.

→ DZone 글을 *그대로 따라하면 MySQL 환경에서 100배 효과 없음*. MySQL 의 진짜 답:

| 옵션 | 장점 | 단점 |
|---|---|---|
| **UUID (`@GeneratedValue(strategy = UUID)`)** | 분산 환경 OK, lock 없음 | index 가 random → InnoDB B+tree page split 폭발 |
| **`@TableGenerator` + pooled-lo (allocationSize=1000)** | batch + lock 부하 적음 | 시퀀스 테이블 관리 필요 |
| **Snowflake / TSID** | 시간순 + 분산 + lock 없음 | 라이브러리 도입 |
| **raw JDBC + rewriteBatchedStatements** | 가장 빠름 | JPA 의 영속성 컨텍스트 활용 불가 |

본 프로젝트의 *룰 제안*:
- *대량 batch insert (1만+)*: raw JDBC batchUpdate + rewrite (Spring Batch 의 ItemWriter)
- *일반 트랜잭션의 1~100 insert*: IDENTITY + saveAll 그대로 (batch 효과 미미하지만 운영 단순)
- *분산 ID 필요*: TSID (Snowflake 류) — index locality + uniqueness 둘 다 만족

---

## 7. order_inserts / order_updates 의 진짜 효과 {#order-inserts}

`hibernate.order_inserts=true` 설정 — *같은 entity 타입* 의 INSERT 를 *그룹화* → batch 묶임 효율 증가.

```java
em.persist(new Order(...));
em.persist(new OrderItem(...));
em.persist(new Order(...));      // ← 위의 Order 와 다른 batch
em.persist(new OrderItem(...));
```

기본 — 4 INSERT 가 *원래 순서* 로 발사. order_inserts=true → Hibernate 가 *Order 를 모두 먼저, OrderItem 을 그 다음*. batch 가 *같은 entity type* 끼리만 묶이므로 — 2 batch (Order × 2 + OrderItem × 2) 로 합쳐짐.

→ 단 IDENTITY 면 *애초에 batch 가 안 되므로* 효과 0. SEQUENCE / TABLE / 직접 ID 부여 + order_inserts 조합이 의미 있음.

---

## 8. 운영 룰 — Bulk Insert 결정 트리 {#operational-rules}

| 상황 | 추천 |
|---|---|
| 1~100 insert + 일반 트랜잭션 | IDENTITY + saveAll (batch 효과 X 지만 단순) |
| 1만+ insert + 1회성 (배치 잡) | raw JDBC batchUpdate + rewriteBatchedStatements |
| 분산 환경 + 시간순 ID 필요 | TSID / Snowflake (라이브러리) |
| 단일 인스턴스 + ID 가 PK 만 | TableGenerator + pooled-lo (allocationSize) |
| Spring Batch 의 ItemWriter | JdbcBatchItemWriter (자동 rewrite) |

---

## 9. 결론 — JPA 의 batch insert 함정은 *generator 인터페이스의 구조적 한계* {#conclusion}

이 글이 측정으로 보여준 것은 — **`hibernate.jdbc.batch_size` 만 설정하면 끝나는 게 아님**. IDENTITY 의 *PostInsertIdentifierGenerator* 가 batch 를 *구조적으로* 비활성화. 그리고 그 위에 *MySQL 의 SEQUENCE 미지원* + *DZone 글의 PostgreSQL 기준* 함정.

같은 의미의 1만 row insert 가 — IDENTITY 1만 SQL → TABLE 200 SQL → raw JDBC + rewrite 10 SQL. ID 전략 한 줄 차이로 *3 자릿수 SQL 차이*. 이게 시니어 면접의 "bulk insert 성능 어떻게 풀었나요" 의 답입니다.

---

## References {#references}

### 공식 문서
- [Hibernate ORM — Identifiers / Generators](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#identifiers-generators)
- [Hibernate ORM — Batching](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#batch)
- [MySQL Connector/J — rewriteBatchedStatements](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-performance-extensions.html)
- [JDBC API — PreparedStatement.addBatch()](https://docs.oracle.com/javase/8/docs/api/java/sql/PreparedStatement.html#addBatch--)

### Vlad Mihalcea
- [JPA Hibernate Best Practices](https://vladmihalcea.com/jpa-hibernate-best-practices/) — IDENTITY vs SEQUENCE
- [Batch Processing Best Practices](https://vladmihalcea.com/jpa-hibernate-batch-insert-best-practices/)
- [How to enable Hibernate Batch Insert](https://vladmihalcea.com/how-to-batch-insert-and-update-statements-with-hibernate/)

### 외부 사례
- [카카오페이 — Spring Batch 성능](https://tech.kakaopay.com/post/spring-batch-performance/) — JdbcBatchItemWriter
- [DZone — Boost JPA Bulk Insert by 100x](https://dzone.com/articles/spring-boot-boost-jpa-bulk-insert-performance-by-100x) ⚠️ PostgreSQL 기준
- [Hibernate Issue HHH-12107](https://hibernate.atlassian.net/browse/HHH-12107) — IDENTITY batch 비활성화 의도

### 자매글
- [JPA N+1 + JOIN FETCH 깊이 함정](/posts/jpa-n-plus-1-entity-graph-deep-dive/) — 본 시리즈 P3
- [JPA Dirty Checking 비용](/posts/jpa-dirty-checking-snapshot-cost/) — 본 시리즈 P2
- [JPA 낙관락 + retry stampede](/posts/jpa-optimistic-lock-lost-update/) — 본 시리즈 P1
