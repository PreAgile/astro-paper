---
author: 김면수
pubDatetime: 2026-05-03T22:30:00Z
title: "프로덕션이 'Check failed: node->IsInUse()' 한 줄로 죽었습니다 (2) — Datadog 프로파일러가 V8 청소부와 race를 만든 자리"
featured: true
draft: false
tags:
  - Node.js
  - V8
  - Datadog
  - Observability
  - Profiling
  - Production
  - Debugging
  - Postmortem
description: "1편에서 V8 GlobalHandles 의 어설션이 깨졌다는 것까지 확인했습니다. 그 어설션을 깬 범인을 추적합니다 — V8 CPU Profiler 의 WeakCodeRegistry, dd-trace 의 1분 타이머, 그리고 6주 전 v5.14에서 새로 기본 경로가 된 lazy stop-and-collect. 마지막으로 우리 팀이 출혈 차단을 위해 무엇을 껐고 항구적으로는 어떻게 처방할 것인가까지 정리합니다."
---

## Table of Contents

> 이 글은 2부작의 후편입니다. [1편](/posts/datadog-profiler-v8-crash-deep-dive-part1) 에서 사건 현장과 V8 GlobalHandles 슬롯 어휘 — `Persistent`, IN_USE/FREE 상태, `IsInUse()`, double-free 어설션 — 까지 정리했습니다. 본 편은 그 어휘가 손에 익었다는 가정 위에서 시작합니다.

## Executive Summary

1편의 핵심 한 줄: **V8 의 `GlobalHandles::NodeSpace::Free` 가 이미 비어 있는 슬롯을 또 비우려다 어설션이 깨졌다 (= double-free).**

남은 질문은 두 가지였습니다.

1. **누가** 그 슬롯을 두 번 비웠나? — V8 내부의 청소부 한 명을 추적합니다.
2. **왜** 하필 지금 터졌나? — `@datadog/pprof` v5.14 의 새 코드패스가 6주 전에 기본이 되었다는 사실을 추적하고, 그게 race window 를 넓혔다는 가설을 세웁니다.

그리고 마지막으로:

3. 우리 팀이 출혈 차단을 위해 무엇을 껐고 (`DD_PROFILING_ENABLED=false`), 항구적으로는 무엇을 점검·교체해야 하는가.

---

## 1. 청소부 셋의 자리 잡기 — `CpuProfiler`, `WeakCodeRegistry`, `GlobalHandles`

1편에서 본 abort 스택의 V8 내부 부분을 다시 보겠습니다.

```text
3: GlobalHandles::Destroy(unsigned long*)
4: WeakCodeRegistry::Clear()
5: CpuProfiler::StopProfiling(unsigned int)
```

세 개의 V8 내부 컴포넌트가 위에서 아래로 (3 ← 4 ← 5) 호출됐습니다. 각자의 역할을 라커룸 비유 위에 다시 올려봅니다.

| 프레임 | V8 컴포넌트 | 비유 |
|---|---|---|
| 5 | `CpuProfiler` | 라커룸 한쪽에서 일하는 **CCTV 분석가** — 매 ms 마다 "지금 어떤 칸이 활발하게 쓰이는지" 샘플링 |
| 4 | `WeakCodeRegistry` | CCTV 분석가가 **참고용으로 가져온 보관증 묶음** (영구는 아니고, 내가 일하는 동안만 들고 있음 = weak handle) |
| 3 | `GlobalHandles` | 라커룸 카운터의 **보관증 발급/회수 시스템** |

CCTV 분석가(`CpuProfiler`) 가 일을 마치고 자리에서 일어날 때(`StopProfiling`), 자기가 참고용으로 묶어두었던 보관증들(`WeakCodeRegistry::Clear`) 을 카운터로 가져가 일제히 반납합니다(`GlobalHandles::Destroy`). 이게 정상 흐름입니다.

문제는 그 보관증 중 한 장이 **이미 누군가가 회수해버린 상태**였다는 점입니다. 카운터가 "이 보관증은 이미 비어있는 칸을 가리키는데요?" 라고 발견하고 panic 한 것 — 이게 1편에서 풀어낸 어설션 실패입니다.

이제 한 단계씩 풀어봅니다.

---

## 2. `CpuProfiler` 가 보관증을 만드는 이유 — JIT 코드의 일생

### 2.1 프로파일링 = 매 ms 마다 "지금 무슨 함수?" 의 반복 샘플링

V8 의 `CpuProfiler` 가 하는 일은 단순합니다.

> 매 1ms (기본) 마다 인터럽트를 걸어 "지금 이 isolate 가 실행 중인 함수가 뭔지" 를 기록합니다. 그게 수만 개 모이면 어느 함수가 CPU 시간을 많이 먹었는지 알 수 있고, 그게 우리가 보는 불꽃 그래프(flame graph) 가 됩니다.

이 "지금 실행 중인 함수" 라는 정보는 보통 **JIT 컴파일된 코드 객체** 의 주소로 표현됩니다. V8 은 hot 한 JS 함수를 머신 코드로 컴파일해서 힙 위에 코드 블롭(Code object) 으로 올려두는데, 샘플 인터럽트 시점에 PC(program counter) 가 어느 코드 블롭 안에 있는지를 보고 함수를 식별합니다.

### 2.2 코드 블롭은 GC 대상

여기서 까다로운 점이 생깁니다. **JIT 코드 블롭은 일반 JS 객체와 똑같이 GC 의 회수 대상입니다.**

- 어떤 함수가 더 이상 hot 하지 않으면 V8 의 deoptimization 이 코드 블롭을 떼어냅니다.
- 그 코드 블롭을 가리키는 강한 참조가 더 없으면 GC 가 회수합니다.

만약 프로파일러가 "샘플 #12345 가 가리키는 코드 블롭" 의 주소를 평범한 raw pointer 로만 들고 있다면, GC 가 그 블롭을 치워버린 직후 그 raw pointer 는 dangling 이 됩니다. 그 상태에서 프로파일을 직렬화하면 SIGSEGV 직행입니다.

### 2.3 그래서 weak handle 로 살짝 붙들어 둔다

V8 은 이 문제를 **weak `Persistent` 핸들** 로 해결합니다.

- `CpuProfiler` 는 샘플에 등장한 코드 블롭마다 `Persistent` 를 하나 만듭니다 → GlobalHandles 에 슬롯이 IN_USE 로 잡힙니다.
- 단 이 `Persistent` 는 **weak** 으로 표시됩니다. 즉 GC 가 다른 강한 참조가 없어도 회수할 수 있습니다.
- 회수가 결정되면 V8 이 callback 으로 알려주고, 그 시점에 `WeakCodeRegistry` 에서 해당 슬롯을 제거합니다.

비유로 풀면:

> CCTV 분석가가 매 ms 마다 "이 칸 (= 코드 블롭) 활발해" 라고 메모하면서, 라커룸 카운터에 가서 "이 칸 보관증 한 장만 나도 같이 들게요" 라고 받아 옵니다.
> 단, 보관증은 약한 종류라서 — 원래 손님이 와서 칸을 비우면 라커룸이 분석가 보관증도 같이 무효화시킵니다 (weak 의 의미).
> 분석가는 무효화된 보관증을 묶음에서 알아서 빼야 합니다.

### 2.4 `WeakCodeRegistry::Clear` 의 역할

이 weak `Persistent` 들의 모음집이 `WeakCodeRegistry` 입니다. 이름 그대로 "약한 코드 핸들들을 모아둔 등록부".

`CpuProfiler::StopProfiling` 이 호출되면, 분석가가 자리에서 일어나면서 자기 보관증 묶음을 한꺼번에 카운터로 가져가 반납합니다. 이게 `WeakCodeRegistry::Clear()` 입니다 — 묶음을 순회하면서 매 entry 마다 `GlobalHandles::Destroy(handle)` 를 부릅니다.

```text
WeakCodeRegistry::Clear()
  for entry in registry:
      GlobalHandles::Destroy(entry.handle)  ← 슬롯 비우기
  registry.clear()
```

평소엔 잘 됩니다. 묶음에 남아 있는 보관증은 모두 IN_USE 상태일 거고, `Destroy` 가 슬롯을 IN_USE → FREE 로 정직하게 토글합니다.

### 2.5 그러면 왜 깨졌나? — 가설: GC 와의 race

가능한 시나리오 중 가장 자연스러운 것:

> 분석가가 들고 있던 보관증 한 장이, **분석가가 자리에서 일어나기 직전 GC 가 무효화** 시켰습니다 (weak 이니까 가능). 무효화는 슬롯을 FREE 로 만들어 버립니다.
>
> 그런데 분석가의 묶음(`WeakCodeRegistry`) 에서는 그 보관증이 **아직 빠지지 않은 상태** 입니다 (weak callback 이 늦게 도착했거나, registry 가 아직 정리 시그널을 못 받음).
>
> 분석가가 자리에서 일어나며 묶음을 카운터로 가져가 일제히 반납합니다. 그 중 한 장 — 이미 GC 가 비워둔 슬롯을 가리키는 — 을 또 반납하려고 합니다.
>
> 카운터(`GlobalHandles::NodeSpace::Free`): "이 칸은 이미 비어있는데요?" → CHECK fail.

이게 가설입니다. **확정**은 아닙니다 — V8 코어 디버그 빌드 없이 정확한 race 윈도우를 재현하는 건 매우 어렵고, V8 측 어설션이 절대 거짓을 출력하지 않는다는 사실(즉 정말로 double-free 가 있었다는 사실)만 우리가 확실히 알 수 있을 뿐입니다.

다만 이 가설에는 곁가지 증거가 한 가지 있습니다 — **이 race window 가 6주 전부터 넓어진 정황**이 `@datadog/pprof` 깃허브에 또렷하게 남아 있습니다.

<details>
<summary><b>(심도) 다른 가설 — V8 자체의 회귀 가능성</b> (펼치기)</summary>

GC race 외에 가능한 가설은 V8 자체의 `WeakCodeRegistry` 정리 로직에 회귀가 있을 가능성입니다. Node 22 가 사용하는 V8 버전(12.x 후반대) 이 비교적 최근까지 코드 객체 라이프사이클 관련 패치를 받았기 때문에, 어느 마이너 버전의 변경이 weak callback 의 도착 순서를 바꿨을 수 있습니다.

이 가설을 검증하려면 (a) Node 22 의 마이너 버전별로 같은 부하를 재현해 차이를 보거나, (b) V8 ChangeLog 에서 `WeakCodeRegistry`, `CpuProfiler`, `GlobalHandles` 관련 커밋을 시간순으로 비교해야 합니다.

본 사고에서는 우리가 (a) 를 시도하기엔 운영 부담이 너무 컸기에 출혈 차단(5.1 절) 으로 충분하다고 판단했습니다. 다만 이 가능성은 열어두고 있습니다 — 다음에 같은 abort 가 다른 스택 모양으로 또 나면, 그땐 V8 회귀 가설을 좀 더 진지하게 봐야 할 겁니다.

</details>

---

## 3. dd-trace / `@datadog/pprof` 의 위치 — 1분 타이머의 정체

### 3.1 두 라이브러리의 분업

운영 환경의 `node_modules` 안에는 두 패키지가 있습니다.

| 패키지 | 역할 |
|---|---|
| **`dd-trace`** | Datadog APM 의 메인 라이브러리. 분산 트레이싱 + 메트릭 + 프로파일러 통합 |
| **`@datadog/pprof`** | 그 중 프로파일러 부분의 네이티브 애드온. C++ 로 V8 의 `CpuProfiler` 를 감쌈 |

`dd-trace` 가 JS 측 오케스트레이터(scheduler) 라면, `@datadog/pprof` 는 V8 의 native API 와 직접 대화하는 손과 발입니다.

### 3.2 1분 타이머의 흐름

`dd-trace` 가 Continuous Profiler 를 켜면 다음 일이 일어납니다.

```text
1) startup 시점:
   dd-trace 가 @datadog/pprof 의 wallProfiler.start() 호출
   → V8 의 CpuProfiler::StartProfiling("wall") 가 켜짐
   → 매 1ms 마다 샘플 누적 시작

2) 1분 후 (반복):
   dd-trace 의 setInterval 콜백 실행
   → wallProfiler.stopAndCollect()        ← 우리 abort 의 트리거 지점
   → V8 의 CpuProfiler::StopProfiling 호출
   → WeakCodeRegistry::Clear() 가 슬롯들 일제 반납
   → (정상이면) profile 객체를 .pprof 포맷으로 직렬화
   → wallProfiler.start() 다시 호출 (새 1분 시작)

3) 직렬화된 .pprof 를 dd-agent 로 전송
```

이 1분 타이머의 콜백이 abort 시점의 호출 체인 시작점입니다. 1편 5 절의 흐름도를 다시 보면, 9~10번 프레임의 이름 없는 JIT 코드가 바로 이 setInterval 콜백의 마지막 자리입니다.

### 3.3 `WallProfiler::StopAndCollect` 의 두 변종

`@datadog/pprof` 안에는 프로파일러 stop 함수가 사실 **두 가지 변종** 으로 존재합니다.

1. **`stop()`** — 옛 경로. V8 프로파일을 즉시 JS 객체 트리로 변환해 반환.
2. **`stopAndCollect()`** — 신 경로. V8 프로파일을 lazy 한 형태로 반환해 직렬화 시점까지 V8 객체를 살려둠.

이 둘이 abort 한 함수 이름이기도 합니다 — `dd::WallProfiler::StopAndCollect` 와 `dd::WallProfiler::StopAndCollectImpl`. 즉 우리가 죽은 자리는 **신 경로** 위입니다. 이게 6주 전 이야기와 연결됩니다.

---

## 4. 6주 전 — `@datadog/pprof` v5.14 의 라이프사이클 변경

### 4.1 PR #287 — lazy 프로파일 트리

`@datadog/pprof` 의 [PR #287](https://github.com/DataDog/pprof-nodejs/pull/287) 은 2026-03-10 에 머지되어 v5.14.0 으로 릴리스됐습니다. 본문에서 이 PR 의 동기를 직접 인용합니다 (영문 그대로):

> The current `stop()` API recursively translates the entire profile tree into JS objects, creating a full copy in heap memory which can be significant for large applications.
>
> The new `stopAndCollect()` API uses a callback to keep the V8 profile alive while the TS serializer traverses the tree lazily.
>
> Scalar properties are set at creation time, but children are resolved on first access, reducing peak memory usage.

요약하면:

- **이전**: stop 호출 시점에 전체 프로파일 트리를 JS 객체로 한꺼번에 복사. 메모리 부담 큼.
- **이후**: lazy. JS 객체는 껍데기만 만들고, 실제 자식 노드는 직렬화 도중 처음 접근될 때 V8 측 객체에서 끌어와 채움.

벤치마크 결과: 메모리 사용량 약 **52% 감소**.

좋은 최적화입니다. 다만 이 lazy 의 핵심 문장은 마지막 한 줄입니다:

> "uses a callback to **keep the V8 profile alive** while the TS serializer traverses the tree lazily."

**V8 프로파일 객체를 평소보다 오래 살려둡니다.** 이게 우리 사고와 직접 연결됩니다.

### 4.2 PR #305 — 신 경로가 기본이 되다

[PR #305](https://github.com/DataDog/pprof-nodejs/pull/305) 가 2026-03-23 에 머지되어 v5.14.1 로 릴리스됐습니다. 제목 그대로:

> "Switch time profiling to use lazy load stop and collect method by default"

즉 v5.14.1 부터는 **time profiler 의 기본 경로가 옛 `stop()` 에서 새 `stopAndCollect()` 로 바뀌었습니다.** 우리 팀이 운영 중인 버전이 정확히 5.14.1 입니다.

```bash
$ cat node_modules/@datadog/pprof/package.json | grep version
  "version": "5.14.1"
```

### 4.3 lazy 가 race window 를 넓히는 메커니즘 (가설)

이제 2.5 절의 가설을 한 번 더 정밀하게 그립니다.

**옛 경로 (`stop`)**:
```text
stop() 호출
  → CpuProfiler::StopProfiling 즉시 진입
  → WeakCodeRegistry::Clear() 즉시 진입
  → 슬롯 일제 반납 (이때까지 GC 가 weak 무효화 못 함, race window 짧음)
  → JS 트리 통째 복사
  → 반환
```

**신 경로 (`stopAndCollect`, 우리 환경)**:
```text
stopAndCollect() 호출
  → V8 프로파일 객체를 callback 으로 살려둔 채 반환
  → (잠깐 동안 V8 프로파일이 alive 한 채 JS 측 직렬화 진행)
  → 이 동안 GC 사이클이 끼어들 가능성
  → 마지막에 callback 안에서 비로소
     CpuProfiler::StopProfiling
     → WeakCodeRegistry::Clear()
     → 슬롯 반납 (= race window 가 길어진 자리)
```

신 경로는 의도적으로 V8 객체의 수명을 직렬화가 끝날 때까지 늘립니다. 그 늘어난 구간에 GC 가 한 번이라도 끼면 weak callback 이 발동하면서 슬롯이 먼저 FREE 로 토글될 수 있고, 나중에 `StopProfiling` 의 일제 반납이 그 슬롯을 또 비우려 듭니다 → CHECK fail.

다시 말씀드리면 이건 **가설** 입니다. 우리 측에서 V8 디버그 빌드로 race 를 결정적으로 재현하지 못했고, Datadog 측 공시된 동일 시그니처 이슈도 아직 없습니다(4.5 절). 다만 다음 두 가지 사실은 강한 정황 증거입니다.

1. abort 한 함수 이름이 정확히 `StopAndCollectImpl` 이라는 신 경로의 함수.
2. 그 신 경로가 운영 라이브러리 입장에서는 **6주 전에 처음 기본이 된 코드** 입니다.

### 4.4 다른 사람들도 봤나 — 동일 어설션 사례 일별

`Check failed: node->IsInUse()` 어설션 자체는 V8 임베더/네이티브 애드온 세계에서 **잘 알려진 시그니처** 입니다. 비슷한 위치에서 죽은 다른 라이브러리들의 사례를 모아두면 패턴이 더 또렷해집니다.

| Repo | Issue | 죽은 컴포넌트 | 원인 결론 |
|---|---|---|---|
| nodejs/node | [#52418](https://github.com/nodejs/node/issues/52418) (Node 20.12 회귀) | Embedder Environment 소멸 시 | 임베더 측 핸들 라이프사이클 버그 |
| vitest-dev/vitest | [#5037](https://github.com/vitest-dev/vitest/issues/5037) | watch 모드 worker | 워커-메인 간 핸들 공유 race |
| mscdex/ssh2 | [#1393](https://github.com/mscdex/ssh2/issues/1393) | 네이티브 애드온 | 동일 어설션, 라이프사이클 버그 |
| microsoft/onnxruntime | [#23794](https://github.com/microsoft/onnxruntime/issues/23794) | Node 바인딩 InferenceSession | 동일 |
| napi-rs/napi-rs | [#2555](https://github.com/napi-rs/napi-rs/issues/2555) | NAPI custom GC | 동일 |

다섯 사례의 공통 패턴: **비슷한 계층의 핸들 라이프사이클 문제에서 같은 어설션이 관측된 사례가 있다**. 각 이슈의 *최종 원인* 이 모두 같은 계약 위반인지는 별도 검증이 필요하지만, *어셜션 위치 + 스택 모양* 의 유사성은 *우리 사례* 가 동일 카테고리에서 의심할 자리에 있음을 시사. 호출자가 `@datadog/pprof` 일 뿐인지, 또는 다른 race 조건과 결합인지는 *재현 + 코어덤프 + 업스트림 확인* 이 필요한 영역.

### 4.5 Datadog 측 공시 여부

Datadog 측 공식 채널을 다음 순서로 점검했습니다 (작성 시점: **2026-05-03**).

1. **`DataDog/dd-trace-js` 이슈 트래커** — `IsInUse`, `StopAndCollect`, `WallProfiler`, `SIGABRT`, `V8_Fatal` 키워드로 검색 — *작성 시점 기준* 공개 이슈 발견 못 함.
2. **`DataDog/pprof-nodejs` 이슈 트래커** — 동일 키워드 — *작성 시점 기준* 공개 이슈 발견 못 함.
3. **Datadog Profiler Troubleshooting 공식 문서** — 일반적인 SIGSEGV/SIGABRT 가능성은 언급되지만 본 어설션을 명시한 항목은 없음.

즉 우리가 본 정확한 시그니처는 **작성 시점 기준 공식 채널에서 발견되지 않은** 상태입니다 (이후 보고 / 패치 / 이슈 등록 가능성은 별개). 두 가지 가능성이 있습니다.

- (a) 매우 드문 race 라 아직 보고가 들어오지 않았다.
- (b) 내부적으로 트래킹은 되고 있지만 공개 이슈로는 노출되지 않았다.

어느 쪽이든 **본 사례를 정리해 dd-trace-js 측에 리포트할 가치가 있습니다.** 본 글의 v5.14 변경과 abort 스택은 충분히 명확한 정황 자료가 됩니다 (재현이 어려운 게 흠이지만, 이 정도면 dd-trace 메인테이너가 가설 검증 시작점 잡기에는 충분합니다).

---

## 5. 출혈 차단과 항구적 처방

### 5.1 즉시 — `DD_PROFILING_ENABLED=false`

가장 빠르고 안전한 조치입니다.

```yaml
# docker-compose.server.yml (요약)
services:
  scrapper:
    environment:
      - DD_TRACE_ENABLED=true       # APM 분산 트레이싱은 그대로 유지
      - DD_PROFILING_ENABLED=false  # ← Continuous Profiler 만 끔
```

이 변경의 **잃는 것 / 잃지 않는 것** 을 분명히 합니다.

**잃지 않는 것**:
- APM 분산 트레이싱 (Datadog 화면의 service map / span / latency 분포 모두 그대로)
- 표준 메트릭 (`runtime.node.*`, `cpu`, `memory` 등)
- 로그 → trace 상관관계 (각 로그의 `dd.trace_id`, `dd.span_id`)

**잃는 것**:
- Continuous Profiler 의 **불꽃 그래프** (1분 단위 wall-time, CPU, heap profile)
- Profiler 화면에서 함수 단위 핫스팟 분석

운영적으로는 — 우리 서비스에서 불꽃 그래프를 매일 들여다보던 워크플로우가 아니었기에 (대부분 trace 와 로그로 진단해왔기에) 이 절충은 받아들일 만했습니다. 다만 **이건 응급 조치라는 점을 분명히 메모해 둡니다.** "프로파일러 끄고 끝" 으로 마무리하면 안 되는 이유가 바로 다음 섹션입니다.

### 5.2 단기 — pprof / dd-trace 업그레이드 후 카나리

현재 npm 기준으로 `@datadog/pprof` 의 최신 안정 릴리스는 **v5.14.1** 이고, 이후로는 **v6.0.0 의 pre-release** (예: `6.0.0-pre-*`) 만 게시되어 있습니다. 같은 시기에 `dd-trace` 의 최신 안정 릴리스는 **v5.99.1** 입니다. 본 race 가설이 맞다면 lazy 경로의 weak handle 동기화 보강은 v6 pre-release 또는 Datadog 공지/이슈 트래커에서 추적해야 할 영역입니다 (예: 관련 작업 흐름은 PR [#311](https://github.com/DataDog/pprof-nodejs/pull/311), [#313](https://github.com/DataDog/pprof-nodejs/pull/313) 같은 dev release / dependency bump 에서 일부 확인 가능).

운영 절차:

1. `dd-trace` 는 최신 안정 패치 (v5.99.x) 로, `@datadog/pprof` 는 v5.14.1 (현재 안정 최신) 유지하거나 v6 pre-release 는 *카나리에서만* 검증.
2. **카나리 1대** (또는 staging) 에 한정해 `DD_PROFILING_ENABLED=true` 로 다시 켬.
3. 7일간 observe — abort 재발 없으면 점진 확장.
4. abort 재발 시: `DD_PROFILING_ENABLED=false` 로 즉시 롤백 후 dd-trace-js 이슈로 리포트 (스택, 버전, 환경, 본 글 링크 첨부).

### 5.3 장기 — 관측성 도구도 SUT(System Under Test) 다

이 사고가 우리에게 가르쳐 준 가장 큰 한 줄입니다.

> **운영을 보기 위해 깐 도구가 운영을 죽일 수 있다.**

기존 우리 멘탈 모델에서는 dd-trace 같은 관측성 SDK 가 거의 "공기" 처럼 취급됐습니다 — 깔면 그냥 잘 돌고, 가끔 메트릭 수치가 좀 부정확한 정도가 큰 이슈였지 어플 자체를 죽일 거라곤 가정 안 했습니다.

이번 사례 이후 우리는 멘탈 모델을 다음으로 갱신했습니다.

1. **관측성 SDK 도 의존성이다.** 메이저/마이너 변경, 특히 네이티브 부분은 다른 라이브러리와 똑같이 카나리에 태운다.
2. **관측성 SDK 의 헬스체크 신호를 어플 헬스와 분리해서 본다.** dd-agent 연결 실패, profiler upload 실패 같은 신호를 따로 모니터링.
3. **Continuous Profiler 같은 고급 기능은 opt-in 으로 둔다.** "기본 ON" 이 아니라, 정말 필요한 서비스에서만 켜는 정책.

### 5.4 운영의 마지막 안전망 — `restart: unless-stopped`

이번 사고에서 명백히 일을 잘 한 한 사람이 있습니다. **도커의 재시작 정책** 입니다.

1편 2.3 절에서 `RestartCount=0` 이 우리를 잠깐 헷갈리게 했지만, 정책 자체(`unless-stopped`) 는 살아있는 상태였습니다. 사람(우리 팀) 이 더 빨라서 정책이 일을 시작하기 전에 새 컨테이너를 띄워버렸을 뿐, V8 fatal 같은 SIGABRT 에 대해서도 정책은 자동으로 컨테이너를 재기동하게 되어 있습니다.

운영적 시사점:

- **자동 재시작 정책은 V8 fatal 같은 "JS 가 잡을 수 없는 죽음" 에서 가장 큰 가치를 발휘합니다.** `process.on('uncaughtException')` 같은 후크가 잡지 못하는 abort 를 컨테이너 단위에서 받아내 줍니다.
- 정책 검증은 `RestartCount` 가 아니라 `HostConfig.RestartPolicy` + `docker events` 로 해야 합니다 (1편 2.3 절).
- 컨테이너가 아닌 환경 (베어메탈 + PM2, systemd 등) 이라면 동일 효과를 PM2 의 `restart_delay` / systemd 의 `Restart=on-failure` 로 보장해야 합니다.

### 5.5 마지막 한 가지 — 코어덤프와 stack 보관

이번엔 운 좋게 컨테이너 stdout 에 V8 panic 메시지가 통째로 찍혀 있었지만, 환경에 따라 abort 시점에 **stdout 을 다 못 비우고 죽는 경우** 도 있습니다. 그러면 진단할 단서가 거의 없습니다.

다음 번을 위한 보강:

```bash
# Linux 호스트에 코어덤프 활성화
ulimit -c unlimited
echo '/tmp/core-%e.%p' > /proc/sys/kernel/core_pattern

# 컨테이너 측에서 코어덤프 허용
docker run --ulimit core=-1 ...
```

abort 시점에 코어덤프가 남으면 GDB 로 사후 분석이 가능합니다. 본 사고처럼 stack 만 받아 있어도 진단의 80% 는 됩니다만, 가설 단계에서 결정 단계로 넘어갈 때(특히 V8 회귀 가설 검증 시) 코어덤프가 결정적인 차이를 냅니다.

---

## 6. 우리가 다음 번에 다르게 할 것

체크리스트로 정리합니다.

- [x] **즉시**: `DD_PROFILING_ENABLED=false` 로 출혈 차단. 분산 트레이싱은 유지.
- [ ] **이번 주**: `dd-trace` / `@datadog/pprof` 최신 패치 추적, 카나리 환경 준비.
- [ ] **이번 달**: 카나리에서 7일 무사고 시 점진적으로 Continuous Profiler 재활성화. 재발 시 dd-trace-js 이슈 리포트.
- [ ] **다음 분기**: 관측성 도구 의존성을 카나리/스테이징 정책의 1급 시민으로 승격. 메이저/마이너 변경 시 다른 라이브러리와 동일한 검증 절차 적용.
- [ ] **다음 분기**: 컨테이너 코어덤프 파이프라인 구축 — abort 시 stack 자동 보존, S3 등 외부 보관, Slack 알람.
- [ ] **다음 분기**: 어플 abort 별도 모니터 — Datadog `agent.connectivity` 에 의존하지 않는 외부 ping 기반 헬스체크.

---

## 7. 마치며 — 청소부의 빗자루

이 두 편의 글에서 우리는 다음을 했습니다.

- V8 의 GlobalHandles 라는 보관함 시스템을 들여다봤고,
- `IsInUse()` 1비트 플래그가 깨질 때 어설션이 무엇을 의미하는지 번역했고,
- 그 어설션을 깨뜨린 청소부 (`CpuProfiler` → `WeakCodeRegistry` → `GlobalHandles`) 의 일과를 따라가봤고,
- dd-trace 의 1분 타이머가 그 청소부를 어떻게 호출하는지 보았고,
- 6주 전 v5.14 의 lazy 경로가 race window 를 넓혔다는 가설을 세웠고,
- 무엇을 끄고 무엇을 유지할지 결정했습니다.

처음에 "JS 프레임이 한 줄도 없는 abort" 를 봤을 때의 막막함은, V8 청소부의 일과를 이해하고 나니 한 단계 옅어졌습니다. 모든 V8 panic 을 이렇게 풀어낼 수 있는 건 아닙니다 — 다만 어휘를 갖추고 있으면 적어도 **"어디서부터 추적해야 하는가"** 는 알 수 있습니다.

운영 환경에서 새벽에 갑자기 abort 한 줄이 보이는 그날, 이 두 편이 누군가에게 "어휘 사전" 으로 도움이 됐으면 좋겠습니다.

---

## References

### V8 / Node.js
- [V8 GlobalHandles — `deps/v8/src/handles/global-handles.cc`](https://github.com/v8/v8/blob/main/src/handles/global-handles.cc)
- [Node.js #52418 — Embedder Crash at Check failed: node->IsInUse()](https://github.com/nodejs/node/issues/52418)
- [V8 CpuProfiler 공식 헤더 (v8-profiler.h)](https://github.com/v8/v8/blob/main/include/v8-profiler.h)

### Datadog 라이브러리 (1편 references와 함께)
- [`@datadog/pprof` PR #287 — Reduce time profiler memory usage with lazy profile tree](https://github.com/DataDog/pprof-nodejs/pull/287) — v5.14.0
- [`@datadog/pprof` PR #305 — Switch time profiling to use lazy load stop and collect method by default](https://github.com/DataDog/pprof-nodejs/pull/305) — v5.14.1
- [`@datadog/pprof` PR #293 — Unify StopImpl and StopAndCollectImpl via StopCore template](https://github.com/DataDog/pprof-nodejs/pull/293) — 신/구 경로 통합 *시도* (머지되지 않은 refactor PR — 본 글의 직접 근거는 아니고 lazy 경로 작업 흐름의 컨텍스트로 참고)
- [Datadog Node.js Profiler Troubleshooting (공식 문서)](https://docs.datadoghq.com/profiler/profiler_troubleshooting/nodejs/)
- [Datadog Node.js Tracing 환경 변수](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/nodejs/) — `DD_PROFILING_ENABLED`, `DD_TRACE_ENABLED`

### 동일 어설션 다른 사례
- [vitest #5037](https://github.com/vitest-dev/vitest/issues/5037)
- [ssh2 #1393](https://github.com/mscdex/ssh2/issues/1393)
- [onnxruntime #23794](https://github.com/microsoft/onnxruntime/issues/23794)
- [napi-rs #2555](https://github.com/napi-rs/napi-rs/issues/2555)
