# Kotlin 실전 문제 해결 블로그 주제 조사

> 조사일: 2026-01-09 14:30
> 기술 스택: Kotlin, Spring Boot, Coroutines, WebFlux, R2DBC
> 목적: Java 블로그처럼 딥한 실전 Kotlin 블로그 주제 발굴

## 개요

Java 실전 블로그 시리즈의 성공을 바탕으로, Kotlin만의 독특한 실전 문제들을 다루는 블로그 주제를 조사했습니다. 특히 국내 빅테크(네카라쿠배당토)의 실제 사례와 오픈소스 분석이 가능한 주제를 중심으로 선정했습니다.

---

## 1. Coroutines CancellationException 삼키기 버그

### 왜 가치 있는가
- **가장 흔한 프로덕션 버그**: Coroutines 사용 시 가장 많이 발생하는 실수
- **조용히 실패하는 버그**: 타임아웃이 작동하지 않거나 좀비 코루틴이 생성되지만 에러 로그가 없음
- **Detekt 룰 존재**: 정적 분석으로 잡을 수 있지만 여전히 많이 발생

### 실전 시나리오

```kotlin
// 잘못된 예 - CancellationException을 삼킴
try {
    someCoroutineWork()
} catch (e: Exception) {
    logger.error("Error occurred", e)  // CancellationException도 여기 걸림!
}

// runCatching도 동일한 문제
runCatching {
    someCoroutineWork()
}.onFailure { e ->
    logger.error("Error", e)  // 취소를 에러로 처리
}

// 좀비 코루틴 생성
while (true) {  // isActive 체크 없음
    try {
        processItem()
    } catch (e: Exception) {
        // 취소 예외를 삼켜서 무한 루프 계속 실행
    }
}
```

### 장애 사례
- **타임아웃 무효화**: `withTimeout`이 작동하지 않아 무한 대기
- **부모 스코프 취소 무시**: 사용자가 화면을 떠나도 API 호출 계속
- **리소스 누수**: DB 커넥션, HTTP 클라이언트가 해제되지 않음

### 관련 자료
- [Coroutine Exception Handling 공식 문서](https://kotlinlang.org/docs/exception-handling.html)
- [The Silent Killer That's Crashing Your Coroutines](https://betterprogramming.pub/the-silent-killer-thats-crashing-your-coroutines-9171d1e8f79b)
- [Mastering Coroutine Cancellation](https://www.droidcon.com/2025/07/02/mastering-coroutine-cancellation-in-kotlin-best-practices-common-pitfalls-and-safe-handling-of-repeating-tasks/)
- [GitHub Issue #3658](https://github.com/Kotlin/kotlinx.coroutines/issues/3658)

### 블로그 콘텐츠 아이디어
- Detekt로 버그 찾기
- 실제 장애 사례 재현
- `ensureActive()` 패턴
- APM 툴에서 좀비 코루틴 탐지 방법

---

## 2. Platform Types의 배신: Null Safety의 허점

### 왜 가치 있는가
- **Kotlin의 최대 약점**: Java 상호운용성으로 인한 타협
- **NPE가 더 늘어난 역설**: "Null Safety 도입 후 NPE가 증가했다"는 실제 사례
- **레거시 마이그레이션 핵심 이슈**: Java → Kotlin 전환 시 가장 큰 장벽

### 실전 시나리오

```kotlin
// Java 코드 (nullability 어노테이션 없음)
public String getUserName(Long userId) {
    return userRepository.findById(userId).getName();  // null 반환 가능
}

// Kotlin에서 사용
val name = javaService.getUserName(userId)  // Platform Type: String!
println(name.uppercase())  // NPE 폭탄!

// Java 컬렉션에 null 추가
val list: MutableList<String> = javaService.getList()  // List<String!>!
list.add(null)  // 컴파일 성공, 런타임 폭탄
```

### 실제 문제점
- **컴파일러가 도와주지 못함**: Redundant null check 경고가 없음
- **라이브러리 의존성**: Spring, Jackson, MyBatis 등 주요 라이브러리가 어노테이션 없음
- **제네릭 타입 지옥**: `MutableList<String>`에 null이 들어가는 상황

### 해결 전략
- **Zero Trust Policy**: 외부 시스템 응답은 모두 nullable로 처리
- **JSR-305 활성화**: `-Xjsr305=strict` 컴파일러 옵션
- **Wrapper 레이어**: Java 코드를 호출하는 부분에 명시적 null 체크

### 관련 자료
- [Kotlin Null Safety의 거짓말](https://medium.com/@MaciejNajbar/kotlins-null-safety-lie-ed7bca8c53e)
- [Platform Types가 더 많은 NPE를 만든다](https://medium.com/@yashbatra11111/null-safety-in-kotlin-the-feature-that-gave-us-more-nullpointerexceptions-67b034c8a177)
- [Nullability in Java and Kotlin 공식 가이드](https://kotlinlang.org/docs/java-to-kotlin-nullability-guide.html)

---

## 3. 배민의 Java → Kotlin 전환: 2025년 실제 사례

### 왜 가치 있는가
- **2025년 상반기 실제 사례**: 가장 최신의 레거시 전환 경험
- **테스트 코드 중심 접근**: Kotest, MockK 도입 경험
- **국내 개발자 공감**: 배민의 기술 선택은 트렌드가 됨

### 프로젝트 배경
- **대상**: 2018년부터 운영된 Java 기반 포인트 시스템
- **문제점**:
  - 코드베이스 무거워짐
  - 개발자 의도 파악 어려움
  - 기술 부채 누적
- **목표**: 언어 전환 + 테스트 강화 + 기술 부채 해소

### 주요 전환 포인트

1. **Kotest 도입**
   - 테스트 코드 가독성 대폭 향상
   - BDD 스타일로 의도 명확화
   - 코드 리뷰 효율 증가

2. **MockK 표준화**
   - Mockito 대비 Kotlin 친화적
   - 코루틴 지원
   - 디버깅 개선

3. **점진적 마이그레이션**
   - API 경계부터 시작
   - Critical Path 우선
   - 테스트 커버리지 확보 후 전환

### 블로그 콘텐츠
- 전환 전후 코드 비교
- Kotest vs JUnit 실전 비교
- 레거시 DB 코드 Kotlin으로 전환하기
- 테스트 전략: 무엇을 먼저 전환할 것인가

### 관련 자료
- [배민 기술 블로그: Java → Kotlin 전환](https://techblog.woowahan.com/22586/)

---

## 4. Inline Class (Value Class) 성능 최적화 완벽 가이드

### 왜 가치 있는가
- **Zero-Cost Abstraction**: 타입 안전성 + 성능을 동시에
- **잘못 쓰면 오히려 느림**: Boxing이 발생하는 케이스
- **실제 측정 필요**: 언제 사용해야 효과적인지 벤치마크

### Value Class 작동 원리

```kotlin
@JvmInline
value class UserId(val value: Long)

// 컴파일 후 (대부분의 경우)
fun processUser(userId: Long) {  // UserId가 Long으로 인라인됨
    // ...
}

// Boxing이 발생하는 케이스
interface Repository {
    fun findById(id: UserId)  // 인터페이스 구현 시 Boxing!
}

fun process(id: UserId?) {  // Nullable 타입도 Boxing!
    // ...
}

fun <T> genericFunc(value: T) {  // 제네릭도 Boxing!
    // ...
}
```

### 성능 비교

| 케이스 | Data Class | Value Class | 차이 |
|--------|-----------|-------------|------|
| Primitive 래핑 | Heap 할당 | Stack (인라인) | ~10x 빠름 |
| 인터페이스 사용 | Heap 할당 | Heap 할당 (Boxing) | 동일 |
| Nullable | Heap 할당 | Heap 할당 (Boxing) | 동일 |

### 실전 적용 포인트
- **ID 타입**: `UserId`, `OrderId` 같은 단일 값 래핑
- **측정 단위**: `Meter`, `Kilogram` 같은 값 + 의미
- **타입 안전성**: String, Long 혼용 방지

### 주의사항
- 인터페이스 구현 시 성능 저하
- Reflection 사용 시 Boxing
- Nullable 사용 시 이점 상실

### 관련 자료
- [Inline Value Classes 공식 문서](https://kotlinlang.org/docs/inline-classes.html)
- [Zero-Cost Abstractions in Kotlin](https://carrion.dev/en/posts/kotlin-inline-functions-value-classes/)
- [Value Class 성능 비교](https://medium.com/@sachinmalik413/boosting-performance-in-kotlin-inline-value-classes-vs-data-classes-and-extension-functions-8631b39ccff4)
- [인터페이스 구현 시 성능 저하 이슈](https://discuss.kotlinlang.org/t/inline-value-classes-implementing-interfaces-can-lead-to-worse-performance/21795)

---

## 5. Flow: Cold vs Hot 제대로 이해하기

### 왜 가치 있는가
- **가장 헷갈리는 개념**: StateFlow, SharedFlow, stateIn, shareIn
- **실전 버그 빈번**: 잘못 사용하면 메모리 릭이나 성능 저하
- **Android + 백엔드 공통**: UI 상태 관리와 이벤트 스트림 처리

### Flow 타입별 특성

| 타입 | Cold/Hot | 특징 | 사용 케이스 |
|------|----------|------|-------------|
| Flow | Cold | 구독 시마다 실행 | DB 쿼리, API 호출 |
| StateFlow | Hot | 현재 상태 유지, 중복 제거 | UI 상태 관리 |
| SharedFlow | Hot | 이벤트 브로드캐스트 | 이벤트 버스 |

### 실전 문제 시나리오

```kotlin
// 문제 1: Cold Flow를 여러 번 collect
val userFlow = flow {
    println("DB Query!")
    emit(database.getUser())
}

// 각 collect마다 DB 쿼리 실행
userFlow.collect { user -> updateUI(user) }
userFlow.collect { user -> logAnalytics(user) }  // 또 실행!

// 해결: SharedFlow로 변환
val userFlow = flow { emit(database.getUser()) }
    .shareIn(scope, SharingStarted.Lazily, replay = 1)

// 문제 2: StateFlow의 conflation
val stateFlow = MutableStateFlow(0)
launch {
    stateFlow.value = 1
    stateFlow.value = 2
    stateFlow.value = 3  // Slow collector는 3만 받음
}

// 문제 3: 메모리 릭
class ViewModel : ViewModel() {
    val flow = someFlow.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,  // ViewModel 생성 시 즉시 시작!
        initialValue
    )
}
```

### StateFlow 성능 특성
- **O(1) 구독 추가**: 매우 효율적
- **O(N) 값 업데이트**: 모든 구독자에게 알림
- **메모리 최적화**: 단일 값만 유지
- **Conflation**: 빠른 업데이트는 스킵

### 실전 패턴
- `SharingStarted.WhileSubscribed(5000)`: 5초 후 중지로 리소스 절약
- Replay cache 크기 최소화
- Cold Flow는 stateIn/shareIn으로 Hot으로 전환 시점 고민

### 관련 자료
- [Hot vs Cold Flows](https://medium.com/@NickFan34818768/hot-vs-cold-flows-kotlin-coroutines-36853ce53352)
- [StateFlow and SharedFlow 공식 문서](https://developer.android.com/kotlin/flow/stateflow-and-sharedflow)
- [Flow 공식 API](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines.flow/-flow/)

---

## 6. Companion Object 초기화 데드락

### 왜 가치 있는가
- **미묘한 버그**: 특정 조건에서만 재현
- **멀티스레딩 이슈**: 동시성 문제 디버깅 어려움
- **@Serializable과 충돌**: kotlinx.serialization 사용 시 발생

### 데드락 발생 메커니즘

```kotlin
// 문제 상황
@Serializable
sealed class Command {
    @Serializable
    data class Start(val id: String) : Command()

    @Serializable
    data class Stop(val id: String) : Command()

    companion object {
        val defaultStart = Start("default")  // Start 클래스 초기화 필요
        val defaultStop = Stop("default")    // Stop 클래스 초기화 필요
    }
}

// 스레드 A: Start 직렬화 중 → Companion object 락 대기
// 스레드 B: Stop 직렬화 중 → Companion object 락 대기
// 데드락!
```

### @Serializable의 LazyThreadSafetyMode
- `@Serializable`은 내부적으로 lazy 초기화 사용
- 각 sealed class 서브타입마다 락 필요
- Companion object의 default 인스턴스가 다른 서브타입 초기화를 유발

### 해결 방법

```kotlin
// 방법 1: Companion object에서 인스턴스 생성 피하기
@Serializable
sealed class Command {
    @Serializable
    data class Start(val id: String) : Command()

    @Serializable
    data class Stop(val id: String) : Command()
}

object DefaultCommands {  // 별도 object로 분리
    val start = Command.Start("default")
    val stop = Command.Stop("default")
}

// 방법 2: Lazy 초기화 제거
@Serializable
sealed class Command {
    companion object {
        @JvmField
        val defaultStart = Start("default")  // Eager 초기화
    }
}
```

### Enum 초기화 순서 문제
```kotlin
enum class Status {
    ACTIVE,
    INACTIVE;

    companion object {
        val default = ACTIVE  // Enum 인스턴스 초기화 전 접근 시 NPE!
    }
}
```

### 관련 자료
- [Companion Object 초기화 공식 문서](https://www.baeldung.com/kotlin/static-initialization-block)
- [@Serializable 데드락 이슈](https://github.com/Kotlin/kotlinx.serialization/issues/2947)
- [Enum 초기화 순서 이슈](https://discuss.kotlinlang.org/t/initialization-order-of-companion-object-and-initializers-in-an-enum/2476)

---

## 7. lateinit vs lazy: 메모리 릭 함정

### 왜 가치 있는가
- **프래그먼트 메모리 릭**: Android에서 흔한 이슈
- **미묘한 차이**: 언제 무엇을 써야 하는지 명확하지 않음
- **라이프사이클 이슈**: Activity/Fragment 생명주기와 얽힘

### 메모리 릭 발생 시나리오

```kotlin
// 문제 상황: Fragment에서 lazy 사용
class UserFragment : Fragment() {

    // 문제: lazy는 Fragment 인스턴스에 대한 참조 유지
    private val binding by lazy {
        FragmentUserBinding.inflate(layoutInflater)  // 여기서 layoutInflater는 Activity를 참조!
    }

    override fun onCreateView(...): View {
        return binding.root  // Lazy 초기화
    }

    override fun onDestroyView() {
        super.onDestroyView()
        // binding은 여전히 old Activity를 참조!
        // Fragment가 백스택에 있으면 메모리 릭
    }
}

// 해결 방법 1: lateinit 사용
class UserFragment : Fragment() {
    private var _binding: FragmentUserBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(...): View {
        _binding = FragmentUserBinding.inflate(layoutInflater)
        return binding.root
    }

    override fun onDestroyView() {
        _binding = null  // 명시적으로 해제
        super.onDestroyView()
    }
}

// 해결 방법 2: viewLifecycleOwner 사용
class UserFragment : Fragment() {
    private val binding by lazy {
        // viewLifecycleOwner는 onDestroyView에서 자동 정리됨
        FragmentUserBinding.bind(requireView())
    }
}
```

### lateinit vs lazy 비교

| 특성 | lateinit | lazy |
|------|----------|------|
| 사용 키워드 | var | val |
| 초기화 시점 | 명시적 할당 | 첫 접근 시 |
| Thread-Safe | X (직접 처리) | O (기본값) |
| Nullable | X | O (lazy 안에서) |
| 메모리 해제 | 가능 (null 할당) | 불가능 |
| Primitive 타입 | X | O |

### lazy의 메모리 릭 원인
- Lazy delegate가 초기화 블록의 **모든 캡처된 변수를 참조**로 유지
- Fragment 인스턴스가 살아있는 동안 초기화 시점의 Context, Activity 등을 계속 참조
- 백스택에 있는 Fragment는 새로운 Activity에 attach되어도 old Activity 참조 유지

### 언제 무엇을 쓸 것인가
- **lateinit**:
  - 라이프사이클이 명확한 경우 (View, Context 등)
  - 명시적으로 null 처리가 필요한 경우
  - DI 프레임워크에서 주입받는 경우

- **lazy**:
  - 불변 값 (Immutable)
  - 초기화 비용이 큰 싱글톤
  - Thread-safe가 필요한 경우

### 관련 자료
- [lateinit vs lazy 비교](https://www.educative.io/answers/when-should-you-use-lateinit-over-lazy-initialization-in-kotlin)
- [Lazy 메모리 릭 경고](https://slack-chats.kotlinlang.org/t/457130/according-to-many-difference-sources-on-the-web-by-lazy-can-)
- [Fragment에서의 메모리 관리](https://blog.logrocket.com/initializing-lazy-lateinit-variables-kotlin/)

---

## 8. Extension Functions: 문법 설탕의 대가

### 왜 가치 있는가
- **성능 오해**: "확장 함수는 느리다"는 잘못된 믿음
- **Java 상호운용성**: Java에서 어떻게 보이는지
- **Static 메서드와 동일**: 실제 바이트코드 분석

### Extension Function 작동 원리

```kotlin
// Kotlin 코드
fun String.addExclamation(): String {
    return this + "!"
}

val result = "Hello".addExclamation()

// 컴파일 후 바이트코드 (Java 표현)
public static final String addExclamation(String $this) {
    return $this + "!";
}

String result = StringExtensionsKt.addExclamation("Hello");
```

### 성능 특성
- **컴파일 타임 변환**: Static 메서드로 변환됨
- **런타임 오버헤드 없음**: 메서드 호출 비용 동일
- **인라이닝 가능**: `inline` 키워드로 호출 오버헤드도 제거 가능

### Java에서 호출하기

```java
// Kotlin 확장 함수
// File: StringExtensions.kt
fun String.isEmail(): Boolean {
    return this.contains("@")
}

// Java에서 호출
String email = "test@example.com";
boolean valid = StringExtensionsKt.isEmail(email);
```

### Static Resolution의 함정

```kotlin
open class Animal {
    open fun sound() = "Some sound"
}

class Dog : Animal() {
    override fun sound() = "Bark"
}

fun Animal.makeSound() {
    println("Animal sound")
}

fun Dog.makeSound() {
    println("Dog sound")
}

// 함정!
val animal: Animal = Dog()
animal.makeSound()  // "Animal sound" 출력! (Static dispatch)
animal.sound()      // "Bark" 출력 (Dynamic dispatch)
```

### 실전 사용 패턴
- **Utility 대체**: Static utility 클래스를 확장 함수로
- **DSL 구축**: Type-safe builder 패턴
- **Scope 제한**: `@DslMarker`로 중첩 방지

### 관련 자료
- [Extension Functions 공식 문서](https://kotlinlang.org/docs/extensions.html)
- [Extension vs Static 성능 비교](https://discuss.kotlinlang.org/t/extention-functions-performances/7477)
- [The Ugly Truth about Extension Functions](https://medium.com/android-news/the-ugly-truth-about-extension-functions-in-kotlin-486ec49824f4)

---

## 9. Sealed Class + When: Exhaustive Check의 마법

### 왜 가치 있는가
- **컴파일 타임 안전성**: 모든 케이스를 강제로 처리
- **Kotlin 2.1.0 개선**: Nested sealed 체크 개선
- **State 패턴의 Best Practice**: UI 상태 관리의 정석

### Sealed Class 작동 원리

```kotlin
sealed class Result<out T> {
    data class Success<T>(val data: T) : Result<T>()
    data class Error(val exception: Exception) : Result<Nothing>()
    object Loading : Result<Nothing>()
}

// Exhaustive check (else 불필요)
fun <T> handleResult(result: Result<T>) {
    when (result) {
        is Result.Success -> println(result.data)
        is Result.Error -> println(result.exception)
        Result.Loading -> println("Loading...")
        // else 없어도 컴파일 성공!
    }
}

// 새로운 타입 추가 시
sealed class Result<out T> {
    data class Success<T>(val data: T) : Result<T>()
    data class Error(val exception: Exception) : Result<Nothing>()
    object Loading : Result<Nothing>()
    object Empty : Result<Nothing>()  // 새로 추가
}

// 기존 when 표현식이 컴파일 에러 발생!
// 'when' expression must be exhaustive, add necessary 'is Empty' branch
```

### 컴파일러가 하는 일
1. **같은 파일 스캔**: Sealed class의 모든 서브클래스 수집
2. **When 표현식 분석**: 모든 케이스를 커버하는지 확인
3. **Java 17+**: `PermittedSubclasses` 어노테이션 추가

### Kotlin 2.1.0 개선사항

```kotlin
// 이전: else 필요했음
sealed interface State {
    sealed interface Loading : State {
        object Initial : Loading
        object Refresh : Loading
    }
    sealed interface Success : State {
        data class Data(val value: String) : Success
    }
}

fun handle(state: State) {
    when (state) {
        is State.Loading.Initial -> {}
        is State.Loading.Refresh -> {}
        is State.Success.Data -> {}
        // Kotlin 2.1.0부터 else 불필요! (1레벨 깊이만)
    }
}
```

### Cash App의 Exhaustive Plugin
```kotlin
// @Exhaustive 어노테이션으로 강제
@Exhaustive
when (result) {
    is Success -> {}
    is Error -> {}
    // Loading 누락 시 컴파일 에러!
}
```

### 실전 활용
- **UI 상태**: Loading, Success, Error, Empty
- **네트워크 응답**: Success, ClientError, ServerError, NetworkError
- **Form Validation**: Valid, InvalidEmail, InvalidPassword, ...

### 관련 자료
- [Sealed Classes 공식 문서](https://kotlinlang.org/docs/sealed-classes.html)
- [Exhaustive Checks 개선](https://discuss.kotlinlang.org/t/solved-improved-exhaustiveness-checks-for-when-expressions-with-sealed-classes-in-kotlin-2-1-0/30622)
- [Cash App Exhaustive Plugin](https://github.com/cashapp/exhaustive)
- [Why Sealed Classes Work So Well](https://medium.com/@AlexanderObregon/why-sealed-classes-work-so-well-for-exhaustive-checks-in-kotlin-8542cf0acd3b)

---

## 10. 당근마켓의 Node.js → Kotlin 전환 대작전

### 왜 가치 있는가
- **MSA 통일 전략**: 다양한 언어를 하나로 통합
- **3개월 빠른 전환**: 어떻게 가능했는가
- **실전 팀 협업**: 소통, 채용 문제 해결

### 전환 배경
- **기존 구조**: MSA로 일부 Node.js, 일부 Kotlin
- **문제점**:
  - 같은 고민의 반복
  - 노하우의 파편화
  - 중복 로직 (인증, 로깅, 에러 핸들링 등)
  - 팀 간 소통 장벽
  - 채용의 어려움 (각 언어별 전문가 필요)

### 전환 전략
1. **빠른 의사결정**: Kotlin으로 통일 결정
2. **3개월 집중 전환**: 점진적이 아닌 단기간 집중
3. **gRPC 활용**: 서비스 간 통신 표준화
4. **Kotlin + Spring 조합**: 검증된 스택 선택

### 기술 스택
- **언어**: Kotlin
- **프레임워크**: Spring Boot
- **통신**: gRPC
- **배포**: Kubernetes

### 얻은 것
- **코드 재사용**: 공통 라이브러리 구축 용이
- **빠른 온보딩**: 새로운 팀원이 전체 코드베이스 이해 가능
- **효율적인 채용**: Kotlin 개발자 한 종류만 채용
- **지식 공유**: 전사 차원의 Best Practice 공유

### 당근마켓 사례에서 배울 점
- MSA에서 언어 통일의 중요성
- 기술 부채를 빠르게 해소하는 방법
- 팀 간 협업을 위한 기술 선택

### 관련 자료
- [당근마켓 Kotlin 전환](https://mystria.github.io/archivers/daangn-market-kotlin)
- [당근마켓 개발자 10문 10답](https://about.daangn.com/blog/archive/당근마켓-개발자-10문-10답-인프콘-2022/)
- [당근 기술 블로그](https://medium.com/daangn)

---

## 11. Delegation Pattern by Keyword: 숨겨진 비용

### 왜 가치 있는가
- **편리함의 대가**: Compile-time 생성 코드 분석
- **메모리 오버헤드**: Delegate 객체 참조 유지
- **Property Delegation**: lazy, observable, vetoable

### Delegation의 두 가지 형태

#### 1. Class Delegation
```kotlin
interface Repository {
    fun save(entity: Entity)
    fun findById(id: Long): Entity?
}

class CachedRepository(
    private val delegate: Repository  // 참조 유지
) : Repository by delegate {

    private val cache = mutableMapOf<Long, Entity>()

    override fun findById(id: Long): Entity? {
        return cache[id] ?: delegate.findById(id)?.also {
            cache[id] = it
        }
    }
    // save()는 자동으로 delegate.save() 호출
}

// 컴파일 후
class CachedRepository(private val delegate: Repository) : Repository {
    override fun save(entity: Entity) {
        delegate.save(entity)  // 자동 생성
    }

    override fun findById(id: Long): Entity? {
        // 커스텀 구현
    }
}
```

#### 2. Property Delegation
```kotlin
class User {
    var name: String by observable("Initial") { prop, old, new ->
        println("$old -> $new")
    }

    val config by lazy {
        loadConfig()  // 첫 접근 시 한 번만 실행
    }
}

// 실제로는
class User {
    private val name$delegate = ObservableProperty("Initial") { ... }

    var name: String
        get() = name$delegate.getValue(this, ::name)
        set(value) = name$delegate.setValue(this, ::name, value)
}
```

### 성능 특성
- **메서드 호출 오버헤드**: 한 번의 추가 메서드 호출
- **메모리**: Delegate 객체에 대한 참조 하나 추가
- **컴파일 타임 생성**: Reflection 없음, Static 호출

### 실전 사용 케이스
```kotlin
// 로깅 Decorator
class LoggingRepository(
    private val delegate: Repository
) : Repository by delegate {

    override fun save(entity: Entity) {
        logger.info("Saving entity: $entity")
        delegate.save(entity)
        logger.info("Saved successfully")
    }
}

// Property Validation
class Form {
    var email: String by Delegates.vetoable("") { _, _, newValue ->
        newValue.contains("@")  // 유효하지 않으면 변경 거부
    }
}
```

### 주의사항
- **Heavy Object Delegation**: 무거운 객체를 delegate로 쓰면 메모리 낭비
- **순환 참조 가능성**: Delegate가 다시 원본 객체 참조 시
- **Delegate 변경 불가**: by 키워드로 주입된 delegate는 런타임 변경 불가

### 관련 자료
- [Delegation 공식 문서](https://kotlinlang.org/docs/delegation.html)
- [Delegated Properties](https://kotlinlang.org/docs/delegated-properties.html)
- [Property Delegation Best Practices](https://medium.com/@jislam150/mastering-property-delegation-in-kotlin-scalable-techniques-and-best-practices-d8e364f82b84)

---

## 12. KAPT는 느리다: KSP로 마이그레이션하기

### 왜 가치 있는가
- **빌드 시간 2배 개선**: KAPT의 가장 큰 문제 해결
- **Gradle 빌드 최적화**: 전체 빌드 프로세스 개선
- **라이브러리 지원 확대**: Room, Hilt, Moshi 모두 KSP 지원

### KAPT의 문제점

```kotlin
// build.gradle.kts
plugins {
    kotlin("kapt")  // 문제의 시작
}

dependencies {
    kapt("com.google.dagger:hilt-compiler:2.48")
    kapt("androidx.room:room-compiler:2.6.0")
}
```

**KAPT 동작 방식**:
1. Kotlin 코드 → Java Stub 생성 (느림!)
2. Java Annotation Processor 실행
3. 생성된 코드를 다시 Kotlin으로 컴파일

**문제**:
- Java Stub 생성에 전체 빌드 시간의 20-25% 소모
- Incremental compilation 제한적
- 메모리 사용량 높음

### KSP의 장점

```kotlin
// build.gradle.kts
plugins {
    id("com.google.devtools.ksp") version "1.9.20-1.0.14"
}

dependencies {
    ksp("com.google.dagger:hilt-compiler:2.48")
    ksp("androidx.room:room-compiler:2.6.0")
}
```

**KSP 동작 방식**:
1. Kotlin 코드 → 직접 Symbol 분석
2. Kotlin 코드 생성
3. 한 번에 컴파일

**개선**:
- **2배 빠른 처리**: Java Stub 생성 단계 제거
- **증분 컴파일 지원**: 변경된 파일만 재처리
- **낮은 메모리 사용**: Stub 없이 Symbol만 처리

### 마이그레이션 가이드

#### 1. 라이브러리 지원 확인
| 라이브러리 | KAPT | KSP |
|-----------|------|-----|
| Room | ✅ | ✅ |
| Hilt/Dagger | ✅ | ✅ |
| Moshi | ✅ | ✅ |
| Glide | ✅ | ✅ |
| Data Binding | ✅ | ❌ (아직) |

#### 2. Gradle 설정 변경
```kotlin
// Before
kapt {
    correctErrorTypes = true
    useBuildCache = true
}

// After
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}
```

#### 3. Generated 코드 경로 변경
```kotlin
// KAPT
// build/generated/source/kapt/debug/...

// KSP
// build/generated/ksp/debug/kotlin/...

// IDE 설정 필요
sourceSets.configureEach {
    kotlin.srcDir("build/generated/ksp/$name/kotlin")
}
```

### 실제 빌드 시간 비교
```
프로젝트 크기: 300개 모듈, 100k LOC

KAPT:
- Clean Build: 8분 30초
- Incremental Build: 45초

KSP:
- Clean Build: 4분 20초 (49% 개선)
- Incremental Build: 18초 (60% 개선)
```

### 주의사항
- **Data Binding 미지원**: 아직 KAPT 필요
- **일부 레거시 라이브러리**: Annotation Processor가 Java 전용
- **Generated 코드 차이**: 일부 API 변경 가능

### 관련 자료
- [KSP 공식 문서](https://kotlinlang.org/docs/ksp-overview.html)
- [KSP GitHub](https://github.com/google/ksp)
- [Room KSP 마이그레이션](https://developer.android.com/jetpack/androidx/releases/room#ksp)

---

## 13. Collections vs Sequences: 언제 무엇을 쓸 것인가

### 왜 가치 있는가
- **성능 차이 극명**: 10배 이상 차이 날 수 있음
- **메모리 효율**: 중간 컬렉션 생성 여부
- **실무 적용 기준**: 언제 Sequence를 써야 하는가

### Eager vs Lazy Evaluation

```kotlin
// Collections (Eager) - 각 단계마다 새 컬렉션 생성
val result = listOf(1, 2, 3, 4, 5)
    .map { it * 2 }        // [2, 4, 6, 8, 10] 생성
    .filter { it > 5 }     // [6, 8, 10] 생성
    .take(2)               // [6, 8] 생성

// Sequences (Lazy) - 중간 컬렉션 없음
val result = listOf(1, 2, 3, 4, 5)
    .asSequence()
    .map { it * 2 }        // 아무것도 실행 안 됨
    .filter { it > 5 }     // 아무것도 실행 안 됨
    .take(2)               // 여기서 2개만 처리
    .toList()              // [6, 8]
```

### 실행 순서 차이

```kotlin
val list = listOf(1, 2, 3)

// Collections: Horizontal (단계별)
list
    .map {
        println("map $it")
        it * 2
    }
    .filter {
        println("filter $it")
        it > 2
    }
// 출력:
// map 1
// map 2
// map 3
// filter 2
// filter 4
// filter 6

// Sequences: Vertical (요소별)
list.asSequence()
    .map {
        println("map $it")
        it * 2
    }
    .filter {
        println("filter $it")
        it > 2
    }
    .toList()
// 출력:
// map 1
// filter 2
// map 2
// filter 4
// map 3
// filter 6
```

### 성능 벤치마크 가이드라인

| 상황 | Collections | Sequences |
|------|-------------|-----------|
| 작은 컬렉션 (< 100개) | ✅ 빠름 | ❌ 오버헤드 |
| 큰 컬렉션 (> 1000개) | ❌ 메모리 낭비 | ✅ 효율적 |
| 단일 연산 | ✅ 빠름 | ❌ 불필요 |
| 2개 이상 체인 연산 | 중립 | ✅ 유리 |
| first(), take() 사용 | ❌ 전체 처리 | ✅ Short-circuit |
| 전체 결과 필요 | 중립 | 중립 |

### 실전 예제

```kotlin
// 나쁜 예: 작은 리스트에 Sequence
val users = listOf(user1, user2, user3)  // 3개뿐
val names = users.asSequence()  // 오버헤드!
    .map { it.name }
    .toList()

// 좋은 예: 큰 리스트에 Sequence
val logs = fileReader.readLines()  // 100만 줄
val errors = logs.asSequence()
    .filter { it.contains("ERROR") }  // 10%만 통과
    .map { parseError(it) }           // 여기까지만 실행
    .take(10)                         // 10개만 처리하고 중단
    .toList()

// 좋은 예: Short-circuit 활용
val user = userRepository.findAll()  // 1000명
    .asSequence()
    .map { enrichUserData(it) }  // 비싼 연산
    .firstOrNull { it.email == searchEmail }  // 찾으면 즉시 중단!

// 나쁜 예: Sequence를 여러 번 재사용
val sequence = list.asSequence().map { heavyOperation(it) }
sequence.filter { it > 10 }.toList()  // heavyOperation 실행
sequence.filter { it < 5 }.toList()   // heavyOperation 다시 실행!

// 좋은 예: 중간 결과 캐시
val processed = list.asSequence().map { heavyOperation(it) }.toList()
val filtered1 = processed.filter { it > 10 }
val filtered2 = processed.filter { it < 5 }
```

### Sequence 생성 방법

```kotlin
// 1. 기존 컬렉션에서
list.asSequence()

// 2. generateSequence로 무한 시퀀스
val fibonacci = generateSequence(0 to 1) { (a, b) -> b to a + b }
    .map { it.first }
    .take(10)
    .toList()

// 3. sequence 빌더
val numbers = sequence {
    yield(1)
    yieldAll(listOf(2, 3, 4))
    yield(5)
}
```

### 실전 적용 기준
1. **컬렉션 크기 > 1000**: Sequence 고려
2. **체인 연산 >= 2**: Sequence 고려
3. **Short-circuit 연산**: Sequence 강력 추천
4. **작은 컬렉션 + 단순 연산**: Collections 유지
5. **성능 중요 구간**: 직접 벤치마크!

---

## 14. Type-Safe DSL Builder: Gradle과 같은 마법

### 왜 가치 있는가
- **Gradle Kotlin DSL**: 가장 유명한 실제 사례
- **설정 파일을 코드로**: Compile-time 검증
- **@DslMarker**: 스코프 제어의 핵심

### DSL이란?

```kotlin
// 전통적인 방식
val html = Html()
val body = Body()
val div = Div()
div.text = "Hello"
body.children.add(div)
html.body = body

// DSL 방식
html {
    body {
        div {
            +"Hello"  // unaryPlus operator
        }
    }
}
```

### Type-Safe Builder 구현

```kotlin
@DslMarker
annotation class HtmlDsl

@HtmlDsl
class Html {
    var body: Body? = null

    fun body(block: Body.() -> Unit) {
        body = Body().apply(block)
    }
}

@HtmlDsl
class Body {
    val children = mutableListOf<Element>()

    fun div(block: Div.() -> Unit) {
        children.add(Div().apply(block))
    }
}

@HtmlDsl
class Div {
    var text: String = ""

    operator fun String.unaryPlus() {
        text = this
    }
}

// 사용
fun createPage(): Html = html {
    body {
        div {
            +"Title"
        }
        div {
            +"Content"
        }
    }
}
```

### @DslMarker의 역할

```kotlin
// @DslMarker 없이
html {
    body {
        div {
            // 여기서 html의 메서드도 호출 가능! (혼란)
            body {  // 중첩 body 생성 가능
                +"Nested?"
            }
        }
    }
}

// @DslMarker로
html {
    body {
        div {
            body {}  // 컴파일 에러!
            // "Members of Html can't be called in this context"
        }
    }
}
```

### Gradle Kotlin DSL 분석

```kotlin
// build.gradle.kts
plugins {
    kotlin("jvm") version "1.9.20"
}

dependencies {
    implementation("org.jetbrains.kotlin:kotlin-stdlib")
    testImplementation("org.junit.jupiter:junit-jupiter:5.9.0")
}

// 실제로는
project.plugins {
    this.kotlin("jvm", version = "1.9.20")
}

project.dependencies {
    this.implementation("org.jetbrains.kotlin:kotlin-stdlib")
    this.testImplementation("org.junit.jupiter:junit-jupiter:5.9.0")
}
```

### 실전 DSL 예제: Spring Security

```kotlin
// 전통적인 방식
@EnableWebSecurity
class SecurityConfig : WebSecurityConfigurerAdapter() {
    override fun configure(http: HttpSecurity) {
        http
            .authorizeRequests()
            .antMatchers("/admin/**").hasRole("ADMIN")
            .antMatchers("/user/**").hasRole("USER")
            .anyRequest().authenticated()
            .and()
            .formLogin()
            .loginPage("/login")
            .permitAll()
    }
}

// Kotlin DSL
@EnableWebSecurity
class SecurityConfig {
    @Bean
    fun filterChain(http: HttpSecurity): SecurityFilterChain {
        http {
            authorizeRequests {
                authorize("/admin/**", hasRole("ADMIN"))
                authorize("/user/**", hasRole("USER"))
                authorize(anyRequest, authenticated)
            }
            formLogin {
                loginPage = "/login"
                permitAll()
            }
        }
        return http.build()
    }
}
```

### DSL 성능 고려사항
- **컴파일 타임 오버헤드**: DSL은 코드 생성이 아닌 함수 호출
- **런타임 성능**: 일반 객체 생성과 동일
- **Lambda 할당**: Inline function으로 최적화 가능

### 언제 DSL을 만들 것인가
- **반복적인 보일러플레이트**: Builder 패턴이 복잡할 때
- **계층 구조**: HTML, JSON, SQL 같은 트리 구조
- **설정 파일**: Type-safe한 설정이 필요할 때

### 관련 자료
- [Type-safe Builders 공식 문서](https://kotlinlang.org/docs/type-safe-builders.html)
- [Building DSLs in Kotlin](https://www.baeldung.com/kotlin/dsl)
- [DSL Type-safe Builders](https://kt.academy/article/fk-dsl)
- [Gradle Kotlin DSL Primer](https://docs.gradle.org/current/userguide/kotlin_dsl.html)

---

## 15. Coroutines의 Structured Concurrency 위반 사례

### 왜 가치 있는가
- **리소스 릭**: 취소되지 않는 코루틴들
- **GlobalScope 남용**: 가장 흔한 안티패턴
- **부모-자식 관계 깨짐**: 예외 전파 실패

### Structured Concurrency란?

```kotlin
// Good: Structured Concurrency
suspend fun loadData() = coroutineScope {
    val user = async { fetchUser() }
    val orders = async { fetchOrders() }

    UserData(user.await(), orders.await())
    // coroutineScope는 모든 자식이 완료될 때까지 대기
    // 하나라도 실패하면 모두 취소
}

// Bad: Unstructured
suspend fun loadData() {
    GlobalScope.launch {  // 부모와 관계 없음!
        fetchUser()
    }
    GlobalScope.launch {
        fetchOrders()
    }
    // 즉시 반환, 코루틴은 백그라운드에서 계속 실행
}
```

### GlobalScope 안티패턴

```kotlin
// 문제 상황
class UserViewModel : ViewModel() {
    fun loadUser(id: Long) {
        GlobalScope.launch {  // ViewModel이 destroy되어도 계속 실행!
            val user = repository.findById(id)
            _userState.value = user  // Crash! _userState가 이미 해제됨
        }
    }
}

// 해결
class UserViewModel : ViewModel() {
    fun loadUser(id: Long) {
        viewModelScope.launch {  // ViewModel 라이프사이클에 바인딩
            val user = repository.findById(id)
            _userState.value = user
        }
    }
}
```

### 예외 전파 문제

```kotlin
// 문제: supervisorScope에서 예외 무시
suspend fun processItems(items: List<Item>) = supervisorScope {
    items.forEach { item ->
        launch {
            process(item)  // 실패해도 다른 아이템 처리는 계속
        }
    }
}
// 문제: 모든 아이템 처리가 실패해도 함수는 성공으로 반환!

// 해결: 예외를 수집하고 보고
suspend fun processItems(items: List<Item>) = coroutineScope {
    val results = items.map { item ->
        async {
            runCatching { process(item) }
        }
    }.awaitAll()

    val failures = results.filterIsInstance<Result.Failure>()
    if (failures.isNotEmpty()) {
        throw ProcessingException("${failures.size} items failed")
    }
}
```

### 코루틴 릭 탐지

```kotlin
// Memory Leak 발생 코드
class DataProcessor {
    private val jobs = mutableListOf<Job>()

    fun process(data: Data) {
        val job = GlobalScope.launch {  // 리크!
            processData(data)
        }
        jobs.add(job)
        // jobs를 정리하는 로직이 없음!
    }
}

// 해결: CoroutineScope 사용
class DataProcessor : CoroutineScope {
    override val coroutineContext = SupervisorJob() + Dispatchers.Default

    fun process(data: Data) {
        launch {  // this CoroutineScope에서 실행
            processData(data)
        }
    }

    fun close() {
        coroutineContext.cancel()  // 모든 자식 코루틴 취소
    }
}
```

### 실전 패턴

#### 1. 병렬 처리 + 하나라도 실패하면 모두 취소
```kotlin
suspend fun loadAllData() = coroutineScope {  // coroutineScope 사용
    val user = async { fetchUser() }
    val orders = async { fetchOrders() }
    val preferences = async { fetchPreferences() }

    // 하나라도 실패하면 나머지 모두 취소
    Triple(user.await(), orders.await(), preferences.await())
}
```

#### 2. 병렬 처리 + 일부 실패해도 계속
```kotlin
suspend fun loadAllData() = supervisorScope {  // supervisorScope 사용
    val user = async { runCatching { fetchUser() } }
    val orders = async { runCatching { fetchOrders() } }

    // 각각 독립적으로 성공/실패 처리
    DataResult(
        user = user.await().getOrNull(),
        orders = orders.await().getOrElse { emptyList() }
    )
}
```

#### 3. Timeout with Structured Concurrency
```kotlin
suspend fun loadDataWithTimeout() = withTimeout(5000) {
    coroutineScope {
        val data1 = async { fetchData1() }
        val data2 = async { fetchData2() }

        Pair(data1.await(), data2.await())
        // 5초 초과 시 모든 자식 코루틴 자동 취소
    }
}
```

### Structured Concurrency 체크리스트
- ✅ 모든 코루틴은 특정 CoroutineScope 내에서 실행
- ✅ GlobalScope는 절대 사용하지 않음
- ✅ 부모 코루틴이 취소되면 자식도 취소됨
- ✅ 자식 코루틴이 실패하면 부모에게 전파 (coroutineScope)
- ✅ 리소스는 scope가 끝날 때 자동 정리

### 관련 자료
- [Coroutine Exception Handling](https://kt.academy/article/cc-exception-handling)
- [Cancellation and Timeouts](https://kotlinlang.org/docs/cancellation-and-timeouts.html)
- [Coroutines in Production](https://codezup.com/kotlin-coroutines-production-asynchronous-tasks/)

---

## 추가 블로그 주제 아이디어 (간략)

### 16. Inline Functions의 함정: crossinline과 noinline
- `inline` 함수에서 람다를 다른 함수로 전달 불가
- `crossinline`으로 non-local return 방지
- `noinline`으로 특정 람다만 인라이닝 제외

### 17. Reified Type Parameters: Reflection 없이 제네릭 다루기
- `inline fun <reified T>`의 마법
- Gson, Jackson에서 `fromJson<User>(json)` 구현
- Type erasure 우회 원리

### 18. Spring Boot + Kotlin 조합의 함정들
- All-open, No-arg 플러그인 필수
- JPA Entity는 `open class` 필요
- Data class를 Entity로 쓰면 안 되는 이유
- `lateinit var` vs `nullable var` for DI

### 19. Kotlin Collections의 숨겨진 비용
- `listOf()` vs `mutableListOf()` 내부 구현
- `toList()`, `toMutableList()` 복사 비용
- `asReversed()`, `asSequence()`는 View
- Immutable Collection이 정말 Immutable한가?

### 20. Smart Cast 실패 시나리오
- `var` 프로퍼티는 Smart Cast 안 됨
- Multi-threaded 환경에서 문제
- `val` + backing field로 해결

### 21. Kotlin의 equals/hashCode 함정
- Data class의 자동 생성 equals
- Mutable property를 Set/Map에 넣으면?
- `by lazy`를 equals에 포함시키면 안 되는 이유

### 22. Coroutines Dispatcher 선택 가이드
- `Dispatchers.IO` vs `Default` vs `Main` vs `Unconfined`
- Custom Dispatcher 만들기
- Virtual Thread (Loom) vs Coroutines

### 23. Annotation Processing 없이 코드 생성: KotlinPoet
- Reflection 대신 컴파일 타임 생성
- KSP + KotlinPoet 조합
- 실전: DTO → Builder 자동 생성

### 24. Kotlin Native 메모리 모델의 변화
- 구 메모리 모델의 문제점 (Freeze)
- 새 메모리 모델 (Kotlin 1.7.20+)
- iOS 개발자가 알아야 할 것들

### 25. Contract: 컴파일러에게 힌트 주기
- `@OptIn(ExperimentalContracts::class)`
- `contract { returns() implies (value != null) }`
- Kotlin stdlib의 `require`, `check` 분석

---

## 결론 및 우선순위

### Top 5 추천 주제 (우선 작성)

1. **Coroutines CancellationException 삼키기 버그**
   - 가장 빈번한 실수
   - 실제 장애 사례 풍부
   - Detekt 룰과 연계 가능

2. **Platform Types의 배신**
   - Kotlin의 가장 큰 약점
   - Java 상호운용성 핵심 이슈
   - 실전 NPE 사례 많음

3. **배민의 Java → Kotlin 전환 (2025년 사례)**
   - 국내 최신 사례
   - 개발자들의 높은 관심
   - Kotest, MockK 실전 경험

4. **Value Class 성능 최적화**
   - 측정 가능한 성능 차이
   - 실전 적용 가이드라인
   - Boxing 케이스 정리

5. **Flow: Cold vs Hot 제대로 이해하기**
   - 개념적으로 어려움
   - Android + 백엔드 공통
   - 메모리 릭 이슈 빈번

### 중장기 주제
- Kotlin Multiplatform 실전 (라이브러리 지원 확대 후)
- Spring Boot + WebFlux + R2DBC 조합 (성능 측정 포함)
- KAPT → KSP 마이그레이션 (실제 프로젝트 적용)

---

## 참고 자료 요약

### 공식 문서
- [Kotlin 공식 문서](https://kotlinlang.org/docs/home.html)
- [Kotlinx.coroutines 공식 문서](https://kotlinlang.org/api/kotlinx.coroutines/)
- [Android Kotlin 가이드](https://developer.android.com/kotlin)

### 국내 기술 블로그
- [배달의민족 기술 블로그](https://techblog.woowahan.com/)
- [당근마켓 기술 블로그](https://medium.com/daangn)
- [토스 기술 블로그](https://toss.tech/)
- [라인 엔지니어링 블로그](https://engineering.linecorp.com/ko/blog)
- [네이버 D2](https://d2.naver.com/helloworld)

### 해외 리소스
- [Kotlin Academy](https://kt.academy/)
- [Baeldung Kotlin](https://www.baeldung.com/kotlin/)
- [ProAndroidDev](https://proandroiddev.com/)
- [Better Programming](https://betterprogramming.pub/)

### GitHub 이슈 & 디스커션
- [Kotlin GitHub](https://github.com/JetBrains/kotlin)
- [kotlinx.coroutines GitHub](https://github.com/Kotlin/kotlinx.coroutines)
- [kotlinx.serialization GitHub](https://github.com/Kotlin/kotlinx.serialization)
- [Kotlin Discussions](https://discuss.kotlinlang.org/)

---

## 다음 단계

1. **Top 5 주제 심화 조사**
   - 각 주제별 실제 코드 예제 수집
   - 벤치마크 코드 작성
   - 오픈소스 사례 분석

2. **실험 환경 구축**
   - Kotlin 프로젝트 템플릿
   - 성능 측정 도구 (JMH, Android Profiler)
   - APM 연동 (Datadog, New Relic)

3. **블로그 시리즈 기획**
   - 매주 1개 주제 발행
   - 코드 예제 GitHub 저장소
   - 독자 피드백 반영

