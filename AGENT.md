# AGENT.md
> Forward Engineering Blog - Technical Writing Guide

---

## Project Overview

**Forward Engineering Blog** - Astro Paper 기반 기술 블로그

```
Tech Stack:
├── Framework: Astro 5.x
├── Styling: TailwindCSS v4 + Typography plugin
├── Language: TypeScript
├── Search: Pagefind
├── Package Manager: bun (preferred) / pnpm
└── i18n: Korean (default) / English
```

### Commands

```bash
bun run dev      # 개발 서버 시작
bun run build    # 프로덕션 빌드
bun run preview  # 빌드 미리보기
bun run format   # 코드 포맷팅
bun run lint     # 린트 검사
```

### Git Workflow

**커밋 메시지는 항상 한글로 작성**

```bash
# 좋은 예
git commit -m "feat: 목차 컴포넌트 추가 및 블로그 콘텐츠 개선"
git commit -m "fix: Vite watch 중복 이벤트 방지 설정 추가"
git commit -m "chore: 패키지 매니저를 bun으로 마이그레이션"

# 나쁜 예
git commit -m "feat: add TableOfContents component"
git commit -m "fix: prevent duplicate watch events"
```

**커밋 메시지 구조:**
- `feat:` 새로운 기능 추가
- `fix:` 버그 수정
- `chore:` 빌드/설정 변경
- `docs:` 문서 수정
- `refactor:` 코드 리팩토링
- `style:` 코드 포맷팅
- `test:` 테스트 추가/수정

### Directory Structure

```
src/
├── components/     # Reusable Astro components
├── layouts/        # Page layouts
├── pages/          # Route pages
│   ├── *.astro     # Korean pages (default locale)
│   └── en/         # English pages
├── data/blog/      # Blog posts (Markdown)
│   ├── ko/         # Korean posts
│   └── en/         # English posts
├── i18n/           # Internationalization
├── styles/         # Global styles, typography
├── utils/          # Helper functions
└── assets/         # Images, icons
```

---

## Writing Philosophy | 글쓰기 철학

### 핵심

**"엔지니어링은 선택에 대한 설명이다"**

이 블로그는 무엇을 만들었는지가 아니라 **왜 그렇게 선택했는지**를 기록합니다.

---

### 톤과 태도

**독자를 동료 엔지니어로 대한다**
- 가르치려 들지 않는다
- 함께 고민을 나누는 톤
- "~입니다"보다 "~했습니다", "~겪었습니다"처럼 경험을 공유하는 어투

**거리감을 줄인다**
- 막연한 질문이나 어려움을 먼저 인정한다
- 자조적인 표현도 괜찮다 ("우물 안 개구리였다", "손 안 대고 코 푸는 격이었다")
- 완벽한 전문가가 아니라 같이 배워가는 사람으로 다가간다

**겸손하되 깊이 있게**
- "완벽한 답"을 주장하지 않는다
- "이 맥락에서는 이 선택이 합리적이었다"를 설명한다
- 틀렸던 가정, 예상과 다른 결과도 솔직히 공유한다

---

### 깊이와 구체성

**표면이 아닌 근본을 파고든다**
- "이렇게 쓰면 됩니다" (X)
- "왜 이렇게 설계되었는지, 어떤 트레이드오프가 있는지" (O)
- 공식 문서, 소스코드를 직접 확인하고 인용한다

**추상적 개념을 구체적 사례로 설명한다**
- "성능이 중요하다" (X)
- "배달앱에서 주문 피크 시간에 P99 레이턴시가 3초를 넘으면..." (O)
- 독자가 자신의 상황에 대입해볼 수 있는 예시를 든다

**추측이 아닌 측정으로 말한다**
- 주장에는 데이터가 뒷받침되어야 한다
- 프로파일링 결과, 벤치마크, 실제 운영 수치
- "빠르다/느리다"가 아니라 "P99 45ms → 38ms"

---

### 맥락의 존중

**같은 기술도 상황에 따라 답이 다르다**
- 팀 규모, 서비스 트래픽, 운영 역량에 따라 선택이 달라진다
- 독자가 "우리 상황에 적용 가능한가?" 판단할 수 있도록 맥락을 명시한다
- 외부 사례를 인용할 때는 우리와의 차이점을 함께 언급한다

---

### 피해야 할 것

- 단순 튜토리얼 ("설치하고 실행하면 끝")
- 근거 없는 주장 ("이게 더 좋습니다")
- 맥락 없는 벤치마크 ("A가 B보다 10배 빠름")
- 완벽주의적 톤 ("이것이 정답입니다")

### 지향해야 할 것

- 실제 프로덕션 경험 기반의 인사이트
- "왜 선택하지 않았는가"에 대한 설명
- 측정 가능한 결과와 구체적인 수치
- 다음 엔지니어가 참고할 수 있는 의사결정 기록
- 희망과 영감을 주는 마무리

---

## Content Structure | 콘텐츠 구조

### 기술 문서에 포함되어야 할 것

1. **맥락 (Context)** — 서비스 규모, 팀 구성, 제약사항. 왜 이 문제를 풀어야 했는지.

2. **문제 정의 (Problem)** — 증상이 아닌 구조적 문제. 비즈니스에 미친 영향.

3. **탐색 과정 (Exploration)** — 검토한 대안들, 선택하지 않은 이유, 외부 사례와의 차이점.

4. **결정과 트레이드오프 (Decision)** — 최종 선택과 그 이유. 이 선택으로 포기한 것들.

5. **결과 (Outcome)** — 정량/정성 지표. 예상과 달랐던 점.

6. **참고자료 (References)** — 공식 문서 우선. 모든 핵심 주장에 출처.

---

## Architecture Diagrams

**Excalidraw 사용 권장**

- 손그림 스타일로 "완성된 문서" 부담 감소
- 빠른 수정과 반복 가능
- SVG/PNG로 내보내서 `src/assets/images/`에 저장

```markdown
![Architecture](/assets/images/architecture.svg)
```

---

## Bilingual Posts

한국어와 영어 버전을 각각 작성:

```
src/data/blog/
├── ko/
│   └── my-post.md    # 한국어
└── en/
    └── my-post.md    # English
```

### Frontmatter

```yaml
---
author: 김면수
pubDatetime: 2024-01-15T10:00:00Z
title: "제목"
slug: my-post-slug
featured: true
draft: false
tags:
  - Backend
  - Kotlin
description: |
  한두 문장으로 핵심 내용 요약
---
```

---

## References | 참고자료 원칙

1. 모든 핵심 주장에는 출처를 남긴다
2. 공식 문서를 1순위로 사용한다
3. 기술 블로그는 보조 근거로 활용한다

**자주 참고하는 소스:**
- 공식 문서 (Kotlin, JVM, Framework docs)
- GitHub 소스코드 직접 확인
- Netflix/Uber/배민/네이버 기술 블로그
- 서적 (Effective Java, DDIA 등)
