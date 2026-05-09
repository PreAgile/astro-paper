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
  In a 4-depth domain (owner→merchant→rule→history) findAll + child traversal yields 121 SQL. JOIN FETCH collapses it to 1 (12× faster). Fetching two collections at once raises MultipleBagFetchException — Hibernate refuses the cartesian of two Bags. JOIN FETCH + setMaxResults emits HHH000104 and applies pagination *in memory* — silent OOM at scale. Non-owning @OneToOne LAZY is *always fetched* because the proxy cannot tell whether the value is null. **`default_batch_fetch_size: 10` reduces N+1 from 121 → 13 prep (9.3× drop) — but does NOT fix @OneToOne non-owning LAZY (still 1201 prep)**, because batch fetch only batches collection LAZY triggers, not row-by-row ToOne SELECTs. The fetch traps come from Bag/List/Set semantics, proxy limitations, and Hibernate's cartesian handling — JOIN FETCH alone is half the answer.
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

**[Measured — Java/Spring Stage 2 / 2026-05-09]** Identical code, run twice — only `application.yml`'s `hibernate.default_batch_fetch_size` differs:

**Run A — `default_batch_fetch_size` OFF (default):**

| Scenario | prepStmts | rows | aux | elapsed |
|---|---:|---:|---:|---:|
| **S1 N+1 baseline** | **121** | 20 | 300 | 86 ms |
| S2 JOIN FETCH 1-level | **1** | 20 | 100 | 7 ms (12×) |
| S3 MultipleBagFetchException | (thrown) | — | — | — |
| **S4 @OneToOne non-owning LAZY** | **1201** | 1200 | 0 | 282 ms |
| S5 JOIN FETCH + Pagination | 1 | 5 | 0 | 6 ms |
| S6 (same code as S1) | **121** | 20 | 300 | 31 ms |

**Run B — `default_batch_fetch_size: 10`:**

| Scenario | prepStmts | Δ vs Run A |
|---|---:|---|
| S1 / S6 (identical code) | **13** | **−9.3×** (1 + ⌈20/10⌉ + ⌈100/10⌉) |
| S2 / S3 / S5 | unchanged | (no effect) |
| **S4 @OneToOne non-owning LAZY** | **1201** | **unchanged — key finding ★** |

> S1's 121 prep decomposition: **1 main + 20 (owners→merchants) + 100 (merchants→rules) = 121** — the measurement is a 3-depth traversal of the 4-depth domain (history is not iterated). Multiplicative growth per depth. **★ Critical finding: S4's 1201 prep is unaffected by `default_batch_fetch_size`** — the answer "just enable batch_fetch_size" to N+1 is half-true. ToOne LAZY's proxy limitation lives outside the collection batch mechanism (see §6).

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

### 5.1 Why in-memory paging — code trace

Assume 20 owners × 5 merchants and `Pageable.of(0, 5)` (we want 5 owners).

#### ❌ If Hibernate naively appended LIMIT (hypothetical)

```sql
SELECT o.*, m.* FROM merchant_owner o
LEFT JOIN merchant m ON m.owner_id = o.id
ORDER BY o.id LIMIT 5;
```

The 5 rows returned:

| row # | o.id | m.id | meaning |
|---:|---:|---:|---|
| 1 | 1 | 11 | owner 1's 1st merchant |
| 2 | 1 | 12 | owner 1's 2nd |
| 3 | 1 | 13 | owner 1's 3rd |
| 4 | 1 | 14 | owner 1's 4th |
| 5 | 1 | 15 | owner 1's 5th |

→ **only 1 owner returned** (not the 5 requested). Worse case: if owner 1 had 3 merchants, row 4 would jump to owner 2's merchants, leaving owner 2 with only 2 of its 5 — *truncated child collection*. Data integrity broken.

#### ✅ Hibernate's actual fallback

```sql
-- Hibernate's actual SQL — no LIMIT
SELECT o.*, m.* FROM merchant_owner o
LEFT JOIN merchant m ON m.owner_id = o.id
ORDER BY o.id;
```

```java
// Hibernate internal flow (pseudocode):
List<Object[]> rawRows = jdbc.executeQuery(sqlWithoutLimit);  // all 100 rows hydrated
List<MerchantOwner> allOwners = dedupByOwnerId(rawRows);      // memory dedup → 20 owners
return allOwners.subList(0, 5);                               // ★ in-memory paging
```

→ correct 5 owners, but *100 rows traversed memory*. **Correctness paid in heap**. The `HHH90003004` WARN signals this fallback.

### 5.2 Production OOM scale — domain size matters

| Scenario | Parents N | Children/parent M | cartesian (N×M) | heap |
|---|---:|---:|---:|---|
| This EXP (S5) | 20 | 5 | 100 | negligible |
| Small ops | 1,000 | 5 | 5,000 | a few MB |
| Medium ops | 10,000 | 5 | 50,000 | tens of MB |
| Large ops | 10,000 | 50 | **500,000** | **OOM risk** |
| Worst | 100,000 | 100 | **10,000,000** | **certain OOM** |

→ even with page size of just 20, the *entire cartesian* materialises in memory. **A silent OOM** — fine until your advertiser/store list grows, then sudden 5xx.

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

### ★ Why `default_batch_fetch_size` does NOT fix this

S4 stays at **1201 prep in Run B** (with `default_batch_fetch_size: 10`). Two different LAZY mechanisms:

- **Collection LAZY** (OneToMany / ManyToMany): Hibernate wraps the collection in a `PersistentBag`/`PersistentSet`. On first access, `default_batch_fetch_size` rounds up *other parents at the same depth* and fetches them in one IN clause — *batched*.
- **ToOne LAZY** (OneToOne / ManyToOne): Hibernate inserts a *proxy*. The proxy must know "is this null?" — but for the non-owning side the FK is in the *opposite table*, so Hibernate fires a SELECT *per row* at materialisation time. *No window to batch*.

→ batch_fetch_size batches collection LAZY triggers via IN-clause grouping; it has no hook into the per-row ToOne SELECTs. **This is the article's core point: "N+1" hides two distinct mechanisms** — the global config fixes the first, only `@MapsId` (or bytecode enhancement) fixes the second.

### Fixes

- `@MapsId` — collapse 1:1 into PK = FK on the owning side, drop the mappedBy mapping. Single direction. Vlad's standard recommendation.
- Bytecode Enhancement with `@LazyToOne(LazyToOneOption.NO_PROXY)` — needs the gradle plugin.

[Vlad Mihalcea — OneToOne LAZY](https://vladmihalcea.com/hibernate-one-to-one-lazy-not-working/).

---

## 7. S6 — `default_batch_fetch_size` and N/K+1 {#s6}

S6 in this experiment runs the **exact same code as S1**. The only difference is one line in `application.yml`:

```yaml
spring.jpa.properties.hibernate:
  default_batch_fetch_size: 10   # Hibernate default is -1 (off) — must be enabled explicitly
```

3-depth traversal SQL emitted:

```sql
-- Run A (config OFF) — baseline N+1
SELECT * FROM merchant_owner;                              -- 1
SELECT * FROM merchant WHERE owner_id = ?;                 -- ×20
SELECT * FROM auto_reply_rule_n1 WHERE merchant_id = ?;    -- ×100
-- = 121 SQL

-- Run B (default_batch_fetch_size: 10)
SELECT * FROM merchant_owner;                              -- 1
SELECT * FROM merchant WHERE owner_id IN (?,?,...,?);      -- ×2 (20/10)
SELECT * FROM auto_reply_rule_n1 WHERE merchant_id IN (?,?,...,?);  -- ×10 (100/10)
-- = 13 SQL
```

**121 → 13 (9.3×) without changing a single line of application code.** The value of `default_batch_fetch_size` as a *global safety net*. But — as measured in §6 — **it does not fix `@OneToOne` non-owning LAZY**. The full prescription is the config plus `@MapsId`.

### 7.1 Step-by-step — how Hibernate's batch fetch actually works

How does paging 20 owners with `default_batch_fetch_size: 10` enabled end up at *13 SQL*? Let's trace it through the persistence context.

#### 1:N row layout

```
merchant_owner (20 rows)              merchant (100 rows, 5/owner)
┌────┬──────────┐                     ┌────┬──────────┬──────────┐
│ id │ name     │                     │ id │ name     │ owner_id │
├────┼──────────┤                     ├────┼──────────┼──────────┤
│  1 │ owner-1  │ ─┐                  │  1 │ m-1-0    │    1     │ ◄┐
│  2 │ owner-2  │  │                  │  2 │ m-1-1    │    1     │ ◄┤  owner=1's
│ ...│ ...      │  │   1:N            │ ...│ ...      │   ...    │ ◄┤  5 merchants
│ 20 │ owner-20 │ ─┘                  │  5 │ m-1-4    │    1     │ ◄┘
└────┴──────────┘                     │ ...│ ...      │   ...    │
                                      │100 │ m-20-4   │   20     │
                                      └────┴──────────┴──────────┘
```

#### Step 1: parent paging — initial persistence context

```sql
-- SQL #1
SELECT * FROM merchant_owner ORDER BY id LIMIT 20;
```

```
PersistenceContext (1st-level cache):
  owner#1  → merchants: ⏳ PersistentBag (NOT initialized)
  owner#2  → merchants: ⏳ PersistentBag (NOT initialized)
  ...
  owner#20 → merchants: ⏳ PersistentBag (NOT initialized)
```

→ 20 owners hydrated; each `merchants` slot holds an *uninitialized PersistentBag*. No merchant SQL fired yet.

#### Step 2: forEach first iteration → owner#1 LAZY trigger

`owner#1.getMerchants().size()` is called. Hibernate's batch decision:

```
1. owner#1's merchants are needed
2. scan persistence context for *other uninitialized PersistentBags* → owner#2..#20 (19)
3. batch_size = 10 → group owner#1 + 9 others → owner_id ∈ {1, 2, ..., 10}
4. fire one IN-clause SQL, hydrate all 10 owners' merchants
```

```sql
-- SQL #2
SELECT * FROM merchant WHERE owner_id IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
```

→ **only owner#1 was needed, but 10 owners' merchants were fetched in one SQL**. This is the heart of batch fetching — *current need + likely upcoming needs* combined as a look-ahead.

```
PersistenceContext after Step 2:
  owner#1..#10 → merchants: ✅ hydrated (1..10 batch)
  owner#11..#20 → merchants: ⏳ NOT initialized
```

#### Steps 3~10: owner#2..#10 — all cache hits

```java
owner#2.getMerchants().size();   // ✅ already hydrated → no SQL
...
owner#10.getMerchants().size();  // ✅ same
```

#### Step 11: owner#11 → second batch

```sql
-- SQL #3
SELECT * FROM merchant WHERE owner_id IN (11, 12, ..., 20);
```

#### Steps 12~20: all cache hits

#### Result

| Step | SQL |
|---|---:|
| parent paging | 1 |
| owner#1 trigger → batch (1..10) | 1 |
| owner#2..#10 cache hit | 0 |
| owner#11 trigger → batch (11..20) | 1 |
| owner#12..#20 cache hit | 0 |
| **total** | **3** |

Formula: **1 + ⌈N/K⌉**. For the 3-depth traversal in this EXP (down to rules), it's 1 + 2 + 10 = **13 SQL** — the §7 measurement.

**Key takeaways**:
- zero changes to application code — `o.getMerchants()` calls remain the same
- after the first trigger, every subsequent call is a cache hit
- iteration order doesn't matter — whichever owner triggers first kicks off the batch
- no cartesian risk — IN clauses can't produce row multiplication

### 7.2 What batch fetch does NOT fix

But (§6.2) **`@OneToOne` non-owning LAZY (S4) stays at 1201 prep** — only `@MapsId` fixes it. The one-line config is half the answer; that's this article's core message.

---

## 7.5 Easy to confuse — DTO projection vs `@Transactional(readOnly = true)` {#dto-vs-readonly}

These are *completely different dimensions* — meant to be used together, but each fixes a different problem.

| | DTO projection | `@Transactional(readOnly = true)` |
|---|---|---|
| **Dimension** | *result object type* — entity vs POJO | *transaction mode* — flush/snapshot |
| **What it fixes** | the N+1 / fetch plan traps themselves | dirty checking snapshot cost |
| **LAZY trigger?** | ❌ impossible (no proxy is created) | ✅ still happens (entity intact) |

**Direct evidence from this EXP** — S1 already uses `@Transactional(readOnly = true)` and *still emits 121 prep*:

```java
@Transactional(readOnly = true)         // ← already readOnly!
public Stats s1NPlusOne() {
    List<MerchantOwner> owners = ownerRepo.findAllNoFetch();
    for (MerchantOwner o : owners) {
        for (Merchant m : o.getMerchants()) {       // ← LAZY trigger
            sumRules += m.getRules().size();
        }
    }
}
```

→ **readOnly does nothing for the fetch traps**.

### 7.5.1 What `@Transactional(readOnly = true)` actually does

1. Sets `FlushMode.MANUAL` → no auto-flush → no `INSERT/UPDATE/DELETE`
2. **★ no snapshot taken** — entity hydration skips the original-state copy. Dirty-check cost = 0 (W4 P2 EXP-13 measured 132×)
3. Passes a read-only hint to the JDBC driver

What it does NOT fix:
- ✅ entities still hydrate, proxies still alive
- ✅ LAZY triggers still fire → **N+1 unchanged**
- ✅ JOIN FETCH / paging / MultipleBag / OneToOne LAZY traps unchanged

### 7.5.2 What DTO projection actually does

1. Maps SQL results directly to a POJO constructor → no proxy is created
2. Not registered in the persistence context — first-level cache cost = 0
3. No snapshot taken (same effect as readOnly)
4. **★ since there is no proxy, LAZY triggers are physically impossible** → N+1 traps fail to start

### 7.5.3 Side-by-side

| Dimension | DTO projection | readOnly | both |
|---|---|---|---|
| dirty-check snapshot cost | ✅ avoided (no entity) | ✅ skipped (readOnly) | ✅ |
| LAZY trigger → N+1 | ✅ impossible | ❌ **still happens** | ✅ impossible |
| MultipleBagFetchException | ✅ avoided | ❌ unchanged | ✅ avoided |
| HHH000104 paging OOM | ✅ avoided | ❌ unchanged | ✅ avoided |
| @OneToOne LAZY 1201 prep | ✅ avoided | ❌ unchanged | ✅ avoided |
| flush blocking | (no entity) | ✅ | ✅ |
| entity methods / cascade | ❌ unavailable | ✅ | ❌ |

### 7.5.4 In practice — use both together

```java
@Transactional(readOnly = true)              // ← snapshot savings (W4 P2 132×)
public List<OwnerSummaryDto> summaries() {
    return ownerRepo.findOwnerSummaries();   // ← DTO projection (zero N+1)
}
```

→ The two tools act on *different layers*. readOnly fixes the *write side* (snapshot/flush) cost; DTO projection fixes the *read side* (proxy/LAZY/cache) traps. **"readOnly solves N+1" is wrong** — S1's 121 prep is the direct counter-evidence.

---

## 8. Operational rules — Vlad's 5 commandments + 4 industry patterns + decision tree {#rules}

### 8.1 Vlad Mihalcea's 5 commandments

[Vlad Mihalcea](https://vladmihalcea.com/) — Hibernate ORM's most active external contributor. His blog is the de facto standard for production-grade Hibernate. Mapped to this article's scenarios:

| # | Commandment | Where this article shows it |
|---|---|---|
| 1 | Never use `FetchType.EAGER` (anti-pattern) | (premise) |
| 2 | Specify the fetch plan **per query** (JPQL / Criteria / EntityGraph) | S2 / §7 |
| 3 | Read-only views → **DTO projection** | (sidesteps every trap) |
| 4 | Collections: `JOIN FETCH + DISTINCT` for one, `@BatchSize` for the rest | S2 + S6 |
| 5 | OneToOne: `@MapsId` *unidirectional* (no `mappedBy`) | S4 |

The 6 scenarios are precisely each commandment violated.

### 8.2 What real teams pick — 4 industry patterns

| Pattern | Examples | Trade-off |
|---|---|---|
| **A. JPA write-only + native/QueryDSL/jOOQ read** | Naver D2, Kakao tech (high-traffic services) | ✅ Full performance control / ❌ Two parallel codebases |
| **B. JPA + @EntityGraph + @BatchSize safety net** | Generic Spring Boot guides — startups / SaaS | ✅ Stay in entities / ❌ EntityGraph methods explode; MultipleBag still possible |
| **C. JPA + DTO projection everywhere** | Finance / payments / ad bidding (latency-critical) | ✅ Zero N+1, predictable latency / ❌ DTO sprawl, lose dirty checking |
| **D. Avoid JPA (jOOQ / MyBatis)** | Some US SaaS — strong SQL control | ✅ No fetch traps ever / ❌ Lose object-graph naturalness |

Korean big-tech commerce/content teams typically run pattern A (write JPA + read QueryDSL). Whichever pattern you pick, **the N+1 mechanisms here still matter** — pattern A's write side still triggers LAZY through dirty checking; pattern B with EntityGraph alone walks into the pagination trap.

### 8.3 Decision tree

| Situation | Recommendation |
|---|---|
| Read-only view (report / list) | **DTO projection first** — sidesteps every trap |
| 1:N, no pagination | JOIN FETCH (DISTINCT) |
| 1:N two levels deep | JOIN FETCH one level + `@BatchSize` for the rest |
| Two collections from same entity | One `Set` + JOIN FETCH, or both via `@BatchSize` |
| Pagination needed | Page parents, fetch children with `IN` or `@BatchSize` |
| `@OneToOne mappedBy` (non-owning) | **`@MapsId` unidirectional** — `default_batch_fetch_size` does NOT help (§6) |
| Global safety net | Always set `default_batch_fetch_size: 10` in `application.yml` |

### 8.4 Production default this article recommends

1. Always enable `default_batch_fetch_size: 10` (measured: 9.3× drop on collection LAZY)
2. One JOIN FETCH + `@BatchSize` for the rest (commandment 4)
3. DTO projection for read-only views (commandment 3)
4. `@MapsId` unidirectional for OneToOne (commandment 5; batch_fetch_size cannot save you)

---

## 9. Conclusion {#conclusion}

JOIN FETCH alone is not the answer. The trade-off space spans `List` vs `Set`, owning vs non-owning, pagination compatibility, **the boundary between N+1 that batch_fetch_size *can* fix and N+1 it *cannot***, and how Hibernate processes cartesian products. Without that map, the failure modes (OOM, surprise SELECTs) reproduce only in production.

Three-line summary:
1. **`default_batch_fetch_size: 10`** — one line, 9.3× drop on collection LAZY (S1 121 → 13). Always on.
2. **But it does NOT fix `@OneToOne` non-owning LAZY** (S4 1201 → 1201). Separate prescription: `@MapsId` unidirectional.
3. *DTO projection for read-only views* + *JOIN FETCH + BatchSize for transactional views*. Two trails, picked per screen.

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
