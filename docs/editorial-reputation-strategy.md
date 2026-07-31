# 블로그 편집·평판 전략

이 문서는 Forward Engineering을 단순한 기술 지식 모음이 아니라, 김면수가 어떤 문제를 어떻게 해결하는 엔지니어인지 증명하는 공개 자산으로 운영하기 위한 기준이다.

문서의 목표는 글 수를 늘리는 것이 아니다.

> 실제 운영 문제를 재현 가능한 설계와 공개된 증거로 바꾸는 백엔드 엔지니어로 기억되게 한다.

## 1. 현재 블로그가 주는 인상

### 강점

- 구현 결과뿐 아니라 처음의 가정, 실패 trace와 수정된 계약을 함께 공개한다.
- PR, issue, 테스트, mutation과 실제 코드 경계를 연결한다.
- 적용 범위와 아직 확인하지 못한 한계를 분리한다.
- 초보 독자가 따라올 수 있도록 핵심 개념을 본문과 토글에서 설명한다.
- concurrency, persistence, SaaS isolation처럼 시니어 면접에서 후속 질문이 생기는 주제를 다룬다.

### 현재 평판

현재 글만으로도 다음 인상은 충분히 전달된다.

> 구현을 자랑하기보다 계약을 정의하고, 테스트를 의심하고, 실패 조건과 남은 한계를 공개하는 백엔드 엔지니어

다음 단계로 올라가기 위해서는 프로덕션 결과가 필요하다.

> 실제 운영 문제를 재현 가능한 시스템 설계와 공개된 증거로 바꾸는 엔지니어

## 2. 부족한 증거

현재 증거는 PR, 코드, 단위·통합 테스트와 mutation에 강하다. 반면 실제 운영에서 무엇이 달라졌는지 보여주는 증거가 상대적으로 적다.

대표 글에는 가능한 범위에서 다음을 후속으로 추가한다.

- 실제 요청량과 tenant 수
- 도입 전후 성공률·오류율
- P50·P95·P99 latency
- heap 사용량과 GC 변화
- resource·cell 점유 분포
- global budget 도달률과 거부 건수
- rate limit 거부율과 limiter error
- checkpoint freshness와 restore failure
- false grant·false denial
- 장애 건수와 복구 시간
- 예상과 달랐던 운영 결과

수치가 없으면 추정치를 넣지 않는다. 아직 측정하지 않았다는 사실과 수집 계획을 명시한다.

## 3. 대표작과 역할

모든 글을 같은 비중으로 노출하지 않는다. 글마다 역할을 정한다.

### 평판을 만드는 대표작

1. **Lincheck 동시성 계약**
   - 32-thread 테스트가 통과했지만 명세가 틀렸다는 반전이 있다.
   - fencing token, linearizability와 mutation 검증이 연결된다.
   - 국내외 JVM concurrency 독자에게 공유할 가능성이 가장 높다.

2. **JDK-only core와 SaaS thin host**
   - open-core, adapter, composition root와 release 경계를 설명한다.
   - 시니어 아키텍처 면접에서 후속 질문을 만들기 좋다.

3. **멀티테넌트 격리와 noisy neighbor**
   - 데이터 격리와 자원 격리가 다르다는 판단을 보여준다.
   - global budget이 fairness를 보장하지 않는 한계까지 공개한다.

### 앞으로 가장 중요한 글

1. **운영에서 reputation-pool이 필요해진 원인**
   - 독자가 프로젝트 필요성을 이해하는 진입점이다.
   - 실제 장애와 도입 전후 수치가 있다면 가장 강한 대표작이 될 수 있다.

2. **Shadow mode 측정 결과**
   - 기존 선택과 새 엔진의 판단을 실제 데이터로 비교한다.
   - 설계 기록을 운영 검증으로 완결한다.

3. **수평 확장에서 깨지는 모델**
   - 아직 구현하지 않은 설계를 완료된 것처럼 쓰지 않는다.
   - 현재 원자성 범위와 선택지별 비용을 명확하게 비교한다.

### 검색 유입을 만드는 글

- MySQL 1,000만 row cursor pagination
- JPA N+1과 JOIN FETCH 함정
- HikariCP pool exhaustion과 thread dump
- transaction 안의 외부 API 호출
- InnoDB isolation level 실측

검색 유입 글은 새로운 독자를 데려오는 입구다. reputation-pool 시리즈와 About 페이지로 자연스럽게 연결한다.

## 4. 글의 세 가지 읽기 깊이

긴 deep-dive 글은 서로 다른 독자를 동시에 만족시켜야 한다.

### 30초 요약

글 상단에서 다음 네 가지를 바로 답한다.

1. 어떤 문제가 있었는가?
2. 무엇을 선택했는가?
3. 어떤 근거로 검증했는가?
4. 무엇은 아직 증명하지 못했는가?

### 5분 설계 요약

- 핵심 아키텍처 다이어그램
- 변경 전과 변경 후 비교
- Evidence card
- 핵심 의사결정과 trade-off
- 운영·보안·확장 한계

### 전체 deep dive

- 코드 흐름
- 실패 trace
- 테스트와 mutation
- 대안 검토
- 자가진단
- 의사결정 매트릭스
- FAQ와 원전 자료

글이 길어질수록 같은 설명을 반복하지 않는다. 본문에 필수인 개념은 펼쳐 두고, 구현 세부와 곁가지 원리는 토글로 격리한다.

## 5. 발행 전 평판 체크리스트

### 기술적 신뢰

- 실제 코드와 현재 release version을 확인했는가?
- 주장과 PR·issue·test를 직접 연결했는가?
- 성공한 테스트가 무엇을 증명하지 못하는지도 썼는가?
- 성능 수치에 환경과 baseline이 있는가?
- 실패·rollback·restart·delete 경로를 확인했는가?
- 단일 JVM의 보장을 분산 시스템 전체 보장으로 확대하지 않았는가?

### 저자 정체성

- 이 글을 읽고 “어떤 문제를 잘 푸는 개발자”인지 한 문장으로 설명할 수 있는가?
- 기술 사용법보다 선택 이유와 버린 대안이 드러나는가?
- 일반 문서 요약이 아니라 직접 경험·실험·분석이 있는가?
- 다른 글과 겹치는 설명은 링크로 연결했는가?

### 읽기 경험

- 제목이 문제와 결과를 정확하게 요약하는가?
- 과장하거나 결과보다 강하게 주장하지 않는가?
- 첫 30초 안에 글의 가치가 드러나는가?
- 처음 온 독자도 핵심 명사를 이해할 수 있는가?
- 5분만 읽는 독자도 설계 판단과 한계를 파악할 수 있는가?
- Markdown 강조 문법이 최종 HTML에 그대로 노출되지 않는가?

### 재현과 외부 검증

- 재현 가능한 Git tag 또는 commit이 있는가?
- 실행 방법과 예상 결과가 있는가?
- 테스트 결과 원본이나 고정된 evidence가 있는가?
- 정정 이력과 마지막 검증 날짜가 있는가?
- 외부 독자가 질문·반례·재현 결과를 남길 경로가 있는가?

## 6. 이력서와 면접에서의 사용법

이력서에는 “기술 블로그 운영”이라고만 쓰지 않는다. 대표 글이 증명하는 엔지니어링 결과를 적는다.

### Lincheck

> 32-thread stress test가 놓친 동시성 명세 오류를 Lincheck로 식별하고, fencing token·resource selection·block 경쟁의 공개 계약을 재정의했습니다. 구현 변이로 double grant 검출력을 검증하고 전 과정을 기술 글과 공개 PR로 남겼습니다.

### Open-core

> JDK-only core와 Spring Boot SaaS의 변경 경계를 분리하고, 복제되던 gRPC 계약과 adapter를 공개 artifact로 추출했습니다. reference server와 cloud가 하나의 wire contract를 소비하도록 만들고 release·호환성 비용까지 기록했습니다.

### 멀티테넌트

> 멀티테넌트 SaaS에서 pool·PostgreSQL row·event stream을 격리하고, 공유 JVM의 OOM과 요청 폭주를 global budget·tenant별 token bucket으로 제한했습니다. 복원·삭제 회계와 단일 instance 한계를 공개 설계 기록으로 정리했습니다.

이력서에는 대표 글을 2~3개만 연결한다. 면접에서 설명할 수 없는 글은 대표작으로 올리지 않는다.

## 7. 배포와 외부 인용 전략

좋은 글을 발행한 것만으로 유명해지지는 않는다. 대표 글이 외부에서 재현·토론·인용되는 경로를 만든다.

### 원칙

- 모든 글을 홍보하지 않고 대표작만 반복적으로 갱신하고 배포한다.
- 커뮤니티마다 전문을 복제하기보다 핵심 문제·다이어그램·한계를 요약하고 canonical 글로 연결한다.
- 관련 없는 커뮤니티에 일괄 배포하지 않는다.
- maintainer에게 단순 홍보를 보내지 않는다. 재현 사례, 발견한 계약 문제 또는 구체적인 질문이 있을 때만 공유한다.
- 영어판은 대표작만 고품질로 유지한다.

### LinkedIn

개인 프로필에서 하나의 명확한 주제로 newsletter를 운영한다.

추천 주제:

> Evidence-Driven Backend Engineering — 실패 trace, 운영 지표와 반례로 다시 쓰는 백엔드 설계

각 발행 글은 다음 형식으로 요약한다.

1. 기존에 믿었던 가정
2. 그 가정을 깨뜨린 증거
3. 수정한 계약
4. 아직 남은 한계
5. 원문 링크

### Open-source 연결

- Lincheck 글은 최소 재현과 고정된 version을 함께 제공한다.
- reputation-pool issue와 PR에서 관련 설계 글을 참고자료로 연결한다.
- 후속 수정이 생기면 글의 정정 이력과 PR 양쪽을 갱신한다.
- 다른 개발자의 재현·반례가 나오면 본문에 외부 검증으로 기록한다.

## 8. 성과 측정

page view 하나로 평판을 판단하지 않는다.

### 발견성

- Google Search Console impression·click·query
- ChatGPT 등 AI referral
- 영문·한글 대표 글의 검색 유입
- branded query 증가

### 권위

- 외부 backlink와 referring domain
- GitHub issue·discussion·PR에서의 인용
- maintainer 또는 다른 개발자의 공유
- 재현 결과와 정정 제보

### 채용 효과

- 이력서에서 대표 글 클릭
- recruiter·면접관이 먼저 언급한 글
- 글에서 파생된 면접 질문
- 기술 발표·인터뷰·협업 제안

### 독자 관계

- newsletter subscriber
- 재방문 독자
- 대표 글의 완독과 후속 글 이동
- 댓글·질문·GitHub discussion

월별 측정 방법은 [`docs/search-ai-measurement.md`](search-ai-measurement.md)를 따른다.

## 9. 실행 우선순위

### 지금

1. reputation-pool 대표 3편을 완성하고 상호 연결한다.
2. About·홈에서 대표작 3편을 우선 노출한다.
3. 각 대표작의 30초·5분·deep-dive 구조를 점검한다.

### 실제 운영 데이터 확보 후

1. 탄생 배경에 도입 전 baseline을 추가한다.
2. 멀티테넌트 글에 memory·rate limit 운영 결과를 추가한다.
3. shadow mode에서 false grant·false denial을 측정한다.
4. 예상과 다른 결과를 별도 회고로 남긴다.

### 외부 배포

1. Lincheck 영문판과 재현 자산을 먼저 배포한다.
2. LinkedIn newsletter를 개인 저자 identity로 시작한다.
3. 검색 유입 글에서 reputation-pool 대표 시리즈로 내부 연결한다.
4. 월별로 검색·backlink·채용 효과를 검토한다.

## 10. 하지 않을 것

- 글 수를 채우기 위한 유사 주제 대량 발행
- 측정하지 않은 성능·운영 효과 주장
- 모든 글의 기계적인 영문화
- 검색 키워드를 위한 어색한 제목과 반복
- 완료되지 않은 수평 확장·RBAC를 구현 완료로 표현
- page view만으로 글의 품질 판단
- 면접에서 방어할 수 없는 과장된 이력서 문구
