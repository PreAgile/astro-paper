---
author: Myunsoo Kim
pubDatetime: 2026-05-04T12:00:00.000Z
title: "JPA N+1 and the Four JOIN FETCH Traps — MultipleBagFetchException, Pagination OOM, OneToOne LAZY"
featured: true
draft: false
tags:
  - JPA
  - Hibernate
  - NPlusOne
  - JoinFetch
  - EntityGraph
  - BatchSize
  - Performance
  - Backend
description: |
  In a 4-depth domain (owner→merchant→rule→history) findAll + child traversal yields 21 SQL. JOIN FETCH collapses it to 1. But fetching two collections at once raises MultipleBagFetchException — Hibernate refuses the cartesian product of two Bags. JOIN FETCH + setMaxResults emits HHH000104 and applies pagination *in memory* — load 10K rows, keep 20, OOM. Non-owning @OneToOne LAZY is *always fetched* because the proxy cannot tell whether the value is null. @BatchSize tames N+1 to N/K+1, the standard mitigation. The fetch traps in JPA come from Bag/List/Set semantics, proxy limitations, and how Hibernate handles cartesian products — never from JOIN FETCH alone.
---

## Table of contents

## Why this article {#intro}

"How do you solve N+1?" is the most common JPA interview question — which is exactly why depth shows up in the *follow-up*:

- What if you JOIN FETCH **two** collections?
- What about JOIN FETCH with `setMaxResults`?
- When does `@OneToOne(LAZY)` actually behave as LAZY, and when does it always fetch?

These three questions decide senior depth. This article measures all of them in one 4-depth domain.

---

## 1. The 4-depth domain {#domain}

```
MerchantOwner (1)
  └─ OneToMany → Merchant (5/owner)
                     └─ OneToMany → AutoReplyRuleN1 (3/merchant)
                                         └─ OneToMany → ReplyHistory (4/rule)
                                                            └─ OneToOne mappedBy → ReplyHistoryMetadata
```

20 owners × 5 × 3 × 4 = 1,200 histories. Big enough to expose every trap.

---

## 2. S1 baseline — N+1 {#s1}

```java
@Transactional(readOnly = true)
public void s1NPlusOne() {
    List<MerchantOwner> owners = ownerRepo.findAll();   // 1 SQL
    for (MerchantOwner o : owners) {
        for (Merchant m : o.getMerchants()) {            // LAZY — 1 SQL/owner
            for (AutoReplyRuleN1 r : m.getRules()) {     // LAZY — 1 SQL/merchant
                ...
            }
        }
    }
}
```

Expected: 1 + 20 + 100 = **121 SQL**.

---

## 3. S2 — JOIN FETCH one level {#s2}

```java
@Query("SELECT DISTINCT o FROM MerchantOwner o LEFT JOIN FETCH o.merchants")
List<MerchantOwner> findAllJoinFetchMerchants();
```

One SQL with cartesian product, deduplicated by `DISTINCT` (Hibernate 6 also performs in-memory dedup automatically).

---

## 4. S3 — `MultipleBagFetchException` {#s3}

```java
@Query("SELECT DISTINCT m FROM Merchant m "
        + "LEFT JOIN FETCH m.rules r "
        + "LEFT JOIN FETCH m.owner.merchants")
List<Merchant> findAllTwoBags();
```

```
org.hibernate.loader.MultipleBagFetchException:
cannot simultaneously fetch multiple bags: [m.rules, owner.merchants]
```

### Why

`List` is treated as a *Bag* — unordered. Two Bags joined together produce a cartesian whose row-to-element mapping is undefined for unordered collections.

### Fixes

- Switch one to `Set`. Hibernate dedups automatically.
- Fetch one collection per query; let the second use `@BatchSize`.
- Or, fetch via two separate JPQL queries and let the persistence context stitch them.

[Vlad Mihalcea — MultipleBagFetchException](https://vladmihalcea.com/hibernate-multiplebagfetchexception/) compares all three.

---

## 5. S5 — JOIN FETCH + Pagination → in-memory OOM {#s5}

```java
@Query("SELECT DISTINCT o FROM MerchantOwner o LEFT JOIN FETCH o.merchants")
List<MerchantOwner> findAllJoinFetchPaging(Pageable pageable);
```

Logs:

```
WARN  HHH000104: firstResult/maxResults specified with collection fetch; applying in memory!
```

Hibernate cannot push `LIMIT` to SQL because the cartesian breaks the row-to-owner mapping. So it loads *all* rows and keeps `pageSize` in memory. With 10K owners × 5 merchants average, that's 50K rows materialised to return 20.

### Fix

- Page parents only, then fetch children with an `IN` query.
- Or use `@BatchSize` so each lazy collection load batches K parents at a time.

[Vlad Mihalcea — HHH000104](https://vladmihalcea.com/fix-hibernate-hhh000104-entity-fetch-pagination-warning-message/) walks both patterns.

---

## 6. S4 — `@OneToOne` LAZY proxy limitation {#s4}

```java
@Entity class ReplyHistory {
    @OneToOne(mappedBy = "history", fetch = LAZY)
    private ReplyHistoryMetadata metadata;
}
```

Even though `metadata` is LAZY, every `findAll()` of `ReplyHistory` issues a SELECT for metadata.

### Why

The owning side (`@JoinColumn`) can decide null-ness from the FK column — proxy works. The non-owning side (`mappedBy`) has no FK in the entity itself, so Hibernate must SELECT to know whether `metadata` is null. The intent of LAZY is impossible to honour without enhancement.

### Fixes

- `@MapsId` — collapse 1:1 into PK = FK on the owning side, drop the mappedBy mapping. Single direction.
- Bytecode Enhancement with `@LazyToOne(LazyToOneOption.NO_PROXY)` — needs the gradle plugin.

[Vlad Mihalcea — OneToOne LAZY](https://vladmihalcea.com/hibernate-one-to-one-lazy-not-working/).

---

## 7. S6 — `@BatchSize` and N/K+1 {#s6}

`hibernate.default_batch_fetch_size=10` (or `@BatchSize(size=10)`):

```sql
-- N+1 baseline
SELECT * FROM owner;
SELECT * FROM merchant WHERE owner_id = ?;   -- 20 times

-- @BatchSize
SELECT * FROM owner;
SELECT * FROM merchant WHERE owner_id IN (?, ?, ?, ..., ?);   -- 2 times
```

121 → ~13. Not 1, but single-digit — the practical fix in many production codebases.

---

## 8. Decision tree {#rules}

| Situation | Recommendation |
|---|---|
| 1:N, no pagination | JOIN FETCH (DISTINCT) |
| 1:N two levels deep | JOIN FETCH + `@BatchSize` |
| Two collections from same entity | One `Set` + JOIN FETCH, or both via `@BatchSize` |
| Pagination needed | Page parents, fetch children with `IN` or `@BatchSize` |
| `@OneToOne mappedBy` | `@MapsId` unidirectional, or Bytecode Enhancement |
| Read-only report | DTO projection (`SELECT new com.x.Dto(...)`) — bypass entities |

---

## 9. Conclusion {#conclusion}

JOIN FETCH alone is not the answer. The trade-off space spans `List` vs `Set`, owning vs non-owning, pagination compatibility, and how Hibernate processes cartesian products. Without that map, the failure modes (OOM, surprise SELECTs) reproduce only in production.

Next: [JPA saveAll IDENTITY bulk-insert trap](/en/posts/jpa-saveall-identity-bulk-insert-trap/).

---

## References {#references}

### Official
- [Hibernate ORM — Fetching](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#fetching)
- [Hibernate ORM — @BatchSize](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#fetching-batch)

### Vlad Mihalcea
- [N+1 Query Problem](https://vladmihalcea.com/n-plus-1-query-problem/)
- [MultipleBagFetchException](https://vladmihalcea.com/hibernate-multiplebagfetchexception/)
- [HHH000104](https://vladmihalcea.com/fix-hibernate-hhh000104-entity-fetch-pagination-warning-message/)
- [OneToOne LAZY](https://vladmihalcea.com/hibernate-one-to-one-lazy-not-working/)

### External
- [Baeldung — @BatchSize](https://www.baeldung.com/jpa-hibernate-batchsize)

### Sister posts
- [JPA Dirty Checking cost](/en/posts/jpa-dirty-checking-snapshot-cost/)
- [JPA Optimistic Lock + retry stampede](/en/posts/jpa-optimistic-lock-lost-update/)
