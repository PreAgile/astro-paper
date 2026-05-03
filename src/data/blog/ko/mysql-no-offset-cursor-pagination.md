---
title: "MySQL No-Offset Cursor 페이지네이션 — 1,000만 row에서 OFFSET 1M이 171ms / Cursor 0.30ms, 그 사이의 500배 함정 한 줄까지 측정으로 풀어봤습니다"
description: "1,000만 row 환경에서 OFFSET 1M이 171ms / No-Offset Cursor가 0.30ms — 약 570배 차이를 측정으로 재현했습니다. 그런데 No-Offset 코드를 어떻게 쓰느냐에 따라 또 한 번 500배가 갈라집니다. ANSI SQL 표준의 row constructor `(a,b)<(?,?)` 는 의미상 OR 분리 형태와 같지만 MySQL 옵티마이저가 index range로 push down 못 합니다 (154ms — OFFSET과 거의 동일). EXPLAIN ANALYZE 의 Filter: vs Covering index range scan over 한 줄 차이가 본질입니다 — 프로덕션 회고와 학습 환경 재현을 같이 풀어봤습니다."
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

## 들어가며 {#intro}

사장님 대시보드에 **주문 목록** 화면이 있었습니다. `LIMIT 20 OFFSET ?` — 가장 흔한 모양. 1페이지, 10페이지, 100페이지까진 빨랐습니다.

그런데 어느 날 사장님 한 분이 **몇 달 전 거래 내역**을 찾으러 50,000 페이지로 이동했습니다 — 그 한 번의 클릭에 P99가 무너졌습니다. 같은 endpoint, 같은 인덱스, 같은 SQL인데 OFFSET 값 하나가 백 ms 단위 latency 차이를 만듭니다.

머릿속으로는 답을 압니다 — "OFFSET은 깊은 페이지에서 무너진다, cursor 페이지네이션을 써야 한다." 그런데 더 어려운 질문이 따라옵니다. **"cursor 페이지네이션을 어떻게 쓰는가?"**

ANSI SQL 표준은 **row constructor** `WHERE (created_at, id) < (?, ?)` 를 가지고 있습니다. 의미가 명확하고, 한 줄로 충분합니다. 이 형태로 짜면 — **돌려보기 전엔** — 인덱스가 잘 먹을 거라고 믿습니다.

그런데 측정해 보면 OFFSET과 거의 같은 154ms가 나옵니다. **의미가 같은** OR 분리 형태는 0.30ms. **같은 SQL 의도가 500배 차이**가 납니다.

이 글은 그 한 줄 차이를 EXPLAIN ANALYZE 출력으로 끝까지 풀어본 기록입니다.

1. **OFFSET의 본질적 비용**: 1K → 5M 위치까지 4개 측정점으로 **선형 증가**를 직접 확인
2. **No-Offset 3가지 형태**: row constructor / 단순 cursor / OR 분리 — 같은 1M 위치에서 latency 154ms / 0.27ms / 0.30ms
3. **왜 500배 갈라지는가**: MySQL 옵티마이저가 row constructor를 **index range로 push down 못 하는** 구조적 한계
4. **운영 적용**: cursor 토큰화 (base64 + HMAC), 강제 룰 6가지, PR 차단 정책

결론부터 말하면:

- **OFFSET 1M = 171ms / No-Offset = 0.30ms — 약 570배 차이** (1,000만 row, [실측 — Java/Spring])
- **그런데 No-Offset 코드가 row constructor면 154ms** — OFFSET과 거의 같음. **의미는 같은데 옵티마이저가 못 알아본다**
- 핵심은 EXPLAIN ANALYZE의 한 줄 — `Filter:` (1M scan) vs `Covering index range scan over` (20 rows). **rows=20 vs rows=1M의 차이가 본질**
- 운영 적용 시 cursor는 base64 + HMAC 토큰으로 인코딩. row constructor 형태는 PR 단계에서 차단

머릿속의 "cursor 쓰면 끝이지"가 왜 **반쪽 답**인지 라인 단위로 나눠봅니다.

---

## 1. Context — 왜 깊은 페이지가 운영에서 진짜 문제가 되나 {#context}

### 1.1 도메인

서비스는 멀티 플랫폼 커머스 SaaS의 백엔드입니다. B사·C사·Y사·D사 같은 외부 커머스 플랫폼에서 주문이 자기 DB로 동기화돼서, **사장님 대시보드**에 시간 역순으로 표시됩니다.

사장님이 보는 화면은 단순합니다.

```
[주문 목록] 2026-05-03 기준
─────────────────────────────────
주문 #20251003-A1B2  | 12:34 | 32,000원 | CONFIRMED
주문 #20251003-C3D4  | 12:33 | 18,500원 | CONFIRMED
... (20건)
─────────────────────────────────
< 1 2 3 ... 49,998 49,999 50,000 >
```

평소엔 1~10페이지만 봅니다. 그런데 **환불 분쟁**이나 **세무 신고** 같은 이벤트가 생기면 사장님이 **깊은 페이지**로 점프합니다 — 페이지 50,000번까지.

흔한 SQL은 다음입니다.

```sql
SELECT id, created_at, amount, state
FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET ?;
```

평소 OFFSET이 0~200 정도라면 문제없습니다. 그런데 OFFSET이 1,000,000을 넘는 순간 — 코드는 그대로인데 시스템이 무너집니다.

### 1.2 가설

- (H1) OFFSET이 커질수록 latency가 **선형**으로 증가한다. **읽고 버리는 row 수**가 OFFSET만큼 비용
- (H2) No-Offset (Cursor 복합키) 은 OFFSET 위치와 무관하게 **수 ms 이내** 응답
- (H3) row constructor `(created_at, id) < (?, ?)` 와 분리된 OR 형태의 차이 가능성 — MySQL 옵티마이저가 둘을 다르게 다룰 수 있다

### 1.3 측정 환경

| 항목 | 값 |
|---|---|
| OS / 호스트 | macOS 14.x, MacBook Pro M2 16GB |
| DB | MySQL 8.0.44 (Docker, host 3307) |
| 테이블 | `orders_w2` 1,000만 row (의도된 학습 환경) |
| 인덱스 | `idx_created_at_id (created_at, id)` — covering |
| 도구 | `docker exec mysql + EXPLAIN ANALYZE` (실 실행) |
| 측정 방법 | 각 쿼리 1회, EXPLAIN ANALYZE의 `actual time` 채택 |

InnoDB buffer pool은 워밍업 후 측정 — 콜드 캐시 효과는 별도 변수.

---

## 2. OFFSET의 본질적 비용 — **읽고 버리는 row 수** 가 비용 {#offset-cost}

먼저 OFFSET이 **얼마나** 무너지는지부터 측정으로 확인합니다.

### 2.1 OFFSET 위치별 latency

같은 SQL을 OFFSET만 바꿔서 4개 위치에서 측정했습니다.

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

→ **선형 증가**. OFFSET이 1,000 → 1,000,000 (1,000배)이 되면 latency도 0.443 → 171ms (약 386배). 약간 sublinear인데 이건 InnoDB buffer pool 캐시 효과로 해석됩니다.

(H1) 검증: ✅ 거의 선형. 1M / 1K = 1,000배 vs latency 386배 — InnoDB가 **연속된 페이지**를 reverse scan하면서 캐시 hit율이 일부 buffer 효과를 줘서 sublinear.

### 2.2 EXPLAIN ANALYZE 한 줄로 보는 OFFSET의 의미

OFFSET 1,000,000의 EXPLAIN ANALYZE 핵심:

```
-> Limit/Offset: 20/1000000 row(s)
   -> Covering index scan on orders_w2 using idx_created_at_id (reverse)
      (cost=... rows=1000020) (actual time=... rows=1000020 loops=1)
```

읽어야 할 한 줄은 **`actual ... rows=1000020`**. InnoDB는 covering index를 reverse scan하면서 1,000,020개 row를 **모두** 읽고 — 처음 1,000,000개를 **그냥 버립니다** — 마지막 20개만 클라이언트로 보냅니다.

→ **OFFSET의 진짜 비용 = 읽고 버리는 row 수**. 인덱스가 있어도, covering이어도, **건너뛸 수가 없다**. InnoDB의 인덱스 구조상 N번째 row로 **직접 점프**하는 메커니즘이 없어서 — N개를 **순차적으로** 읽어야 합니다.

이게 OFFSET 페이지네이션의 본질적 비용입니다. SQL이 단순해 보이는 만큼, **비용이 OFFSET 값에 정확히 비례**합니다.

<details>
<summary><b>OFFSET이 왜 건너뛸 수 없는가 — InnoDB 인덱스 구조</b> (펼치기)</summary>

InnoDB는 B+-tree 인덱스를 씁니다. 리프 노드에 **모든 row**가 **정렬된 순서**로 있는 구조입니다.

"N번째 row로 점프"가 가능하려면 — 인덱스가 **서수 위치(ordinal position)** 정보를 가져야 합니다. 예: "20,000번째 row는 페이지 X의 슬롯 Y" 같은 메타데이터.

InnoDB는 이런 메타데이터가 **없습니다**. 인덱스는 `(key 값) → row` 매핑만 있지, `(서수 위치) → row` 매핑이 없습니다.

따라서 `OFFSET 1000000`은 옵티마이저 입장에서 **"인덱스의 첫 row부터 1,000,000번째까지 순차로 읽고, 그 다음 20개를 반환"** 외에 다른 방법이 없습니다.

PostgreSQL도 마찬가지입니다 (B+-tree 인덱스). Oracle도, SQL Server도. **일반적인 B-tree 인덱스 구조**에 깊이 박힌 한계입니다.

→ 그래서 cursor 페이지네이션이 **모든** 주요 RDBMS에서 동일하게 권장됩니다.

</details>

---

## 3. No-Offset Cursor 복합키 — 같은 1M번째 위치를 **3가지 SQL 형태**로 풀어봤습니다 {#cursor-three-forms}

OFFSET이 무너졌으니 cursor 페이지네이션이 답입니다 — 까진 흔한 답. 그런데 **cursor 페이지네이션을 어떻게 쓰는가** 가 진짜 본질입니다.

같은 **1,000,000번째 페이지**를 읽는 No-Offset 쿼리 3가지를 측정했습니다. cursor 값은 OFFSET 1M 위치의 마지막 row의 `(created_at, id)`로 통일.

### 3.1 (a) Row Constructor — ANSI SQL 표준 형태

```sql
EXPLAIN ANALYZE
SELECT id, created_at FROM orders_w2
WHERE (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

ANSI SQL의 **row constructor** (튜플 비교) 형태. 의미가 명확합니다 — "(created_at, id)가 어떤 튜플보다 작은 row".

| 지표 | 값 |
|---|---|
| actual time | **154 ms** ⚠️ |
| 의미 | OFFSET과 거의 같음 |

EXPLAIN ANALYZE 핵심:

```
-> Filter: ((orders_w2.created_at, orders_w2.id) < ('2024-...', 12345))
   -> Covering index scan on orders_w2 using idx_created_at_id (reverse)
      (cost=... rows=1e+6) (actual time=... rows=1e+6 loops=1)
```

→ **`Filter:` 단계로 row constructor 비교가 적용됨**. 옵티마이저가 이 비교를 **index range로 push down 못 했다**는 결정적 증거. 1,000,000 row를 **모두 reverse scan**하고 **Filter 단계에서 매칭되는 row**를 골라서 — 20개 모이면 종료.

결과적으로 OFFSET 1M (171ms)과 거의 같은 latency가 나옵니다. **cursor 페이지네이션이라고 작성했는데 인덱스 효과를 못 받은** 케이스.

### 3.2 (b) 단순 Cursor — `created_at < ?` 만

```sql
EXPLAIN ANALYZE
SELECT id, created_at FROM orders_w2
WHERE created_at < ?
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

가장 단순한 형태. cursor를 **created_at만** 으로 잡고, id는 cursor에서 제외.

| 지표 | 값 |
|---|---|
| actual time | **0.27 ms** ✅ |
| OFFSET 대비 | **약 633배** ↑ |

EXPLAIN ANALYZE 핵심:

```
-> Limit: 20 row(s)
   -> Covering index range scan on orders_w2 using idx_created_at_id
      over (created_at < '2024-...') (reverse)
      (cost=... rows=20) (actual time=... rows=20 loops=1)
```

→ **`Covering index range scan over`**. 옵티마이저가 `created_at < ?` 를 정확히 **index range**로 변환. **rows=20** — 인덱스 위에서 정확히 20 row만 읽음. **OFFSET처럼 1M을 읽고 버리는 게 아니라**, 인덱스에서 cursor 위치를 **바로 점프**해서 거기서부터 20개만 읽음.

이게 cursor 페이지네이션의 진짜 모습 — **OFFSET 위치와 무관**. cursor가 1M번째든 5M번째든 latency 0.3ms.

### 3.3 (c) OR 분리 — `created_at < ? OR (created_at = ? AND id < ?)`

```sql
EXPLAIN ANALYZE
SELECT id, created_at FROM orders_w2
WHERE created_at < ?
   OR (created_at = ? AND id < ?)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

(a) row constructor 와 **의미가 동일**하지만 OR로 분리한 형태. cursor를 **복합키** (created_at + id) 로 정확히 잡되, MySQL 옵티마이저가 알아들을 수 있는 모양으로 풀어 씀.

| 지표 | 값 |
|---|---|
| actual time | **0.30 ms** ✅ |
| OFFSET 대비 | **약 570배** ↑ |
| (a) 대비 | **약 513배** ↑ |

EXPLAIN ANALYZE 핵심:

```
-> Limit: 20 row(s)
   -> Covering index range scan on orders_w2 using idx_created_at_id
      over (created_at < '2024-...') OR (created_at = '2024-...' AND id < 12345)
      (reverse) (cost=... rows=20) (actual time=... rows=20 loops=1)
```

→ **`Covering index range scan over (... OR ...)`**. 옵티마이저가 OR로 분리된 두 조건을 **모두 index range**로 인식하고 union으로 처리. **rows=20**.

이게 운영의 정확한 cursor 페이지네이션 형태입니다. (b) 단순 cursor 와 거의 같은 latency지만, 같은 created_at row가 다수일 때 **정확성**까지 보장.

### 3.4 OFFSET vs No-Offset 3가지 형태 — 한 표로 비교

| 방식 | actual time | rows scanned | 차이 |
|---|---|---|---|
| OFFSET 1,000,000 | 171 ms | 1,000,020 | (baseline) |
| **(a) row constructor** | **154 ms** ⚠️ | **1,000,000** | **OFFSET과 비슷** |
| **(b) 단순 cursor** | **0.27 ms** | 20 | **약 633배** ↑ |
| **(c) OR 분리** ⭐ | **0.30 ms** | 20 | **약 570배** ↑ |

(H2) 검증: ✅ No-Offset (b)/(c)는 OFFSET 위치와 무관 (cursor가 1M번째든 5M번째든 latency ~0.3ms).

(H3) 검증: ✅ row constructor와 OR 분리의 차이가 명확 — 의미는 같은데 옵티마이저가 다르게 다룬다.

→ 결정적 발견은 **(a) vs (c)** 의 비교입니다. **같은 의미**의 SQL이 **513배 차이**. 다음 섹션에서 그 이유를 풀어봅니다.

---

## 4. 왜 row constructor가 push down 못 하는가 — MySQL 옵티마이저의 구조적 한계 {#row-constructor-pushdown-failure}

### 4.1 EXPLAIN ANALYZE의 **Filter:** vs **range scan over** — 한 줄 차이가 본질

세 형태의 EXPLAIN ANALYZE 핵심을 나란히 놓고 보면:

| 형태 | 핵심 한 줄 | 의미 |
|---|---|---|
| (a) row constructor | `Filter: ((created_at, id) < ...) ... Covering index scan reverse, rows=1e+6` | 인덱스 **전체 scan** + Filter 단계 |
| (b) 단순 cursor | `Covering index range scan over (created_at < ...) reverse, rows=20` | 인덱스 **range scan** (cursor 위치 점프) |
| (c) OR 분리 | `Covering index range scan over (created_at < ...) OR (= AND <), rows=20` | OR 둘 다 index range |

→ **`Filter:` 와 `range scan over` 의 한 줄 차이가 latency 500배 차이의 원인**.

`Filter:` 는 옵티마이저가 **조건을 인덱스 탐색에 활용 못 함**을 뜻합니다. 인덱스를 **전부 scan** 하고, 그 위에서 **조건을 평가** 해서 매칭되는 row만 골라내는 방식. covering index라 disk I/O는 없지만 **모든 row를 메모리에서 처리** 하는 비용은 그대로.

`range scan over` 는 옵티마이저가 **조건으로 인덱스의 시작/끝 위치를 정확히 결정** 함을 뜻합니다. cursor 위치로 **바로 점프** 해서 거기서부터 20개만 읽음. **rows=20 vs rows=1e+6 의 차이가 latency 500배의 원인**.

### 4.2 MySQL 옵티마이저의 row constructor 한계 — 알려진 동작

MySQL 옵티마이저는 `(a, b) < (?, ?)` 같은 **row constructor 비교**를 자동으로 **동등한 OR 형태로 변환하지 않습니다**. 둘이 **논리적으로 동등**함에도 불구하고, 옵티마이저가 이 동등성을 **인식하지 못해서** index range로 push down 못 합니다.

[MySQL Bug #16247](https://bugs.mysql.com/bug.php?id=16247) — "Row comparisons should use range scan" — 2006년에 등록되어 **지금도 열려 있는** known limitation. 19년 동안 fix 안 됨. 즉 **MySQL을 쓰는 한** row constructor 형태는 cursor 페이지네이션에 부적합.

→ 의미가 같은 SQL이라도 **옵티마이저가 알아들을 수 있는 형태**로 작성해야 한다는 뼈아픈 교훈.

### 4.3 PostgreSQL 비교 — 같은 row constructor가 **정상 동작**

같은 SQL이 PostgreSQL에선 어떻게 동작하나? PostgreSQL 옵티마이저는 row constructor 비교를 **정확히 index range**로 변환합니다.

PostgreSQL의 `(created_at, id) < (?, ?)`는 [Multicolumn Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html) 문서에 명시된 형태로 동작 — composite index 가 있으면 **정확한 index range scan**. 이건 PostgreSQL 옵티마이저의 **명시된 기능**입니다.

→ 같은 SQL이 RDBMS에 따라 **완전히 다른 latency**가 나올 수 있다는 점이 인상적. ANSI SQL 표준이라도 **DB 구현** 에 따라 성능 특성이 갈립니다.

| | MySQL 8.0 | PostgreSQL |
|---|---|---|
| `(a, b) < (?, ?)` | **Filter, 1M scan** ⚠️ | **Index range scan** ✅ |
| `a < ? OR (a = ? AND b < ?)` | Index range scan ✅ | Index range scan ✅ |

→ **이식성 관점에서도 OR 분리 형태가 안전**. 어느 DB든 같은 latency를 보장.

### 4.4 면접에서 이 한 줄로 답하면

> "같은 ANSI SQL 표준 형태라도 **옵티마이저 구현**에 따라 인덱스 효과가 갈립니다. MySQL의 row constructor는 **index range로 push down 못 하는** 알려진 한계 — Bug #16247은 2006년에 등록된 오래된 known limitation (현재 트래커는 duplicate 처리). 그래서 **분리된 OR 형태로 작성해야** 옵티마이저가 정확히 인식. EXPLAIN ANALYZE의 **Filter:** (1M scan) vs **Covering index range scan over** (rows=20) — 이 한 줄이 latency 500배 차이의 원인."

<details>
<summary><b>왜 옵티마이저가 row constructor를 OR 형태로 변환 못 하는가</b> (펼치기)</summary>

이론적으로는 옵티마이저가 `(a, b) < (?, ?)`를 `a < ? OR (a = ? AND b < ?)`로 **자동 변환**하면 됩니다. 그런데 MySQL은 안 합니다. 왜?

옵티마이저의 **변환 규칙(transformation rules)** 은 **언제 어떤 변환을 적용할 것인가** 가 코드로 박혀 있습니다. 변환 규칙이 추가되면 — 모든 케이스에서 **변환의 안전성과 비용** 을 다시 검증해야 합니다. 변환 자체가 **항상 이득**이라는 보장이 없으면 안 추가합니다.

row constructor의 OR 변환은 — 인덱스가 있으면 이득이지만, **없으면** 같음. 그래서 옵티마이저 입장에선 **항상 이득은 아닌** 변환이라 우선순위가 낮음. Bug #16247이 오래 known limitation으로 남은 이유.

PostgreSQL은 이 변환을 **명시적으로** 구현 — composite index 가 있는 경우만 변환 적용. MySQL과 PostgreSQL의 옵티마이저 철학 차이가 여기서 드러납니다.

→ **옵티마이저는 똑똑하다** 는 일반적 가정이 깨지는 케이스. 옵티마이저는 **코드로 짜인 변환 규칙의 집합** 일 뿐. 어떤 변환이 들어 있고 어떤 게 빠져 있는지를 **측정으로 확인** 해야 합니다.

</details>

---

## 5. 운영 적용 — Cursor 토큰화 + 강제 룰 6가지 {#production-cursor-tokenization}

### 5.1 표준 SQL 형태

```sql
-- 첫 페이지 (cursor 없음)
SELECT id, created_at, amount, state FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- 다음 페이지 (cursor: lastCreatedAt, lastId)
SELECT id, created_at, amount, state FROM orders
WHERE created_at < :lastCreatedAt
   OR (created_at = :lastCreatedAt AND id < :lastId)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

### 5.2 Cursor 토큰화 — base64 + HMAC

cursor를 클라이언트에 노출할 때 **내부 컬럼명 / 타임스탬프 직접 노출** 안 함. base64 인코딩 + HMAC 서명으로 변조 방지.

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

응답 형태:

```json
{
  "items": [...20건...],
  "next_cursor": "MTcwOTM4NDAwMDAwMDoxMjM0NTo3OWE0Yjg..."
}
```

→ 클라이언트는 토큰을 **불투명한 문자열**로 다룸. 내부 컬럼 구조 변경에 영향 없음 (예: cursor 정의에 **id 대신 uuid** 추가해도 클라이언트 코드 무수정).

### 5.3 강제 동반 룰 6가지

운영에서 cursor 페이지네이션이 **진짜로** 동작하려면 다음 룰을 모두 강제해야 합니다.

| # | 룰 | 검증 방법 |
|---|---|---|
| 1 | **인덱스 필수**: `idx_(created_at, id)` 또는 도메인별 복합 인덱스 | EXPLAIN ANALYZE에 `Covering index range scan over` 확인 |
| 2 | **cursor 토큰화**: base64 + HMAC | 응답에 raw timestamp/id 노출 안 됨 |
| 3 | **첫/다음 페이지 분기**: cursor 비어있으면 LIMIT만, 있으면 OR 분리 WHERE | 코드 리뷰 |
| 4 | **응답에 next_cursor 포함**: 마지막 row의 (created_at, id) → 토큰 인코딩 | API 스펙 |
| 5 | **row constructor 금지**: `(a, b) <` / `(a, b) >` 패턴 발견 시 PR 차단 | 코드 검색 + lint |
| 6 | **OFFSET 사용 시 N ≤ 1,000 허용**: 작은 OFFSET은 빠름 (0.443ms) | 코드 리뷰 |

### 5.4 PR 차단 정책 — row constructor 자동 검출

GitHub Actions에 lint 룰 추가 — `WHERE` 절에 `(.*) < (.*)` 같은 row constructor 패턴 발견 시 PR 차단.

```bash
# lint script (CI)
if grep -rE 'WHERE\s+\([a-zA-Z_,\s]+\)\s*[<>]' src/main/resources/db/; then
  echo "ERROR: row constructor detected in SQL. Use OR-split form."
  exit 1
fi
```

운영의 **진짜 가치**는 이 차단이 PR 단계에서 막아준다는 점. 한 번 운영에 풀리면 P99 spike → 알람 → 롤백 → 마이그레이션 — 비용이 큽니다. PR 단계에서 lint 한 줄로 막는 게 1/100 비용.

### 5.5 이 결정이 틀렸다고 판단할 기준

- 운영 측정 결과 OR 분리 형태도 **수백 ms**로 느림 → 인덱스 검토 필요 (composite index 누락 / cardinality 낮음)
- 같은 `created_at`의 row가 **극단적으로 많은** 도메인 → cursor 정의에 추가 컬럼 검토 (예: shop_id, batch_id)
- DB가 PostgreSQL로 바뀌면 — PostgreSQL은 row constructor 정확히 push down → row constructor 형태가 더 단순

---

## 6. 빅테크 사례 — Cursor 페이지네이션이 표준인 이유 {#bigtech-references}

### 6.1 Stripe — Cursor 표준의 원형

[Stripe API — Pagination](https://stripe.com/docs/api/pagination) 은 **모든** list endpoint가 cursor 기반:

```http
GET /v1/charges?limit=20&starting_after=ch_3MtwBwLkdIwHu7ix28a3tqPa
```

`starting_after` / `ending_before` 파라미터 — Stripe 표준. **깊은 페이지에서도 같은 latency**를 보장.

### 6.2 Notion — Cursor 표준 + 명시적 has_more

[Notion API — Pagination](https://developers.notion.com/reference/intro#pagination):

```json
{
  "has_more": true,
  "next_cursor": "ZZZZZZ-block-id",
  "results": [...]
}
```

`has_more` 플래그로 마지막 페이지 명시. cursor가 **opaque token** — 내부 구조 노출 없음.

### 6.3 Slack — Cursor-based Pagination 명시

[Slack API — Cursor-based Pagination](https://api.slack.com/docs/pagination):

> "Cursor-based pagination is the most reliable type for traversing large lists. Cursor-based pagination works by returning a pointer to a specific item in the dataset."

`response_metadata.next_cursor` — 표준. Slack도 **모든 list endpoint**가 cursor.

### 6.4 Use The Index, Luke! — "No Offset" 표준

[Use The Index, Luke! — No Offset](https://use-the-index-luke.com/no-offset) 은 OFFSET을 **anti-pattern**으로 명시:

> "OFFSET is bad for both performance and correctness. The seek method (also known as keyset pagination) is the alternative."

이 사이트는 RDBMS 인덱스 학습의 **bible** 격. cursor 페이지네이션 = "seek method" = "keyset pagination" — 같은 패턴의 다른 이름들.

### 6.5 Vlad Mihalcea — OR 분리 형태 패턴

[Vlad Mihalcea — Keyset Pagination](https://vladmihalcea.com/sql-seek-keyset-pagination/) 은 본 글의 (c) OR 분리 형태를 표준 패턴으로 제시:

```sql
WHERE (created_at < ? OR (created_at = ? AND id < ?))
ORDER BY created_at DESC, id DESC
LIMIT 20
```

Hibernate / JPA 컨텍스트에서 keyset pagination 구현법까지 자세히. **Java/Spring 백엔드**에서 가장 많이 인용되는 출처.

### 6.6 한 줄로

> 글로벌 API 표준 (Stripe / Notion / Slack), 인덱스 학습 표준 (Use The Index, Luke!), Java/Spring 표준 (Vlad Mihalcea) 모두 **cursor 페이지네이션**. OFFSET은 **작은 N** 또는 **내부 admin**만.

---

## 7. 운영 실패 시나리오 (3 AM 시나리오) {#failure-scenarios}

### 7.1 시나리오 1 — 운영자가 **깊은 페이지 OFFSET**으로 진입

대시보드 검색에서 사장님이 50,000 페이지로 점프. OFFSET 1,000,000 쿼리가 그대로 실행.

| 시점 | 신호 |
|---|---|
| **첫 알람** | 특정 endpoint P99 spike (수백 ms~초 단위) |
| **첫 5분** | 1) SLOW LOG → OFFSET 큰 쿼리 식별<br/>2) 대시보드 코드 → OFFSET 페이지네이션 잔재 검색<br/>3) cursor 페이지네이션 마이그레이션 PR 작성 |
| **사용자 영향** | 깊은 페이지 사용자 응답 수백 ms ~ 수 초 |

→ 임시 mitigation: 대시보드에서 **깊은 페이지 점프 비활성화** (다음/이전 버튼만). 영구 fix: cursor 마이그레이션.

### 7.2 시나리오 2 — 같은 created_at의 row가 다수일 때 단순 cursor가 row 빠뜨림

대량 INSERT batch (예: 외부 플랫폼 동기화) 직후 — 같은 `created_at` (ms 단위)의 row가 100건 이상 생김. (b) 단순 cursor `WHERE created_at < ?` 를 쓰면 — cursor 값이 **그 ms**인 row 100건 중 20개를 읽으면, 다음 페이지에서 `created_at < (그 ms)` 가 되니 **나머지 80건이 빠져버림**.

| 시점 | 신호 |
|---|---|
| **첫 알람** | 사용자 신고: "주문 목록에서 빠진 row 발견" |
| **첫 5분** | 1) `SELECT created_at, COUNT(*) FROM orders GROUP BY created_at HAVING COUNT(*) > 1` 로 동시각 row 확인<br/>2) cursor 형태 (b) → (c) OR 분리로 전환 |
| **사용자 영향** | 페이지네이션 **정확성** 깨짐 (운영 신뢰 손상) |

→ 단순 cursor가 **성능은 같은데** 정확성에서 깨짐. OR 분리 형태가 운영 표준인 이유.

### 7.3 시나리오 3 — 누군가 PR에 row constructor 형태로 작성

```sql
WHERE (created_at, id) < (:lastCreatedAt, :lastId)
```

PR 작성자가 ANSI SQL 표준이라 **맞다고 생각하고** 작성. 의미는 정확.

| 시점 | 신호 |
|---|---|
| **첫 알람** | (운영 영향 전) 코드 리뷰 단계 |
| **첫 5분** | 1) lint가 자동 차단 (5.4장)<br/>2) 차단 안 되면 리뷰어가 4장 룰 인용해서 차단 |
| **사용자 영향** | 0 (사전 차단) |

→ 사후 모니터링이 아니라 **PR 차단**이 핵심. row constructor가 운영에 한 번 풀리면 EXPLAIN ANALYZE 보기 전엔 **눈에 안 보임** (의미가 같으니까).

---

## 8. 무엇을 배웠나 {#key-takeaways}

### 8.1 측정으로 깨진 가정들

- "OFFSET은 깊은 페이지에서 느리지만, **얼마나** 느린지 막연" → **선형 증가, 1M = 171ms (실측)**
- "cursor 페이지네이션 쓰면 끝" → **반쪽 답** (어떤 SQL 형태인가에 따라 500배 차이)
- "ANSI SQL 표준 형태가 가장 안전" → **MySQL에선 옵티마이저 한계로 부적합**
- "옵티마이저가 똑똑하니까 OR로 자동 변환할 것" → **MySQL은 안 함 — Bug #16247은 오래된 known limitation (현재 트래커 duplicate)**

### 8.2 측정값이 만드는 **후속 학습 동기**

| 측정 | 후속 결정 |
|---|---|
| OFFSET 5M = 765ms | 깊은 페이지 점프 UI 비활성화 (다음/이전 버튼만) |
| (a) row constructor = 154ms | PR lint 룰 추가 (row constructor 차단) |
| (b) 단순 cursor = 0.27ms | 같은 created_at row 검토 후 (b) 사용 가능 도메인 식별 |
| (c) OR 분리 = 0.30ms | 운영 표준 — Vlad Mihalcea 패턴 |
| MySQL Bug #16247 | DB 마이그레이션 시 (PostgreSQL 등) cursor 형태 재검토 |

### 8.3 핵심 한 줄

> **OFFSET은 **읽고 버리는 row 수**가 비용**. 1,000만 row에서 OFFSET 1M = 171ms / cursor = 0.30ms — **약 570배 차이**. 그런데 cursor 코드를 **어떻게 쓰는가** 가 진짜 본질 — row constructor 형태는 MySQL 옵티마이저가 push down 못 해서 154ms (OFFSET과 비슷). EXPLAIN ANALYZE의 **Filter:** vs **Covering index range scan over** 한 줄 차이가 latency 500배의 원인.

---

## 9. 정리 — 이 글을 한 번 더, 자기 말로 {#recap}

이 글을 다 읽은 누군가가 "그래서 이게 뭐였지?" 묻는다면 — 측정으로 풀었던 답을 자기 말로 정리해보면 다음과 같습니다.

### Q. "OFFSET 페이지네이션이 1,000만 row 환경에서 무너지는 진짜 이유는?"

OFFSET 의 비용은 **읽고 버리는 row 수** 와 정확히 비례합니다 — [실측] OFFSET 1M = 171ms (rows scanned 1,000,020), OFFSET 5M = 765ms. 인덱스가 있어도, covering 이어도 마찬가지. **InnoDB 의 B+-tree 인덱스가 서수 위치 메타데이터를 가지지 않기 때문**에 N번째 row 로 직접 점프할 수 없고, 1번째부터 N번째까지 순차로 읽고 버리는 방법밖에 없습니다. PostgreSQL · Oracle · SQL Server 의 일반적인 B-tree 인덱스도 동일한 구조라 같은 한계가 적용됩니다. 그래서 cursor 페이지네이션이 **대용량 순차 탐색 API 에서 널리 쓰이는 표준 패턴**.

### Q. "row constructor `(a,b) < (?,?)` 와 OR 분리 형태가 같은 의미인데 왜 500배 차이가 나나요?"

수학적으로는 lexicographic 비교 — 동일한 row 집합을 반환합니다. 그런데 **MySQL 옵티마이저가 row constructor 를 index range scan 으로 push down 못 하는 한계** 가 있습니다 — Bug #16247 은 2006년에 등록된 오래된 known limitation (트래커는 현재 duplicate 처리). EXPLAIN ANALYZE 한 줄로 검증되는 차이: row constructor 는 `Filter:` 단계로 1,000,000 row 전수 스캔 (154ms), OR 분리는 `Covering index range scan over` 로 rows=20 만 스캔 (0.30ms). PostgreSQL 은 같은 SQL 을 정상 push down — **DB 별 옵티마이저 구현이 ANSI SQL 표준 의미를 어떻게 해석하느냐가 본질**.

### Q. "단순 cursor `created_at < ?` 와 OR 분리 형태 — 운영 표준은 어느 쪽?"

성능은 거의 동일합니다 — 0.27 vs 0.30ms. 차이는 **운영 안전성**: 같은 `created_at` 의 row 가 동시각에 다수 존재할 때 (대량 INSERT batch / 마이그레이션 등) 단순 cursor 는 row 누락 발생. 같은 ms 에 100건 INSERT 됐는데 그 ms 를 cursor 로 잡으면 다음 페이지에서 일부가 빠집니다. **OR 분리는 (created_at, id) 둘 다 비교해서 정확한 페이지 경계** 를 보장. 동시각 row 가 희소하다고 증명된 도메인이 아닌 한, 운영 표준은 OR 분리.

### Q. "OFFSET 페이지네이션을 **완전히** 안 쓰는 게 정답인가요?"

[실측] 으로 본 결론: **작은 OFFSET (≤ 1,000) 은 OK** — 0.443ms 로 충분히 빠름. 내부 admin / sample 1페이지 처럼 제한된 사용처엔 SQL 단순함이 cursor 보다 가독성 좋음. 단 사용자 노출 깊은 페이지엔 절대 X — 5M OFFSET = 765ms. 본 글의 결론: ADR 룰로 **"OFFSET 사용 시 N ≤ 1,000 만 허용"** 명시 + PR 차단.

---

## 10. 다음 글에서 {#next-post}

본 측정은 EXPLAIN ANALYZE 의 단일 쿼리 latency만 봤습니다. 운영에서는 다음 축들도 같이 봐야 합니다.

- **동시성** — cursor 페이지네이션 중에 **INSERT**가 들어오면? **DELETE**가 들어오면? Repeatable Read에서 어떻게 보장되나
- **인덱스 cardinality** — created_at의 cardinality가 낮으면 (예: 일별 통계) cursor 형태 어떻게 잡나
- **infinite scroll vs page jump UI** — UX와 SQL의 trade-off

다음 글에서:

- Repeatable Read에서 cursor 페이지네이션 + INSERT 시 **팬텀 row**가 어떻게 다뤄지나
- composite cursor의 **세 번째 컬럼** 도입 시점 (shop_id, batch_id 등)
- ElasticSearch / OpenSearch의 search_after vs RDBMS cursor — 같은 패턴, 다른 구현

---

## 참고자료 {#references}

- [Stripe API — Pagination](https://stripe.com/docs/api/pagination) — cursor 표준의 원형
- [Notion API — Pagination](https://developers.notion.com/reference/intro#pagination) — opaque cursor + has_more
- [Slack API — Cursor-based Pagination](https://api.slack.com/docs/pagination) — "most reliable type for traversing large lists"
- [Use The Index, Luke! — No Offset](https://use-the-index-luke.com/no-offset) — OFFSET = anti-pattern
- [Vlad Mihalcea — Keyset Pagination](https://vladmihalcea.com/sql-seek-keyset-pagination/) — OR 분리 형태 표준 패턴 (Java/Spring)
- [MySQL Bug #16247 — Row comparisons should use range scan](https://bugs.mysql.com/bug.php?id=16247) — 2006년 등록된 오래된 known limitation (트래커는 현재 duplicate 처리)
- [PostgreSQL — Multicolumn Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html) — row constructor가 정상 동작
- [MySQL Reference — EXPLAIN ANALYZE](https://dev.mysql.com/doc/refman/8.0/en/explain.html#explain-analyze) — `actual time` / `rows` 해석
- 본 측정 — raw 데이터는 별도 학습 노트에 보관 (포트폴리오 repo 내부)
