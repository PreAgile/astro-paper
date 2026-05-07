---
author: 김면수
pubDatetime: 2026-05-07T22:00:00.000Z
title: "[JPA + Spring Mastery 09] 어디서 무엇을 쓸까 — JPA / JPQL / Native SQL 결정 트리, 측정값 4종으로 갈리는 컷"
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
description: "8 편을 거치며 PersistenceContext / Dirty Checking / Optimistic Lock / N+1 / IDENTITY / self-invocation / Saga·Outbox 를 측정값으로 풀었습니다. 이 마무리편은 그 모든 evidence 를 한 결정 트리 위에 올려놓습니다 — 도메인 단위인지 데이터 단위인지의 첫 갈림길로 시작해, JPA Dirty Checking 이 빛나는 곳 5 가지와 적자인 곳 5 가지, JPQL 의 중간 자리, Native / JdbcTemplate / MyBatis 의 자리를 4 측정값 (Dirty Checking 132× / saveAll IDENTITY ~1000× / OFFSET 1M 570× / bulk JPQL vs Dirty Checking 84×) 으로 컷하고, Eric Evans Aggregate (DDD 2003), Fowler PoEAA Identity Map / Unit of Work (2002), Greg Young CQRS Documents (2010), Vlad Mihalcea High-Performance Java Persistence (2016) 의 학술 anchor 와 카카오페이 readOnly QPS 58% 회고로 묶었습니다. 면접에서 'JPA 어떻게 다뤄봤어요?' 에 URL 한 줄로 답하기 위한 entry point 입니다."
---

## Table of contents

## 들어가며 {#intro}

이 시리즈를 1 편부터 8 편까지 끌고 오면서 가장 자주 받은 질문이 하나 있습니다 — **"그래서 결국 언제 JPA 를 쓰고 언제 안 써야 하나요?"**. 1 편의 PersistenceContext 와 Dirty Checking, 4 편의 N+1 entity graph, 5 편의 saveAll IDENTITY 함정, 7 편의 self-invocation, 8 편의 Saga / Outbox — 각 편이 측정값으로 한 함정을 풀었지만, 그 측정값들이 결정 트리의 어디에 위치하는지는 따로 정리하지 않았습니다.

이 마무리편은 그 정리입니다. 8 편의 evidence 를 한 트리 위에 올리고, 4 개의 측정값 컷 — Dirty Checking 132×, saveAll IDENTITY 약 1000×, OFFSET 1M 570×, bulk JPQL vs Dirty Checking 84× — 으로 **어느 컷에서 도구를 바꿔야 하는지** 를 그어둡니다. 면접 자리에서 "JPA 어떻게 다뤄봤어요?" 라는 질문에 URL 한 줄로 답하기 위한 entry point 글입니다.

JPA 가 만능이라는 주장과 JPA 는 ORM 이라 느리다는 주장 모두 반쪽 답입니다. 정확한 질문은 **지금 이 작업이 도메인 단위인가 데이터 단위인가** — 이 한 질문이 JPA / JPQL / Native SQL 의 갈림길의 첫 분기입니다. Eric Evans 가 Domain-Driven Design (2003) 에서 정의한 **Aggregate Root** 의 일관성 경계 안의 일은 JPA 의 Dirty Checking 이 가장 빛나는 자리고, Aggregate 경계를 넘는 데이터 처리 — bulk UPDATE, 통계, 리포팅, 1만 건 INSERT — 는 JPA 가 적자를 보는 자리입니다. 이 둘 사이의 회색지대를 JPQL 이 메우고, JPQL 도 못 가는 곳에 Native SQL / JdbcTemplate / MyBatis 가 있습니다.

1. **첫 갈림길** — 도메인 단위인가 데이터 단위인가 (Eric Evans Aggregate / Fowler Identity Map)
2. **JPA Dirty Checking 이 빛나는 곳 5 가지** — Aggregate 의 atomic 변경, 1차 캐시 hit, Optimistic Lock, Rich Domain, Cascade
3. **JPA Dirty Checking 이 적자인 곳 5 가지** — bulk UPDATE (132× / 84×), saveAll IDENTITY (~1000×), 통계·집계, 복잡한 join + N+1, DB 고유 기능
4. **JPQL 의 중간 자리** — `@Modifying` bulk, DTO Projection, QueryDSL, 한계
5. **Native / JdbcTemplate / MyBatis 의 자리** — entity 매핑 안 함, Spring Batch reader 4 종
6. **Command / Query 분리** — Greg Young CQRS Documents (2010) 의 가벼운 적용
7. **결정 트리 + 측정값 4 종 컷**
8. **면접 답변 — 1 분 / 5 분 / 30 분 꼬리질문 방어**

결론부터 말하면:

- **JPA 는 작은 단위 도메인의 일관성을 코드로 표현하는 도구** — 모든 SQL 의 대체재가 아닙니다. Eric Evans 의 Aggregate Root 경계 안의 일에서만 진가
- **bulk 의 컷은 수만 row** — 1 만 row UPDATE 에서 Dirty Checking 3,450ms vs raw JDBC 31ms = 132×, 그리고 bulk JPQL 41ms 와 비교해도 84× 차이. 수천 row 까지는 JPQL `@Modifying`, 수만 부터는 raw JDBC
- **saveAll(IDENTITY) 의 컷은 천 row** — `GenerationType.IDENTITY` 는 batch 를 구조적으로 비활성화. 1 만 INSERT 가 1 만 SQL → raw JDBC batch ~10 SQL 의 약 1000× 차이
- **OFFSET 의 컷은 깊은 페이지 5만 위치 부근** — OFFSET 1M = 171ms vs No-Offset cursor = 0.30ms = 570× 차이. 사장님 대시보드 / 사용자 무한스크롤 모두 cursor 가 정답
- **Command (JPA Aggregate) / Query (DTO Projection) 분리만으로도 80% 효과** — Greg Young 의 full CQRS 까지 갈 필요 없음. 같은 도메인 안에서 두 갈래로

머릿속의 "JPA 가 좋아 / 나빠" 라는 이분법이 어떻게 **어디서 무엇을 써야 하는가** 의 결정 트리로 바뀌는지 측정값과 함께 풀어봅니다.

---

## 1. 첫 갈림길 — 도메인 단위 vs 데이터 단위 {#1-domain-vs-data}

### 1.1 Eric Evans 의 Aggregate Root — 일관성 경계

[Eric Evans, Domain-Driven Design (Addison-Wesley, 2003)](https://www.dddcommunity.org/book/evans_2003/) 의 **Aggregate** 정의가 이 글의 출발점입니다.

> "An AGGREGATE is a cluster of associated objects that we treat as a unit for the purpose of data changes. Each AGGREGATE has a root and a boundary. The boundary defines what is inside the AGGREGATE. The root is a single, specific ENTITY contained in the AGGREGATE. The root is the only member of the AGGREGATE that outside objects are allowed to hold references to."
> — Eric Evans, Domain-Driven Design, 2003, Chapter 6

핵심 정의:

1. **Aggregate** = 데이터 변경 단위로 함께 다루는 객체 cluster
2. **경계 (boundary)** = 이 안에 있는 것 / 밖에 있는 것의 명확한 선
3. **Root** = Aggregate 의 단일 진입점 entity. 외부는 root 만 참조 가능
4. **일관성** = Aggregate 안의 invariant 는 한 트랜잭션 안에서 보장

이 정의가 JPA Dirty Checking 의 적합 영역을 직접 가리킵니다. **Aggregate 경계 안의 변경** = Dirty Checking 이 자동으로 추적해주는 변경. **경계 밖의 변경** = JPA 의 1 차 캐시 / Unit of Work 의 가치가 떨어지는 영역.

### 1.2 Fowler 의 Identity Map / Unit of Work — JPA 가 구현한 패턴

[Martin Fowler, Patterns of Enterprise Application Architecture (Addison-Wesley, 2002)](https://martinfowler.com/eaaCatalog/) 가 JPA 의 구현 패턴의 원전입니다.

| 패턴 | 정의 | JPA 의 구현 |
|---|---|---|
| Identity Map | 한 비즈니스 트랜잭션 안에서 같은 ID = 같은 Java 객체 | 1 차 캐시 (`PersistenceContext`) |
| Unit of Work | 트랜잭션 안의 모든 변경 추적 → commit 시점에 한 번에 flush | `ActionQueue` + Dirty Checking |
| Repository | 도메인 객체의 컬렉션처럼 보이는 추상화 | `JpaRepository` / `EntityManager` |
| Domain Model | 도메인 로직이 entity 메서드에 들어감 | `@Entity` + 도메인 메서드 |

이 4 패턴의 조합이 JPA 가 도메인 단위 작업에 빛나는 이유입니다. 그리고 이 4 패턴이 데이터 단위 작업에는 오히려 비용이 되는 이유 — Identity Map 은 1 만 entity 메모리 등록을 강제, Unit of Work 는 1 만 snapshot 비교를 강제, Repository 추상화는 raw SQL 의 자유도를 잃습니다.

이 비용을 실제 측정값으로 본 게 시리즈 1 편의 [PersistenceContext 글](/posts/jpa-spring-mastery-01-persistence-context-flush/) — 같은 SELECT 를 raw JDBC 와 JPA 로 비교하면 raw 0.74ms vs JPA 0.99ms 의 +0.4ms baseline 비용이 **반드시** 발생합니다. 1 row 당 0.4ms — 1 만 row 면 4 초의 baseline 비용.

### 1.3 도메인 단위 vs 데이터 단위의 정의

이 글에서 두 개념을 다음과 같이 정의합니다.

**도메인 단위 작업** — Aggregate 경계 안의 invariant 변경. 사용자 행동 1 회가 만드는 변경. 보통 row 수 1 ~ 수십.

```java
// 도메인 단위 — 결제 webhook 한 번이 5 entity 변경
@Transactional
public void confirmPayment(PaymentWebhook webhook) {
    Subscription sub = repo.findById(webhook.subId());
    sub.activate(webhook.confirmedAt());      // 변경 1
    sub.getBilling().markPaid(webhook);       // 변경 2
    sub.getCoupon().consume();                // 변경 3
    sub.scheduleNextBilling();                // 변경 4
    auditRepo.save(new ConfirmAudit(webhook));// 변경 5
}
```

**데이터 단위 작업** — Aggregate 경계를 명시적으로 넘어서 처리하는 row 단위 작업. 통계 / 리포팅 / bulk 변경 / 마이그레이션. 보통 row 수 수천 ~ 수억.

```java
// 데이터 단위 — 만료된 쿠폰 1 만 건 일괄 expire
@Modifying(clearAutomatically = true)
@Query("UPDATE Coupon c SET c.status = 'EXPIRED' WHERE c.expiresAt < :now AND c.status = 'ACTIVE'")
int expireOldCoupons(@Param("now") LocalDateTime now);
```

이 두 작업의 근본적 차이 — **도메인 단위는 invariant 추적이 가치**, **데이터 단위는 invariant 추적이 비용**. 이 한 줄이 결정 트리의 첫 분기입니다.

### 1.4 첫 결정 — 이 작업이 도메인 단위인가 데이터 단위인가

PR 리뷰 / 설계 회의에서 제일 먼저 묻는 질문:

```
질문 1: 이 작업이 만들어내는 변경이 어느 Aggregate 의 invariant 를 건드리나?
  - 명확한 단일 Aggregate → 도메인 단위 → JPA Dirty Checking
  - 여러 Aggregate / Aggregate 경계 없음 → 데이터 단위 → 질문 2

질문 2: row 수가 예측 가능한 수십 ~ 수백인가, 아니면 수천 이상으로 폭증 가능한가?
  - 수십 ~ 수백 → JPA + DTO Projection 도 OK
  - 수천 ~ 수만 → JPQL bulk UPDATE / DELETE
  - 수만 ~ → raw JDBC batch / native SQL
```

이 결정 트리의 각 분기에 측정값을 다음 절부터 채워 넣습니다.

---

## 2. JPA Dirty Checking 이 빛나는 곳 5 가지 {#2-jpa-shines}

### 2.1 Aggregate Root + 자식 entity 의 atomic 변경

도메인 작업 1 회가 여러 entity 를 동시 변경할 때, JPA Dirty Checking 이 **코드의 의도와 DB 의 상태**를 일치시켜줍니다. 결제 webhook 처리가 대표 사례.

```java
@Service
public class PaymentConfirmService {

    @Transactional
    public void confirm(PaymentWebhook webhook) {
        Subscription sub = repo.findById(webhook.subId())
            .orElseThrow();

        // 5 entity 의 atomic 변경 — 도메인 메서드로 의도 표현
        sub.activate(webhook.confirmedAt());
        sub.getBilling().markPaid(webhook.amount());
        sub.getCoupon().ifPresent(Coupon::consume);
        sub.scheduleNext(webhook.confirmedAt());
        auditRepo.save(ConfirmAudit.of(webhook));

        // commit 시점에 flush — UPDATE / INSERT 자동 발사
    }
}
```

이 코드가 raw SQL 이라면 5 개의 UPDATE / INSERT 를 순서까지 직접 작성해야 합니다. 한 entity 만 잊어도 부분 업데이트 사고. JPA 의 가치는 — 변경 의도만 표현하면 SQL 발행은 Hibernate 가 책임진다는 것.

8 편의 Saga 구현이 이 패턴 위에 있습니다. Saga 의 각 step (Tx1 reserve / Tx2 confirm / Tx3 cancel) 안은 단일 Aggregate 의 atomic 변경 — JPA Dirty Checking 이 그 step 안의 일관성을 책임지고, Saga 의 보상 로직이 step 간의 일관성을 책임집니다. **Aggregate = JPA / 분산 단위 = Saga** 의 2 층 구조 — [시리즈 8 편 트랜잭션 분리 글](/posts/jpa-spring-mastery-08-tx-split-saga-outbox/) 의 핵심이기도 합니다.

[외부 사례: 토스 SLASH24 — SAGA 분산 트랜잭션 보상](https://haon.blog/article/toss-slash/msa-reward-transaction/) 에서도 Saga 의 각 step 은 단일 Aggregate 의 JPA 트랜잭션으로 구현됨을 확인할 수 있습니다.

### 2.2 1 차 캐시 hit — 같은 entity 반복 접근

같은 트랜잭션 안에서 같은 ID 의 entity 를 여러 번 읽으면 — **2 회차부터 SQL 0 건**. Identity Map 패턴의 직접적 가치.

```java
@Transactional
public void processOrder(Long orderId) {
    Order o1 = repo.findById(orderId).orElseThrow();    // SELECT 1 회
    validateInventory(o1);                              // 메서드 안에서 다시 조회
    calculateDiscount(o1);                              // 또 조회
    sendNotification(o1);                               // 또 조회
}

private void validateInventory(Order o) {
    Order again = repo.findById(o.getId()).orElseThrow();// 1 차 캐시 hit — SQL 0
    // ...
}
```

raw JDBC 였다면 각 조회마다 SELECT 1 건 — 총 4 SELECT. 같은 트랜잭션 안에서 같은 row 를 반복 조회하는 도메인 코드에서 1 차 캐시 hit 의 가치가 누적됩니다.

단 반복 접근이 없는 호출 1 회 path 에서는 1 편에서 본 +0.4ms baseline 비용 (raw 0.74ms vs JPA 0.99ms) 이 순손실. **반복 접근의 빈도 × baseline 비용**의 trade-off — 반복이 많으면 1 차 캐시가 이긴다.

### 2.3 Optimistic Lock + `@Version`

Aggregate 의 atomic 변경 + 동시성 제어가 결합되는 자리. JPA 의 `@Version` 한 줄이 SQL 의 `WHERE version = ?` 절 자동 생성.

```java
@Entity
public class Account {
    @Id Long id;
    long balance;
    @Version Long version;  // ← 한 줄

    public void deduct(long amount) {
        if (balance < amount) throw new InsufficientBalance();
        this.balance -= amount;
        // commit 시점에 자동: UPDATE Account SET balance=?, version=version+1 WHERE id=? AND version=?
    }
}
```

[시리즈 7 편 self-invocation 글](/posts/jpa-spring-mastery-07-aop-self-invocation/) 의 락 4 종 측정 [실측, EXP-02] 을 보면 — 동시성 100 worker, 잔액 100 차감 시나리오에서:

| 락 | 시간 | 정확성 |
|---|---|---|
| 비관락 (FOR UPDATE) | **180ms** | 100% 정확 |
| 낙관락 (`@Version`) | 549ms | 100% 정확 (단, contention 시 N² 재시도) |
| MySQL `GET_LOCK` | 5,015ms | 91% (advisory lock 비용) |
| Redisson | 단일 인스턴스 환경 부적합 | 53% |

낙관락의 549ms 가 비관락 180ms 의 3 배 느림이지만 — 이건 **100 worker 가 같은 row 를 노리는 high-contention 환경** 의 측정. low-contention (서로 다른 Aggregate) 에서는 낙관락이 lock 부하 없이 더 빠른 경우가 많습니다. **어떤 도메인의 contention 패턴인가**에 따라 답이 갈립니다.

이 측정의 진짜 학습은 측정값이 아니라 **측정 도중 발견한 self-invocation 함정**입니다. `successes=100` 인데 잔액이 그대로 — 같은 클래스 내부 호출이 Spring AOP 프록시를 우회. 7 편이 그 함정을 라인 단위로 분해했습니다.

### 2.4 도메인 메서드로 비즈니스 로직 표현 — Rich Domain

Fowler PoEAA 의 [Domain Model 패턴](https://martinfowler.com/eaaCatalog/domainModel.html) 이 정의한 **Rich Domain Model** vs **Anemic Domain Model**.

```java
// Anemic — getter/setter 만 있고 로직은 service 에
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
        o.setStatus(OrderStatus.CANCELLED);  // 로직이 service 에 흩어짐
    }
}

// Rich — 로직이 entity 안에
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
        repo.findById(id).orElseThrow().cancel();  // 의도가 명확
    }
}
```

Rich Domain 은 service 비대화를 막고 비즈니스 invariant 가 entity 안에 응집 됩니다. JPA Dirty Checking 이 이 패턴을 코드로 표현 가능하게 만든 핵심 — 변경 후 save() 호출 불필요. 도메인 메서드만 호출하면 commit 시점에 자동 flush.

raw JDBC 라면 도메인 메서드 호출 후 반드시 `repo.update(o)` 를 명시 — 잊으면 silent miss. JPA 는 이 호출을 암묵적 으로 처리합니다.

### 2.5 Cascade + Orphan Removal

부모-자식 관계의 일관성. raw SQL 의 삭제 동기화 누락 사고를 JPA 가 막아줍니다.

```java
@Entity
public class Order {
    @OneToMany(mappedBy = "order",
               cascade = CascadeType.ALL,
               orphanRemoval = true)
    private List<OrderItem> items;

    public void removeItem(OrderItem item) {
        items.remove(item);  // commit 시점에 DELETE FROM order_items 자동
    }
}
```

raw JDBC 였다면 — `Order.items` 의 메모리 상태와 DB 상태를 수동 동기화. 변경 다섯 번 하면 다섯 번 모두 일관성 책임. JPA 는 컬렉션 변경 을 자동 감지해서 INSERT / DELETE 발행.

단 함정도 있습니다. `@OneToMany` 가 2 개 이상 일 때 fetch join 시 `MultipleBagFetchException`, paging 시 OOM (Hibernate 가 메모리에서 paging) — [N+1 entity graph deep dive 글](/posts/jpa-n-plus-1-entity-graph-deep-dive/) 의 4 함정. Cascade 의 가치는 경계가 명확한 1:N 관계에 한정.

---

## 3. JPA Dirty Checking 이 적자인 곳 5 가지 {#3-jpa-cost}

### 3.1 bulk UPDATE — 132× / 84× 측정값

수만 row UPDATE 에서 Dirty Checking 의 비용이 dominant 가 됩니다. [Dirty Checking snapshot cost 글 (EXP-13)](/posts/jpa-dirty-checking-snapshot-cost/) 의 6 시나리오 측정 [실측 — Java/Spring]:

| # | 시나리오 | 시간 (ms) | 의미 |
|---|---|---|---|
| S1 | 일반 entity (`@Transactional`, readOnly 없음) | **3,450** | Dirty Checking dominant |
| S2 | readOnly SELECT 만 | 26 | 변경 없음 baseline |
| S3 | 일반 entity 변경 (`@DynamicUpdate` 없음) | 3,117 | S1 과 비슷 |
| S4 | `@DynamicUpdate` 적용 | **2,123** | SET 절 축소만 |
| S5 | bulk JPQL `@Modifying` | **41** | PersistenceContext 우회 |
| S6 | raw JDBC | **31** | baseline |

비교 기준 분리:

> - **S1 vs S2 ≈ 132×** (3,450 / 26) — readOnly 가 빠진 메서드가 부담하는 비용. 단, S2 는 SELECT only 이므로 쓰기 비용 비교 가 아니라 Dirty Checking 부재 시 1 만 row 로드 + flush 한계 비용 비교
> - **S4 vs S6 ≈ 68×** (2,123 / 31) — `@DynamicUpdate` 만으로는 Dirty Checking dominant 비용을 못 줄임
> - **S5 vs S6 ≈ 1.32×** (41 / 31) — JPA 추상화 오버헤드는 30% 수준
> - **S1 vs S5 ≈ 84×** (3,450 / 41) — bulk JPQL 로 모델 자체를 바꿨을 때 의 효과

이 측정의 의미 — **bulk 작업에서 도구를 바꾸지 않으면 84× 손해**. 1 분 작업이 84 분.

<details>
<summary><b>(심도) Hibernate 6 의 loadedState 가 어떻게 만들어지나 — Dirty Checking 비용의 정체</b> (펼치기)</summary>

[Vlad Mihalcea, High-Performance Java Persistence (2016, Manning), Chapter 5 Persistence Context](https://vladmihalcea.com/books/high-performance-java-persistence/) 가 가장 정확하게 설명한 부분.

Hibernate 가 entity 를 hydrate 할 때:

```
SELECT 결과 row → ResultSet → Hibernate hydrator
  → Object[] (= loadedState, snapshot 1)
  → 이 Object[] 를 복사 해서 entity 필드에 set
  → EntityEntry 가 (entity, loadedState) 둘 다 보관
```

핵심 비용:
1. **Object[] 복사** — 1 만 entity × N 컬럼 = N 만 객체 참조 메모리
2. **flush 시 비교 loop** — 모든 managed entity × 모든 컬럼 = `O(N × M)` reflection 호출 (또는 bytecode enhancement 인터셉터)
3. **WHERE 절은 PK 만** — `@DynamicUpdate` 없으면 모든 컬럼 을 SET 절에 (변경 안 된 컬럼도 포함)

S4 의 `@DynamicUpdate` 가 (3) 만 해결. (1)(2) 는 그대로 — 그래서 S4 가 여전히 raw JDBC 대비 68× 느림. 근본 해결 은 모델 자체를 bulk JPQL 로 바꾸는 것 (S5, 41ms).

Hibernate 6 부터는 [bytecode enhancement 옵션](https://docs.jboss.org/hibernate/orm/6.6/userguide/html_single/Hibernate_User_Guide.html#BytecodeEnhancement) 으로 dirty tracking 을 interceptor 패턴 으로 교체 가능 — 단 빌드 시 enhancement task 추가 + 디버깅 복잡도 증가. 측정 시 30 ~ 40% 개선 보고가 있지만 bulk 작업의 84× 차이 를 메우진 못합니다.

</details>

### 3.2 saveAll(IDENTITY) — 약 1000× 측정값

[saveAll IDENTITY bulk insert trap 글 (EXP-14)](/posts/jpa-saveall-identity-bulk-insert-trap/) 의 측정 [실측 — Java/Spring]:

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50    # 설정해도 IDENTITY 면 무시됨
```

```java
@Entity
public class BulkRow {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)  // ← 함정
    private Long id;
    // ...
}

repo.saveAll(rows);  // 1 만 row
```

기대: 1 만 row / batch 50 = 200 SQL.
실제: **1 만 SQL** (Hibernate Statistics `prepareStatementCount=10000`).

**근본 원인**: `GenerationType.IDENTITY` 는 매 INSERT 마다 `LAST_INSERT_ID()` 를 즉시 받아야 합니다 — `Statement.RETURN_GENERATED_KEYS` 가 batch 와 호환 안 됨. 그래서 Hibernate 가 batch 자체를 비활성화.

raw JDBC `batchUpdate` + `rewriteBatchedStatements=true` 면 1 만 row → multi-value INSERT 약 10 SQL → **약 1000×** 의 SQL 수 차이 (그리고 비례적인 시간 차이).

해결 4 가지:

| 방법 | 동작 | trade-off |
|---|---|---|
| **UUID** | 애플리케이션이 UUID 생성 후 set → batch 가능 | UUID 16 byte, 인덱스 random IO |
| **`@TableGenerator` + pooled-lo (allocationSize=1000)** | 시퀀스 테이블에서 1000 ID 한 번에 발급 | 시퀀스 테이블 관리 + MySQL 환경 PostgreSQL SEQUENCE 의 효과 못 봄 |
| **Snowflake / TSID** | 분산 ID 생성기 | 라이브러리 의존 추가 |
| **raw JDBC batchUpdate** | JPA 우회 | entity 매핑 안 함 |

**MySQL 환경의 진짜 답** — 위 4 가지 중 도메인 특성에 따라 선택. PostgreSQL 의 `SEQUENCE` 가 없는 MySQL 에서는 IDENTITY → SEQUENCE 100 배 같은 dzone 글의 결론을 그대로 옮겨오면 안 됩니다 ([dzone 글의 PostgreSQL 가정](https://dzone.com/articles/spring-boot-boost-jpa-bulk-insert-performance-by-100x)).

### 3.3 통계 / 집계 / 리포팅

도메인 의미가 아닌 데이터 처리 가 목적인 작업. JPQL 도 표현이 어렵고 — Window function, recursive CTE, JSON 함수, FULLTEXT 모두 JPQL 표준 spec 에 없습니다.

```sql
-- 사장님 대시보드: 최근 30 일의 일별 매출 + 7 일 이동평균
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

이 SQL 을 JPQL 로 표현 시도 → window function 미지원 → 실패. native query 또는 JdbcTemplate 으로 바로 가야 합니다.

DTO Projection 의 비용도 다릅니다.

| 방식 | 비용 | 1 만 row |
|---|---|---|
| Entity 로딩 (`findAll()`) | 1 만 entity 메모리 + snapshot + 1 차 캐시 | 4,000ms (1 편의 +0.4ms × 1 만) |
| DTO Projection (`SELECT new com.X.SalesDto(...)`) | DTO 만 — 1 차 캐시 안 차임 | 약 30ms |
| JdbcTemplate `RowMapper` | DTO 만 — 추상화 0 | 약 25ms |

리포팅은 entity 가 필요 없는 작업 — DTO Projection 또는 JdbcTemplate.

### 3.4 복잡한 join + N+1

Aggregate 경계를 넘는 join. JPA 의 fetch join / `@EntityGraph` 의 4 함정이 [N+1 entity graph deep dive 글](/posts/jpa-n-plus-1-entity-graph-deep-dive/) 에서 풀렸습니다 — `MultipleBagFetchException`, Pagination OOM, OneToOne LAZY 가 EAGER 처럼 작동, `@BatchSize` 의 양면성.

복잡한 join 의 정통 패턴은 **DTO Projection 으로 fetch join 자체를 회피**.

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

DTO Projection 은 entity 의 atomic 변경 이 필요 없는 조회 전용 path 의 정통. 다음 6 절의 Command / Query 분리의 핵심 도구이기도 합니다.

### 3.5 DB 고유 기능

JPA 의 추상화 는 DB-portability 를 위한 것 — 그 대가로 DB 고유 기능 을 잃습니다.

| 기능 | JPA / JPQL 표현 가능? | 권장 도구 |
|---|---|---|
| Window function (`OVER`) | ❌ | Native SQL / JdbcTemplate |
| Recursive CTE (`WITH RECURSIVE`) | ❌ | Native SQL |
| JSON 함수 (`JSON_EXTRACT`) | ⚠️ MySQL Dialect 한정, 표준 spec 아님 | Native SQL |
| Upsert (`INSERT ... ON DUPLICATE KEY`) | ❌ | Native SQL |
| Partition pruning hint | ❌ | Native SQL |
| FULLTEXT (`MATCH ... AGAINST`) | ❌ | Native SQL |
| `SELECT FOR UPDATE SKIP LOCKED` | ⚠️ 일부 Dialect | Native SQL |
| Bulk INSERT multi-value | ❌ | raw JDBC `batchUpdate` |

이 매트릭스의 의미 — **DB 고유 기능이 필요한 순간 = JPA 를 부분적으로 우회**. 같은 코드베이스 안에서 JPA 와 Native SQL 을 공존 시키는 게 정상 운영 패턴.

---

## 4. JPQL 의 중간 자리 {#4-jpql}

JPQL 은 JPA 와 Native SQL 의 사이 — entity 매핑은 유지 하지만 PersistenceContext 의 Dirty Checking 을 우회. 이 우회의 의미를 정확히 알아야 함정에 안 빠집니다.

### 4.1 bulk UPDATE / DELETE — `@Modifying`

```java
public interface CouponRepository extends JpaRepository<Coupon, Long> {

    @Modifying(clearAutomatically = true)
    @Query("UPDATE Coupon c SET c.status = 'EXPIRED' " +
           "WHERE c.expiresAt < :now AND c.status = 'ACTIVE'")
    int expireOldCoupons(@Param("now") LocalDateTime now);
}
```

핵심 동작:
1. **PersistenceContext 우회** — Dirty Checking 도, 1 차 캐시도 거치지 않음
2. **DB 에 직접 UPDATE 발행** — bulk 1 SQL
3. **1 차 캐시는 stale** — 같은 트랜잭션에서 이미 로드한 entity 는 변경 전 상태

**stale 함정**:

```java
@Transactional
public void scenario() {
    Coupon c = repo.findById(1L).orElseThrow();  // ACTIVE 로 로드, 1 차 캐시 등록
    repo.expireOldCoupons(LocalDateTime.now());   // bulk UPDATE — DB 는 EXPIRED
    System.out.println(c.getStatus());            // ⚠️ 여전히 ACTIVE — 1 차 캐시 stale
}
```

처방: `@Modifying(clearAutomatically = true)` 로 1 차 캐시 자동 비움. 또는 `@Modifying(flushAutomatically = true)` 로 발행 전 미flush 변경 먼저 flush.

**측정값**: 1 만 row UPDATE 시 bulk JPQL = 41ms (S5), Dirty Checking = 3,450ms (S1). **84×** 차이. 데이터 단위 작업의 1 차 처방.

### 4.2 DTO Projection — readOnly + 1 차 캐시 안 차기

조회 전용 path 의 정통.

```java
@Query("SELECT new com.X.OrderSummaryDto(o.id, o.amount, m.name, o.createdAt) " +
       "FROM Order o JOIN o.merchant m " +
       "WHERE m.id = :merchantId " +
       "ORDER BY o.createdAt DESC")
List<OrderSummaryDto> findOrderSummaries(@Param("merchantId") Long merchantId);
```

DTO Projection + `@Transactional(readOnly = true)` 의 결합 — 시리즈 1 편에서 분해한 readOnly 의 3 단 효과:

1. **Hibernate flush mode** = MANUAL → flush 발생 안 함 → Dirty Checking 안 함
2. **Spring Tx readOnly 마커** → 일부 connection / driver 가 read-only 최적화
3. **MySQL `Com_set_option` 감소** → [외부 사례: 카카오페이 — JPA Transactional 잘 알고 쓰고 계신가요?](https://tech.kakaopay.com/post/jpa-transactional-bri/) 의 QPS 58% 감소 회고. read-only 트랜잭션의 `set autocommit = 0/1` round-trip 이 줄어드는 효과

조회 path 의 기본값 이 `readOnly = true` + DTO Projection. 변경 path 만 명시적으로 `readOnly = false` 또는 `@Transactional` 만.

### 4.3 동적 query — QueryDSL / Criteria

검색 조건이 런타임 결정 되는 경우. JPQL 의 문자열 쿼리로는 동적 조건 결합이 위태로움.

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

QueryDSL 의 가치는 컴파일 시 type 안전. 단 빌드 설정이 추가됨 (Q-class 생성). Criteria API 는 type 안전이지만 가독성 매우 낮음 — 보통 QueryDSL 을 권장.

### 4.4 JPQL 의 한계 — native function 못 씀

```java
// ❌ JPQL — MySQL JSON_EXTRACT 표준 spec 에 없음
@Query("SELECT o FROM Order o WHERE JSON_EXTRACT(o.metadata, '$.coupon') = :code")

// ✅ Native SQL — MySQL Dialect 직접 사용
@Query(value = "SELECT * FROM orders WHERE JSON_EXTRACT(metadata, '$.coupon') = :code",
       nativeQuery = true)
```

native function (window, JSON, FULLTEXT, recursive CTE) 이 필요한 순간 → JPQL 한계 → Native query 또는 JdbcTemplate 으로.

---

## 5. Native SQL / JdbcTemplate / MyBatis 의 자리 {#5-native}

### 5.1 Native `@Query(nativeQuery = true)`

entity 매핑 유지 + DB 고유 기능. 트랜잭션 / 1 차 캐시 / 격리수준은 JPA 와 함께.

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

**적합한 자리**:
- entity 가 필요한 변경 path 인데 JPQL 표현 불가 (FULLTEXT, JSON, window function)
- bulk UPDATE 의 비표준 함수 사용 (PostgreSQL `UPDATE ... FROM`, MySQL `JSON_SET`)

**부적합한 자리**:
- entity 가 필요 없는 조회 → DTO Projection 으로 (entity hydration 비용 회피)
- DB-portability 가 필수 인 라이브러리 / 프레임워크 코드

### 5.2 JdbcTemplate

entity 매핑 전혀 안 함. 통계 / 리포팅 / bulk / 마이그레이션의 정통.

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

**Spring Batch 의 reader 와 조합** — JdbcCursorItemReader, JdbcPagingItemReader. 대용량 backfill / 마이그레이션의 정석.

[외부 사례: 우아콘 — Spring Batch 와 함께 하는 대용량 데이터 처리](https://techblog.woowahan.com/2725/) 에서도 JpaItemReader 가 아닌 JdbcCursorItemReader 권장. JPA 의 entity 매핑 비용이 데이터 단위 처리 에서는 손해.

### 5.3 MyBatis

SQL 100% 직접 + 결과 매핑 자동. 한국 금융권 / 보험 / 일부 enterprise 가 여전히 정통으로 사용. JPA 와 동시 사용 도 가능 — 같은 DataSource 공유, 같은 트랜잭션 참여.

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
// JPA 와 MyBatis 공존
@Service
public class OrderQueryService {

    @Transactional(readOnly = true)
    public Page<OrderListDto> list(Long merchantId, Pageable p) {
        return mybatisMapper.findOrderList(merchantId, p);  // MyBatis 조회
    }

    @Transactional
    public void cancel(Long orderId) {
        Order o = jpaRepo.findById(orderId).orElseThrow();  // JPA 도메인 변경
        o.cancel();
    }
}
```

**MyBatis 의 자리**: SQL 의 세밀한 제어 가 비즈니스 가치인 도메인 (보험 정산, 회계 마감) — JPA 의 추상화가 오히려 디버깅 비용 증가. legacy 시스템 흡수 도 흔한 경우.

### 5.4 Spring Batch reader 4 종 — cross-link

대용량 처리는 Spring Batch 의 reader 선택이 결정적.

| Reader | 특징 | OFFSET 사용 여부 | 측정값 |
|---|---|---|---|
| `JpaPagingItemReader` | OFFSET 페이지네이션 + entity hydration | OFFSET ✓ | OFFSET 1M → 171ms (570× 손해) |
| `JdbcCursorItemReader` | DB cursor 기반, entity 매핑 없음 | OFFSET ✗ | cursor 0.30ms |
| `JpaCursorItemReader` | JPA + cursor (Hibernate ScrollableResults) | OFFSET ✗ | entity hydration 비용 남음 |
| `QuerydslZeroOffset` (수제) | OFFSET 안 쓰는 keyset pagination | OFFSET ✗ | cursor 0.30ms |

[OFFSET vs No-Offset cursor 글 (EXP-07)](/posts/mysql-no-offset-cursor-pagination/) 의 측정 [실측 — Java/Spring]:

| OFFSET 위치 | Latency | row scanned |
|---|---|---|
| 1,000 | 0.443ms | 1,020 |
| 10,000 | ~5ms | 10,020 |
| 100,000 | ~50ms | 100,020 |
| **1,000,000** | **171ms** | **1,000,020** |
| **No-Offset cursor** | **0.30ms** | 20 |

**약 570× 차이** (171 / 0.30). 사장님 대시보드의 깊은 페이지 사고가 이 측정값으로 설명됩니다 — OFFSET 5 만 페이지 클릭 한 번이 P99 를 무너뜨림.

함정 하나 더 — No-Offset 코드를 어떻게 쓰느냐 에 따라 또 한 번 500× 가 갈라집니다. ANSI SQL row constructor `(a,b) < (?,?)` 는 의미상 OR 분리 형태와 같지만 MySQL 옵티마이저가 index range 로 push down 못 함. 154ms (OFFSET 과 거의 동일). OR 분리 형태로 써야 0.30ms.

이 측정의 의미 — **데이터 단위 처리 = JPA 추상화의 적자 영역**. JpaPagingItemReader 의 OFFSET 함정은 reader 종류만 바꿔도 해결.

---

## 6. Command / Query 분리 — Greg Young CQRS 의 가벼운 적용 {#6-cqrs-light}

### 6.1 Greg Young 의 CQRS Documents (2010)

[Greg Young, CQRS Documents (2010)](https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf) 가 Command Query Responsibility Segregation 의 정의를 정리한 문서.

> "CQRS is simply the creation of two objects where there was previously only one. The separation occurs based upon whether the methods are a command or a query (the same definition that is used by Meyer in Command and Query Separation, but, CQRS uses a separate object)."
> — Greg Young, CQRS Documents, 2010

핵심 정의:

1. **Command** — 시스템 상태를 변경 하는 작업. 반환값 없음 (의도적)
2. **Query** — 시스템 상태를 읽기만 하는 작업. 변경 없음
3. **분리** — Command 와 Query 를 서로 다른 객체 로 (또는 서로 다른 모델)

**Full CQRS** 는 Command 측에 Event Sourcing, Query 측에 별도 read model + 별도 DB / 인덱스 — 이 글이 추천하는 건 그게 아닙니다. Greg Young 자신도 같은 문서에서 full CQRS 의 비용 을 언급하며 대부분의 시스템은 그 비용을 정당화 못 함 이라고 적었습니다.

### 6.2 가벼운 분리 — 같은 도메인 안의 두 갈래

Full CQRS 가 아닌 **논리적 분리** 만으로도 80% 의 효과:

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
        │ OrderService │          │ OrderQuery-  │
        │ .place()     │          │ Service      │
        │ .cancel()    │          │ .list()      │
        │ .refund()    │          │ .summary()   │
        └──────────────┘          └──────────────┘
```

같은 도메인 (`Order`) 인데 변경 path 와 조회 path 가 다른 코드 / 다른 모델:

```java
// Command path — JPA Aggregate
@Service
public class OrderCommandService {
    @Transactional
    public void cancel(Long orderId) {
        Order o = repo.findById(orderId).orElseThrow();
        o.cancel();  // 도메인 메서드
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

이 분리의 가치:
1. **Query path 는 entity 안 차임** — 1 차 캐시 / Dirty Checking / snapshot 비용 없음
2. **Command path 는 도메인 메서드 응집** — Rich Domain
3. **읽기 부하 분산이 쉬움** — Query path 만 read replica 로 분리 가능
4. **변경 / 조회 모델이 다를 수 있음** — Query 가 join / aggregation 를 자유롭게

### 6.3 [외부 사례: 우아콘 — Spring Batch + DTO Projection](https://techblog.woowahan.com/2725/)

우아콘의 대용량 처리 회고에서 — 조회는 JdbcCursorItemReader 또는 DTO Projection, 변경은 JPA Aggregate 의 분리 패턴이 명시적으로 등장합니다. full CQRS 까지 가지 않고 코드베이스 한 곳에서 두 갈래로 분리.

### 6.4 분리의 안티패턴

```java
// ❌ Command 와 Query 가 섞임
@Service
public class OrderService {
    @Transactional
    public OrderDto getAndCancel(Long id) {  // 의도 불명
        Order o = repo.findById(id).orElseThrow();
        o.cancel();
        return new OrderDto(o);  // Query 인지 Command 인지
    }
}
```

이런 메서드는 호출자가 의도를 못 읽음. `getAndCancel` 같은 이름이 함수 이름의 burning sign. Greg Young 의 Meyer Command-Query Separation 원칙 — 반환값이 있는 변경 메서드 금지.

---

## 7. 결정 트리 — 손에 잡히는 시나리오 매핑 {#7-decision-tree}

### 7.1 결정 트리 (ASCII)

```
[ 작업이 들어옴 ]
       │
       ▼
질문 1: 변경인가 조회인가
   ├─ 변경 → 질문 2
   └─ 조회 → 질문 5

질문 2: row 수가 예측 가능한 수십 ~ 수백인가
   ├─ YES → 질문 3
   └─ NO (수천 이상) → 질문 4

질문 3: 단일 Aggregate 의 invariant 변경인가
   ├─ YES → JPA Dirty Checking + Rich Domain
   │        (1 차 캐시 + Unit of Work + Optimistic Lock)
   └─ NO (여러 Aggregate / 외부 시스템) → Saga (시리즈 8)

질문 4: row 수
   ├─ 수천 → JPQL @Modifying bulk UPDATE / DELETE
   │         (PersistenceContext 우회, clearAutomatically=true)
   ├─ 수만 → raw JDBC batchUpdate
   │         (Dirty Checking 84× 차이 회피)
   └─ INSERT 수만 → raw JDBC + rewriteBatchedStatements=true
                    (saveAll IDENTITY ~1000× 회피)

질문 5: 조회 — 단순 / 복잡 / 통계
   ├─ 단순 (Aggregate 단일 ID) → JPA findById + readOnly
   ├─ 복잡 (join + paging) → JPQL DTO Projection + readOnly
   │                          (paging 깊으면 No-Offset cursor — 570×)
   └─ 통계 / 리포팅 / 집계 → JdbcTemplate + Native SQL
                              (window function / CTE / JSON)
```

### 7.2 시나리오 매핑 표

| 시나리오 | row 수 | Aggregate? | 도구 |
|---|---|---|---|
| 결제 webhook 처리 | 1 | 단일 (Subscription) | JPA Dirty Checking |
| 주문 생성 + 외부 PG | 1 + 외부 | 1 + 분산 | JPA + Saga |
| 잔액 차감 (high-contention) | 1 | 단일 | JPA + 비관락 (180ms) |
| 잔액 차감 (low-contention) | 1 | 단일 | JPA + 낙관락 (`@Version`) |
| 만료 쿠폰 일괄 expire | 수천 ~ 수만 | 데이터 단위 | JPQL `@Modifying` |
| 1 만 row 마이그레이션 | 1 만 | 데이터 단위 | raw JDBC batchUpdate |
| 사장님 일별 매출 리포트 | 30 | 데이터 단위 | JdbcTemplate + window function |
| 검색 (FULLTEXT) | 20 | 단일 조회 | Native @Query + MATCH |
| 사장님 대시보드 주문 목록 | 20 (paged) | 데이터 단위 | JPQL DTO + No-Offset cursor |
| 알림 발행 (eventually consistent) | 1 + 외부 | 분산 | Outbox (시리즈 8) |
| 통계 집계 (월말 마감) | 수십만 | 데이터 단위 | Spring Batch + JdbcCursorItemReader |

### 7.3 결정 트리의 변동 요인

이 트리의 cut 은 이 환경의 측정값 에 기반합니다. 다른 환경에선 cut 이 달라질 수 있습니다:

| 변동 요인 | 영향 |
|---|---|
| Hibernate 6 bytecode enhancement | Dirty Checking 비용 30~40% 감소 (S1 측정값 변동) |
| MySQL Connector/J 버전 | `rewriteBatchedStatements` 효과 차이 |
| InnoDB buffer pool 크기 | OFFSET 비용 변동 (cache 효과) |
| 동시성 / contention 패턴 | 락 종류 선택 cut 변동 |
| 네트워크 latency (DB - app) | 1 차 캐시 hit 의 가치 증가 |

학술적 정직성 — **이 컷은 이 환경 / 이 데이터 의 측정값**. 다른 환경에선 다른 컷. 운영 도입 전 직접 측정 권장.

---

## 8. 측정값 4 종으로 갈리는 컷 {#8-measurements}

이 글의 허브 가 되는 4 측정값.

### 8.1 측정값 표

| 측정 | 비율 | 의미 | 출처 |
|---|---|---|---|
| 1 만 row UPDATE: Dirty Checking vs raw JDBC | **132×** (3,450ms / 26ms) | readOnly 가 빠진 메서드의 부담 | [Dirty Checking snapshot cost (EXP-13)](/posts/jpa-dirty-checking-snapshot-cost/) |
| 1 만 row UPDATE: Dirty Checking vs bulk JPQL | **84×** (3,450ms / 41ms) | 모델 자체를 bulk JPQL 로 바꿨을 때 | 동일 |
| `@DynamicUpdate` 단독 한계 vs raw JDBC | **68×** (2,123ms / 31ms) | `@DynamicUpdate` 만으론 부족 | 동일 |
| bulk JPQL vs raw JDBC | **1.32×** (41ms / 31ms) | JPA 추상화 30% 오버헤드 | 동일 |
| `saveAll(IDENTITY)` vs raw JDBC batch | **약 1000×** (1 만 SQL vs 약 10 SQL) | IDENTITY = batch 비활성화 | [saveAll IDENTITY trap (EXP-14)](/posts/jpa-saveall-identity-bulk-insert-trap/) |
| OFFSET 1M vs No-Offset cursor | **570×** (171ms vs 0.30ms) | OFFSET 깊은 페이지의 비용 | [No-Offset cursor (EXP-07)](/posts/mysql-no-offset-cursor-pagination/) |
| 비관락 vs 낙관락 (high-contention) | 3× (180ms vs 549ms) | contention 패턴별 락 선택 | [락 4 종 비교 (EXP-02)](/posts/mysql-credit-concurrency-lock-comparison/) |
| raw JDBC vs JPA (warm) | 1.35× (0.74ms vs 0.99ms) | JPA baseline +0.4ms | [PersistenceContext flush (시리즈 1)](/posts/jpa-spring-mastery-01-persistence-context-flush/) |

### 8.2 컷의 위치

```
              row 수 / 작업 규모
                  │
   1 ───── 100 ──── 1,000 ───── 10,000 ──── 100,000 ───>
                  │              │              │
                  │              │              │
   JPA Dirty C    │              │              │
   ←───── 적합 ──→│              │              │
                  │              │              │
                  │  JPQL bulk   │              │
                  │←─── 적합 ───→│              │
                  │              │              │
                  │              │  raw JDBC    │
                  │              │←──── 적합 ──→│
                  │              │              │
   84× cut ────────────────────→│              │
                  │              │              │
   1000× cut ────────────────────────────────→ │ (IDENTITY)
                  │              │              │
   570× cut (OFFSET) — 페이지 깊이 5만 부근

cut 의 근사 값 — 환경 / 데이터 / 동시성에 따라 변동
```

### 8.3 cut 이 다른 환경에서 변동하는 예

| 환경 | Dirty Checking 84× cut 변동 | 사례 |
|---|---|---|
| **bytecode enhancement** | 30~40% 감소 → 수만 row 까진 JPA 도 가능 | Hibernate 6 + 빌드 enhancement |
| **batch_size + non-IDENTITY** | INSERT cut 사라짐 | UUID / TableGenerator pooled-lo |
| **읽기 전용 path** | Dirty Checking 비용 0 | `readOnly = true` (1 편 카카오페이 회고) |
| **반복 조회 path** | 1 차 캐시 hit 의 가치 ↑ | 같은 entity 4~5 회 접근 |

이 cut 들은 고정값이 아닌 권장 시작점. 운영 도입 전 직접 측정.

---

## 9. 면접 답변 — 1 분 / 5 분 / 30 분 {#9-interview}

### 9.1 1 분 후크

> "JPA 는 작은 단위 도메인의 일관성을 코드로 표현하는 도구이지, 모든 SQL 의 대체재가 아닙니다. Aggregate 경계 안의 atomic 변경 — 결제 webhook 5 entity 동시 변경 — 에서는 Dirty Checking 이 가장 빛나고, bulk UPDATE 1 만 row 같은 데이터 단위 작업에서는 84 배 적자입니다. 도구 선택의 첫 갈림길은 도메인 단위인가 데이터 단위인가 라는 한 질문입니다."

### 9.2 5 분 — 5 단계

**1단계 — 첫 갈림길**: 도메인 단위 (Aggregate 경계 안의 invariant 변경) vs 데이터 단위 (통계 / bulk / 리포팅). Eric Evans DDD 의 Aggregate Root 정의가 이 분기의 학술 anchor.

**2단계 — JPA 가 빛나는 곳**: Aggregate atomic 변경, 1 차 캐시 hit (Identity Map 패턴), Optimistic Lock + `@Version`, Rich Domain 의 도메인 메서드, Cascade + Orphan Removal. Fowler PoEAA 의 Identity Map / Unit of Work 패턴 위에 구현됨.

**3단계 — JPA 가 적자인 곳 + 측정값**:
- 1 만 row UPDATE: Dirty Checking 3,450ms vs bulk JPQL 41ms = **84×**
- saveAll(IDENTITY) 1 만 INSERT: 1 만 SQL vs raw JDBC batch ~10 SQL = **약 1000×**
- 통계 / window function / FULLTEXT: JPQL 표현 불가
- 복잡한 join + N+1: DTO Projection 으로 회피

**4단계 — JPQL 의 중간 자리**: `@Modifying(clearAutomatically = true)` bulk UPDATE, DTO Projection, QueryDSL 동적 query. PersistenceContext 우회의 의미 + 1 차 캐시 stale 함정.

**5단계 — Command / Query 분리**: Greg Young CQRS Documents (2010) 의 가벼운 적용. Full CQRS 까지 안 가도 같은 도메인 안에서 두 갈래 (Command = JPA Aggregate / Query = DTO Projection + readOnly) 만으로도 80% 효과. [외부 사례: 카카오페이 readOnly QPS 58% 감소](https://tech.kakaopay.com/post/jpa-transactional-bri/) 가 그 효과의 운영 회고.

### 9.3 30 분 — 꼬리질문 5 개 방어

**Q1. Dirty Checking 비용의 정체는 무엇인가?**

Vlad Mihalcea 의 High-Performance Java Persistence (2016, Chapter 5) 의 분해 — Hibernate hydrator 가 SELECT 결과를 entity 로 만들 때 Object[] (loadedState) 를 복사 해서 보관. flush 시점에 모든 managed entity × 모든 컬럼 reflection 비교. `O(N × M)` 의 비용. 1 만 entity × 10 컬럼 = 10 만 비교 + 1 만 UPDATE 발사. 해결은 모델 자체 를 bulk 로 바꾸는 것 (S5 측정값 41ms = 84× 개선). `@DynamicUpdate` 만 켜면 SET 절 축소 효과만 (S4 = 2,123ms = 여전히 raw JDBC 대비 68× 느림).

**Q2. JPA bulk = 84× 느린 근본 이유?**

세 가지: (1) entity hydration — 1 만 row 가 1 만 Java 객체 + Object[] snapshot. (2) Dirty Checking — flush 시 전수 비교. (3) `Statement.RETURN_GENERATED_KEYS` 가 batch 와 비호환 (IDENTITY 의 경우 추가). bulk JPQL 은 (1)(2) 우회 — DB 에 직접 UPDATE 1 SQL. raw JDBC 는 (3) 까지 우회 — multi-value INSERT 또는 batchUpdate.

**Q3. JPQL bulk 가 PersistenceContext stale 만드는 메커니즘 + 해결?**

`@Modifying` bulk UPDATE 는 PersistenceContext 우회. DB 에 직접 UPDATE 발사. 그런데 같은 트랜잭션에서 이미 로드한 entity 는 변경 전 상태 — 1 차 캐시의 객체와 DB 의 row 가 불일치. 처방: `@Modifying(clearAutomatically = true)` 로 1 차 캐시 자동 비움. 또는 발행 후 해당 entity 를 더 이상 안 쓰게 흐름 설계. 그리고 `flushAutomatically = true` — bulk UPDATE 직전에 미flush 변경 을 먼저 flush (Dirty Checking 결과를 DB 에 먼저 반영).

**Q4. CQRS 가 아닌데 왜 Command / Query 분리가 의미 있나?**

Greg Young 자신이 같은 문서에서 full CQRS 의 비용 을 인정. Event Sourcing + 별도 read model 까지 안 가도 — Meyer Command-Query Separation 의 원칙만 지키면 80%. 가치: (1) Query path 가 readOnly + DTO Projection 이면 1 차 캐시 / Dirty Checking / snapshot 비용 0. (2) Command path 의 도메인 메서드가 응집 (Rich Domain). (3) 읽기 부하 분산이 쉬움 (read replica 분리). (4) 변경 / 조회 모델이 다를 수 있음. 카카오페이의 readOnly QPS 58% 감소 회고가 (1) 의 운영 측정값.

**Q5. JPA / MyBatis 혼용 시 트랜잭션 동기화는?**

같은 DataSource 공유 시 — Spring 의 `DataSourceTransactionManager` 가 같은 connection 위에 둘을 묶음. JPA 의 `EntityManager` 와 MyBatis 의 `SqlSession` 이 같은 트랜잭션 에 참여. 단 함정: (1) JPA 의 지연 flush 와 MyBatis 의 직접 SQL 이 순서 어긋남 — JPA 의 변경이 flush 안 된 상태에서 MyBatis 가 SELECT 하면 변경 전 row 를 봄. 처방: MyBatis 호출 전 `entityManager.flush()` 명시. (2) 1 차 캐시 stale — MyBatis 의 UPDATE 후 같은 트랜잭션에서 JPA 로 entity 조회 시 변경 전 객체 반환. 처방: `entityManager.clear()` 또는 `refresh()`. (3) 격리 수준 — 한 connection 위 같은 격리수준이지만 MyBatis 가 MVCC 가시성을 명시적으로 알아야 디버깅 가능.

---

## 10. 결론 — 시리즈를 닫으며 {#10-conclusion}

### 10.1 한 문장 요약

> JPA 는 작은 단위 도메인의 일관성 을 코드로 표현하는 도구이지, 모든 SQL 의 대체재가 아닙니다. Aggregate 경계 안의 atomic 변경에서는 Dirty Checking 이 빛나고, 데이터 단위 작업 (bulk UPDATE / saveAll IDENTITY / 통계) 에서는 84× ~ 1000× 적자를 봅니다. 도구 선택의 첫 갈림길은 도메인 단위인가 데이터 단위인가 라는 한 질문이고, 그 답을 측정값 4 종 (132× / 84× / ~1000× / 570×) 으로 컷합니다.

### 10.2 시리즈 1 ~ 9 의 evidence chain

| 편 | 측정값 / 학술 anchor | 결정 트리에서의 자리 |
|---|---|---|
| **01 PersistenceContext / Flush** | raw 0.74ms vs JPA 0.99ms = 1.35× / Fowler Identity Map / 카카오페이 readOnly QPS 58% | JPA baseline 비용 + readOnly 효과 |
| **02 N+1 / Entity Graph** ([deep dive](/posts/jpa-n-plus-1-entity-graph-deep-dive/)) | MultipleBagFetchException / Pagination OOM / OneToOne LAZY EAGER 문제 / `@BatchSize` | 복잡한 join 의 4 함정 |
| **03 Optimistic Lock** ([lost update](/posts/jpa-optimistic-lock-lost-update/)) | 비관락 180ms / 낙관락 549ms / GET_LOCK 5,015ms | 동시성 패턴 별 락 선택 |
| **04 Dirty Checking 비용** ([snapshot cost](/posts/jpa-dirty-checking-snapshot-cost/)) | 132× / 68× / 84× / Vlad Mihalcea Hibernate 6 loadedState | bulk 의 84× 컷 |
| **05 saveAll IDENTITY** ([trap](/posts/jpa-saveall-identity-bulk-insert-trap/)) | 약 1000× / `RETURN_GENERATED_KEYS` 비호환 | INSERT 의 1000× 컷 |
| **06 (예정) QueryDSL 동적 query** | type-safe 동적 조건 결합 | JPQL 의 중간 자리 |
| **07 self-invocation** ([AOP proxy](/posts/jpa-spring-mastery-07-aop-self-invocation/)) | `successes=100` + 잔액 그대로의 모순 / 6 어노테이션 / Spring AOP 프록시 | 운영 함정 진단법 |
| **08 트랜잭션 분리** ([Saga / Outbox](/posts/jpa-spring-mastery-08-tx-split-saga-outbox/)) | 9 시나리오 매트릭스 / Garcia-Molina 1987 / Helland CIDR 2005 | Aggregate 너머의 분산 |
| **09 (이 글)** | 4 측정값 컷 / 결정 트리 / Greg Young CQRS / Eric Evans Aggregate | 시리즈의 허브 |

### 10.3 운영 점검 체크리스트

- [ ] PR 리뷰 — 변경 row 수 추정 (수백 / 수천 / 수만)
- [ ] 변경 path 가 Aggregate 경계 안인가 — 여러 Aggregate 면 Saga / Outbox 설계
- [ ] 조회 path 의 `@Transactional(readOnly = true)` 누락 검사
- [ ] DTO Projection vs entity 로딩 — 변경 안 하는 path 는 DTO 우선
- [ ] saveAll(`IDENTITY`) 발견 시 — UUID / TableGenerator pooled-lo / raw JDBC batch 중 선택
- [ ] OFFSET paging 의 깊이 한계 모니터링 — 5 만 페이지 넘으면 cursor 로 마이그레이션
- [ ] window / CTE / FULLTEXT 사용 시 Native query 또는 JdbcTemplate 으로
- [ ] Command / Query 분리가 service 레벨에서 명확한가
- [ ] bulk JPQL `@Modifying` 의 `clearAutomatically = true` 누락 검사

### 10.4 시리즈를 닫으며

이 시리즈는 측정값 으로 시작해서 학술 원전 으로 깊이를 채우고 한국 빅테크 회고 로 운영 reality 를 검증하는 3 박자였습니다. Eric Evans 의 Aggregate, Fowler 의 Identity Map / Unit of Work, Greg Young 의 CQRS, Vlad Mihalcea 의 Hibernate 내부 구조, Pat Helland 의 Idempotence — 이 학술 anchor 들이 언제 / 어디서 / 어떤 환경 의 측정값과 결합될 때 기억에 남는다고 믿습니다.

면접 자리에서 "JPA 어떻게 다뤄봤어요?" 라는 질문에 URL 한 줄로 답할 수 있는 entry point 를 만들고 싶었습니다. 1 편의 PersistenceContext 부터 9 편의 결정 트리까지 — 8 편의 evidence chain 이 하나의 결정 트리 위에 정리되었습니다.

다음 도구가 무엇이 됐든 — 측정값 4 종으로 갈리는 컷의 원리 는 같습니다. 도메인 단위인가 데이터 단위인가. 이 한 질문이 도구 선택의 첫 갈림길이고, 그 답을 측정값과 학술 anchor 로 검증하는 게 글로벌 시니어가 도구를 다루는 방식 입니다.

---

## 11. 참고자료 {#references}

### 학술 자료 (L5)

- **Eric Evans — Domain-Driven Design (Addison-Wesley, 2003)** — Aggregate Root, Bounded Context, Repository 의 정의. [DDD Community](https://www.dddcommunity.org/book/evans_2003/)
- **Martin Fowler — Patterns of Enterprise Application Architecture (Addison-Wesley, 2002)** — Identity Map, Unit of Work, Active Record vs Data Mapper, Repository, Domain Model. [eaaCatalog](https://martinfowler.com/eaaCatalog/)
- **Greg Young — CQRS Documents (2010)** — Command Query Responsibility Segregation 정의 + Meyer Command-Query Separation 원칙. [CQRS Documents PDF](https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf)
- **Vlad Mihalcea — High-Performance Java Persistence (Manning, 2016)** — JPA 비용 측정 + Hibernate 6 내부 구조 (loadedState, ActionQueue, FlushMode). [vladmihalcea.com](https://vladmihalcea.com/books/high-performance-java-persistence/)
- **Pat Helland — Idempotence Is Not a Medical Condition (ACM Queue, 2012)** — bulk 처리에서 멱등성. [ACM Queue](https://queue.acm.org/detail.cfm?id=2187821)
- **Hector Garcia-Molina, Kenneth Salem — Sagas (ACM SIGMOD, 1987)** — Saga 원전. [ACM DL](https://dl.acm.org/doi/10.1145/38713.38742)
- **Pat Helland — Data on the Outside vs Data on the Inside (CIDR, 2005)** — Outbox 학술 기원. [PDF](http://cidrdb.org/cidr2005/papers/P12.pdf)
- **Bertrand Meyer — Object-Oriented Software Construction (Prentice Hall, 1997)** — Command-Query Separation 원칙

### 공식 문서 (1 순위)

- [Hibernate ORM 6.6 User Guide](https://docs.jboss.org/hibernate/orm/6.6/userguide/html_single/Hibernate_User_Guide.html) — bytecode enhancement, FlushMode, batch_size
- [JPA 2.2 Specification (JSR 338)](https://jakarta.ee/specifications/persistence/) — `GenerationType.IDENTITY`, JPQL spec
- [Spring Data JPA Reference](https://docs.spring.io/spring-data/jpa/reference/) — `@Modifying`, `@Query`, projection
- [Spring Framework — Declarative Transaction Management](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative.html)
- [QueryDSL Reference](http://querydsl.com/static/querydsl/latest/reference/html/) — type-safe query
- [Spring Batch Reference — ItemReader](https://docs.spring.io/spring-batch/reference/readers-and-writers/) — Jpa / Jdbc Cursor / Paging Reader

### 한국 빅테크 회고

- **카카오페이** — [JPA Transactional 잘 알고 쓰고 계신가요?](https://tech.kakaopay.com/post/jpa-transactional-bri/) — readOnly + `Com_set_option` QPS 58% 감소
- **토스 SLASH24** — [SAGA 분산 트랜잭션 보상](https://haon.blog/article/toss-slash/msa-reward-transaction/) — Saga step 안의 JPA Aggregate 패턴
- **우아콘 / 우아한형제들** — [Spring Batch + 대용량 데이터 처리](https://techblog.woowahan.com/2725/) — JdbcCursorItemReader 권장
- **우아한형제들** — [응? 이게 왜 롤백되는거지?](https://techblog.woowahan.com/2606/) — REQUIRED rollback-only 함정
- **29CM** — [Transactional Outbox 실제 구현](https://medium.com/@greg.shiny82/%ED%8A%B8%EB%9E%9C%EC%9E%AD%EC%85%94%EB%84%90-%EC%95%84%EC%9B%83%EB%B0%95%EC%8A%A4-%ED%8C%A8%ED%84%B4%EC%9D%98-%EC%8B%A4%EC%A0%9C-%EA%B5%AC%ED%98%84-%EC%82%AC%EB%A1%80-29cm-0f822fc23edb)

### Canonical 작가

- [Vlad Mihalcea — High-Performance Java Persistence Newsletter](https://vladmihalcea.com/) — Hibernate 6 내부 구조, batch insert, `@DynamicUpdate`
- [Martin Fowler — eaaCatalog](https://martinfowler.com/eaaCatalog/) — Identity Map, Unit of Work, Repository, Domain Model
- [Greg Young — CQRS Documents](https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf)

### 시리즈 자매글 + 측정값 출처

- **시리즈 01** — [PersistenceContext / Flush](/posts/jpa-spring-mastery-01-persistence-context-flush/) — JPA baseline +0.4ms, 카카오페이 readOnly 회고
- **시리즈 07** — [Spring AOP self-invocation](/posts/jpa-spring-mastery-07-aop-self-invocation/) — 운영 함정 진단법
- **시리즈 08** — [Saga / Outbox / REQUIRES_NEW](/posts/jpa-spring-mastery-08-tx-split-saga-outbox/) — Aggregate 너머의 분산
- **W4 P2 EXP-13** — [Dirty Checking snapshot cost](/posts/jpa-dirty-checking-snapshot-cost/) — 132× / 84× / 68× 측정값
- **W4 P4 EXP-14** — [saveAll IDENTITY trap](/posts/jpa-saveall-identity-bulk-insert-trap/) — 약 1000× 측정값
- **W4** — [Optimistic Lock Lost Update](/posts/jpa-optimistic-lock-lost-update/) — 낙관락 메커니즘
- **W4** — [N+1 Entity Graph deep dive](/posts/jpa-n-plus-1-entity-graph-deep-dive/) — 4 함정
- **W3 EXP-02** — [락 4 종 비교](/posts/mysql-credit-concurrency-lock-comparison/) — 비관락 180ms 측정값
- **W2 EXP-07** — [No-Offset cursor pagination](/posts/mysql-no-offset-cursor-pagination/) — 570× 측정값
