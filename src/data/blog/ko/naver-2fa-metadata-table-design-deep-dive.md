---
author: 김면수
pubDatetime: 2026-01-22T10:00:00Z
title: "N사 2FA 메타데이터 테이블 설계기: BIGINT vs UUID 선택부터 TypeORM GENERATED 컬럼 트러블슈팅까지"
featured: true
draft: false
tags:
  - database-design
  - mysql
  - typeorm
  - backend
description: "플랫폼 계정 2FA 상태 추적을 위한 메타데이터 테이블 설계 과정에서 겪은 PK 타입 선택, UNIQUE KEY 설계, Optimistic Lock 적용, 그리고 TypeORM과 MySQL의 GENERATED 컬럼 충돌 해결까지의 기록"
---

## Table of Contents

## Executive Summary

N사 플랫폼 연동 서비스를 운영하면서, 2FA(2단계 인증) 사용자의 상태를 추적해야 하는 요구사항이 생겼습니다. 기존 범용 `platform_accounts` 테이블에 컬럼을 추가하는 방식으로는 한계가 있어, 별도의 메타데이터 테이블을 설계하게 되었습니다.

이 글은 그 과정에서 마주친 설계 결정들을 정리한 기록입니다:

- **BIGINT vs UUID**: PK 타입 선택의 트레이드오프 (B-Tree 페이지 분할 관점)
- **UNIQUE KEY 설계**: Soft Delete와 유일성 보장의 충돌
- **Optimistic Lock**: 동시성 제어 전략 선택
- **GENERATED 컬럼**: TypeORM과 MySQL의 숨겨진 충돌

**결과적으로** 하이브리드 PK 패턴(내부 BIGINT + 외부 UUID)을 채택했고, TypeORM의 `insert: false` 옵션으로 GENERATED 컬럼 문제를 해결했습니다. 다만 이게 정답이라고 말하기는 어렵습니다. 우리 팀 규모(3명)와 트래픽 수준에서 합리적이었던 선택일 뿐입니다.

---

## 1. 배경: 왜 별도 테이블이 필요했는가

### 1.1 기존 시스템의 한계

우리 시스템은 여러 플랫폼의 계정을 관리하는 `platform_accounts` 테이블을 가지고 있었습니다:

```typescript
// 기존 범용 테이블
interface PlatformAccount {
  userId: string;
  platformId: string;      // 플랫폼 계정 ID
  platform: string;        // 'BAEMIN', 'CPEATS', 'YOGIYO', ...
  accessToken: string;
  isLoggedIn: boolean;
}
```

그런데 N사 플랫폼을 연동하면서 문제가 생겼습니다. N사는 다른 플랫폼과 달리 **2FA(2단계 인증)** 사용자가 많았고, 이 정보를 추적해야 했습니다:

```typescript
// N사 스크래퍼가 반환하는 인증 메타데이터
interface NaverAuthMetadata {
  is2FAUser: boolean;           // 2FA 유저 여부
  sessionReused: boolean;       // 세션 재사용 여부
  loginWith2FA: boolean | null; // 이번 로그인에 2FA 사용 여부
}
```

### 1.2 범용 테이블 확장의 문제점

처음에는 단순하게 생각했습니다. "기존 테이블에 컬럼 몇 개만 추가하면 되는 거 아닌가?"

```typescript
// BAD: Sparse Table 문제
interface PlatformAccount {
  userId: string;
  platformId: string;
  platform: string;

  // N사 전용 (다른 플랫폼은 NULL)
  naverIs2FAUser?: boolean;
  naverSessionReused?: boolean;
  naverLastLoginWith2FA?: boolean;

  // 향후 추가될 플랫폼별 필드들...
}
```

이 접근 방식의 문제점:

1. **Sparse Table**: 대부분의 행에서 N사 전용 필드가 NULL
2. **SRP 위반**: 하나의 테이블이 너무 많은 책임을 가짐
3. **마이그레이션 지옥**: 플랫폼 추가마다 ALTER TABLE 반복
4. **쿼리 복잡도**: 플랫폼별 분기 처리 필요

### 1.3 요구사항 도출

CS팀과 논의 끝에 다음 요구사항을 정리했습니다:

| 요구사항 | 비즈니스 가치 | 기술적 도전 |
|---------|-------------|-----------|
| **2FA 상태 추적** | 세션 안정성 예측으로 에러 감소 | 동시 업데이트 처리 |
| **CS 조회 최적화** | 빠른 고객 문의 대응 | 인덱스 전략 |
| **Soft Delete 지원** | 데이터 복구 가능 | UNIQUE 제약 충돌 |

---

## 2. 설계 결정 1: PK 타입 선택

### 2.1 BIGINT vs UUID 트레이드오프

가장 먼저 결정해야 할 것은 PK 타입이었습니다. 우리 팀에서는 두 가지 선택지를 놓고 고민했습니다:

| 구분 | BIGINT AUTO_INCREMENT | UUID (CHAR(36)) |
|------|----------------------|-----------------|
| 크기 | 8 바이트 | 36 바이트 |
| INSERT 성능 | 순차 삽입 (빠름) | 랜덤 삽입 (30~50% 느림) |
| 분산 환경 | 충돌 가능 | 충돌 없음 |
| 예측 가능성 | `/users/123` (취약) | `/users/550e8400-...` (안전) |

단순히 크기 차이(8 vs 36바이트)만 보면 대수롭지 않아 보입니다. 하지만 **B-Tree 페이지 분할** 관점에서 보면 이야기가 달라집니다.

### 2.2 B-Tree 페이지 분할 이해하기

InnoDB는 데이터를 16KB 크기의 **페이지** 단위로 저장합니다. PK는 B-Tree 인덱스로 관리되는데, 여기서 순차 삽입과 랜덤 삽입의 차이가 극명하게 드러납니다.

**AUTO_INCREMENT (순차 삽입):**

```
id = 7 삽입:
┌────────────────────────────────┐
│ 페이지 1: [1, 2, 3, 4, 5, 6, 7]│ ← 끝에 추가
└────────────────────────────────┘

페이지가 꽉 차면:
┌────────────────────────────────┐
│ 페이지 1: [1, 2, 3, 4, 5, 6, 7]│ ← 그대로 유지
└────────────────────────────────┘
┌────────────────────────────────┐
│ 페이지 2: [8]                  │ ← 새 페이지에 순차 추가
└────────────────────────────────┘
```

**UUID (랜덤 삽입) - 페이지 분할 발생:**

```
새 UUID 삽입: 250e... (222...와 333... 사이)
문제: 페이지가 꽉 참 → 페이지 분할!

BEFORE:
┌────────────────────────────────────────┐
│ [111..., 222..., 333..., 444..., ...]  │ ← 꽉 참
└────────────────────────────────────────┘

AFTER:
┌───────────────────────┐ ┌───────────────────────┐
│ [111..., 222..., 250..]│ │ [333..., 444..., ...] │
└───────────────────────┘ └───────────────────────┘
        ↑ 절반만 사용              ↑ 새로 생성
```

페이지 분할이 발생하면:
1. 새 페이지 할당 (디스크 공간)
2. 기존 페이지 절반을 새 페이지로 복사
3. 두 페이지 모두 **50% 공간 낭비**
4. INSERT마다 이 비용 발생

### 2.3 하이브리드 패턴 채택

결국 우리는 **하이브리드 패턴**을 선택했습니다:

```sql
CREATE TABLE platform_account_naver_metadata (
  -- 내부 PK: 성능 최적화
  id BIGINT PRIMARY KEY AUTO_INCREMENT,

  -- 외부 참조: users 테이블의 UUID
  user_id CHAR(36) NOT NULL,

  -- N사 계정 ID (이메일 형식 가능)
  platform_id VARCHAR(255) NOT NULL,

  -- ... 나머지 컬럼들
);
```

**선택 이유:**

1. **내부 PK는 BIGINT**: JOIN, FK 참조 시 8바이트로 효율적
2. **user_id는 UUID 그대로**: 기존 users 테이블과 일관성 유지
3. **platform_id는 VARCHAR(255)**: N사 계정이 이메일 형식일 수 있음

```typescript
// TypeORM Entity
@Entity('platform_account_naver_metadata')
export class PlatformAccountNaverMetadata {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;  // 내부에서만 사용

  @Column({ type: 'char', length: 36 })
  userId: string;  // 외부 참조용
}
```

### 2.4 트레이드오프 정리

| 결정 | 장점 | 단점 |
|------|------|------|
| 내부 PK: BIGINT | 순차 삽입, B-Tree 최적 | 분산 환경 불리 |
| 외부 참조: UUID | 기존 시스템 호환 | - |
| 하이브리드 | 둘의 장점 조합 | 복잡도 증가 |

---

## 3. 설계 결정 2: UNIQUE KEY와 Soft Delete

### 3.1 처음 시도한 설계

"같은 유저가 같은 N사 아이디를 중복 등록할 수 없다"는 비즈니스 규칙을 강제하기 위해 UNIQUE KEY가 필요했습니다. 동시에 Soft Delete도 지원해야 했습니다.

처음에는 이렇게 설계했습니다:

```sql
-- BAD: 처음 시도한 설계
UNIQUE KEY uk_user_platform_status (user_id, platform_id, account_status)
```

의도는 "삭제된 레코드(account_status = 'DELETED')는 유일성 검사에서 제외"하는 것이었습니다.

### 3.2 MySQL 조건부 UNIQUE의 한계

그런데 MySQL에는 PostgreSQL의 **Partial Index** 같은 기능이 없습니다:

```sql
-- PostgreSQL에서는 가능
CREATE UNIQUE INDEX uk_active
ON metadata (user_id, platform_id)
WHERE deleted_at IS NULL;  -- 조건부 유일성

-- MySQL에서는 불가능!
```

MySQL의 UNIQUE KEY는 **모든 행**에 적용됩니다. 그래서 위 설계에서는 문제가 생겼습니다:

```
시나리오: 유저 A가 계정 X를 삭제 후 재등록

1. (user_A, platform_X, ACTIVE) 삽입 → OK
2. Soft Delete → (user_A, platform_X, DELETED)
3. 재등록 시도 → (user_A, platform_X, ACTIVE)
   → ❌ UNIQUE 충돌! (account_status 다르지만 같은 user_id + platform_id)
```

### 3.3 최종 설계: 애플리케이션 레벨 처리

결국 UNIQUE KEY를 단순화하고, 재등록 로직은 애플리케이션에서 처리하기로 했습니다:

```sql
-- 최종 설계
UNIQUE KEY uk_user_platform_active (user_id, platform_id(191))
```

> **191자 프리픽스**: MySQL의 InnoDB + UTF8MB4에서 인덱스 키 최대 크기는 767바이트입니다. VARCHAR(255)에 UTF8MB4(4바이트)를 적용하면 1020바이트가 되어 초과합니다. 191 × 4 = 764바이트로 제한 내에 들어옵니다.

```typescript
// 재등록 시: Soft Delete된 레코드 복원 또는 새로 생성
async reactivateOrCreate(
  userId: string,
  platformId: string
): Promise<PlatformAccountNaverMetadata> {
  // Soft Delete된 레코드도 조회
  const deleted = await this.repo.findOne({
    where: { userId, platformId },
    withDeleted: true,
  });

  if (deleted) {
    // 복원
    deleted.deletedAt = null;
    deleted.is2faUser = false;  // 상태 초기화
    return await this.repo.save(deleted);
  }

  // 새로 생성
  return await this.repo.save(
    this.repo.create({ userId, platformId })
  );
}
```

### 3.4 트레이드오프 정리

| 결정 | 장점 | 단점 |
|------|------|------|
| 단순 UNIQUE KEY | 명확한 제약 | 재등록 시 충돌 가능 |
| 앱 레벨 처리 | 유연한 로직 | DB 레벨 보장 없음 |
| TypeORM withDeleted | Soft Delete 조회 가능 | 항상 명시 필요 |

---

## 4. 설계 결정 3: Optimistic Lock

### 4.1 왜 동시성 제어가 필요했나

2FA 메타데이터는 여러 상황에서 업데이트됩니다:

```
상황 1: 로그인 성공 → is2faUser, lastLoginWith2fa 업데이트
상황 2: 리뷰 수집 → sessionReused 업데이트
상황 3: 에러 발생 → last2faCheckedAt 업데이트
```

만약 같은 유저가 여러 탭에서 동시에 작업하면? 또는 배치 작업과 실시간 요청이 겹치면?

```
요청 A (로그인)           요청 B (리뷰 수집)
─────────────────────────────────────────────
SELECT (is2faUser: false)
                          SELECT (is2faUser: false)
is2faUser = true
                          sessionReused = true
UPDATE
                          UPDATE  ← 요청 A의 변경 덮어씀!
```

### 4.2 Pessimistic vs Optimistic Lock

동시성 제어에는 두 가지 접근 방식이 있습니다:

| 구분 | Pessimistic Lock | Optimistic Lock |
|------|------------------|-----------------|
| 가정 | 충돌이 자주 발생 | 충돌이 거의 없음 |
| 방식 | 조회 시 락 획득 | 저장 시 버전 검증 |
| 대기 | 락 해제까지 대기 | 없음 |
| 데드락 | 가능 | 없음 |

```typescript
// Pessimistic Lock
const metadata = await repo.findOne({
  where: { id: 1 },
  lock: { mode: 'pessimistic_write' }  // SELECT ... FOR UPDATE
});
// 다른 트랜잭션은 이 행 접근 시 대기
```

### 4.3 Optimistic Lock 선택 이유

우리 상황을 분석해보니:

1. **충돌 가능성 낮음**: 같은 유저가 같은 계정을 동시에 조작할 확률 < 1%
2. **읽기가 압도적**: 업데이트보다 조회가 10배 이상 많음
3. **락 대기 비용**: Pessimistic Lock은 동시 요청 시 병목

그래서 Optimistic Lock을 선택했습니다:

```typescript
@Entity('platform_account_naver_metadata')
export class PlatformAccountNaverMetadata {
  @VersionColumn()
  version: number;  // 버전 컬럼 추가
}
```

```sql
-- TypeORM이 자동 생성하는 UPDATE 쿼리
UPDATE platform_account_naver_metadata
SET is_2fa_user = true, version = 2
WHERE id = 1 AND version = 1;
--              ^^^^^^^^^^^^^ 버전 체크!
```

### 4.4 충돌 시 재시도 로직

Optimistic Lock에서 충돌이 발생하면 `OptimisticLockVersionMismatchError`가 발생합니다. 이를 처리하는 재시도 로직을 구현했습니다:

```typescript
async updateMetadataWithRetry(
  userId: string,
  platformId: string,
  updateFn: (metadata: PlatformAccountNaverMetadata) => void,
  maxRetries = 3
): Promise<PlatformAccountNaverMetadata> {
  let retries = 0;

  while (retries < maxRetries) {
    try {
      // 1. 최신 데이터 조회
      const metadata = await this.repo.findOne({
        where: { userId, platformId }
      });

      // 2. 업데이트 적용
      updateFn(metadata);

      // 3. 저장 (버전 검증)
      return await this.repo.save(metadata);

    } catch (error) {
      if (error instanceof OptimisticLockVersionMismatchError) {
        retries++;
        // Exponential backoff: 100ms, 200ms, 300ms
        await sleep(100 * retries);
        continue;
      }
      throw error;
    }
  }

  throw new Error('Max retries exceeded');
}
```

### 4.5 트레이드오프 정리

| 결정 | 장점 | 단점 |
|------|------|------|
| Optimistic Lock | 데드락 없음, 대기 없음 | 충돌 시 재시도 필요 |
| @VersionColumn | TypeORM 자동 처리 | 버전 컬럼 추가 필요 |
| 재시도 로직 | 충돌 복구 | 코드 복잡도 증가 |

---

## 5. 설계 결정 4: GENERATED 컬럼과 TypeORM 충돌

### 5.1 파티션 키용 created_date

작업 로그 테이블(`naver_operation_logs`)은 파티셔닝을 적용하기로 했습니다. (이 부분은 [Part 2](/posts/mysql-partitioning-small-table-deep-dive)에서 자세히 다룹니다.)

파티션 키로 `created_date`(DATE 타입)를 사용하려 했는데, 매번 애플리케이션에서 계산하기 번거로웠습니다. 그래서 MySQL의 **GENERATED 컬럼**을 사용하기로 했습니다:

```sql
-- created_at에서 자동으로 created_date 계산
created_date DATE NOT NULL
  GENERATED ALWAYS AS (DATE(created_at)) STORED
```

`GENERATED ALWAYS AS ... STORED`는 INSERT/UPDATE 시 자동으로 계산되어 저장됩니다.

### 5.2 TypeORM에서 직접 값 설정 시도

처음에는 아무 생각 없이 TypeORM Entity를 작성했습니다:

```typescript
// BAD: 처음 작성한 Entity
@Entity('naver_operation_logs')
export class NaverOperationLog {
  @PrimaryColumn({ type: 'date' })
  createdDate: Date;

  @CreateDateColumn()
  createdAt: Date;
}
```

그리고 서비스에서 이렇게 사용했습니다:

```typescript
// BAD: GENERATED 컬럼에 직접 값 설정
const log = new NaverOperationLog();
log.createdDate = new Date();  // ← 문제!
log.createdAt = new Date();
await this.repo.save(log);
```

### 5.3 에러 발생

실행하면 다음 에러가 발생합니다:

```
Error: The value specified for generated column 'created_date'
in table 'naver_operation_logs' is not allowed.
```

`GENERATED ALWAYS` 컬럼은 **직접 값을 설정할 수 없습니다**. MySQL이 자동으로 계산하는 것만 허용됩니다.

### 5.4 해결: insert/update false 옵션

TypeORM에서는 `insert: false`, `update: false` 옵션으로 해당 컬럼을 INSERT/UPDATE 쿼리에서 제외할 수 있습니다:

```typescript
// GOOD: GENERATED 컬럼 올바른 설정
@Entity('naver_operation_logs')
export class NaverOperationLog {
  @PrimaryColumn({
    type: 'date',
    insert: false,  // INSERT 시 제외
    update: false,  // UPDATE 시 제외
  })
  createdDate: Date;

  @CreateDateColumn()
  createdAt: Date;
}
```

이제 TypeORM이 생성하는 쿼리에서 `created_date`가 제외됩니다:

```sql
-- TypeORM이 생성하는 쿼리
INSERT INTO naver_operation_logs (created_at, ...)
VALUES ('2026-01-22 10:00:00', ...);
-- created_date는 MySQL이 자동 계산: '2026-01-22'
```

### 5.5 조회 시 값 접근

INSERT/UPDATE에서 제외했지만, SELECT 시에는 정상적으로 값을 읽을 수 있습니다:

```typescript
const log = await this.repo.findOne({ where: { id: 1 } });
console.log(log.createdDate);  // '2026-01-22' (자동 계산된 값)
```

### 5.6 트레이드오프 정리

| 결정 | 장점 | 단점 |
|------|------|------|
| GENERATED 컬럼 | 데이터 일관성 보장 | TypeORM 설정 필요 |
| insert/update false | 깔끔한 해결 | 문서화 부재 시 혼란 |

---

## 6. 인덱스 전략

### 6.1 CS 조회 패턴 분석

CS팀이 가장 많이 사용하는 조회 패턴을 분석했습니다:

```sql
-- 패턴 1: 특정 유저의 N사 계정 조회
SELECT * FROM platform_account_naver_metadata
WHERE user_id = ? AND deleted_at IS NULL;

-- 패턴 2: N사 아이디로 검색
SELECT * FROM platform_account_naver_metadata
WHERE platform_id = ?;

-- 패턴 3: 2FA 유저만 조회
SELECT * FROM platform_account_naver_metadata
WHERE is_2fa_user = true AND last_2fa_checked_at > ?;
```

### 6.2 커버링 인덱스 설계

자주 조회되는 컬럼들을 인덱스에 포함시켜 **커버링 인덱스**를 구성했습니다:

```sql
-- CS 조회 최적화 커버링 인덱스
INDEX idx_user_platform_covering (
  user_id,
  platform_id(191),
  is_2fa_user,
  last_2fa_checked_at,
  deleted_at
)
```

커버링 인덱스란 **쿼리에 필요한 모든 컬럼이 인덱스에 포함**되어, 테이블 데이터에 접근하지 않고 인덱스만으로 결과를 반환할 수 있는 인덱스입니다.

```sql
-- 이 쿼리는 테이블 접근 없이 인덱스만으로 처리
SELECT user_id, is_2fa_user, last_2fa_checked_at
FROM platform_account_naver_metadata
WHERE user_id = ? AND deleted_at IS NULL;
```

```sql
-- EXPLAIN으로 확인
EXPLAIN SELECT ...
-- Extra: Using index  ← 커버링 인덱스 사용!
```

### 6.3 프리픽스 인덱스 191자 이슈

`platform_id`에 프리픽스 인덱스를 적용했는데, TypeORM의 `@Index` 데코레이터는 프리픽스 길이를 지원하지 않습니다:

```typescript
// BAD: TypeORM은 프리픽스 길이 미지원
@Index('uk_user_platform', ['userId', 'platformId'], { unique: true })
// 생성되는 DDL: ... platform_id VARCHAR(255) ...
// 에러: Index column size too large
```

해결 방법은 **마이그레이션에서 raw SQL**을 사용하는 것입니다:

```typescript
// migration 파일
export class CreateNaverMetadataTable1706000000000
  implements MigrationInterface {

  async up(queryRunner: QueryRunner): Promise<void> {
    // 테이블 생성
    await queryRunner.query(`
      CREATE TABLE platform_account_naver_metadata (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        user_id CHAR(36) NOT NULL,
        platform_id VARCHAR(255) NOT NULL,
        ...
      )
    `);

    // 프리픽스 인덱스는 raw SQL로
    await queryRunner.query(`
      CREATE UNIQUE INDEX uk_user_platform_active
      ON platform_account_naver_metadata (user_id, platform_id(191))
    `);
  }
}
```

### 6.4 트레이드오프 정리

| 결정 | 장점 | 단점 |
|------|------|------|
| 커버링 인덱스 | Random I/O 제거 | INSERT 시 오버헤드 |
| 프리픽스 인덱스 | 인덱스 크기 제한 내 | 191자 이후 유일성 미보장 |
| raw SQL 마이그레이션 | TypeORM 한계 극복 | 수동 관리 필요 |

---

## 7. 리뷰 메타데이터 확장 테이블

### 7.1 요구사항

N사 리뷰에는 다른 플랫폼에 없는 특수 정보가 있었습니다:

| 필드 | 설명 |
|------|------|
| review_type | RECEIPT(영수증), BOOKING(포장), PICKUP(픽업) |
| visit_count | 방문 횟수 |
| keywords | 투표된 키워드 (JSON 배열) |
| booking_detail | 주문 정보 (JSON) |

기존 `reviews` 테이블을 수정하지 않고, 별도의 메타데이터 테이블을 만들기로 했습니다.

### 7.2 JSON 컬럼 vs 정규화

`keywords`와 `booking_detail`을 어떻게 저장할지 고민했습니다:

**옵션 1: 정규화 (별도 테이블)**
```sql
CREATE TABLE review_keywords (
  id BIGINT PRIMARY KEY,
  review_id VARCHAR(36),
  keyword VARCHAR(50)
);
```

**옵션 2: JSON 컬럼**
```sql
CREATE TABLE review_metadata (
  keywords JSON,          -- ['맛있어요', '친절해요']
  booking_detail JSON     -- { "menu": "...", "price": 15000 }
);
```

### 7.3 JSON 컬럼 선택 이유

1. **조회 패턴**: keywords를 개별 조회하는 경우 거의 없음
2. **데이터 구조**: booking_detail은 복잡하고 가변적
3. **성능**: JSON 타입은 MySQL 8.0에서 최적화됨
4. **확장성**: 향후 플랫폼별 추가 필드를 extra_data에 저장 가능

```typescript
@Entity('review_metadata')
export class ReviewMetadata {
  @Column({ type: 'json', nullable: true })
  keywords?: string[];  // TypeORM이 자동 직렬화/역직렬화

  @Column({ type: 'json', nullable: true })
  bookingDetail?: BookingDetail;

  @Column({ type: 'json', nullable: true })
  extraData?: Record<string, unknown>;  // 향후 확장용
}
```

### 7.4 트레이드오프 정리

| 결정 | 장점 | 단점 |
|------|------|------|
| JSON 컬럼 | 유연한 스키마 | 쿼리 복잡도 증가 |
| extra_data | 플랫폼 확장 용이 | 타입 안전성 약함 |
| 별도 테이블 | 기존 스키마 보호 | JOIN 필요 |

---

## 8. 결론 및 회고

### 8.1 최종 스키마

```sql
CREATE TABLE platform_account_naver_metadata (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id CHAR(36) NOT NULL,
  platform_id VARCHAR(255) NOT NULL,

  is_2fa_user BOOLEAN DEFAULT FALSE,
  last_login_with_2fa BOOLEAN NULL,
  session_reused BOOLEAN DEFAULT FALSE,
  last_2fa_checked_at TIMESTAMP NULL,

  deleted_at TIMESTAMP NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_user_platform_active (user_id, platform_id(191)),
  INDEX idx_user_platform_covering (user_id, platform_id(191), is_2fa_user, last_2fa_checked_at, deleted_at)
);
```

### 8.2 포기한 것들

모든 설계 결정에는 트레이드오프가 있습니다. 우리가 포기한 것들:

| 포기한 것 | 이유 |
|----------|------|
| 단일 식별자 (UUID만) | B-Tree 효율을 위해 하이브리드 패턴 선택 |
| DB 레벨 조건부 UNIQUE | MySQL 제약으로 앱 레벨 처리 |
| 자동 충돌 해결 | Optimistic Lock은 재시도 로직 필요 |
| 191자 이후 유일성 | 프리픽스 인덱스 제약 (실질적 문제 없음) |

### 8.3 다음에는 다르게 할 것들

1. **처음부터 TypeORM 제약 파악**: GENERATED 컬럼, 프리픽스 인덱스 등 ORM 한계를 먼저 조사
2. **인덱스 설계 시 EXPLAIN 필수**: 커버링 인덱스 효과를 미리 검증
3. **Soft Delete 전략 명확화**: 재등록 시나리오를 처음부터 고려

---

## References

- [MySQL 8.0 Reference Manual - InnoDB Index Types](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)
- [TypeORM - Entity Column Types](https://typeorm.io/entities#column-types)
- [High Performance MySQL 4th Edition](https://www.oreilly.com/library/view/high-performance-mysql/9781492080503/)

---

**다음 글 예고**: [작은 테이블에도 파티셔닝을 적용한 이유: DELETE 대신 DROP PARTITION으로 300배 빠른 아카이빙](/posts/mysql-partitioning-small-table-deep-dive)에서는 로그 테이블의 파티셔닝 전략과 Redis 분산 락을 활용한 아카이빙 자동화를 다룹니다.
