---
author: 김면수
pubDatetime: 2026-05-04T14:30:00.000Z
title: "Aggregate boundary 를 *권한* 으로 강제 — 한 schema 에 5 user 분리 + cross-domain write 차단 7/7 실측"
featured: true
draft: false
tags:
  - MySQL
  - DDD
  - Aggregate
  - Microservices
  - SchemaDesign
  - Permission
  - Backend
  - Architecture
description: |
  Distributed Monolith 의 가장 흔한 함정 — *모든 도메인이 같은 user 로 같은 schema 에 접근* 하니 cross-domain write 가 코드 리뷰에서만 잡힘. W4 P5 에서 같은 schema 에 5 user (be_owner / be_billing / be_persona / be_rule / be_workflow) 분리 + GRANT 로 cross-domain WRITE 를 *런타임* 에 ERROR 1142 로 차단. 7/7 검증 시나리오 모두 의도대로 동작 — 잘못된 코드가 *DB 가 직접* 잡아주는 첫 단계. 이 글은 "왜 같은 schema 안에서 user 분리가 의미 있는가" 의 *진화 전략* (W3 논리적 namespace → W4 user 분리 → W6 별도 DB 인스턴스) 의 두 번째 단계 측정 기록입니다.
---

## Table of contents

## 들어가며 {#intro}

DDD 의 *Aggregate* — "한 트랜잭션 안에 같이 변하는 entity 묶음" 이라는 정의는 책에서 봤습니다. 그런데 *팀 코드* 에서 이 boundary 가 어떻게 강제되나요?

대부분 답은 *코드 리뷰* 입니다. PR 에서 "왜 결제 모듈이 사장님 도메인의 `auto_reply_rule` 을 직접 UPDATE 하지?" 라는 코멘트가 달리길 *바랄* 뿐. **실수가 머지되면** — 빌드 통과, 테스트 통과, 운영 사고로 폭발.

본 글은 그 boundary 를 *DB 권한* 으로 강제한 이야기. 같은 schema 안에 5 user 를 만들고 GRANT 를 쪼개서, 잘못된 cross-domain write 가 *런타임* 에 `ERROR 1142` 로 거부되는 환경을 구축했습니다. 7/7 검증 시나리오 모두 의도대로 동작.

> **[실측 — 인프라 / Java/Spring Stage 2 / 2026-05-04]** 본 측정의 모든 결과는 [`commerce-comment-platform-be/measurements/p5-permissions/`](https://github.com/PreAgile/commerce-comment-platform-be) 에 raw 로그로 보존.

---

## 1. 진화 전략 — W3 논리적 namespace → W4 user 분리 → W6 별도 DB {#strategy}

```
W3 (이전): 단일 schema / 단일 user (commerce)        ← 모든 테이블 자유 접근
W4 (지금): 단일 schema / 5 user 분리 + GRANT          ← Aggregate boundary 시작
W6:        별도 DB 인스턴스                            ← True MSA, cross-DB 불가
```

**왜 단계적으로 가는가?** 처음부터 별도 DB 인스턴스로 가면 — *암묵적 의존성* 이 보이지 않습니다. "이 도메인이 저 도메인의 테이블을 가끔 SELECT 한다" 는 사실이 *분리 후* 에 폭발. user 분리 단계는 *그 의존성을 명시적으로 GRANT 로 선언* 하게 강제합니다.

### 1.1 5 namespace 매핑

| User | RW 테이블 | RO (cross-domain) |
|------|-----------|-------------------|
| `be_owner_user` | merchant_owner, merchant | auto_reply_rule (대시보드용) |
| `be_billing_user` | account_balance | orders (정산용) |
| `be_persona_user` | (placeholder, 향후 templates) | auto_reply_rule |
| `be_rule_user` | auto_reply_rule, reply_history*, reply_request_dc* | (없음) |
| `be_workflow_user` | orders, outbox, payment_intent, external_call_log | account_balance (잔액 조회) |

cross-domain SELECT 만 명시적으로 GRANT — *write 는 절대 X*.

---

## 2. SQL 적용 {#sql}

```sql
USE commerce_comment_platform_be;

-- 1. 5 사용자 생성
CREATE USER IF NOT EXISTS 'be_workflow_user'@'%' IDENTIFIED BY 'workflowpw';
CREATE USER IF NOT EXISTS 'be_billing_user'@'%' IDENTIFIED BY 'billingpw';
-- ... (5명)

-- 2. workflow_user — 자기 도메인 RW
GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_comment_platform_be.orders
   TO 'be_workflow_user'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_comment_platform_be.outbox
   TO 'be_workflow_user'@'%';

-- 3. workflow_user — cross-domain READ ONLY
GRANT SELECT ON commerce_comment_platform_be.account_balance
   TO 'be_workflow_user'@'%';

-- 4. billing_user — 자기 도메인 RW + orders 정산용 RO
GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_comment_platform_be.account_balance
   TO 'be_billing_user'@'%';
GRANT SELECT ON commerce_comment_platform_be.orders
   TO 'be_billing_user'@'%';

-- ... (5명 모두 비슷한 패턴)

FLUSH PRIVILEGES;
```

핵심: **자기 도메인은 RW, 다른 도메인은 RO 또는 없음**. `INSERT`/`UPDATE`/`DELETE` 가 cross-domain 으로 들어가면 `ERROR 1142`.

---

## 3. 검증 시나리오 7/7 {#verification}

8 케이스로 *권한이 의도대로 막거나 허용하는지* 검증.

### 3.1 자기 도메인 RW (T1, T2)

```bash
# T1: workflow_user — orders 자기 도메인 INSERT/SELECT/DELETE
$ mysql -u be_workflow_user -pworkflowpw commerce_comment_platform_be \
  -e "INSERT INTO orders (owner_id, amount, state, pattern) VALUES (999, 1000, 'PENDING', 'X');
      SELECT id, owner_id, state FROM orders WHERE owner_id=999;
      DELETE FROM orders WHERE owner_id=999"

id     owner_id   state
1236   999        PENDING       ← ✅ OK

# T2: workflow_user — account_balance SELECT (cross-domain READ)
$ mysql -u be_workflow_user -pworkflowpw commerce_comment_platform_be \
  -e "SELECT COUNT(*) AS num_rows FROM account_balance"

num_rows
1                                ← ✅ OK
```

### 3.2 cross-domain WRITE 차단 (T3, T4, T7)

```bash
# T3: workflow_user — account_balance UPDATE 시도
$ mysql -u be_workflow_user -pworkflowpw commerce_comment_platform_be \
  -e "UPDATE account_balance SET balance = 0 WHERE owner_id=1"

ERROR 1142 (42000) at line 1: UPDATE command denied to user
'be_workflow_user'@'localhost' for table 'account_balance'
                                ← ✅ 차단

# T4: billing_user — auto_reply_rule UPDATE 시도
$ mysql -u be_billing_user -pbillingpw commerce_comment_platform_be \
  -e "UPDATE auto_reply_rule SET priority = 0"

ERROR 1142 (42000) at line 1: UPDATE command denied to user
'be_billing_user'@'localhost' for table 'auto_reply_rule'
                                ← ✅ 차단

# T7: owner_user — auto_reply_rule UPDATE 시도 (RO 만 GRANT)
$ mysql -u be_owner_user -pownerpw commerce_comment_platform_be \
  -e "UPDATE auto_reply_rule SET priority = 99 WHERE id = 1"

ERROR 1142 (42000) at line 1: UPDATE command denied to user
'be_owner_user'@'localhost' for table 'auto_reply_rule'
                                ← ✅ 차단
```

### 3.3 권한 자체 없음 (T5, T8)

```bash
# T5: rule_user — orders SELECT 시도 (orders 권한 자체 없음)
$ mysql -u be_rule_user -prulepw commerce_comment_platform_be \
  -e "SELECT * FROM orders LIMIT 1"

ERROR 1142 (42000) at line 1: SELECT command denied to user
'be_rule_user'@'localhost' for table 'orders'
                                ← ✅ 차단 (SELECT GRANT 도 없음)

# T8: persona_user — auto_reply_rule SELECT (RO 만 있음)
$ mysql -u be_persona_user -ppersonapw commerce_comment_platform_be \
  -e "SELECT COUNT(*) FROM auto_reply_rule;
      SELECT COUNT(*) FROM merchant"

COUNT(*)
1                                ← ✅ auto_reply_rule SELECT OK
ERROR 1142 (42000) at line 1: SELECT command denied to user
'be_persona_user'@'localhost' for table 'merchant'
                                ← ✅ merchant 차단
```

### 3.4 cross-domain READ 허용 (T6)

```bash
# T6: owner_user — auto_reply_rule SELECT (대시보드용 RO GRANT 있음)
$ mysql -u be_owner_user -pownerpw commerce_comment_platform_be \
  -e "SELECT COUNT(*) FROM auto_reply_rule"

COUNT(*)
1                                ← ✅ OK (RO grant)
```

### 3.5 결과 정리

| # | 시나리오 | 기대 | 실제 | 결과 |
|---|---|---|---|---|
| T1 | workflow → orders RW | OK | OK | ✅ |
| T2 | workflow → account_balance SELECT | OK | OK | ✅ cross-domain READ |
| T3 | workflow → account_balance UPDATE | 차단 | ERROR 1142 | ✅ |
| T4 | billing → auto_reply_rule UPDATE | 차단 | ERROR 1142 | ✅ |
| T5 | rule → orders SELECT | 차단 (권한 없음) | ERROR 1142 | ✅ |
| T6 | owner → auto_reply_rule SELECT | OK (RO) | OK | ✅ |
| T7 | owner → auto_reply_rule UPDATE | 차단 | ERROR 1142 | ✅ |
| T8 | persona → auto_reply_rule SELECT + merchant SELECT | OK + 차단 | OK + ERROR 1142 | ✅ |

**7/7 통과**. (T8 은 두 케이스 합산 → 8 케이스가 모두 의도대로)

---

## 4. 운영 시 실수가 *런타임* 에 잡히는 시나리오 {#runtime-catch}

가장 가치 있는 부분. 코드 리뷰가 놓친 cross-domain write 가 어떻게 *DB 단에서* 잡히는지 시나리오.

### 4.1 사고 시나리오 (잡혔어야 할 코드 리뷰가 놓침)

```java
// be_billing_user 로 connection 열린 BillingService
@Service
class BillingService {
    @Transactional
    public void processRefund(Long orderId, Long ownerId) {
        // 1. account_balance 차감 (자기 도메인 — OK)
        balanceRepo.decrement(ownerId, 1000);

        // 2. orders 의 state 를 REFUNDED 로 (cross-domain WRITE — 실수!)
        orderRepo.markRefunded(orderId);
        // ↑ 여기서 코드 리뷰가 놓치면 — 운영 사고
    }
}
```

### 4.2 user 분리 환경에서의 결과

```
2026-05-04 23:10:42 ERROR --- BillingService : Refund failed for order=42

org.springframework.dao.DataAccessException: SQL exception
  ERROR 1142 (42000): UPDATE command denied to user 'be_billing_user'@'localhost'
  for table 'orders'
  at o.s.j.s.SQLErrorCodesFactory ...
```

→ **즉시 fail**. 트랜잭션 롤백, 알림. 운영자가 알아챔. 코드 리뷰가 놓쳤어도 — *DB 가 잡아줌*.

### 4.3 user 분리 없는 환경 (Distributed Monolith) 결과

```
(아무 에러 없음)
account_balance.balance: 1000 → 0       ← 차감 OK
orders.state: PENDING → REFUNDED       ← cross-domain write 통과
```

→ **조용히 작동**. 그런데 BillingService 는 *orders 의 lifecycle* 을 모름. workflow domain 의 정합성 가정 (예: REFUNDED 상태에서 outbox event 발행) 이 깨짐. *몇 시간 후 운영 사고* — workflow team 이 outbox 비어있다고 발견.

→ **이게 user 분리의 핵심 가치**. *"코드 리뷰 + 테스트 + 컨벤션"* 의 3중 안전망에 4번째 *DB 권한* 이 추가됩니다.

---

## 5. 진화의 다음 단계 — W6 별도 DB 인스턴스 {#evolution}

본 W4 단계는 *같은 schema, 같은 DB* 안에서의 user 분리. 다음 단계 (W6, Stage 4) 는 별도 DB 인스턴스로 분리:

```
[W6 이후]
billing_db   (MySQL 1)         ← be_billing_user 가 owner
workflow_db  (MySQL 2)         ← be_workflow_user 가 owner
rule_db      (MySQL 3)
owner_db     (MySQL 4)
persona_db   (MySQL 5)
```

이 시점부터:
- cross-domain SELECT 도 *불가능* — 다른 DB 인스턴스에 connection 안 만들어줌
- 정산 도메인이 orders 가 필요하면 — *workflow domain 의 API 호출* 또는 *event 구독*
- DB 단위 백업 / 복구 / 스케일 아웃 분리

W4 의 user 분리는 이 큰 그림의 *훈련 단계*. 진짜로 별도 DB 가 됐을 때 *cross-domain SELECT 를 어떻게 처리할지* 의 의사결정을 *코드 단계* 에서 미리 강제함.

> **암묵적 의존성 차단**: 처음부터 별도 DB 면 *어떤 도메인이 어떤 도메인을 참조하는지* 모릅니다. 이 단계에서 GRANT 로 명시 → migration 시점에 의사결정 명확.

---

## 6. 면접 한 줄 {#interview}

> "W4 P5 [실측 — 인프라 / Java/Spring Stage 2] — 같은 schema 안에서 5 user 를 분리하고 cross-domain
> WRITE 를 *런타임* 에 ERROR 1142 로 차단. 7/7 검증 시나리오 모두 의도대로 동작. *Distributed Monolith
> → True MSA* 진화의 *점진적 분리* 첫 단계. 처음부터 별도 DB 로 가면 cross-domain 의 *암묵적 의존성*
> 이 안 보임 — user 분리 단계가 그 의존성을 GRANT 로 강제 명시하게 만듦. 코드 리뷰 + 테스트 + 컨벤션
> 3중 안전망에 4번째 *DB 권한* 을 추가하는 것."

---

## 참고

- [Vlad Mihalcea — How to choose the database isolation level](https://vladmihalcea.com/database-isolation-levels/)
- [MySQL — GRANT Syntax](https://dev.mysql.com/doc/refman/8.0/en/grant.html)
- [Sam Newman — Building Microservices, 2nd Ed.](https://samnewman.io/books/building_microservices/) (Chapter 4: Database Decomposition)
- [Stage 진화 설계](https://github.com/PreAgile/portfolio-docs) (private)
