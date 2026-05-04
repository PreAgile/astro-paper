---
author: Myunsoo Kim
pubDatetime: 2026-05-04T11:00:00.000Z
title: "The Real Cost of JPA Dirty Checking — readOnly, @DynamicUpdate, and Query Plan Cache Leaks"
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
  Hibernate's dirty checking copies an entity snapshot at load time and compares it against the current state at flush. With 10,000 rows, readOnly=true skips the snapshot copy (memory savings). @DynamicUpdate emits SQL with only the changed columns — but generates a fresh SQL string per update pattern, increasing Query Plan Cache usage (a permanent heap leak if hibernate.query.plan_cache_max_size is unset). @Modifying bulk JPQL is fastest but leaves the persistence context inconsistent — clearAutomatically=true is the standard. The clear() pattern (flush + clear every 50 inserts) keeps memory bounded for large insert batches. The trap in JPA is never one feature; it is the interaction of flush, cache, and snapshot lifecycle.
---

## Table of contents

## Why this article {#intro}

The first surprise when learning JPA is *automatic UPDATE on setter*:

```java
@Transactional
void update(Long id) {
    Order o = repo.findById(id).orElseThrow();
    o.setStatus(CONFIRMED);   // No explicit save
}
```

Looks magical. But understanding *how* it works changes how you write batch jobs, choose `readOnly`, and tune Hibernate properties. This article measures the cost across six scenarios and exposes a senior-level trap on Query Plan Cache leaks.

---

## 1. The mechanism {#mechanism}

```
[entity load via findById]
   ↓
[entity registered in persistence context]
   ↓
[snapshot — a copy of every column at load time]
   ↓
... (application calls setters) ...
   ↓
[flush at commit or em.flush()]
   ↓
[for each managed entity: compare current vs snapshot]
   ↓
[changed entities → UPDATE SQL]
```

Cost = snapshot allocation × N entities + per-entity comparison at flush. 10,000 entities means 10,000 snapshots and 10,000 comparisons.

Reference: [Vlad Mihalcea — Anatomy of Hibernate Dirty Checking](https://vladmihalcea.com/the-anatomy-of-hibernate-dirty-checking/).

---

## 2. Setup {#setup}

```
DB:    MySQL 8.0.44 (Docker, 3307)
Table: reply_request_dc (10 columns)
Seed:  10,000 rows via JDBC batchUpdate
Tool:  Java 21, Spring Boot 3.4, Hibernate 6.6
Run:   ./gradlew :runExpW4DirtyChecking
```

---

## 3. Six scenarios {#scenarios}

| Scenario | UPDATE SQL | Snapshot? |
|---|---|---|
| **S1** dirty checking, `readOnly=false` | every column SET | yes |
| **S2** `readOnly=true` | none | **no** |
| **S3** no `@DynamicUpdate` | every column SET | yes |
| **S4** `@DynamicUpdate` | only changed columns | yes + Plan Cache pressure |
| **S5** `@Modifying` bulk JPQL | one SQL | no, persistence context stale |
| **S6** raw JDBC | one SQL | no |

[Numbers filled in after measurement run.]

---

## 4. S2 — what `readOnly=true` actually saves {#readonly}

Hibernate's `Session.setDefaultReadOnly(true)`:

1. Skips the snapshot copy at entity load → **memory savings**.
2. Switches FlushMode to MANUAL → no auto-flush, no comparison → **CPU savings**.

For 10,000 rows of pure read traffic, this is roughly 50% less heap. The kakaopay rule — *every read method gets `readOnly=true`* — comes from this. See [JPA Transactional 잘 알고 쓰고 계신가요?](https://tech.kakaopay.com/post/jpa-transactional-bri/) (Korean).

---

## 5. S4 — `@DynamicUpdate` and the hidden Query Plan Cache leak {#dynamic-update}

```java
@Entity @DynamicUpdate
class Entity { ... }
```

```sql
-- Without @DynamicUpdate
UPDATE entity SET col1=?, col2=?, ..., col10=? WHERE id=?

-- With @DynamicUpdate
UPDATE entity SET col3=? WHERE id=?
```

Wins: shorter SQL, smaller binlog, less ROW-format replication overhead.

The senior trap: SQL is **regenerated per change pattern**. If `col3` is updated in one call and `col5, col7` in another, Hibernate caches both as separate plans in `QueryPlanCacheStandardImpl`. Without `hibernate.query.plan_cache_max_size`, dynamic update patterns can cause a *permanent old-gen leak*. Full GC cannot reclaim it.

Our `application.yml`:

```yaml
spring.jpa.properties.hibernate.query.plan_cache_max_size: 2048
```

LRU bounded — sized for our query diversity.

---

## 6. S5 — `@Modifying` bulk JPQL and persistence-context staleness {#bulk}

```java
@Modifying
@Query("UPDATE ReplyRequestDc r SET r.retryCount = r.retryCount + 1 WHERE r.ownerId = :ownerId")
int bulkIncrementRetry(@Param("ownerId") Long ownerId);
```

The fastest update — DB does it in one statement. The trap:

```java
@Transactional
public void problematic(Long ownerId) {
    List<Entity> rows = repo.findAll();         // entities now in persistence context
    repo.bulkIncrementRetry(ownerId);            // DB updated; entities stale
    rows.get(0).getRetryCount();                // ← old value
}
```

Use `@Modifying(clearAutomatically = true)` or call `em.clear()` explicitly. Bulk JPQL belongs in batch jobs and admin endpoints, not in mid-transaction code that re-uses the entities.

---

## 7. S7 — `clear()` pattern for large inserts {#clear-pattern}

```java
// Anti-pattern
@Transactional
public void insertMany(int count) {
    for (int i = 0; i < count; i++) em.persist(new Entity(...));
    em.flush();   // 10,000 entities + 10,000 snapshots in memory
}
```

Standard pattern:

```java
@Transactional
public void insertManyBatched(int count, int batchSize) {
    for (int i = 0; i < count; i++) {
        em.persist(new Entity(...));
        if (i % batchSize == 0 && i > 0) {
            em.flush();
            em.clear();   // bound the persistence context
        }
    }
    em.flush(); em.clear();
}
```

Memory stays bounded; flush comparison is `O(batchSize)`, not `O(N)`.

Note: with `GenerationType.IDENTITY`, JDBC batch is structurally disabled regardless of `clear()` — that is the topic of [P4 — saveAll IDENTITY trap](/en/posts/jpa-saveall-identity-bulk-insert-trap/).

---

## 8. Operational rules {#rules}

| Situation | Recommendation |
|---|---|
| Pure read | `@Transactional(readOnly = true)` |
| Update 1–10 rows | dirty checking + `@DynamicUpdate` |
| Update 10K+ rows | `@Modifying` JPQL UPDATE + `clearAutomatically` |
| Insert 10K+ rows | `em.persist()` + flush/clear every 50 |
| Many dynamic queries | Set `query.plan_cache_max_size` explicitly |

---

## 9. Conclusion {#conclusion}

Dirty checking cost grows with the number of managed entities. Single-entity is free; ten thousand is OOM. The four levers — `readOnly`, `@DynamicUpdate`, `@Modifying`, `clear()` — each address a different segment of the lifecycle. None of them is a stand-alone fix.

Next: [JPA N+1 + JOIN FETCH deep-dive](/en/posts/jpa-n-plus-1-entity-graph-deep-dive/).

---

## References {#references}

### Official
- [Hibernate ORM — Persistence Context](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#persistence-context)
- [Hibernate ORM — @DynamicUpdate](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#mapping-DynamicUpdate)

### Vlad Mihalcea
- [Anatomy of Hibernate Dirty Checking](https://vladmihalcea.com/the-anatomy-of-hibernate-dirty-checking/)
- [Spring Read-Only Transaction Hibernate Optimization](https://vladmihalcea.com/spring-read-only-transaction-hibernate-optimization/)

### External
- [kakaopay — JPA Transactional](https://tech.kakaopay.com/post/jpa-transactional-bri/)
- [Baeldung — @DynamicUpdate](https://www.baeldung.com/spring-data-jpa-dynamicupdate)

### Sister posts
- [JPA Optimistic Lock + retry stampede](/en/posts/jpa-optimistic-lock-lost-update/)
- [JPA Spring Mastery #1 — Persistence Context Flush](/en/posts/jpa-spring-mastery-01-persistence-context-flush/)
