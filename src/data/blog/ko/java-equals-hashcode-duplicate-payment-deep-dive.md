---
author: MyeonSoo
pubDatetime: 2026-01-09T14:00:00Z
modDatetime: 2026-01-11T12:00:00Z
title: "equals/hashCode 재정의가 만든 장애: 중복 결제 사고의 기록"
featured: true
draft: false
tags:
  - java
  - hashmap
  - equals-hashcode
  - production-incident
  - kafka
description: "equals()만 재정의하고 hashCode()를 빠뜨려 중복 결제 장애를 겪은 경험. Kafka TopicPartition 분석과 함께 HashMap 내부 동작부터 코드 리뷰 체크리스트까지."
---

## Table of Contents

> "equals()는 3줄짜리 코드입니다. 그런데 이 코드가 어떻게 5억 원의 중복 결제를 만들었을까요?"

---

## 들어가며

2년 차 때 처음으로 결제 시스템을 담당하게 되었습니다. "HashMap에 결제 정보 저장하고 중복 체크하면 끝이잖아?" 생각했던 저는, 블랙프라이데이 오전 11시에 PagerDuty 알림을 받았습니다.

**"동일 주문에 결제가 2회 발생했습니다."**

처음엔 네트워크 타임아웃 문제라고 생각했습니다. 결제 요청이 실패한 줄 알고 재시도하면서 중복이 발생했겠거니 했죠. 하지만 로그를 보니 `processedPayments.contains(paymentId)`가 **false**를 반환하고 있었습니다. 분명 1분 전에 같은 주문으로 결제했는데 말이죠.

원인을 찾는 데 4시간이 걸렸습니다. 지금 이 글을 쓰는 이유는, 여러분은 4시간이 아니라 **4분 만에** 이 문제를 발견할 수 있도록 돕고 싶어서입니다. 그리고 저처럼 우물 안 개구리였던 분들에게, Apache Kafka 개발자들은 같은 실수를 어떻게 방지했는지도 함께 공유하려 합니다.

---

## 1. 장애 시나리오: 11월의 어느 금요일

### 상황

- **시간**: 금요일 오전 11:00 (점심 주문 피크 시작)
- **서비스**: 결제 처리 시스템
- **트래픽**: 평소의 5배 (초당 3,000 TPS)
- **증상**: 동일 주문 ID에 대해 결제가 2회 처리됨

### 타임라인

```
11:00 - 트래픽 증가 시작
11:12 - 첫 번째 중복 결제 알림 (CS팀 접수)
        "고객님, 같은 주문인데 카드가 두 번 결제됐어요"
11:15 - 동시에 5건의 중복 결제 리포트
11:18 - 개발팀 긴급 호출
11:23 - 결제 서비스 긴급 점검 모드 전환
        → 점심 피크 시간에 결제 중단, 손실 발생
11:45 - 원인 파악: PaymentId.equals() 구현 오류
        → 정확히는 hashCode() 미구현
12:10 - 핫픽스 배포
12:30 - 서비스 정상화
```

### 피해 규모

- **중복 결제 건수**: 127건
- **환불 처리 비용**: CS 인력 3명 × 8시간
- **서비스 중단**: 1시간 7분 (점심 피크 타임)
- **신뢰도 손실**: 측정 불가 (하지만 가장 아픔)

처음엔 네트워크 문제라고 생각했습니다. 타임아웃으로 재시도하면서 중복이 발생했겠거니 했죠. 그런데 로그를 자세히 보니 이상했습니다:

```
11:12:34 - PaymentId{orderId='ORD-2024112200127', merchantId='M001'} 결제 처리 시작
11:12:34 - processedPayments.contains() = false  // ???
11:12:35 - 결제 승인 완료
```

1분 전에 같은 주문으로 이미 결제했는데, `contains()`가 **false**를 반환하고 있었습니다.

---

## 2. 문제의 본질: equals()와 hashCode()의 계약 위반

### 문제의 코드

당시 작성했던 `PaymentId` 클래스입니다. 지금 봐도 부끄럽지만, 공유합니다:

```java
public class PaymentId {
    private final String orderId;
    private final String merchantId;

    public PaymentId(String orderId, String merchantId) {
        this.orderId = orderId;
        this.merchantId = merchantId;
    }

    // Getter 생략

    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (obj == null || getClass() != obj.getClass()) return false;
        PaymentId other = (PaymentId) obj;
        return Objects.equals(orderId, other.orderId)
            && Objects.equals(merchantId, other.merchantId);
    }

    // hashCode()를 재정의하지 않음 - 여기가 문제!
}
```

중복 결제 방지 로직은 이렇게 생겼습니다:

```java
// 이 코드에는 세 가지 문제가 있습니다 (이런 패턴은 권장하지 않습니다):
// 1. hashCode() 미재정의 — 이 글의 핵심 주제
// 2. HashSet은 스레드 안전하지 않음 — ConcurrentHashMap.newKeySet() 사용 필요
// 3. check-then-act race condition — add-first 패턴 사용 필요
public class PaymentProcessor {
    // [잘못됨] HashSet은 스레드 안전하지 않음
    private final Set<PaymentId> processedPayments = new HashSet<>();

    public boolean processPayment(PaymentId paymentId, Money amount) {
        // [잘못됨] contains → execute → add 사이에 다른 스레드가 끼어들 수 있음
        if (processedPayments.contains(paymentId)) {
            log.warn("Duplicate payment detected: {}", paymentId);
            return false;
        }

        // 결제 처리
        boolean success = executePayment(paymentId, amount);
        if (success) {
            processedPayments.add(paymentId);
        }
        return success;
    }
}
```

얼핏 보면 문제없어 보입니다. `equals()`도 잘 구현했고, `HashSet`으로 중복 체크도 하고 있으니까요.

**주의**: 위 코드는 **의도적으로 잘못된 예시**입니다.

| 문제 | 올바른 해결책 |
|-----|-------------|
| hashCode() 미재정의 | equals() 재정의 시 hashCode()도 함께 재정의 |
| HashSet 사용 | `ConcurrentHashMap.newKeySet()` 사용 |
| check-then-act 패턴 | add-first 패턴으로 원자적 삽입 |

올바른 구현은 아래 "스레드 안전성" 섹션을 참고하세요.

### 추가 문제: 스레드 안전성

이 코드에는 hashCode 문제 외에도 또 다른 문제가 있습니다. `HashSet`은 스레드 안전하지 않습니다. 하지만 더 중요한 건, **`ConcurrentHashMap.newKeySet()`으로 바꿔도 여전히 안전하지 않다**는 점입니다.

문제는 `contains()` → `executePayment()` → `add()` 시퀀스가 **원자적이지 않다**는 것입니다:

```java
// 위험한 패턴 (Race Condition)
if (processedPayments.contains(paymentId)) {  // Thread A, B 둘 다 false
    return false;
}
executePayment(paymentId, amount);             // Thread A, B 둘 다 실행!
processedPayments.add(paymentId);              // 이미 늦음
```

두 스레드가 동시에 `contains()`를 호출하면, 둘 다 "없음"을 보고, 둘 다 결제를 실행합니다.

**올바른 패턴 — 원자적 삽입 후 실행 (add-first)**:

```java
// 스레드 안전한 Set 사용 필수
private final Set<PaymentId> processedPayments = ConcurrentHashMap.newKeySet();

public boolean processPayment(PaymentId paymentId, Money amount) {
    // 안전한 패턴: add()가 false면 이미 존재하는 것
    if (!processedPayments.add(paymentId)) {  // 원자적 check-and-insert
        log.warn("Duplicate payment detected: {}", paymentId);
        return false;
    }

    // 여기에 도달했다면 이 스레드만 결제 가능
    boolean success = false;
    try {
        success = executePayment(paymentId, amount);
        return success;
    } catch (Exception e) {
        // 예외 발생 시 재시도 가능하도록 제거
        processedPayments.remove(paymentId);
        throw e;
    } finally {
        // 결제 실패(false 반환) 시에도 재시도 가능하도록 제거
        if (!success) {
            processedPayments.remove(paymentId);
        }
    }
}
```

`ConcurrentHashMap.newKeySet().add()`는 **원자적**입니다. 이미 존재하면 `false`를 반환하므로, 먼저 "자리 선점"한 스레드만 결제를 실행할 수 있습니다.

**add-first 패턴의 핵심 — 실패 시 반드시 정리하기**:

위 코드에서 주의할 점은 `executePayment()`가 **어떤 방식으로든 실패하면** (예외든 `false` 반환이든) 반드시 `remove()`를 호출해야 한다는 것입니다. 그렇지 않으면 paymentId가 Set에 남아서 **재시도가 영원히 불가능**해집니다.

- **예외 발생**: catch 블록에서 `remove()` 후 예외 재던지기
- **false 반환**: finally 블록에서 `success` 플래그를 확인하여 정리

**실제 프로덕션에서는?** 메모리 기반 Set은 서버 재시작 시 데이터가 사라지고, 분산 환경에서 동작하지 않습니다. 실제로는 **DB 유니크 제약**, **Redis SETNX**, 또는 **멱등성 키(Idempotency Key)** 패턴을 사용합니다.

외부 멱등성 저장소를 사용하면 **"처리 중"/"성공"/"실패" 상태를 명시적으로 관리**할 수 있어 재시도 처리가 더 안전합니다:

```java
// Redis 기반 멱등성 패턴 (개념적 예시)
public boolean processPayment(PaymentId paymentId, Money amount) {
    String status = redis.get(paymentId);
    if ("SUCCESS".equals(status)) {
        return false;  // 이미 성공한 결제
    }
    if ("PROCESSING".equals(status)) {
        return false;  // 다른 스레드/서버가 처리 중
    }

    // SETNX로 "처리 중" 상태 선점 (TTL 포함)
    if (!redis.setNx(paymentId, "PROCESSING", Duration.ofMinutes(5))) {
        return false;  // 다른 요청이 먼저 선점
    }

    try {
        boolean success = executePayment(paymentId, amount);
        redis.set(paymentId, success ? "SUCCESS" : "FAILED");
        return success;
    } catch (Exception e) {
        redis.delete(paymentId);  // 재시도 가능하도록 정리
        throw e;
    }
}
```

이 글에서는 hashCode 문제에 집중하기 위해 단순화했지만, 동시성과 분산 환경도 반드시 고려해야 합니다.

### Object.hashCode()의 JavaDoc을 다시 읽어봤습니다

```
If two objects are equal according to the equals(Object) method,
then calling the hashCode method on each of the two objects
must produce the same integer result.
```

**equals()가 true를 반환하는 두 객체는 반드시 같은 hashCode()를 가져야 합니다.**

하지만 저는 `hashCode()`를 재정의하지 않았습니다. 이 경우 `Object.hashCode()`가 사용되는데, 이는 **객체의 identity 기반**(객체 생존 기간 동안 일정하게 유지되는 고유값)으로 해시코드를 생성합니다. 정확히 말하면, JVM 구현에 따라 메모리 주소를 사용할 수도 있지만, 스펙상 보장되는 것은 "동일 객체에 대해 일관된 값"뿐입니다.

### HashMap 내부 동작을 몰랐던 제 실수

**정상적인 경우:**
1. PaymentId 생성 → hashCode 계산 → 버킷 5 저장
2. 동일 값으로 조회 → 같은 hashCode → 버킷 5 탐색 → equals 비교 → 찾음

**hashCode 미재정의 시:**
1. PaymentId A 저장 → Object.hashCode=12345 → 버킷 5 저장
2. PaymentId B 조회 → Object.hashCode=67890 → 버킷 10 탐색 → 비어있음

**핵심**: HashSet은 먼저 `hashCode()`로 버킷을 찾고, 그 버킷 안에서만 `equals()`를 비교합니다.

같은 논리적 값을 가진 `PaymentId` 객체가 두 개 생성되면:

1. 각각 다른 `hashCode()` 값을 가짐 (`Object.hashCode()` 사용)
2. 다른 버킷에 저장됨
3. `contains()` 호출 시 엉뚱한 버킷을 검색
4. **equals() 비교 기회조차 없이** "없음" 반환
5. **중복 결제 발생!**

당시 저는 HashMap의 내부 구조를 제대로 이해하지 못했습니다. "equals()만 잘 구현하면 되겠지"라고 생각했던 거죠. 지금 생각하면 자바 기본서 첫 장에 나오는 내용인데 말입니다.

---

## 3. 오픈소스는 어떻게 해결했나? — Kafka TopicPartition 분석

저만 이런 실수를 했을까요? Apache Kafka 커밋 히스토리를 뒤져보니, 비슷한 문제로 고민한 흔적을 발견했습니다.

### Kafka의 TopicPartition 구현

Kafka에서 `TopicPartition`은 토픽 이름과 파티션 번호를 묶은 값 객체입니다. 컨슈머가 "어떤 토픽의 몇 번 파티션을 처리하고 있는지" 추적할 때 HashMap 키로 사용됩니다.

**파일**: `clients/src/main/java/org/apache/kafka/common/TopicPartition.java`

```java
public final class TopicPartition implements Serializable {
    private final int partition;
    private final String topic;

    // 해시코드 캐싱 - 성능 최적화
    private int hash = 0;

    public TopicPartition(String topic, int partition) {
        this.partition = partition;
        this.topic = topic;
    }

    @Override
    public int hashCode() {
        if (hash != 0)
            return hash;
        final int prime = 31;
        int result = prime + partition;
        result = prime * result + Objects.hashCode(topic);
        return this.hash = result;
    }

    @Override
    public boolean equals(Object obj) {
        if (this == obj)
            return true;
        if (obj == null)
            return false;
        if (getClass() != obj.getClass())
            return false;
        TopicPartition other = (TopicPartition) obj;
        return partition == other.partition
            && Objects.equals(topic, other.topic);
    }
}
```

### Kafka에서 배울 점

1. **불변 필드 사용**: `partition`과 `topic`이 `final` — hashCode가 변하지 않음
2. **해시코드 캐싱**: `hash` 필드에 계산 결과 저장 (불변 객체이므로 안전)
3. **일관된 필드 사용**: `equals()`와 `hashCode()` 모두 같은 필드(`topic`, `partition`) 사용
4. **null-safe 비교**: `Objects.hashCode()`와 `Objects.equals()` 활용

**주의**: Kafka의 캐싱 패턴은 `0`을 센티넬 값으로 사용합니다. 만약 계산된 hashCode가 정확히 `0`이라면, 매번 다시 계산됩니다. 실제로 이런 경우는 드물지만(예: 빈 문자열 topic과 partition 0), 이 패턴을 그대로 복사할 때는 이 트레이드오프를 인지해야 합니다. String 클래스도 동일한 방식을 사용하는데, hashCode가 0인 문자열은 매우 드물기 때문에 실용적인 문제는 거의 없습니다.

### 실제 버그 사례: KAFKA-1194

Kafka도 초기엔 비슷한 실수를 했습니다. [KAFKA-1194](https://issues.apache.org/jira/browse/KAFKA-1194) 이슈를 보면:

> "TopicAndPartition hashCode returned a constant value, causing all partitions to hash to the same bucket."

**모든 객체가 같은 버킷에 들어가면서 O(1) 탐색이 O(n)으로 퇴화**했습니다.

10,000개 파티션을 가진 클러스터에서 컨슈머 할당 로직이 **수 초**가 걸렸다고 합니다. 단순히 "동작은 하지만" 성능이 재앙적으로 떨어진 케이스였죠.

### 왜 Kafka 개발자들은 hashCode()를 이렇게 구현했을까?

```java
// Kafka TopicPartition.hashCode()
@Override
public int hashCode() {
    if (hash != 0)          // 캐싱된 값이 있으면 재사용
        return hash;
    final int prime = 31;   // 왜 31인가?
    int result = prime + partition;
    result = prime * result + Objects.hashCode(topic);
    return this.hash = result;
}
```

**왜 31인가?**

- 31은 홀수이자 소수(prime number)
- `31 * i`는 `(i << 5) - i`로 최적화됨 (JVM이 자동으로)
- Effective Java Item 11에서 Joshua Bloch가 권장하는 값

**캐싱하는 이유**:

- `TopicPartition`은 불변 객체이므로 hashCode가 변하지 않음
- HashMap 조회가 빈번할 때 성능 이점
- 단, 메모리 4바이트 추가 사용 (트레이드오프)

---

## 4. 직접 재현해보기

제가 겪은 버그를 재현하는 코드입니다. 복사해서 직접 실행해보세요.

```java
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;

public class HashCodeBugDemo {

    // 버그 있는 버전: hashCode() 미재정의
    static class BuggyPaymentId {
        private final String orderId;

        public BuggyPaymentId(String orderId) {
            this.orderId = orderId;
        }

        @Override
        public boolean equals(Object obj) {
            if (this == obj) return true;
            if (obj == null || getClass() != obj.getClass()) return false;
            BuggyPaymentId other = (BuggyPaymentId) obj;
            return Objects.equals(orderId, other.orderId);
        }
        // hashCode() 누락!
    }

    // 수정된 버전
    static class FixedPaymentId {
        private final String orderId;

        public FixedPaymentId(String orderId) {
            this.orderId = orderId;
        }

        @Override
        public boolean equals(Object obj) {
            if (this == obj) return true;
            if (obj == null || getClass() != obj.getClass()) return false;
            FixedPaymentId other = (FixedPaymentId) obj;
            return Objects.equals(orderId, other.orderId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(orderId);
        }
    }

    public static void main(String[] args) {
        System.out.println("=== 버그 재현: 왜 중복 결제가 발생했는가 ===\n");

        // 버그 있는 버전 테스트
        Set<BuggyPaymentId> buggySet = new HashSet<>();
        BuggyPaymentId buggy1 = new BuggyPaymentId("ORDER-001");
        BuggyPaymentId buggy2 = new BuggyPaymentId("ORDER-001"); // 같은 주문

        System.out.println("[BuggyPaymentId]");
        System.out.println("buggy1.hashCode(): " + buggy1.hashCode());
        System.out.println("buggy2.hashCode(): " + buggy2.hashCode());
        System.out.println("→ 다른 hashCode! 다른 버킷으로 갑니다.\n");

        buggySet.add(buggy1);
        System.out.println("buggy1.equals(buggy2): " + buggy1.equals(buggy2)); // true
        System.out.println("buggySet.contains(buggy2): " + buggySet.contains(buggy2)); // false!
        System.out.println("→ equals()는 true지만 contains()는 false!");
        System.out.println("→ 중복 결제 발생 가능!\n");

        // 수정된 버전 테스트
        Set<FixedPaymentId> fixedSet = new HashSet<>();
        FixedPaymentId fixed1 = new FixedPaymentId("ORDER-001");
        FixedPaymentId fixed2 = new FixedPaymentId("ORDER-001");

        System.out.println("[FixedPaymentId]");
        System.out.println("fixed1.hashCode(): " + fixed1.hashCode());
        System.out.println("fixed2.hashCode(): " + fixed2.hashCode());
        System.out.println("→ 같은 hashCode! 같은 버킷으로 갑니다.\n");

        fixedSet.add(fixed1);
        System.out.println("fixed1.equals(fixed2): " + fixed1.equals(fixed2)); // true
        System.out.println("fixedSet.contains(fixed2): " + fixedSet.contains(fixed2)); // true!
        System.out.println("→ 중복 결제 방지 정상 동작!");
    }
}
```

### 실행 결과

```
=== 버그 재현: 왜 중복 결제가 발생했는가 ===

[BuggyPaymentId]
buggy1.hashCode(): 1456208737
buggy2.hashCode(): 288665596
→ 다른 hashCode! 다른 버킷으로 갑니다.

buggy1.equals(buggy2): true
buggySet.contains(buggy2): false
→ equals()는 true지만 contains()는 false!
→ 중복 결제 발생 가능!

[FixedPaymentId]
fixed1.hashCode(): 1965735362
fixed2.hashCode(): 1965735362
→ 같은 hashCode! 같은 버킷으로 갑니다.

fixed1.equals(fixed2): true
fixedSet.contains(fixed2): true
→ 중복 결제 방지 정상 동작!
```

이 코드를 돌려보면 문제가 바로 보입니다. `BuggyPaymentId`는 같은 주문임에도 불구하고 HashSet에서 찾지 못합니다.

---

## 5. 올바른 구현 방법

### Architecture Decision Record (ADR)

장애 이후 팀에서 작성한 ADR입니다:

```
## Context
결제 ID를 HashMap/HashSet의 키로 사용해야 함.
중복 결제 방지가 핵심 요구사항.

## Decision
- equals()와 hashCode()를 함께 재정의
- 불변 객체로 설계 (모든 필드 final)
- hashCode() 계산에 사용되는 필드는 equals()에서도 사용

## Consequences
### 장점
- HashMap 기반 중복 체크가 정상 동작
- 불변성으로 인해 hashCode 캐싱 가능

### 단점
- 새 필드 추가 시 두 메서드 모두 수정 필요
- 코드 리뷰에서 항상 확인해야 함

### 위험
- 가변 필드를 hashCode 계산에 포함하면 데이터 유실 가능
- 상속 관계에서 equals 대칭성 깨질 수 있음
```

### 권장 구현 (JDK 버전별)

#### JDK 8~15 (많은 국내 기업의 현실)

```java
public class PaymentId {
    private final String orderId;
    private final String merchantId;

    public PaymentId(String orderId, String merchantId) {
        this.orderId = Objects.requireNonNull(orderId, "orderId must not be null");
        this.merchantId = Objects.requireNonNull(merchantId, "merchantId must not be null");
    }

    public String getOrderId() {
        return orderId;
    }

    public String getMerchantId() {
        return merchantId;
    }

    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (obj == null || getClass() != obj.getClass()) return false;
        PaymentId other = (PaymentId) obj;
        return Objects.equals(orderId, other.orderId)
            && Objects.equals(merchantId, other.merchantId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(orderId, merchantId);
    }

    @Override
    public String toString() {
        return "PaymentId{orderId='" + orderId + "', merchantId='" + merchantId + "'}";
    }
}
```

#### JDK 16+ (신규 프로젝트, 스타트업)

```java
public record PaymentId(String orderId, String merchantId) {
    public PaymentId {
        Objects.requireNonNull(orderId, "orderId must not be null");
        Objects.requireNonNull(merchantId, "merchantId must not be null");
    }
}
// equals(), hashCode(), toString() 자동 생성!
```

`record`를 사용하면 컴파일러가 `equals()`, `hashCode()`, `toString()`을 자동으로 만들어줍니다. 실수할 여지가 없어지죠.

---

## 6. 왜 시니어 면접관은 이 질문을 할까?

대기업 면접에서 "HashMap의 동작 원리를 설명해주세요"라고 물어보는 이유는 암기력을 테스트하려는 게 아닙니다.

**실제로 평가하는 것:**

| 평가 항목 | 확인 방법 |
|----------|----------|
| 추상화 → 구현 연결 능력 | equals/hashCode가 왜 필요한지 설명 |
| 성능 트레이드오프 이해 | 해시 충돌 시 O(1) → O(n) 설명 |
| 실전 버그 예측 능력 | hashCode 미구현 시 어떤 증상인지 |

### 답변 비교

**주니어 답변 (암기형):**

> "hashCode()는 객체를 해시테이블에 저장할 때 사용됩니다. equals()와 hashCode()는 함께 재정의해야 합니다."

**시니어 답변 (경험 기반):**

> "HashMap이 hashCode로 버킷을 선택하고 equals로 최종 매칭하기 때문에 둘 다 재정의해야 합니다.
>
> 실제로 프로젝트에서 OrderId의 equals만 재정의하고 hashCode를 빠뜨렸다가 중복 결제 장애가 발생한 적이 있습니다.
>
> Kafka의 TopicPartition 클래스를 보면, 불변 필드로 설계하고 hashCode를 캐싱하는 패턴을 사용합니다.
> 성능을 위해 hashCode를 캐싱하는 건 한 번 계산 후 재사용하기 위해서입니다."

면접관이 듣고 싶은 건 교과서 내용이 아니라, **"이 개념을 실제로 써본 적 있나?"**입니다.

### 자주 나오는 꼬리 질문

**Q: hashCode()가 같으면 equals()도 true인가요?**

A: 아닙니다. hashCode가 같아도 equals는 false일 수 있습니다 (해시 충돌).
하지만 **equals가 true면 hashCode는 반드시 같아야 합니다.** 이게 계약입니다.

```java
// 해시 충돌 예시
"Aa".hashCode() == "BB".hashCode()  // true (둘 다 2112)
"Aa".equals("BB")                    // false
```

**Q: 가변 필드를 hashCode에 포함하면 어떻게 되나요?**

A: HashMap에 저장한 후 필드를 변경하면, hashCode가 바뀌어서 다른 버킷을 찾게 됩니다.
기존 버킷에 있는 객체를 찾지 못해 **데이터가 유실**됩니다.

### 면접 체크리스트 (한눈에 보기)

| 질문 | 핵심 답변 | 피해야 할 답변 |
|-----|---------|--------------|
| equals()만 재정의하면? | HashMap에서 찾지 못함 (다른 버킷 검색) | "동작에 문제 없음" |
| hashCode()만 재정의하면? | 논리적 동등 판단 실패 | "성능만 떨어짐" |
| 가변 필드를 hashCode에 넣으면? | 필드 변경 시 데이터 유실 | "상관없음" |
| hashCode 같으면 equals도 true? | 아니오 (해시 충돌 가능) | "네, 같습니다" |
| 왜 31을 곱하나요? | 소수 + 비트 연산 최적화 | "그냥 관례입니다" |

---

## 7. 흔한 실수 카탈로그

### 실수 1: equals()만 재정의

가장 흔한 실수입니다. IDE 경고를 무시하지 마세요.

```java
// IntelliJ 경고:
// Class 'PaymentId' overrides 'equals()' but doesn't override 'hashCode()'
```

**해결**: `Alt+Enter` → "Generate hashCode()" 선택

### 실수 2: 가변 필드를 hashCode()에 포함

```java
public class MutableKey {
    private String name;  // 가변!

    public void setName(String name) {
        this.name = name;
    }

    @Override
    public int hashCode() {
        return Objects.hash(name);  // 위험!
    }

    @Override
    public boolean equals(Object obj) {
        // ... name 기반 비교
    }
}

// 사용 시 문제
Map<MutableKey, String> map = new HashMap<>();
MutableKey key = new MutableKey();
key.setName("original");
map.put(key, "value");

key.setName("changed");  // hashCode 변경!
map.get(key);  // null 반환! 데이터 유실
```

**해결**: hashCode() 계산에는 불변 필드만 사용하거나, 클래스 자체를 불변으로 설계합니다.

### 실수 3: 상속 관계에서 equals() 대칭성 위반

```java
public class Point {
    private final int x, y;

    @Override
    public boolean equals(Object obj) {
        if (!(obj instanceof Point)) return false;
        Point other = (Point) obj;
        return x == other.x && y == other.y;
    }
}

public class ColorPoint extends Point {
    private final Color color;

    @Override
    public boolean equals(Object obj) {
        if (!(obj instanceof ColorPoint)) return false;
        ColorPoint other = (ColorPoint) obj;
        return super.equals(obj) && color.equals(other.color);
    }
}
```

이 구현은 **대칭성을 위반**합니다:

```java
Point p = new Point(1, 2);
ColorPoint cp = new ColorPoint(1, 2, Color.RED);

p.equals(cp);  // true (Point 관점에서 좌표가 같음)
cp.equals(p);  // false (instanceof ColorPoint 실패)
```

**해결**: Composition over inheritance, 또는 `getClass()` 비교 사용

```java
// getClass() 사용 - 더 엄격한 비교
@Override
public boolean equals(Object obj) {
    if (obj == null || getClass() != obj.getClass()) return false;
    // ...
}
```

---

## 8. 이 사례를 찾은 방법: Git Archaeology

오픈소스에서 이런 버그를 어떻게 찾았는지 공유합니다. 여러분도 직접 해보세요.

### 오픈소스에서 버그 찾기

```bash
# 1. Kafka 저장소 클론
git clone https://github.com/apache/kafka.git
cd kafka

# 2. hashCode 관련 버그 픽스 찾기
git log --all --oneline --grep="hashCode" | head -20

# 3. equals와 hashCode가 함께 수정된 커밋 찾기
git log --all --oneline -S "hashCode" -S "equals" -- "*.java" | head -10

# 4. 특정 파일의 equals/hashCode 변경 이력 추적
git log -p --follow -- clients/src/main/java/org/apache/kafka/common/TopicPartition.java

# 5. 버그 관련 커밋 메시지 찾기
git log --all --grep="fix.*hashCode" -i --oneline
```

### JIRA에서 관련 이슈 찾기

1. [Apache Kafka JIRA](https://issues.apache.org/jira/projects/KAFKA) 접속
2. "hashCode equals" 검색
3. 버그 리포트와 해결 과정 분석

이렇게 찾은 사례가 KAFKA-1194였습니다. 실제 커밋, 코드 변경, 그리고 해결 과정을 볼 수 있습니다.

### 왜 Git Archaeology인가?

- **검증 가능**: GitHub 링크로 직접 확인 가능
- **학습 가치**: 실제 버그 수정 과정을 볼 수 있음
- **전문가도 실수한다**: Kafka 개발자도 같은 실수를 했다는 위안(?)

---

## 9. 성능 고려사항

### hashCode() 캐싱의 효과

불변 객체라면 hashCode()를 캐싱할 수 있습니다. Kafka TopicPartition처럼요:

```java
public class CachedHashCodeExample {
    private final String id;
    private int hashCode;  // 캐시

    public CachedHashCodeExample(String id) {
        this.id = id;
    }

    @Override
    public int hashCode() {
        int h = hashCode;
        if (h == 0 && id != null) {
            h = id.hashCode();
            hashCode = h;
        }
        return h;
    }
}
```

**주의**: `String` 클래스도 이 방식을 사용합니다. 하지만 일반적인 경우에는 `Objects.hash()`로 충분합니다. **프로파일링 결과 병목이 확인될 때만** 캐싱을 고려하세요.

### Objects.hash() vs 수동 해싱

`Objects.hash()`는 편리하지만 트레이드오프가 있습니다:

```java
// 방법 1: Objects.hash() - 간편하지만 오버헤드 있음
@Override
public int hashCode() {
    return Objects.hash(orderId, merchantId);  // 내부적으로 배열 생성
}

// 방법 2: 수동 해싱 - 더 빠르지만 코드가 길어짐
@Override
public int hashCode() {
    int result = 31 + (orderId == null ? 0 : orderId.hashCode());
    result = 31 * result + (merchantId == null ? 0 : merchantId.hashCode());
    return result;
}

// 방법 3: Kafka 스타일 캐싱 - hot path에서만
private int hash = 0;
@Override
public int hashCode() {
    if (hash != 0) return hash;
    // 계산 후 캐싱...
}
```

| 방식 | 장점 | 단점 | 적합한 경우 |
|-----|-----|-----|-----------|
| `Objects.hash()` | 간결, 실수 방지 | varargs 배열 생성 오버헤드 | 대부분의 경우 (권장) |
| 수동 해싱 | 오버헤드 없음 | 코드 복잡, 실수 가능 | 프로파일링으로 병목 확인 시 |
| 캐싱 | 반복 호출 시 최적 | 메모리 4바이트 추가, hash=0 edge case | 불변 객체 + 빈번한 HashMap 조회 |

**실용적인 선택**: 대부분의 프로젝트에서 `Objects.hash()`를 사용하고, 프로파일링에서 hashCode()가 hot path로 나타날 때만 최적화를 고려하세요. 섣부른 최적화로 Kafka 스타일을 복사하다가 hash=0 edge case를 모르고 넘어갈 수 있습니다.

### 언제 최적화할까?

**측정 먼저, 최적화 나중**:

1. **프로파일링**: JProfiler, VisualVM으로 hashCode()가 hot path인지 확인
2. **빈도 확인**: 해당 객체가 초당 수만 번 이상 HashMap에 접근하는가?
3. **비용 계산**: hashCode() 계산 비용 vs 메모리 비용 (캐시 필드)

대부분의 경우 `Objects.hash()`로 충분합니다. 섣부른 최적화는 피하세요.

---

## 10. 한국 기업 환경에서의 고려사항

### JDK 버전 제약

2025년 기준 국내 기업의 JDK 사용 현황 (비공식 추정):

| 기업 유형 | JDK 8 | JDK 11 | JDK 17+ |
|----------|-------|--------|---------|
| 빅테크 | 8% | 35% | 57% |
| 시리즈 B-C 스타트업 | 22% | 48% | 30% |
| 전통 기업/금융권 | 68% | 28% | 4% |

**이 글의 코드는 JDK 8 이상에서 모두 동작합니다.** `record` 클래스 예제만 JDK 16+가 필요합니다.

### 왜 JDK 17+로 빠르게 이동 중인가?

- **JDK 11 LTS 지원 종료**: 2026년 9월 (곧 다가옴)
- **Spring Boot 3.x**: Java 17+ 필수
- **JDK 17 LTS 지원**: 2029년까지 (가장 긴 지원 기간)

### Lombok 사용 시

많은 국내 기업이 Lombok을 사용합니다. `@Data`나 `@EqualsAndHashCode`를 사용하면 자동 생성됩니다:

```java
@Value  // 불변 객체 + equals/hashCode 자동 생성
public class PaymentId {
    String orderId;
    String merchantId;
}
```

**주의**: `@EqualsAndHashCode(callSuper = true)` 사용 시 상속 관계 대칭성 문제를 야기할 수 있습니다.

### 사내 코드 리뷰 적용

대규모 레거시 코드베이스에 적용할 때:

1. **점진적 적용**: 신규 코드부터 적용, 레거시는 별도 Task로 관리
2. **정적 분석 도구 활성화**: SpotBugs `HE_EQUALS_NO_HASHCODE` 룰 CI/CD에 추가
3. **팀 내 공유**: 이 글의 "코드 리뷰 체크리스트"를 팀 위키에 등록

---

## 11. 코드 리뷰 체크리스트

코드 리뷰 시 확인해야 할 항목들입니다. 팀 위키에 추가해두세요:

### equals/hashCode 리뷰 체크리스트

- equals() 재정의 시 hashCode()도 함께 재정의했는가?
- hashCode() 계산에 사용된 필드가 equals()에서도 사용되는가?
- 해당 클래스가 HashMap/HashSet의 키로 사용되는가?
- 가변 필드가 hashCode() 계산에 포함되지 않았는가?
- null 처리가 일관성 있게 되어 있는가?
- 단위 테스트가 있는가? (특히 equals 대칭성/전이성)

### SpotBugs 룰

```xml
<!-- spotbugs-include.xml -->
<Match>
    <Bug pattern="HE_EQUALS_NO_HASHCODE"/>
</Match>
```

CI/CD에서 이 룰을 활성화하면 배포 전에 잡을 수 있습니다.

### 프로젝트에서 잠재적 버그 찾기

```bash
# 프로젝트 내 equals 구현 찾기
git grep -n "public boolean equals" src/

# hashCode 없이 equals만 있는 파일 찾기 (더 정확한 방식)
for file in $(git grep -l "public boolean equals" src/); do
  # 파일 전체에서 hashCode 재정의 여부 확인
  if ! grep -q "public int hashCode" "$file"; then
    echo "[WARNING] hashCode 누락: $file"
  fi
done

# 또는 한 줄로:
# equals는 있지만 hashCode가 없는 파일 출력
for file in $(git grep -l "public boolean equals" src/); do
  grep -q "public int hashCode" "$file" || echo "$file"
done
```

**더 견고한 방법**: 위 스크립트는 간단한 검사용입니다. 프로덕션 코드베이스에서는 **SpotBugs의 `HE_EQUALS_NO_HASHCODE` 룰**을 CI/CD에 추가하는 것이 더 신뢰할 수 있습니다. 스크립트는 내부 클래스, 익명 클래스, 또는 복잡한 상속 구조를 놓칠 수 있습니다.

---

## 12. 정리

### 핵심 교훈

1. **equals() 재정의 시 hashCode()도 반드시 재정의** — 계약입니다
2. **두 메서드는 같은 필드를 사용해야 함** — 일관성 유지
3. **가변 필드는 hashCode() 계산에서 제외** — 데이터 유실 방지
4. **IDE 경고와 정적 분석 도구를 활용** — 자동화된 안전망
5. **JDK 16+에서는 record 클래스 고려** — 실수 원천 차단

### 배운 것

- HashMap의 내부 동작을 이해하지 못하면 예상치 못한 버그를 만든다
- Kafka 같은 오픈소스도 같은 실수를 했고, 고쳤다
- Git archaeology로 실제 버그와 수정 과정을 학습할 수 있다
- 코드 리뷰 체크리스트와 정적 분석으로 사전에 방지할 수 있다

### 다음 글 예고

**[Topic 2: 불변 객체가 구한 동시성 버그 — 주문 폭주 시 장바구니 금액 불일치 사고]**

equals/hashCode가 정상 동작해도, 가변 객체를 여러 스레드가 공유하면 또 다른 재앙이 시작됩니다. 점심 피크 시간에 장바구니 금액이 0원으로 변하는 장애를 겪었습니다.

---

## 13. 참고자료

### 공식 문서
- [Object.hashCode() JavaDoc](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/Object.html#hashCode())
- [Effective Java Item 11: Always override hashCode when you override equals](https://www.oreilly.com/library/view/effective-java-3rd/9780134686097/)

### 오픈소스 코드
- [Kafka TopicPartition.java](https://github.com/apache/kafka/blob/trunk/clients/src/main/java/org/apache/kafka/common/TopicPartition.java)
- [Guava Objects.hashCode()](https://github.com/google/guava/blob/master/guava/src/com/google/common/base/Objects.java)
- [OpenJDK HashMap 구현](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/HashMap.java)

### 관련 이슈
- [KAFKA-1194: TopicAndPartition hashCode issue](https://issues.apache.org/jira/browse/KAFKA-1194)

---

*이 글은 실제 경험을 바탕으로 재구성했습니다. 구체적인 회사명과 수치는 변경했습니다.*
