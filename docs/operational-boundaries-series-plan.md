# 운영 장애를 설계 경계로 되돌린 기록 — 집필 근거 노트

> 공개 글에는 서비스·플랫폼·호스트·계정·프록시 벤더·식별 가능한 endpoint를 쓰지 않는다.
> 이 문서는 집필 준비용 내부 메모다. 각 편은 여기에 적힌 근거를 다시 열어 확인한 뒤에만 발행한다.

## 시리즈 공통 발행 원칙

- 운영 수치는 기간, 분모, 제외 기준과 환경을 같이 쓴다.
- 재현 실험의 수치와 production 관측 수치를 섞지 않는다.
- 외부 플랫폼 차단을 회피하는 세부 절차·fingerprint·계정·프록시 정보는 공개하지 않는다.
- “정확히 한 번”, “무손실”, “고가용성”은 코드와 시험이 증명하는 범위에서만 쓴다.
- 공개 글에는 코드 저장소 링크 대신 역할·불변식·재현 방법을 설명한다. 공개 가능한 PR인지 다시 확인되기 전에는 URL을 직접 연결하지 않는다.

## 1편 — 실패의 대부분은 브라우저가 아니라 배포 경로에 있었다

### 주장 후보

대량 수집 실패를 브라우저 또는 외부 시스템 탓으로 단정하지 않고, 응답 형태와 요청 경로를 분해했다. 실패의 대부분은 동적 라우팅 설정을 in-place로 여러 번 고치는 배포 중간 상태에서 발생했고, 완성된 파일을 같은 파일시스템 안에서 한 번에 교체하는 방식으로 제거했다.

### 근거

- Issue #904 — 대량 주문/매출 수집 실패를 라우팅 오류, 외부 응답 오류, 성공으로 분류한 RCA.
- PR #905 — 동적 라우팅 설정을 temporary file에 완성한 뒤 단일 rename으로 교체하고, 수집 중 배포를 막는 best-effort guard 추가.
- PR #951 — 디스크 부족으로 설정 파일이 0 byte가 되는 별도 배포 실패 모드도 원자 복원으로 보강.
- 격리 재현: 구 방식 1,412회 중 비정상 응답 324회, 원자 교체 1,407회 중 비정상 응답 0회.

### 확인할 코드 경로

- `deploy/deploy-rolling.sh`: active target 전환, temporary file 생성, atomic replace, collection guard.
- `deploy/traefik/dynamic/scraper.yml`: file-provider가 읽는 동적 라우팅 정의.
- 배포 스크립트의 health check와 rollback 분기.

### 반드시 밝힐 한계

- 격리 재현의 HTTP 상태 코드는 운영 환경의 proxy 버전·설정에 따라 달라질 수 있다.
- access log 기반 in-flight guard는 long-running 단일 요청을 놓칠 수 있어 best-effort다.
- 원자 교체는 설정 파일 중간 상태를 막을 뿐, backend 자체의 용량 부족·외부 의존성 장애를 해결하지 않는다.

### 면접 질문

- 왜 container health check만으로 부족했나?
- 왜 lock이 아니라 rename인가?
- 배포와 수집을 완전히 분리하지 못할 때 어떤 안전장치가 필요한가?
- 404, 502, application JSON error를 어떻게 서로 다른 장애로 분류했나?

## 2편 — 동시 로그인 하나가 여러 환경을 만들던 문제

### 주장 후보

동일 계정의 병렬 요청을 모두 직렬화하지 않고, 상태를 초기화하는 로그인 구간만 single-flight로 합쳤다. owner Promise를 공유해 성공 결과뿐 아니라 구조화된 예외와 timeout 의미도 보존했고, 측정되기 전에는 Redis 분산 락을 추가하지 않았다.

### 근거

- Issue #531 — 짧은 시간 동안 동일 계정 요청이 중첩되며 세션 초기화와 환경 할당이 증폭된 RCA.
- PR #532 — in-process `Map<accountId, Promise>` 기반 `ensureSession` single-flight.
- Issue #533 — multi-instance coalescing은 실제 재현 후 결정한다는 후속 경계.
- PR #569 — single-flight를 재사용 가능한 coordinator port로 추출.
- 후속 Issue #788 / PR #790 — 작업 전체를 넓게 직렬화하지 않고 session boundary와 fan-out cap을 재조정한 변경.

### 확인할 코드 경로

- session orchestration의 `ensureSession`과 session cache read/write 경로.
- single-flight coordinator의 key, cleanup, waiter count, exception propagation spec.
- session clear와 proxy assignment 변경이 연결되는 경로.
- account/session operation 전체를 직렬화하던 기존 lock의 범위.

### 반드시 밝힐 한계

- in-process single-flight는 같은 process 안에서만 합쳐진다.
- multi-instance duplicate login은 별도 ownership 또는 distributed coordination 문제다.
- 로그인 단계를 합친다고 외부 쓰기까지 멱등이 되지는 않는다.
- 계정 보호 정책의 상세 조건과 우회 기법은 공개하지 않는다.

### 면접 질문

- 왜 Redis lock을 즉시 도입하지 않았나?
- Promise 공유가 timeout·예외 전파에 주는 장점은 무엇인가?
- 왜 댓글 등록 전체를 lock으로 감싸지 않았나?
- single-flight key에 account 외의 조건을 포함해야 하는 경우는 언제인가?

## 3편 — 프록시는 문자열이 아니라 관측 가능한 자원이었다

### 주장 후보

프록시 공급자별 문자열·환경변수·분기문을 endpoint 모델로 정규화했다. 회전과 일시 격리는 vendor-neutral engine에 두고, vendor-specific 해석만 adapter로 한정했다. 또한 endpoint 관측은 필요한 작은 pool에만 제한해 metric cardinality를 통제했다.

### 근거

- Issue #883 — 다중 벤더 pool RFC, plaintext credential 제거, endpoint normalization, 단계적 rollout 설계.
- PR #884~#895 — secret migration, registry/adapter, rotation, TTL blacklist, browser credential path 통합, 플랫폼별 opt-in rollout.
- Issue #919 및 PR #924, #926, #934, #936, #937 — outcome 분류와 전 플랫폼 배선.
- PR #957 — vendor-level 성공률과 allowlist된 small pool에만 endpoint-level metric을 허용한 cardinality guard.
- Issue #915 — 운영 지표 보강의 미완료 항목.

### 확인할 코드 경로

- `src/proxy/vendor-pool/`: vendor registry, adapter, merged pool, endpoint blacklist, resolver.
- endpoint identity와 blacklist key를 만드는 코드.
- Redis rotation counter와 TTL 복귀 경로.
- observability reporter 및 metric tag allowlist.

### 반드시 밝힐 한계

- endpoint selection이 외부 플랫폼 성공을 보장하지 않는다.
- blacklist TTL은 일시 오류 격리 정책이지 영구 평판 판정이 아니다.
- endpoint-level metric은 pool이 작고 목적이 분명할 때만 안전하다.
- 공급자·주소·자격증명·회전 규칙은 공개하지 않는다.

### 면접 질문

- 왜 strategy class를 더 추가하지 않고 endpoint adapter로 정규화했나?
- TTL blacklist와 영구 차단은 왜 분리해야 하나?
- metric cardinality를 어떻게 통제했나?
- endpoint pool이 전부 격리됐을 때의 fail-open/fail-closed 정책은 무엇인가?

## 4편 — 메시지 큐를 붙인 것이 아니라 처리 계약을 옮겼다

### 주장 후보

기존 직접 호출을 단순히 broker로 감싸지 않고, versioned envelope·environment topology·platform handler·result publisher·다중 queue 구독으로 계약을 분리했다. production에서 일부 queue만 subscribe하면 나머지 작업이 영구 적체되는 위험은 부팅 guard와 회귀 test로 먼저 막았다.

### 근거

- Issue #676 — messaging module RFC와 단계별 전환 계획.
- Issue #677~#680 — contract/schema, broker adapter, handler/result pipeline, legacy removal 단계.
- PR #681, #682, #684, #688 — issue #676의 각 phase 구현 및 production topology guard.
- 현재 "서로 다른 작업을 함께 처리하는 파이프라인" 시리즈 1편 — producer confirm, bounded queue, done queue, DLQ, stress runbook.

### 확인할 코드 경로

- `src/messaging/`: envelope schema, topology provider, consumer, result publisher, handler registry.
- environment별 topology 선택과 production boot guard.
- queue별 prefetch·ack·retry 정책.
- controller부터 platform adapter, result consumer까지 이어지는 E2E test.

### 반드시 밝힐 한계

- broker ack와 외부 side effect 성공은 같은 보장이 아니다.
- queue가 여러 개여도 consumer capacity나 DB 병목은 공유될 수 있다.
- 실서비스 전체 E2E와 failure injection 결과를 최신 환경에서 다시 확인해야 한다.

### 면접 질문

- 왜 schema부터 만들었나?
- 왜 production에서 fail-fast boot guard를 넣었나?
- consumer가 처리 중 죽었을 때 메시지와 DB 상태는 어떻게 되는가?
- queue별 prefetch와 retry 정책을 어떤 workload 기준으로 정하는가?

## 집필 순서와 발행 조건

1. 1편: 재현 수치와 PR이 가장 명확하므로 첫 대표작으로 작성한다.
2. 2편: 계정·세션 상태를 익명화한 sequence diagram과 concurrency spec을 먼저 만든다.
3. 4편: 현재 발행한 이종 workload 1편과 중복되지 않도록 scraper-side contract migration에 초점을 둔다.
4. 3편: 공급자 식별 정보와 최신 운영 지표를 제거·검증한 뒤 발행한다.

모든 편은 발행 전 다음을 충족한다.

- 익명화 검사: 서비스명, 호스트명, 플랫폼명, 계정, endpoint, 자격증명, 내부 URL이 없다.
- 근거 검사: 각 핵심 주장에 하나 이상의 code/PR/issue/재현 근거가 있다.
- 수치 검사: 기간·분모·환경·표본 수를 명시하거나 수치를 빼고 정성 결론으로 낮춘다.
- 한계 검사: 현재 해결하지 않은 failure mode를 별도 절로 적는다.
