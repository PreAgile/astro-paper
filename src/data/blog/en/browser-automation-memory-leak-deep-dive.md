---
author: Myeonsoo Kim
pubDatetime: 2026-01-07T15:00:00Z
title: "Debugging a Memory Leak in Browser Automation: The Perfect Storm of Three Cleanup Paths"
featured: true
draft: false
tags:
  - Node.js
  - Browser Automation
  - Memory Leak
  - Concurrency
  - Production
  - Debugging
description: "A deep dive into debugging a memory leak in a production system managing 50 concurrent Firefox browsers. The story of how Promise.race and finally blocks created a double-cleanup bug, and the journey to fix it."
---

## Table of Contents

## Introduction: One Strange Log Line

Our production server was slowing down. Memory usage crept upward steadily, until finally—OOMKilled. The pod restarted.

While digging through logs, I found this line:

```log
[Camoufox] counter(5) > sessions(3) - MISMATCH DETECTED
```

"Counter doesn't match the actual session count?"

This single log line started a 3-day debugging journey. This post documents what I learned—not to present a perfect solution, but to share **how we dug into the problem**, **what we missed**, and **why we made those choices**.

---

## 1. Context: The Problem We Had to Solve

### 1.1 Business Requirements

Our team operates a web scraping system that collects review data from multiple platforms. One platform, CPEATS, was particularly challenging:

- Single requests take 5+ minutes (hundreds of pages to paginate)
- Dynamic rendering (browser automation required)
- Anti-bot mechanisms (standard Puppeteer gets blocked)

Initially, we processed requests sequentially. But to handle 10,000+ daily requests, parallel processing became essential.

### 1.2 Technical Constraints

**Browsers consume a lot of memory.**

```
1 Firefox process = ~300MB RAM
50 concurrent = 15GB
Server memory limit = 32GB (Pod limit: 2GB × 16)
```

This led to the key question:

> **Q: How do we process as many requests as possible with limited resources?**

This is why we designed three mechanisms: Counter, Watchdog, and Lock.

---

## 2. Design: Three Core Mechanisms

### 2.1 Counter - "How many are running?"

The simplest but most important question: **"How many browsers are currently running?"**

```typescript
// browser.service.ts
private camoufoxActiveCount = 0;
private readonly MAX_CAMOUFOX = 50;

async getCamoufoxPage(sessionId: string): Promise<Page> {
  // Check limit
  if (this.camoufoxActiveCount >= this.MAX_CAMOUFOX) {
    throw new Error('Browser limit reached');
  }

  // Increment counter
  this.camoufoxActiveCount++;

  try {
    const browser = await this.launchCamoufox();
    const page = await browser.newPage();
    return page;
  } catch (error) {
    // Rollback on failure
    this.camoufoxActiveCount--;
    throw error;
  }
}
```

**Purpose**: Prevent memory overflow and ensure system stability.

Little did I know this simple counter would become the source of a major problem.

---

### 2.2 Watchdog - "Kill if it takes too long"

**Problem Scenario:**

```
Normal case: getReviews executes → 3 minutes → completes
Abnormal case: network disconnects → page loads forever → browser never closes!
```

To prevent infinite waiting, we introduced the Watchdog pattern:

```typescript
// cpeats.service.ts
async getReviews(request: GetReviewsRequest): Promise<Review[]> {
  const watchdogMs = 5 * 60 * 1000; // 5-minute timeout

  const watchdogPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new SessionQueueTimeoutException('Watchdog timeout'));
    }, watchdogMs);
  });

  // Promise.race: returns whichever finishes first
  const result = await Promise.race([
    this.actualGetReviews(request),  // Actual work
    watchdogPromise,                 // 5-minute timer
  ]);

  return result;
}
```

**Concept**: Like a "dog that barks after time passes", it forcefully terminates work after 5 minutes.

Visualized:

```
Normal flow:
T=0s ─────── actualGetReviews starts
T=180s ───── Completes ✅ (watchdog doesn't trigger)

Abnormal flow:
T=0s ─────── actualGetReviews starts
T=300s ───── Watchdog triggers! 🐕
             Force terminates work
             Closes browser
```

---

### 2.3 Lock - "Who's using it?"

Browser sessions are expensive to create, so we wanted to reuse them. But there's a problem:

```
Scenario: 2 requests try to use the same session
- Request A: Running getReviews on session-123
- Request B: Tries to run getDetail on same session-123
- Result: Page navigation conflict! ❌
```

To solve this, we added a Lock mechanism:

```typescript
// session-lock-registry.service.ts
async attach(sessionId: string): Promise<SessionHandle> {
  const state = this.locks.get(sessionId);

  if (state.activeCount > 0) {
    // Someone's using it, wait
    await this.waitForAvailability(sessionId);
  }

  // Acquire lock
  state.activeCount++;

  return {
    release: async () => {
      state.activeCount--;
    }
  };
}
```

**Concept**: Like using a bathroom. If someone's inside, you wait. When they leave, you enter and signal "I'm done" when leaving.

### 2.4 Overall System Structure

Here's how these three mechanisms work together:

![System Architecture](/src/assets/images/system-architecture.svg)

---

## 3. Operation: Stable for 3 Months

This system worked pretty well for 3 months:

```
Daily requests: 5,000~8,000
Avg concurrent browsers: 30~40
Peak time: 50 browsers
Memory usage: 18~22GB (stable)
```

Key metrics were stable too:

```typescript
// Log example (normal)
[Camoufox] counter(32) == sessions(32) ✅
[Locks] 28 locks, 32 active operations
[Memory] RSS: 19.2GB
```

But in mid-December, strange signals started appearing.

---

## 4. Observation: Strange Signals

### 4.1 First Signal: Counter Mismatch

```log
2026-01-06 14:23:15 [Camoufox] counter(5) > sessions(3) ⚠️
2026-01-06 14:45:32 [Camoufox] counter(2) < sessions(4) ⚠️
```

"Huh? Counter doesn't match actual session count?"

At first, I thought it was a logging bug. But the frequency increased.

### 4.2 Second Signal: Locks Accumulating

```log
[LockSweep] Cleaned 23 orphan locks
[LockSweep] locksSize(47) > activeOps(18) × 2 - triggering sweep
```

The code had logic to periodically clean "orphan locks". Normally it barely triggered, but now it was firing frequently.

"Why are locks accumulating? Isn't cleanup happening?"

### 4.3 Third Signal: Memory Growth

```bash
# 4-hour observation
12:00 - RSS: 18.2GB
14:00 - RSS: 19.5GB (+1.3GB)
16:00 - RSS: 21.1GB (+1.6GB)
18:00 - OOMKilled! 💥
```

Memory growing over time. Classic memory leak pattern.

---

## 5. Investigation: Digging Into Code

### 5.1 "Where does counter decrement?"

First thing I did was trace the code. Searching for `camoufoxActiveCount--`:

```typescript
// Discovery 1: Increment in getCamoufoxPage
this.camoufoxActiveCount++;  // 🔼 Line 3745

// Discovery 2: Decrement in closeSession
finally {
  this.camoufoxActiveCount--;  // 🔽 Line 1142
}

// Discovery 3: Also decrement in safeCloseSession?!
private async safeCloseSession(id: string) {
  // ...
  this.camoufoxActiveCount--;  // 🔽 Line 975
}

// Discovery 4: Also in disconnect handler?!
browser.on('disconnected', () => {
  this.safeCloseSession(id, 'exception');  // → counter--
});
```

"Wait, there are **three** paths that decrement the counter?"

| Path | Triggered When | File Location |
|------|----------------|---------------|
| closeSession | Normal close | browser.service.ts:1142 |
| safeCloseSession | Exception/force close | browser.service.ts:975 |
| disconnect handler | Browser disconnects | browser.service.ts:3928 |

**Intuition**: If there are multiple decrement paths for a single increment, there's potential for double-decrement.

Visualizing these three paths makes the problem clearer:

![Counter Decrement Paths](/src/assets/images/counter-decrement-paths.svg)

---

### 5.2 "Can double-decrement happen?" - Reproduction Attempt

I traced the scenario when watchdog timeout occurs:

```typescript
// Simplified code structure
async getCamoufoxPage(sessionId: string) {
  this.camoufoxActiveCount++;  // 1️⃣ Increment

  const watchdog = new Promise((_, reject) => {
    setTimeout(() => {
      // On timeout
      this.safeCloseSession(sessionId, 'watchdog');  // 2️⃣ Decrement
      reject(new TimeoutError());
    }, 300_000);
  });

  try {
    await Promise.race([
      actualWork(sessionId),
      watchdog,
    ]);
  } finally {
    // 3️⃣ Decrement again?!
    await this.closeSession(sessionId);  // → counter--
  }
}
```

Drawing this as a timeline made the problem clear:

```
T=0s:     getReviews starts
          ├─ counter++ (counter: 1)
          ├─ lock.attach()
          └─ Promise.race starts

T=300s:   Watchdog timeout triggers! 🔥
          ├─ timeout callback executes:
          │   ├─ safeCloseSession() called
          │   │   └─ counter-- (counter: 0) ← 1st decrement
          │   ├─ forceTerminate() called
          │   └─ reject(TimeoutError)
          │
          └─ Promise.race ends

T=300s+1ms: Finally block executes! 🚨
          ├─ closeSession() called
          │   └─ counter-- (counter: -1) ← 2nd decrement!
          └─ sessionHandle.release()
```

**Reproduction successful!**

Actually logging this showed:

```log
[Counter] Decrement: watchdog timeout, count: 4
[Counter] Decrement: finally block, count: 3  ← Double decrement!
[Counter] MISMATCH: counter(3) > sessions(4)
```

Counter didn't go negative (due to Math.max(0, count - 1)), but the mismatch occurred.

This timeline becomes much clearer with a diagram:

![Promise.race Timeline](/src/assets/images/promise-race-timeline.svg)

---

### 5.3 "Why this structure?" - Git History Investigation

This was actually the most important question. The code wasn't written this way from the start.

```bash
git log --oneline --all -- src/browser/browser.service.ts | grep -E "watchdog|close|counter"
```

Pattern discovered:

```
v1.0 (March 2024)
└─ Only simple closeSession() exists
   Browser create → use → close (linear flow)

v1.5 (July 2024)
└─ Watchdog feature added
   Reason: Infinite wait problem occurred
   Implementation: Promise.race + timeout callback

v2.0 (October 2024)
└─ Disconnect handler added
   Reason: Resources not cleaned on browser crash
   Implementation: Added browser.on('disconnected')

v2.3 (January 2025)
└─ Lock registry added
   Reason: Need session sharing in distributed environment
   Implementation: Redis-based lock system
```

**Realization**:

> This wasn't a simple bug. As the system evolved, each feature was added **independently**, and cleanup paths became separated. This was **design debt**.

---

## 6. Deep Dive: Promise.race's Fatal Trap

At this point, I asked a more fundamental question:

> **"Does Promise.race actually stop the loser?"**

### 6.1 Concept Experiment

I tested with a simple example:

```typescript
async function slowTask() {
  console.log('slowTask starts');
  await sleep(10000);
  console.log('slowTask ends'); // Will this print?
  return 'slow';
}

async function fastTask() {
  await sleep(1000);
  return 'fast';
}

const result = await Promise.race([
  slowTask(),
  fastTask(),
]);

console.log('Race result:', result);

// Output:
// slowTask starts
// Race result: fast
// slowTask ends  ← What? Still running!
```

**Key Discovery**:

> Promise.race only "returns the first result", it does **not cancel** the loser. The loser keeps running.

This is because JavaScript Promises have no cancellation mechanism.

---

### 6.2 Application to Our Code

```typescript
const result = await Promise.race([
  actualWork(),      // Browser work (takes 5 min)
  watchdogPromise,   // 5-minute timer
]);
```

When watchdog wins:
1. `watchdogPromise` rejects
2. What about `actualWork()`? → **Still running!** 🏃💨
3. The browser? → **Still open!**

So we tried to clean up like this:

```typescript
try {
  await Promise.race([...])
} catch (error) {
  if (isTimeout) {
    // Clean up in timeout callback
    await this.safeCloseSession(sessionId);  // ← cleanup #1
  }
} finally {
  // Also clean up in finally
  await this.closeSession(sessionId);  // ← cleanup #2 (duplicate!)
}
```

**Problem**:

> When watchdog timeout occurs:
> 1. catch block: safeCloseSession() → counter--
> 2. finally block: also closeSession() → counter--
>
> = **Double decrement!**

---

## 7. Solution: Idempotent Resource Management

### 7.1 Core Principle: "Clean Up Only Once"

Once I understood the problem, the solution was clear: ensure **idempotency**.

> **What is idempotency?**
> Doing the same operation multiple times has the same result as doing it once.
>
> Example: Pressing "turn off light" button 10 times = pressing it once

**Before (problematic code)**:

```typescript
// Multiple paths each decrement counter
async closeSession(id: string) {
  // ...
  this.camoufoxActiveCount--;  // ❌
}

async safeCloseSession(id: string) {
  // ...
  this.camoufoxActiveCount--;  // ❌
}
```

**After (fixed code)**:

```typescript
interface PageSession {
  // ... existing fields
  counterDecremented?: boolean;  // ✅ Add flag
}

// Single decrement function - all paths call only this
private decrementCounter(sessionId: string, reason: string): void {
  const session = this.pages.get(sessionId);
  if (!session?.isCamoufox) return;

  // Skip if already decremented
  if (session.counterDecremented) {
    this.logger.debug(`[Counter] Already decremented for ${sessionId}, skipping`);
    return;
  }

  // Set flag + decrement
  session.counterDecremented = true;
  this.camoufoxActiveCount = Math.max(0, this.camoufoxActiveCount - 1);

  this.logger.info(
    `[Counter] Decremented: ${reason}, new count: ${this.camoufoxActiveCount}`
  );
}
```

**Pattern Name**: Per-resource idempotency flag

> Attach an "already processed" flag to each resource (session), so even if called from multiple paths, it executes only once.

Now all cleanup paths call this function:

```typescript
async closeSession(id: string) {
  // ...
  this.decrementCounter(id, 'normal close');  // ✅
}

async safeCloseSession(id: string) {
  // ...
  this.decrementCounter(id, 'safe close');  // ✅
}
```

---

### 7.2 Preventing Watchdog + Finally Conflict

Fixing just the counter wasn't enough. Lock cleanup was also happening twice.

**Before**:

```typescript
try {
  await Promise.race([work(), watchdog()])
} catch (error) {
  if (isTimeout) {
    await safeCloseSession();  // cleanup #1
    await forceTerminate();
  }
} finally {
  await sessionHandle?.release();  // cleanup #2 (duplicate!)
  await dequeue();
}
```

**After**:

```typescript
let watchdogCleanupDone = false;  // ✅ Shared flag

try {
  await Promise.race([work(), watchdog()])
} catch (error) {
  if (isTimeout) {
    watchdogCleanupDone = true;  // ✅ Mark as done
    await safeCloseSession();
    await forceTerminate();
  }
} finally {
  if (!watchdogCleanupDone) {  // ✅ Check before executing
    await sessionHandle?.release();
    await dequeue();
  }
}
```

**Pattern Name**: Shared Mutable Flag Pattern

> When using Promise.race, use a shared flag to track "who cleaned up". If one side cleaned up, the other skips.

---

### 7.3 Preventing Thundering Herd

While analyzing the problem, I discovered another risk:

```typescript
// All requests have identical 5-minute timeout
private readonly getReviewsWatchdogMs = 5 * 60 * 1000;
```

**Scenario:**

```
12:00:00 - Traffic spike, 50 requests start simultaneously
12:05:00 - All 50 timeout at once! 💥
           50 browsers close simultaneously
           Memory spike → GC pause → cascading timeouts → OOM!
```

This is called the Thundering Herd Problem.

**Solution: Add Jitter**

```typescript
private getJitteredTimeout(baseMs: number): number {
  const jitter = Math.random() * 30_000;  // 0~30 second random
  return baseMs + jitter;
}

// Usage:
const watchdogMs = this.getJitteredTimeout(this.getReviewsWatchdogMs);
```

Now timeouts are distributed:

```
12:05:00~12:05:30 distributed termination ✅
└─ Load spread over 30 seconds
```

---

## 8. Results: Measurable Improvement

### 8.1 Before/After Comparison

```bash
=== Before (Problem State) ===
Counter mismatches: avg 47/30min
Lock sweeps: 12/30min
Memory growth rate: ~50MB/hour
OOMKilled: 3 times (3 days)

=== After (P0 Fix) ===
Counter mismatches: 0 ✅
Lock sweeps: 0 ✅
Memory growth rate: ~5MB/hour ✅
OOMKilled: 0 (7 days stable) ✅
```

Numerically, clear improvement. But more importantly, **trust in the system** was restored.

### 8.2 Log Changes

**Before**:

```log
[Counter] counter(5) > sessions(3) ⚠️
[Counter] counter(2) < sessions(4) ⚠️
[LockSweep] Cleaned 23 orphan locks
[Memory] RSS 21.1GB, approaching limit
[System] OOMKilled, restarting pod...
```

**After**:

```log
[Counter] counter(32) == sessions(32) ✅
[Counter] Decrement skipped: already done (session-abc-123)
[Locks] All locks aligned with active operations
[Memory] RSS 18.5GB, stable for 168 hours
```

Logs changed from "warnings" to "confirmations".

---

## 9. Lessons: What We Learned

### 9.1 Promise.race Is Not Cancellation

The biggest misconception was this:

```typescript
// ❌ Wrong understanding
await Promise.race([work(), timeout()])
// → If timeout wins, work() stops?

// ✅ Correct understanding
// → If timeout wins, the race ends,
//    but work() keeps running! (no cancellation mechanism)
```

This is a fundamental characteristic of JavaScript/Node.js. Promises cannot be cancelled.

**Alternative (long-term task)**:

```typescript
const controller = new AbortController();

const timeout = setTimeout(() => {
  controller.abort();  // Explicit cancellation signal
}, 5000);

await work({ signal: controller.signal });
```

But this requires logic inside `work()` to check the abort signal. A major refactoring, so we left it as a long-term task.

---

### 9.2 "It Should Work" Is Never Guaranteed

Implicit assumptions we made when writing code:

```typescript
// Assumption 1: "finally executes only once"
// → NO! Finally runs even after cleanup in catch

// Assumption 2: "Counter will stay in sync automatically"
// → NO! Gets misaligned when 3 paths decrement separately

// Assumption 3: "Locks will clean up automatically"
// → NO! Stays forever if cleanup path isn't called
```

**Lesson**:

> For concurrent code, don't assume—**verify**.
>
> Not "it should work this way" but "it must work this way" with proof.

---

### 9.3 Observability = Start of Debugging

We could solve all this thanks to **this single log line**:

```log
[Camoufox] counter(5) > sessions(3)
```

Without this log? We'd only know "memory is growing", and finding the cause would take weeks.

**Requirements for good logs**:

1. **Check invariants**
   - `counter == sessions.size` must hold
   - Alert immediately on mismatch

2. **Include context**
   - Where did it happen
   - Why did it happen
   - What were the values

```typescript
// Improved log
this.logger.warn(
  `[Counter] MISMATCH: counter(${this.camoufoxActiveCount}) ` +
  `${op} sessions(${this.pages.size}), ` +
  `trigger: ${trigger}, sessionId: ${sessionId}, ` +
  `stack: ${new Error().stack.split('\n')[2]}`
);
```

---

### 9.4 Incremental Complexity Breeds Debt

From Git history analysis:

> Systems don't evolve linearly. Each time a feature is added, **assumptions of the existing design break**.

```
v1.0: Perfect when only closeSession() existed
v1.5: Added watchdog → timeout callback also needs cleanup
v2.0: Added disconnect handler → another cleanup path
v2.3: Added lock registry → cleanup becomes more complex
```

At each stage, we thought "just add this", but overall system consistency gradually broke down.

**Lesson**:

> When adding features, always ask "how does this interact with existing resource management flows?"

---

## 10. Open Questions

### 10.1 Is This a Perfect Solution?

Honestly, no.

Limitations of current solution:

1. **Flags use memory**
   - Each session has `counterDecremented` flag
   - 10,000 sessions = 10,000 flags

2. **Promises still aren't cancelled**
   - `actualWork()` still runs after watchdog timeout
   - True cancellation requires AbortController + major refactoring

3. **What about distributed environments?**
   - Currently only works within single process
   - Multi-process needs shared memory

But this was **the best choice in current context**:

- Minimally invasive (keeps most existing code)
- Immediate effect (stabilized right after deployment)
- Easy to understand pattern (next engineer can maintain)

---

### 10.2 Applicable to Other Systems?

This isn't just a browser automation problem. Similar patterns appear in:

**Database connection pools**:
```typescript
// Similar structure
connectionPool.acquire()  // counter++
try {
  await query()
} finally {
  connectionPool.release()  // counter--
}
```

**File handle management**:
```typescript
const fd = fs.openSync(path)  // handle++
try {
  fs.readSync(fd)
} finally {
  fs.closeSync(fd)  // handle--
}
```

**Generalized pattern**:

```typescript
interface Resource {
  released?: boolean;
}

function release(resource: Resource, reason: string) {
  if (resource.released) {
    console.log('Already released, skipping');
    return;
  }
  resource.released = true;
  // ... actual release logic
}
```

This pattern applies to **"any system managing resource lifecycle from multiple paths"**.

---

## 11. Conclusion: Engineering Is Measurement and Understanding

Solving this problem wasn't a straight line:

```
Observe → trace → dead end → trace again →
Git history analysis → concept experiment → reproduce →
Fix → measure → discover unexpected side effects → ...
```

**If we tried to write perfect code, we would have failed.**

Instead, we:
1. Made the problem measurable (logs)
2. Understood the root cause (Promise.race + finally)
3. Applied minimally invasive fix (flags)
4. Measured the effect (0 mismatches)

And we documented it. When we face similar problems next time, or when someone else has similar concerns, I hope this record helps.

---

## References

### Projects
- [Camoufox](https://github.com/daijro/camoufox) - Python/JS anti-bot browser
- [Playwright](https://playwright.dev/) - Browser automation library

### Concepts
- [Promise.race - MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/race)
- [AbortController - MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- [Idempotence - Martin Fowler](https://martinfowler.com/bliki/Idempotence.html)
- [Thundering Herd Problem](https://en.wikipedia.org/wiki/Thundering_herd_problem)

### Books
- **Designing Data-Intensive Applications** - Martin Kleppmann
  - Chapter 8: The Trouble with Distributed Systems
- **Node.js Design Patterns** - Mario Casciaro
  - Chapter 9: Advanced Asynchronous Recipes

### Debugging Tools
- [Node.js --inspect](https://nodejs.org/en/docs/guides/debugging-getting-started/)
- [Chrome DevTools Memory Profiler](https://developer.chrome.com/docs/devtools/memory-problems/)
- [Clinic.js](https://clinicjs.org/) - Node.js performance diagnostics

---

Thank you for reading. Are you experiencing similar issues in your systems? Please share your experiences in the comments—we can learn together.
