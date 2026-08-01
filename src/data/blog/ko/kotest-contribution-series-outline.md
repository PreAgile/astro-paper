---
title: "Kotest 기여 설계 기록 — 집필 계획"
description: "공개 Kotlin 테스트 프레임워크에 기여하며 다룬 API, 동시성, Kotlin Multiplatform, property testing 경계를 정리한 미발행 집필 계획입니다."
pubDatetime: 2026-08-01T12:30:00+09:00
draft: true
tags:
  - Kotlin
  - Kotest
  - OpenSource
  - Testing
series: kotest-contributions
seriesOrder: 1
---

> 이 문서는 집필 순서와 근거를 확정하기 위한 내부 초안이다. 시리즈 안내 페이지는 공개하지만, 각 본문은 아직 발행하지 않는다.

# Kotest 기여 설계 기록 — 집필 계획

## 시리즈의 한 문장

Kotest는 Kotlin 테스트 프레임워크다. 단언문(assertion), 테스트 DSL과 실행 엔진, property-based testing, Kotlin Multiplatform 지원을 제공한다. 이 시리즈는 “기능을 몇 개 추가했다”가 아니라, 공개 프레임워크에서 **호환성·상태 소유권·실행 모델을 어떻게 판단하고 검증했는가**를 다룬다.

## 발행 순서

| 순서 | 예정 제목 | 중심 기여 | 독자가 가져갈 판단 |
| --- | --- | --- | --- |
| 1 | 테스트 메타데이터는 왜 Map 하나로 끝나지 않았는가 | [PR #5905](https://github.com/kotest/kotest/pull/5905), issue #5103 | 등록 중 가변성, 실행 중 불변성, 부모-자식 설정 병합을 분리한다. |
| 2 | JVM에서 되는 구현이 Kotlin Multiplatform에서 안전하지 않은 이유 | [PR #5789](https://github.com/kotest/kotest/pull/5789), [PR #5828](https://github.com/kotest/kotest/pull/5828) | 언어 내부 API를 우회할 때는 각 target의 링크 모델까지 검증해야 한다. |
| 3 | 전역 비교 규칙을 요청 범위로 내린 이유 | [PR #6010](https://github.com/kotest/kotest/pull/6010), issue #5910 | 병렬 실행에서 전역 mutable registry를 고치기보다, context를 따라 정책을 전달한다. |
| 4 | property test의 실패를 같은 최소 반례로 다시 여는 방법 | [PR #6097](https://github.com/kotest/kotest/pull/6097), [PR #6098](https://github.com/kotest/kotest/pull/6098), issue #3076 | seed만으로 부족한 재현성에서 탐색 경로·iteration·실패 의미를 분리한다. |
| 5 | 테스트 실패 메시지도 API다 | [PR #5835](https://github.com/kotest/kotest/pull/5835), [PR #5795](https://github.com/kotest/kotest/pull/5795), [PR #5807](https://github.com/kotest/kotest/pull/5807), [PR #5756](https://github.com/kotest/kotest/pull/5756) | 진단 정보, 설정 확장, DSL 일관성은 개발자의 디버깅 비용을 줄이는 제품 기능이다. |

## 각 글에서 지킬 서술 순서

1. 사용자가 실제로 부딪힌 문제를 작은 Kotlin 예제로 재현한다.
2. 기존 구조와 제약을 그림으로 먼저 설명한다.
3. 가능한 설계를 최소 두 개 비교하고, 선택하지 않은 안의 비용을 밝힌다.
4. PR의 코드·리뷰·테스트가 어떤 불변식을 검증했는지 연결한다.
5. 해결 범위와 남긴 후속 과제를 분리한다.
6. 독자가 설계의 경계를 확인할 수 있도록 FAQ를 마지막에 둔다.

## 1편 상세 목차 — 테스트 메타데이터는 왜 Map 하나로 끝나지 않았는가

1. 테스트에 issue·owner 같은 메타데이터가 필요한 순간
2. 단순 `Map<String, Any>`가 남기는 타입 충돌과 확장 한계
3. `MetadataKey<T>`: 이름만이 아니라 타입까지 키의 동일성으로 삼은 이유
4. 등록 시점의 mutable container와 실행 시점의 immutable snapshot을 나눈 이유
5. spec → container → test 설정을 병합할 때 child-wins를 택한 이유
6. 리뷰가 바꾼 설계: `TestConfig`에는 왜 mutable 객체 대신 `Map`을 남겼는가
7. public API 변경에서 api dump와 KMP 테스트가 의미하는 것
8. FAQ: “동일한 기능을 Spring의 annotation으로 만들지 않은 이유는?”

**필수 근거**: PR #5905의 maintainer 리뷰와 후속 수정 commit, `TestConfigResolver`의 parent-chain, metadata resolver 테스트.

## 2편 상세 목차 — JVM에서 되는 구현이 Kotlin Multiplatform에서 안전하지 않은 이유

1. `shouldEq`가 막으려 한 문제: `Int`와 `String` 비교가 컴파일되는 DSL
2. Kotlin의 `OnlyInputTypes`를 이용한 타입 추론 제한
3. 처음 선택: 내부 annotation shadowing과 그 이유
4. Native consumer에서만 터진 IR symbol 충돌을 최소 재현으로 좁힌 과정
5. 수정 선택: shadow class 제거와 invisible-reference suppression
6. 무엇을 그대로 보존했나: compile-time restriction과 public ABI
7. KMP 라이브러리에서 검증 매트릭스를 만드는 법
8. FAQ: “suppression은 기술 부채 아닌가?”

**필수 근거**: PR #5789와 PR #5828의 diff, Native library → consumer two-step reproducer, `apiDump` 결과.

## 3편 상세 목차 — 전역 비교 규칙을 요청 범위로 내린 이유

1. `DefaultEqResolver.register`가 병렬 spec에서 만드는 비결정성
2. lock으로 global registry를 보호하는 안을 먼저 버린 이유
3. 비교 한 번의 범위에만 적용되는 `withEqs { ... } shouldBe ...`
4. `EqContext`에 resolver를 넣어 재귀 비교까지 전파한 구조
5. layered resolver의 우선순위와 runtime type mismatch fallback
6. duplicate registration에서 last-wins를 명시한 이유
7. 리뷰에서 확인한 누락: `shouldNotBe` 경로와 parallel test 후속 과제
8. FAQ: “thread-local 대신 context를 선택한 이유는?”

**필수 근거**: PR #6010의 issue 제안, maintainer approval, `WithEqsTest`, 문서에 남은 global registration 제약.

## 4편 상세 목차 — property test의 실패를 같은 최소 반례로 다시 여는 방법

1. property-based testing과 shrinking: seed만으로는 왜 느린가
2. `RTree`와 shrink 탐색이 만드는 “최소 반례”의 의미
3. 기록할 index: dedup 이후 순번이 아니라 raw child index를 택한 이유
4. path recording과 replay를 두 PR로 나눈 이유
5. `seed + eval index + shrink path`의 역할을 분리한 이유
6. stale path·arity mismatch·최종 값 통과를 조용히 fallback하지 않은 이유
7. 22개 overload를 바꾸면서 JVM binary compatibility를 지킨 방식
8. 현재 상태와 발행 조건: 두 PR의 머지·리뷰·최종 API를 다시 확인한 뒤 발행

**필수 근거**: PR #6097/#6098의 최종 상태, `ShrinkPathRecordingTest`, replay E2E 테스트. **발행 전 현재 PR 상태 재확인 필수.**

## 5편 상세 목차 — 테스트 실패 메시지도 API다

1. assertion library의 사용자는 실패 메시지로 디버깅한다
2. 컬렉션 비교에서 index만 보일 때의 정보 손실과 data class diff 보존
3. JSON matcher의 hard-coded parser가 막은 실제 설정들
4. 기본 overload를 지우지 않고 custom parser overload를 더한 이유
5. `anyOf`와 `oneOf`: DSL·validation·parser dispatch를 함께 바꿔야 했던 이유
6. chainable assertion의 작은 변경이 API consistency에 미치는 영향
7. 무엇을 하나의 PR로 묶지 않았는가: 리뷰 가능한 범위와 회귀 표면
8. FAQ: “에러 메시지 개선을 기능 개발이라고 보는 이유는?”

**필수 근거**: PR #5835, #5795, #5807, #5756의 before/after 테스트와 API compatibility 확인.

## 발행 전 확인 목록

- 각 PR의 merge commit과 현행 source가 같은지 확인한다.
- Kotest 버전과 Kotlin 버전은 글의 기준 날짜·버전으로 고정한다.
- PR 설명의 AI 표시는 이력서·본문의 업적 근거로 사용하지 않는다. 본인이 제안·결정·수정·검증한 코드와 리뷰 대화만 인용한다.
- “org member”는 초대 사실과 공개 프로필에서 검증 가능한 범위로만 표기한다.
- 아직 open인 PR #6097/#6098은 완료된 업적으로 쓰지 않는다.
