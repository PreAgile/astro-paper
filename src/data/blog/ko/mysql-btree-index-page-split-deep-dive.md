---
author: 김면수
pubDatetime: 2026-01-09T10:00:00Z
title: "B+-tree 인덱스와 Page Split: UUID가 당신의 INSERT를 죽이고 있다"
featured: true
draft: false
tags:
  - MySQL
  - InnoDB
  - Database
  - Backend
  - Performance
  - Index
description: "왜 복합 인덱스의 컬럼 순서가 중요할까? UUID PK가 왜 INSERT 성능을 망칠까? InnoDB B+-tree의 Page Split 메커니즘을 파고들어, '감'이 아닌 '원리'로 인덱스를 설계합니다."
---

## 목차

## 들어가며: 1,000 TPS의 벽

리뷰 수집 서비스를 운영하던 중, 갑자기 INSERT 성능이 급락하는 현상을 겪었습니다.

```log
[WARN] Slow Query: 850ms
INSERT INTO reviews (id, shop_id, content, ...) VALUES (?, ?, ?, ...)
```

특이한 점은 **데이터가 쌓일수록 느려진다**는 것이었습니다.

| 데이터 크기 | INSERT TPS | 평균 응답 시간 |
|------------|-----------|--------------|
| 100만 건 | 2,500 | 2ms |
| 500만 건 | 800 | 15ms |
| 1,000만 건 | 200 | 85ms |

테이블 구조는 평범했습니다:

```sql
CREATE TABLE reviews (
  id VARCHAR(36) PRIMARY KEY,  -- UUID v4
  shop_id VARCHAR(36),
  content TEXT,
  rating TINYINT,
  created_at DATETIME,
  INDEX idx_shop_created (shop_id, created_at)
);
```

범인은 **UUID v4 Primary Key**였습니다. 더 정확히 말하면, UUID의 **랜덤성**이 B+-tree의 **Page Split**을 폭발적으로 유발하고 있었습니다.

이 글에서는 B+-tree 인덱스의 내부 구조를 파고들어, **왜** 이런 일이 발생하는지, 그리고 **어떻게** 해결해야 하는지 설명하겠습니다.

---

## 1. B+-tree 인덱스 구조 이해하기

### Clustered Index vs Secondary Index

이전 글에서 InnoDB의 Page 개념을 다뤘습니다. 인덱스는 이 Page들을 **B+-tree 구조**로 연결한 것입니다.

```mermaid
graph TB
    subgraph "Clustered Index - B+-tree"
        R[Root Page<br/>PK 범위 포인터]

        I1[Internal Page<br/>1-500 → Leaf1]
        I2[Internal Page<br/>501-1000 → Leaf2]

        L1[Leaf Page 1<br/>실제 Row 데이터]
        L2[Leaf Page 2<br/>실제 Row 데이터]
        L3[Leaf Page 3<br/>실제 Row 데이터]
    end

    R --> I1
    R --> I2
    I1 --> L1
    I1 --> L2
    I2 --> L3

    L1 <-.-> L2 <-.-> L3
```

<img src="/images/btree-index/btree-structure-light.svg" alt="InnoDB B+-tree Clustered Index 구조" class="theme-img-light" />
<img src="/images/btree-index/btree-structure-dark.svg" alt="InnoDB B+-tree Clustered Index 구조" class="theme-img-dark" />

**InnoDB의 두 가지 인덱스:**

| 특징 | Clustered Index | Secondary Index |
|------|-----------------|-----------------|
| **구성** | PK + 전체 Row 데이터 | 인덱스 컬럼 + PK |
| **개수** | 테이블당 1개 | 여러 개 가능 |
| **Leaf 노드** | 실제 데이터 저장 | PK 값 저장 |
| **정렬** | PK 순서로 물리적 정렬 | 인덱스 컬럼 순서로 정렬 |

**핵심 포인트**: InnoDB에서 테이블 자체가 Clustered Index입니다. 테이블이 곧 B+-tree입니다.

### B+-tree의 특징

**일반 B-tree와의 차이:**

```mermaid
graph TB
    subgraph "B-tree"
        BR[Root<br/>데이터 + 포인터]
        BI1[Internal<br/>데이터 + 포인터]
        BI2[Internal<br/>데이터 + 포인터]
        BL1[Leaf]
        BL2[Leaf]
        BL3[Leaf]

        BR --> BI1
        BR --> BI2
        BI1 --> BL1
        BI1 --> BL2
        BI2 --> BL3
    end

    subgraph "B+-tree"
        PR[Root<br/>포인터만]
        PI1[Internal<br/>포인터만]
        PI2[Internal<br/>포인터만]
        PL1[Leaf<br/>모든 데이터]
        PL2[Leaf<br/>모든 데이터]
        PL3[Leaf<br/>모든 데이터]

        PR --> PI1
        PR --> PI2
        PI1 --> PL1
        PI1 --> PL2
        PI2 --> PL3

        PL1 <-.->|Linked List| PL2 <-.-> PL3
    end
```

| 특징 | B-tree | B+-tree |
|------|--------|---------|
| 데이터 위치 | 모든 노드 | **Leaf 노드만** |
| Leaf 연결 | 연결 없음 | **양방향 Linked List** |
| 범위 검색 | 트리 재탐색 필요 | **순차 스캔 가능** |
| 공간 효율 | Internal에도 데이터 | Internal은 포인터만 → **더 많은 fanout** |

### Fan-out과 Tree Height

**Fan-out**: 하나의 노드가 가리킬 수 있는 자식 노드 수

```sql
-- InnoDB Internal 노드 Entry 구조
┌─────────────────────────────────┐
│ Key (BIGINT): 8 bytes           │
│ Child Page Number: 4 bytes      │
│ Record Header: 약 5 bytes       │
│ Total: 약 17 bytes              │
└─────────────────────────────────┘

-- 페이지 가용 공간 계산
페이지 크기: 16,384 bytes
- FIL Header/Trailer: 46 bytes
- Page Header: 56 bytes
- Infimum/Supremum: 26 bytes
≈ 16,256 bytes 가용

BIGINT PK Fan-out ≈ 16,256 / 17 ≈ 950
UUID(16) Fan-out ≈ 16,256 / 25 ≈ 650
```

**Tree Height 계산:**

| Rows | BIGINT PK (fanout ~950) | UUID PK (fanout ~650) |
|------|------------------------|----------------------|
| 1만 | 2 | 2 |
| 100만 | **3** | **3** |
| 1억 | 3 | **4** ← 여기서 차이! |
| 10억 | 4 | 4 |

```
BIGINT: 950² = 90만, 950³ = 8.5억 → 1억건은 Height 3
UUID:   650² = 42만, 650³ = 2.7억 → 1억건은 Height 4
```

Height 3 vs 4의 차이는 **1 I/O**뿐입니다. 하지만 UUID의 진짜 문제는 **매 INSERT마다 Page Split이 발생**한다는 점입니다. 이는 높이와 무관하게 성능을 파괴합니다.

---

## 2. Page Split: INSERT 성능의 핵심

### Page Split이란?

페이지가 가득 찬 상태에서 새 레코드를 삽입해야 할 때, 페이지를 **분할**하는 과정입니다.

```mermaid
sequenceDiagram
    participant App as Application
    participant BP as Buffer Pool
    participant Disk as Disk

    Note over BP: Page A: 95% Full<br/>[1, 2, 3, ..., 100]

    App->>BP: INSERT id=50.5
    Note over BP: 공간 부족!

    BP->>BP: Page Split 시작
    Note over BP: 1. 새 Page B 할당
    Note over BP: 2. Page A의 절반을 Page B로 이동
    Note over BP: 3. 새 레코드 삽입
    Note over BP: 4. 부모 노드에 Page B 포인터 추가

    BP->>Disk: Page A 쓰기
    BP->>Disk: Page B 쓰기
    BP->>Disk: 부모 Page 쓰기

    Note over Disk: 3배의 I/O 발생!
```

<img src="/images/btree-index/page-split-light.svg" alt="Page Split 발생 과정 - Before/After" class="theme-img-light" />
<img src="/images/btree-index/page-split-dark.svg" alt="Page Split 발생 과정 - Before/After" class="theme-img-dark" />

**Page Split 비용:**

| 작업 | 디스크 I/O | 메모리 작업 |
|------|-----------|------------|
| 일반 INSERT | 0~1회 | 1 페이지 수정 |
| Page Split | **3회 이상** | 3+ 페이지 수정, 메모리 복사 |

### Sequential vs Random Insert

**MySQL 공식 문서**에 따르면:

> 새로운 레코드가 InnoDB clustered index에 삽입될 때, InnoDB는 미래의 삽입과 업데이트를 위해 페이지의 **1/16(6.25%)**을 비워둡니다.
>
> - **순차 삽입**: 페이지 활용률 **15/16 (93.75%)**
> - **무작위 삽입**: 페이지 활용률 **1/2 ~ 15/16 (50% ~ 93.75%)**

```mermaid
graph LR
    subgraph "Sequential Insert - Auto Increment"
        S1["Page 1<br/>██████████████░<br/>93% Full"]
        S2["Page 2<br/>██████████████░<br/>93% Full"]
        S3["Page 3: 현재<br/>████░░░░░░░░░░░<br/>Writing..."]
    end

    subgraph "Random Insert - UUID v4"
        R1["Page 1<br/>████████░░░░░░░<br/>50% Full"]
        R2["Page 2<br/>█████░░░░░░░░░░<br/>35% Full"]
        R3["Page 3<br/>███████░░░░░░░░<br/>45% Full"]
    end
```

<img src="/images/btree-index/sequential-vs-random-light.svg" alt="Sequential INSERT vs Random INSERT 비교" class="theme-img-light" />
<img src="/images/btree-index/sequential-vs-random-dark.svg" alt="Sequential INSERT vs Random INSERT 비교" class="theme-img-dark" />

**왜 Random Insert가 공간 효율이 낮을까?**

UUID v4는 완전히 랜덤합니다:

```
550e8400-e29b-41d4-a716-446655440000
6ba7b810-9dad-11d1-80b4-00c04fd430c8
3f2504e0-4f89-11d3-9a0c-0305e82c3301
```

이 값들을 정렬하면 **어느 위치든** 삽입될 수 있습니다. 결과적으로:

1. **모든 페이지가 "Hot"**: 어떤 페이지든 수정 대상
2. **빈번한 Page Split**: 이미 50% 찬 페이지에 삽입 → 즉시 분할
3. **Buffer Pool 경쟁**: 모든 페이지를 메모리에 유지해야 함

### 실측 데이터: UUID v4 vs Auto Increment

[MySQL.rjweb.org의 벤치마크](https://mysql.rjweb.org/doc.php/uuid)에서 발췌:

```
테스트 환경: 1억 건 INSERT
Buffer Pool: 1GB (전체 인덱스 크기보다 작음)

Auto Increment:
- INSERT/sec: 8,000+
- Page Split: ~1,000회
- 디스크 활용률: 93%

UUID v4:
- INSERT/sec: 400 (20배 느림!)
- Page Split: ~50,000회 (50배 많음!)
- 디스크 활용률: 50%
```

**핵심 인사이트**: 인덱스가 Buffer Pool보다 커지는 순간, UUID의 성능은 급락합니다. 랜덤 접근으로 인해 **거의 모든 INSERT가 디스크 I/O를 유발**합니다.

> ⚠️ **Critical Threshold**
>
> - 인덱스 크기 < Buffer Pool: UUID 문제가 **숨겨져 있음**
> - 인덱스 크기 > Buffer Pool: UUID **재앙 시작**
>
> 이것이 "데이터가 쌓일수록 느려지는" 진짜 이유입니다.

---

## 3. UUID PK의 실제 문제점

### 문제 1: 저장 공간 2배 증가

| PK 타입 | 저장 크기 | 1억 건 기준 |
|---------|----------|-----------|
| BIGINT | 8 bytes | 800 MB |
| BINARY(16) | 16 bytes | 1.6 GB |
| VARCHAR(36) | 37 bytes | **3.7 GB** |

**Secondary Index 영향:**

모든 Secondary Index는 PK를 포함합니다:

```sql
-- UUID PK 사용 시
CREATE INDEX idx_shop ON reviews (shop_id);
-- 실제 저장: shop_id(36) + PK(36) = 72 bytes per entry

-- BIGINT PK 사용 시
-- 실제 저장: shop_id(36) + PK(8) = 44 bytes per entry
-- 38% 공간 절약!
```

### 문제 2: B+-tree 높이 증가 가능성

PK 크기가 커지면 페이지당 Entry 수가 줄어듭니다:

```
BIGINT PK:
- Internal Entry: 8 + 6 = 14 bytes
- Fan-out: ~1,000
- 10억 rows → Height 3

UUID (BINARY 16) PK:
- Internal Entry: 16 + 6 = 22 bytes
- Fan-out: ~680
- 10억 rows → Height 4 (추가 1 I/O!)
```

### 문제 3: 캐시 효율성 저하

```mermaid
graph TB
    subgraph "Auto Increment - Hot Spot at Right Edge"
        A1["Page 1<br/>Cold: 오래된 데이터"]
        A2[Page 2<br/>Cold]
        A3[Page 999<br/>Cold]
        A4["Page 1000<br/>HOT: 최신 삽입"]
    end

    subgraph "UUID - 전체가 Hot"
        U1[Page 1<br/>Hot]
        U2[Page 2<br/>Hot]
        U3[Page 999<br/>Hot]
        U4[Page 1000<br/>Hot]
    end
```

**Auto Increment**:
- 최신 페이지만 Hot → Buffer Pool에 쉽게 유지
- 오래된 데이터는 Cold → 제거되어도 영향 적음

**UUID v4**:
- 모든 페이지가 Hot → Buffer Pool 경쟁 심화
- 어떤 페이지든 제거되면 디스크 I/O 발생

### 문제 4: Change Buffer를 활용하지 못함

InnoDB의 **Change Buffer**는 Secondary Index의 Random Write를 버퍼링하여 성능을 개선합니다. 하지만 **Clustered Index(PK)는 Change Buffer를 사용하지 않습니다!**

```sql
-- Change Buffer 사용 조건
✅ 사용 가능:
   - Non-Unique Secondary Index의 INSERT/UPDATE/DELETE
   - 해당 페이지가 Buffer Pool에 없을 때

❌ 사용 불가:
   - Unique Index (중복 체크 필요)
   - Clustered Index (PK) ← UUID가 여기!
   - Full-Text Index
```

```mermaid
graph LR
    subgraph "Secondary Index INSERT"
        S1[INSERT] --> S2{페이지가<br/>Buffer Pool에?}
        S2 -->|No| S3[Change Buffer에<br/>기록]
        S2 -->|Yes| S4[직접 수정]
        S3 -->|나중에 Merge| S4
    end

    subgraph "Clustered Index INSERT"
        C1[INSERT] --> C2[무조건<br/>즉시 처리!]
        C2 --> C3[Page Split 발생 가능]
    end
```

**실무 영향**: UUID PK의 Random INSERT는 **Change Buffer로 해결 불가능**합니다. 이것이 UUID가 Secondary Index보다 PK에서 더 치명적인 이유입니다.

### 문제 5: Write Amplification (쓰기 증폭)

UUID v4 PK는 단순히 INSERT 성능만 낮추는 것이 아니라, **물리적 디스크 쓰기량**을 폭발적으로 증가시킵니다.

```mermaid
graph TB
    subgraph "Auto Increment PK"
        A1["1 INSERT"] --> A2["1~2 Page Write"]
        A2 --> A3["Clustered: 1 page"]
        A2 --> A4["Secondary 1: 1 page"]
        A2 --> A5["Secondary 2: 1 page"]
        AT["Total: 3 pages"]
    end

    subgraph "UUID v4 PK + Page Split"
        U1["1 INSERT"] --> U2["9+ Page Write!"]
        U2 --> U3["Clustered: 3 pages<br/>(Split)"]
        U2 --> U4["Secondary 1: 3 pages"]
        U2 --> U5["Secondary 2: 3 pages"]
        UT["Total: 9+ pages - 3배!"]
    end
```

**Write Amplification Factor (WAF) 계산:**

| 시나리오 | 논리적 쓰기 | 물리적 쓰기 | WAF |
|---------|-----------|-----------|-----|
| Auto Increment, Secondary 2개 | 1 row | ~3 pages | 3x |
| UUID v4, Secondary 2개 | 1 row | ~9 pages | **9x** |
| UUID v4, Secondary 5개 | 1 row | ~18 pages | **18x** |

**SSD 수명 영향:**

```
1억 건 INSERT 시 총 쓰기량:
- Auto Increment: 100M × 3 × 16KB = 4.8TB
- UUID v4 (5 Secondary): 100M × 18 × 16KB = 28.8TB

→ UUID v4는 SSD 수명을 6배 단축시킵니다!
```

---

## 4. 복합 인덱스: 컬럼 순서가 왜 중요한가?

PK 최적화만으로는 부족합니다. Secondary Index가 3개 이상인 테이블에서는 **복합 인덱스 설계 실수**가 더 큰 병목이 될 수 있습니다.

### Leftmost Prefix Rule

복합 인덱스는 **왼쪽부터 순서대로만** 사용됩니다.

```sql
CREATE INDEX idx_composite ON orders (
  customer_id,   -- Column 1
  order_date,    -- Column 2
  status         -- Column 3
);
```

**인덱스 활용 패턴:**

| WHERE 조건 | 인덱스 사용 | 사용되는 컬럼 |
|------------|-----------|--------------|
| `customer_id = 1` | ✅ | customer_id |
| `customer_id = 1 AND order_date = '2024-01-01'` | ✅ | customer_id, order_date |
| `customer_id = 1 AND order_date = '...' AND status = 'DONE'` | ✅ | 전체 |
| `order_date = '2024-01-01'` | ❌ | **없음** |
| `status = 'DONE'` | ❌ | **없음** |
| `customer_id = 1 AND status = 'DONE'` | ⚠️ | customer_id만 |

### B+-tree 저장 방식 시각화

복합 인덱스는 **컬럼을 연결한 값**으로 정렬됩니다:

```mermaid
graph TB
    subgraph "idx_composite 정렬 순서"
        R1["(1, 2024-01-01, DONE)"]
        R2["(1, 2024-01-02, PENDING)"]
        R3["(1, 2024-01-03, DONE)"]
        R4["(2, 2024-01-01, PENDING)"]
        R5["(2, 2024-01-01, SHIPPED)"]
    end

    R1 --> R2 --> R3 --> R4 --> R5
```

**핵심**: `customer_id = 1`을 찾으면 연속된 영역. 하지만 `status = 'DONE'`만 찾으면 **전체 스캔**해야 함.

### Range 조건의 함정

```sql
-- 인덱스: (last_name, first_name, birthday)

SELECT * FROM users
WHERE last_name = 'Kim'           -- Equality ✅
  AND first_name BETWEEN 'A' AND 'M'  -- Range ⚠️
  AND birthday = '1990-01-01';    -- 인덱스 사용 불가 ❌
```

**MySQL은 Range 조건을 만나면 그 이후 컬럼은 인덱스를 사용하지 않습니다.**

```
인덱스 사용: last_name, first_name
인덱스 미사용: birthday

EXPLAIN에서 key_len으로 확인 가능:
- last_name VARCHAR(50): 200 bytes (utf8mb4)
- first_name VARCHAR(50): 200 bytes
- key_len = 400 (birthday는 포함 안 됨)
```

### 최적의 컬럼 순서 전략

**원칙:**
1. **Equality 조건 컬럼을 앞에** 배치
2. **카디널리티가 높은 컬럼을 앞에** (선택성이 좋은 것)
3. **Range/ORDER BY 컬럼은 뒤에** 배치

```sql
-- ❌ 비효율적: Range가 앞에
CREATE INDEX idx_bad ON orders (order_date, customer_id, status);

-- ✅ 효율적: Equality가 앞에, Range가 뒤에
CREATE INDEX idx_good ON orders (customer_id, status, order_date);
```

### Covering Index: 테이블 접근 제거

**Covering Index**는 쿼리에 필요한 모든 컬럼을 인덱스에 포함시켜, **테이블 접근 없이** 인덱스만으로 쿼리를 처리합니다.

```sql
-- Non-Covering Index
CREATE INDEX idx_customer ON orders (customer_id);

SELECT customer_id, order_date, total_amount
FROM orders
WHERE customer_id = 100;

-- 실행 과정:
-- 1. idx_customer에서 PK 찾기
-- 2. PK로 테이블 접근 (Random I/O!)
-- 3. order_date, total_amount 읽기
```

```sql
-- Covering Index
CREATE INDEX idx_covering ON orders (
  customer_id,
  order_date,
  total_amount
);

-- 실행 과정:
-- 1. idx_covering만 스캔 → 끝!
-- EXPLAIN에서 "Using index" 표시
```

**성능 차이:**

| 시나리오 | Non-Covering | Covering | 개선 |
|---------|-------------|----------|------|
| 조회 10,000건 | 5초 (HDD) | 50ms | **100배** |
| 조회 10,000건 | 500ms (SSD) | 50ms | **10배** |

---

## 5. 대안: 시간 정렬 가능한 ID

### UUIDv7 (2024년 표준)

2024년 5월 IETF RFC 9562로 표준화된 **시간 정렬 가능한 UUID**입니다.

```
UUIDv7 구조 (128 bits):
┌──────────────────────────────────────────────────┐
│ unix_ts_ms (48 bits)                             │ → 시간순 정렬 가능!
├──────────────────────────────────────────────────┤
│ ver(4) │ rand_a (12 bits)                        │
├──────────────────────────────────────────────────┤
│ var(2) │ rand_b (62 bits)                        │
└──────────────────────────────────────────────────┘
```

**UUIDv4 vs UUIDv7:**

```
UUIDv4 (완전 랜덤):
550e8400-e29b-41d4-a716-446655440000
6ba7b810-9dad-11d1-80b4-00c04fd430c8
3f2504e0-4f89-11d3-9a0c-0305e82c3301
→ 정렬하면 완전히 뒤섞임

UUIDv7 (시간 기반):
018d3f3c-8c84-7890-abcd-123456789012  ← 2024-01-01 10:00:00
018d3f3c-9a12-7234-ef01-234567890123  ← 2024-01-01 10:00:01
018d3f3c-a7b3-7456-1234-345678901234  ← 2024-01-01 10:00:02
→ 시간순 정렬 유지!
```

### ULID (Universally Unique Lexicographically Sortable Identifier)

```
ULID 구조:
 01AN4Z07BY      79KA1307SR9X4MV3
├──────────┤    ├────────────────┤
 Timestamp        Randomness
  48 bits          80 bits

특징:
- Crockford's Base32 인코딩 (I, L, O, U 제외)
- 문자열로도 정렬 가능
- 26자리 (UUID의 36자리보다 짧음)
```

### Twitter Snowflake ID

Twitter(현 X)에서 개발한 **64-bit** 분산 ID 생성 방식입니다.

```
Snowflake ID 구조 (64 bits):
┌─────────────────────────────────────────────────────────────────┐
│ 0 │ Timestamp (41 bits)     │ DC(5) │ Worker(5) │ Seq(12)      │
└─────────────────────────────────────────────────────────────────┘

- Timestamp: 밀리초 (69년 사용 가능)
- Datacenter ID: 32개 데이터센터
- Worker ID: 데이터센터당 32개 머신
- Sequence: 밀리초당 4,096 ID

→ 초당 409만 6천 ID 생성 가능 (머신당)
```

### 성능 비교

```mermaid
graph LR
    subgraph "INSERT 성능 비교 - 1억 건"
        A[Auto Increment<br/>TPS: 8,000<br/>기준]
        B[UUIDv7<br/>TPS: 6,000<br/>-25%]
        C[ULID<br/>TPS: 6,500<br/>-19%]
        D[UUIDv4<br/>TPS: 400<br/>-95%!]
    end
```

| ID 타입 | 크기 | INSERT TPS | Page Fill | 특징 |
|---------|------|-----------|-----------|------|
| Auto Increment | 8 bytes | 8,000 | 93% | 단일 DB에서 최고 |
| Snowflake | 8 bytes | 7,500 | 90% | 분산 환경 최적 |
| ULID | 16 bytes | 6,500 | 85% | 문자열 정렬 가능 |
| UUIDv7 | 16 bytes | 6,000 | 80% | UUID 호환 필요 시 |
| UUIDv4 | 16 bytes | **400** | **50%** | ❌ 사용 금지 |

---

## 6. 글로벌 기업의 ID 전략

### Instagram: 샤딩 환경의 ID 생성

Instagram은 PostgreSQL 샤딩 환경에서 고유한 ID 생성 전략을 사용합니다.

```sql
-- Instagram ID 구조 (64 bits)
-- 41 bits: Timestamp
-- 13 bits: Shard ID (8,192개 샤드 지원)
-- 10 bits: Auto-increment (밀리초당 1,024 ID)

CREATE OR REPLACE FUNCTION next_id(OUT result bigint) AS $$
DECLARE
  our_epoch bigint := 1314220021721;
  seq_id bigint;
  now_millis bigint;
  shard_id int := 5;  -- 현재 샤드 ID
BEGIN
  SELECT nextval('table_id_seq') % 1024 INTO seq_id;
  SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) INTO now_millis;
  result := (now_millis - our_epoch) << 23;
  result := result | (shard_id << 10);
  result := result | seq_id;
END;
$$ LANGUAGE PLPGSQL;
```

**장점:**
- ZooKeeper 불필요 (샤드 ID가 이미 정해져 있음)
- 기존 PostgreSQL 기능만 사용
- 시간순 정렬 가능

### Flickr: Ticket Server

Flickr는 매우 단순하지만 효과적인 중앙 집중식 ID 생성을 사용합니다.

```sql
-- Ticket Server 1 (홀수)
SET auto_increment_increment = 2;
SET auto_increment_offset = 1;  -- 1, 3, 5, 7...

-- Ticket Server 2 (짝수)
SET auto_increment_increment = 2;
SET auto_increment_offset = 2;  -- 2, 4, 6, 8...

-- ID 요청
REPLACE INTO Tickets64 (stub) VALUES ('a');
SELECT LAST_INSERT_ID();
```

**2006년부터 18년 이상 프로덕션에서 운영** - "elegant하지 않지만 놀랍도록 잘 작동한다"고 Flickr 엔지니어가 언급.

### Shopify: Composite Primary Key

Shopify는 멀티테넌트 환경에서 **Composite Primary Key**를 활용합니다.

```sql
-- 기존: shop_id를 Foreign Key로
CREATE TABLE orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  shop_id BIGINT,
  ...
);

-- 변경: shop_id를 PK에 포함
CREATE TABLE orders (
  shop_id BIGINT,
  id BIGINT AUTO_INCREMENT,
  PRIMARY KEY (shop_id, id),
  ...
);
```

**효과:**
- 같은 shop의 데이터가 물리적으로 인접
- 샤딩 시 자연스러운 파티션 키
- JOIN 성능 향상

### Stripe: Prefixed Object ID

Stripe은 객체 타입을 구분할 수 있는 **Prefix**를 사용합니다:

```
ch_1A2B3C4D5E6F7G8H  → Charge
cus_1A2B3C4D5E6F7G8H → Customer
pi_1A2B3C4D5E6F7G8H  → Payment Intent
evt_1A2B3C4D5E6F7G8H → Event (시간 기반 컴포넌트 포함)
```

**특징:**
- ID만 보고 객체 타입 식별 가능
- 디버깅 용이
- 최대 255자까지 허용 (확장성 확보)

---

## 7. 실무 튜닝 가이드

### innodb_fill_factor 설정

인덱스 빌드 시 페이지를 얼마나 채울지 결정합니다.

```sql
-- 기본값: 100 (100%)
SHOW VARIABLES LIKE 'innodb_fill_factor';

-- INSERT가 많은 워크로드
SET GLOBAL innodb_fill_factor = 80;
-- 효과: 20% 여유 공간 → Page Split 감소
-- 단점: 디스크 사용량 25% 증가
```

### MERGE_THRESHOLD 설정

페이지 병합을 트리거하는 임계값입니다.

```sql
-- 기본값: 50 (50% 미만이면 병합 시도)
-- 테이블 레벨 설정
CREATE TABLE orders (
  ...
) ENGINE=InnoDB COMMENT='MERGE_THRESHOLD=40';

-- 인덱스 레벨 설정
CREATE INDEX idx_name ON orders (name)
  COMMENT='MERGE_THRESHOLD=35';
```

**Merge-Split 사이클 문제:**
- 페이지가 49%로 떨어짐 → 병합
- 새 INSERT로 다시 분할
- 반복...

**해결**: `MERGE_THRESHOLD`를 낮춰서 병합을 덜 적극적으로

### Page Split 모니터링

```sql
-- Page Split 카운터 확인
SELECT NAME, COUNT
FROM INFORMATION_SCHEMA.INNODB_METRICS
WHERE NAME IN (
  'index_page_splits',
  'index_page_merge_attempts',
  'index_page_merge_successful'
);

-- 시간당 Page Split 계산
SELECT
  @prev := COUNT as current,
  @delta := COUNT - @prev as delta
FROM INFORMATION_SCHEMA.INNODB_METRICS
WHERE NAME = 'index_page_splits';

-- 권장: 시간당 1,000회 이하
```

### 인덱스 재구성 시점

**트리거 조건:**
1. Page Split이 시간당 10,000회 이상
2. 예상 대비 실제 테이블 크기가 2배 이상
3. 동일 쿼리 응답 시간이 2배 이상 증가

```sql
-- Online 재구성 (MySQL 5.6+)
ALTER TABLE orders ENGINE=InnoDB, ALGORITHM=INPLACE, LOCK=NONE;

-- 또는 pt-online-schema-change 사용 (서비스 중단 없음)
pt-online-schema-change \
  --alter "ENGINE=InnoDB" \
  D=mydb,t=orders \
  --execute
```

---

## 8. 우리의 해결책

### Before: UUID v4

```sql
CREATE TABLE reviews (
  id VARCHAR(36) PRIMARY KEY,  -- UUID v4
  shop_id VARCHAR(36),
  ...
);
```

**문제:**
- INSERT TPS: 200 (목표의 20%)
- Page Fill: 50%
- 디스크 사용량: 예상의 2배

### After: ULID + BINARY

```sql
CREATE TABLE reviews (
  id BINARY(16) PRIMARY KEY,  -- ULID → Binary 변환
  shop_id BINARY(16),
  ...
);

-- 애플리케이션에서 ULID 생성 후 Binary로 변환
-- TypeScript 예시
import { ulid } from 'ulid';

const id = ulid();  // "01ARZ3NDEKTSV4RRFFQ69G5FAV"
const binary = Buffer.from(decodeULID(id));  // 16 bytes
```

### 결과

| 지표 | Before | After | 개선 |
|------|--------|-------|------|
| INSERT TPS | 200 | 3,500 | **17.5배** |
| Page Fill Rate | 50% | 85% | +35%p |
| 디스크 사용량 | 20GB | 12GB | **40% 절감** |
| P99 Latency | 850ms | 45ms | **19배** |

---

## 9. 3분 안에 내 DB 진단하기

지금 당장 실행해볼 수 있는 진단 쿼리입니다.

### Step 1: 테이블 크기 확인

```sql
-- 테이블별 크기 확인
SELECT
  table_name,
  table_rows,
  ROUND(data_length / 1024 / 1024, 2) AS data_mb,
  ROUND(index_length / 1024 / 1024, 2) AS index_mb,
  ROUND((data_length + index_length) / 1024 / 1024, 2) AS total_mb
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY total_mb DESC
LIMIT 10;
```

### Step 2: Row당 평균 크기 계산

```sql
-- Row 크기가 예상보다 2배 이상이면 Page Split 의심
SELECT
  table_name,
  ROUND(data_length / table_rows, 2) AS avg_row_size,
  CASE
    WHEN data_length / table_rows > 500 THEN '⚠️ 크기 확인 필요'
    ELSE '✅ 정상'
  END AS status
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_rows > 0
ORDER BY avg_row_size DESC;
```

### Step 3: Page Split 현황

```sql
-- Page Split 카운터 확인
SELECT
  NAME,
  COUNT,
  CASE
    WHEN NAME = 'index_page_splits' AND COUNT > 10000 THEN '⚠️ Split 과다'
    ELSE '✅ 정상'
  END AS status
FROM INFORMATION_SCHEMA.INNODB_METRICS
WHERE NAME IN (
  'index_page_splits',
  'index_page_merge_attempts',
  'index_page_merge_successful'
);
```

### Step 4: Buffer Pool vs 인덱스 크기

```sql
-- Buffer Pool 크기
SELECT VARIABLE_VALUE / 1024 / 1024 / 1024 AS buffer_pool_gb
FROM performance_schema.global_variables
WHERE VARIABLE_NAME = 'innodb_buffer_pool_size';

-- 인덱스 총 크기
SELECT ROUND(SUM(index_length) / 1024 / 1024 / 1024, 2) AS total_index_gb
FROM information_schema.tables
WHERE table_schema = DATABASE();

-- 결과: index_gb > buffer_pool_gb 이면 UUID 재앙 위험!
```

> 💡 **Action Items**
>
> 위 쿼리 실행 후:
> - [ ] PK 타입이 VARCHAR(36)인 테이블 확인
> - [ ] Page Split > 10,000인 테이블 리스트업
> - [ ] Buffer Pool < 인덱스 크기인 경우 확장 검토
> - [ ] UUID v4 → ULID/UUIDv7 마이그레이션 계획 수립

---

## 마치며

처음에 던졌던 질문으로 돌아가봅시다.

> "왜 데이터가 쌓일수록 INSERT가 느려졌을까?"

이제 답할 수 있습니다:

1. **UUID v4의 랜덤성**으로 B+-tree 전체에 삽입 분산
2. **Page Split 폭발**로 I/O 3배 증가
3. **Buffer Pool 경쟁**으로 디스크 접근 급증
4. **50% Page Fill**로 공간 낭비

**핵심 원칙:**

| 상황 | 권장 ID 타입 |
|------|-------------|
| 단일 DB, 최고 성능 | Auto Increment (BIGINT) |
| 분산 시스템, 64-bit | Snowflake ID |
| UUID 호환 필요 | UUIDv7 |
| 문자열 정렬 필요 | ULID |
| **절대 금지** | **UUIDv4** |

다음 글에서는 **MySQL 쿼리 최적화: Execution Plan 완벽 분석**을 다루겠습니다. 같은 쿼리라도 EXPLAIN 결과를 어떻게 해석하느냐에 따라 10배 이상 성능 차이가 날 수 있습니다.

---

## 참고자료

### MySQL 공식 문서
- [MySQL 8.0 Reference Manual - The Physical Structure of an InnoDB Index](https://dev.mysql.com/doc/refman/8.4/en/innodb-physical-structure.html)
- [MySQL 8.0 Reference Manual - Sorted Index Builds](https://dev.mysql.com/doc/refman/8.4/en/sorted-index-builds.html)
- [MySQL 8.0 Reference Manual - Multiple-Column Indexes](https://dev.mysql.com/doc/en/multiple-column-indexes.html)
- [MySQL 8.0 Reference Manual - Configuring the Merge Threshold](https://dev.mysql.com/doc/refman/8.0/en/index-page-merge-threshold.html)
- [MySQL Worklog - InnoDB: make fill factor settable](https://dev.mysql.com/worklog/task/?id=6747)

### 기술 블로그
- [Jeremy Cole - B+Tree index structures in InnoDB](https://blog.jcole.us/2013/01/10/btree-index-structures-in-innodb/)
- [PlanetScale - The Problem with Using a UUID Primary Key in MySQL](https://planetscale.com/blog/the-problem-with-using-a-uuid-primary-key-in-mysql)
- [PlanetScale - B-trees and database indexes](https://planetscale.com/blog/btrees-and-database-indexes)
- [PlanetScale - Composite indexes](https://planetscale.com/learn/courses/mysql-for-developers/indexes/composite-indexes)
- [MySQL.rjweb.org - UUID Performance Breakthrough](https://mysql.rjweb.org/doc.php/uuid)

### 분산 ID 생성 전략
- [Instagram Engineering - Sharding & IDs at Instagram](https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c)
- [Flickr Engineering - Ticket Servers: Distributed Unique Primary Keys on the Cheap](https://code.flickr.net/2010/02/08/ticket-servers-distributed-unique-primary-keys-on-the-cheap/)
- [Shopify Engineering - How to Introduce Composite Primary Keys in Rails](https://shopify.engineering/how-to-introduce-composite-primary-keys-in-rails)
- [Stripe - Object IDs Gist](https://gist.github.com/fnky/76f533366f75cf75802c8052b577e2a5)

### UUID/ULID 표준
- [IETF RFC 9562 - UUIDv7 Specification](https://www.rfc-editor.org/rfc/rfc9562.html)
- [ULID Specification](https://github.com/ulid/spec)
- [Twitter Snowflake - GitHub Archive](https://github.com/twitter-archive/snowflake)

### 성능 분석
- [Vlad Mihalcea - Clustered Index](https://vladmihalcea.com/clustered-index/)
- [Percona - MySQL InnoDB Sorted Index Builds](https://www.percona.com/blog/mysql-innodb-sorted-index-builds/)
- [MinervaDB - How InnoDB Fill Factor Affects MySQL Performance](https://minervadb.xyz/how-innodb-fill-factor-affect-mysql-performance/)
