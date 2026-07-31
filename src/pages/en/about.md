---
layout: ../../layouts/AboutLayout.astro
title: "Myeonsoo Kim — Backend Engineer"
description: "Backend engineer documenting production problems through code, experiments, failure traces, and verifiable architecture decisions."
---

I am **Myeonsoo Kim (김면수)**, a backend engineer who narrows production problems through code and measurement, then publishes the decisions as records other engineers can verify.

The principle of this blog is: **engineering is the explanation of choices**. Instead of restating generic tutorials, I document:

- assumptions that turned out to be wrong,
- counterexamples that broke an implementation or specification,
- rejected alternatives and their trade-offs,
- reproducible test and measurement environments,
- the real PRs, issues, commits, and source code,
- and the boundary of what the evidence does not prove.

## Current focus

- safe selection and leasing of reputation-bearing proxies, accounts, and sessions,
- Java concurrency contracts and linearizability testing,
- the boundary between a JDK-only core and a SaaS host,
- multi-tenant isolation, noisy-neighbor control, and horizontal scaling,
- and operational reliability for scraping systems.

## Public projects

- [PreAgile/reputation-pool](https://github.com/PreAgile/reputation-pool) — a JDK-only reputation decision and resource-leasing engine
- [PreAgile/reputation-pool-cloud](https://github.com/PreAgile/reputation-pool-cloud) — a hosted SaaS built on the public engine
- [Building reputation-pool](/en/series/reputation-pool/) — the connected series of implementation failures and redesigns

## How to evaluate these articles

Each deep dive includes the tested version, environment, PR, failure trace, and limitations whenever the evidence exists. When production data is not available yet, I say **not measured yet** instead of presenting a hypothesis as a number.

## Connect

- [GitHub](https://github.com/PreAgile)
- [Korean RSS](/rss.xml)
- [English RSS](/en/rss.xml)
