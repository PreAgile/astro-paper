---
author: 김면수
pubDatetime: 2026-05-04T12:00:00.000Z
title: "JPA N+1 + JOIN FETCH 깊이 함정 4종 — MultipleBagFetchException, Pagination OOM, OneToOne LAZY 트랩"
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
  4-depth 도메인 (owner→merchant→rule→history) 에서 findAll() + 자식 접근하면 21 SQL. JOIN FETCH 한 단계로 1 SQL. 단 *두 collection 동시 fetch* 면 MultipleBagFetchException — Hibernate 가 List(Bag) 두 개의 cartesian product 를 거부. *JOIN FETCH + setMaxResults* 면 HHH000104 경고 + in-memory pagination — 1만 row 다 읽고 20개만 남기는 OOM. *@OneToOne non-owning LAZY* 는 프록시가 null 인지 알 방법이 없어서 *항상 fetch* — LAZY 무시. @BatchSize 가 N+1 → N/K+1 으로 완화하는 표준 처방. JPA 의 fetch 함정은 기능 한 줄이 아니라 *Bag/List/Set + 프록시 메커니즘 + Hibernate 의 cartesian 처리 정책* 의 상호작용입니다.
---

## Table of contents

## 들어가며 {#intro}

JPA 면접의 단골 질문 — **"N+1 어떻게 해결해요?"**. 답이 너무 잘 알려져 있어서 *오히려 깊이* 가 갈리는 영역.

기본 답: "JOIN FETCH 또는 @EntityGraph 쓰면 됩니다". 맞는 말. 그런데 시니어 면접관은 보통 거기서 *꼬리 질문*:
- *두 collection* 을 동시에 JOIN FETCH 하면 어떻게 되나요?
- JOIN FETCH 에 페이지네이션 (`setMaxResults`) 붙이면요?
- `@OneToOne(LAZY)` 가 *진짜로 LAZY 인 케이스* 와 *항상 fetch 되는 케이스* 의 차이는요?

이 세 질문에 답할 수 있어야 *시니어 깊이*. 본 글은 4-depth 도메인 (owner → merchant → rule → history) 에서 *모든 함정을 한 번에* 측정한 기록입니다.

---

## 1. 4-depth 도메인 — 의도적으로 깊게 {#domain}

```
MerchantOwner (사장님)
    └─ OneToMany ─→ Merchant (매장)
                          └─ OneToMany ─→ AutoReplyRuleN1 (자동 응답 룰)
                                                └─ OneToMany ─→ ReplyHistory (답글 이력)
                                                                      └─ OneToOne mappedBy ─→ ReplyHistoryMetadata
```

20 owner × 5 merchant/owner × 3 rule/merchant × 4 history/rule = 1,200 history. 적당히 크면서 측정하기 좋은 사이즈.

---

## 2. S1 baseline — N+1 직접 재현 {#s1-baseline}

```java
@Transactional(readOnly = true)
public void s1NPlusOne() {
    List<MerchantOwner> owners = ownerRepo.findAll();   // 1 SQL
    for (MerchantOwner o : owners) {
        for (Merchant m : o.getMerchants()) {            // ← LAZY trigger — 1 SQL/owner
            for (AutoReplyRuleN1 r : m.getRules()) {     // ← LAZY trigger — 1 SQL/merchant
                // ...
            }
        }
    }
}
```

기대 SQL 수: 1 (owners) + 20 (merchants per owner) + 100 (rules per merchant) = **121 SQL**.

→ 운영에선 사장님 100 명, 매장 1000 개, 룰 5000 개면 *수천 SQL* 한 번 호출에 발사.

**[실측 — Java/Spring Stage 2 / 2026-05-09 23:21~22 KST 재측정]** 20 owner × 5 merchant × 3 rule × 4 history 도메인. *동일 코드를 두 번 실행* — `application.yml` 의 `hibernate.default_batch_fetch_size` 한 줄을 토글:

**Run A — `default_batch_fetch_size` OFF (기본):**

| Scenario | prepStmts | queries | rows | aux | elapsedMs |
|---|---:|---:|---:|---:|---:|
| **S1 N+1 baseline** | **121** | 1 | 20 | 300 | **86** |
| S2 JOIN FETCH 1-level | **1** | 1 | 20 | 100 | **7** (12x 빠름) |
| S3 MultipleBagFetchException | (예외) | — | — | — | — |
| **S4 `@OneToOne` non-owning LAZY** | **1201** | 1 | 1200 | 0 | **282** |
| S5 JOIN FETCH + Pagination (HHH000104) | 1 | 1 | 5 | 0 | 6 |
| S6 (S1 과 동일 코드) | **121** | 1 | 20 | 300 | 31 |

**Run B — `default_batch_fetch_size: 10`:**

| Scenario | prepStmts | Δ vs Run A |
|---|---:|---|
| S1 / S6 (동일 코드) | **13** | **-9.3x** (1 + ⌈20/10⌉ + ⌈100/10⌉ = 1 + 2 + 10) |
| S2 / S3 / S5 | 동일 | (영향 없음) |
| **S4 `@OneToOne` non-owning LAZY** | **1201** | **변화 없음 — 새 발견 ★** |

> S1 의 121 prep 분해: **1 main + 20 (owners→merchants) + 100 (merchants→rules) = 121** — 본 측정은 4-depth 도메인의 *3-depth traversal* (history 까지 안 들어감). 깊이마다 multiplicative 증가. S4 `@OneToOne` non-owning LAZY 는 metadata 변수를 안 써도 1200x 추가 SELECT (null 확인용). **★ 더 중요한 발견 — S4 의 1201 prep 는 `default_batch_fetch_size` 켜도 변화 없음.** "JPA 면접에 batch_fetch_size 한 줄로 답하면 통과" 가 *반쪽 답* 이라는 직접 증거. ToOne LAZY 의 프록시 한계는 collection batch 메커니즘 밖이다 (자세한 이유는 §6).

---

## 3. S2 — JOIN FETCH 한 단계 {#s2-join-fetch}

```java
@Query("SELECT DISTINCT o FROM MerchantOwner o LEFT JOIN FETCH o.merchants")
List<MerchantOwner> findAllJoinFetchMerchants();
```

생성 SQL:

```sql
SELECT DISTINCT o.*, m.* FROM merchant_owner o LEFT JOIN merchant m ON m.owner_id = o.id
```

owner + merchants 한 SQL 로 끝. **1 SQL**.

`DISTINCT` 의 역할: cartesian product 로 *중복 owner row* 가 생겨서 중복 제거. JPA 의 DISTINCT 는 *Java 객체 수준* — Hibernate 6 부터는 자동 deduplication 이라 명시 불필요한 케이스도 있지만 안전망.

---

## 4. S3 — `MultipleBagFetchException` (한 entity 의 두 collection 동시 fetch) {#s3-multi-bag}

```java
@Query("SELECT DISTINCT m FROM Merchant m "
        + "LEFT JOIN FETCH m.rules r "
        + "LEFT JOIN FETCH m.owner.merchants")  // owner.merchants 도 collection
List<Merchant> findAllTwoBags();
```

실행 시:

```
org.hibernate.loader.MultipleBagFetchException:
cannot simultaneously fetch multiple bags: [m.rules, owner.merchants]
```

### 4.1 왜 이게 거부되는가

Hibernate 가 `List` 를 *Bag* (= 순서 없는 collection) 으로 봄. 두 Bag 을 *동시에* JOIN FETCH 하면 — cartesian product 의 row 수가 모호.

예:
- Merchant A 가 rules 3개, owner.merchants 가 5개
- JOIN FETCH 로 한 row 당 3 × 5 = 15 row 반환
- Hibernate 가 *어느 row 가 어느 collection 의 어느 element 인지* 매핑하기 위해선 **순서 보장** 또는 **DISTINCT 키** 필요
- Bag (= 순서 없는 List) 은 둘 다 없음 → 거부

### 4.2 해결법

**(a) `Set` 으로 바꿈** — Hibernate 가 자동 DISTINCT:

```java
@OneToMany(mappedBy = "merchant")
private Set<AutoReplyRuleN1> rules = new HashSet<>();
```

단 Set + JPA 의 *equals/hashCode* 함정 (이전 시리즈 글에서 다룬) 이 따라옴. *id 기반 equals* 가 transient 단계에서 깨짐.

**(b) JOIN FETCH 를 *한 번에 한 collection 만*** — 다른 collection 은 별도 SELECT:

```java
@Query("SELECT m FROM Merchant m LEFT JOIN FETCH m.rules WHERE m.id IN :ids")
List<Merchant> findRules(...);

@Query("SELECT m FROM Merchant m LEFT JOIN FETCH m.owner.merchants WHERE m.id IN :ids")
List<Merchant> findOwnerMerchants(...);
```

**(c) `@BatchSize` + 두 collection 모두 LAZY** — 한 collection 만 JOIN FETCH, 다른 건 batch fetch:

```java
@OneToMany @BatchSize(size = 10)
private List<AutoReplyRuleN1> rules;
```

[Vlad Mihalcea — Hibernate MultipleBagFetchException](https://vladmihalcea.com/hibernate-multiplebagfetchexception/) 가 세 옵션을 비교.

---

## 5. S5 — `JOIN FETCH` + Pagination 의 메모리 OOM {#s5-pagination-oom}

```java
@Query("SELECT DISTINCT o FROM MerchantOwner o LEFT JOIN FETCH o.merchants")
List<MerchantOwner> findAllJoinFetchPaging(Pageable pageable);
```

`Pageable.of(0, 5)` 로 5 owner 만 가져오고 싶다? 실행해보면:

```
WARN  o.h.h.internal.ast.QueryTranslatorImpl :
HHH000104: firstResult/maxResults specified with collection fetch; applying in memory!
```

### 5.1 왜 메모리에서 paging 되는가 — 코드 트레이스

20 owner × 5 merchant 도메인에서 `Pageable.of(0, 5)` 로 *5 owner 만* 받고 싶다고 가정.

#### ❌ 만약 Hibernate 가 LIMIT 을 그대로 붙였다면 (가상 시나리오)

```sql
SELECT o.*, m.* FROM merchant_owner o
LEFT JOIN merchant m ON m.owner_id = o.id
ORDER BY o.id LIMIT 5;
```

생성되는 row:

| row # | o.id | m.id | 설명 |
|---:|---:|---:|---|
| 1 | 1 | 11 | owner 1 의 1 번째 merchant |
| 2 | 1 | 12 | owner 1 의 2 번째 |
| 3 | 1 | 13 | owner 1 의 3 번째 |
| 4 | 1 | 14 | owner 1 의 4 번째 |
| 5 | 1 | 15 | owner 1 의 5 번째 |

→ **1 owner 만 반환됨** (요청한 5 owner 와 전혀 다름). 더 나쁜 경우: owner 1 의 merchants 가 3 개라면 row 4 부터 owner 2 의 merchants 로 넘어가 *5 row 안에 owner 2 의 5 merchants 중 2 개만* — *잘린 자식*. 데이터 일관성 자체 깨짐.

#### ✅ Hibernate 의 실제 fallback

```sql
-- Hibernate 가 실제로 발사 — LIMIT 없음
SELECT o.*, m.* FROM merchant_owner o
LEFT JOIN merchant m ON m.owner_id = o.id
ORDER BY o.id;
```

```java
// Hibernate 의 내부 흐름 (의사 코드):
List<Object[]> rawRows = jdbc.executeQuery(sqlWithoutLimit);  // 100 row 모두 hydrate
List<MerchantOwner> allOwners = dedupByOwnerId(rawRows);      // 메모리 dedup → 20 owner
return allOwners.subList(0, 5);                               // ★ 메모리에서 paging
```

→ 결과는 *정확히 5 owner* 지만 *100 row 가 메모리를 거쳐감*. **정확성을 메모리 비용으로 산 셈**. WARN `HHH90003004` 가 이 fallback 의 신호.

### 5.2 운영의 OOM 시나리오 — 도메인 크기에 따른 위험도

| 시나리오 | 부모 N | 자식/부모 M | cartesian (N×M) | heap 영향 |
|---|---:|---:|---:|---|
| 본 EXP (S5) | 20 | 5 | 100 | 무시 (rows=5 만 보임) |
| 작은 운영 | 1,000 | 5 | 5,000 | 수 MB, 무해 |
| 중간 운영 | 10,000 | 5 | 50,000 | 수십 MB, latency ↑ |
| 큰 운영 | 10,000 | 50 | **500,000** | **OOM 위험권** |
| Worst | 100,000 | 100 | **10,000,000** | **OOM 확정** |

→ 페이지 사이즈가 *고작 20* 이라도 cartesian 의 모든 row 가 *한 번에 메모리에* 올라감. **조용한 OOM** — 평소엔 잘 돌다가 광고주 / 매장이 늘면 갑자기 5xx.

### 5.3 해결법

**(a) parent 만 paging**, 자식은 *별도 쿼리* + `IN`:

```java
// 1. owners 만 paging
List<Owner> owners = ownerRepo.findAll(pageable);

// 2. owners 의 id 로 merchants 조회
List<Long> ownerIds = owners.stream().map(Owner::getId).toList();
List<Merchant> merchants = merchantRepo.findByOwnerIdIn(ownerIds);

// 3. 메모리에서 group by — Hibernate 의 1차 캐시 활용
```

**(b) `@BatchSize` + paging** — owner 만 paging 한 후 자식은 batch fetch:

```java
@OneToMany @BatchSize(size = 10)
private List<Merchant> merchants;
```

이 두 옵션이 표준. JOIN FETCH + paging 은 *절대 같이 쓰면 안 됨*.

[Vlad Mihalcea — Hibernate HHH000104 Fix](https://vladmihalcea.com/fix-hibernate-hhh000104-entity-fetch-pagination-warning-message/) 가 2 패턴 비교.

---

## 6. S4 — `@OneToOne` LAZY 의 프록시 한계 {#s4-onetoone-lazy}

```java
@Entity
class ReplyHistory {
    @OneToOne(mappedBy = "history", fetch = FetchType.LAZY)  // ← LAZY 인데...
    private ReplyHistoryMetadata metadata;
}

@Entity
class ReplyHistoryMetadata {
    @OneToOne @JoinColumn(name = "history_id")
    private ReplyHistory history;
}
```

`historyRepo.findAll()` 했을 때 — `metadata` 가 LAZY 라서 fetch 안 될 줄 아는데, 실제로는 **ReplyHistory 마다 metadata SELECT 가 발사**.

### 6.1 왜?

Hibernate 의 `@OneToOne` LAZY 는 *owning side* (= `@JoinColumn` 가진 쪽) 에선 정상 동작 — FK 가 null 인지 알 수 있어서 *프록시* 만들면 됨.

*non-owning side* (= `mappedBy` 쪽) 에선 — *FK 가 entity 에 없음*. metadata 가 *존재하는지* / *null 인지* 알려면 *반대 쪽 테이블 SELECT* 필요. Hibernate 가 *값을 set 하기 위해* 미리 SELECT — LAZY 의도 무시.

### 6.2 [실측 — 새 발견 ★] `default_batch_fetch_size` 로도 못 풀린다

S4 의 1201 prep 는 `default_batch_fetch_size: 10` 켠 Run B 에서도 **여전히 1201**. 이유:

- **collection LAZY** (OneToMany / ManyToMany): Hibernate 가 컬렉션을 PersistentBag/PersistentSet 으로 wrap. 첫 접근 시 트리거되며, batch fetch 가 활성이면 *같은 깊이의 다른 부모 ID 들* 을 모아 IN 절로 한 번에 fetch — *batch 효과 적용*
- **ToOne LAZY** (OneToOne / ManyToOne): 프록시 객체. 프록시는 "null 인지 여부" 를 알아야 하는데 — non-owning side 에선 FK 가 *반대 테이블* 에 있어서 *각 row 시점*에 SELECT 한 번. *batch 로 묶을 기회 없음*

→ batch_fetch_size 는 *collection LAZY 트리거의 IN-clause 묶음* 이지 *각 row 단위로 발사되는 ToOne SELECT* 와는 무관. **이게 본 글의 핵심 — N+1 이라는 한 단어 뒤에 *서로 다른 메커니즘 두 개* 가 있음**.

### 6.3 해결법

**(a) `@MapsId` + owning side 에서 PK = FK** — 1:1 의 정통 매핑:

```java
@Entity
class ReplyHistoryMetadata {
    @Id Long id;     // = history.id
    @MapsId @OneToOne(fetch = LAZY) @JoinColumn(name = "id") ReplyHistory history;
}
```

이러면 ReplyHistory 쪽엔 metadata 매핑 *생략* — 단방향. metadata 는 LAZY proxy.

**(b) Bytecode Enhancement** — `LazyToOneOption.NO_PROXY` 사용:

```java
@OneToOne(mappedBy = "history", fetch = LAZY)
@LazyToOne(LazyToOneOption.NO_PROXY)
private ReplyHistoryMetadata metadata;
```

단 Bytecode Enhancement gradle plugin 추가 필요.

[Vlad Mihalcea — Hibernate OneToOne LAZY](https://vladmihalcea.com/hibernate-one-to-one-lazy-not-working/) 가 두 옵션 비교.

---

## 7. S6 — `@BatchSize` / `default_batch_fetch_size` 의 N/K+1 효과 {#s6-batch-size}

본 EXP 의 S6 는 **S1 과 *완전히 동일한 코드***. 차이는 application.yml 한 줄:

```yaml
spring.jpa.properties.hibernate:
  default_batch_fetch_size: 10   # ★ 명시적으로 켜야 동작 (Hibernate 기본값은 -1 = off)
```

3-depth traversal 기준:

```sql
-- Run A (config OFF) — N+1 baseline:
SELECT * FROM merchant_owner;                              -- 1
SELECT * FROM merchant WHERE owner_id = ?;                 -- 20 번
SELECT * FROM auto_reply_rule_n1 WHERE merchant_id = ?;    -- 100 번
-- = 121 SQL

-- Run B (default_batch_fetch_size: 10):
SELECT * FROM merchant_owner;                              -- 1
SELECT * FROM merchant WHERE owner_id IN (?,?,...,?);      -- 2 번 (20/10)
SELECT * FROM auto_reply_rule_n1 WHERE merchant_id IN (?,?,...,?);  -- 10 번 (100/10)
-- = 13 SQL
```

→ **121 → 13 (9.3x 감소)**. 코드 한 줄 안 고치고 application.yml 한 줄 추가만. 이게 *전역 안전망* 으로서 batch_fetch_size 의 가치.

### 7.1 step-by-step — Hibernate 의 batch fetch 메커니즘

`default_batch_fetch_size: 10` 켜진 상태에서 page 20 owner 를 forEach 하면 어떻게 *13 SQL* 로 끝나는지 영속성 컨텍스트 변화로 풀어봄.

#### 1:N 의 DB row 분포

```
merchant_owner (20 row)               merchant (100 row, 5/owner)
┌────┬──────────┐                     ┌────┬──────────┬──────────┐
│ id │ name     │                     │ id │ name     │ owner_id │
├────┼──────────┤                     ├────┼──────────┼──────────┤
│  1 │ owner-1  │ ─┐                  │  1 │ m-1-0    │    1     │ ◄┐
│  2 │ owner-2  │  │                  │  2 │ m-1-1    │    1     │ ◄┤  owner=1
│ ...│ ...      │  │   1:N            │ ...│ ...      │   ...    │ ◄┤  의 5 m
│ 20 │ owner-20 │ ─┘                  │  5 │ m-1-4    │    1     │ ◄┘
└────┴──────────┘                     │ ...│ ...      │   ...    │
                                      │100 │ m-20-4   │   20     │
                                      └────┴──────────┴──────────┘
```

#### Step 1: parent paging — 영속성 컨텍스트 초기 상태

```sql
-- 발사 SQL #1
SELECT * FROM merchant_owner ORDER BY id LIMIT 20;
```

```
PersistenceContext (1차 캐시):
  owner#1  → merchants: ⏳ PersistentBag (NOT initialized)
  owner#2  → merchants: ⏳ PersistentBag (NOT initialized)
  ...
  owner#20 → merchants: ⏳ PersistentBag (NOT initialized)
```

→ 20 owner hydrate, 각 merchants 자리에는 *아직 비어있는 PersistentBag* 만 끼움. merchant 테이블 SQL 미발사.

#### Step 2: forEach 첫 iteration → owner#1 LAZY trigger

`owner#1.getMerchants().size()` 호출. Hibernate 의 batch 결정 로직:

```
1. owner#1 의 merchants 가 필요해짐
2. 영속성 컨텍스트의 *다른 미초기화 PersistentBag* 본다 → owner#2..#20 (19 개)
3. batch_size = 10 → owner#1 + 9 개 더 묶음 → owner_id ∈ {1, 2, 3, ..., 10}
4. IN 절 SQL 한 번 발사 → 10 owner 의 merchants 모두 hydrate
```

```sql
-- 발사 SQL #2
SELECT * FROM merchant WHERE owner_id IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
```

→ **owner#1 만 필요했는데도 10 owner 의 merchants 한 번에 fetch**. 이게 batch 의 핵심 — *현재 + 곧 필요할 것* 을 같이 미리 (look-ahead).

```
PersistenceContext 변화:
  owner#1..#10 → merchants: ✅ hydrated (1~10 batch)
  owner#11..#20 → merchants: ⏳ NOT initialized
```

#### Step 3~10: owner#2..#10 — 모두 cache hit

```java
owner#2.getMerchants().size();   // ✅ 이미 hydrated → SQL 안 나감
...
owner#10.getMerchants().size();  // ✅ 같음
```

#### Step 11: owner#11 → 새 batch

```sql
-- 발사 SQL #3
SELECT * FROM merchant WHERE owner_id IN (11, 12, ..., 20);
```

#### Step 12~20: 모두 cache hit

#### 결과

| Step | SQL |
|---|---:|
| parent paging | 1 |
| owner#1 trigger → batch (1..10) | 1 |
| owner#2..#10 cache hit | 0 |
| owner#11 trigger → batch (11..20) | 1 |
| owner#12..#20 cache hit | 0 |
| **합계** | **3** |

공식: **1 + ⌈N/K⌉**. 본 EXP 의 3-depth (rules 까지) 까지 가면 1 + 2 + 10 = **13 SQL** — §7 측정값과 일치.

**핵심**:
- application 코드 0 변경 — `o.getMerchants()` 호출 패턴 그대로
- 첫 trigger 후 모든 호출 cache hit
- forEach 순서 무관 — 어떤 owner 든 첫 trigger 가 batch 발동
- cartesian 위험 zero (IN 절은 row 곱 없음)

### 7.2 batch fetch 가 못 푸는 N+1

단 (§6.2 측정) **OneToOne non-owning LAZY 함정에는 안 먹힘** — 이걸 함께 푸는 건 @MapsId 만 가능. 한 줄 처방으론 부족하다는 게 본 EXP 의 메시지.

---

## 7.5 자주 헷갈림 — DTO projection vs `@Transactional(readOnly = true)` {#dto-vs-readonly}

이 둘은 *완전 다른 차원* — 같이 써야 하지만 *서로 풀어주는 문제가 다름*.

| | DTO projection | `@Transactional(readOnly = true)` |
|---|---|---|
| **차원** | *결과 객체의 종류* — entity vs POJO | *트랜잭션의 모드* — flush/snapshot 옵션 |
| **푸는 문제** | N+1 / fetch plan 함정 자체 | dirty checking snapshot 비용 |
| **LAZY 트리거** | ❌ 불가능 (proxy 자체가 안 만들어짐) | ✅ 발생함 (entity 그대로) |

**본 EXP 의 직접 증거** — S1 코드는 *이미 `@Transactional(readOnly = true)`* 인데도 121 prep N+1 그대로 발생:

```java
@Transactional(readOnly = true)         // ← 이미 readOnly!
public Stats s1NPlusOne() {
    List<MerchantOwner> owners = ownerRepo.findAllNoFetch();
    for (MerchantOwner o : owners) {
        for (Merchant m : o.getMerchants()) {       // ← LAZY trigger
            sumRules += m.getRules().size();
        }
    }
}
```

→ **readOnly 는 fetch 측 함정에 대해 아무것도 안 해줌**.

### 7.5.1 `@Transactional(readOnly = true)` 가 하는 일

1. `FlushMode.MANUAL` → 자동 flush 안 일어남 (`INSERT/UPDATE/DELETE` 차단)
2. **★ snapshot 안 뜸** — entity hydrate 시 원본 복사본 안 만듦. dirty checking 비용 0 (W4 P2 EXP-13 측정 132×)
3. DB 드라이버에 read-only hint 전달

남아있는 것 (= 못 푸는 것):
- ✅ entity 그대로 hydrate, proxy 살아있음
- ✅ LAZY trigger 가능 → **N+1 함정 그대로**
- ✅ JOIN FETCH / paging / MultipleBag / OneToOne LAZY 함정 모두 그대로

### 7.5.2 DTO projection 이 하는 일

1. POJO 생성자에 직접 매핑 → proxy 자체를 안 만듦
2. 영속성 컨텍스트 등록 안 함 — 1차 캐시 비용 0
3. snapshot 비용 0 (readOnly 와 같은 효과)
4. **★ proxy 가 없으므로 LAZY trigger 자체 불가능** → N+1 함정 *원리적* 차단

### 7.5.3 항목별 비교

| 차원 | DTO projection | readOnly | 둘 다 |
|---|---|---|---|
| dirty checking snapshot 비용 | ✅ 우회 | ✅ 절감 | ✅ |
| LAZY 트리거 → N+1 | ✅ 불가능 | ❌ **그대로 발생** | ✅ 불가능 |
| MultipleBagFetchException | ✅ 우회 | ❌ 그대로 | ✅ 우회 |
| HHH000104 paging OOM | ✅ 우회 | ❌ 그대로 | ✅ 우회 |
| @OneToOne LAZY 1201 prep | ✅ 우회 | ❌ 그대로 | ✅ 우회 |
| flush 차단 | (entity 아님) | ✅ | ✅ |
| entity 메서드 / cascade | ❌ 못 씀 | ✅ | ❌ |

### 7.5.4 실무 — 같이 쓰는 게 정석

```java
@Transactional(readOnly = true)              // ← snapshot 절감 (W4 P2 132×)
public List<OwnerSummaryDto> summaries() {
    return ownerRepo.findOwnerSummaries();   // ← DTO projection (N+1 zero)
}
```

→ 두 도구의 *작용 지점이 다름*. readOnly 는 *write 측* (snapshot/flush) 비용을 풀고, DTO projection 은 *read 측* (proxy/LAZY/캐시) 함정을 푼다. **"readOnly 켜면 N+1 풀려요" 는 틀린 답** — S1 의 121 prep 가 직접 증거.

---

## 7.6 Deep hierarchy — *dedicated 한 방 쿼리* (QueryDSL / DTO projection) {#deep-hierarchy-dedicated}

`@BatchSize` chain (§7.1) 은 *generic entity traversal* 의 안전망이지 *모든 deep hierarchy 의 정답* 은 아님. **명확한 화면 / API endpoint 가 deep hierarchy 를 요구하면 *전용 쿼리 한 방* 이 정석**. §8.2 의 *기업 패턴 A* (Naver / Kakao 류 — write JPA + read QueryDSL/jOOQ) 가 이 원칙의 제도화.

### 7.6.1 4-depth 한 방 쿼리 옵션 4 가지

#### (A) JPQL `JOIN FETCH` (entity) — *깊이 한계*

```java
@Query("""
    SELECT DISTINCT o FROM MerchantOwner o
    LEFT JOIN FETCH o.merchants m
    LEFT JOIN FETCH m.rules
""")
List<MerchantOwner> findOwnersWithMerchantsAndRules();
```

❌ **`m.rules` 도 List → MultipleBagFetchException** (Hibernate 6 startup HQL 검증). `Set` 으로 바꿔도 cartesian = 20×5×3 = **300 row** + history 까지 = **1,200 row** → result hydration 비용 폭증, paging 불가. → entity JOIN FETCH 는 *깊이 1, 잘해야 2* 까지가 한계.

#### (B) JPQL DTO projection (★) — depth 무한, 모든 함정 우회

```java
public record OwnerHierarchyRow(
    Long ownerId, String ownerName,
    Long merchantId, String merchantName,
    Long ruleId, String keyword,
    Long historyId, String matchedText
) {}

@Query("""
    SELECT new com.example.OwnerHierarchyRow(
        o.id, o.name,
        m.id, m.name,
        r.id, r.keyword,
        h.id, h.matchedText
    )
    FROM MerchantOwner o
    LEFT JOIN o.merchants m
    LEFT JOIN m.rules r
    LEFT JOIN r.histories h
    WHERE o.id IN :ownerIds
    ORDER BY o.id, m.id, r.id, h.id
""")
List<OwnerHierarchyRow> findHierarchy(@Param("ownerIds") List<Long> ownerIds);
```

발사 SQL — **1 SQL**:
```sql
SELECT o.id, o.name, m.id, m.name, r.id, r.keyword, h.id, h.matched_text
FROM merchant_owner o
LEFT JOIN merchant m ON m.owner_id = o.id
LEFT JOIN auto_reply_rule_n1 r ON r.merchant_id = m.id
LEFT JOIN reply_history h ON h.rule_id = r.id
WHERE o.id IN (?, ?, ...)
ORDER BY o.id, m.id, r.id, h.id;
```

→ 1200 row flat. **proxy / entity 자체가 안 만들어지므로**:
- ✅ MultipleBagFetchException 우회
- ✅ N+1 zero (proxy 없음)
- ✅ paging 가능 (parent 만 paginate 후 IN)
- ✅ snapshot / 1차 캐시 비용 0

#### (C) QueryDSL DTO projection (★★) — type-safe + dynamic

```java
public List<OwnerHierarchyRow> findHierarchy(List<Long> ownerIds, String keywordPrefix) {
    return queryFactory
        .select(Projections.constructor(OwnerHierarchyRow.class,
            owner.id, owner.name,
            merchant.id, merchant.name,
            rule.id, rule.keyword,
            history.id, history.matchedText))
        .from(owner)
        .leftJoin(owner.merchants, merchant)
        .leftJoin(merchant.rules, rule)
        .leftJoin(rule.histories, history)
        .where(
            owner.id.in(ownerIds),
            keywordPrefix == null ? null : rule.keyword.startsWith(keywordPrefix)  // ← 동적
        )
        .orderBy(owner.id.asc(), merchant.id.asc(), rule.id.asc(), history.id.asc())
        .fetch();
}
```

JPQL 대비 장점: ✅ type-safe (컴파일 타임 컬럼 참조) ✅ 동적 where ✅ 리팩토링 안전. 한국 빅테크가 *read 측에 QueryDSL 채택* 하는 이유 — 화면별 조건 다양성이 큰 read 에 가장 자연스러움.

#### (D) Native SQL — *특수 case* (window function / CTE / 복잡 집계)

`GROUP BY`, window function, CTE 같은 *RDBMS 고유 기능* 필요할 때.

### 7.6.2 SQL 수 비교 — 4-depth 1200 row 기준

| 전략 | SQL 수 | round-trip | hydration |
|---|---:|---|---|
| N+1 baseline | 421 | 421× | entity proxy 1200 |
| All `@BatchSize=10` cascading IN | 43 | 43× | entity proxy 1200 |
| **JPQL DTO 한 방** | **1** | **1×** | flat 1200 row |
| **QueryDSL DTO 한 방** | **1** | **1×** | flat 1200 row |
| JPQL JOIN FETCH 2+ depth | (예외) | — | — |

→ DTO multi-JOIN 한 방 쿼리가 round-trip *압도적*. 1× vs 43× 의 차이는 *DB 가 멀리 있으면* latency 가 수십 배.

### 7.6.3 두 축 의사결정 — entity/DTO × JPQL/QueryDSL

DTO projection 자체는 JPQL 로도 QueryDSL 로도 가능. 두 축이 독립.

| | JPQL string | QueryDSL builder |
|---|---|---|
| **entity 반환** | `@Query("SELECT o FROM ... JOIN FETCH ...")` | `selectFrom(o).leftJoin(...)` |
| **DTO 반환** | `@Query("SELECT new com.x.Dto(...)")` ★ | `Projections.constructor(Dto.class, ...)` ★★ |

축 1 (반환 타입):
- **entity** → BatchSize 동작, dirty checking 가능, *but 함정 (MultipleBag / paging) 잔존*
- **DTO** → proxy 없음, 모든 함정 우회, *but cascade / dirty checking 못 씀*

축 2 (작성 도구):
- **JPQL** → 짧음, 정적 — 단순 화면에 충분
- **QueryDSL** → type-safe, 동적 where 강함 — 복잡 / 동적 화면에 정석

### 7.6.4 세 갈래 운영 default

한 운영 코드베이스에서 *세 갈래가 공존*. 화면 / endpoint 별 결정.

| 상황 | 처방 |
|---|---|
| 명시적 화면 / API + 동적 조건 | **QueryDSL DTO projection** (1순위) |
| 명시적 화면 / API + 정적 조건 | **JPQL DTO projection** (보일러플레이트 적음) |
| Generic traversal (백오피스 / 도메인 메서드) | **entity + `default_batch_fetch_size: 10`** (안전망) |
| 통계 / 집계 | **Native SQL** |
| Write 트랜잭션 | **entity** (dirty checking + cascade) |

**의사결정 한 줄**:
- *"이 deep hierarchy 가 화면 / API 단위로 명확한가?"* → YES → **DTO + (QueryDSL or JPQL)** 한 방
- *NO, generic entity traversal 임* → **entity + BatchSize chain**

---

## 8. 운영 룰 — Vlad 5 계명 + 기업 4 패턴 + 결정 트리 {#operational-rules}

### 8.1 Vlad Mihalcea 의 5 계명

[Vlad Mihalcea](https://vladmihalcea.com/) — Hibernate 의 most active 외부 contributor. 그의 블로그가 *현실적인 Hibernate 사용법* 의 사실상 표준. 5 계명을 본 EXP 의 시나리오와 매핑하면:

| # | 계명 | 본 EXP 의 시연 |
|---|---|---|
| 1 | `FetchType.EAGER` 를 *절대* 쓰지 말 것 — anti-pattern | (전제) |
| 2 | fetch 플랜은 *쿼리별* 명시 (JPQL / Criteria / EntityGraph) | S2 / §7 |
| 3 | 읽기 전용 화면은 **DTO projection** | (모든 함정 우회) |
| 4 | 컬렉션은 `JOIN FETCH + DISTINCT` 한 단계, 나머지는 `@BatchSize` | S2 + S6 |
| 5 | OneToOne 은 `@MapsId` *단방향* (양방향 mappedBy 안 됨) | S4 |

본 EXP 의 6 시나리오는 정확히 *각 계명을 안 지킨 함정* 을 시연한 것 — S1 = 계명 4, S3 = 계명 4 의 함정, S4 = 계명 5, S5 = 계명 4 의 paging 함정.

### 8.2 기업의 실제 패턴 4 종 [외부 사례 + 추정]

| 패턴 | 사례 | 트레이드오프 |
|---|---|---|
| **A. JPA write-only + native/QueryDSL/jOOQ read** | Naver D2, Kakao tech 다수 [외부 사례] — 대규모 트래픽 | ✅ 성능 100% 통제 / ❌ 코드 두 갈래 유지 비용 |
| **B. JPA + @EntityGraph + @BatchSize 안전망** | 일반적 Spring Boot 가이드 [외부 사례] — 스타트업 / SaaS | ✅ entity 그대로 / ❌ EntityGraph 정의 폭증 + MultipleBag 함정 잔존 |
| **C. JPA + DTO projection 전부** | 금융 / 결제 / 광고 입찰 [추정] — latency-critical | ✅ N+1 zero / ❌ DTO 폭증 + dirty checking 못 씀 |
| **D. JPA 회피 (jOOQ / MyBatis)** | 일부 미국 SaaS [외부 사례] — 강한 SQL 통제 | ✅ fetch 함정 영원히 zero / ❌ 객체 모델링 자연스러움 포기 |

→ 한국 빅테크 커머스/콘텐츠는 보통 패턴 A (write JPA + read QueryDSL). B2B/스타트업은 패턴 B. 어느 패턴이든 *N+1 함정의 메커니즘은 알아야* — 패턴 A 도 write 측 dirty checking 이 LAZY 트리거를 일으킬 수 있고, 패턴 B 는 EntityGraph 만 믿으면 paging 함정에 빠진다.

### 8.3 fetch 전략 결정 트리

| 상황 | 추천 |
|---|---|
| 읽기 전용 (보고서 / 리스트) | **DTO projection 1순위** — 모든 함정 우회 |
| 1:N 한 단계 + paging 없음 | JOIN FETCH (DISTINCT) |
| 1:N 두 단계 동시 | JOIN FETCH 한 단계 + `@BatchSize` |
| 한 entity 의 *두 collection* 동시 | Set 으로 변경 또는 `@BatchSize` |
| paging 필요 | parent 만 paging + 자식은 `IN` 쿼리 또는 `@BatchSize` |
| 1:1 mappedBy (non-owning) | **`@MapsId` 단방향** — batch_fetch_size 는 도움 안 됨 (§6.2) |
| 전역 안전망 | `application.yml` 에 `default_batch_fetch_size: 10` *항상* 켜둠 |

### 8.4 본 EXP 측정으로 권장하는 운영 default

1. application.yml 에 `default_batch_fetch_size: 10` *항상 켜둠* (S6 측정: 9.3x 감소)
2. 화면별로 fetch plan 명시: 한 collection JOIN FETCH + 두 번째는 BatchSize (계명 4)
3. 읽기 전용 화면은 DTO projection (계명 3)
4. OneToOne 은 무조건 @MapsId 단방향 (계명 5, S4 측정 — batch fetch 못 풂)

---

## 9. 결론 — fetch 함정은 *Bag / List / Set + 프록시 + cartesian 처리 정책* 의 상호작용 {#conclusion}

이 글이 측정으로 보여준 것은 — **JOIN FETCH 한 단어로 끝나는 게 아님**. List 와 Set 의 차이, owning / non-owning side 의 차이, paging 과의 호환성, *batch_fetch_size 가 풀 수 있는 N+1 과 풀 수 없는 N+1 의 경계*. 이 *조합 공간* 을 모르면 운영에서 *재현 어려운* OOM 이나 *의외의 SELECT 폭발*.

세 줄 요약:
1. **`default_batch_fetch_size: 10`** 한 줄로 collection LAZY 의 N+1 이 9.3x 감소 (S1 121 → 13). 안전망으로 항상 켜둠.
2. **그러나 `@OneToOne` non-owning LAZY 는 batch fetch 가 못 푼다** (S4 1201 → 1201). 별도 처방: `@MapsId` 단방향.
3. *읽기 전용 화면은 DTO projection*, *수정 가능 화면은 JOIN FETCH + BatchSize 조합*. 두 trail 을 화면별로 명시.

다음 글은 [JPA saveAll IDENTITY 의 batch insert 비활성화 함정](/posts/jpa-saveall-identity-bulk-insert-trap/).

---

## References {#references}

### 공식 문서
- [Hibernate ORM — Fetching Strategies](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#fetching)
- [Hibernate ORM — @BatchSize](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#fetching-batch)
- [Spring Data JPA — @EntityGraph](https://docs.spring.io/spring-data/jpa/reference/jpa/entity-graph.html)

### Vlad Mihalcea
- [N+1 Query Problem](https://vladmihalcea.com/n-plus-1-query-problem/)
- [Hibernate MultipleBagFetchException](https://vladmihalcea.com/hibernate-multiplebagfetchexception/)
- [Hibernate HHH000104 Fix](https://vladmihalcea.com/fix-hibernate-hhh000104-entity-fetch-pagination-warning-message/)
- [Hibernate OneToOne LAZY](https://vladmihalcea.com/hibernate-one-to-one-lazy-not-working/)

### 외부 사례
- [Baeldung — Hibernate @BatchSize](https://www.baeldung.com/jpa-hibernate-batchsize)
- [Thorben Janssen — N+1 Solutions](https://thorben-janssen.com/hibernate-tip-find-n-1-issues/)

### 자매글
- [JPA Dirty Checking 비용](/posts/jpa-dirty-checking-snapshot-cost/) — 본 시리즈 P2
- [JPA 낙관락 + retry stampede](/posts/jpa-optimistic-lock-lost-update/) — 본 시리즈 P1
