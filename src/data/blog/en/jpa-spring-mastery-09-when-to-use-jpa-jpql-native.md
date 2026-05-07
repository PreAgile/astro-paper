---
author: Myeonsoo Kim
pubDatetime: 2026-05-07T22:00:00.000Z
title: "[JPA + Spring Mastery 09] When to use what — a JPA / JPQL / Native SQL decision tree, cuts drawn by four measurements"
featured: true
draft: false
tags:
  - JPA Spring Mastery
  - JPA
  - JPQL
  - Native SQL
  - CQRS
  - Performance
  - Architecture
  - Backend
description: "Across eight prior posts, this series unpacked PersistenceContext / Dirty Checking / Optimistic Lock / N+1 / IDENTITY / self-invocation / Saga·Outbox with measurements. This finale lays that evidence on a single decision tree — starting with the first fork (domain unit vs data unit), then five places where JPA Dirty Checking shines and five where it bleeds, JPQL's middle ground, and the seat for Native / JdbcTemplate / MyBatis. Four measurement cuts (Dirty Checking 132× / saveAll IDENTITY ~1000× / OFFSET 1M 570× / bulk JPQL vs Dirty Checking 84×) decide the boundaries, anchored on Eric Evans' Aggregate (DDD 2003), Fowler's Identity Map / Unit of Work (PoEAA 2002), Greg Young's CQRS Documents (2010), and Vlad Mihalcea's **High-Performance Java Persistence** (2016). The entry point you can hand over in a single URL when an interviewer asks 'how have you used JPA?'"
---

## Table of contents

## Preface {#intro}

Across the eight posts in this series, one question keeps coming back — **"so when do I actually use JPA, and when not?"**. Post 1 on PersistenceContext and Dirty Checking, post 4 on N+1 with entity graph, post 5 on the saveAll IDENTITY trap, post 7 on self-invocation, post 8 on Saga / Outbox — each unpacked one pitfall with measurements, but I never put those measurements **on a single tree** showing where each lives.

This finale does that. It lays the eight posts' evidence on one tree and draws four measurement cuts — Dirty Checking 132×, saveAll IDENTITY ~1000×, OFFSET 1M 570×, bulk JPQL vs Dirty Checking 84× — to mark **where to switch tools**. The post is built to be the URL you can paste in an interview when someone asks "how have you used JPA?"

The claim that JPA is universal and the claim that JPA is slow because it's an ORM are both half answers. The right question is **is this work a domain unit or a data unit?** — that one question is the first fork in the JPA / JPQL / Native SQL split. The work inside Eric Evans' **Aggregate Root** consistency boundary (Domain-Driven Design, 2003) is where JPA Dirty Checking shines brightest, and **data processing** that crosses that boundary — bulk UPDATE, statistics, reports, 10,000-row INSERT — is where JPA bleeds. JPQL fills the gray zone between them, and where JPQL can't reach, Native SQL / JdbcTemplate / MyBatis live.

1. **The first fork** — domain unit vs data unit (Eric Evans' Aggregate / Fowler's Identity Map)
2. **Five places JPA Dirty Checking shines** — atomic Aggregate change, first-level cache hit, Optimistic Lock, Rich Domain, Cascade
3. **Five places JPA Dirty Checking bleeds** — bulk UPDATE (132× / 84×), saveAll IDENTITY (~1000×), statistics, complex join + N+1, DB-specific features
4. **JPQL's middle seat** — `@Modifying` bulk, DTO Projection, QueryDSL, the limits
5. **Native / JdbcTemplate / MyBatis seats** — no entity mapping, four Spring Batch readers
6. **Command / Query separation** — a light application of Greg Young's CQRS Documents (2010)
7. **Decision tree + the four measurement cuts**
8. **Interview answer — 1 minute / 5 minutes / 30 minutes of follow-ups**

The headline:

- **JPA is a tool for expressing small-unit domain consistency in code** — not a replacement for all SQL. It earns its keep only inside Eric Evans' Aggregate Root boundary.
- **The bulk cut is at tens of thousands of rows** — for 10,000-row UPDATE, Dirty Checking 3,450ms vs raw JDBC 31ms = 132×, and even compared to bulk JPQL 41ms it's 84×. Up to a few thousand rows JPQL `@Modifying` is fine; from tens of thousands raw JDBC.
- **The saveAll(IDENTITY) cut is at a thousand rows** — `GenerationType.IDENTITY` **structurally disables** batching. 10,000 INSERTs become 10,000 SQLs; raw JDBC batch makes it ~10 SQLs, roughly 1000×.
- **The OFFSET cut sits around the deep-page-50K mark** — OFFSET 1M = 171ms vs No-Offset cursor = 0.30ms = 570×. Owner dashboards and infinite-scroll feeds both want a cursor.
- **Splitting Command (JPA Aggregate) and Query (DTO Projection) is 80% of the win** — no need to go all the way to full CQRS. Two branches inside the same domain are enough.

The "JPA good / JPA bad" binary in your head reshapes into a decision tree of **where to use what** once measurements are stitched in. Here it is.

---

## 1. The first fork — domain unit vs data unit {#1-domain-vs-data}

### 1.1 Eric Evans' Aggregate Root — the consistency boundary

[Eric Evans, **Domain-Driven Design** (Addison-Wesley, 2003)](https://www.dddcommunity.org/book/evans_2003/) defines **Aggregate** as the starting point of this article.

> "An AGGREGATE is a cluster of associated objects that we treat as a unit for the purpose of data changes. Each AGGREGATE has a root and a boundary. The boundary defines what is inside the AGGREGATE. The root is a single, specific ENTITY contained in the AGGREGATE. The root is the only member of the AGGREGATE that outside objects are allowed to hold references to."
> — Eric Evans, **Domain-Driven Design**, 2003, Chapter 6

Core definitions:

1. **Aggregate** = a cluster of objects treated as a single unit for data changes
2. **Boundary** = a clear line between what's inside and what's outside
3. **Root** = the single entry-point entity. Outsiders may only reference the root
4. **Consistency** = invariants inside the Aggregate hold **within one transaction**

This points directly at JPA Dirty Checking's **fit zone**. **Changes inside the Aggregate boundary** = changes Dirty Checking tracks for free. **Changes outside the boundary** = where the value of JPA's first-level cache and Unit of Work drops.

### 1.2 Fowler's Identity Map / Unit of Work — patterns JPA implements

[Martin Fowler, **Patterns of Enterprise Application Architecture** (Addison-Wesley, 2002)](https://martinfowler.com/eaaCatalog/) is the source for JPA's **implementation patterns**.

| Pattern | Definition | JPA's implementation |
|---|---|---|
| Identity Map | Same ID = same Java object inside one business transaction | First-level cache (`PersistenceContext`) |
| Unit of Work | Track all changes; flush once at commit | `ActionQueue` + Dirty Checking |
| Repository | Abstraction that looks like a domain-object collection | `JpaRepository` / `EntityManager` |
| Domain Model | Domain logic lives on the entity itself | `@Entity` + domain methods |

The **combination** of these four patterns is why JPA shines on domain-unit work. And it's why those same four patterns become **cost** on data-unit work — Identity Map forces 10,000 entities into memory, Unit of Work forces 10,000 snapshot comparisons, the Repository abstraction trades away raw-SQL freedom.

The actual measurement is in [post 1 on PersistenceContext](/en/posts/jpa-spring-mastery-01-persistence-context-flush/) — comparing the same SELECT, raw JDBC 0.74ms vs JPA 0.99ms shows a **+0.4ms baseline** that JPA **always** pays. 0.4ms per row — 4 seconds of baseline cost for 10,000 rows.

### 1.3 Defining domain unit vs data unit

In this article the two terms are pinned down as follows.

**Domain-unit work** — changes to invariants inside an Aggregate boundary. Changes produced by one user action. Usually 1 to a few dozen rows.

```java
// Domain unit — one payment webhook touches 5 entities
@Transactional
public void confirmPayment(PaymentWebhook webhook) {
    Subscription sub = repo.findById(webhook.subId());
    sub.activate(webhook.confirmedAt());      // change 1
    sub.getBilling().markPaid(webhook);       // change 2
    sub.getCoupon().consume();                // change 3
    sub.scheduleNextBilling();                // change 4
    auditRepo.save(new ConfirmAudit(webhook));// change 5
}
```

**Data-unit work** — row-level processing that **explicitly crosses** Aggregate boundaries. Statistics, reporting, bulk changes, migrations. Usually thousands to hundreds of millions of rows.

```java
// Data unit — bulk-expire 10,000 stale coupons
@Modifying(clearAutomatically = true)
@Query("UPDATE Coupon c SET c.status = 'EXPIRED' WHERE c.expiresAt < :now AND c.status = 'ACTIVE'")
int expireOldCoupons(@Param("now") LocalDateTime now);
```

The fundamental difference — for domain-unit work, **invariant tracking is value**; for data-unit work, **invariant tracking is cost**. That single line is the first fork in the decision tree.

### 1.4 The first decision — domain unit or data unit?

The question I ask first in PR review and design discussions:

```
Q1: Which Aggregate's invariant does the change touch?
  - A clear single Aggregate → domain unit → JPA Dirty Checking
  - Multiple Aggregates / no Aggregate boundary → data unit → Q2

Q2: Is the row count predictable in tens to hundreds, or can it explode into thousands+?
  - Tens to hundreds → JPA + DTO Projection is fine
  - Thousands to tens of thousands → JPQL bulk UPDATE / DELETE
  - Tens of thousands+ → raw JDBC batch / native SQL
```

The next sections fill in measurements at each branch.

---

## 2. Five places JPA Dirty Checking shines {#2-jpa-shines}

### 2.1 Atomic change of an Aggregate Root + child entities

When one domain action changes **several entities** together, JPA Dirty Checking aligns **the code's intent and the DB's state**. Payment webhook handling is the canonical case.

```java
@Service
public class PaymentConfirmService {

    @Transactional
    public void confirm(PaymentWebhook webhook) {
        Subscription sub = repo.findById(webhook.subId())
            .orElseThrow();

        // Atomic change across 5 entities — intent expressed via domain methods
        sub.activate(webhook.confirmedAt());
        sub.getBilling().markPaid(webhook.amount());
        sub.getCoupon().ifPresent(Coupon::consume);
        sub.scheduleNext(webhook.confirmedAt());
        auditRepo.save(ConfirmAudit.of(webhook));

        // Flush at commit — UPDATE / INSERT issued automatically
    }
}
```

In raw SQL, you'd hand-write five UPDATEs/INSERTs **with the right ordering**. Forget one entity → partial-update incident. JPA's value: **state your intent**, and Hibernate owns the SQL.

Post 8's Saga implementation is layered on top of this pattern. Inside each Saga step (Tx1 reserve / Tx2 confirm / Tx3 cancel) is the atomic change of a single Aggregate — JPA Dirty Checking owns consistency **within** the step, and Saga compensation owns consistency **between** steps. **Aggregate = JPA / distributed unit = Saga**, a two-layer structure that's the spine of [post 8 on transaction split](/en/posts/jpa-spring-mastery-08-tx-split-saga-outbox/).

[External case: Toss SLASH24 — SAGA distributed transaction compensation](https://haon.blog/article/toss-slash/msa-reward-transaction/) shows the same shape: each Saga step is implemented as a single-Aggregate JPA transaction.

### 2.2 First-level cache hit — repeat reads of the same entity

Read the same entity ID multiple times in one transaction → **zero SQL from the second read**. The direct value of the Identity Map pattern.

```java
@Transactional
public void processOrder(Long orderId) {
    Order o1 = repo.findById(orderId).orElseThrow();    // SELECT 1
    validateInventory(o1);                              // re-query inside
    calculateDiscount(o1);                              // re-query
    sendNotification(o1);                               // re-query
}

private void validateInventory(Order o) {
    Order again = repo.findById(o.getId()).orElseThrow();// cache hit — 0 SQL
    // ...
}
```

In raw JDBC, each call would issue a SELECT — 4 SELECTs total. The cache-hit value compounds in domain code that re-reads the same row inside one transaction.

But on a path with **no repeat reads**, the +0.4ms baseline (raw 0.74ms vs JPA 0.99ms) seen in post 1 is pure loss. The trade-off is **frequency of repeat × baseline cost** — if repeat is high, the first-level cache wins.

### 2.3 Optimistic Lock + `@Version`

The seat where atomic Aggregate change meets concurrency control. A single `@Version` field generates the `WHERE version = ?` clause for you.

```java
@Entity
public class Account {
    @Id Long id;
    long balance;
    @Version Long version;  // ← one line

    public void deduct(long amount) {
        if (balance < amount) throw new InsufficientBalance();
        this.balance -= amount;
        // At commit: UPDATE Account SET balance=?, version=version+1 WHERE id=? AND version=?
    }
}
```

The four-lock measurement (EXP-02, [measurement — Java/Spring], referenced in [post 7 on self-invocation](/en/posts/jpa-spring-mastery-07-aop-self-invocation/)) for a balance-100 / 100-worker / -1 deduction:

| Lock | Time | Correctness |
|---|---|---|
| Pessimistic (FOR UPDATE) | **180ms** | 100% accurate |
| Optimistic (`@Version`) | 549ms | 100% accurate (but N² retries under contention) |
| MySQL `GET_LOCK` | 5,015ms | 91% (advisory-lock cost) |
| Redisson | unsuited for single-instance | 53% |

Optimistic 549ms is 3× slower than pessimistic 180ms — but this is a **high-contention** measurement (100 workers chasing the same row). Under low contention (different Aggregates) optimistic often wins by avoiding lock overhead. **Which contention pattern your domain has** decides the answer.

The real lesson of that measurement isn't the numbers; it's the self-invocation trap discovered **during** it. `successes=100` while balance was unchanged — same-class internal calls bypassed the Spring AOP proxy. Post 7 takes that trap apart line by line.

### 2.4 Domain methods carrying business logic — Rich Domain

Fowler's [Domain Model pattern](https://martinfowler.com/eaaCatalog/domainModel.html) defines the **Rich Domain Model** vs **Anemic Domain Model**.

```java
// Anemic — getters/setters only; logic in service
public class Order {
    private OrderStatus status;
    public OrderStatus getStatus() { return status; }
    public void setStatus(OrderStatus s) { this.status = s; }
}

@Service
public class OrderService {
    public void cancel(Long id) {
        Order o = repo.findById(id);
        if (o.getStatus() == OrderStatus.SHIPPED) throw new IllegalState();
        o.setStatus(OrderStatus.CANCELLED);  // logic scattered into service
    }
}

// Rich — logic lives on the entity
public class Order {
    private OrderStatus status;

    public void cancel() {
        if (status == OrderStatus.SHIPPED)
            throw new CannotCancelShippedOrder();
        this.status = OrderStatus.CANCELLED;
    }
}

@Service
public class OrderService {
    @Transactional
    public void cancel(Long id) {
        repo.findById(id).orElseThrow().cancel();  // intent is clear
    }
}
```

Rich Domain prevents service bloat and **keeps business invariants cohesive on the entity**. The reason JPA Dirty Checking enables this pattern is that you don't need to call `save()` after a change — domain methods alone, and the flush at commit is automatic.

In raw JDBC, you must explicitly `repo.update(o)` after every domain method — forget once, silent miss. JPA handles it implicitly.

### 2.5 Cascade + Orphan Removal

Parent–child consistency. JPA prevents the **delete-sync-miss** incidents common in raw SQL.

```java
@Entity
public class Order {
    @OneToMany(mappedBy = "order",
               cascade = CascadeType.ALL,
               orphanRemoval = true)
    private List<OrderItem> items;

    public void removeItem(OrderItem item) {
        items.remove(item);  // DELETE FROM order_items at commit
    }
}
```

In raw JDBC, you'd manually sync `Order.items` memory state with the DB. Five changes → five chances to break consistency. JPA detects the collection change and emits INSERT / DELETE.

There are traps too. With **two or more** `@OneToMany`, fetch-join hits `MultipleBagFetchException`; paging triggers OOM (Hibernate paginates in memory) — the four traps in [N+1 entity graph deep dive](/en/posts/jpa-n-plus-1-entity-graph-deep-dive/). Cascade's value is bounded to **clearly delimited** 1:N relationships.

---

## 3. Five places JPA Dirty Checking bleeds {#3-jpa-cost}

### 3.1 Bulk UPDATE — 132× / 84× measurements

For tens of thousands of UPDATEs, Dirty Checking becomes the dominant cost. The 6-scenario measurement [measurement — Java/Spring] in [Dirty Checking snapshot cost (EXP-13)](/en/posts/jpa-dirty-checking-snapshot-cost/):

| # | Scenario | Time (ms) | Meaning |
|---|---|---|---|
| S1 | Plain entity (`@Transactional`, no readOnly) | **3,450** | Dirty Checking dominant |
| S2 | readOnly SELECT only | 26 | No-change baseline |
| S3 | Plain entity change (no `@DynamicUpdate`) | 3,117 | Similar to S1 |
| S4 | `@DynamicUpdate` applied | **2,123** | Only SET-clause shrink |
| S5 | bulk JPQL `@Modifying` | **41** | PersistenceContext bypass |
| S6 | raw JDBC | **31** | baseline |

Comparison axes, separated:

> - **S1 vs S2 ≈ 132×** (3,450 / 26) — the cost a method without readOnly carries. Note: S2 is SELECT-only, so this isn't a **write-cost** comparison; it's **the limit cost of a 10K-row load + flush when Dirty Checking is absent**.
> - **S4 vs S6 ≈ 68×** (2,123 / 31) — `@DynamicUpdate` alone doesn't address the Dirty Checking dominant cost.
> - **S5 vs S6 ≈ 1.32×** (41 / 31) — JPA abstraction overhead is around 30%.
> - **S1 vs S5 ≈ 84×** (3,450 / 41) — the win when the model itself shifts to bulk JPQL.

What this measurement says — **on bulk work, not switching tools costs you 84×**. A 1-minute job becomes 84 minutes.

<details>
<summary><b>(deep dive) How Hibernate 6's loadedState is built — the anatomy of Dirty Checking cost</b> (expand)</summary>

[Vlad Mihalcea, **High-Performance Java Persistence** (2016, Manning), Chapter 5 **Persistence Context**](https://vladmihalcea.com/books/high-performance-java-persistence/) gives the most precise account.

When Hibernate hydrates an entity:

```
SELECT row → ResultSet → Hibernate hydrator
  → Object[] (= loadedState, snapshot 1)
  → copy this Object[] into the entity's fields
  → EntityEntry holds (entity, loadedState) both
```

The dominant costs:
1. **Object[] copy** — 10K entities × N columns = N×10K object references in memory
2. **Compare loop at flush** — every managed entity × every column = `O(N × M)` reflection (or interceptor with bytecode enhancement)
3. **WHERE clause is PK only** — without `@DynamicUpdate`, every column lands in the SET clause (even unchanged ones)

S4's `@DynamicUpdate` only addresses (3). (1) and (2) remain — which is why S4 is still 68× slower than raw JDBC. The **root fix** is shifting the model itself to bulk JPQL (S5, 41ms).

Hibernate 6 lets you swap dirty tracking to interceptors via [bytecode enhancement](https://docs.jboss.org/hibernate/orm/6.6/userguide/html_single/Hibernate_User_Guide.html#BytecodeEnhancement) — at the cost of build-time enhancement and trickier debugging. Reports of 30 ~ 40% improvement exist, but it doesn't close the 84× bulk gap.

</details>

### 3.2 saveAll(IDENTITY) — ~1000× measurement

[saveAll IDENTITY bulk insert trap (EXP-14)](/en/posts/jpa-saveall-identity-bulk-insert-trap/), [measurement — Java/Spring]:

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50    # Ignored if entity uses IDENTITY
```

```java
@Entity
public class BulkRow {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)  // ← the trap
    private Long id;
    // ...
}

repo.saveAll(rows);  // 10K rows
```

Expectation: 10K / batch 50 = 200 SQLs.
Reality: **10K SQLs** (Hibernate `prepareStatementCount=10000`).

**Root cause**: `GenerationType.IDENTITY` requires `LAST_INSERT_ID()` **immediately** after each INSERT — `Statement.RETURN_GENERATED_KEYS` **isn't compatible with batching**. Hibernate disables batching itself.

raw JDBC `batchUpdate` + `rewriteBatchedStatements=true` collapses 10K rows into a multi-value INSERT of about 10 SQLs — **roughly 1000×** in SQL-count difference (and a comparable time difference).

Four fixes:

| Method | How it works | Trade-off |
|---|---|---|
| **UUID** | Application generates UUID before save → batching enabled | UUID 16 bytes, random IO on the index |
| **`@TableGenerator` + pooled-lo (allocationSize=1000)** | Pull 1000 IDs from a sequence table at once | Sequence-table maintenance + MySQL doesn't get PostgreSQL SEQUENCE benefits |
| **Snowflake / TSID** | Distributed ID generator | Library dependency added |
| **raw JDBC batchUpdate** | Bypass JPA | No entity mapping |

**The real answer in MySQL** — pick from these four based on domain shape. PostgreSQL's `SEQUENCE` story doesn't translate to MySQL; the dzone "IDENTITY → SEQUENCE 100×" claim is PostgreSQL-specific ([the dzone post's PostgreSQL assumption](https://dzone.com/articles/spring-boot-boost-jpa-bulk-insert-performance-by-100x)).

### 3.3 Statistics / aggregation / reporting

Work whose purpose is **data processing**, not domain semantics. JPQL struggles to express it — window functions, recursive CTEs, JSON functions, FULLTEXT are all outside the JPQL standard spec.

```sql
-- Owner dashboard: daily sales over the last 30 days + 7-day moving average
SELECT
    DATE(created_at) AS day,
    SUM(amount) AS daily,
    AVG(SUM(amount)) OVER (
        ORDER BY DATE(created_at)
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS rolling_7d
FROM orders
WHERE merchant_id = ?
  AND created_at >= NOW() - INTERVAL 30 DAY
GROUP BY DATE(created_at);
```

Trying to express this in JPQL → no window functions → fail. Native query or JdbcTemplate, directly.

DTO Projection costs are also different.

| Approach | Cost | 10K rows |
|---|---|---|
| Entity load (`findAll()`) | 10K entities + snapshots + first-level cache | 4,000ms (post 1's +0.4ms × 10K) |
| DTO Projection (`SELECT new com.X.SalesDto(...)`) | DTO only — no first-level cache | ~30ms |
| JdbcTemplate `RowMapper` | DTO only — zero abstraction | ~25ms |

For reporting — work that doesn't **need** entities — DTO Projection or JdbcTemplate is the canonical choice.

### 3.4 Complex joins + N+1

Joins that span Aggregate boundaries. JPA's fetch join / `@EntityGraph` trips on the four traps from [N+1 entity graph deep dive](/en/posts/jpa-n-plus-1-entity-graph-deep-dive/) — `MultipleBagFetchException`, pagination OOM, `@OneToOne` LAZY behaving like EAGER, the double-edge of `@BatchSize`.

The classical pattern for complex joins is **avoid fetch join via DTO Projection**.

```java
// Anti-pattern: entity fetch join
@Query("SELECT DISTINCT o FROM Order o " +
       "LEFT JOIN FETCH o.items " +
       "LEFT JOIN FETCH o.payments " +  // ← MultipleBagFetchException
       "WHERE o.merchantId = :id")
List<Order> findWithItemsAndPayments(@Param("id") Long id);

// Right way: DTO Projection
@Query("SELECT new com.X.OrderListDto(o.id, o.amount, o.createdAt, m.name) " +
       "FROM Order o JOIN o.merchant m " +
       "WHERE m.id = :id")
List<OrderListDto> findOrderList(@Param("id") Long id);
```

DTO Projection is the canonical shape for **read-only** paths that don't need atomic Aggregate change. It's also the central tool of section 6's Command / Query split.

### 3.5 DB-specific features

JPA's **abstraction** exists for DB portability — at the cost of **DB-specific features**.

| Feature | JPA / JPQL expressible? | Recommended tool |
|---|---|---|
| Window function (`OVER`) | ❌ | Native SQL / JdbcTemplate |
| Recursive CTE (`WITH RECURSIVE`) | ❌ | Native SQL |
| JSON functions (`JSON_EXTRACT`) | ⚠️ MySQL Dialect only, not standard | Native SQL |
| Upsert (`INSERT ... ON DUPLICATE KEY`) | ❌ | Native SQL |
| Partition pruning hint | ❌ | Native SQL |
| FULLTEXT (`MATCH ... AGAINST`) | ❌ | Native SQL |
| `SELECT FOR UPDATE SKIP LOCKED` | ⚠️ some Dialects | Native SQL |
| Bulk INSERT multi-value | ❌ | raw JDBC `batchUpdate` |

Read this matrix as — **the moment a DB-specific feature is needed, JPA is partially bypassed**. The normal operational shape is JPA **and** Native SQL coexisting in the same codebase.

---

## 4. JPQL's middle seat {#4-jpql}

JPQL sits between JPA and Native SQL — **entity mapping stays**, but **PersistenceContext Dirty Checking is bypassed**. Knowing this bypass precisely is the difference between safe use and a stale-cache trap.

### 4.1 Bulk UPDATE / DELETE — `@Modifying`

```java
public interface CouponRepository extends JpaRepository<Coupon, Long> {

    @Modifying(clearAutomatically = true)
    @Query("UPDATE Coupon c SET c.status = 'EXPIRED' " +
           "WHERE c.expiresAt < :now AND c.status = 'ACTIVE'")
    int expireOldCoupons(@Param("now") LocalDateTime now);
}
```

Behavior:
1. **PersistenceContext bypass** — neither Dirty Checking nor first-level cache sees this
2. **Direct UPDATE to DB** — bulk, 1 SQL
3. **First-level cache goes stale** — entities already loaded in the same transaction stay at **their pre-change state**

**Stale trap**:

```java
@Transactional
public void scenario() {
    Coupon c = repo.findById(1L).orElseThrow();  // loaded as ACTIVE, in cache
    repo.expireOldCoupons(LocalDateTime.now());   // bulk UPDATE → DB is EXPIRED
    System.out.println(c.getStatus());            // ⚠️ still ACTIVE — cache stale
}
```

Fix: `@Modifying(clearAutomatically = true)` clears the cache automatically. Or `@Modifying(flushAutomatically = true)` to flush pending changes **before** the bulk fires.

**Measurement**: 10K-row UPDATE — bulk JPQL = 41ms (S5), Dirty Checking = 3,450ms (S1). **84×** difference. The first-line answer for data-unit work.

### 4.2 DTO Projection — readOnly + skipping the first-level cache

The canonical shape for read-only paths.

```java
@Query("SELECT new com.X.OrderSummaryDto(o.id, o.amount, m.name, o.createdAt) " +
       "FROM Order o JOIN o.merchant m " +
       "WHERE m.id = :merchantId " +
       "ORDER BY o.createdAt DESC")
List<OrderSummaryDto> findOrderSummaries(@Param("merchantId") Long merchantId);
```

DTO Projection + `@Transactional(readOnly = true)` together — the three-stage readOnly effect from post 1:

1. **Hibernate flush mode** = MANUAL → no flush → no Dirty Checking
2. **Spring Tx readOnly marker** → some connections / drivers apply read-only optimizations
3. **MySQL `Com_set_option` reduction** → the **QPS 58% drop** reported in [external case: Kakao Pay — Are you really using JPA Transactional?](https://tech.kakaopay.com/post/jpa-transactional-bri/). Read-only transactions cut down `set autocommit = 0/1` round-trips.

The default for read paths is `readOnly = true` + DTO Projection. Only **write paths** declare `readOnly = false` or `@Transactional` alone.

### 4.3 Dynamic queries — QueryDSL / Criteria

When search criteria are determined **at runtime**. JPQL string queries get fragile when conditions combine dynamically.

```java
public List<Order> search(OrderSearchCriteria c) {
    return queryFactory
        .selectFrom(order)
        .where(
            c.merchantId() != null ? order.merchantId.eq(c.merchantId()) : null,
            c.from() != null ? order.createdAt.goe(c.from()) : null,
            c.to() != null ? order.createdAt.lt(c.to()) : null,
            c.status() != null ? order.status.eq(c.status()) : null
        )
        .orderBy(order.createdAt.desc())
        .limit(20)
        .fetch();
}
```

QueryDSL's value is **compile-time type safety**. The cost is build setup (Q-class generation). Criteria API offers type safety too but is hard to read — QueryDSL is usually preferred.

### 4.4 JPQL's limit — no native functions

```java
// ❌ JPQL — JSON_EXTRACT isn't in the standard spec
@Query("SELECT o FROM Order o WHERE JSON_EXTRACT(o.metadata, '$.coupon') = :code")

// ✅ Native SQL — MySQL dialect directly
@Query(value = "SELECT * FROM orders WHERE JSON_EXTRACT(metadata, '$.coupon') = :code",
       nativeQuery = true)
```

Once native functions (window, JSON, FULLTEXT, recursive CTE) are needed, JPQL hits its limit and you reach for native query or JdbcTemplate.

---

## 5. The seat for Native SQL / JdbcTemplate / MyBatis {#5-native}

### 5.1 Native `@Query(nativeQuery = true)`

Keeps entity mapping, gains DB-specific features. Transactions / first-level cache / isolation continue to flow through JPA.

```java
@Query(value = """
    SELECT * FROM orders
    WHERE merchant_id = :id
      AND MATCH(description) AGAINST (:keyword IN BOOLEAN MODE)
    ORDER BY created_at DESC
    LIMIT 20
    """, nativeQuery = true)
List<Order> searchByFulltext(@Param("id") Long id, @Param("keyword") String keyword);
```

**Good fits**:
- Write paths that need entities but JPQL can't express (FULLTEXT, JSON, window functions)
- Bulk UPDATE that needs non-standard functions (PostgreSQL `UPDATE ... FROM`, MySQL `JSON_SET`)

**Bad fits**:
- Reads that don't need entities → DTO Projection (skip hydration cost)
- Library / framework code where DB portability is mandatory

### 5.2 JdbcTemplate

**No entity mapping at all**. The orthodox choice for statistics, reporting, bulk, migrations.

```java
@Service
public class SalesReportService {
    private final JdbcTemplate jdbc;

    public List<DailySalesDto> dailySales(Long merchantId, int days) {
        return jdbc.query("""
            SELECT
                DATE(created_at) AS day,
                SUM(amount) AS daily,
                AVG(SUM(amount)) OVER (
                    ORDER BY DATE(created_at)
                    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
                ) AS rolling_7d
            FROM orders
            WHERE merchant_id = ?
              AND created_at >= NOW() - INTERVAL ? DAY
            GROUP BY DATE(created_at)
            """,
            (rs, n) -> new DailySalesDto(
                rs.getDate("day").toLocalDate(),
                rs.getLong("daily"),
                rs.getDouble("rolling_7d")
            ),
            merchantId, days);
    }
}
```

**Pairs with Spring Batch readers** — JdbcCursorItemReader, JdbcPagingItemReader. The default for large backfills and migrations.

[External case: Woowacon — Spring Batch large-data processing](https://techblog.woowahan.com/2725/) recommends JdbcCursorItemReader over JpaItemReader for the same reason: JPA's entity-mapping cost is a loss on data-unit processing.

### 5.3 MyBatis

100% hand-written SQL with automatic result mapping. Korean financial / insurance / some enterprise codebases still use it as the orthodox tool. Coexists with JPA over a shared DataSource on the same transaction.

```xml
<!-- MyBatis mapper -->
<select id="findOrderList" resultType="OrderListDto">
    SELECT
        o.id, o.amount, o.created_at,
        m.name AS merchant_name
    FROM orders o
    JOIN merchants m ON m.id = o.merchant_id
    WHERE m.id = #{merchantId}
    ORDER BY o.created_at DESC
    LIMIT 20
</select>
```

```java
// JPA + MyBatis side by side
@Service
public class OrderQueryService {

    @Transactional(readOnly = true)
    public Page<OrderListDto> list(Long merchantId, Pageable p) {
        return mybatisMapper.findOrderList(merchantId, p);  // MyBatis read
    }

    @Transactional
    public void cancel(Long orderId) {
        Order o = jpaRepo.findById(orderId).orElseThrow();  // JPA write
        o.cancel();
    }
}
```

**MyBatis's seat**: domains where **fine SQL control** is the business value (insurance settlement, accounting close) — JPA's abstraction makes debugging more, not less, expensive. Absorbing legacy systems is also a common case.

### 5.4 Four Spring Batch readers — cross-link

Reader choice is decisive for large-volume processing.

| Reader | Trait | OFFSET? | Measurement |
|---|---|---|---|
| `JpaPagingItemReader` | OFFSET pagination + entity hydration | OFFSET ✓ | OFFSET 1M → 171ms (570× loss) |
| `JdbcCursorItemReader` | DB cursor, no entity mapping | OFFSET ✗ | cursor 0.30ms |
| `JpaCursorItemReader` | JPA + cursor (Hibernate ScrollableResults) | OFFSET ✗ | hydration cost remains |
| `QuerydslZeroOffset` (in-house) | Keyset pagination, no OFFSET | OFFSET ✗ | cursor 0.30ms |

The measurement [measurement — Java/Spring] from [OFFSET vs No-Offset cursor (EXP-07)](/en/posts/mysql-no-offset-cursor-pagination/):

| OFFSET position | Latency | rows scanned |
|---|---|---|
| 1,000 | 0.443ms | 1,020 |
| 10,000 | ~5ms | 10,020 |
| 100,000 | ~50ms | 100,020 |
| **1,000,000** | **171ms** | **1,000,020** |
| **No-Offset cursor** | **0.30ms** | 20 |

**About 570× difference** (171 / 0.30). The "owner clicked deep page" P99 incident is exactly this measurement — one click on page 50K can topple P99.

One more trap — **how you write No-Offset** opens another 500× split. The ANSI SQL row constructor `(a,b) < (?,?)` is semantically equivalent to OR-split form, but the MySQL optimizer **can't push it down to an index range**. 154ms (almost identical to OFFSET). Only the OR-split form lands at 0.30ms.

The takeaway — **data-unit processing is JPA's loss zone**. The OFFSET trap in JpaPagingItemReader vanishes the moment you switch readers.

---

## 6. Command / Query separation — a light Greg Young CQRS {#6-cqrs-light}

### 6.1 Greg Young's CQRS Documents (2010)

[Greg Young, **CQRS Documents** (2010)](https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf) defines **Command Query Responsibility Segregation**.

> "CQRS is simply the creation of two objects where there was previously only one. The separation occurs based upon whether the methods are a command or a query (the same definition that is used by Meyer in **Command and Query Separation**, but, CQRS uses a separate object)."
> — Greg Young, **CQRS Documents**, 2010

Core definitions:

1. **Command** — a method that **changes** system state. Returns void (deliberately)
2. **Query** — a method that **only reads** state. No change
3. **Separation** — Commands and Queries on **different objects** (or **different models**)

**Full CQRS** adds Event Sourcing on the command side and a separate read model + separate DB / index on the query side — **that's not what this article recommends**. Greg Young himself, in the same document, notes that **full CQRS is rarely justified for most systems**.

### 6.2 Light split — two branches inside one domain

Without going to full CQRS, **logical separation alone** wins about 80% of the value:

```
                    ┌─────────────────────────────────┐
                    │      Order Domain               │
                    └─────────────────────────────────┘
                             │
                ┌────────────┴─────────────┐
                ▼                          ▼
        ┌──────────────┐          ┌──────────────┐
        │   Command    │          │     Query    │
        │              │          │              │
        │  JPA         │          │  JPQL DTO    │
        │  Aggregate   │          │  Projection  │
        │  Dirty Check │          │  readOnly=T  │
        └──────────────┘          └──────────────┘
                │                          │
                ▼                          ▼
        ┌──────────────┐          ┌──────────────┐
        │ OrderCommand-│          │ OrderQuery-  │
        │ Service      │          │ Service      │
        │ .place()     │          │ .list()      │
        │ .cancel()    │          │ .summary()   │
        │ .refund()    │          │ .detail()    │
        └──────────────┘          └──────────────┘
```

Same domain (`Order`), but write path and read path are **different code / different models**:

```java
// Command path — JPA Aggregate
@Service
public class OrderCommandService {
    @Transactional
    public void cancel(Long orderId) {
        Order o = repo.findById(orderId).orElseThrow();
        o.cancel();  // domain method
    }
}

// Query path — DTO Projection
@Service
public class OrderQueryService {
    @Transactional(readOnly = true)
    public Page<OrderListDto> list(Long merchantId, Pageable p) {
        return repo.findOrderList(merchantId, p);
    }

    @Transactional(readOnly = true)
    public OrderDetailDto detail(Long orderId) {
        return repo.findOrderDetail(orderId);
    }
}
```

What this split buys you:
1. **No entity hydration on the query path** — no first-level cache / Dirty Checking / snapshot cost
2. **Cohesive domain methods on the command path** — Rich Domain
3. **Easy read-traffic offload** — only the query path can move to a read replica
4. **Read and write models can differ** — queries are free to join / aggregate

### 6.3 [External case: Woowacon — Spring Batch + DTO Projection](https://techblog.woowahan.com/2725/)

Woowacon's large-data retrospective explicitly states the pattern: **reads via JdbcCursorItemReader or DTO Projection**, **writes via JPA Aggregate**. They didn't go to full CQRS — they split into two branches inside one codebase.

### 6.4 Anti-pattern of the split

```java
// ❌ Command and Query mashed together
@Service
public class OrderService {
    @Transactional
    public OrderDto getAndCancel(Long id) {  // intent unclear
        Order o = repo.findById(id).orElseThrow();
        o.cancel();
        return new OrderDto(o);  // Query? Command?
    }
}
```

Callers can't read the intent. The function name `getAndCancel` is the burning sign. Greg Young's **Meyer Command-Query Separation** principle — **no return value on a method that mutates**.

---

## 7. Decision tree — mapping scenarios you can hold in hand {#7-decision-tree}

### 7.1 The decision tree (ASCII)

```
[ a piece of work arrives ]
       │
       ▼
Q1: write or read?
   ├─ write → Q2
   └─ read → Q5

Q2: row count predictable in tens to hundreds?
   ├─ YES → Q3
   └─ NO (thousands+) → Q4

Q3: a single Aggregate's invariant change?
   ├─ YES → JPA Dirty Checking + Rich Domain
   │        (first-level cache + Unit of Work + Optimistic Lock)
   └─ NO (multiple Aggregates / external) → Saga (post 8)

Q4: row count
   ├─ thousands → JPQL @Modifying bulk UPDATE / DELETE
   │              (PersistenceContext bypass, clearAutomatically=true)
   ├─ tens of thousands → raw JDBC batchUpdate
   │                       (avoid Dirty Checking 84× gap)
   └─ tens of thousands of INSERTs → raw JDBC + rewriteBatchedStatements=true
                                      (avoid saveAll IDENTITY ~1000×)

Q5: read — simple / complex / statistical
   ├─ simple (single Aggregate by ID) → JPA findById + readOnly
   ├─ complex (join + paging) → JPQL DTO Projection + readOnly
   │                              (deep paging → No-Offset cursor — 570×)
   └─ statistics / reporting / aggregation → JdbcTemplate + Native SQL
                                              (window function / CTE / JSON)
```

### 7.2 Scenario mapping table

| Scenario | Row count | Aggregate? | Tool |
|---|---|---|---|
| Payment webhook | 1 | single (Subscription) | JPA Dirty Checking |
| Order create + external PG | 1 + external | 1 + distributed | JPA + Saga |
| Balance deduct (high-contention) | 1 | single | JPA + pessimistic (180ms) |
| Balance deduct (low-contention) | 1 | single | JPA + optimistic (`@Version`) |
| Bulk-expire stale coupons | thousands ~ tens of thousands | data unit | JPQL `@Modifying` |
| 10K-row migration | 10K | data unit | raw JDBC batchUpdate |
| Owner daily sales report | 30 | data unit | JdbcTemplate + window function |
| Search (FULLTEXT) | 20 | single read | Native @Query + MATCH |
| Owner dashboard order list | 20 (paged) | data unit | JPQL DTO + No-Offset cursor |
| Notification publish (eventually consistent) | 1 + external | distributed | Outbox (post 8) |
| Statistics close (month-end) | hundreds of thousands | data unit | Spring Batch + JdbcCursorItemReader |

### 7.3 Variables that move the cuts

The cuts in this tree rest on **this environment's measurements**. Other environments shift them:

| Variable | Effect |
|---|---|
| Hibernate 6 bytecode enhancement | Dirty Checking cost down 30~40% (S1 shifts) |
| MySQL Connector/J version | Different `rewriteBatchedStatements` payoff |
| InnoDB buffer-pool size | OFFSET cost varies (cache effect) |
| Concurrency / contention pattern | Lock-choice cut shifts |
| Network latency (DB ↔ app) | First-level cache hit is more valuable |

Honest about the limits — **the cuts are this environment's numbers**, not universal constants. Measure before adopting.

---

## 8. Four measurements that draw the cuts {#8-measurements}

The four measurements that act as the **hub** of this article.

### 8.1 Measurement table

| Measurement | Ratio | Meaning | Source |
|---|---|---|---|
| 10K-row UPDATE: Dirty Checking vs raw JDBC | **132×** (3,450ms / 26ms) | The cost a method without readOnly carries | [Dirty Checking snapshot cost (EXP-13)](/en/posts/jpa-dirty-checking-snapshot-cost/) |
| 10K-row UPDATE: Dirty Checking vs bulk JPQL | **84×** (3,450ms / 41ms) | Switching the model itself to bulk JPQL | same |
| `@DynamicUpdate` alone vs raw JDBC | **68×** (2,123ms / 31ms) | `@DynamicUpdate` alone isn't enough | same |
| bulk JPQL vs raw JDBC | **1.32×** (41ms / 31ms) | JPA abstraction adds about 30% | same |
| `saveAll(IDENTITY)` vs raw JDBC batch | **~1000×** (10K SQLs vs ~10 SQLs) | IDENTITY disables batching | [saveAll IDENTITY trap (EXP-14)](/en/posts/jpa-saveall-identity-bulk-insert-trap/) |
| OFFSET 1M vs No-Offset cursor | **570×** (171ms vs 0.30ms) | OFFSET cost on deep pages | [No-Offset cursor (EXP-07)](/en/posts/mysql-no-offset-cursor-pagination/) |
| Pessimistic vs optimistic (high-contention) | 3× (180ms vs 549ms) | Lock choice by contention pattern | [4-lock comparison (EXP-02)](/en/posts/mysql-credit-concurrency-lock-comparison/) |
| raw JDBC vs JPA (warm) | 1.35× (0.74ms vs 0.99ms) | JPA baseline +0.4ms | [PersistenceContext flush (post 1)](/en/posts/jpa-spring-mastery-01-persistence-context-flush/) |

### 8.2 Where each cut lives

```
              row count / work scale
                  │
   1 ───── 100 ──── 1,000 ───── 10,000 ──── 100,000 ───>
                  │              │              │
                  │              │              │
   JPA Dirty C    │              │              │
   ←──── good ──→ │              │              │
                  │              │              │
                  │  JPQL bulk   │              │
                  │←─── good ───→│              │
                  │              │              │
                  │              │  raw JDBC    │
                  │              │←──── good ──→│
                  │              │              │
   84× cut ────────────────────→│              │
                  │              │              │
   1000× cut ────────────────────────────────→ │ (IDENTITY)
                  │              │              │
   570× cut (OFFSET) — page depth around 50K

cut values are approximate — they shift with environment / data / concurrency
```

### 8.3 Examples of cuts moving in different environments

| Environment | Dirty Checking 84× cut shift | Case |
|---|---|---|
| **bytecode enhancement** | Down 30~40% → JPA stays viable up to tens of thousands | Hibernate 6 + build enhancement |
| **batch_size + non-IDENTITY** | INSERT cut disappears | UUID / TableGenerator pooled-lo |
| **read-only path** | Dirty Checking cost = 0 | `readOnly = true` (post 1's Kakao Pay retro) |
| **repeat-read path** | First-level cache hit value rises | same entity touched 4-5 times |

These cuts are **recommended starting points**, not fixed values. Measure before adoption.

---

## 9. Interview answer — 1 minute / 5 minutes / 30 minutes {#9-interview}

### 9.1 1-minute hook

> "JPA is a tool for expressing small-unit domain consistency in code, not a substitute for all SQL. It shines on atomic Aggregate change — a payment webhook touching 5 entities at once — and bleeds 84× on data-unit work like a 10K-row bulk UPDATE. The first fork in tool selection is one question: is this work a domain unit or a data unit?"

### 9.2 5 minutes — five steps

**Step 1 — first fork**: domain unit (invariant change inside an Aggregate boundary) vs data unit (statistics / bulk / reporting). Eric Evans' Aggregate Root from DDD anchors this fork.

**Step 2 — where JPA shines**: atomic Aggregate change, first-level cache hit (Identity Map), Optimistic Lock + `@Version`, Rich Domain methods, Cascade + Orphan Removal. Built on Fowler's Identity Map / Unit of Work.

**Step 3 — where JPA bleeds + measurements**:
- 10K-row UPDATE: Dirty Checking 3,450ms vs bulk JPQL 41ms = **84×**
- saveAll(IDENTITY) 10K INSERTs: 10K SQLs vs raw JDBC batch ~10 SQLs = **~1000×**
- statistics / window function / FULLTEXT: outside JPQL's reach
- complex join + N+1: avoid via DTO Projection

**Step 4 — JPQL's middle seat**: `@Modifying(clearAutomatically = true)` bulk UPDATE, DTO Projection, QueryDSL dynamic queries. Knowing the PersistenceContext bypass and the stale-cache trap.

**Step 5 — Command / Query split**: a **light** application of Greg Young's CQRS Documents (2010). Without going to full CQRS, **two branches inside the same domain** (Command = JPA Aggregate / Query = DTO Projection + readOnly) deliver about 80% of the win. [External case: Kakao Pay readOnly QPS 58% drop](https://tech.kakaopay.com/post/jpa-transactional-bri/) is the operational measurement of that win.

### 9.3 30 minutes — defending five follow-ups

**Q1. What's the anatomy of Dirty Checking cost?**

Vlad Mihalcea's **High-Performance Java Persistence** (2016, Chapter 5) breaks it down — Hibernate's hydrator builds an **Object[] (loadedState)** by **copying** the SELECT result and stashes it next to the entity. At flush time, every managed entity × every column is compared via reflection. `O(N × M)` cost. 10K entities × 10 columns = 100K comparisons + 10K UPDATEs. The fix is reshaping the **model itself** into bulk (S5, 41ms = 84× win). `@DynamicUpdate` only shrinks the SET clause (S4 = 2,123ms, still 68× slower than raw JDBC).

***Q2. Why is JPA bulk **fundamentally* 84× slow?**

Three axes. (1) Entity hydration — 10K rows become 10K Java objects + Object[] snapshots. (2) Dirty Checking — full sweep at flush. (3) `Statement.RETURN_GENERATED_KEYS` incompatible with batching (for IDENTITY). Bulk JPQL bypasses (1) and (2) — one direct UPDATE to the DB. raw JDBC bypasses (3) too — multi-value INSERT or batchUpdate.

**Q3. How does JPQL bulk make the PersistenceContext stale, and how do you fix it?**

`@Modifying` bulk UPDATE **bypasses** the PersistenceContext. The DB receives a direct UPDATE. Entities already loaded inside the same transaction stay at their pre-change state — the cache and the DB diverge. Fixes: `@Modifying(clearAutomatically = true)` clears the cache automatically, or design the flow so the entities aren't read again. Also `flushAutomatically = true` to flush **pending** dirty changes **before** the bulk fires (so Dirty Checking results land in the DB first).

**Q4. If it isn't CQRS, why is Command / Query separation worth it?**

Greg Young himself acknowledges, in the same document, the cost of **full** CQRS. Without going to Event Sourcing + a separate read model, just respecting **Meyer Command-Query Separation** delivers about 80% of the win. Concretely: (1) a readOnly + DTO Projection query path pays zero first-level cache / Dirty Checking / snapshot cost. (2) Command-path domain methods stay cohesive (Rich Domain). (3) Read-traffic offload becomes easy (read replica). (4) Read and write models can differ. Kakao Pay's readOnly QPS 58% drop is the operational measurement of (1).

**Q5. Transaction sync when JPA and MyBatis coexist?**

Sharing the same DataSource, Spring's `DataSourceTransactionManager` binds both onto one connection. JPA's `EntityManager` and MyBatis's `SqlSession` join the **same transaction**. Traps: (1) JPA's **deferred flush** and MyBatis's **direct SQL** can re-order — if MyBatis SELECTs while JPA changes are unflushed, it sees the **pre-change** row. Fix: `entityManager.flush()` before MyBatis. (2) Stale first-level cache — after a MyBatis UPDATE in the same transaction, JPA's `findById` returns the **pre-change** object. Fix: `entityManager.clear()` or `refresh()`. (3) Isolation — same connection, same isolation level, but MyBatis must **consciously understand MVCC visibility** to be debuggable.

---

## 10. Closing the series {#10-conclusion}

### 10.1 One-sentence summary

> JPA is a tool for expressing small-unit domain consistency in code, not a replacement for all SQL. It shines on atomic change inside an Aggregate boundary, and bleeds 84× ~ 1000× on data-unit work (bulk UPDATE / saveAll IDENTITY / statistics). The first fork in tool selection is **domain unit or data unit?**, and the answer is decided by four measurement cuts (132× / 84× / ~1000× / 570×).

### 10.2 The evidence chain across posts 1 ~ 9

| Post | Measurement / academic anchor | Place on the decision tree |
|---|---|---|
| **01 PersistenceContext / Flush** | raw 0.74ms vs JPA 0.99ms = 1.35× / Fowler Identity Map / Kakao Pay readOnly QPS 58% | JPA baseline + readOnly effect |
| **02 N+1 / Entity Graph** ([deep dive](/en/posts/jpa-n-plus-1-entity-graph-deep-dive/)) | MultipleBagFetchException / pagination OOM / OneToOne LAZY-as-EAGER / `@BatchSize` | Four traps of complex joins |
| **03 Optimistic Lock** ([lost update](/en/posts/jpa-optimistic-lock-lost-update/)) | pessimistic 180ms / optimistic 549ms / GET_LOCK 5,015ms | Lock choice by contention pattern |
| **04 Dirty Checking cost** ([snapshot cost](/en/posts/jpa-dirty-checking-snapshot-cost/)) | 132× / 68× / 84× / Vlad Mihalcea Hibernate 6 loadedState | Bulk's 84× cut |
| **05 saveAll IDENTITY** ([trap](/en/posts/jpa-saveall-identity-bulk-insert-trap/)) | ~1000× / `RETURN_GENERATED_KEYS` incompatibility | INSERT's 1000× cut |
| **06 (planned) QueryDSL dynamic queries** | type-safe dynamic conditions | JPQL middle seat |
| **07 self-invocation** ([AOP proxy](/en/posts/jpa-spring-mastery-07-aop-self-invocation/)) | `successes=100` with unchanged balance / 6 annotations / Spring AOP proxy | Operational diagnosis |
| **08 transaction split** ([Saga / Outbox](/en/posts/jpa-spring-mastery-08-tx-split-saga-outbox/)) | 9-scenario matrix / Garcia-Molina 1987 / Helland CIDR 2005 | Beyond the Aggregate |
| **09 (this post)** | 4 measurement cuts / decision tree / Greg Young CQRS / Eric Evans Aggregate | The **hub** of the series |

### 10.3 Operational checklist

- [ ] PR review — estimate row count of changes (hundreds / thousands / tens of thousands)
- [ ] Is the write path inside a single Aggregate boundary? Multiple Aggregates → design Saga / Outbox
- [ ] Audit read paths for missing `@Transactional(readOnly = true)`
- [ ] DTO Projection vs entity load — **non-mutating paths** prefer DTO
- [ ] On encountering saveAll(`IDENTITY`) — pick UUID / TableGenerator pooled-lo / raw JDBC batch
- [ ] Monitor OFFSET-paging depth; migrate to cursor past page 50K
- [ ] Window / CTE / FULLTEXT → Native query or JdbcTemplate
- [ ] Is Command / Query separation visible at the service level?
- [ ] Audit bulk JPQL `@Modifying` for missing `clearAutomatically = true`

### 10.4 Closing the series

This series ran a three-layer cadence — **measurements** to start, **academic sources** for depth, **Korean tech retrospectives** to validate operational reality. Eric Evans' Aggregate, Fowler's Identity Map / Unit of Work, Greg Young's CQRS, Vlad Mihalcea's Hibernate internals, Pat Helland's Idempotence — these anchors stick when they're tied to **when / where / under what conditions** a measurement was taken.

The goal was an entry point you can hand over with a single URL when an interviewer asks "how have you used JPA?". From post 1's PersistenceContext to post 9's decision tree, eight posts of evidence now live on one tree.

Whatever the next tool turns out to be, the **principle** behind the cuts stays the same: **is this work a domain unit or a data unit?** That single question is the first fork, and validating the answer with measurements and academic anchors is how a global senior engineer holds a tool.

---

## 11. References {#references}

### Academic (L5)

- ***Eric Evans — **Domain-Driven Design* (Addison-Wesley, 2003)** — Aggregate Root, Bounded Context, Repository definitions. [DDD Community](https://www.dddcommunity.org/book/evans_2003/)
- **Martin Fowler — **Patterns of Enterprise Application Architecture** (Addison-Wesley, 2002)** — Identity Map, Unit of Work, Active Record vs Data Mapper, Repository, Domain Model. [eaaCatalog](https://martinfowler.com/eaaCatalog/)
- **Greg Young — **CQRS Documents** (2010)** — Command Query Responsibility Segregation + Meyer's Command-Query Separation. [CQRS Documents PDF](https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf)
- **Vlad Mihalcea — **High-Performance Java Persistence** (Manning, 2016)** — JPA cost measurement + Hibernate 6 internals (loadedState, ActionQueue, FlushMode). [vladmihalcea.com](https://vladmihalcea.com/books/high-performance-java-persistence/)
- **Pat Helland — **Idempotence Is Not a Medical Condition** (ACM Queue, 2012)** — idempotence in bulk processing. [ACM Queue](https://queue.acm.org/detail.cfm?id=2187821)
- **Hector Garcia-Molina, Kenneth Salem — **Sagas** (ACM SIGMOD, 1987)** — the Saga origin. [ACM DL](https://dl.acm.org/doi/10.1145/38713.38742)
- **Pat Helland — **Data on the Outside vs Data on the Inside** (CIDR, 2005)** — the academic origin of Outbox. [PDF](http://cidrdb.org/cidr2005/papers/P12.pdf)
- **Bertrand Meyer — **Object-Oriented Software Construction** (Prentice Hall, 1997)** — Command-Query Separation principle

### Official documentation (tier 1)

- [Hibernate ORM 6.6 User Guide](https://docs.jboss.org/hibernate/orm/6.6/userguide/html_single/Hibernate_User_Guide.html) — bytecode enhancement, FlushMode, batch_size
- [JPA 2.2 Specification (JSR 338)](https://jakarta.ee/specifications/persistence/) — `GenerationType.IDENTITY`, JPQL spec
- [Spring Data JPA Reference](https://docs.spring.io/spring-data/jpa/reference/) — `@Modifying`, `@Query`, projection
- [Spring Framework — Declarative Transaction Management](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative.html)
- [QueryDSL Reference](http://querydsl.com/static/querydsl/latest/reference/html/) — type-safe queries
- [Spring Batch Reference — ItemReader](https://docs.spring.io/spring-batch/reference/readers-and-writers/) — Jpa / Jdbc Cursor / Paging Reader

### Korean tech retrospectives

- **Kakao Pay** — [Are you really using JPA Transactional?](https://tech.kakaopay.com/post/jpa-transactional-bri/) — readOnly + `Com_set_option` QPS 58% drop
- **Toss SLASH24** — [SAGA distributed transaction compensation](https://haon.blog/article/toss-slash/msa-reward-transaction/) — JPA Aggregate inside Saga steps
- **Woowacon / Woowahan** — [Spring Batch + large-data processing](https://techblog.woowahan.com/2725/) — JdbcCursorItemReader recommended
- **Woowahan** — [Wait, why is this rolling back?](https://techblog.woowahan.com/2606/) — REQUIRED rollback-only trap
- **29CM** — [Transactional Outbox in production](https://medium.com/@greg.shiny82/%ED%8A%B8%EB%9E%9C%EC%9E%AD%EC%85%94%EB%84%90-%EC%95%84%EC%9B%83%EB%B0%95%EC%8A%A4-%ED%8C%A8%ED%84%B4%EC%9D%98-%EC%8B%A4%EC%A0%9C-%EA%B5%AC%ED%98%84-%EC%82%AC%EB%A1%80-29cm-0f822fc23edb)

### Canonical authors

- [Vlad Mihalcea — High-Performance Java Persistence Newsletter](https://vladmihalcea.com/) — Hibernate 6 internals, batch insert, `@DynamicUpdate`
- [Martin Fowler — eaaCatalog](https://martinfowler.com/eaaCatalog/) — Identity Map, Unit of Work, Repository, Domain Model
- [Greg Young — CQRS Documents](https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf)

### Series companions + measurement sources

- **Series 01** — [PersistenceContext / Flush](/en/posts/jpa-spring-mastery-01-persistence-context-flush/) — JPA baseline +0.4ms, Kakao Pay readOnly retro
- **Series 07** — [Spring AOP self-invocation](/en/posts/jpa-spring-mastery-07-aop-self-invocation/) — operational diagnosis
- **Series 08** — [Saga / Outbox / REQUIRES_NEW](/en/posts/jpa-spring-mastery-08-tx-split-saga-outbox/) — beyond the Aggregate
- **W4 P2 EXP-13** — [Dirty Checking snapshot cost](/en/posts/jpa-dirty-checking-snapshot-cost/) — 132× / 84× / 68× measurements
- **W4 P4 EXP-14** — [saveAll IDENTITY trap](/en/posts/jpa-saveall-identity-bulk-insert-trap/) — ~1000× measurement
- **W4** — [Optimistic Lock Lost Update](/en/posts/jpa-optimistic-lock-lost-update/) — optimistic-lock mechanics
- **W4** — [N+1 Entity Graph deep dive](/en/posts/jpa-n-plus-1-entity-graph-deep-dive/) — four traps
- **W3 EXP-02** — [4-lock comparison](/en/posts/mysql-credit-concurrency-lock-comparison/) — pessimistic 180ms measurement
- **W2 EXP-07** — [No-Offset cursor pagination](/en/posts/mysql-no-offset-cursor-pagination/) — 570× measurement
