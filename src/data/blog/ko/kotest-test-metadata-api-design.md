---
title: "테스트 메타데이터는 왜 Map 하나로 끝나지 않았는가 — 공개 API의 가변성 경계"
description: "Kotest에 type-safe test metadata API를 기여하며, 등록 시점의 가변성·실행 시점의 불변성·설정 계층의 우선순위를 어떻게 나눴는지 PR 리뷰와 코드로 설명합니다."
pubDatetime: 2026-08-01T13:00:00+09:00
draft: false
tags:
  - Kotlin
  - Kotest
  - OpenSource
  - API Design
  - Kotlin Multiplatform
series: kotest-contributions
seriesOrder: 1
---

테스트에 이슈 번호, 담당 팀, 기능 이름, 심각도 같은 정보를 붙이고 싶을 때가 있습니다. 가장 쉬운 출발점은 annotation입니다.

```kotlin
@Issue("PAY-123")
class PaymentSpec : FunSpec()
```

하지만 Kotlin Multiplatform 라이브러리에서는 이 선택이 곧 경계가 됩니다. JVM의 reflection으로는 annotation을 읽을 수 있어도 JS·Native·Wasm까지 같은 방식으로 읽을 수는 없습니다. 그렇다고 `TestConfig`에 `issueUrl`, `owner`, `story`를 하나씩 더하면, 새 metadata 종류가 생길 때마다 프레임워크 자체를 바꿔야 합니다.

이 글은 Kotest의 [issue #5103](https://github.com/kotest/kotest/issues/5103)에서 출발해 [PR #5905](https://github.com/kotest/kotest/pull/5905)로 머지된 type-safe test metadata API를 다룹니다. 핵심은 `Map`을 추가한 일이 아닙니다. **언제 누가 값을 바꿀 수 있고, 언제부터 누가 읽기만 할 수 있는지**를 공개 API의 일부로 만든 일입니다.

![PR #5905의 문제 정의와 머지 상태](/images/kotest/pr-5905-review-feedback.png)

*그림 1. PR #5905는 metadata key, 등록 시점 container, 실행 시점 snapshot, resolver의 역할을 분리해 제안했고 2026년 4월 14일 머지됐다. 원문과 전체 변경은 [PR #5905](https://github.com/kotest/kotest/pull/5905)에서 확인할 수 있다.*

## 1. Kotest에서 metadata가 흘러야 하는 곳

Kotest는 Kotlin 테스트 프레임워크다. 사용자는 `FunSpec`, `DescribeSpec` 같은 DSL로 테스트를 등록하고, 엔진은 등록된 테스트를 계층적으로 실행합니다. extension이나 listener는 실행 중인 `TestCase`를 받아 리포트를 만들거나 외부 도구와 연동합니다.

문제의 metadata도 이 흐름을 따라야 합니다.

```text
spec 기본 설정 ─┐
spec DSL ───────┼─> TestConfigResolver ─> ResolvedTestMetadata ─> extension / listener
container 설정 ─┤
test 설정 ──────┘
```

여기에는 서로 다른 두 시간이 있습니다.

- **등록 시간**: spec 본문이 실행되고 container·test가 만들어진다. DSL은 자연스럽게 `metadata[Issue] = ...`처럼 값을 추가하고 싶다.
- **실행 시간**: 여러 테스트와 extension이 metadata를 읽는다. 이 시점의 객체가 바뀌면, 같은 테스트도 reader마다 다른 값을 볼 수 있다.

처음부터 이 둘을 같은 `MutableMap`으로 처리하면 사용하기는 짧아도, 실행 중 공유 상태라는 문제를 API 사용자에게 넘기게 됩니다.

## 2. `Map<String, Any>`를 바로 공개하지 않은 이유

문자열 key는 빠르게 시작하기 좋습니다.

```kotlin
metadata["owner"] = "payments"
metadata["owner"] = User("kim") // 다른 모듈이 이렇게 쓰면?
```

두 모듈이 같은 이름을 다른 타입으로 쓰면, 읽는 쪽에서 cast가 늦게 실패합니다. 그래서 key 자체에 타입을 넣었습니다.

```kotlin
val Issue = MetadataKey<String>("Issue")
val Owner = MetadataKey<String>("Owner")

metadata[Issue] = "PAY-123"
val issue: String? = resolved[Issue]
```

`MetadataKey<T>`의 동일성은 `name`만이 아니라 `name + type`입니다. 즉 `MetadataKey<String>("Owner")`와 `MetadataKey<User>("Owner")`는 다른 key입니다. 저장소 내부의 `Any`는 피할 수 없지만, public API의 입력과 조회는 generic key를 통해 제한합니다.

이 선택에는 비용도 있습니다. 같은 문자열 이름이라도 타입이 다르면 “충돌” 대신 서로 다른 metadata가 됩니다. 그러나 library API에서 모호한 전역 문자열 충돌을 조용히 허용하는 것보다, 각 호출자가 정한 타입 계약을 보존하는 편이 낫다고 판단했습니다. 이슈에 남긴 최초 설계와 대안은 [issue comment](https://github.com/kotest/kotest/issues/5103#issuecomment-4240979525)에서 확인할 수 있습니다.

## 3. 가변성과 불변성을 같은 타입으로 만들지 않았다

처음 제안한 모델은 다음 세 역할이었습니다.

| 타입 | 사용 시점 | 허용하는 일 |
| --- | --- | --- |
| `TestMetadata` | spec 등록 | key-value 추가 |
| `TestConfig.metadata` | test/container 설정 | 설정 전달 |
| `ResolvedTestMetadata` | 실행·extension | 타입 안전 조회 |

이 구분의 핵심은 “concurrent collection을 쓰자”가 아닙니다. 실행 시점에 **mutation 자체가 필요 없게** 만드는 것입니다. resolver는 설정 계층을 모두 합친 뒤 `ResolvedTestMetadata` snapshot을 만들고, extension과 listener는 이 snapshot만 받습니다.

```kotlin
// 등록 시점: spec DSL은 추가할 수 있다.
metadata[Issue] = "PAY-123"

// 실행 시점: extension은 resolved snapshot을 읽는다.
val issue = testConfigResolver.metadata(testCase)[Issue]
```

이렇게 하면 extension이 우연히 `metadata[Issue] = ...`를 해 다른 테스트의 리포트 결과까지 바꾸는 경로가 없습니다. 병렬 실행 안전성을 lock으로 사후 보강하는 대신, 상태가 바뀌는 수명 자체를 registration 단계로 닫은 것입니다.

## 4. 리뷰가 바꾼 결정: `TestConfig`에는 왜 mutable container를 두지 않았는가

처음 PR에서는 test/container 설정도 다음처럼 제안했습니다.

```kotlin
test("refund").config(
   metadata = TestMetadata().also { it[Owner] = "payments-team" }
) { /* ... */ }
```

리뷰에서 메인테이너는 “framework가 만든 metadata instance를 새 객체로 바꾸는 모양이어서 예측하기 어려울 수 있다”는 점을 지적했습니다. 정확한 질문은 [리뷰 코멘트](https://github.com/kotest/kotest/pull/5905#issuecomment-4241135445)에 남아 있습니다.

이 피드백은 단순한 문법 취향이 아니었습니다. `TestConfig`의 기존 `tags`, `extensions`는 모두 value를 전달하는 immutable 설정입니다. test configuration에 mutable container를 넣으면 다음 두 모델이 섞입니다.

```text
spec DSL          : framework가 보유한 registration state를 누적한다
test.config(...)  : 한 test의 configuration value를 선언한다
```

두 모델을 같은 `TestMetadata`로 표현하면 사용자는 “기존 값을 추가하는가, 객체를 교체하는가”를 매번 해석해야 합니다. 그래서 리뷰 뒤에는 역할을 더 선명하게 나눴습니다.

```kotlin
// spec 등록: framework가 보유한 mutable container에 추가
metadata[Issue] = "PAY-123"

// test/container 설정: immutable value를 선언
test("refund").config(
   metadata = mapOf(Owner to "payments-team")
) { /* ... */ }
```

제가 [후속 답변](https://github.com/kotest/kotest/pull/5905#issuecomment-4241457176)에서 명시했듯, `TestMetadata`는 spec-level registration에 남기고 `TestConfig.metadata`는 `Map<MetadataKey<*>, Any>`로 바꿨습니다. 이 결정은 편의 메서드 하나를 줄이는 대신, **소유권과 mutation 가능성을 호출 위치만 보고 알 수 있게** 했습니다.

## 5. 상속은 새 알고리즘을 만들지 않고 기존 설정 해석을 재사용했다

metadata에는 우선순위가 필요합니다. spec에 공통 issue를 두고, 특정 test에서 다른 issue를 지정할 수 있어야 하기 때문입니다.

```kotlin
spec default      : Issue = "COMMON-1"
spec DSL          : Issue = "PAY-123"
container config  : Owner = "payments"
test config       : Issue = "PAY-456"

resolved test     : Issue = "PAY-456", Owner = "payments"
```

선택한 규칙은 **child wins per key**입니다. 같은 key를 더 안쪽 test가 지정하면 그 값이 이깁니다. 중요한 점은 metadata만을 위한 새로운 parent traversal을 만들지 않았다는 것입니다. Kotest가 이미 `tags` 등 설정을 해석할 때 쓰던 `TestConfigResolver`의 test parent-chain을 재사용하고, 낮은 우선순위부터 차례대로 덮어썼습니다.

```kotlin
spec defaults → spec DSL → outer container → inner container → test
```

이 선택의 trade-off도 분명합니다. 여러 단계에서 동일 key를 지정해도 경고 없이 마지막 값이 남습니다. merge conflict를 오류로 만들 수도 있었지만, test configuration은 가까운 scope가 일반 설정을 override하는 기존 Kotest 모델과 맞추는 편이 예측 가능했습니다. 대신 resolver test에서 inheritance와 override를 각각 고정했습니다.

## 6. 무엇을 일부러 하지 않았는가

이 변경은 `tags`, `severity`를 metadata로 전부 치환하지 않았습니다. 그 migration은 기존 API와 문서, extension 동작까지 넓게 바꿉니다. 이번 PR의 목적은 custom metadata를 위한 **공통 인프라**를 만드는 것이었고, 기존 domain-specific API의 재설계는 후속 결정으로 남겼습니다.

또한 JVM annotation을 유지하면서 reflection fallback을 추가하는 안도 택하지 않았습니다. 그 방식은 JVM에서만 편한 API를 먼저 만들고, 다른 target에서 다른 의미를 갖게 합니다. `commonMain`에서 동작하는 key-value 모델을 중심에 두면, extension 작성자가 target마다 metadata 수집 경로를 갈라야 하지 않습니다.

## 7. 공개 라이브러리 변경은 구현 테스트만으로 끝나지 않는다

PR #5905는 engine source뿐 아니라 public API dump와 resolver 테스트를 함께 바꿨습니다. 검증한 불변식은 다음과 같습니다.

- 같은 이름·같은 타입 key는 같다. 이름이나 타입이 다르면 다르다.
- 등록 중에는 값을 추가할 수 있지만, 실행 reader는 immutable snapshot만 본다.
- parent metadata는 상속되고 child가 같은 key를 override한다.
- 기존 engine test가 유지되고, 추가된 public surface만 API dump에 나타난다.

즉 “새 테스트가 통과했다”보다, **다음 버전으로 올린 사용자가 어떤 source·binary 계약을 보게 되는가**를 함께 확인한 변경입니다. 최종 머지 commit과 12개 변경 파일은 [PR의 files changed](https://github.com/kotest/kotest/pull/5905/files)에서 확인할 수 있습니다.

## FAQ

**왜 concurrent map을 쓰지 않았나요?**

동시성 자료구조는 mutation을 안전하게 만들 뿐, 실행 중에 metadata를 바꿔도 되는지 결정하지 않습니다. 등록 단계에는 가변 API를 제공하고, 실행 단계에는 immutable snapshot을 전달해 mutation이 필요한 범위를 없앴습니다.

**왜 `Map<String, Any>`가 아니라 `MetadataKey<T>`인가요?**

확장 라이브러리들이 같은 문자열을 독립적으로 쓸 수 있기 때문입니다. name과 type을 key identity로 만들고 generic lookup으로 감싸, 오류를 extension 실행 중 cast failure가 아니라 API 사용 경계로 앞당겼습니다.

**리뷰에서 무엇을 바꿨나요?**

처음에는 `TestConfig`에도 mutable `TestMetadata`를 전달했습니다. 리뷰 뒤에 spec 등록의 누적 상태와 test config의 선언형 value를 분리하고, 후자는 immutable `Map`으로 바꿨습니다. 코드량보다 상태 소유권을 더 분명하게 만든 수정입니다.

## 마무리

이 기여에서 남은 판단은 단순합니다. 프레임워크 API에서 `mutable`은 자료구조 선택이 아니라 **언제까지 누가 상태를 소유하는가**의 선언입니다. metadata를 한 개의 map으로 만들지 않고 registration container, configuration value, execution snapshot으로 나눈 이유도 여기에 있습니다.

다음 글에서는 JVM에서 통과한 타입 안전 assertion이 Kotlin/Native consumer에서 왜 linker failure를 냈는지, 그리고 public API를 유지하면서 어떤 수정 경로를 택했는지 다룹니다.

## 참고

- [Kotest issue #5103 — Store arbitrary test metadata](https://github.com/kotest/kotest/issues/5103)
- [Kotest PR #5905 — type-safe test metadata API](https://github.com/kotest/kotest/pull/5905)
- [Maintainer review on mutable config metadata](https://github.com/kotest/kotest/pull/5905#issuecomment-4241135445)
- [Review response and final `Map` decision](https://github.com/kotest/kotest/pull/5905#issuecomment-4241457176)
