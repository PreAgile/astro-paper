---
author: 김면수
pubDatetime: 2026-01-08T12:00:00Z
title: "배달 플랫폼 스크래핑 대장정 - 글로벌 Anti-Bot 솔루션을 뚫기까지"
featured: false
draft: true
tags:
  - Scraping
  - Playwright
  - Anti-Bot
  - Camoufox
  - TLS Fingerprinting
  - Browser Automation
description: "글로벌 Anti-Bot 솔루션을 뚫고 99% 성공률을 달성하기까지의 여정. API에서 Playwright, Stealth, Camoufox까지 진화한 스크래핑 아키텍처 5부작 시리즈 개요."
---

## 목차

> 글로벌 Anti-Bot 솔루션을 뚫고 99% 성공률을 달성하기까지의 여정

---

## 시리즈 개요

**배달 플랫폼 C사**의 리뷰 데이터 스크래핑 시스템을 구축하면서 겪은 수많은 시행착오와 개선 과정을 정리합니다. API 호출 방식에서 시작해 **글로벌 Anti-Bot 솔루션 A사**의 차단에 맞서 Playwright, Stealth 플러그인, Camoufox까지 진화한 아키텍처 변천사입니다.

---

## Part 1: API에서 브라우저 자동화로 - 스크래핑의 첫 걸음

### 주제
- 초기 API 기반 스크래핑 아키텍처
- Playwright 내부 아키텍처와 CDP 통신
- 효율적인 세션 풀 설계

### 소제목
1. **API 호출 방식의 한계**
   - 세션 쿠키 수동 관리의 복잡성
   - 동적 렌더링 페이지의 한계
   - 인증 상태 유지의 어려움

2. **Playwright 도입 배경**
   - 브라우저 자동화 도구 비교 (Puppeteer vs Playwright)
   - Chromium 기반 첫 구현
   - Context와 Browser 분리 전략

3. **Playwright 내부 아키텍처 딥다이브**
   - **계층 구조 이해**
     ```
     Browser (프로세스)
       └── BrowserContext (시크릿 모드와 유사)
             └── Page (탭)
                   └── Frame (iframe)
     ```
   - **CDP (Chrome DevTools Protocol) 통신 구조**
     - Node.js ↔ WebSocket ↔ Browser 프로세스
     - CDP 세션과 타겟 개념
     - 명령(Command) vs 이벤트(Event) 패턴
   - **IPC (Inter-Process Communication) 흐름**
     - playwright-core가 브라우저 프로세스 spawn
     - WebSocket을 통한 양방향 통신
     - 각 Page마다 별도의 CDP 세션
   - **코드 레벨 통신 흐름**
     ```typescript
     // 실제 통신 흐름
     page.goto(url)
       → Playwright Client (Node.js)
         → WebSocket Message (JSON-RPC)
           → Browser Process (CDP Handler)
             → Renderer Process
               → Network Stack
     ```

4. **효율적인 세션 풀 설계 전략**
   - **Browser vs BrowserContext 분리의 이유**
     - Browser: 무거움 (프로세스), 생성 비용 높음
     - Context: 가벼움 (메모리), 생성 비용 낮음
     - 최적 비율: 1 Browser당 5~10 Context 권장
   - **세션 풀 설계 패턴**
     - Object Pool 패턴 적용
     - Lazy Initialization vs Eager Initialization
     - 풀 크기 동적 조절 (min/max)
   - **락(Lock) 메커니즘 심화**
     - Redis 기반 분산 락 (Redlock 알고리즘)
     - 세션 획득 → 사용 → 반환 흐름
     - 데드락 방지: TTL 설정과 heartbeat
     - Race Condition 방지: Compare-and-Set

5. **세션 관리 전략**
   - 세션 생성/유지/만료 정책
   - 로그인 상태 캐싱
   - 세션 재사용을 통한 리소스 절약

### 관련 커밋
- `4ae0979` feat: only context -> browser / context 분할
- `f56fb24` feat: lock 추가 queue 제거
- `4884ecd` feat: 캐싱 레디스로 전환
- `e996a5c` feat: ssl 에러 혹은 로그인 실패시 3회 리트라이

### 아키텍처 다이어그램
```
┌──────────────────────────────────────────────────────────────────┐
│                     Node.js Process (Playwright Client)          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Session Pool Manager                    │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐                   │  │
│  │  │ Session1 │ │ Session2 │ │ Session3 │  ...              │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘                   │  │
│  └───────┼────────────┼────────────┼─────────────────────────┘  │
│          │            │            │                             │
│          └────────────┼────────────┘                             │
│                       ▼                                          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                 CDP Connection Manager                     │  │
│  │            (WebSocket JSON-RPC Protocol)                   │  │
│  └───────────────────────┬────────────────────────────────────┘  │
└──────────────────────────┼───────────────────────────────────────┘
                           │ WebSocket (ws://localhost:PORT)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Browser Process (Chromium)                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    CDP Server (DevTools)                   │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐     │
│  │  BrowserContext │ │  BrowserContext │ │  BrowserContext │     │
│  │  (독립 쿠키/    │ │  (독립 쿠키/    │ │  (독립 쿠키/    │     │
│  │   스토리지)     │ │   스토리지)     │ │   스토리지)     │     │
│  │  ┌───────────┐  │ │  ┌───────────┐  │ │  ┌───────────┐  │     │
│  │  │   Page    │  │ │  │   Page    │  │ │  │   Page    │  │     │
│  │  │ (Renderer)│  │ │  │ (Renderer)│  │ │  │ (Renderer)│  │     │
│  │  └───────────┘  │ │  └───────────┘  │ │  └───────────┘  │     │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

---

## Part 2: 글로벌 Anti-Bot 솔루션과의 첫 만남 - 쿠키 기반 보안의 이해

### 주제
- A사 Bot Manager 동작 원리
- 쿠키 기반 보안 메커니즘 분석
- A사 공식 문서/리포트 기반 대응

### 소제목
1. **갑자기 올라간 실패율**
   - 403 에러의 증가
   - WAF(Web Application Firewall) 차단 패턴
   - 차단 로그 분석

2. **A사 Bot Manager 공식 문서 분석**
   - **A사 탐지 레이어**
     - Layer 1: IP Reputation (IP 평판)
     - Layer 2: Device Fingerprinting (디바이스 핑거프린팅)
     - Layer 3: Behavioral Analysis (행동 분석)
     - Layer 4: Challenge/Response (챌린지)
   - **A사 리포트에서 확인한 탐지 기준**
     - Bot Score 계산 방식
     - Risk Level 분류 (Low/Medium/High)
     - 탐지 시그니처 업데이트 주기

3. **A사 보안 쿠키 심층 분석**
   - **`_abck` 쿠키 (Anti-Bot Cookie)**
     - 센서 데이터 수집 결과
     - 브라우저 환경 검증 정보
     - 값 구조: `{version}~{timestamp}~{sensor_data_hash}~{...}`
   - **`bm_sv` 쿠키 (Session Validation)**
     - 세션 유효성 검증
     - loader.min.js 실행 후 생성
     - 생성 조건: JavaScript 실행 완료 + 센서 데이터 전송 성공
   - **`bm_sz` 쿠키 (Size/Behavior)**
     - 페이지 로딩 행동 패턴
     - 마우스/키보드 이벤트 수집
   - **`ak_bmsc` 쿠키 (Bot Management Session Cookie)**
     - 초기 세션 식별자
     - 후속 요청 검증에 사용

4. **네트워크 콜에서 항상 체크한 값들**
   - **Request Headers 검증 항목**
     ```
     - User-Agent: 일관성 체크
     - Accept-Language: 브라우저 설정과 일치 여부
     - Accept-Encoding: gzip, deflate, br 순서
     - Sec-Ch-Ua: Client Hints 값
     - Sec-Fetch-*: 요청 컨텍스트 메타데이터
     ```
   - **Response Headers 모니터링**
     ```
     - Set-Cookie: bm_sv, _abck 갱신 여부
     - X-A사-*: 디버깅 헤더 (있을 경우)
     - Cache-Control: 캐시 정책 변화
     ```
   - **쿠키 상태 실시간 체크**
     ```typescript
     // 매 요청마다 체크한 항목
     const cookieChecklist = {
       '_abck': { exists: boolean, valid: boolean, age: number },
       'bm_sv': { exists: boolean, freshness: number },
       'bm_sz': { exists: boolean },
       'ak_bmsc': { exists: boolean }
     };
     ```

5. **loader.min.js 딥다이브**
   - 스크립트 로딩 시점과 쿠키 생성
   - 난독화된 코드 분석 방법
   - 센서 데이터 수집 항목
     - Canvas/WebGL 핑거프린트
     - Audio Context 핑거프린트
     - 폰트 목록
     - 화면 해상도/색상 깊이
     - 타임존/언어 설정

6. **쿠키 기반 차단 우회 시도**
   - 쿠키 저장 및 재사용 전략
   - Header 조작 시도
   - 실패와 교훈

### 관련 커밋
- `171cc34` fix: C사 스크래퍼 A사 차단 우회 및 세션 안정성 강화
- `c80bc94` fix: A사 차단 회피를 위해 휴먼처럼 로그인했던거 삭제 및 Header 수정
- `d91b2b4` fix: C사 getSales API 403 에러 해결 및 WAF 우회

### 참고 논문/자료
- A사 Bot Manager 공식 문서
- A사 State of the Internet Report
- Browser Fingerprinting 관련 논문
- "FP-STALKER: Tracking Browser Fingerprint Evolutions" (S&P 2018)

---

## Part 3: Stealth 플러그인 - 봇 탐지 우회의 시작

### 주제
- 브라우저 핑거프린팅 이해
- Stealth 플러그인 동작 원리
- Node.js 메모리 모델과 누수 해결

### 소제목
1. **왜 일반 Playwright는 탐지되는가**
   - navigator.webdriver 속성
   - Chrome DevTools Protocol 흔적
   - 브라우저 핑거프린팅 요소들

2. **Stealth 플러그인 분석**
   - puppeteer-extra-plugin-stealth 원리
   - playwright-stealth 적용
   - 각 evasion 모듈 설명
     - `chrome.runtime` 패치
     - `navigator.webdriver` 숨기기
     - `navigator.plugins` 조작
     - WebGL 벤더/렌더러 스푸핑

3. **rebrowser-playwright 전환**
   - TLS Fingerprinting 이슈
   - rebrowser-playwright 특징
   - 성공률 변화 측정

4. **Playwright 메모리 누수 해결 - CS 지식 기반 접근**
   - **Node.js 메모리 모델 이해**
     - **V8 Heap Memory 구조**
       ```
       ┌─────────────────────────────────────┐
       │            V8 Heap                  │
       │  ┌─────────────────────────────┐    │
       │  │    New Space (Young Gen)    │    │  ← 단기 객체
       │  │  ┌─────────┐ ┌─────────┐    │    │
       │  │  │ From    │ │ To      │    │    │  ← Scavenge GC
       │  │  └─────────┘ └─────────┘    │    │
       │  └─────────────────────────────┘    │
       │  ┌─────────────────────────────┐    │
       │  │    Old Space (Old Gen)      │    │  ← 장기 객체
       │  │    Mark-Sweep-Compact GC    │    │
       │  └─────────────────────────────┘    │
       │  ┌─────────────────────────────┐    │
       │  │    Large Object Space       │    │  ← 큰 객체 (>1MB)
       │  └─────────────────────────────┘    │
       └─────────────────────────────────────┘
       ```
     - **RSS (Resident Set Size) vs Heap**
       - RSS: OS가 프로세스에 할당한 실제 물리 메모리
       - Heap Used: V8이 사용 중인 JavaScript 객체 메모리
       - Heap Total: V8이 OS로부터 확보한 메모리
       - External: V8 외부 C++ 객체 (Buffer 등)
   - **메모리 측정 방법**
     ```typescript
     // Node.js 메모리 측정
     const memUsage = process.memoryUsage();
     // { rss, heapTotal, heapUsed, external, arrayBuffers }

     // V8 상세 통계
     const v8 = require('v8');
     const heapStats = v8.getHeapStatistics();
     ```
   - **OS 레벨 프로세스 모니터링**
     - `/proc/{pid}/status` 파싱 (Linux)
     - `ps aux` 메모리 컬럼 해석
     - VmRSS vs VmSize 차이
   - **브라우저 프로세스와 Node.js 프로세스 분리 이해**
     ```
     ┌─────────────────┐      ┌─────────────────┐
     │  Node.js (PID1) │ WS   │  Chromium (PID2)│
     │  - Playwright   │◄────►│  - Renderer     │
     │  - Heap ~200MB  │      │  - RSS ~500MB   │
     └─────────────────┘      └─────────────────┘
                                     │
                              ┌──────┴──────┐
                              ▼             ▼
                         GPU Process   Network Process
     ```

5. **메모리 누수 유형별 해결**
   - **Context 미정리로 인한 누수**
     - Browser는 살아있고 Context만 쌓이는 문제
     - Context close 누락 케이스 추적
     - 해결: finally 블록에서 무조건 close 보장
   - **Event Listener 누수**
     - page.on() 이벤트 미해제
     - 네트워크 인터셉터 정리
     - 해결: removeListener 또는 once() 사용
   - **Tracing 충돌 문제**
     - 세션 재사용 시 tracing 중복 시작
     - tracing 상태 관리
   - **메모리 누수 탐지 방법**
     ```typescript
     // 주기적 메모리 스냅샷
     setInterval(() => {
       const mem = process.memoryUsage();
       if (mem.heapUsed > threshold) {
         // Heap Snapshot 생성
         const v8 = require('v8');
         v8.writeHeapSnapshot();
       }
     }, 60000);
     ```

6. **프로세스 동기화와 정리**
   - **Graceful Shutdown 패턴**
     - SIGTERM/SIGINT 핸들링
     - 진행 중인 작업 완료 대기
     - 리소스 역순 정리
   - **좀비 프로세스 방지**
     - 부모-자식 프로세스 관계
     - orphan 프로세스 감지
     - PID 파일 기반 추적

### 관련 커밋
- `fe61c1a` feat: rebrowser-playwright 의존성 추가
- `c76a7c2` feat: BrowserService A사 우회 설정 강화
- `c91f3e6` fix: A사 TLS fingerprinting 차단 우회를 위해 requestLegacy로 전환
- `56a502e` fix: 세션 재사용 시 Playwright tracing 충돌 해결
- `f6d90ad` fix: 메모리 누수 방지를 위한 다중 방어 로직 구현

### 기술 딥다이브
- WebGL Fingerprinting
- Canvas Fingerprinting
- TLS JA3 Fingerprinting
- Node.js Garbage Collection 튜닝

---

## Part 4: Camoufox - Firefox 기반 Anti-detection의 정점

### 주제
- Chromium에서 Firefox로 전환 이유
- Camoufox 내부 아키텍처와 TLS Fingerprinting 우회
- 메모리 관리와 프로세스 추적

### 소제목
1. **왜 Firefox인가**
   - Chromium 기반 브라우저의 한계
   - Firefox의 봇 탐지 우회 장점
   - Camoufox 선택 배경

2. **Camoufox 내부 아키텍처 딥다이브**
   - **Firefox vs Chromium 구조 차이**
     ```
     [Chromium]                    [Firefox]
     Multi-process:                Multi-process:
     - Browser Process             - Parent Process
     - Renderer Process (per tab)  - Content Process (per tab)
     - GPU Process                 - GPU Process
     - Network Process             - Socket Process

     Protocol:                     Protocol:
     - CDP (Chrome DevTools)       - Marionette (Selenium)
     - Proprietary                 - WebDriver BiDi
     ```
   - **Camoufox 수정 레이어**
     - Firefox ESR 기반 패치
     - Anti-fingerprinting 모듈
     - TLS 스택 수정
     - WebRTC 제어

3. **TLS Fingerprinting 우회 - A사 보안 뚫기**
   - **JA3/JA3S 핑거프린트 이해**
     ```
     JA3 = MD5(
       TLS Version,
       Cipher Suites,
       Extensions,
       Elliptic Curves,
       EC Point Formats
     )

     예시: 769,47-53-5-10-49171-49172-...,0-23-65281-...,29-23-24,0
           → MD5 → "a0e9f5d64349fb13191bc781f81148a1"
     ```
   - **왜 Chromium JA3는 탐지되는가**
     - 모든 Chromium 기반 브라우저가 유사한 JA3
     - Headless 모드의 특이한 TLS 패턴
     - 자동화 도구 특유의 Cipher Suite 순서
   - **Camoufox의 TLS 우회 방법**
     - Firefox 고유의 TLS 스택 사용
     - Cipher Suite 랜덤화
     - Extension 순서 변조
     - GREASE (Generate Random Extensions And Sustain Extensibility)
   - **HTTP/2 핑거프린팅 대응**
     - SETTINGS 프레임 값 조정
     - WINDOW_UPDATE 패턴
     - Header 순서 (pseudo-headers)

4. **Camoufox vs Playwright 아키텍처 차이**
   - **Playwright: 세션 풀 + 락 방식**
     - Browser 1개에 다수 BrowserContext
     - Context 재사용으로 리소스 절약
     - 락으로 동시성 제어
   - **Camoufox: MAX 카운터 + 즉시 생성/종료 방식**
     - 1 Browser = 1 Context (BrowserContext 개념 없음)
     - 세션 풀 없이 MAX 동시 실행 수만 제한
     - 요청마다 브라우저 생성 → 작업 → 즉시 종료
     - 풀 관리 오버헤드 제거, 단순한 구조
   - **왜 Camoufox는 풀링하지 않는가**
     - Anti-detection을 위해 매번 새로운 핑거프린트 필요
     - 세션 재사용 시 A사가 패턴 감지
     - 단순한 생명주기가 메모리 관리에 유리

5. **Camoufox 도입과 설정**
   - camoufox-js 설치 및 설정
   - headless 옵션 (virtual vs true)
   - Docker 환경 설정 (dbus, Xvfb)

6. **Camoufox 메모리 누수 해결**
   - **브라우저 프로세스 좀비화**
     - 브라우저는 종료됐는데 프로세스가 남는 문제
     - PID 추적 및 강제 종료 로직
     ```typescript
     // 프로세스 추적 구현
     interface ProcessTracker {
       pid: number;
       startTime: number;
       sessionId: string;
     }

     // 좀비 프로세스 감지
     const isZombie = (tracker: ProcessTracker) => {
       try {
         process.kill(tracker.pid, 0); // 존재 확인
         return Date.now() - tracker.startTime > MAX_LIFETIME;
       } catch {
         return false; // 이미 종료됨
       }
     };
     ```
   - **카운터 불일치 문제**
     - `counter(5) > sessions(3)` 로그의 의미
     - closeSession 중복 호출 방지
     - 메트릭 멱등성 보장
   - **safeCloseSession 구현**
     - disconnect 핸들러에서 정상 종료 구분
     - launchServer 방식으로 PID 획득
     - 타임아웃 기반 강제 정리

7. **성공률 극대화**
   - Proxy 연동
   - GeoIP 설정
   - 플랫폼별 브라우저 분리 운영 (C사: Camoufox, N사: Chromium)

### 관련 커밋
- `5d47674` docs: C사 A사 우회를 위한 Camoufox 전환 계획 문서 추가
- `adfebc7` feat: Camoufox 브라우저 지원 및 모니터링 시스템 추가
- `79048d4` feat: Camoufox 메모리 누수 방지를 위한 safeCloseSession 및 추적기 구현
- `d5946cf` fix: Camoufox 메모리 누수 방지를 위한 P0 수정
- `e28ee7c` feat: Camoufox launchServer 방식으로 전환하여 PID 획득 가능하도록 개선
- `5277bae` fix: closeSession 중복 호출 방지 및 메트릭 멱등성 강화

### 아키텍처 다이어그램
```
┌─────────────────────────────────────────────────────────────────┐
│                    TLS Handshake 비교                           │
├────────────────────────────┬────────────────────────────────────┤
│      Chromium (탐지됨)     │      Camoufox (우회)               │
├────────────────────────────┼────────────────────────────────────┤
│ ClientHello:               │ ClientHello:                       │
│ - TLS 1.3                  │ - TLS 1.3                          │
│ - 동일한 Cipher 순서       │ - 랜덤화된 Cipher 순서             │
│ - CDP 특유의 Extension     │ - 실제 Firefox Extension           │
│ - 예측 가능한 JA3          │ - 매번 다른 JA3                    │
├────────────────────────────┼────────────────────────────────────┤
│ JA3: a0e9f5d64349fb...     │ JA3: (매번 다름)                   │
│ → A사 블랙리스트           │ → 일반 사용자로 인식               │
└────────────────────────────┴────────────────────────────────────┘
```

---

## Part 5: Page Call 최적화와 사이트 분석 - 뚫기 위한 디테일

### 주제
- page.goto() 옵션 심층 튜닝
- C사 사이트 분석과 업데이트 대응
- 네트워크 타이밍과 프록시

### 소제목
1. **page.goto() 옵션 심층 튜닝**
   - **waitUntil 옵션 완전 분석**
     ```typescript
     // 각 옵션의 의미
     waitUntil: 'load'           // window.onload 이벤트
     waitUntil: 'domcontentloaded' // DOMContentLoaded 이벤트
     waitUntil: 'networkidle'    // 500ms 동안 네트워크 요청 2개 이하
     waitUntil: 'commit'         // 응답 수신 시작 (가장 빠름)
     ```
   - **왜 networkidle이 중요한가**
     - loader.min.js 완전 실행 보장
     - bm_sv 쿠키 생성 시간 확보
     - 센서 데이터 전송 완료 대기
   - **상황별 최적 옵션**
     ```typescript
     // 초기 로그인 페이지: networkidle 필수
     await page.goto(loginUrl, {
       waitUntil: 'networkidle',
       timeout: 30000
     });

     // API 호출 후 리다이렉트: domcontentloaded로 속도 확보
     await page.goto(dashboardUrl, {
       waitUntil: 'domcontentloaded',
       timeout: 15000
     });

     // bm_sv 필요한 페이지: 커스텀 대기 로직
     await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
     await waitForBmSvCookie(page, { timeout: 10000 });
     ```
   - **timeout 설정 전략**
     - 네트워크 상태에 따른 동적 조절
     - 프록시 latency 고려
     - 재시도 시 timeout 점진적 증가

2. **bm_sv 쿠키 대기 전략 상세**
   ```typescript
   async function waitForBmSvCookie(page: Page, options: { timeout: number }) {
     const startTime = Date.now();

     while (Date.now() - startTime < options.timeout) {
       const cookies = await page.context().cookies();
       const bmSv = cookies.find(c => c.name === 'bm_sv');

       if (bmSv && isValidBmSv(bmSv.value)) {
         return bmSv;
       }

       await page.waitForTimeout(100); // 100ms polling
     }

     throw new Error('bm_sv cookie not received');
   }

   function isValidBmSv(value: string): boolean {
     // bm_sv 값 유효성 검증 로직
     // - 길이 체크
     // - 포맷 체크
     // - 만료 시간 체크
     return value.length > 50 && !value.includes('invalid');
   }
   ```

3. **C사 사이트 심층 분석**
   - **로그인 플로우 분석**
     - 로그인 페이지 → 인증 → 리다이렉트 흐름
     - 각 단계에서 생성되는 쿠키 추적
   - **보안 업데이트 대응 히스토리**
     - loader.min.js 버전 변경 시 대응
     - 새로운 검증 로직 추가 시 분석
     - bm_sv 쿠키 생성 조건 변화 추적
   - **네트워크 콜 패턴 분석**
     - 필수 API 호출 순서
     - Preflight 요청 처리
     - CORS 정책 대응

4. **NS_ERROR_NET_INTERRUPT 대응**
   - **발생 원인 분석**
     - Firefox 네트워크 스택 특성
     - Proxy 연결 불안정
     - 서버 측 연결 강제 종료
   - **대응 전략**
     ```typescript
     try {
       await page.goto(url, { waitUntil: 'networkidle' });
     } catch (error) {
       if (error.message.includes('NS_ERROR_NET_INTERRUPT')) {
         // 네트워크 재시도 로직
         await page.waitForTimeout(1000);
         await page.goto(url, { waitUntil: 'domcontentloaded' });
       }
     }
     ```

5. **프록시 관리 시스템**
   - Residential Proxy 선택
   - 프록시 풀 로테이션
   - ProxyMonitoringInterceptor 구현
   - 응답 시간 기반 프록시 품질 관리

6. **에러 분류와 재시도 전략**
   - 임시 오류 vs 영구 오류 분류
     ```typescript
     const TEMPORARY_ERRORS = [
       'NS_ERROR_NET_INTERRUPT',
       'ECONNRESET',
       'ETIMEDOUT',
       '502', '503', '504'  // Gateway errors
     ];

     const PERMANENT_ERRORS = [
       '401', '403',  // Auth errors
       'invalid_credentials',
       'account_locked'
     ];
     ```
   - 오류별 재시도 정책
   - Orphan 세션 정리

7. **모니터링과 Phase별 진단**
   - Phase 1/2/3 진단 로깅
   - 성공률 메트릭 수집
   - 실시간 대시보드 구축

### 관련 커밋
- `781e6d6` fix: forceNavigateToLogin에서 networkidle → domcontentloaded 변경
- `474f21d` feat(C사): Phase 2 & 3 로그인 안정성 개선 - NS_ERROR_NET_INTERRUPT 대응
- `7bd843e` feat: Add Phase 1 diagnostics for C사 A사 blocking
- `11ef029` feat: Add ProxyMonitoringInterceptor for C사/N사 tracking
- `299d742` feat: C사 에러 분류 및 임시 오류 처리 시스템 구현
- `84c1305` fix: A사 탐지 회피 로직 개선

---

## Epilogue: 미래 - AI 기반 자동 분석 시스템

### 주제
- AI를 활용한 차단 원인 자동 분석
- 개발자 의사결정 지원 시스템
- 지속 가능한 스크래핑 아키텍처

### 소제목
1. **현재 문제점**
   - 수동 로그 분석의 한계
   - 차단 패턴 변화 시 대응 지연
   - 반복되는 디버깅 시간 소모

2. **AI 분석 시스템 아키텍처**
   - **데이터 수집 레이어**
     - HAR 파일 자동 저장
       - 오류 발생 시 즉시 저장
       - 특정 시간대 주기적 저장
       - 성공/실패 케이스 샘플링
     - 구조화된 로그 저장
       - Phase별 진단 로그
       - 네트워크 타이밍 로그
       - 쿠키 상태 스냅샷
   - **AI 분석 트리거**
     - 임계치 기반: 실패율 X% 초과 시
     - 시간 기반: 하루 1회 정기 분석
     - 수동 트리거: 개발자 요청 시
   - **AI API 호출**
     - Claude/GPT API 활용
     - 프롬프트 엔지니어링
       - HAR 파일 분석 프롬프트
       - 로그 패턴 분석 프롬프트
       - 차단 원인 추론 프롬프트

3. **자동 리포트 생성**
   - **리포트 구성 요소**
     - 문제 요약 (Executive Summary)
     - 원인 분석 (Root Cause Analysis)
     - 증거 데이터 (HAR/로그 발췌)
     - 개선 방안 제안 (Recommendations)
     - 예상 코드 변경 사항
   - **리포트 전달**
     - Slack/Teams 알림
     - 이메일 발송
     - 대시보드 게시

4. **개발자 워크플로우**
   - AI 리포트 검토
   - 제안 사항 평가
     - 즉시 적용
     - 수정 후 적용
     - 거부 (사유 기록)
   - 피드백 루프로 AI 정확도 향상

### 시스템 아키텍처 다이어그램
```
┌─────────────────────────────────────────────────────────────┐
│                    Scraping System                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Browser   │  │   Proxy     │  │   Session Manager   │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
└─────────┼────────────────┼────────────────────┼─────────────┘
          │                │                    │
          ▼                ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    Data Collection Layer                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  HAR Files   │  │  Logs (JSON) │  │  Cookie Snapshots│   │
│  │  - on error  │  │  - phase log │  │  - bm_sv status  │   │
│  │  - periodic  │  │  - timing    │  │  - session state │   │
│  │  - sampling  │  │  - errors    │  │                  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
└─────────┼────────────────┼────────────────────┼─────────────┘
          │                │                    │
          └────────────────┼────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Trigger Engine                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  - 실패율 > 10% (임계치 초과)                         │   │
│  │  - 매일 03:00 KST (정기 분석)                         │   │
│  │  - 개발자 수동 트리거                                 │   │
│  └──────────────────────────┬───────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    AI Analysis Engine                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Claude API / GPT API                                │   │
│  │                                                      │   │
│  │  Prompt Engineering:                                 │   │
│  │  - "이 HAR 파일에서 A사 차단 징후를 분석해줘"        │   │
│  │  - "bm_sv 쿠키가 없는 케이스의 공통점을 찾아줘"      │   │
│  │  - "실패 패턴과 성공 패턴의 차이점을 분석해줘"       │   │
│  └──────────────────────────┬───────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Report Generator                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ## 분석 리포트 (2024-01-08)                         │   │
│  │                                                      │   │
│  │  ### 요약                                            │   │
│  │  - 실패율: 15% → 원인: loader.min.js 버전 변경       │   │
│  │                                                      │   │
│  │  ### 원인 분석                                       │   │
│  │  - bm_sv 쿠키 생성 타이밍 변경 감지                  │   │
│  │  - 새로운 센서 데이터 필드 추가됨                    │   │
│  │                                                      │   │
│  │  ### 제안 사항                                       │   │
│  │  1. waitUntil을 networkidle로 변경 (Priority: High) │   │
│  │  2. 쿠키 대기 timeout 5s → 10s 증가 (Priority: Med) │   │
│  │                                                      │   │
│  │  ### 예상 코드 변경                                  │   │
│  │  ```typescript                                       │   │
│  │  // Before                                           │   │
│  │  await page.goto(url, { waitUntil: 'domcontent...'}) │   │
│  │  // After                                            │   │
│  │  await page.goto(url, { waitUntil: 'networkidle' }) │   │
│  │  ```                                                 │   │
│  └──────────────────────────┬───────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Developer Decision                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐     │
│  │   적용     │  │  수정 적용  │  │  거부 (사유 기록)  │     │
│  └─────┬──────┘  └─────┬──────┘  └─────────┬──────────┘     │
│        │               │                   │                │
│        ▼               ▼                   ▼                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Feedback Loop → AI 학습                 │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 기대 효과
- 차단 감지 → 분석 → 대응 시간 단축 (수시간 → 수분)
- 개발자 디버깅 시간 80% 절감
- 패턴 학습을 통한 선제적 대응 가능
- 운영 노하우의 문서화 및 자동화

---

## 시리즈 공통 요소

### 각 편에 포함할 내용
- **문제 상황**: 실제 발생한 에러 로그/메트릭
- **분석 과정**: 원인 파악을 위한 조사
- **해결 과정**: 시도한 방법들과 결과
- **코드 예시**: 핵심 구현 코드
- **다이어그램**: Mermaid로 아키텍처/흐름도
- **교훈**: 배운 점과 개선 방향

### 전체 기술 스택
```
- Runtime: Node.js, NestJS
- Browser Automation: Playwright → rebrowser-playwright → Camoufox
- Anti-detection: playwright-stealth, rebrowser-patches
- Proxy: Residential Proxy (LumiProxy)
- Caching: Redis
- Monitoring: Custom metrics, Grafana
- Deployment: Docker, Kubernetes
- Future: Claude API / GPT API for analysis
```

### 핵심 아키텍처 비교 요약

| 항목 | Playwright | Camoufox |
|------|------------|----------|
| 브라우저 엔진 | Chromium | Firefox |
| 통신 프로토콜 | CDP (Chrome DevTools Protocol) | Marionette + WebDriver BiDi |
| Context 모델 | 1 Browser : N Context | 1 Browser : 1 Context (없음) |
| 세션 관리 | 세션 풀 + Redis Lock | MAX 카운터만 (풀 없음) |
| 생명주기 | 생성 → 풀 저장 → 재사용 → 반환 | 생성 → 사용 → 즉시 종료 |
| TLS Fingerprint | JA3 고정 (탐지 취약) | JA3 랜덤화 (우회) |
| 메모리 특성 | Context 누수 주의 | 프로세스 좀비화 주의 |
| 장점 | 리소스 효율적, 빠른 세션 생성 | Anti-detection 강력, 구조 단순 |

### 성공률 변화 그래프 (예상)
```
Phase 1 (API Only)        : 95% → 60% (A사 보안 솔루션 등장)
Phase 2 (Playwright)      : 60% → 70%
Phase 3 (Stealth)         : 70% → 85%
Phase 4 (Camoufox)        : 85% → 95%
Phase 5 (Timing + Proxy)  : 95% → 99%
```

---

## 작성 일정 (참고용)

| Part | 제목 | 핵심 키워드 |
|------|------|-------------|
| 1 | API에서 브라우저 자동화로 | CDP, WebSocket, Session Pool, Lock, Object Pool |
| 2 | 글로벌 Anti-Bot 솔루션과의 첫 만남 | bm_sv, bm_sz, _abck, WAF, Cookie, A사 Report |
| 3 | Stealth 플러그인 | Fingerprinting, TLS, Heap/RSS, GC, 좀비 프로세스 |
| 4 | Camoufox 전환기 | JA3, TLS Stack, Firefox, PID Tracking |
| 5 | Page Call 최적화 | waitUntil, networkidle, bm_sv polling, NS_ERROR |
| Epilogue | AI 기반 자동 분석 | HAR, AI API, Auto Report, Developer Workflow |

---

## 참고 자료 (수집 필요)

### A사(글로벌 Anti-Bot 솔루션) 관련
- [ ] A사 Bot Manager 공식 문서
- [ ] A사 "State of the Internet" 보안 리포트
- [ ] A사 쿠키 스펙 (_abck, bm_sv, bm_sz, ak_bmsc)

### 학술 논문
- [ ] "FP-STALKER: Tracking Browser Fingerprint Evolutions" (S&P 2018)
- [ ] "How Unique Is Your Web Browser?" (EFF)
- [ ] JA3/JA3S TLS Fingerprinting 논문

### 기술 문서
- [ ] Chrome DevTools Protocol 스펙
- [ ] Firefox Marionette Protocol 스펙
- [ ] Node.js V8 Memory Model
- [ ] Camoufox 공식 문서

### 내부 자료
- [ ] 성공률 메트릭 데이터
- [ ] 관련 커밋 diff 및 PR 설명
- [ ] HAR 파일 분석 사례
- [ ] 장애 대응 히스토리
