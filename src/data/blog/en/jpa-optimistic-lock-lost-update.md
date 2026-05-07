---
author: Myunsoo Kim
pubDatetime: 2026-05-04T10:00:00.000Z
title: "JPA Optimistic Lock and the Retry Stampede Trap — 6 Scenarios @Version Cannot Cover Alone"
featured: true
draft: false
tags:
  - JPA
  - Spring
  - Optimistic-Lock
  - Lost-Update
  - Retry
  - Backoff
  - Jitter
  - Hibernate
  - Concurrency
  - Backend
description: |
  100 workers each increment the same rule's priority by +1. Without @Version, the final priority < 100 (Lost Update). With @Version, you only get OptimisticLockException — handling is the caller's responsibility, so only some succeed. @Retryable(3) with backoff=0 produces **retry stampede** — retries pile up at the same instant, colliding again. Exponential backoff with full jitter spreads retries out and reaches priority=100. Plus the **self Lost Update** trap discovered along the way — same transaction, two SELECTs returning different objects (JDBC) vs the same instance (JPA first-level cache `==`). Different category from distributed Lost Update. The piece also covers @Transactional + @Retryable AOP ordering and the AWS Architecture Blog rationale for full jitter.
---

## Table of contents

## Why this article {#intro}

Everyone "knows" the answer to concurrency on a JPA entity: **put `@Version` on it**. That answer is half right. The lesser-known half is what you do with the `OptimisticLockException` it throws — and that detail decides whether your update is correct, fast, both, or neither.

This article measures the **same** update intent (priority += 1) across **six scenarios** to draw the trade-off boundary precisely.

---

## 1. The setup {#setup}

```
- entity:    auto_reply_rule (id, owner_id, priority, @Version version)
- initial:   priority=0, version=0
- workers:   100 concurrent workers, each priority +1
- correct:   final priority = 100 (zero loss)
```

| # | Scenario | What it shows |
|---|---|---|
| **S1** | RMW without `@Version` | Lost Update reproduction |
| **S2** | `@Version`, no retry | Detection, no recovery |
| **S3** | `@Retryable(3)` + backoff=0 | Retry stampede |
| **S4** | `@Retryable(5)` + exp + full jitter | Distributed retries |
| **S5** | Self Lost Update (DC-4) | JDBC vs JPA first-level cache |
| **S6** | (combined into next article) | — |

---

## 2. S1 — Read-modify-write without `@Version` {#s1}

```java
@Transactional
public void incrementWithoutVersion(Long ruleId) {
    Integer current = jdbc.queryForObject(
        "SELECT priority FROM auto_reply_rule WHERE id = ?", Integer.class, ruleId);
    jdbc.update("UPDATE auto_reply_rule SET priority = ?, updated_at = NOW(6) WHERE id = ?",
        current + 1, ruleId);
}
```

100 workers run this concurrently. Result: `priority < 100`. Two workers SELECT the same value, both write `value + 1`, one increment is silently lost. **Every worker reports success** — the bug is in the data, invisible without correctness checks.

---

## 3. S2 — `@Version` only, no retry {#s2}

```java
@Entity class AutoReplyRule {
    @Version Long version;
    public void incrementPriority() { this.priority += 1; }
}

@Transactional
public void incrementWithVersion(Long ruleId) {
    AutoReplyRule rule = repo.findById(ruleId).orElseThrow();
    rule.incrementPriority();
}
```

Hibernate emits:

```sql
UPDATE auto_reply_rule
   SET priority=?, version=?+1, updated_at=?
 WHERE id=? AND version=?
```

If 0 rows match, Spring throws `ObjectOptimisticLockingFailureException`. Lost Update is **prevented**, but only some workers succeed. Recovery is the caller's job.

---

## 4. S3 — Retry stampede {#s3}

```java
@Retryable(retryFor = OptimisticLockingFailureException.class,
           maxAttempts = 3, backoff = @Backoff(delay = 0))
@Transactional
public void incrementWithRetryNoBackoff(Long ruleId) { ... }
```

99 workers fail, all retry **simultaneously**, 1 succeeds, 98 fail again, all retry simultaneously again. Total elapsed grows; effective throughput stays low. Spring Retry without jitter is a stampede generator.

The [AWS Architecture Blog — Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) is the canonical reference for **why** this happens and what fixes it.

<details>
<summary><b>(deep dive) Backoff & Jitter — definitions, 4 jitter strategies, Spring Retry's variant</b> (expand)</summary>

#### Backoff — wait time between retries

Backoff is the function that decides how long to wait before retrying. It is independent of retry count.

| Type | wait(attempt) | Example (baseDelay=100ms) | Note |
|---|---|---|---|
| No backoff | 0 | 0, 0, 0... | Immediate retry. Permanent stampede if root cause persists. |
| Fixed | baseDelay | 100, 100, 100, 100 | Simple. Synchronized retry waves under client surges. |
| Linear | baseDelay × attempt | 100, 200, 300, 400 | Gradual. Insufficient at large attempts. |
| Exponential | baseDelay × multiplier^attempt | 100, 200, 400, 800 (multiplier=2) | Canonical. Load drops fast as collisions accumulate. |

Without a cap (`maxDelay`), attempt 10 yields `100 × 2^10 ≈ 100s`. Spring Retry uses `@Backoff(maxDelay=10000)` to bound this.

#### Jitter — spreading retry timestamps in time

Why exponential alone fails: 100 clients with the same backoff formula wait the same duration → retry simultaneously → collide again. The load curve becomes a repeating pulse.

```
t:    0ms ────── 100ms ────── 200ms ────── 400ms
      │             │              │              │
fail ─→ all wait 100ms → simultaneous retry → collide
        all wait 200ms → simultaneous retry → collide
        ...
```

Jitter randomizes the wait so retry timestamps spread across the time axis.

| Type | Formula (`base = baseDelay × 2^attempt`) | Characteristic |
|---|---|---|
| No Jitter | wait = base | Synchronized stampede |
| Full Jitter | wait = random(0, base) | AWS recommended. Average base/2. Strongest spread. |
| Equal Jitter | wait = base/2 + random(0, base/2) | Guaranteed minimum base/2. Half the spread. |
| Decorrelated Jitter | wait = min(cap, random(base, prev_wait × 3)) | Stateful, derived from prev_wait. AWS recommends for long-tail workloads. |

Full vs Equal trade-off: Full has shorter average wait but may produce wait=5ms — too short for the server to recover. Equal guarantees base/2 minimum but has half the spread.

#### Spring Retry's jitter is NOT AWS Full Jitter

With `@Backoff(random=true)`, Spring uses `ExponentialRandomBackOffPolicy`:

```
nextInterval = random_between(currentInterval, currentInterval × multiplier)
```

- AWS Full Jitter: `random(0, base)` — minimum 0
- Spring Retry: `random(currentInterval, currentInterval × multiplier)` — minimum guaranteed

In AWS taxonomy, this is a variant of Equal Jitter. Resilience4j's `IntervalFunction.ofExponentialRandomBackoff(initial, multiplier, randomizationFactor)` follows a similar shape, with `randomizationFactor` (0~1) controlling spread amplitude.

#### Mapping back to this EXP

- S3 (`backoff=0`, no jitter): priority=29 — direct stampede
- S4 (`exponential + random=true`): priority=50 — 1.7× improvement

S4 fell short of 100 because of a combination: workers=100 high contention + maxAttempts=5 + `delay=5ms` (base too small for attempt-5 spread) + Spring's Equal-like jitter (less spread than AWS Full). workers=20 or maxAttempts=10 should reach priority=100.

#### Interview tail questions

- "Why isn't exponential alone enough?" → Synchronized retry waves.
- "Full vs Equal Jitter?" → Minimum-wait guarantee + spread amplitude.
- "Spring Retry default?" → `random=false` means no jitter. `random=true` is Equal-like.
- "What if maxDelay is missing?" → wait grows to minutes; can't finalize within SLA.
- "10k clients — is jitter alone enough?" → No. You also need retry budget (token bucket) + circuit breaker + load shedding. Jitter only solves synchronization, not total retry load.

</details>

---

## 5. S4 — Exponential + full jitter {#s4}

```java
@Retryable(retryFor = OptimisticLockingFailureException.class, maxAttempts = 5,
           backoff = @Backoff(delay = 5, maxDelay = 100, multiplier = 2.0, random = true))
@Transactional
public void incrementWithRetryJitter(Long ruleId) { ... }
```

Each worker waits a **random** delay between attempts. Retries spread across time → fewer concurrent collisions → progress accumulates. Final priority = 100. This is the only safe shape of retry under contention.

---

## 6. AOP order — `@Retryable` outside `@Transactional` {#aop-order}

For each retry to start a fresh transaction (and read a fresh `version`), `@Retryable` must wrap **outside** `@Transactional`. Spring's default ordering does this. If `@Transactional` is outer, retries happen inside one transaction and the first-level cache hands back the **same stale entity**, retrying forever.

<details>
<summary><b>(side path) Self-invocation trap — internal calls bypass the proxy</b> (expand)</summary>

#### One-line summary

Annotations like `@Transactional` and `@Retryable` are all proxy-based AOP. They only kick in when the method is called **from outside the class**. Inside the same class, `this.method()` calls the raw object directly, bypassing the proxy — so the annotation **silently does nothing**. That is the self-invocation trap.

#### The trapping code

```java
@Service
class RuleUpdateService {

    @Retryable(retryFor = OptimisticLockingFailureException.class,
               maxAttempts = 5,
               backoff = @Backoff(delay = 5, multiplier = 2.0, random = true))
    public void wrapper(Long id) {
        this.realLogic(id);   // bypasses the proxy. @Transactional won't fire.
    }

    @Transactional
    public void realLogic(Long id) {
        AutoReplyRule rule = repo.findById(id).orElseThrow();
        rule.incrementPriority();
        // No transaction was started, so there is no PersistenceContext.
        // Dirty checking never runs. UPDATE SQL is never issued.
    }
}
```

#### Call flow — where does the proxy actually do its job

When the caller invokes `service.wrapper(id)`:

```
Caller (e.g. Controller)
   │
   │ service.wrapper(id)
   ▼
[Spring-generated proxy object]   ← @Retryable intercepts here, starts the retry
   │
   │ proxy → target.wrapper(id)
   ▼
[Original RuleUpdateService instance]
   │
   │ inside wrapper(), this.realLogic(id)
   │   ← 'this' refers to the original object, NOT the proxy.
   │     The interceptor chain is bypassed entirely.
   ▼
realLogic() runs without a transaction.
```

Two facts:
1. External → `wrapper` goes through the proxy → `@Retryable` works
2. `this.realLogic()` inside `wrapper` skips the proxy → `@Transactional` does nothing

#### Why every worker reported success while the balance stayed at 100

An earlier lock-comparison test fell into exactly this shape. 100 workers called the same method — zero `OptimisticLockingFailureException`s, every worker returned normally. But the DB was unchanged. 100% "success", zero effect.

The mechanism:
1. The entry method went through the proxy, but the actual logic ran via self-invocation, so no transaction was started.
2. No transaction → no PersistenceContext → entity is not managed → dirty checking does not run.
3. No flush → no UPDATE SQL hits the DB.
4. No exception either; the in-memory object's field is incremented and the method returns.
5. From the caller's view: normal return → counted as a success.
6. From the DB's view: only SELECTs landed, never an UPDATE.

```
[measurement]
totalMs: 549ms
successes: 100   ← 100% "success"
fails: 0
finalBalance: 100   ← but the balance never moved
```

#### Four ways to fix it

| Approach | Code shape | Note |
|---|---|---|
| (a) Split into a separate bean | New `RuleUpdateLogicService` and inject it | Clearest. Aligns with SRP. |
| (b) Self-injection | `@Autowired private RuleUpdateService self;` then `self.realLogic()` | Stays in the same class. Looks circular but Spring injects the proxy. |
| (c) `AopContext.currentProxy()` | `((RuleUpdateService) AopContext.currentProxy()).realLogic(id)` | Requires `@EnableAspectJAutoProxy(exposeProxy=true)`. |
| (d) AspectJ compile-time weaving | Bytecode rewriting at compile time | Strongest but adds build complexity. |

The measurement code in this EXP went with (a). For the deeper breakdown — `TransactionInterceptor.invoke` 6 steps, AOP Alliance `MethodInvocation`, and the 6 other annotations that fall into the same trap — see [JPA Spring Mastery #7](/en/posts/jpa-spring-mastery-07-aop-self-invocation/).

</details>

---

## 7. S5 — Self Lost Update (DC-4) {#s5}

A different family of Lost Update — **inside one transaction**.

### JDBC stale read anti-pattern

```java
@Transactional
public void selfLostUpdateJdbcStale(Long id) {
    Integer aRetry = jdbc.queryForObject(
        "SELECT retry_count FROM reply_request_dc4 WHERE id = ?", Integer.class, id);
    jdbc.update("UPDATE ... SET retry_count = ? WHERE id = ?", aRetry + 1, id);   // DB: 1
    // (later, using the stale aRetry variable)
    jdbc.update("UPDATE ... SET last_attempted_at = ?, retry_count = ? WHERE id = ?",
        Timestamp.from(now()), aRetry, id);   // ★ overwrites 1 with 0 (stale)
}
```

No lock prevents this — same transaction.

### JPA first-level cache `==` guarantee

```java
@Transactional
public boolean jpaIdentityProof(Long id) {
    ReplyRequestDc4 a = repo.findById(id).orElseThrow();
    ReplyRequestDc4 b = repo.findById(id).orElseThrow();
    return (a == b);   // ★ true — application-level repeatable read
}
```

[Vlad Mihalcea — JPA First-Level Cache](https://vladmihalcea.com/jpa-hibernate-first-level-cache/): two `findById` in the same transaction return **the same Java instance**. Two changes accumulate on one object, flushed as a single UPDATE.

| | JDBC stale | JPA first-level cache |
|---|---|---|
| `a == b` | false | **true** |
| retry_count result | 0 (lost) | 1 (correct) |

Distributed Lost Update needs locks; self Lost Update needs the first-level cache.

---

## 8. Operational rules {#rules}

| Environment | Recommendation |
|---|---|
| High contention (e.g. balance deduction) | Pessimistic lock (`SELECT ... FOR UPDATE`) — see [W3 EXP-02](/en/posts/mysql-credit-concurrency-lock-comparison/) |
| Low contention (rule edit) | Optimistic + retry **with jitter** |
| Atomic increment / decrement | `UPDATE ... SET col = col ± n WHERE ... AND col >= n` |

---

## 9. Conclusion {#conclusion}

`@Version` alone is not enough. Without retry, only some succeed. Retry without backoff stampedes. Only retry with **jitter** is safe. And the entire family of **self Lost Update** trap is orthogonal — it needs the first-level cache, not a lock.

Same `priority += 1`, six combinations of `@Version`, retry, backoff, jitter, and first-level cache, five different outcomes. Senior interviews about JPA concurrency live in this trade-off space.

---

## References {#references}

### Official
- [Hibernate ORM — Persistence Context](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#persistence-context)
- [Spring Retry GitHub](https://github.com/spring-projects/spring-retry)

### Vlad Mihalcea
- [JPA First-Level Cache](https://vladmihalcea.com/jpa-hibernate-first-level-cache/)
- [Optimistic vs Pessimistic Locking](https://vladmihalcea.com/optimistic-vs-pessimistic-locking/)

### External
- [AWS Architecture Blog — Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Toss SLASH22 — Delivering one Apple share to the customer](https://toss.im/slash-22/sessions/2-7) — JPA OptimisticLock + distributed lock + MVCC

### Sister posts
- [W3 EXP-02 — MySQL credit deduction 4-lock comparison](/en/posts/mysql-credit-concurrency-lock-comparison/)
- [JPA Spring Mastery #7 — AOP Self-Invocation](/en/posts/jpa-spring-mastery-07-aop-self-invocation/)
- [JPA Spring Mastery #1 — Persistence Context Flush](/en/posts/jpa-spring-mastery-01-persistence-context-flush/)
