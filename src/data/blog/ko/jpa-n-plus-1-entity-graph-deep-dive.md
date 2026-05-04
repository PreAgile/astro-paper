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

**[실측 — Java/Spring Stage 2 / 2026-05-04 23:01 KST]** 20 owner × 5 merchant × 3 rule × 4 history 도메인:

| Scenario | prepStmts | queries | rows | aux | elapsedMs |
|---|---:|---:|---:|---:|---:|
| **S1 N+1 baseline** | **121** | 1 | 20 | 300 | **73** |
| S2 JOIN FETCH 1-level | **1** | 1 | 20 | 100 | **10** (7x 빠름) |
| S3 MultipleBagFetchException | (예외) | — | — | — | — |
| **S4 `@OneToOne` non-owning LAZY** | **1201** | 1 | 1200 | 0 | **384** |
| S5 JOIN FETCH + Pagination (HHH000104) | 1 | 1 | 5 | 0 | 5 |
| S6 BatchSize=10 | **21** | 1 | 20 | 100 | 10 |

> S1 의 121 prep 분해: 1 main + 20 merchant + 60 rule + 40 history aux ≈ 121 — *깊이마다 multiplicative 증가*. S4 `@OneToOne` non-owning LAZY 는 metadata 변수를 안 써도 1200x 추가 SELECT (null 확인용). `@BatchSize=10` 이 121→21 로 5.7x 감소 — 정석은 *한 collection 만 JOIN FETCH + 나머지 BatchSize*.

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

### 6.2 해결법

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

## 7. S6 — `@BatchSize` 의 N/K+1 효과 {#s6-batch-size}

`hibernate.default_batch_fetch_size=10` (또는 `@BatchSize(size=10)`) 적용 시:

```sql
-- N+1 baseline:
SELECT * FROM owner;
SELECT * FROM merchant WHERE owner_id = ?;  -- 20 번
-- = 21 SQL

-- @BatchSize 적용:
SELECT * FROM owner;
SELECT * FROM merchant WHERE owner_id IN (?, ?, ?, ..., ?);  -- 10 owner_id 묶어서, 2 번
-- = 3 SQL
```

→ N + 1 = 21 → ⌈N/K⌉ + 1 = 3. 한 자릿수.

application.yml 의 `hibernate.default_batch_fetch_size` 가 활성화된 상태면 — *모든 LAZY collection* 에 자동 적용.

---

## 8. 운영 룰 — fetch 전략 결정 트리 {#operational-rules}

| 상황 | 추천 |
|---|---|
| 1:N 한 단계 + paging 없음 | JOIN FETCH (DISTINCT) |
| 1:N 두 단계 동시 | JOIN FETCH + `@BatchSize` 조합 |
| 한 entity 의 *두 collection* 동시 | Set 으로 변경 또는 `@BatchSize` |
| paging 필요 | parent 만 paging + 자식은 `IN` 쿼리 또는 `@BatchSize` |
| 1:1 mappedBy | `@MapsId` 단방향 또는 Bytecode Enhancement |
| read-only 보고서 | DTO projection (`SELECT new com.x.Dto(o.id, m.name) ...`) — entity 우회 |

---

## 9. 결론 — fetch 함정은 *Bag / List / Set + 프록시 + cartesian 처리 정책* 의 상호작용 {#conclusion}

이 글이 측정으로 보여준 것은 — **JOIN FETCH 한 단어로 끝나는 게 아님**. List 와 Set 의 차이, owning / non-owning side 의 차이, paging 과의 호환성. 이 *조합 공간* 을 모르면 운영에서 *재현 어려운* OOM 이나 *의외의 SELECT 폭발*.

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
