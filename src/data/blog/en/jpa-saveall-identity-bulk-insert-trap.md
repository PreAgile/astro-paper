---
author: Myunsoo Kim
pubDatetime: 2026-05-04T13:00:00.000Z
title: "Why saveAll() Becomes 10K INSERTs — IDENTITY and Hibernate's Structural Batch Disablement"
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
  hibernate.jdbc.batch_size=50 is set, yet saveAll() of 10,000 rows fires 10,000 INSERTs. GenerationType.IDENTITY needs LAST_INSERT_ID() per INSERT, which Statement.RETURN_GENERATED_KEYS cannot deliver in batch — Hibernate disables batching structurally. Application-managed IDs (TABLE strategy simulation) restore batching at ~200 SQL. Raw JDBC batchUpdate with rewriteBatchedStatements=true rewrites them as multi-value INSERT (~10 SQL) — the fastest path. The DZone "IDENTITY → SEQUENCE 100x" post is PostgreSQL-specific. MySQL has no native SEQUENCE (it falls back to TABLE), so the real options on MySQL are UUID, TableGenerator pooled-lo, Snowflake/TSID, or raw JDBC batch.
---

## Table of contents

## Why this article {#intro}

The straightforward way to insert many rows in JPA:

```java
@Transactional
public void bulkSave(List<Entity> rows) {
    repo.saveAll(rows);
}
```

With `hibernate.jdbc.batch_size=50` set, saving 10,000 rows should be `10,000 / 50 = 200` SQL calls.

Reality: **10,000 SQL** calls. Why?

The common answer ("IDENTITY") is correct but rarely explained. And the most-cited fix — DZone's [Boost JPA Bulk Insert by 100x](https://dzone.com/articles/spring-boot-boost-jpa-bulk-insert-performance-by-100x) — assumes PostgreSQL. On MySQL there is no native SEQUENCE, so the playbook differs.

---

## 1. The phenomenon {#phenomenon}

```java
@Entity class BulkTargetIdentity {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    Long id;
    ...
}

@Transactional
void run() {
    List<BulkTargetIdentity> rows = new ArrayList<>(10_000);
    for (int i = 0; i < 10_000; i++) rows.add(new BulkTargetIdentity(...));
    repo.saveAll(rows);
}
```

`hibernate.jdbc.batch_size=50` plus `order_inserts=true` in `application.yml`. Hibernate Statistics still report `prepareStatementCount = 10000`.

---

## 2. The structural reason — `Statement.RETURN_GENERATED_KEYS` vs batch {#root-cause}

For each INSERT, Hibernate must immediately retrieve the generated ID to register the entity in the persistence context. JDBC's mechanism:

```java
PreparedStatement ps = conn.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS);
ps.executeUpdate();
ResultSet keys = ps.getGeneratedKeys();
```

Per the JDBC spec ([PreparedStatement.addBatch()](https://docs.oracle.com/javase/8/docs/api/java/sql/PreparedStatement.html#addBatch--)): "*not all databases support batch updates with generated keys*." MySQL Connector/J does, partially, but Hibernate's `PostInsertIdentifierGenerator` does not trust the per-row mapping in batch — and disables batching to keep semantics consistent.

Issue [HHH-12107](https://hibernate.atlassian.net/browse/HHH-12107) confirms this is intentional.

Consequence: with IDENTITY, `hibernate.jdbc.batch_size` has no effect.

---

## 3. S2 — `clear()` every 50 saves memory but not SQL count {#s2}

```java
for (int i = 0; i < 10_000; i++) {
    em.persist(new BulkTargetIdentity(...));
    if (i % 50 == 0 && i > 0) {
        em.flush();
        em.clear();
    }
}
```

Persistence context stays bounded — see [P2 dirty-checking](/en/posts/jpa-dirty-checking-snapshot-cost/). But IDENTITY still cannot batch, so SQL count remains 10,000.

---

## 4. S3 — TABLE strategy simulation: pre-allocated IDs {#s3}

```sql
CREATE TABLE hibernate_sequence_emul (
    sequence_name VARCHAR(50) PRIMARY KEY,
    next_val      BIGINT NOT NULL
);
```

```java
@Transactional
public long allocateBlock(int count) {
    Long start = jdbc.queryForObject(
        "SELECT next_val FROM hibernate_sequence_emul WHERE sequence_name = ? FOR UPDATE",
        Long.class, "bulk_target_seq");
    jdbc.update("UPDATE hibernate_sequence_emul SET next_val = ? WHERE sequence_name = ?",
        start + count, "bulk_target_seq");
    return start;
}

@Entity class BulkTargetTableSeq {
    @Id Long id;   // application-set
    ...
}

long start = allocateBlock(10_000);
List<BulkTargetTableSeq> rows = new ArrayList<>();
for (int i = 0; i < 10_000; i++) rows.add(new BulkTargetTableSeq(start + i, ...));
repo.saveAll(rows);
```

ID is set before INSERT, so generated-keys mapping is irrelevant — batch works. With `batch_size=50`, ~200 SQL.

### TABLE strategy trap — sequence-table row lock

`SELECT ... FOR UPDATE` + UPDATE serialises ID allocation. With many concurrent bulk inserts, the sequence row becomes the bottleneck. Mitigation: **pooled-lo optimizer** — allocate a block at a time:

```java
@Id @GeneratedValue(strategy = TABLE, generator = "bulk_seq")
@TableGenerator(name = "bulk_seq", table = "hibernate_sequence_emul",
        pkColumnValue = "bulk_target_seq", allocationSize = 1000)
```

`allocationSize=1000` → one sequence-row touch per 1,000 IDs.

---

## 5. S4 — raw JDBC batchUpdate + `rewriteBatchedStatements=true` {#s4}

```java
@Transactional
public void s4() {
    List<Object[]> args = new ArrayList<>(10_000);
    for (int i = 0; i < 10_000; i++) args.add(new Object[]{1L, "raw-" + i});
    jdbc.batchUpdate("INSERT INTO bulk_target_identity (owner_id, payload, created_at) VALUES (?, ?, NOW(6))",
            args);
}
```

JDBC URL must include `rewriteBatchedStatements=true`:

```
jdbc:mysql://...?...&rewriteBatchedStatements=true
```

The MySQL driver rewrites N batched INSERTs into one multi-value INSERT:

```sql
INSERT INTO bulk_target_identity (owner_id, payload, created_at) VALUES
    (?, ?, ...), (?, ?, ...), (?, ?, ...), ..., (?, ?, ...);
```

10K rows / 1K batch size → ~10 SQL — fewer round trips, less network overhead. Fastest path for one-off bulk loads.

---

## 6. MySQL has no native SEQUENCE {#mysql}

DZone's "IDENTITY → SEQUENCE for 100x" applies to PostgreSQL, where `nextval()` is atomic and Hibernate caches blocks. On MySQL, `GenerationType.SEQUENCE` falls back to TABLE — a row-locking sequence simulation.

Practical MySQL options:

| Option | Pros | Cons |
|---|---|---|
| **UUID** (`@GeneratedValue(strategy = UUID)`) | distributed-safe, no lock | random IDs cause heavy InnoDB B+tree page splits |
| **`@TableGenerator` + pooled-lo** | batch + low lock overhead | needs sequence-table maintenance |
| **Snowflake / TSID** | time-ordered + distributed + no lock | extra library |
| **Raw JDBC + rewriteBatchedStatements** | fastest | bypasses persistence context |

Project rule of thumb:

- Bulk load (10K+, one-off): raw JDBC batchUpdate + rewrite (Spring Batch's `JdbcBatchItemWriter`).
- Normal transactions (1–100 rows): IDENTITY + `saveAll` is fine — batch effect is small but operations are simple.
- Need distributed IDs: TSID (Snowflake-family) for index locality + uniqueness.

---

## 7. `order_inserts` / `order_updates` revisited {#order-inserts}

`hibernate.order_inserts=true` reorders inserts to group same-entity-type rows together, increasing batch fill rate. This *only* helps when batching is enabled — i.e., not with IDENTITY. With SEQUENCE / TABLE / application-set IDs, it is part of the standard tuning set.

---

## 8. Decision tree {#rules}

| Situation | Recommendation |
|---|---|
| 1–100 inserts in normal transactions | IDENTITY + saveAll (simple; minor batch loss is acceptable) |
| 10K+ inserts, one-off (batch job) | Raw JDBC batchUpdate + `rewriteBatchedStatements` |
| Distributed env, time-ordered IDs | TSID / Snowflake (library) |
| Single instance, PK only | TableGenerator + pooled-lo |
| Spring Batch ItemWriter | `JdbcBatchItemWriter` (rewrites automatically) |

---

## 9. Conclusion {#conclusion}

`hibernate.jdbc.batch_size` alone is not the answer. IDENTITY's `PostInsertIdentifierGenerator` disables batching by design. Combine that with MySQL's lack of native SEQUENCE, and the popular DZone playbook stops applying. Three orders of magnitude separate IDENTITY (10K SQL) from raw JDBC + rewrite (~10 SQL) for the same 10K rows. The choice of ID strategy is the choice of bulk-insert performance.

---

## References {#references}

### Official
- [Hibernate ORM — Identifiers / Generators](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#identifiers-generators)
- [Hibernate ORM — Batching](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#batch)
- [MySQL Connector/J — rewriteBatchedStatements](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-performance-extensions.html)
- [JDBC API — addBatch()](https://docs.oracle.com/javase/8/docs/api/java/sql/PreparedStatement.html#addBatch--)

### Vlad Mihalcea
- [JPA Hibernate Best Practices](https://vladmihalcea.com/jpa-hibernate-best-practices/) — IDENTITY vs SEQUENCE
- [Batch Processing Best Practices](https://vladmihalcea.com/jpa-hibernate-batch-insert-best-practices/)
- [How to enable Hibernate batch insert](https://vladmihalcea.com/how-to-batch-insert-and-update-statements-with-hibernate/)

### External
- [kakaopay — Spring Batch performance](https://tech.kakaopay.com/post/spring-batch-performance/) — JdbcBatchItemWriter
- [DZone — Boost JPA Bulk Insert by 100x](https://dzone.com/articles/spring-boot-boost-jpa-bulk-insert-performance-by-100x) ⚠️ PostgreSQL
- [Hibernate Issue HHH-12107](https://hibernate.atlassian.net/browse/HHH-12107) — IDENTITY batch disable

### Sister posts
- [JPA N+1 deep-dive](/en/posts/jpa-n-plus-1-entity-graph-deep-dive/)
- [JPA Dirty Checking cost](/en/posts/jpa-dirty-checking-snapshot-cost/)
- [JPA Optimistic Lock + retry stampede](/en/posts/jpa-optimistic-lock-lost-update/)
