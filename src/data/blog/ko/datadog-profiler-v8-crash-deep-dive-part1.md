---
author: 김면수
pubDatetime: 2026-05-03T22:00:00Z
title: "프로덕션이 'Check failed: node->IsInUse()' 한 줄로 죽었습니다 (1) — V8 GlobalHandles 해부"
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
description: "프로덕션 컨테이너가 평범한 새벽에 V8 fatal 한 줄을 남기고 죽었습니다. 어플 코드는 단 한 줄도 안 들어간 스택, Datadog 프로파일러의 마지막 호출, 그리고 V8 내부의 'Check failed: node->IsInUse()'. 이게 무슨 뜻인지부터 풀어봅니다 — 1편: 사건 재현과 V8 GlobalHandles의 해부."
---

## Table of Contents

## Executive Summary

> **환경**: Node.js v22.22.2 / `dd-trace` 5.97.0 / `@datadog/pprof` 5.14.1 / 도커 컨테이너 운영 / Datadog Continuous Profiler ON.

새벽 3시, 평범한 리뷰 등록 흐름이 끝난 직후에 컨테이너가 죽었습니다. 종료 직전 마지막 정상 로그는 외부 API 호출 한 줄. 그 다음 줄부터는 V8 엔진의 panic 메시지였습니다.

```text
# Fatal error in , line 0
# Check failed: node->IsInUse().
```

이 한 줄을 처음 봤을 때, 솔직히 무슨 말인지 몰랐습니다. `node` 가 Node.js냐, V8 내부의 무엇이냐, `IsInUse()` 가 왜 거짓이라고 폭발하는 거냐. 스택 트레이스에는 우리가 작성한 JavaScript 코드 프레임이 **단 한 줄도** 없었습니다. "어플 코드는 멀쩡한데 왜 죽지?" 라는 막막함이 디버깅의 출발점이었습니다.

이 글은 그 출발점부터 한 단계씩 올라가며 다음을 풀어봅니다:

1. 어떻게 우리 컨테이너가 죽었는지 (시간순 재구성, 도커 정책 점검 포함)
2. **V8 핸들** 이라는 단어가 정확히 뭘 가리키는지 — JS 변수에서 시작해 V8 내부의 슬롯 한 칸까지
3. `Check failed: node->IsInUse()` 가 평소 우리가 쓰는 말로 번역하면 어떤 사고인지
4. 왜 스택에 JS 프레임이 한 줄도 없었는지

진짜 범인 — Datadog Continuous Profiler가 V8 내부의 청소부 루틴과 어떻게 race를 만들었는지, v5.14에서 어떤 신규 코드패스가 race window를 넓혔는지 — 는 [2편](/posts/datadog-profiler-v8-crash-deep-dive-part2)에서 다룹니다. 1편은 **사고 현장**과 **V8 어휘 사전** 두 가지에 집중합니다.

---

## 1. 들어가며 — 새벽 3시의 한 줄

평범한 새벽이었습니다. 우리 팀이 운영하는 스크래핑 서버는 여러 외부 플랫폼(B사·C사·Y사·D사 등)의 리뷰를 수집·등록하는 일을 합니다. 24/7로 돌아가고, Datadog APM·Continuous Profiler 가 함께 켜져 있어서 평소엔 분산 트레이싱 화면과 불꽃 그래프(flame graph)를 보면서 운영합니다.

그날 새벽, 컨테이너가 갑자기 죽었습니다. 마지막 정상 로그는 다음 한 줄이었습니다:

```text
03:11:12.176  [YOGIYO] addReply (new API) URL: https://ceo-api.yogiyo.co.kr/vendor/.../reviews/.../reply/
```

이 줄 다음에는 어플 로그가 한 줄도 없습니다. 대신 V8의 panic 메시지가 찍혀 있었습니다.

```text
#
# Fatal error in , line 0
# Check failed: node->IsInUse().
#
#
#
#FailureMessage Object: 0x7fffa5cfd490
----- Native stack trace -----

 1: 0x102a331  [node]
 2: 0x29fa84b V8_Fatal(char const*, ...) [node]
 3: 0x13c8c89 v8::internal::GlobalHandles::Destroy(unsigned long*) [node]
 4: 0x1813181 v8::internal::WeakCodeRegistry::Clear() [node]
 5: 0x17dfbc7 v8::internal::CpuProfiler::StopProfiling(unsigned int) [node]
 6: 0x765d40071bde dd::WallProfiler::StopAndCollectImpl(...) [.../@datadog/pprof/.../node-127.node]
 7: 0x765d400726f2 dd::WallProfiler::StopAndCollect(Nan::FunctionCallbackInfo<v8::Value> const&)
 8: 0x765d4006c894  [.../@datadog/pprof/.../node-127.node]
 9: 0x121c5e9  [node]
10: 0x765d3b5cf655
```

처음 본 인상:

- **`Fatal error in , line 0`** — 라인 정보 없음. 코드의 어디서 났는지 V8 자기도 못 적고 있다는 뜻입니다.
- **`Check failed: node->IsInUse()`** — `node` 라는 게 거짓 상태였답니다. 이게 V8 내부 변수인지, Node.js 자체인지, 아니면 우리 코드의 변수인지 — 단어가 너무 흔해서 헷갈렸습니다.
- **스택에 JS 프레임이 없음** — `at Function (...)` 같은 V8 JIT 프레임이 한 줄도 보이지 않습니다.
- **6번 프레임 `dd::WallProfiler`** — Datadog의 프로파일러가 호출 체인 어딘가에 있습니다.

이 네 단서를 들고, 가장 먼저 던진 질문은 두 가지였습니다.

> 1. **`node->IsInUse()` 가 도대체 무슨 뜻이지?**
> 2. **JS 프레임이 한 줄도 없으면, 우리 어플 코드가 트리거한 게 아니란 뜻인가?**

이 두 질문에 답하기 전에, 사고 현장부터 정리해두는 게 좋겠습니다.

---

## 2. 사건 — 마지막 정상 로그와 그 뒤의 침묵

### 2.1 시간순 재구성

컨테이너가 살아있던 시점의 마지막 정상 로그(03:11:12)와 그 뒤의 V8 abort 사이를, 도커 메타데이터로 다시 맞춰봤습니다.

```text
03:10:53  CacheService SET success: key=cookie:ddangyo:...
03:10:54  BAEMIN initializeProxyInfo: DECODO fallback
03:10:55  락 획득 시도 / 락 획득 완료 (ID=2200426316, 활성 락=1/60)
03:10:56  락 정상 해제 (활성 락=0/60)
03:11:04  [세션 종료] NAVER 브라우저 세션 timeout (예약된 정리)
03:11:11  [YOGIYO] checkLogin → 200 OK
03:11:12  [YOGIYO] addReply 호출 시작   ← 마지막 정상 로그
.... (어플 로그 없음, 짧은 공백)
03:11:??  V8 fatal: Check failed: node->IsInUse()
04:01:08  새 컨테이너 시작 (StartedAt) — 우리가 수동으로 재기동
```

마지막 정상 로그를 자세히 보면, 어플은 **세 가지 다른 흐름** 이 동시에 돌고 있었던 것을 알 수 있습니다.

- B사 리뷰 댓글 등록 (BAEMIN)
- D사 락 획득/해제 (DDANGYO)
- Y사 로그인 → 답글 (YOGIYO)
- N사 브라우저 세션 정리 (NAVER, BrowserMonitoring 의 timeout 트리거)

특별히 "이상한" 흐름은 없습니다. 평소와 똑같이 동시에 돌아가는 작업들이고, 락 통계도 60개 한도 중 1개 남짓을 쓰고 있는 평범한 상태였습니다.

그런데도 컨테이너가 죽었습니다. 일단 종료 직후의 도커 상태를 봅니다.

```bash
$ docker inspect cmong-scrapper-js \
    --format='Status={{.State.Status}} ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}}'
Status=running ExitCode=0 OOMKilled=false
```

- **`OOMKilled=false`** — 메모리 부족 아님. 호스트 OOM killer 가 죽인 게 아닙니다.
- **`ExitCode=0`** — abort라면 보통 134(SIGABRT)나 음수 시그널이 찍혀야 할 텐데, 컨테이너 단위로는 0. 이건 우리가 수동으로 새 인스턴스를 띄우면서 컨테이너 ID 자체가 바뀐 결과였습니다 (자세한 건 2.3 절).

### 2.2 abort 직후의 npm 출력

V8 panic 직후 컨테이너 stdout 끝부분에는 다음과 같은 메시지가 남아있었습니다.

```text
npm error path /app
npm error command failed
npm error signal SIGTERM
npm error command sh -c xvfb-run --auto-servernum node --max-old-space-size=16384 dist/main
```

`npm error signal SIGTERM` 한 줄이 핵심입니다. V8이 `V8_Fatal` 에서 `abort()` 를 부르면 SIGABRT 가 발생하는데, 본 로그에서는 npm 의 child 프로세스 종료 신호가 SIGTERM 으로 기록됐습니다 — 이 로그만으로는 SIGABRT 가 SIGTERM 으로 변환되었다고 단정할 수 없습니다. 다만 어느 쪽이든 **JS 코드가 던진 예외가 아니라, 네이티브 프로세스 자체가 시그널로 죽었다** 는 점은 같습니다.

이 사실이 중요한 이유는: Node.js 의 `process.on('uncaughtException')`, `unhandledRejection` 같은 후크는 **이런 죽음을 잡지 못합니다.** V8 자체가 자기 무결성을 더 이상 보장 못하겠다고 abort 한 거라, 그 위에서 동작하던 JS 런타임은 신호도 못 받고 같이 죽습니다.

### 2.3 RestartCount 0 의 함정

가장 헷갈렸던 부분입니다. 도커 인스펙트 결과:

```bash
$ docker inspect cmong-scrapper-js --format='RestartCount={{.RestartCount}}'
RestartCount=0
```

**"RestartCount가 0이면 도커 자동 재시작 정책이 안 동작했다는 뜻 아닌가?"** — 처음 30초간은 그렇게 잘못 읽었습니다. 정책을 다시 봤더니:

```bash
$ docker inspect cmong-scrapper-js --format='{{json .HostConfig.RestartPolicy}}'
{"Name":"unless-stopped","MaximumRetryCount":0}
```

`unless-stopped` 는 멀쩡히 살아있었습니다. 그런데 왜 RestartCount=0이냐? 답은 단순했습니다.

- 컨테이너가 abort 한 직후, 운영 중인 우리 팀원이 **`docker compose up`을 다시 실행** 해 새 컨테이너를 띄웠습니다.
- 도커는 같은 이름의 새 컨테이너를 만들고 이전 인스턴스를 제거합니다 — **이름은 같지만 컨테이너 ID는 다릅니다.**
- 새로 만들어진 컨테이너 입장에서 RestartCount는 당연히 0에서 시작.

도커 이벤트 로그로 확인하면:

```bash
$ docker events --since '1h' --filter container=cmong-scrapper-js | grep -E 'die|start|restart'
# (이번 인스턴스 동안 die/restart 이벤트 없음 — 죽은 적 없음)
```

지난 1시간 동안 이번 컨테이너 인스턴스에서는 die / restart 이벤트가 한 건도 없습니다. 즉 **현재 인스턴스(`StartedAt: 04:01:08Z`) 는 새 컨테이너이고, 정책 자체는 정상 작동 상태**입니다. 만약 다음에 또 같은 abort가 나면 `unless-stopped` 가 자동으로 재시작시켜줄 겁니다. (1편의 사고에서는 운영자가 더 빨라서 정책이 일을 시작하기 전에 사람이 띄워버린 거라고 보면 됩니다.)

이 함정 한 가지를 정리해두면, 비슷한 상황에서 헷갈릴 시간을 줄일 수 있습니다.

> **헷갈리지 마세요**: `RestartCount=0` 은 "정책이 일하지 않았다" 가 아니라 "이 컨테이너 ID 가 시작된 이후로 한 번도 재시작된 적 없다" 입니다. 사람이 새로 띄우면 ID 가 바뀌고 카운터도 0으로 리셋됩니다. 정책 자체의 검증은 `HostConfig.RestartPolicy` 와 `docker events` 로 따로 확인해야 합니다.

### 2.4 한 가지 더 — 우리 환경의 dd-trace / pprof 버전

abort 메시지의 6번 프레임이 `@datadog/pprof/.../node-127.node` 를 가리키고 있어서, 컨테이너 안의 버전을 직접 확인했습니다.

```bash
$ docker exec cmong-scrapper-js node --version
v22.22.2
$ docker exec cmong-scrapper-js cat node_modules/@datadog/pprof/package.json | grep version
  "version": "5.14.1"
$ docker exec cmong-scrapper-js cat node_modules/dd-trace/package.json | grep version
  "version": "5.97.0"
$ docker exec cmong-scrapper-js printenv | grep DD_
DD_AGENT_HOST=172.17.0.1
DD_API_KEY=***
DD_ENV=production
DD_PROFILING_ENABLED=true     ← Continuous Profiler 켜져 있음
DD_SERVICE=cmong-scraper-js-prod
DD_TRACE_ENABLED=true         ← APM 트레이서 켜져 있음
```

세 가지 사실을 메모해 둡니다.

1. Node 22 위에서 돌고 있다 (`node-127.node` 의 `127` 은 V8 Module ABI version 으로, Node 22 계열이 사용하는 번호입니다).
2. `@datadog/pprof` 5.14.1 은 비교적 최근 릴리스 (2026-03)
3. Continuous Profiler 가 켜진 상태 (`DD_PROFILING_ENABLED=true`)

여기까지가 사건 현장입니다. 이제 본격적으로 **`node->IsInUse()` 가 도대체 무슨 뜻인지** 부터 풀어봅니다.

---

## 3. 첫 번째 사다리 — 그래서 'V8 핸들' 이 뭡니까

> 이 절은 V8 내부 용어가 처음인 분들을 위해 가장 천천히 갑니다. 한 칸에 한 개념씩만 올라가니, 뒤에서 헷갈리지 않도록 여기서 어휘를 단단히 잡아두면 좋습니다.

### 3.1 비유로 시작 — 보관함과 보관증

이 글의 모든 것을 관통하는 비유를 먼저 하나 박아두겠습니다.

> **V8 힙 = 거대한 보관함이 있는 코인 라커룸**
>
> JS에서 만든 모든 객체는 이 라커룸의 어떤 칸 안에 들어갑니다. 칸은 라커룸 직원(V8 GC)이 관리합니다.
>
> **handle = 그 칸을 가리키는 보관증**
>
> 보관증을 손에 쥐고 있는 동안 직원은 그 칸을 함부로 비우지 않습니다. 보관증 없는 칸 = 더는 아무도 안 찾는 칸 = 비워도 되는 칸.

이 비유 한 가지로 V8 핸들 시스템의 90% 가 설명됩니다. 진행하면서 디테일을 채워 나갑니다.

### 3.2 JS 변수에서 핸들로

JS에서 우리가 보통 쓰는 코드:

```js
const user = { name: '길동', age: 30 };
```

이 한 줄이 V8 입장에서 어떻게 보일까요?

1. V8 힙(라커룸)에 `{ name: '길동', age: 30 }` 객체용 칸 하나가 잡힙니다.
2. JS 엔진이 컴파일하면서, `user` 라는 식별자에 그 칸의 주소를 박습니다.
3. 함수가 끝나면 `user` 가 더는 안 보이고, 그 칸은 다음 GC 사이클에 회수됩니다.

JS 작성자 입장에선 그냥 변수입니다. 하지만 V8 내부에서 그 칸을 가리키는 자료구조를 **handle** 이라고 부릅니다. C++ 로 V8 임베딩을 해본 적 있다면 `Local<Value>`, `Persistent<Object>` 같은 타입을 본 적이 있을 겁니다 — 그게 바로 핸들의 C++ 표현입니다.

### 3.3 핸들의 세 종류

V8 핸들은 **수명**에 따라 세 가지로 구분됩니다.

| 종류 | 비유 | 수명 | 누가 만드나 |
|---|---|---|---|
| **`Local<T>`** | 일일 보관증 | `HandleScope` 하나 안에서만 유효 | 거의 모든 V8 API 호출이 자동으로 |
| **`Persistent<T>`** | 장기 보관증 | 명시적으로 `Reset()` / `Reset()` 호출 전까지 영구 | 네이티브 애드온, V8 내부 서브시스템 |
| **`Global<T>`** | `Persistent` 의 modern alias | 동일 | 동일 (요즘 코드는 `Global` 권장) |

`Local` 은 짧고 자동으로 정리되니 신경 쓸 일이 거의 없습니다. 우리가 추적해야 할 범인은 **`Persistent` (= `Global`)** 입니다.

`Persistent` 는 비유로 풀면 이런 겁니다:

> 일일 보관증(`Local`)은 그 건물 영업시간 동안만 유효해서 영업이 끝나면 자동 회수됩니다. 그러나 장기 보관증(`Persistent`)은 본인이 손수 직원에게 갖다 주기 전엔 평생 유효합니다. 손에서 떨어뜨려서 잃어버려도 회수가 안 됩니다(= 메모리 누수).

### 3.4 누가 `Persistent` 를 만드나

크게 둘입니다.

1. **네이티브 애드온 (NAN, N-API)** — `node-sqlite3`, `bcrypt`, `@datadog/pprof` 같은 C++ 모듈이 JS 객체를 자기 메모리 안에서 길게 들고 있어야 할 때 만듭니다.
2. **V8 자기 자신** — V8 내부 서브시스템도 자기 안에서 JS 힙 객체를 참조해야 할 때가 있습니다. 대표적인 게 우리가 곧 만날 **CPU Profiler** 입니다.

오늘 사건의 주인공은 두 번째입니다. **V8 의 CPU Profiler 가 자기 일을 하면서 만든 `Persistent`** 가 어느 순간 라이프사이클을 어겼고, 어설션이 깨졌습니다.

### 3.5 핸들이 실제로 저장되는 곳 — GlobalHandles

이제 한 칸 더 올라갑니다. `Persistent` 핸들이 실제로 어디에 저장될까요?

V8 은 모든 `Persistent` 를 한 군데에 모아서 관리합니다. 그 자료구조의 이름이 **`GlobalHandles`** 입니다.

```text
[GlobalHandles 라는 큰 배열]

  ┌───────────────────────────────────────────────────┐
  │ Block #1                                          │
  │ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐  ...           │
  │ │ N0 │ │ N1 │ │ N2 │ │ N3 │ │ N4 │                │
  │ └────┘ └────┘ └────┘ └────┘ └────┘                │
  ├───────────────────────────────────────────────────┤
  │ Block #2                                          │
  │ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐  ...           │
  │ │ N0 │ │ N1 │ │ N2 │ │ N3 │ │ N4 │                │
  │ └────┘ └────┘ └────┘ └────┘ └────┘                │
  ├───────────────────────────────────────────────────┤
  │  ... (필요한 만큼 블록 추가)                         │
  └───────────────────────────────────────────────────┘
```

각 칸(=`Node`)은 다음 정보를 담는 작은 자료구조입니다.

- 가리키는 JS 객체의 주소
- 이 칸이 **사용 중인지(IN_USE) / 비어있는지(FREE)** 의 1비트 플래그
- weak 인지 strong 인지 등 부가 메타

**중요**: 여기서 `Node` 라는 이름은 Node.js 와 **아무 관계가 없습니다.** V8 GlobalHandles 가 자기 슬롯을 부르는 이름일 뿐입니다. 헷갈리기 쉬우니 이 글에서는 의식적으로 "슬롯" 이라고 쓰겠습니다 (원본 코드 인용을 제외하고는).

### 3.6 슬롯 한 칸의 라이프사이클

비유로 다시:

```text
[빈 슬롯, FREE]
        │
        │  ① 누군가 Persistent 를 만들었다 (= 보관증 발급)
        ▼
[사용 중, IN_USE]   ← IsInUse() == true
        │
        │  ② Persistent.Reset() 호출 (= 보관증 반납)
        ▼
[빈 슬롯, FREE]    ← IsInUse() == false (다시 비어있는 상태로)
```

- `IsInUse()` 는 슬롯의 1비트 플래그를 읽어서 `true` / `false` 만 반환하는 매우 단순한 함수입니다.
- 슬롯이 비면 free list 에 다시 들어가서 다른 `Persistent` 발급 요청에 재사용됩니다 (보관함 칸을 다른 손님에게 빌려주는 것과 같음).

이게 정상적인 흐름입니다. 그런데 이 흐름을 어기면 어떻게 될까요? 그 답이 사건의 핵심이고, 다음 절에서 본격적으로 다룹니다.

> **여기서 잠깐 — 사다리 점검**
>
> ① JS 변수 → ② V8 안의 핸들 → ③ 그 중에서도 길게 사는 `Persistent` → ④ `Persistent` 들이 모이는 곳 = `GlobalHandles` → ⑤ 칸 하나 = 슬롯, 상태는 IN_USE / FREE 두 가지.
>
> 여기까지 오면 V8 어설션 메시지를 읽을 준비가 됩니다.

---

## 4. 두 번째 사다리 — `IsInUse()` 와 V8 의 약속

### 4.1 어설션이 깨진 진짜 위치

V8 코드(`deps/v8/src/handles/global-handles.cc`) 에 우리가 봐야 할 함수가 있습니다.

```cpp
template <class NodeType>
void GlobalHandles::NodeSpace<NodeType>::Free(NodeType* node) {
  CHECK(node->IsInUse());        // ← 여기서 깨짐
  node->Release(first_free_);    // 슬롯을 free list 로 반환
  first_free_ = node;
  BlockType* block = BlockType::From(node);
  if (block->DecreaseUsage()) {
    block->ListRemove(&first_used_block_);
  }
  global_handles_->isolate()->counters()
                  ->global_handles()->Decrement();
  handles_count_--;
}
```

이 함수는 슬롯 한 칸을 비우는(= 보관증을 반납하는) 일을 합니다. 한 줄씩 풀면:

1. **`CHECK(node->IsInUse())`** — "이 슬롯, 진짜 사용 중 맞아?" 라고 묻습니다.
2. `node->Release(first_free_)` — 슬롯 상태를 FREE 로 바꾸고, free list 의 머리에 끼워 넣습니다.
3. 블록 사용량을 줄입니다 (블록이 완전히 비면 used 리스트에서 제거).
4. 통계 카운터를 깎습니다.

핵심은 1번 줄입니다. **`CHECK` 는 V8 의 "여기까지 왔다면 이건 무조건 참이어야 한다" 는 약속** 입니다. 거짓이면 V8 은 즉시 abort 합니다.

### 4.2 `CHECK` vs `DCHECK` — 왜 release 빌드에서도 폭발했나

V8 (그리고 Chromium 전반) 에는 두 종류의 어설션이 있습니다.

| 매크로 | release 빌드에서 | 의미 |
|---|---|---|
| `DCHECK` | 컴파일에서 제거됨 (no-op) | "디버그할 때만 검사하는 가정" |
| `CHECK` | **그대로 살아있음** | "이 가정이 깨지면 메모리 안전성 자체가 무너진다 — 그냥 죽자" |

`CHECK(node->IsInUse())` 는 두 번째입니다. release 빌드(= 우리가 운영에서 쓰는 Node 바이너리)에서도 **그대로 abort 합니다.** 디버그 모드에서만 보이고 마는 가벼운 버그가 아니라, V8 입장에서 "이게 깨지면 더 이상 메모리 안전을 보장 못 한다" 고 판단하는 위험 신호입니다.

### 4.3 평소 우리가 쓰는 말로 번역하면

```cpp
CHECK(node->IsInUse());
```

이 한 줄을 직역하면 "이 슬롯은 사용 중이어야 한다" 입니다. 그런데 이 함수의 이름이 `Free` 라는 걸 다시 봅시다. 슬롯을 **비우려는** 함수에서 "이미 사용 중이어야 한다" 를 검사하고 있습니다. 즉:

> "비우려는 슬롯이, 막상 와보니 이미 비어있더라."

C/C++ 언어로 옮기면 한 단어로 끝납니다.

> **double-free.**

같은 메모리 영역을 두 번 free 하는 거랑 정확히 똑같은 사고입니다. C 라이브러리(`malloc`/`free`) 에선 immediate UB(undefined behavior) 가 되고, V8 에선 친절하게 "double-free 발견했다" 고 어설션을 깨고 abort 합니다.

> **요점 정리**
>
> 직전에 짧게 답할 때 저는 이걸 "이미 사용 중인 걸 발견해서 IsInUse 가 실패" 라고 거꾸로 말했었습니다. 정확한 의미는 반대입니다 — **"사용 중이어야 한다는 약속이 깨진 채 비우러 들어왔다 = 이미 누가 비웠다 = double-free"**.

### 4.4 보관함 비유로 다시

라커룸 직원의 일과를 상상해 봅시다.

> 직원: "이 칸 비워달라고? 알겠어. 어디 보자... (열어봄) 어? 이 칸 이미 비어있는데? 누가 벌써 비웠어?"
>
> (시스템 panic — 직원이 도저히 신뢰할 수 없는 상황을 만났으므로 라커룸 영업을 중단)

V8 은 정확히 이 상황입니다. 내부 자료구조의 무결성이 깨진 걸 발견했고, 그 위에서 더 이상 안전을 보장할 수 없으니 abort 합니다.

여기서 V8 의 설계 철학이 한 가지 드러납니다:

> "메모리 안전성이 한 번 깨졌다고 의심되면, 이상한 결과를 내며 계속 도는 것보다 즉시 죽는 게 낫다."

이 철학 덕에 우리는 적어도 abort 시점의 깨끗한 스택 트레이스를 받아볼 수 있습니다 (그렇지 않다면 메모리 깨진 채 한참 돌다가 한참 뒤에 의문의 SIGSEGV 가 났겠지요). 짧게 죽는 대신 진단이 가능한 셈입니다.

### 4.5 V8 GlobalHandles 슬롯 시각화

여기까지의 개념 — 블록, 슬롯, IN_USE/FREE 상태, IsInUse() 1비트 플래그 — 을 한 장에 펼쳐 두면 다음 글이 훨씬 빠르게 읽힙니다.

<!--
Excalidraw 다이어그램 (라이트/다크 2장):
- 가운데에 GlobalHandles 라는 큰 박스
- 안에 Block #1, Block #2 두 개
- 각 블록 안에 슬롯 박스 5개씩
- 슬롯 위에 작은 1-bit 플래그 (○ = FREE, ● = IN_USE)
- 화살표 두 개:
   ① "Persistent 발급" → FREE 슬롯이 IN_USE 로 전이 (○ → ●)
   ② "Persistent.Reset()" → IN_USE 슬롯이 FREE 로 전이 (● → ○)
- 우측 상단에 free list 의 시작점 (first_free) 표시
- 폭주 케이스 박스: "이미 ○ 인 슬롯에 또 Reset → CHECK fail"
파일명:
- /src/assets/images/v8-globalhandles-slots-light.svg
- /src/assets/images/v8-globalhandles-slots-dark.svg
-->

<img src="/src/assets/images/v8-globalhandles-slots-light.svg" alt="V8 GlobalHandles 슬롯 구조와 상태 전이" class="theme-img-light" />
<img src="/src/assets/images/v8-globalhandles-slots-dark.svg" alt="V8 GlobalHandles 슬롯 구조와 상태 전이" class="theme-img-dark" />

이 그림을 머리에 담은 채로 사고 스택을 다시 보면, 6번 프레임 위에서부터 죽 내려가며 "어느 슬롯의 IsInUse 가 깨졌나" 를 추적할 수 있게 됩니다.

<details>
<summary><b>(심도) 슬롯이 일반 malloc/free 가 아닌 이유</b> (펼치기)</summary>

V8 이 굳이 `GlobalHandles` 라는 별도 자료구조를 두는 이유는 두 가지입니다.

1. **GC 와의 협력** — V8 GC 가 힙을 청소할 때, 살아있는 모든 `Persistent` 를 빠르게 순회할 수 있어야 합니다. 슬롯이 블록 단위로 모여 있으면 캐시 친화적으로 한 번에 훑을 수 있습니다.
2. **할당 비용 절감** — `Persistent` 를 만들고 풀고 만들고 풀고를 반복하는 워크로드(예: 프로파일러)에서 매번 malloc/free 를 부르는 건 비쌉니다. 한 번 잡은 블록을 재사용하면서 슬롯만 IN_USE / FREE 상태로 토글하는 게 압도적으로 빠릅니다.

대신 트레이드오프가 있습니다 — 슬롯 풀(pool) 에 들어 있는 칸을 두 번 반환하면 free list 가 망가집니다. C 라이브러리 free 는 다행히 glibc 같은 데서 검사를 해주지만, V8 슬롯은 자기 안에서만 의미 있으니 자체 어설션(`CHECK(IsInUse())`)을 박아둔 겁니다.

이게 "왜 이 어설션이 그렇게 신성한가" 의 답이기도 합니다. 슬롯 풀 무결성이 깨지면 단순히 객체 하나의 문제가 아니라 **앞으로 발급되는 모든 `Persistent` 의 안전성** 이 의심됩니다 — 그래서 죽는 게 맞습니다.

</details>

---

## 5. 세 번째 사다리 — JS 프레임이 한 줄도 없다는 건 무슨 뜻인가

이제 처음 던졌던 두 번째 질문으로 돌아옵니다. 스택을 다시 봅니다.

```text
 1: 0x102a331  [node]                                ← 시그널 핸들러
 2: V8_Fatal(...)                                    ← V8 panic 진입
 3: GlobalHandles::Destroy(...)                      ← 슬롯 비우기
 4: WeakCodeRegistry::Clear()                        ← 슬롯들 일제 비우기
 5: CpuProfiler::StopProfiling(unsigned int)         ← V8 빌트인 CPU 샘플러 끄기
 6: dd::WallProfiler::StopAndCollectImpl(...)        ← @datadog/pprof
 7: dd::WallProfiler::StopAndCollect(...)            ← JS→native 진입점
 8: 0x765d4006c894 [pprof native]                    ← NaN 콜백 thunk
 9: 0x121c5e9 [node]                                 ← V8 의 JS→C++ 호출 자리
10: 0x765d3b5cf655                                   ← 심볼 없는 JIT 코드 주소
```

위(1) 가 가장 최근, 아래(10) 가 가장 오래된 호출자입니다. 1~7번까지는 우리가 다 식별했습니다 — 모두 네이티브 코드입니다. 그리고 8~10번에는 우리 어플의 `cpeats.service.ts:42` 같은 JS 프레임이 등장하지 않습니다. 보이는 건 익명의 주소뿐입니다.

이게 왜 그럴까요?

### 5.1 트리거는 JS, 죽은 곳은 V8 청소부

가장 흔한 오해부터 풀어둡니다.

> ❌ "JS 프레임이 없으니 우리 어플 코드는 이 사고와 무관하다."

이건 **반은 맞고 반은 틀린 결론** 입니다. 정확히는:

- **죽은 시점에** JS 코드가 실행 중이지 않았다 → 맞음
- **이 abort 를 시작시킨 게** JS 코드가 아니다 → 틀림

dd-trace 의 Continuous Profiler 는 1분마다 한 번씩 V8 의 CPU Profiler 를 stop 시켰다가 다시 start 합니다. 그 stop 호출이 어디서 일어날까요? — JS 코드입니다. `setInterval` 로 등록한 JS 함수가 1분에 한 번 실행되면서 `wallProfiler.stop()` 같은 메서드를 부릅니다.

```text
[JS] dd-trace 의 1분 타이머 콜백 실행
 │
 ▼
[JS→C++ 경계] NaN 콜백 변환 thunk         ← 9, 10 번 프레임이 여기 (JIT 된 호출)
 │
 ▼
[Native] dd::WallProfiler::StopAndCollect   ← 7
 │
 ▼
[Native] StopAndCollectImpl                  ← 6
 │
 ▼ (이 시점부터 V8 내부 청소부 루틴, JS 인터프리터/JIT은 잠시 멈춰 있음)
[V8 internal] CpuProfiler::StopProfiling     ← 5
[V8 internal] WeakCodeRegistry::Clear        ← 4
[V8 internal] GlobalHandles::Destroy         ← 3
[V8 internal] V8_Fatal → abort()             ← 1, 2
```

### 5.2 왜 어플 JS 프레임이 안 보이는가

위 흐름에서 한 가지 사실이 결정적입니다. 9~10번 프레임의 JIT 코드는 **dd-trace 의 1분 타이머 콜백** 의 마지막 줄입니다. 우리 어플 코드(`cpeats.service.ts`, `baemin.service.ts`, ...) 는 이 콜백 체인에 끼어 있지 않습니다.

dd-trace 의 타이머는 별도의 macrotask 로 큐잉됩니다. JS 이벤트 루프가 **우리 어플 코드의 microtask 가 끝난 직후, 다음 macrotask 를 꺼낼 때** 타이머 콜백이 실행됩니다. 그래서 호출 스택은:

- 우리 어플의 외부 API 호출(YOGIYO addReply) 이 `await` 로 빠진다
- 이벤트 루프가 한가해진다
- 다음 tick 에 dd-trace 의 1분 타이머 콜백이 실행된다
- 그 콜백 안에서 `wallProfiler.stop()` 호출
- 네이티브로 내려가서 V8 청소부 루틴 진입
- 청소부가 어설션 깨뜨림 → abort

abort 시점의 호출 스택은 **타이머 콜백 → 네이티브 → V8 청소부** 입니다. 우리 어플 함수들은 이미 `await` 뒤로 빠져 있어서 스택에 없습니다.

### 5.3 그래서 무엇이 함의되는가

이 사실은 진단에 두 가지 시사점을 줍니다.

1. **어플 로직 자체는 이 사고를 막을 수 없다.** BAEMIN/YOGIYO/락 매니저 어디를 고쳐도 트리거는 1분마다 어김없이 발생합니다. JS 단에서 try/catch 로 감쌀 수 있는 차원이 아닙니다 (네이티브 abort 는 잡히지 않습니다).
2. **반면 트리거를 끄면 사고도 사라진다.** Datadog Continuous Profiler 가 1분 타이머의 시작점이므로, `DD_PROFILING_ENABLED=false` 한 줄로 트리거 자체가 없어집니다. (단, 이건 응급 조치이고 항구적 처방은 아닙니다 — 자세한 건 2편에서)

### 5.4 마지막 정상 로그와의 시간 간격

스택만 봐도 이미 답이 나오지만, 마지막 정상 로그(03:11:12.176, YOGIYO addReply) 와 V8 abort 사이의 시간 공백도 같은 그림을 가리킵니다.

- YOGIYO addReply 는 외부 HTTP 호출이라 응답까지 수백 ms 가 걸립니다.
- 그 사이 이벤트 루프는 다른 macrotask 를 꺼내 처리합니다.
- 다음 macrotask 중 하나가 dd-trace 의 1분 타이머였고, 거기서 `wallProfiler.stop()` 이 호출됐습니다.
- 그게 V8 청소부 루틴까지 도달해서 abort 했습니다.

03:11:12 이후의 짧은 공백은 "어플 로그가 끊긴 게 이상하다" 가 아니라 **"어플은 정상적으로 외부 API 응답을 기다리고 있었고, 그 한가한 틈을 타 dd-trace 타이머가 발화했다"** 는 그림에 부합합니다.

---

## 6. 1편을 마치며 — 여기까지의 어휘 사전

이 글에서 우리는 다음을 했습니다.

1. **사고 현장을 정리**했습니다 — 마지막 정상 로그, V8 panic 메시지, npm SIGTERM, 도커 RestartCount 0 의 함정.
2. **V8 핸들 사다리 1**을 올랐습니다 — JS 변수 → 핸들 → `Persistent` → `GlobalHandles` 슬롯 → IN_USE/FREE 상태.
3. **`Check failed: node->IsInUse()` 를 번역**했습니다 — 한 마디로 "double-free 어설션".
4. **JS 프레임이 없는 이유를 풀었습니다** — 트리거는 JS(dd-trace 타이머), 죽은 곳은 V8 청소부 루틴. 어플 로직은 무관하지만, 트리거를 끄면 사고가 사라집니다.

그리고 자연스럽게 다음 질문이 쌓였습니다.

> **그러면 V8 청소부(WeakCodeRegistry)는 도대체 무엇을 청소하다 슬롯을 두 번 비웠나?**
>
> **dd-trace의 1분 타이머가 그 청소부를 어떻게 호출했나? 왜 6주 전에 새 코드패스가 들어가면서 race window 가 넓어졌다고 의심하나?**
>
> **그러면 우리는 무엇을 어떻게 끄고, 항구적으로는 어떻게 처방해야 하나?**

이 세 질문에 답하는 게 [2편](/posts/datadog-profiler-v8-crash-deep-dive-part2)입니다. 1편에서 잡아둔 어휘(슬롯, IsInUse, GlobalHandles, JS→C++ 경계) 가 거기서 그대로 다시 등장합니다.

---

## References

### V8 / Node.js 소스
- [V8 GlobalHandles — `deps/v8/src/handles/global-handles.cc`](https://github.com/v8/v8/blob/main/src/handles/global-handles.cc)
- [Node.js Embedder Crash: Check failed: node->IsInUse() (#52418)](https://github.com/nodejs/node/issues/52418) — 동일 어설션을 본 다른 사례 (Javet, Node 20.12 회귀)

### 동일 어설션을 본 GitHub 이슈들
- [vitest #5037 — watch 모드 crash](https://github.com/vitest-dev/vitest/issues/5037)
- [ssh2 #1393](https://github.com/mscdex/ssh2/issues/1393)
- [onnxruntime #23794](https://github.com/microsoft/onnxruntime/issues/23794)
- [napi-rs #2555](https://github.com/napi-rs/napi-rs/issues/2555)

### Datadog
- [dd-trace-js (Datadog APM 라이브러리)](https://github.com/DataDog/dd-trace-js)
- [@datadog/pprof (pprof-nodejs, 프로파일러 네이티브 애드온)](https://github.com/DataDog/pprof-nodejs)
- [Datadog Node.js Profiler Troubleshooting (공식 문서)](https://docs.datadoghq.com/profiler/profiler_troubleshooting/nodejs/)

### Docker
- [Docker Restart Policies (공식 문서)](https://docs.docker.com/engine/containers/start-containers-automatically/) — `unless-stopped` 와 `RestartCount` 의 정확한 정의
