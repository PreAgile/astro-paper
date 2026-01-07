---
author: 김면수
pubDatetime: 2026-01-07T15:00:00Z
title: "대규모 브라우저 자동화 시스템의 메모리 누수 해결기: 3개의 정리 경로가 만든 완벽한 폭풍"
featured: true
draft: false
tags:
  - Node.js
  - Browser Automation
  - Memory Leak
  - Concurrency
  - Production
  - Debugging
description: "50개의 Firefox 브라우저를 동시에 관리하는 자동화 시스템에서 발견한 메모리 누수. Promise.race와 finally 블록이 만든 이중 정리 문제, 그리고 이를 해결하기까지의 탐구 과정을 기록합니다."
---

## 목차

## 들어가며: 이상한 로그 한 줄

프로덕션 서버가 느려지고 있었습니다. 메모리 사용량이 서서히 증가하더니, 결국 OOMKilled로 Pod가 재시작되었습니다.

로그를 뒤지다 발견한 한 줄:

```log
[Camoufox] counter(5) > sessions(3) - MISMATCH DETECTED
```

"카운터와 실제 세션 수가 맞지 않는다고?"

이 한 줄의 로그가 3일간의 디버깅 여정의 시작이었습니다. 이 글은 그 과정에서 배운 것들을 기록합니다. 완벽한 해결책을 제시하기보다는, **어떻게 문제를 파고들었는지**, **무엇을 놓쳤는지**, **왜 그런 선택을 했는지**를 함께 나누고 싶습니다.

---

## 1. 맥락: 우리가 풀어야 했던 문제

### 1.1 비즈니스 요구사항

우리 팀은 여러 플랫폼에서 리뷰 데이터를 수집하는 스크래핑 시스템을 운영하고 있습니다. 그중 CPEATS라는 플랫폼은 특히 까다로웠습니다:

- 단일 요청이 5분 이상 소요 (수백 페이지의 페이지네이션)
- 동적 렌더링 (브라우저 자동화 필수)
- Anti-bot 메커니즘 (일반적인 Puppeteer는 차단됨)

처음에는 요청을 순차적으로 처리했지만, 하루 10,000건 이상의 요청을 처리하려면 병렬 처리가 필수였습니다.

### 1.2 기술적 제약

**브라우저는 메모리를 많이 먹습니다.**

```
Firefox 프로세스 1개 = 평균 300MB RAM
50개 동시 실행 = 15GB
서버 메모리 제한 = 32GB (Pod limit: 2GB × 16)
```

여기서 핵심 질문이 나옵니다:

> **Q: 어떻게 제한된 리소스로 최대한 많은 요청을 처리할까?**

이것이 우리가 Counter, Watchdog, Lock이라는 3가지 메커니즘을 설계한 이유입니다.

---

## 2. 설계: 3가지 핵심 메커니즘

### 2.1 Counter - "몇 개가 돌고 있지?"

가장 단순하지만 중요한 질문입니다: **"지금 몇 개의 브라우저가 실행 중이지?"**

```typescript
// browser.service.ts
private camoufoxActiveCount = 0;
private readonly MAX_CAMOUFOX = 50;

async getCamoufoxPage(sessionId: string): Promise<Page> {
  // 제한 확인
  if (this.camoufoxActiveCount >= this.MAX_CAMOUFOX) {
    throw new Error('브라우저 수 제한 도달');
  }

  // 카운터 증가
  this.camoufoxActiveCount++;

  try {
    const browser = await this.launchCamoufox();
    const page = await browser.newPage();
    return page;
  } catch (error) {
    // 실패 시 롤백
    this.camoufoxActiveCount--;
    throw error;
  }
}
```

**목적**: 메모리 초과를 방지하고 시스템 안정성을 보장합니다.

이 단순한 카운터가 나중에 큰 문제의 원인이 될 줄은 몰랐습니다.

---

### 2.2 Watchdog - "너무 오래 걸리면 죽여"

**문제 시나리오:**

```
정상 케이스: getReviews 실행 → 3분 소요 → 완료
비정상 케이스: 네트워크 끊김 → 페이지 무한 로딩 → 브라우저가 영원히 안 닫힘!
```

무한 대기를 막기 위해 Watchdog(감시자) 패턴을 도입했습니다:

```typescript
// cpeats.service.ts
async getReviews(request: GetReviewsRequest): Promise<Review[]> {
  const watchdogMs = 5 * 60 * 1000; // 5분 timeout

  const watchdogPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new SessionQueueTimeoutException('Watchdog timeout'));
    }, watchdogMs);
  });

  // Promise.race: 둘 중 먼저 끝나는 것을 반환
  const result = await Promise.race([
    this.actualGetReviews(request),  // 실제 작업
    watchdogPromise,                 // 5분 타이머
  ]);

  return result;
}
```

**개념**: "시간 지나면 짖는 개"처럼, 5분이 지나면 작업을 강제 종료합니다.

시각화하면 이렇습니다:

```
정상 흐름:
T=0s ─────── actualGetReviews 시작
T=180s ───── 완료 ✅ (watchdog는 발동 안함)

비정상 흐름:
T=0s ─────── actualGetReviews 시작
T=300s ───── watchdog 발동! 🐕
             작업 강제 종료
             브라우저 닫음
```

---

### 2.3 Lock - "누가 쓰고 있어?"

브라우저 세션은 생성 비용이 크기 때문에 재사용하고 싶었습니다. 하지만 문제가 있습니다:

```
시나리오: 같은 세션을 2개 요청이 동시 사용
- Request A: session-123에서 getReviews 실행 중
- Request B: 같은 session-123에서 getDetail 실행 시도
- 결과: 페이지 네비게이션 충돌! ❌
```

이를 해결하기 위해 Lock(잠금) 메커니즘을 추가했습니다:

```typescript
// session-lock-registry.service.ts
async attach(sessionId: string): Promise<SessionHandle> {
  const state = this.locks.get(sessionId);

  if (state.activeCount > 0) {
    // 누군가 사용 중이면 대기
    await this.waitForAvailability(sessionId);
  }

  // 잠금 획득
  state.activeCount++;

  return {
    release: async () => {
      state.activeCount--;
    }
  };
}
```

**개념**: 화장실 사용과 비슷합니다. 누군가 사용 중이면 기다렸다가, 비면 들어가고, 나올 때 "사용 완료" 신호를 보냅니다.

### 2.4 전체 시스템 구조

이 3가지 메커니즘이 어떻게 함께 작동하는지 시각화하면 다음과 같습니다:

![System Architecture](/src/assets/images/system-architecture.svg)

---

## 3. 운영: 3개월간 안정적이었다

이 시스템은 3개월간 꽤 잘 작동했습니다:

```
일일 요청: 5,000~8,000건
평균 동시 브라우저: 30~40개
피크 타임: 50개 도달
메모리 사용량: 18~22GB (안정적)
```

주요 메트릭도 안정적이었습니다:

```typescript
// 로그 예시 (정상)
[Camoufox] counter(32) == sessions(32) ✅
[Locks] 28 locks, 32 active operations
[Memory] RSS: 19.2GB
```

그런데 12월 중순부터 이상한 신호들이 나타나기 시작했습니다.

---

## 4. 관찰: 이상한 신호들

### 4.1 첫 번째 신호: Counter 불일치

```log
2026-01-06 14:23:15 [Camoufox] counter(5) > sessions(3) ⚠️
2026-01-06 14:45:32 [Camoufox] counter(2) < sessions(4) ⚠️
```

"어? 카운터가 실제 세션 수와 안 맞네?"

처음에는 로그 버그라고 생각했습니다. 하지만 빈도가 점점 늘어났습니다.

### 4.2 두 번째 신호: Lock이 쌓인다

```log
[LockSweep] Cleaned 23 orphan locks
[LockSweep] locksSize(47) > activeOps(18) × 2 - triggering sweep
```

코드에 주기적으로 "orphan lock"을 청소하는 로직이 있었습니다. 평소에는 거의 발동하지 않았는데, 자주 발동하기 시작했습니다.

"왜 Lock이 쌓이지? 정리가 안 되는 건가?"

### 4.3 세 번째 신호: 메모리 증가

```bash
# 4시간 관측
12:00 - RSS: 18.2GB
14:00 - RSS: 19.5GB (+1.3GB)
16:00 - RSS: 21.1GB (+1.6GB)
18:00 - OOMKilled! 💥
```

메모리가 시간이 지남에 따라 증가하는 패턴. 전형적인 메모리 누수였습니다.

---

## 5. 탐구: 코드를 파헤치다

### 5.1 "Counter가 어디서 감소하지?"

가장 먼저 한 일은 코드를 추적하는 것이었습니다. `camoufoxActiveCount--` 를 검색했더니:

```typescript
// 발견 1: getCamoufoxPage에서 증가
this.camoufoxActiveCount++;  // 🔼 Line 3745

// 발견 2: closeSession에서 감소
finally {
  this.camoufoxActiveCount--;  // 🔽 Line 1142
}

// 발견 3: safeCloseSession에서도 감소?!
private async safeCloseSession(id: string) {
  // ...
  this.camoufoxActiveCount--;  // 🔽 Line 975
}

// 발견 4: disconnect 핸들러에서도?!
browser.on('disconnected', () => {
  this.safeCloseSession(id, 'exception');  // → counter--
});
```

"잠깐, 카운터를 감소시키는 경로가 **3개**나 되네?"

| 경로 | 트리거 시점 | 파일 위치 |
|------|-----------|-----------|
| closeSession | 정상 종료 시 | browser.service.ts:1142 |
| safeCloseSession | 예외/강제 종료 시 | browser.service.ts:975 |
| disconnect 핸들러 | 브라우저 연결 끊김 | browser.service.ts:3928 |

**직관**: 하나의 증가에 대해 여러 개의 감소 경로가 있으면, 이중으로 감소될 가능성이 있습니다.

이 3개의 경로를 시각화하면 다음과 같습니다:

![Counter Decrement Paths](/src/assets/images/counter-decrement-paths.svg)

---

### 5.2 "이중 감소가 가능한가?" - 재현 시도

Watchdog timeout이 발생하는 시나리오를 추적해봤습니다:

```typescript
// 단순화된 코드 구조
async getCamoufoxPage(sessionId: string) {
  this.camoufoxActiveCount++;  // 1️⃣ 증가

  const watchdog = new Promise((_, reject) => {
    setTimeout(() => {
      // Timeout 발생 시
      this.safeCloseSession(sessionId, 'watchdog');  // 2️⃣ 감소
      reject(new TimeoutError());
    }, 300_000);
  });

  try {
    await Promise.race([
      actualWork(sessionId),
      watchdog,
    ]);
  } finally {
    // 3️⃣ 또 감소?!
    await this.closeSession(sessionId);  // → counter--
  }
}
```

타임라인으로 그려보니 문제가 명확해졌습니다:

```
T=0s:     getReviews 시작
          ├─ counter++ (카운터: 1)
          ├─ lock.attach()
          └─ Promise.race 시작

T=300s:   Watchdog timeout 발동! 🔥
          ├─ timeout callback 실행:
          │   ├─ safeCloseSession() 호출
          │   │   └─ counter-- (카운터: 0) ← 1번째 감소
          │   ├─ forceTerminate() 호출
          │   └─ reject(TimeoutError)
          │
          └─ Promise.race 종료

T=300s+1ms: Finally 블록 실행! 🚨
          ├─ closeSession() 호출
          │   └─ counter-- (카운터: -1) ← 2번째 감소!
          └─ sessionHandle.release()
```

**재현 성공!**

실제로 로그를 찍어보니:

```log
[Counter] Decrement: watchdog timeout, count: 4
[Counter] Decrement: finally block, count: 3  ← 이중 감소!
[Counter] MISMATCH: counter(3) > sessions(4)
```

카운터가 음수로 가지는 않았지만 (Math.max(0, count - 1) 때문), 불일치가 발생했습니다.

이 타임라인을 그림으로 표현하면 더 명확해집니다:

![Promise.race Timeline](/src/assets/images/promise-race-timeline.svg)

---

### 5.3 "왜 이런 구조가 되었을까?" - Git History 탐색

사실 이게 가장 중요한 질문이었습니다. 코드를 처음부터 이렇게 짠 건 아닐 테니까요.

```bash
git log --oneline --all -- src/browser/browser.service.ts | grep -E "watchdog|close|counter"
```

발견된 패턴:

```
v1.0 (2024년 3월)
└─ 단순한 closeSession()만 존재
   브라우저 생성 → 사용 → 종료 (선형적 흐름)

v1.5 (2024년 7월)
└─ Watchdog 기능 추가
   이유: 무한 대기 문제 발생
   구현: Promise.race + timeout callback

v2.0 (2024년 10월)
└─ Disconnect handler 추가
   이유: 브라우저 크래시 시 리소스 정리 안 됨
   구현: browser.on('disconnected') 추가

v2.3 (2025년 1월)
└─ Lock registry 추가
   이유: 분산 환경에서 세션 공유 필요
   구현: Redis 기반 lock 시스템
```

**깨달음**:

> 이것은 단순한 버그가 아니었습니다. 시스템이 진화하면서 각 기능이 **독립적으로** 추가되었고, 자원 정리 경로가 분리되었습니다. 이것은 **설계 부채**였습니다.

---

## 6. 심화: Promise.race의 치명적 함정

이 시점에서 더 근본적인 질문을 하게 되었습니다:

> **"Promise.race는 진짜로 패자를 멈추는가?"**

### 6.1 개념 실험

간단한 예제로 테스트해봤습니다:

```typescript
async function slowTask() {
  console.log('slowTask 시작');
  await sleep(10000);
  console.log('slowTask 끝'); // 이게 출력될까?
  return 'slow';
}

async function fastTask() {
  await sleep(1000);
  return 'fast';
}

const result = await Promise.race([
  slowTask(),
  fastTask(),
]);

console.log('Race 결과:', result);

// 출력:
// slowTask 시작
// Race 결과: fast
// slowTask 끝  ← 어? 계속 실행됨!
```

**핵심 발견**:

> Promise.race는 "먼저 끝나는 것의 결과만 반환"할 뿐, 패자를 **취소하지 않습니다**. 패자는 계속 달립니다.

이것은 JavaScript의 Promise가 취소 메커니즘이 없기 때문입니다.

---

### 6.2 우리 코드에서의 적용

```typescript
const result = await Promise.race([
  actualWork(),      // 브라우저 작업 (5분 걸림)
  watchdogPromise,   // 5분 타이머
]);
```

Watchdog이 이기면:
1. `watchdogPromise`가 reject 발생
2. `actualWork()`는? → **계속 실행 중!** 🏃💨
3. 브라우저는? → **여전히 열려있음!**

그래서 우리는 이렇게 정리를 시도했습니다:

```typescript
try {
  await Promise.race([...])
} catch (error) {
  if (isTimeout) {
    // Timeout callback에서 정리
    await this.safeCloseSession(sessionId);  // ← cleanup #1
  }
} finally {
  // Finally에서도 정리
  await this.closeSession(sessionId);  // ← cleanup #2 (중복!)
}
```

**문제**:

> Watchdog timeout 발생 시:
> 1. catch 블록에서 safeCloseSession() → counter--
> 2. finally 블록에서도 closeSession() → counter--
>
> = **이중 감소!**

---

## 7. 해결: 멱등성 있는 자원 관리

### 7.1 핵심 원칙: "한 번만 정리하라"

문제를 이해하고 나니 해결책은 명확했습니다: **멱등성(Idempotency)**을 보장해야 합니다.

> **멱등성이란?**
> 같은 작업을 여러 번 해도 결과가 한 번 한 것과 같은 것.
>
> 예: "전등 끄기" 버튼을 10번 눌러도 = 1번 누른 것과 같음

**Before (문제 코드)**:

```typescript
// 여러 경로에서 각자 카운터 감소
async closeSession(id: string) {
  // ...
  this.camoufoxActiveCount--;  // ❌
}

async safeCloseSession(id: string) {
  // ...
  this.camoufoxActiveCount--;  // ❌
}
```

**After (해결 코드)**:

```typescript
interface PageSession {
  // ... 기존 필드
  counterDecremented?: boolean;  // ✅ 플래그 추가
}

// 단일 감소 함수 - 모든 경로가 이것만 호출
private decrementCounter(sessionId: string, reason: string): void {
  const session = this.pages.get(sessionId);
  if (!session?.isCamoufox) return;

  // 이미 감소했으면 스킵
  if (session.counterDecremented) {
    this.logger.debug(`[Counter] Already decremented for ${sessionId}, skipping`);
    return;
  }

  // 플래그 설정 + 감소
  session.counterDecremented = true;
  this.camoufoxActiveCount = Math.max(0, this.camoufoxActiveCount - 1);

  this.logger.info(
    `[Counter] Decremented: ${reason}, new count: ${this.camoufoxActiveCount}`
  );
}
```

**패턴 이름**: Per-resource idempotency flag

> 각 리소스(세션)마다 "이미 처리했는지" 플래그를 붙여서, 여러 경로에서 호출되어도 한 번만 실행되게 합니다.

이제 모든 정리 경로에서 이 함수를 호출합니다:

```typescript
async closeSession(id: string) {
  // ...
  this.decrementCounter(id, 'normal close');  // ✅
}

async safeCloseSession(id: string) {
  // ...
  this.decrementCounter(id, 'safe close');  // ✅
}
```

---

### 7.2 Watchdog + Finally 충돌 방지

Counter만 고친다고 끝이 아니었습니다. Lock 정리도 이중으로 발생하는 문제가 있었습니다.

**Before**:

```typescript
try {
  await Promise.race([work(), watchdog()])
} catch (error) {
  if (isTimeout) {
    await safeCloseSession();  // cleanup #1
    await forceTerminate();
  }
} finally {
  await sessionHandle?.release();  // cleanup #2 (중복!)
  await dequeue();
}
```

**After**:

```typescript
let watchdogCleanupDone = false;  // ✅ 공유 플래그

try {
  await Promise.race([work(), watchdog()])
} catch (error) {
  if (isTimeout) {
    watchdogCleanupDone = true;  // ✅ 표시
    await safeCloseSession();
    await forceTerminate();
  }
} finally {
  if (!watchdogCleanupDone) {  // ✅ 확인 후 실행
    await sessionHandle?.release();
    await dequeue();
  }
}
```

**패턴 이름**: Shared Mutable Flag Pattern

> Promise.race 사용 시 "누가 정리했는지" 추적하는 공유 플래그를 사용합니다. 한쪽에서 정리했으면, 다른 쪽은 스킵합니다.

---

### 7.3 Thundering Herd 방지

문제를 분석하면서 또 다른 위험 요소를 발견했습니다:

```typescript
// 모든 요청이 똑같이 5분 timeout
private readonly getReviewsWatchdogMs = 5 * 60 * 1000;
```

**시나리오:**

```
12:00:00 - 트래픽 급증, 50개 요청 동시 시작
12:05:00 - 50개 모두 동시에 timeout! 💥
           50개 브라우저 동시 종료
           메모리 spike → GC pause → 연쇄 timeout → OOM!
```

이것을 Thundering Herd Problem(우르르 몰려드는 무리 문제)이라고 부릅니다.

**해결: Jitter(지터) 추가**

```typescript
private getJitteredTimeout(baseMs: number): number {
  const jitter = Math.random() * 30_000;  // 0~30초 랜덤
  return baseMs + jitter;
}

// 사용:
const watchdogMs = this.getJitteredTimeout(this.getReviewsWatchdogMs);
```

이제 timeout이 분산됩니다:

```
12:05:00~12:05:30 사이에 분산 종료 ✅
└─ 부하가 30초에 걸쳐 분산됨
```

---

## 8. 결과: 측정 가능한 개선

### 8.1 배포 전/후 비교

```bash
=== Before (문제 상황) ===
Counter 불일치: 평균 47회/30분
Lock sweep 실행: 12회/30분
메모리 증가율: ~50MB/hour
OOMKilled: 3회 (3일간)

=== After (P0 수정 후) ===
Counter 불일치: 0회 ✅
Lock sweep 실행: 0회 ✅
메모리 증가율: ~5MB/hour ✅
OOMKilled: 0회 (7일간 안정) ✅
```

수치상으로는 분명히 개선되었습니다. 하지만 더 중요한 것은 **시스템에 대한 신뢰**가 회복되었다는 점입니다.

### 8.2 실제 로그 변화

**Before**:

```log
[Counter] counter(5) > sessions(3) ⚠️
[Counter] counter(2) < sessions(4) ⚠️
[LockSweep] Cleaned 23 orphan locks
[Memory] RSS 21.1GB, approaching limit
[System] OOMKilled, restarting pod...
```

**After**:

```log
[Counter] counter(32) == sessions(32) ✅
[Counter] Decrement skipped: already done (session-abc-123)
[Locks] All locks aligned with active operations
[Memory] RSS 18.5GB, stable for 168 hours
```

로그가 "경고"에서 "확인"으로 바뀌었습니다.

---

## 9. 교훈: 우리가 배운 것들

### 9.1 Promise.race는 취소가 아니다

가장 큰 착각은 이것이었습니다:

```typescript
// ❌ 잘못된 이해
await Promise.race([work(), timeout()])
// → timeout이 이기면 work()가 멈춘다?

// ✅ 올바른 이해
// → timeout이 이기면 race는 끝나지만,
//    work()는 계속 실행됨! (취소 메커니즘 없음)
```

이것은 JavaScript/Node.js의 근본적인 특성입니다. Promise는 취소할 수 없습니다.

**대안 (장기 과제)**:

```typescript
const controller = new AbortController();

const timeout = setTimeout(() => {
  controller.abort();  // 명시적 취소 신호
}, 5000);

await work({ signal: controller.signal });
```

하지만 이것은 `work()` 내부에서 abort 신호를 확인하는 로직이 필요합니다. 큰 리팩토링이 필요하기 때문에 장기 과제로 남겨두었습니다.

---

### 9.2 "당연히 되겠지"는 없다

코드를 짤 때 했던 암묵적 가정들:

```typescript
// 착각 1: "finally는 한 번만 실행되겠지"
// → NO! catch에서 cleanup 후에도 finally는 실행됨

// 착각 2: "카운터는 자동으로 맞겠지"
// → NO! 3개 경로에서 제각각 감소하면 틀어짐

// 착각 3: "lock은 자동으로 정리되겠지"
// → NO! 정리 경로가 호출 안 되면 영원히 남음
```

**교훈**:

> 동시성 코드는 가정하지 말고 **검증**하라.
>
> "이렇게 되겠지"가 아니라 "이렇게 될 수밖에 없다"를 증명할 수 있어야 합니다.

---

### 9.3 관찰 가능성 = 디버깅의 시작

이 모든 것을 풀 수 있었던 이유는 **이 로그 한 줄** 덕분이었습니다:

```log
[Camoufox] counter(5) > sessions(3)
```

만약 이 로그가 없었다면? 단순히 "메모리가 증가한다"는 것만 알았을 것이고, 원인을 찾는 데 몇 주가 걸렸을 것입니다.

**좋은 로그의 조건**:

1. **불변식(invariant)을 체크**
   - `counter == sessions.size` 여야 함
   - 불일치 시 즉시 알림

2. **Context 포함**
   - 어디서 발생했는지
   - 왜 발생했는지
   - 어떤 값이었는지

```typescript
// 개선된 로그
this.logger.warn(
  `[Counter] MISMATCH: counter(${this.camoufoxActiveCount}) ` +
  `${op} sessions(${this.pages.size}), ` +
  `trigger: ${trigger}, sessionId: ${sessionId}, ` +
  `stack: ${new Error().stack.split('\n')[2]}`
);
```

---

### 9.4 점진적 복잡도 증가는 부채를 낳는다

Git history를 보면서 깨달은 것:

> 시스템은 선형적으로 진화하지 않습니다. 각 기능이 추가될 때마다, **기존 설계의 가정이 깨집니다**.

```
v1.0: closeSession() 하나만 있을 때는 완벽했음
v1.5: watchdog 추가 → timeout callback도 정리 필요
v2.0: disconnect handler 추가 → 또 다른 정리 경로
v2.3: lock registry 추가 → 정리가 더 복잡해짐
```

각 단계에서는 "이것만 추가하면 돼"라고 생각했지만, 전체 시스템의 일관성은 점점 무너졌습니다.

**교훈**:

> 기능을 추가할 때마다 "이것이 기존 자원 관리 흐름과 어떻게 상호작용하는가?"를 물어야 합니다.

---

## 10. 남은 질문들

### 10.1 완벽한 해결책인가?

솔직히 말하면, 아닙니다.

현재 해결책의 한계:

1. **플래그는 메모리를 사용합니다**
   - 각 세션마다 `counterDecremented` 플래그
   - 세션이 10,000개면 10,000개 플래그

2. **Promise는 여전히 취소되지 않습니다**
   - `actualWork()`는 watchdog timeout 후에도 실행 중
   - 진짜 취소하려면 AbortController + 대규모 리팩토링 필요

3. **분산 환경에서는?**
   - 현재는 단일 프로세스 내에서만 작동
   - 멀티 프로세스에서는 공유 메모리 필요

하지만 이것은 **현재 맥락에서 최선의 선택**이었습니다:

- 최소 침습적 수정 (기존 코드 대부분 유지)
- 즉각적인 효과 (배포 후 바로 안정화)
- 이해하기 쉬운 패턴 (다음 엔지니어가 유지보수 가능)

---

### 10.2 다른 시스템에도 적용 가능한가?

이 문제는 브라우저 자동화만의 문제가 아닙니다. 비슷한 패턴은 다음에서도 나타납니다:

**데이터베이스 커넥션 풀**:
```typescript
// 비슷한 구조
connectionPool.acquire()  // counter++
try {
  await query()
} finally {
  connectionPool.release()  // counter--
}
```

**파일 핸들 관리**:
```typescript
const fd = fs.openSync(path)  // handle++
try {
  fs.readSync(fd)
} finally {
  fs.closeSync(fd)  // handle--
}
```

**일반화된 패턴**:

```typescript
interface Resource {
  released?: boolean;
}

function release(resource: Resource, reason: string) {
  if (resource.released) {
    console.log('Already released, skipping');
    return;
  }
  resource.released = true;
  // ... 실제 해제 로직
}
```

이 패턴은 **"자원의 생명주기를 여러 경로에서 관리해야 하는 모든 시스템"**에 적용 가능합니다.

---

## 11. 마무리: 엔지니어링은 측정과 이해다

이 문제를 해결하는 과정은 직선이 아니었습니다:

```
관찰 → 추적 → 막다른 길 → 다시 추적 →
Git history 분석 → 개념 실험 → 재현 →
해결 → 측정 → 예상치 못한 부수 효과 발견 → ...
```

**완벽한 코드를 짜려 했다면 실패했을 것입니다.**

대신 우리는:
1. 문제를 측정 가능하게 만들었습니다 (로그)
2. 근본 원인을 이해했습니다 (Promise.race + finally)
3. 최소 침습적 해결책을 적용했습니다 (플래그)
4. 효과를 측정했습니다 (0회 불일치)

그리고 이것을 기록했습니다. 다음에 비슷한 문제를 만났을 때, 또는 다른 누군가가 비슷한 고민을 할 때, 이 기록이 도움이 되길 바랍니다.

---

## 참고 자료

### 프로젝트
- [Camoufox](https://github.com/daijro/camoufox) - Python/JS 안티봇 우회 브라우저
- [Playwright](https://playwright.dev/) - 브라우저 자동화 라이브러리

### 개념
- [Promise.race - MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/race)
- [AbortController - MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- [Idempotence - Martin Fowler](https://martinfowler.com/bliki/Idempotence.html)
- [Thundering Herd Problem](https://en.wikipedia.org/wiki/Thundering_herd_problem)

### 서적
- **Designing Data-Intensive Applications** - Martin Kleppmann
  - Chapter 8: The Trouble with Distributed Systems
- **Node.js Design Patterns** - Mario Casciaro
  - Chapter 9: Advanced Asynchronous Recipes

### 디버깅 도구
- [Node.js --inspect](https://nodejs.org/en/docs/guides/debugging-getting-started/)
- [Chrome DevTools Memory Profiler](https://developer.chrome.com/docs/devtools/memory-problems/)
- [Clinic.js](https://clinicjs.org/) - Node.js 성능 진단 도구

---

읽어주셔서 감사합니다. 여러분의 시스템에서도 비슷한 문제를 겪고 계신가요? 댓글로 경험을 나눠주시면 함께 배울 수 있을 것 같습니다.
