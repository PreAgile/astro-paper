---
author: 김면수
pubDatetime: 2026-08-01T01:00:00.000Z
title: "브라우저 worker는 CPU worker도 I/O worker도 아니었다 — 작업 시간의 꼬리가 만든 용량 경계"
featured: true
draft: false
depth: deep-dive
translationKey: browser-worker-capacity-boundary
series: heterogeneous-workload-pipeline
seriesOrder: 3
tags:
  - Backend
  - BrowserAutomation
  - CapacityPlanning
  - Queue
  - Observability
  - Operations
description: |
  browser worker의 병목은 CPU나 네트워크 하나로 설명되지 않았습니다. 계정별 session lock의 force-release가 60일 동안 1,129회 기록된 운영 신호를 출발점으로, browser process·page·proxy·외부 응답의 긴 꼬리가 queue 적체로 이어지는 경로와 용량 판단 기준을 정리합니다.
---

## Table of contents

> **TL;DR**
>
> browser worker를 일반적인 CPU worker처럼 개수만 늘리면 해결될 것이라 생각하기 쉽습니다. 하지만 browser 작업은 CPU, 메모리, page lifecycle, proxy, 로그인 상태, 외부 응답 시간이 함께 결정합니다. 어느 하나가 오래 걸리면 worker slot은 계속 점유되고, 뒤의 작업은 queue에서 기다립니다.
>
> 운영 로그에서 계정 단위 session lock의 force-release는 최근 60일 동안 1,129회 발생했습니다. 이것은 곧바로 browser crash 횟수나 장애 건수라는 뜻이 아닙니다. 다만 정상 completion보다 긴 작업이 반복됐고, lock timeout이 정상 흐름이 아니라 backstop으로 동작했다는 강한 신호입니다.
>
> 이 글의 결론은 worker 수를 늘리는 것이 아닙니다. **어떤 작업이 slot을 오래 잡는지, 그 slot을 기다리는 작업이 queue에 어떤 부채를 만드는지, 그리고 언제 새 작업을 받지 않을지**를 함께 정해야 합니다.

### 이 글에서 확인한 범위

| 항목 | 근거 |
| --- | --- |
| 관측 신호 | 최근 60일 session lock force-release 1,129회 |
| 작업 특성 | browser process·page·로그인·proxy·외부 응답이 한 slot의 종료 시점을 결정 |
| 병목 해석 | force-release는 긴 작업의 신호이지 CPU 포화의 단독 증거는 아님 |
| 기존 대응 | 계정 단위 직렬화, fan-out cap, timeout backstop, browser/process 정리 |
| queue와의 연결 | slot 점유가 길어지면 consumer drain rate가 떨어져 backlog가 증가 |
| 확인하지 않은 범위 | host별 CPU·RSS만으로 계산한 절대 최대 동시 browser 수 |

---

## 0. 시작 — timeout이 worker를 빠르게 만들지는 않았다

세션 ownership을 정한 뒤에도 작업이 빨라지는 것은 아닙니다. 같은 계정의 작업을 한 번에 하나씩 실행하면 page 충돌은 줄지만, 앞 작업이 오래 걸리는 동안 뒤 작업은 기다려야 합니다.

운영에서는 이 대기 시간이 lock force-release로 드러났습니다. 60일 동안 1,129회였습니다. 특히 일부 날짜에는 하루 100회 이상 발생했습니다.

이 숫자를 “browser가 1,129번 죽었다”라고 읽으면 안 됩니다. force-release는 긴 작업을 영구 대기열로 남기지 않기 위한 backstop이 발화한 횟수입니다. 작업은 강제 해제 뒤에도 실제 browser에서 계속 실행될 수 있습니다.

따라서 이 지표가 말하는 사실은 하나입니다.

> timeout보다 오래 살아 있는 작업이 충분히 자주 있었고, slot을 점유하는 시간을 평균만으로 판단할 수 없었다.

## 1. browser worker의 용량은 가장 느린 자원이 결정한다

일반 HTTP worker는 요청 하나가 끝나면 socket과 CPU 시간을 비교적 예측 가능하게 돌려줍니다. browser 작업은 다릅니다.

```text
작업 하나
 → account session lock 대기
 → browser/page 확보
 → proxy 할당
 → 로그인 또는 세션 검증
 → navigation / 외부 API 응답 대기
 → 결과 파싱
 → page 정리와 slot 반환
```

어느 단계 하나라도 느려지면 worker의 유효 처리율은 떨어집니다. worker 수가 `W`, 실제 작업 시간이 `T`일 때 이상적인 처리율은 대략 `W / T`지만, browser 작업의 `T`는 평균이 아니라 긴 꼬리에 지배됩니다.

| 자원 | 포화 때 증상 | queue에 미치는 영향 |
| --- | --- | --- |
| CPU | rendering·암호화·JS 실행 지연 | 작업 시간이 늘어 consumer drain이 감소 |
| 메모리 | browser/page 누적, GC·OS 압박 | process 재시작 또는 새 launch 실패 |
| page/context | navigation 충돌·정리 지연 | 계정 lock 보유 시간이 증가 |
| proxy·외부 응답 | timeout·재시도·차단 분류 | 같은 slot이 오래 점유됨 |
| 계정 lock | 같은 계정 요청의 대기 | 전체 worker는 남아도 특정 계정은 진행 못 함 |

## 2. 그래서 fan-out을 늘리는 대신 제한했다

한 계정에서 여러 하위 대상을 조회할 때 `Promise.all`로 전부 실행하면 짧은 순간에는 빨라 보입니다. 하지만 같은 session과 page를 공유하는 작업이라면 동시에 열린 navigation이 서로의 상태를 바꾸고, browser slot·proxy 요청·외부 호출을 한꺼번에 잡아먹습니다.

실제 변경에서는 로그인 single-flight만으로는 부족하다는 판단 뒤, 계정별 작업 경계를 직렬화하고 하위 조회의 fan-out을 제한했습니다. 이는 처리량을 포기한 것이 아니라, 공유 상태를 가진 작업을 무제한 병렬화해 긴 꼬리를 키우는 것을 막기 위한 선택입니다.

```text
무제한 fan-out
 → 같은 browser/page의 동시 navigation
 → 일부 작업 지연과 timeout
 → lock 보유 시간 증가
 → 같은 계정의 후속 요청 대기
 → consumer 처리율 하락
 → queue backlog 증가
```

## 3. queue depth만 보면 잘못된 처방을 하게 된다

queue가 쌓였을 때 worker를 늘리는 것은 자연스러운 반응입니다. 그러나 계정 lock, proxy, browser launch가 이미 병목이면 새 worker는 처리율을 올리기보다 같은 병목에 더 많은 경쟁자를 보냅니다.

그래서 용량 판단은 최소한 다음을 같이 봐야 합니다.

| 지표 | 질문 | 경보가 의미하는 것 |
| --- | --- | --- |
| queue depth와 age | 얼마나 많이, 얼마나 오래 기다리는가 | backlog가 제품 의미를 잃는지 |
| 작업 시간 분포 | P50이 아니라 P95/P99은 어떤가 | 긴 꼬리가 slot을 잠식하는지 |
| lock held time / force-release | 계정별 직렬화가 정상 범위인가 | timeout backstop이 정상 경로가 됐는지 |
| browser launch·재시작 | 새 slot이 안정적으로 생기는가 | process/page lifecycle 문제인지 |
| proxy 결과 | 외부 의존성이 worker 시간을 늘리는가 | scale-out이 아닌 proxy 정책 문제인지 |

이 지표를 분리하지 않으면 “queue가 쌓였다 → worker를 더 띄운다”는 처방만 남습니다. 실제로는 queue가 원인이 아니라, browser slot이 돌아오지 않는 결과일 수 있습니다.

## 4. timeout은 admission control이 아니다

force-release가 발생하면 다음 작업은 진행할 수 있습니다. 하지만 기존 작업을 취소하지 못한다면 두 작업이 겹칠 수 있습니다. 그래서 force-release를 처리량 향상 장치처럼 쓰면 안 됩니다.

올바른 순서는 다음에 가깝습니다.

1. 정상 작업의 최대 시간을 관측해 timeout을 정한다.
2. timeout 뒤에도 계속 실행되는 작업은 별도 지표·로그로 조사한다.
3. browser 종료·page 정리·외부 timeout을 먼저 고친다.
4. 그 뒤에도 유입이 drain rate를 넘으면 bounded queue에서 새 publish를 거절하거나 재예약한다.

이것이 1편의 bounded queue와 이어집니다. queue 상한은 browser worker를 빠르게 만드는 기능이 아니라, 느린 slot 때문에 생기는 미래의 작업 약속을 무한히 늘리지 않는 장치입니다.

## 5. 이 글의 한계

이 기록은 특정 host의 CPU 사용률만으로 “browser는 몇 개까지”라는 절대 숫자를 만들지 않습니다. browser 버전, 플랫폼, proxy, 로그인 조건에 따라 작업 시간 분포가 달라지기 때문입니다.

대신 다음 판단을 남깁니다.

> browser worker의 capacity는 프로세스 개수가 아니라, 가장 느린 세션 작업이 slot을 붙잡는 시간과 그 긴 꼬리를 감당할 수 있는 운영 정책으로 결정된다.

다음 글에서는 broker가 같은 메시지를 다시 전달할 수 있는 환경에서, 외부 쓰기와 결과 상태를 어떤 별도 계약으로 다룰지 정리합니다.

## References

### 구현과 운영 기록

- 계정별 session lock의 timeout backstop과 force-release 관측
- 로그인 single-flight 제거, 세션 작업 경계 직렬화, 하위 조회 fan-out cap
- queue-full 거절과 stale recovery를 다룬 1편의 운영 기록

### 참고 자료

- [Queue Length Limit](https://www.rabbitmq.com/docs/maxlength) — queue backlog 상한과 publish 거절 정책
- [Consumer Prefetch](https://www.rabbitmq.com/docs/consumer-prefetch) — consumer의 in-flight delivery 경계
