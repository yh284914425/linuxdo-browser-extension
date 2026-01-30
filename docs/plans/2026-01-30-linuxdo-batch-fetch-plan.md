# Linuxdo Batch Fetch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add low-frequency, batched queue fetching (max 150 per batch) with cooldown, jitter, and 429 backoff to avoid CF rate limits while streaming queue growth.

**Architecture:** Add pure helpers in `logic.js` for batch planning/backoff scheduling and test them. `content.js` keeps state for batch fetching and uses the helpers to decide when/what to fetch, appending results to the queue while browsing continues. API fetch remains timeout-protected and will fallback to DOM when needed.

**Tech Stack:** Vanilla JS (MV3 content scripts), Node for unit tests.

---

### Task 1: Add batch/backoff helpers + tests

**Files:**
- Modify: `tests/logic.test.js`
- Modify: `logic.js`

**Step 1: Write the failing test**

Append to `tests/logic.test.js` and extend imports:

```js
const {
  DEFAULTS,
  sanitizeTargetCount,
  shouldStopWhenQueueEmpty,
  buildRestartPatch,
  buildStartPatch,
  isOwnerActive,
  pruneHistory,
  addHistoryEntry,
  historyToSet,
  computeNextFetchAt,
  shouldFetchMore,
  computeBatchPlan
} = require('../logic');

function testBatchBackoffHelpers() {
  const now = 10000;
  assert.strictEqual(computeNextFetchAt({ now, status: 429, backoffCount: 0 }).nextFetchAt, now + 30000);
  assert.strictEqual(computeNextFetchAt({ now, status: 429, backoffCount: 1 }).nextFetchAt, now + 60000);
  assert.strictEqual(computeNextFetchAt({ now, status: 200, backoffCount: 2 }).nextFetchAt <= now + 5000, true);

  assert.strictEqual(shouldFetchMore({ remaining: 20, lowWater: 30, fetching: false, now, nextFetchAt: now }), true);
  assert.strictEqual(shouldFetchMore({ remaining: 40, lowWater: 30, fetching: false, now, nextFetchAt: now }), false);
  assert.strictEqual(shouldFetchMore({ remaining: 20, lowWater: 30, fetching: true, now, nextFetchAt: now }), false);
  assert.strictEqual(shouldFetchMore({ remaining: 20, lowWater: 30, fetching: false, now, nextFetchAt: now + 1000 }), false);

  const plan = computeBatchPlan({ batchSize: 150, maxPages: 3, pagesFetched: 1, fetchedCount: 70 });
  assert.strictEqual(plan.shouldContinue, true);
  assert.strictEqual(plan.nextPagesFetched, 2);
}

// add new call near the bottom
testBatchBackoffHelpers();
```

**Step 2: Run test to verify it fails**

Run: `node tests/logic.test.js`
Expected: FAIL with `computeNextFetchAt is not a function` (or similar)

**Step 3: Write minimal implementation**

Add to `logic.js`:

```js
const BATCH_DEFAULTS = {
  batchSize: 150,
  lowWater: 30,
  maxPages: 3,
  jitterMs: [2000, 5000],
  backoffBaseMs: 30000,
  backoffMaxMs: 10 * 60 * 1000
};

function computeNextFetchAt({ now, status, backoffCount, jitterMs } = {}) {
  const ts = Number.isFinite(now) ? now : Date.now();
  if (status === 429) {
    const count = Number.isFinite(backoffCount) ? backoffCount : 0;
    const delay = Math.min(BATCH_DEFAULTS.backoffBaseMs * Math.pow(2, count), BATCH_DEFAULTS.backoffMaxMs);
    return { nextFetchAt: ts + delay, backoffCount: count + 1 };
  }
  const jitter = Array.isArray(jitterMs) ? jitterMs : BATCH_DEFAULTS.jitterMs;
  const min = Number.isFinite(jitter[0]) ? jitter[0] : 2000;
  const max = Number.isFinite(jitter[1]) ? jitter[1] : 5000;
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return { nextFetchAt: ts + delay, backoffCount: 0 };
}

function shouldFetchMore({ remaining, lowWater, fetching, now, nextFetchAt }) {
  if (fetching) return false;
  const limit = Number.isFinite(lowWater) ? lowWater : BATCH_DEFAULTS.lowWater;
  if (!Number.isFinite(remaining) || remaining >= limit) return false;
  const ts = Number.isFinite(now) ? now : Date.now();
  const next = Number.isFinite(nextFetchAt) ? nextFetchAt : 0;
  return ts >= next;
}

function computeBatchPlan({ batchSize, maxPages, pagesFetched, fetchedCount }) {
  const target = Number.isFinite(batchSize) ? batchSize : BATCH_DEFAULTS.batchSize;
  const max = Number.isFinite(maxPages) ? maxPages : BATCH_DEFAULTS.maxPages;
  const pages = Number.isFinite(pagesFetched) ? pagesFetched : 0;
  const count = Number.isFinite(fetchedCount) ? fetchedCount : 0;
  const shouldContinue = count < target && pages < max;
  return { shouldContinue, nextPagesFetched: pages + 1 };
}
```

Export in `logic.js` return block:

```js
    BATCH_DEFAULTS,
    computeNextFetchAt,
    shouldFetchMore,
    computeBatchPlan,
```

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`
Expected: PASS and prints `logic tests passed`

**Step 5: Commit**

Skip (not requested).

---

### Task 2: Wire batch fetching in content script (queue streaming)

**Files:**
- Modify: `content.js`

**Step 1: Write the failing test**

Not applicable (content-script wiring). Use manual verification.

**Step 2: Write minimal implementation**

Add batch state to `DEFAULT_STATE`:
- `batchSize`, `lowWater`, `maxPages`, `nextApiUrl`, `fetching`, `lastFetchAt`, `nextFetchAt`, `backoffCount`, `totalQueued`.

Add helpers using `logic.js`:
- `shouldFetchMore()` using `LOGIC.shouldFetchMore` fallback.
- `computeNextFetchAt()` using `LOGIC.computeNextFetchAt` fallback.
- `computeBatchPlan()` using `LOGIC.computeBatchPlan` fallback.

Modify `buildQueueFromApi` into `fetchMoreFromApi`:
- Use `nextApiUrl` as start; fetch at most `maxPages` and until `batchSize` reached.
- Filter by history, append to existing queue (avoid duplicates).
- Update `nextApiUrl`, `lastFetchAt`, `nextFetchAt` on success.
- On 429, set backoff via `computeNextFetchAt` and keep `nextApiUrl` for retry.

Trigger batch fetch:
- Inside `runLoop` before navigation or after index increment, call `maybeFetchMore()` that checks `shouldFetchMore` with remaining count and schedules `fetchMoreFromApi`.
- Ensure `fetching` prevents concurrent fetches.

Update DOM fallback:
- If API fails/429 and no queue entries, call `buildQueueFromDom` to seed initial queue.

**Step 3: Manual verification**

1. Set target 300, start. Observe initial batch 150, browsing starts.
2. When remaining < 30, verify second batch appends without stopping.
3. Simulate 429 (temporarily block requests) → observe backoff and no repeated hits.
4. Ensure queue doesn’t include already visited items.

**Step 4: Commit**

Skip (not requested).

---

### Task 3: Adjust target limit UI (optional, if requested)

**Files:**
- Modify: `logic.js`
- Modify: `content.js`

**Step 1: Write the failing test**

If limiting to 150 total, add a unit test for `sanitizeTargetCount` max.

**Step 2: Implement**

Set `DEFAULTS.maxTarget = 150` and update input `max` via existing logic.

**Step 3: Verify**

Run: `node tests/logic.test.js` and manual check input range.

**Step 4: Commit**

Skip (not requested).
