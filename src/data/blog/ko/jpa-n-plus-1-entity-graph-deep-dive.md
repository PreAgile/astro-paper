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

### 5.1 왜 메모리에서 paging 되는가

```sql
SELECT DISTINCT o.*, m.* FROM merchant_owner o LEFT JOIN merchant m ON ...
```

이 SQL 에 `LIMIT 5` 를 붙이면 — *5 row* 만 가져옴. 그런데 owner 와 merchants 의 cartesian product 면 5 row 가 *5 owner 가 아닌 5 merchants* 일 수도. Hibernate 가 어느 row 가 한 owner 단위인지 보장 못 해서 — *limit 안 붙이고 전체 가져온 후 메모리에서 paging*.

### 5.2 운영의 OOM 시나리오

owner 1만 명 × 매장 평균 5개 = 5만 row 의 cartesian. 페이지 사이즈 20 인데 — 5만 row 다 메모리로 읽고 *20 owner 만 남김*. heap OOM.

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

단 (§6.2 측정) **OneToOne non-owning LAZY 함정에는 안 먹힘** — 이걸 함께 푸는 건 @MapsId 만 가능. 한 줄 처방으론 부족하다는 게 본 EXP 의 메시지.

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
