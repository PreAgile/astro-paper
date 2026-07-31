---
layout: ../layouts/AboutLayout.astro
title: "김면수 — Backend Engineer"
description: "운영 문제를 코드·실험·실패 trace로 검증하고 공개 설계 기록으로 남기는 백엔드 엔지니어 김면수의 프로필입니다."
---

저는 운영에서 발생한 문제를 코드와 측정으로 좁히고, 그 과정에서 내린 선택을 다른 개발자가 검증할 수 있는 기록으로 남기는 백엔드 엔지니어 **김면수(Myeonsoo Kim)**입니다.

이 블로그의 원칙은 **“엔지니어링은 선택에 대한 설명이다”**입니다. 기술 사용법을 다시 요약하기보다 다음 내용을 기록합니다.

- 처음 세웠지만 틀렸던 가정
- 구현과 명세를 깨뜨린 반례
- 선택하지 않은 대안과 트레이드오프
- 재현 가능한 테스트·측정 환경
- 실제 PR, issue, commit과 소스 코드
- 현재 결과가 증명하지 못하는 범위

## 현재 집중하는 문제

- 평판을 가진 프록시·계정·세션의 안전한 선택과 lease
- Java 동시성 계약과 선형화 가능성 검증
- JDK-only core와 SaaS host 사이의 아키텍처 경계
- 멀티테넌트 격리, noisy neighbor와 수평 확장
- 스크래핑 시스템의 운영 신뢰성과 관측성

## 공개 프로젝트

- [PreAgile/reputation-pool](https://github.com/PreAgile/reputation-pool) — JDK-only 평판 판단 및 resource lease 엔진
- [PreAgile/reputation-pool-cloud](https://github.com/PreAgile/reputation-pool-cloud) — 공개 엔진을 사용하는 hosted SaaS
- [reputation-pool 설계 기록](/series/reputation-pool/) — 구현·실패·재설계 과정을 연결한 시리즈

## 글을 신뢰하는 방법

각 deep-dive 글은 가능한 경우 검증 대상 version, 실행 환경, PR, 실패 trace와 한계를 함께 제공합니다. 운영 데이터가 아직 없다면 추측을 수치처럼 쓰지 않고 **아직 측정하지 않았음**을 명시합니다.

## 연결

- [GitHub](https://github.com/PreAgile)
- [한국어 RSS](/rss.xml)
- [English RSS](/en/rss.xml)
