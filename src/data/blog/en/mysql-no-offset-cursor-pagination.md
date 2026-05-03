---
title: "MySQL No-Offset Cursor Pagination — At 10M rows, OFFSET 1M takes 171ms / Cursor 0.30ms, and the 500x trap between them, traced down to a single line"
description: "On a 10M-row table, OFFSET 1M takes 171ms while a No-Offset cursor takes 0.30ms — about 570x faster, reproduced by direct measurement. But how you write the No-Offset code splits another 500x. The ANSI SQL row constructor `(a,b)<(?,?)` is logically equivalent to the OR-split form, yet the MySQL optimizer cannot push it down to an index range (154ms — about the same as OFFSET). The single line in EXPLAIN ANALYZE — Filter: vs Covering index range scan over — is the root cause. A production retrospective combined with a reproducible learning environment."
author: 김면수
pubDatetime: 2026-05-03T13:00:00Z
featured: true
draft: false
tags:
  - MySQL
  - Pagination
  - Performance
  - SQL-Optimization
  - Cursor
  - Index
  - EXPLAIN
  - Backend
  - Database
---

## Table of contents

## Intro {#intro}

The merchant dashboard had an **order list** screen. `LIMIT 20 OFFSET ?` — the most common shape. Pages 1, 10, 100 were all fast.

Then one day a merchant jumped to page 50,000 to look up **transactions from a few months ago**. That single click crashed the P99. Same endpoint, same index, same SQL — but a single OFFSET value was creating hundreds of milliseconds of latency.

In your head, you know the answer — "OFFSET breaks at deep pages, switch to cursor pagination." But a harder question follows: **"how do you write that cursor pagination?"**

The ANSI SQL standard gives us a **row constructor**: `WHERE (created_at, id) < (?, ?)`. The semantics are clear, one line is enough. If you write it that way — **before you measure** — you trust that the index will work.

Then you measure. It comes back at 154ms, almost identical to OFFSET. The **logically equivalent** OR-split form clocks in at 0.30ms. **The same SQL intent runs 500x apart.**

This post traces that one-line difference all the way down through EXPLAIN ANALYZE output.

1. **The intrinsic cost of OFFSET**: confirming the **linear growth** with four measurements at positions 1K → 5M
2. **Three forms of No-Offset**: row constructor / simple cursor / OR-split — at the same 1M position, 154ms / 0.27ms / 0.30ms
3. **Why the 500x split**: the MySQL optimizer's structural limitation in not being able to **push down a row constructor to an index range**
4. **Production application**: cursor tokenization (base64 + HMAC), six mandatory rules, PR-blocking policy

The conclusion up front:

- **OFFSET 1M = 171ms / No-Offset = 0.30ms — about 570x difference** (10M rows, [measured — Java/Spring])
- **And if your No-Offset code uses a row constructor, it's 154ms** — almost the same as OFFSET. **Same semantics, but the optimizer can't recognize it**
- The crux is one line in EXPLAIN ANALYZE: `Filter:` (1M scan) vs `Covering index range scan over` (20 rows). **The rows=20 vs rows=1M difference is the root cause**
- For production, encode the cursor as a base64 + HMAC token. Block the row-constructor form at PR review

Let's break down — line by line — why "use a cursor and you're done" is only half the answer.

---

## 1. Context — why deep pages actually become a real production problem {#context}

### 1.1 Domain

The service is the backend of a multi-platform commerce SaaS. Orders flow in from external commerce platforms (B-corp, C-corp, Y-corp, D-corp) and sync into our DB, where they're displayed on the **merchant dashboard** in reverse chronological order.

What the merchant sees is simple:

```
[Order list] as of 2026-05-03
─────────────────────────────────
Order #20251003-A1B2  | 12:34 | $32.00 | CONFIRMED
Order #20251003-C3D4  | 12:33 | $18.50 | CONFIRMED
... (20 items)
─────────────────────────────────
< 1 2 3 ... 49,998 49,999 50,000 >
```

In daily use they only browse pages 1–10. But when something like a **refund dispute** or **tax filing** happens, the merchant jumps to **deep pages** — page 50,000.

The common SQL is:

```sql
SELECT id, created_at, amount, state
FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET ?;
```

For OFFSET 0–200, no problem. The moment OFFSET crosses 1,000,000 — the code is unchanged but the system breaks.

### 1.2 Hypotheses

- (H1) Latency grows **linearly** with OFFSET. The **number of rows read and discarded** is the cost
- (H2) No-Offset (composite-key cursor) responds in **single-digit ms** regardless of OFFSET position
- (H3) There may be a difference between the row constructor `(created_at, id) < (?, ?)` and the split-OR form — the MySQL optimizer might handle them differently

### 1.3 Measurement environment

| Item | Value |
|---|---|
| OS / host | macOS 14.x, MacBook Pro M2 16GB |
| DB | MySQL 8.0.44 (Docker, host 3307) |
| Table | `orders_w2`, 10M rows (intentional learning environment) |
| Index | `idx_created_at_id (created_at, id)` — covering |
| Tool | `docker exec mysql + EXPLAIN ANALYZE` (real execution) |
| Method | Each query run once, `actual time` from EXPLAIN ANALYZE |

InnoDB buffer pool warmed up before measuring — cold-cache effects are a separate variable.

---

## 2. The intrinsic cost of OFFSET — **the rows you read and discard** are the cost {#offset-cost}

First, let's measure **how badly** OFFSET breaks.

### 2.1 Latency by OFFSET position

The same SQL, varying only the OFFSET, measured at four positions:

```sql
EXPLAIN ANALYZE
SELECT id, created_at FROM orders_w2
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET ?;
```

| OFFSET | actual time | rows scanned (covering index) |
|---|---|---|
| 1,000 | **0.443 ms** | 1,020 |
| 100,000 | **23.4 ms** | 100,020 |
| **1,000,000** | **171 ms** | **1,000,020** |
| **5,000,000** | **765 ms** | 5,000,020 |

→ **Linear growth**. Going from OFFSET 1,000 → 1,000,000 (1,000x) raises latency 0.443 → 171ms (about 386x). Slightly sublinear — explained by InnoDB buffer pool cache effects.

(H1) verified: ✅ Roughly linear. 1M / 1K = 1,000x vs 386x latency — InnoDB reverse-scans **contiguous pages**, partial cache hits make it sublinear.

### 2.2 The meaning of OFFSET in one line of EXPLAIN ANALYZE

The key line for OFFSET 1,000,000:

```
-> Limit/Offset: 20/1000000 row(s)
   -> Covering index scan on orders_w2 using idx_created_at_id (reverse)
      (cost=... rows=1000020) (actual time=... rows=1000020 loops=1)
```

The line that matters is **`actual ... rows=1000020`**. InnoDB reverse-scans the covering index, reads **all** 1,000,020 rows, **throws away** the first 1,000,000, and returns only the last 20 to the client.

→ **The real cost of OFFSET = the number of rows read and discarded**. Even with an index, even covering — **you cannot skip ahead**. The InnoDB index structure has no mechanism to **jump directly** to the Nth row — you have to read N rows **sequentially**.

That's the intrinsic cost of OFFSET pagination. Simple-looking SQL, **cost exactly proportional to OFFSET**.

<details>
<summary><b>Why OFFSET can't skip ahead — InnoDB index structure</b> (expand)</summary>

InnoDB uses B+-tree indexes. Leaf nodes hold **all rows** in **sorted order**.

For "jump to the Nth row" to work, the index would need **ordinal-position** metadata — e.g., "row #20,000 lives at slot Y of page X."

InnoDB does not store this metadata. The index only maps `(key value) → row`, not `(ordinal position) → row`.

So `OFFSET 1000000` leaves the optimizer no choice but **"read sequentially from the first index row through the 1,000,000th, then return the next 20."**

PostgreSQL is the same (B+-tree). So is Oracle. So is SQL Server. It's a limitation deeply baked into **the standard index structure of all major RDBMS**.

→ Which is why cursor pagination is recommended uniformly across all major RDBMS.

</details>

---

## 3. No-Offset composite-key cursor — three SQL forms for the same 1M position {#cursor-three-forms}

OFFSET breaks, so cursor pagination is the answer — that part is well-known. But **how to write the cursor pagination** is where the real story lies.

We measured three No-Offset queries that read the same **1,000,000th page**. The cursor value is unified: the `(created_at, id)` of the last row at the OFFSET 1M position.

### 3.1 (a) Row constructor — the ANSI SQL standard form

```sql
EXPLAIN ANALYZE
SELECT id, created_at FROM orders_w2
WHERE (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

The ANSI SQL **row constructor** (tuple comparison) form. The semantics are clear — "rows where (created_at, id) is less than some tuple."

| Metric | Value |
|---|---|
| actual time | **154 ms** ⚠️ |
| Meaning | About the same as OFFSET |

Key EXPLAIN ANALYZE line:

```
-> Filter: ((orders_w2.created_at, orders_w2.id) < ('2024-...', 12345))
   -> Covering index scan on orders_w2 using idx_created_at_id (reverse)
      (cost=... rows=1e+6) (actual time=... rows=1e+6 loops=1)
```

→ **The row-constructor comparison is applied at the `Filter:` step**. Decisive evidence that the optimizer **did not push the comparison down to an index range**. It reverse-scans 1,000,000 rows and applies the **Filter step** on top — stops once 20 rows match.

The result: latency basically the same as OFFSET 1M (171ms). A case where you **wrote cursor pagination but got no index benefit**.

### 3.2 (b) Simple cursor — `created_at < ?` only

```sql
EXPLAIN ANALYZE
SELECT id, created_at FROM orders_w2
WHERE created_at < ?
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

The simplest form. Define the cursor with **only created_at**, drop id from the cursor.

| Metric | Value |
|---|---|
| actual time | **0.27 ms** ✅ |
| vs OFFSET | **about 633x** ↑ |

Key EXPLAIN ANALYZE line:

```
-> Limit: 20 row(s)
   -> Covering index range scan on orders_w2 using idx_created_at_id
      over (created_at < '2024-...') (reverse)
      (cost=... rows=20) (actual time=... rows=20 loops=1)
```

→ **`Covering index range scan over`**. The optimizer correctly translates `created_at < ?` into an **index range**. **rows=20** — exactly 20 rows read on the index. **Instead of reading 1M rows and discarding them like OFFSET**, it **jumps directly** to the cursor position on the index and reads 20 rows from there.

This is what cursor pagination really looks like — **independent of OFFSET position**. Whether the cursor is at the 1Mth or 5Mth row, latency stays at 0.3ms.

### 3.3 (c) OR-split — `created_at < ? OR (created_at = ? AND id < ?)`

```sql
EXPLAIN ANALYZE
SELECT id, created_at FROM orders_w2
WHERE created_at < ?
   OR (created_at = ? AND id < ?)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

**Logically identical** to (a) row constructor, but split into an OR. The cursor stays a **composite key** (created_at + id) for accuracy, but written in a shape the MySQL optimizer can read.

| Metric | Value |
|---|---|
| actual time | **0.30 ms** ✅ |
| vs OFFSET | **about 570x** ↑ |
| vs (a) | **about 513x** ↑ |

Key EXPLAIN ANALYZE line:

```
-> Limit: 20 row(s)
   -> Covering index range scan on orders_w2 using idx_created_at_id
      over (created_at < '2024-...') OR (created_at = '2024-...' AND id < 12345)
      (reverse) (cost=... rows=20) (actual time=... rows=20 loops=1)
```

→ **`Covering index range scan over (... OR ...)`**. The optimizer recognizes both branches of the OR as **index ranges** and processes them as a union. **rows=20**.

This is the precise cursor-pagination form for production. Latency essentially the same as (b) simple cursor, but **correct** even when many rows share the same created_at.

### 3.4 OFFSET vs three No-Offset forms — one table

| Form | actual time | rows scanned | Difference |
|---|---|---|---|
| OFFSET 1,000,000 | 171 ms | 1,000,020 | (baseline) |
| **(a) row constructor** | **154 ms** ⚠️ | **1,000,000** | **about the same as OFFSET** |
| **(b) simple cursor** | **0.27 ms** | 20 | **about 633x** ↑ |
| **(c) OR-split** ⭐ | **0.30 ms** | 20 | **about 570x** ↑ |

(H2) verified: ✅ No-Offset (b)/(c) is independent of OFFSET position (cursor at 1M or 5M, latency stays ~0.3ms).

(H3) verified: ✅ The difference between row constructor and OR-split is unmistakable — same semantics, different optimizer treatment.

→ The decisive finding is the **(a) vs (c)** comparison. **Same-meaning** SQL runs **513x apart**. The next section explains why.

---

## 4. Why the row constructor cannot be pushed down — a structural MySQL optimizer limitation {#row-constructor-pushdown-failure}

### 4.1 EXPLAIN ANALYZE: **Filter:** vs **range scan over** — the one line that matters

Lining up the key EXPLAIN ANALYZE lines for all three forms:

| Form | Key line | Meaning |
|---|---|---|
| (a) row constructor | `Filter: ((created_at, id) < ...) ... Covering index scan reverse, rows=1e+6` | **Full index scan** + Filter step |
| (b) simple cursor | `Covering index range scan over (created_at < ...) reverse, rows=20` | **Index range scan** (jumps to cursor position) |
| (c) OR-split | `Covering index range scan over (created_at < ...) OR (= AND <), rows=20` | Both OR branches as index ranges |

→ **The single-line difference between `Filter:` and `range scan over` is the source of the 500x latency gap**.

`Filter:` means the optimizer **cannot use the condition during index traversal**. It **fully scans** the index, **evaluates the condition** on top, and picks rows that match. With a covering index there's no disk I/O, but **processing every row in memory** still costs the same.

`range scan over` means the optimizer **uses the condition to determine the index's start/end positions exactly**. It **jumps directly** to the cursor position and reads only 20 rows from there. **The rows=20 vs rows=1e+6 difference is the source of the 500x latency gap**.

### 4.2 The MySQL optimizer's row-constructor limitation — known behavior

The MySQL optimizer does **not** automatically rewrite `(a, b) < (?, ?)` into the equivalent OR form. Even though the two are **logically equivalent**, the optimizer fails to **recognize that equivalence** and cannot push the comparison down to an index range.

[MySQL Bug #16247](https://bugs.mysql.com/bug.php?id=16247) — "Row comparisons should use range scan" — filed in 2006, **still open** today. Unfixed for 19 years. In other words, **as long as you use MySQL**, the row constructor form is unsuitable for cursor pagination.

→ A painful lesson: even with the same semantics, you have to write SQL in the shape **the optimizer can read**.

### 4.3 PostgreSQL comparison — the same row constructor **works correctly**

How does the same SQL behave in PostgreSQL? The PostgreSQL optimizer translates row-constructor comparisons into **exact index ranges**.

PostgreSQL's `(created_at, id) < (?, ?)` works as documented in [Multicolumn Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html) — given a composite index, it produces an **exact index range scan**. This is a **documented feature** of the PostgreSQL optimizer.

→ Striking that the same SQL produces **completely different latency** depending on the RDBMS. Even ANSI SQL standard syntax has performance characteristics that hinge on **DB implementation**.

| | MySQL 8.0 | PostgreSQL |
|---|---|---|
| `(a, b) < (?, ?)` | **Filter, 1M scan** ⚠️ | **Index range scan** ✅ |
| `a < ? OR (a = ? AND b < ?)` | Index range scan ✅ | Index range scan ✅ |

→ **The OR-split form is also safer for portability**. It guarantees the same latency on either DB.

### 4.4 In an interview, in one line

> "Even ANSI SQL standard syntax can produce different index behavior depending on the **optimizer implementation**. MySQL's row constructor has a known limitation: **it can't be pushed down to an index range** — Bug #16247 has been open for 19 years. So you have to **write it as a split OR** for the optimizer to recognize it. EXPLAIN ANALYZE shows it directly: `Filter:` (1M scan) vs `Covering index range scan over` (rows=20) — that one line is the source of the 500x latency gap."

<details>
<summary><b>Why can't the optimizer rewrite a row constructor into the OR form?</b> (expand)</summary>

In theory, the optimizer could **automatically rewrite** `(a, b) < (?, ?)` into `a < ? OR (a = ? AND b < ?)`. MySQL does not. Why?

Optimizer **transformation rules** — **when to apply which rewrite** — are encoded in the source. Adding a rule means re-validating **the safety and cost of the transformation** across every case. If the rewrite isn't **always a win**, the rule doesn't get added.

Rewriting a row constructor into OR form: a win when an index exists, neutral when it doesn't. So from the optimizer's perspective it's a **not-always-a-win** transformation, with low priority. That's why Bug #16247 stays open for 19 years.

PostgreSQL implements this rewrite **explicitly** — applied only when a composite index exists. The difference between MySQL's and PostgreSQL's optimizer philosophies surfaces here.

→ A case where the comfortable assumption that **the optimizer is smart** breaks. The optimizer is just **a collection of code-encoded transformation rules**. Which rewrites are in and which are out has to be **verified by measurement**.

</details>

---

## 5. Production application — cursor tokenization + six mandatory rules {#production-cursor-tokenization}

### 5.1 Standard SQL form

```sql
-- First page (no cursor)
SELECT id, created_at, amount, state FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- Next page (cursor: lastCreatedAt, lastId)
SELECT id, created_at, amount, state FROM orders
WHERE created_at < :lastCreatedAt
   OR (created_at = :lastCreatedAt AND id < :lastId)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

### 5.2 Cursor tokenization — base64 + HMAC

When exposing the cursor to clients, **don't expose internal column names or raw timestamps**. Encode with base64 and sign with HMAC to prevent tampering.

```java
public class CursorToken {
    private static final String SECRET = System.getenv("CURSOR_SIGNING_KEY");

    public static String encode(Instant createdAt, long id) {
        String payload = createdAt.toEpochMilli() + ":" + id;
        String signature = hmacSha256(payload, SECRET);
        return Base64.getUrlEncoder().withoutPadding()
            .encodeToString((payload + ":" + signature).getBytes(UTF_8));
    }

    public static Cursor decode(String token) {
        String decoded = new String(Base64.getUrlDecoder().decode(token), UTF_8);
        String[] parts = decoded.split(":");
        if (parts.length != 3) throw new IllegalArgumentException("invalid cursor");
        String payload = parts[0] + ":" + parts[1];
        if (!hmacSha256(payload, SECRET).equals(parts[2])) {
            throw new SecurityException("cursor signature mismatch");
        }
        return new Cursor(Instant.ofEpochMilli(Long.parseLong(parts[0])),
                          Long.parseLong(parts[1]));
    }
}
```

Response shape:

```json
{
  "items": [...20 items...],
  "next_cursor": "MTcwOTM4NDAwMDAwMDoxMjM0NTo3OWE0Yjg..."
}
```

→ Clients treat the token as an **opaque string**. Internal column changes have no client impact (e.g., adding **uuid instead of id** to the cursor definition requires no client code changes).

### 5.3 Six mandatory rules

For cursor pagination to **actually** work in production, all of these have to be enforced.

| # | Rule | How to verify |
|---|---|---|
| 1 | **Index required**: `idx_(created_at, id)` or a domain-specific composite index | Verify `Covering index range scan over` in EXPLAIN ANALYZE |
| 2 | **Cursor tokenization**: base64 + HMAC | Response must not expose raw timestamp/id |
| 3 | **First/next page split**: cursor empty → LIMIT only; cursor present → OR-split WHERE | Code review |
| 4 | **Include next_cursor in the response**: encode the last row's (created_at, id) as a token | API spec |
| 5 | **Ban row constructors**: block `(a, b) <` / `(a, b) >` patterns at PR review | Code search + lint |
| 6 | **OFFSET allowed only for N ≤ 1,000**: small OFFSET is fast (0.443ms) | Code review |

### 5.4 PR-blocking policy — automatic detection of row constructors

Add a lint rule to GitHub Actions — block the PR if a `WHERE` clause matches a row-constructor pattern like `(.*) < (.*)`.

```bash
# lint script (CI)
if grep -rE 'WHERE\s+\([a-zA-Z_,\s]+\)\s*[<>]' src/main/resources/db/; then
  echo "ERROR: row constructor detected in SQL. Use OR-split form."
  exit 1
fi
```

The **real production value** is that this blocks at the PR stage. Once a row constructor reaches production, it cascades: P99 spike → alert → rollback → migration — high cost. A single lint line at PR review costs 1/100.

### 5.5 Conditions under which this decision is wrong

- The OR-split form measures in **hundreds of ms** in production → revisit the index (composite index missing / low cardinality)
- A domain with **extremely many rows sharing the same created_at** → consider adding a column to the cursor definition (e.g., shop_id, batch_id)
- DB switches to PostgreSQL — PostgreSQL pushes down row constructors correctly → row constructor form becomes simpler

---

## 6. Big-tech precedents — why cursor pagination is the standard {#bigtech-references}

### 6.1 Stripe — the prototype of cursor as standard

[Stripe API — Pagination](https://stripe.com/docs/api/pagination) makes **every** list endpoint cursor-based:

```http
GET /v1/charges?limit=20&starting_after=ch_3MtwBwLkdIwHu7ix28a3tqPa
```

`starting_after` / `ending_before` parameters — Stripe standard. **Same latency even on deep pages** is guaranteed.

### 6.2 Notion — cursor standard plus an explicit has_more

[Notion API — Pagination](https://developers.notion.com/reference/intro#pagination):

```json
{
  "has_more": true,
  "next_cursor": "ZZZZZZ-block-id",
  "results": [...]
}
```

The `has_more` flag explicitly marks the last page. The cursor is an **opaque token** — no internal structure exposed.

### 6.3 Slack — cursor-based pagination, by name

[Slack API — Cursor-based Pagination](https://api.slack.com/docs/pagination):

> "Cursor-based pagination is the most reliable type for traversing large lists. Cursor-based pagination works by returning a pointer to a specific item in the dataset."

`response_metadata.next_cursor` is the standard. Slack also makes **every list endpoint** cursor-based.

### 6.4 Use The Index, Luke! — "No Offset" as standard

[Use The Index, Luke! — No Offset](https://use-the-index-luke.com/no-offset) names OFFSET an **anti-pattern** explicitly:

> "OFFSET is bad for both performance and correctness. The seek method (also known as keyset pagination) is the alternative."

This site is essentially the **bible** of RDBMS index learning. Cursor pagination = "seek method" = "keyset pagination" — different names for the same pattern.

### 6.5 Vlad Mihalcea — the OR-split form as the standard pattern

[Vlad Mihalcea — Keyset Pagination](https://vladmihalcea.com/sql-seek-keyset-pagination/) presents the (c) OR-split form from this post as the standard pattern:

```sql
WHERE (created_at < ? OR (created_at = ? AND id < ?))
ORDER BY created_at DESC, id DESC
LIMIT 20
```

Detailed implementation guidance for Hibernate / JPA contexts. The most cited source for **Java/Spring backends**.

### 6.6 In one line

> Global API standards (Stripe / Notion / Slack), the index-learning standard (Use The Index, Luke!), the Java/Spring standard (Vlad Mihalcea) — all **cursor pagination**. OFFSET is acceptable only for **small N** or **internal admin**.

---

## 7. Production failure scenarios (the 3 AM playbook) {#failure-scenarios}

### 7.1 Scenario 1 — operator enters via **deep-page OFFSET**

A merchant jumps to page 50,000 from dashboard search. The OFFSET 1,000,000 query runs as-is.

| Stage | Signal |
|---|---|
| **First alert** | P99 spike on a specific endpoint (hundreds of ms to seconds) |
| **First 5 minutes** | 1) SLOW LOG → identify large-OFFSET queries<br/>2) Search dashboard code → find OFFSET pagination remnants<br/>3) Open a cursor-pagination migration PR |
| **User impact** | Deep-page users see hundreds of ms to seconds response time |

→ Temporary mitigation: disable **deep-page jumping** in the dashboard (only next/prev buttons). Permanent fix: cursor migration.

### 7.2 Scenario 2 — simple cursor drops rows when many rows share the same created_at

Right after a bulk INSERT batch (e.g., external-platform sync) — 100+ rows end up with the same `created_at` (millisecond precision). With (b) simple cursor `WHERE created_at < ?`, after reading 20 of those 100 rows, the next page uses `created_at < (that ms)` — and **the remaining 80 rows are skipped**.

| Stage | Signal |
|---|---|
| **First alert** | User report: "missing rows in the order list" |
| **First 5 minutes** | 1) `SELECT created_at, COUNT(*) FROM orders GROUP BY created_at HAVING COUNT(*) > 1` to confirm same-instant rows<br/>2) Switch cursor form (b) → (c) OR-split |
| **User impact** | Pagination **correctness** breaks (operational trust damaged) |

→ The simple cursor has **the same performance** but breaks correctness. That's why the OR-split form is the operational standard.

### 7.3 Scenario 3 — someone writes a row constructor in a PR

```sql
WHERE (created_at, id) < (:lastCreatedAt, :lastId)
```

The PR author writes it thinking **this is the ANSI SQL standard, so it's correct**. The semantics are exact.

| Stage | Signal |
|---|---|
| **First alert** | (Before any production impact) at code review |
| **First 5 minutes** | 1) Lint blocks automatically (§5.4)<br/>2) If lint misses, reviewer cites §4 rule and blocks |
| **User impact** | 0 (blocked pre-emptively) |

→ Not post-hoc monitoring but **PR-time blocking** is the key. Once a row constructor reaches production, it's **invisible without EXPLAIN ANALYZE** (because the semantics are equivalent).

---

## 8. What we learned {#key-takeaways}

### 8.1 Assumptions broken by measurement

- "OFFSET is slow on deep pages, but vague about **how slow**" → **linear growth, 1M = 171ms (measured)**
- "Cursor pagination and you're done" → **half-answer** (the SQL form decides 500x)
- "ANSI SQL standard form is the safest" → **unsuitable in MySQL due to optimizer limitation**
- "The optimizer is smart enough to auto-rewrite to OR" → **MySQL hasn't done it for 19 years (Bug #16247)**

### 8.2 How measurement seeds **follow-up learning**

| Measurement | Follow-up decision |
|---|---|
| OFFSET 5M = 765ms | Disable deep-page jump UI (only next/prev) |
| (a) row constructor = 154ms | Add PR lint rule (block row constructors) |
| (b) simple cursor = 0.27ms | Identify domains where (b) is safe (after auditing same-instant rows) |
| (c) OR-split = 0.30ms | Operational standard — Vlad Mihalcea pattern |
| MySQL Bug #16247 | Revisit cursor form on DB migration (e.g., PostgreSQL) |

### 8.3 The single line

> **OFFSET's cost is the *number of rows read and discarded***. At 10M rows: OFFSET 1M = 171ms / cursor = 0.30ms — **about 570x**. But **how you write the cursor code** is the real point — the row-constructor form can't be pushed down by MySQL's optimizer, so it's 154ms (about the same as OFFSET). The single-line difference between `Filter:` and `Covering index range scan over` in EXPLAIN ANALYZE is the source of the 500x latency gap.

---

## 9. Recap — putting this article in your own words {#recap}

If someone who just finished this article asked, "so what was that all about?" — here's how the measurements answer the natural follow-up questions.

### Q. "Why does OFFSET pagination break down at 10M rows?"

OFFSET cost scales **exactly with the number of rows read and discarded** — [measured] OFFSET 1M = 171ms (rows scanned 1,000,020), OFFSET 5M = 765ms. Having an index doesn't help, even a covering one. **InnoDB's B+-tree index doesn't store *ordinal-position* metadata**, so there's no way to jump straight to the Nth row — you have to read rows 1 through N sequentially and throw away the unwanted ones. PostgreSQL, Oracle, SQL Server all share this limitation — it's intrinsic to the standard RDBMS index structure. That's why cursor pagination is *the standard answer across all major databases*.

### Q. "Row constructor `(a,b) < (?,?)` and the OR-split form mean the same thing — why a 500x gap?"

Mathematically they're a lexicographic comparison and return the same set of rows. The catch is that **MySQL's optimizer has a structural limit: it can't push a row constructor down to an *index range scan*** — Bug #16247 has been open for 19 years. EXPLAIN ANALYZE shows it on a single line: the row constructor lands as `Filter:` and scans 1,000,000 rows (154ms), while the OR-split runs as `Covering index range scan over` and scans only rows=20 (0.30ms). PostgreSQL pushes the *same SQL* down correctly — the real lesson is that **how each DB's optimizer interprets the ANSI SQL standard is what actually decides the cost**.

### Q. "Simple cursor `created_at < ?` vs OR-split — which is the production default?"

Performance is essentially identical — 0.27 vs 0.30ms. The difference is *operational safety*: when many rows share the same `created_at` (bulk INSERT batches, migrations), the simple cursor *drops rows*. If 100 rows are inserted at the same millisecond and you cursor on that ms, the next page skips part of them. **The OR-split compares (created_at, id) together to guarantee a *correct page boundary***. Unless your domain *proves* that same-instant duplicates are rare, the production default is OR-split.

### Q. "So you never use OFFSET pagination?"

The [measured] take: **small OFFSETs (≤ 1,000) are fine** — 0.443ms is plenty fast. Internal admin tools, sample first pages — places with *bounded usage* — are easier to read with OFFSET than a cursor. But never for deep pages on user-facing surfaces — OFFSET 5M = 765ms. The rule this article lands on: an ADR-level cap of **"OFFSET only when N ≤ 1,000"**, enforced at PR review.

---

## 10. In the next post {#next-post}

This measurement only looked at single-query latency from EXPLAIN ANALYZE. In production you also need to look along these axes:

- **Concurrency** — what if INSERTs arrive during cursor pagination? DELETEs? How does Repeatable Read guarantee correctness?
- **Index cardinality** — when created_at has low cardinality (e.g., daily aggregates), how do you shape the cursor?
- **Infinite scroll vs page-jump UI** — UX vs SQL trade-offs

Next post:

- How **phantom rows** are handled with cursor pagination + INSERT under Repeatable Read
- When to introduce the **third column** to a composite cursor (shop_id, batch_id, etc.)
- ElasticSearch / OpenSearch search_after vs RDBMS cursor — same pattern, different implementations

---

## References {#references}

- [Stripe API — Pagination](https://stripe.com/docs/api/pagination) — the prototype of cursor as standard
- [Notion API — Pagination](https://developers.notion.com/reference/intro#pagination) — opaque cursor + has_more
- [Slack API — Cursor-based Pagination](https://api.slack.com/docs/pagination) — "most reliable type for traversing large lists"
- [Use The Index, Luke! — No Offset](https://use-the-index-luke.com/no-offset) — OFFSET = anti-pattern
- [Vlad Mihalcea — Keyset Pagination](https://vladmihalcea.com/sql-seek-keyset-pagination/) — OR-split form as the standard pattern (Java/Spring)
- [MySQL Bug #16247 — Row comparisons should use range scan](https://bugs.mysql.com/bug.php?id=16247) — known limitation, open for 19 years
- [PostgreSQL — Multicolumn Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html) — row constructor works correctly
- [MySQL Reference — EXPLAIN ANALYZE](https://dev.mysql.com/doc/refman/8.0/en/explain.html#explain-analyze) — interpreting `actual time` / `rows`
- This measurement — raw data is kept in a separate learning note (inside the portfolio repo)
