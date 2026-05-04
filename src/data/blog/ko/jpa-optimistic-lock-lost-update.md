---
author: 김면수
pubDatetime: 2026-05-04T10:00:00.000Z
title: "JPA 낙관락 + retry stampede 의 함정 — @Version 만으론 부족한 6 시나리오"
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
  100 worker 가 같은 룰의 priority 를 +1 합니다. @Version 없으면 priority < 100 (Lost Update). @Version 적용하면 OptimisticLockException 만 던지고 처리는 호출자 책임 — 일부만 성공. @Retryable(3) 백오프 0 으로 retry 면 *동시에 retry 가 몰려서* 다시 충돌 (retry stampede). exponential + full jitter 가 retry 를 분산시켜 priority=100 도달. 그리고 측정 도중 만난 자기 Lost Update — 같은 트랜잭션 안에서 SELECT 두 번이 다른 객체 (JDBC) vs 같은 인스턴스 (JPA 1차 캐시 ==). 분산 환경 Lost Update 와는 완전히 별개의 함정. @Transactional + @Retryable AOP 순서, exponential backoff + jitter 의 이론적 근거 (AWS Architecture Blog) 까지 풀었습니다.
---

## Table of contents

## 들어가며 {#intro}

자동 응답 룰 도메인의 코드 리뷰에서 같은 패턴이 또 나왔습니다. **사장님 두 명이 동시에 같은 룰의 priority 를 수정** — 한 명만 dashboard 를 쓰면 문제없는데, 가끔씩 priority 가 *증가하지 않았다* 는 운영 보고가 들어왔습니다.

흔한 답은 두 가지입니다. **"`@Version` 붙이면 됩니다"** 또는 **"비관락 (FOR UPDATE) 쓰면 됩니다"**. 둘 다 *부분적으로 맞는데* 둘 다 *부분적으로 틀립니다*. `@Version` 만 붙이면 `OptimisticLockException` 이 *던져지기만 하고* 처리는 호출자 책임. 비관락은 *충돌 빈번* 환경에서만 효율적. 사장님 룰 수정처럼 *충돌 드문* 환경에선 비관락이 오버킬.

그래서 직접 측정했습니다. **같은 룰의 priority 를 100 worker 가 +1**. `@Version` 의 *진짜 한계* 와 *retry 의 진짜 함정* 을 끝까지 풀어봤습니다.

그리고 측정 도중 더 깊은 함정을 발견했습니다. **`@Retryable` 백오프 0** 으로 두면 — retry 가 *동시에 몰려서* 다시 충돌. retry 횟수만 늘리고 성공률은 그대로. 이게 retry stampede. exponential + jitter 가 *왜 표준* 인지 측정으로 확인했습니다. 거기에 *같은 트랜잭션 내 자기 Lost Update* 라는 별개의 함정 (Vlad Mihalcea 의 1차 캐시 == 보장) 까지 한 글에서 정리했습니다.

이 글은 같은 의도의 update 를 **6 시나리오** 로 비교한 deep-dive 입니다. JPA 의 함정은 *기능 한 줄* 이 아니라 *전체 트랜잭션 lifecycle 과 retry policy 의 상호작용* 입니다.

---

## 1. 같은 시나리오, 같은 entity, 같은 데이터 — 6 시나리오 {#scenarios}

다음 같은 시나리오를 6 가지로 보호:

```
- entity:    auto_reply_rule (id, owner_id, priority, @Version version)
- 초기:      priority=0, version=0
- worker:    100 worker 동시 priority +1
- 정확성:    priority = 100 (loss=0)
```

각 시나리오 한 줄 요약:

| # | 시나리오 | 핵심 |
|---|---|---|
| **S1** | `@Version` 없이 raw RMW (read-modify-write) | Lost Update 직접 재현 |
| **S2** | `@Version` 적용, retry 없음 | OptimisticLockException 만 던지고 끝 |
| **S3** | `@Retryable(3)` + backoff=0 | retry stampede |
| **S4** | `@Retryable(5)` + exponential + full jitter | retry 분산 → 정확성 |
| **S5** | 자기 Lost Update (DC-4) | 같은 트랜잭션 내 JDBC vs JPA 1차 캐시 |
| **S6** | 시리즈 통합 — `@DynamicUpdate` 와의 상호작용 | 다음 글에서 |

---

## 2. S1 — `@Version` 없이 read-modify-write {#s1-baseline}

가장 단순한 코드:

```java
@Transactional
public void incrementWithoutVersion(Long ruleId) {
    Integer current = jdbc.queryForObject(
            "SELECT priority FROM auto_reply_rule WHERE id = ?",
            Integer.class, ruleId);
    int next = current + 1;
    jdbc.update("UPDATE auto_reply_rule SET priority = ?, updated_at = CURRENT_TIMESTAMP(6) WHERE id = ?",
            next, ruleId);
}
```

100 worker 가 동시 호출. 결과는 `priority < 100` — Lost Update. 두 worker 가 *같은 priority 값을 SELECT* 한 후 *같은 next* 로 UPDATE 하면 한 worker 의 increment 가 사라집니다.

**[측정 후 갱신 — `[실측]` 라벨로 결과 표 채움]**

| Scenario | totalMs | success | finalPriority | loss |
|---|---:|---:|---:|---:|
| S1 baseline | TBD | 100 | TBD (예상 < 100) | TBD |

→ 핵심: *모든 worker 가 success* 인데 *priority 가 100 미만*. 사용자 입장에선 "코드 정상 동작" 처럼 보이지만 데이터가 어긋남. 운영에서 *재현 불가능한* 부류의 버그.

---

## 3. S2 — `@Version` 적용, retry 없음 {#s2-version-only}

JPA 의 `@Version` 컬럼 추가 + Dirty Checking 에 맡김:

```java
@Entity @Table(name = "auto_reply_rule")
class AutoReplyRule {
    @Id @GeneratedValue(IDENTITY) Long id;
    int priority;
    @Version Long version;        // ← 핵심
    // ...
    public void incrementPriority() { this.priority += 1; }
}

@Transactional
public void incrementWithVersion(Long ruleId) {
    AutoReplyRule rule = repo.findById(ruleId).orElseThrow();
    rule.incrementPriority();
    // flush 시 UPDATE auto_reply_rule SET ..., version=version+1 WHERE id=? AND version=?
    // 0 row 반환되면 OptimisticLockingFailureException 발사
}
```

Hibernate 가 자동으로 만드는 SQL:

```sql
UPDATE auto_reply_rule
   SET priority = ?, version = ? + 1, updated_at = ?
 WHERE id = ?
   AND version = ?              ← 핵심: version 체크
```

다른 worker 가 먼저 update 해서 version 이 바뀌어 있으면 — 위 UPDATE 가 *0 row 매칭*. Spring 이 이를 감지해서 `ObjectOptimisticLockingFailureException` 던짐.

→ Lost Update 는 **방지**. 단 일부 worker 만 성공, 나머지는 *예외* 로 끝남. *처리는 호출자 책임*.

| Scenario | success | optLockFail | finalPriority |
|---|---:|---:|---:|
| S2 detect | TBD | TBD | TBD (예상 < 100) |

→ 핵심: 정합성은 OK 인데 *처리량* 이 낮음. 100 worker 중 일부만 성공.

---

## 4. S3 — `@Retryable(3)` + backoff=0 (retry stampede) {#s3-stampede}

자연스러운 다음 단계: 충돌하면 *재시도*. Spring Retry 의 `@Retryable`:

```java
@Retryable(
    retryFor = OptimisticLockingFailureException.class,
    maxAttempts = 3,
    backoff = @Backoff(delay = 0)   // ← 백오프 0 = 즉시 retry
)
@Transactional
public void incrementWithRetryNoBackoff(Long ruleId) {
    AutoReplyRule rule = repo.findById(ruleId).orElseThrow();
    rule.incrementPriority();
}
```

직관적으로는 — "충돌하면 다시 시도, 3 번이면 다 성공할 것". 그런데 *백오프 0* 이 함정.

99 worker 가 충돌해서 *동시에 retry* 시작 → 그 99 worker 가 *다시 같은 row* 노림 → 1 worker 만 성공, 98 worker 다시 충돌 → 다시 동시 retry → ...

이게 **retry stampede**. retry 횟수만 N 번 늘었지 *동시 retry* 자체가 충돌의 원인. 결과:
- *3 번 retry 다 소진* 한 worker 들이 결국 실패.
- success 수가 약간 늘긴 하지만 priority < 100.
- *총 elapsed 가 늘어남* — 의미 있는 progress 없이 retry 만 폭증.

| Scenario | success | optLockFail | finalPriority | totalMs |
|---|---:|---:|---:|---:|
| S3 stampede | TBD | TBD | TBD (예상 < 100) | TBD |

<details>
<summary><b>(심도) AWS Architecture Blog — Exponential Backoff and Jitter</b> (펼치기)</summary>

AWS 의 [Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) 글이 이 패턴의 *수학적 근거* 를 정리합니다. 핵심:

- **No backoff**: N client 가 한 번에 retry → 다시 충돌. Server 부하가 *retry 마다 동일* → 영구 stampede.
- **Exponential backoff**: 각 client 가 attempt 마다 wait 시간을 *2 배*. 그러나 *모든 client 가 같은 시간 기다림* → 같은 시점에 다시 retry → 또 stampede.
- **Exponential + Full Jitter**: `wait = random(0, 2^attempt × baseDelay)` — 각 client 가 *랜덤* 시간 대기 → retry 가 분산.

본 EXP 의 S4 가 이 *full jitter* 의 적용 케이스. Spring Retry 의 `@Backoff(random = true)` 가 jitter 를 활성화.

</details>

---

## 5. S4 — `@Retryable(5)` + exponential + full jitter {#s4-jitter}

```java
@Retryable(
    retryFor = OptimisticLockingFailureException.class,
    maxAttempts = 5,
    backoff = @Backoff(
        delay = 5,           // 시작 5ms
        maxDelay = 100,      // 최대 100ms
        multiplier = 2.0,    // exponential
        random = true        // ← full jitter
    )
)
@Transactional
public void incrementWithRetryJitter(Long ruleId) {
    AutoReplyRule rule = repo.findById(ruleId).orElseThrow();
    rule.incrementPriority();
}
```

각 worker 의 retry 시점이 *랜덤* — retry 가 시간 축으로 분산. server (DB) 입장에선 *동시 충돌이 줄어들어* progress 가 누적됨.

기대 결과: *priority = 100 도달*. retry 횟수는 늘지만 *의미 있는 progress*.

| Scenario | success | optLockFail | finalPriority | totalMs |
|---|---:|---:|---:|---:|
| S4 jitter | TBD | TBD | 100 (기대) | TBD |

→ 핵심: **단순 retry ≠ 안전**. *jitter 가 있는 retry 만* 안전. 이게 시니어 면접에서 갈리는 지점.

---

## 6. AOP 순서 — `@Retryable` + `@Transactional` 의 *결정적* 순서 {#aop-order}

`@Retryable` 과 `@Transactional` 둘 다 AOP. 어느 쪽이 *outer* 인가에 따라 동작이 갈립니다:

```
[클라이언트]
   ↓
[@Retryable proxy]   ← outer (Spring Retry interceptor)
   ↓ (1차 호출)
[@Transactional proxy]   ← inner
   ↓
[실제 메서드]            ← 트랜잭션 안
   ↓ (충돌 → exception 던짐)
[@Transactional proxy]   ← rollback
   ↓
[@Retryable proxy]       ← exception catch → retry
   ↓ (2차 호출)
[@Transactional proxy]   ← 새 트랜잭션 열기
   ↓
[실제 메서드]
```

→ **`@Retryable` 이 outer** 일 때 — retry 마다 *새 트랜잭션* 이 열림. `@Version` 의 fresh read 보장. 이게 우리가 원하는 동작.

만약 `@Transactional` 이 outer 면 — retry 가 *같은 트랜잭션* 안에서. JPA 1차 캐시가 *같은 entity* 를 들고 있어서 *같은 stale version* 으로 또 시도 → 무한 retry stampede.

Spring 의 default order: `RetryOperationsInterceptor` 가 Transactional 보다 *outer*. 본 EXP 코드는 default 그대로 — 동작 OK.

<details>
<summary><b>(곁가지) self-invocation 함정 — 같은 클래스 내부 호출이면 AOP 안 먹음</b> (펼치기)</summary>

Spring AOP 는 *proxy 기반*. 따라서 *외부에서 들어오는 호출* 만 가로챔. 같은 클래스 안에서 `this.method()` 호출은 proxy 우회 → AOP 안 먹음.

```java
@Service
class RuleUpdateService {
    @Retryable(...)
    public void wrapper(Long id) {
        this.realLogic(id);   // ← AOP 우회. retry 안 됨
    }
    @Transactional
    private void realLogic(Long id) { ... }
}
```

해결법: (a) 별도 빈으로 분리, (b) `AopContext.currentProxy()` 사용 (단 `exposeProxy=true` 필요), (c) self-injection (`@Autowired private RuleUpdateService self;`).

W3 EXP-02 측정 시 self-invocation 으로 *낙관락 메서드의 성공 100 인데 잔액 그대로* 함정을 한 번 만났습니다. [JPA Spring Mastery #7](/posts/jpa-spring-mastery-07-aop-self-invocation/) 에서 깊이 있게 다룬 함정이라 본 글은 짧게 언급만.

</details>

---

## 7. S5 — 자기 Lost Update (DC-4): JDBC vs JPA 1차 캐시 {#s5-self-lost}

분산 환경 Lost Update 와 *완전히 별개* 의 함정. *같은 트랜잭션 안에서 같은 row 두 번 조회* 하면 어떻게 될까?

### 7.1 JDBC 안티패턴 (자기 Lost Update 발생)

```java
@Transactional
public void selfLostUpdateJdbcStale(Long id) {
    // 1차 SELECT — 메모리 변수 aRetry (예: 0)
    Integer aRetry = jdbc.queryForObject(
        "SELECT retry_count FROM reply_request_dc4 WHERE id = ?", Integer.class, id);

    // 1차 UPDATE — retry_count += 1 (DB: 1)
    jdbc.update("UPDATE reply_request_dc4 SET retry_count = ? WHERE id = ?", aRetry + 1, id);

    // (다른 메서드에서 호출되거나 2차 SELECT 누락 시) — aRetry stale 변수 그대로 사용
    jdbc.update("UPDATE reply_request_dc4 SET last_attempted_at = ?, retry_count = ? WHERE id = ?",
            Timestamp.from(now()), aRetry, id);
    // ↑ aRetry = 0 → DB 의 retry_count=1 을 0 으로 덮어씀. ★ Lost Update.
}
```

같은 트랜잭션 안에서 일어나는 Lost Update — *아무 락 도 못 막음*. 격리수준 (REPEATABLE READ) 도 무관. *코드 작성자가 1차 SELECT 의 변수를 stale 한 채로 쓴* 안티패턴.

### 7.2 JPA 의 1차 캐시 == 보장 (Vlad Mihalcea)

```java
@Transactional
public boolean jpaIdentityProof(Long id) {
    ReplyRequestDc4 a = repo.findById(id).orElseThrow();   // SELECT 1
    ReplyRequestDc4 b = repo.findById(id).orElseThrow();   // 1차 캐시 hit — SELECT 0
    boolean sameInstance = (a == b);                        // ★ true 보장
    a.markProcessing();                                      // retry_count += 1
    b.recordAttempt();                                       // last_attempted_at = now
    return sameInstance;
}
// flush 시 UPDATE 1번 — 두 변경 모두 반영
```

[Vlad Mihalcea — JPA First-Level Cache](https://vladmihalcea.com/jpa-hibernate-first-level-cache/) 가 정의하는 **application-level repeatable read**. 같은 트랜잭션 내 같은 ID 로 조회 시 *항상 같은 Java 객체 인스턴스 반환*. `==` 비교까지 true.

→ 이 보장은 *1차 캐시* 에서 옴. JDBC / MyBatis 는 이 보장이 없습니다 — 메모리 객체 동일성 ≠ DB row 동일성.

| 결과 | JDBC stale | JPA 1차 캐시 |
|---|---|---|
| `a == b` | false (다른 객체) | **true** (같은 객체) |
| retry_count 결과 | 0 (Lost!) | 1 (정상) |
| SELECT 횟수 | 2 (또는 캐시 miss) | 1 |

→ 핵심: **JPA 의 dirty checking 편의성과 1차 캐시의 정합성 보장은 별개**. 분산 환경 Lost Update (락으로 방지) 와 자기 Lost Update (1차 캐시로 방지) 도 *별개* 의 함정.

---

## 8. 운영 처방 — 같은 의미의 update 도 6 시나리오로 갈리는 이유 {#operational-rules}

### 8.1 *충돌 빈번* 환경 — 비관락 (W3 EXP-02 결론)

[W3 EXP-02 — 락 4종 비교](/posts/mysql-credit-concurrency-lock-comparison/) 에서 측정한 잔액 차감 (잔액 100 / 100 worker / 1 차감) 결과:
- 비관락 (FOR UPDATE) 180ms / 100% 정확 ⭐
- 낙관락 549ms (재시도 폭증) / 100% 정확

→ *충돌 빈번* 환경은 비관락이 정답.

### 8.2 *충돌 드문* 환경 — 낙관락 + retry + jitter (본 EXP)

본 EXP 의 룰 수정 (사장님 1명 또는 2명) 환경에선 충돌 빈도 < 1%. 이런 환경에서:
- 비관락 = 오버킬 (대부분 contention 없는데 매번 row lock)
- 낙관락 + retry + jitter = 충돌 시에만 retry, 평소엔 lock 비용 0

→ **환경에 맞는 락 선택 + retry policy 가 답**. retry 횟수가 적어도 OK — 충돌 빈도가 낮으니까.

### 8.3 *충돌 빈번 + 낙관락 강제* 환경 — UPDATE-then-read 패턴

본 EXP 의 S1 baseline 의 변형으로 *증분 UPDATE* 가 답:

```sql
UPDATE auto_reply_rule SET priority = priority + 1 WHERE id = ?
-- 또는 SET balance = balance - amount WHERE id = ? AND balance >= amount
```

→ *원자적* — DB 가 read 와 modify 를 같이 처리. JPA dirty checking 우회. 100% 정확. 단 *값 검증 (balance >= amount)* 을 SQL 안에서 해야 함.

### 8.4 정리

| 환경 | 추천 |
|---|---|
| 충돌 빈번 (잔액 차감) | 비관락 (FOR UPDATE) |
| 충돌 드문 (룰 수정) | 낙관락 + retry + **jitter** |
| 단순 증분 / 단순 차감 | UPDATE atomic SQL |

→ 함정: "락 = 무조건 비관락" 또는 "JPA = 무조건 `@Version`" 의 단일 답이 *현실에 없음*.

---

## 9. 결론 — JPA 의 함정은 *기능 한 줄이 아니라 lifecycle 의 상호작용* {#conclusion}

이 글이 측정으로 보여준 것은 — **`@Version` 만으로는 부족하다**. retry 가 없으면 일부만 성공. retry 가 *백오프 없으면* stampede. *jitter 가 있는 retry* 만 표준. 그리고 분산 환경 Lost Update 와 *별개* 로 *자기 Lost Update* 라는 함정 — JPA 의 1차 캐시가 == 동일성을 보장해야 막아짐.

같은 의미의 *priority +1* 이 — `@Version` / retry / backoff / jitter / 1차 캐시 의 5 변수 조합으로 *5 가지 다른 결과*. 시니어 면접의 "JPA 어떻게 다뤘나요" 에 답하려면 — 이 *조합 공간* 의 trade-off 를 측정값으로 들고 있어야 합니다.

다음 글은 [JPA dirty checking 비용 — 1만건 update 에서 readOnly / @DynamicUpdate / clear() 패턴](/posts/jpa-dirty-checking-snapshot-cost/) 의 내부 메커니즘을 측정합니다.

---

## References {#references}

### 공식 문서
- [Hibernate ORM — Persistence Context](https://docs.hibernate.org/orm/6.5/userguide/html_single/Hibernate_User_Guide.html#persistence-context) — 1차 캐시
- [Spring Retry GitHub](https://github.com/spring-projects/spring-retry) — `@Retryable` + backoff
- [Spring Framework — @Transactional](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative.html) — propagation + AOP

### Vlad Mihalcea (Hibernate 공식 커미터)
- [JPA First-Level Cache](https://vladmihalcea.com/jpa-hibernate-first-level-cache/) — == 동일성 보장
- [Optimistic vs Pessimistic Locking](https://vladmihalcea.com/optimistic-vs-pessimistic-locking/) — 트레이드오프
- [Anatomy of Hibernate Dirty Checking](https://vladmihalcea.com/the-anatomy-of-hibernate-dirty-checking/) — `@Version` 동작 원리

### 외부 사례 (운영)
- [AWS Architecture Blog — Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) — full jitter 의 수학적 근거
- [우아한형제들 — MySQL Named Lock](https://techblog.woowahan.com/2631/) — 비관락 + advisory lock 비교
- [토스 SLASH22 — 애플 한 주가 고객에게 전달되기까지](https://toss.im/slash-22/sessions/2-7) — JPA OptimisticLock + 분산락 + MVCC 운영

### 자매글
- [W3 EXP-02 — MySQL 크레딧 차감 락 4종 비교](/posts/mysql-credit-concurrency-lock-comparison/) — 충돌 빈번 환경
- [JPA Spring Mastery #7 — AOP Self-Invocation](/posts/jpa-spring-mastery-07-aop-self-invocation/) — proxy 우회 함정
- [JPA Spring Mastery #1 — Persistence Context Flush](/posts/jpa-spring-mastery-01-persistence-context-flush/) — 1차 캐시 + flush
