# Fill Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fill the queue as much as possible in a single run by looping API fetches until the target is reached or a safe stop condition triggers.

**Architecture:** Add a pure decision helper in `logic.js` to determine whether the fill loop should continue, with unit tests. In `content.js`, add a `fillQueueFromApi` loop that repeatedly calls the existing `fetchMoreFromApi`, respecting a per-fill page cap and rate-limit cooldown.

**Tech Stack:** MV3 content script, Chrome extension storage, Node-based unit tests.

---

### Task 1: Add a fill-loop decision helper (TDD)

**Files:**
- Modify: `tests/logic.test.js`
- Modify: `logic.js`

**Step 1: Write the failing test**

Add a new test for `computeFillPlan`:

```js
function testFillPlan() {
  const plan1 = computeFillPlan({
    queueLength: 20,
    targetCount: 100,
    pagesFetched: 3,
    maxPages: 10,
    nextUrl: 'https://linux.do/latest.json',
    status: 200
  });
  assert.strictEqual(plan1.shouldContinue, true);

  const plan2 = computeFillPlan({
    queueLength: 100,
    targetCount: 100,
    pagesFetched: 1,
    maxPages: 10,
    nextUrl: 'https://linux.do/latest.json',
    status: 200
  });
  assert.strictEqual(plan2.shouldContinue, false);

  const plan3 = computeFillPlan({
    queueLength: 20,
    targetCount: 100,
    pagesFetched: 10,
    maxPages: 10,
    nextUrl: 'https://linux.do/latest.json',
    status: 200
  });
  assert.strictEqual(plan3.shouldContinue, false);

  const plan4 = computeFillPlan({
    queueLength: 20,
    targetCount: 100,
    pagesFetched: 1,
    maxPages: 10,
    nextUrl: null,
    status: 200
  });
  assert.strictEqual(plan4.shouldContinue, false);

  const plan5 = computeFillPlan({
    queueLength: 20,
    targetCount: 100,
    pagesFetched: 1,
    maxPages: 10,
    nextUrl: 'https://linux.do/latest.json',
    status: 429
  });
  assert.strictEqual(plan5.shouldContinue, false);
}
```

Also import `computeFillPlan` at the top and call `testFillPlan()` at the bottom.

**Step 2: Run test to verify it fails**

Run: `node tests/logic.test.js`

Expected: FAIL with `computeFillPlan is not a function`.

**Step 3: Write minimal implementation**

In `logic.js`, add and export:

```js
function computeFillPlan({ queueLength, targetCount, pagesFetched, maxPages, nextUrl, status }) {
  const hasCapacity = Number.isFinite(targetCount)
    ? queueLength < targetCount
    : true;
  const underMax = Number.isFinite(maxPages)
    ? pagesFetched < maxPages
    : true;
  const ok = status === 200;
  const hasNext = Boolean(nextUrl);
  return { shouldContinue: hasCapacity && underMax && ok && hasNext };
}
```

Add to exports at the bottom.

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`

Expected: PASS and `logic tests passed`.

**Step 5: Commit**

```bash
git add tests/logic.test.js logic.js
git commit -m "feat: add fill loop decision helper"
```

---

### Task 2: Implement fill loop in content script (use helper)

**Files:**
- Modify: `content.js`

**Step 1: Add failing test for helper usage**

No new test here; rely on Task 1 helper tests and keep changes minimal and isolated.

**Step 2: Implement minimal fill loop**

Add a per-fill page cap constant near defaults, e.g.:

```js
const FILL_MAX_PAGES = LOGIC && LOGIC.FILL_DEFAULTS ? LOGIC.FILL_DEFAULTS.maxPages : 50;
```

Add a new async function near `fetchMoreFromApi`:

```js
async function fillQueueFromApi(runId) {
  const isActive = () => currentState.running && currentState.runId === runId && isOwnerSelf();
  let pagesFetched = 0;
  let status = 200;

  while (isActive()) {
    const targetCount = getTargetCount();
    const queueLength = currentState.queue ? currentState.queue.length : 0;
    const nextUrl = currentState.nextApiUrl ? ensureJsonApiUrl(currentState.nextApiUrl) : null;
    const plan = computeFillPlanState({
      queueLength,
      targetCount,
      pagesFetched,
      maxPages: FILL_MAX_PAGES,
      nextUrl,
      status
    });
    if (!plan.shouldContinue) break;

    const result = await fetchMoreFromApi(runId);
    if (!result) break;
    pagesFetched += Number.isFinite(result.pagesFetched) ? result.pagesFetched : 0;
    status = Number.isFinite(result.status) ? result.status : status;
    if (status !== 200) break;
  }
}
```

Update `fetchMoreFromApi` to include `pagesFetched` and `status` in its return object:

```js
return { added: fetchedCount, status, pagesFetched };
```

Then update `runLoop` so the first fill attempt uses `fillQueueFromApi` instead of a single `maybeFetchMore` call when `queueBuilding` or queue is empty:

- In the `queueBuilding` branch, call `await fillQueueFromApi(runId)` before falling back to DOM build.
- In the “queue empty” branch, call `await fillQueueFromApi(runId)` before falling back to DOM build.

Keep the existing `maybeFetchMore` logic for low-water top-ups during normal running.

**Step 3: Run tests**

Run: `node tests/logic.test.js`

Expected: PASS.

**Step 4: Commit**

```bash
git add content.js
git commit -m "feat: fill queue with multi-page api loop"
```

---

### Task 3: Quick sanity check (manual)

**Files:**
- N/A

**Step 1: Manual check**

Load the extension and observe logs:
- Start the script on `https://linux.do/latest`
- Confirm logs show multiple `fetchMoreFromApi` calls until the queue approaches target

**Step 2: Commit (if any changes were required)**

Only if any follow-up tweaks were necessary:

```bash
git add content.js

git commit -m "fix: adjust fill loop stop conditions"
```
