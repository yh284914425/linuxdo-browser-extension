# Linuxdo Auto Browse Controls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix run loop stop issues and add a target-count input plus restart button.

**Architecture:** Add a small `logic.js` module with pure functions used by `content.js`, then wire UI and state changes in the content script. Load `logic.js` first in `manifest.json`.

**Tech Stack:** Vanilla JavaScript (MV3 content scripts), Node for simple tests.

---

### Task 1: Add failing tests for logic helpers

**Files:**
- Create: `tests/logic.test.js`

**Step 1: Write the failing test**

```js
const assert = require('assert');
const {
  DEFAULTS,
  sanitizeTargetCount,
  shouldStopWhenQueueEmpty,
  buildRestartPatch,
  buildStartPatch
} = require('../logic');

function testSanitizeTargetCount() {
  assert.strictEqual(sanitizeTargetCount('abc', DEFAULTS), DEFAULTS.defaultTarget);
  assert.strictEqual(sanitizeTargetCount(0, DEFAULTS), DEFAULTS.minTarget);
  assert.strictEqual(sanitizeTargetCount(99999, DEFAULTS), DEFAULTS.maxTarget);
  assert.strictEqual(sanitizeTargetCount('123', DEFAULTS), 123);
}

function testQueueEmptyStop() {
  assert.strictEqual(shouldStopWhenQueueEmpty({ queueBuilding: true }), false);
  assert.strictEqual(shouldStopWhenQueueEmpty({ queueBuilding: false }), true);
}

function testRunIdPatches() {
  const state = { runId: 1 };
  assert.deepStrictEqual(buildStartPatch(state), { running: true, runId: 2 });
  assert.deepStrictEqual(buildRestartPatch(state), {
    running: true,
    queue: [],
    index: 0,
    queueBuilding: true,
    runId: 2
  });
}

testSanitizeTargetCount();
testQueueEmptyStop();
testRunIdPatches();
console.log('logic tests passed');
```

**Step 2: Run test to verify it fails**

Run: `node tests/logic.test.js`
Expected: FAIL with module not found (logic.js missing)

**Step 3: Write minimal implementation**

Create `logic.js` in Task 2.

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`
Expected: PASS and prints `logic tests passed`

**Step 5: Commit**

Skip: no git repo / not requested.

---

### Task 2: Implement logic.js

**Files:**
- Create: `logic.js`

**Step 1: Write the failing test**

Already done in Task 1.

**Step 2: Run test to verify it fails**

Run: `node tests/logic.test.js`
Expected: FAIL (module not found)

**Step 3: Write minimal implementation**

```js
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.LinuxdoLogic = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULTS = {
    minTarget: 1,
    maxTarget: 1000,
    defaultTarget: 1000
  };

  function sanitizeTargetCount(value, defaults = DEFAULTS) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return defaults.defaultTarget;
    }
    if (parsed < defaults.minTarget) return defaults.minTarget;
    if (parsed > defaults.maxTarget) return defaults.maxTarget;
    return parsed;
  }

  function shouldStopWhenQueueEmpty(state) {
    return !state.queueBuilding;
  }

  function nextRunId(current) {
    const base = Number.isFinite(current) ? current : 0;
    return base + 1;
  }

  function buildStartPatch(state) {
    return {
      running: true,
      runId: nextRunId(state.runId)
    };
  }

  function buildRestartPatch(state) {
    return {
      running: true,
      queue: [],
      index: 0,
      queueBuilding: true,
      runId: nextRunId(state.runId)
    };
  }

  return {
    DEFAULTS,
    sanitizeTargetCount,
    shouldStopWhenQueueEmpty,
    buildStartPatch,
    buildRestartPatch
  };
});
```

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`
Expected: PASS and prints `logic tests passed`

**Step 5: Commit**

Skip: no git repo / not requested.

---

### Task 3: Wire logic.js and update content script

**Files:**
- Modify: `manifest.json`
- Modify: `content.js`

**Step 1: Write the failing test**

Not applicable (behavioral wiring).

**Step 2: Run test to verify it fails**

Not applicable.

**Step 3: Write minimal implementation**

- Load `logic.js` before `content.js` in `manifest.json` content_scripts.
- Add `targetCount` and `runId` to default state in `content.js`.
- Use `LinuxdoLogic.sanitizeTargetCount` to compute target count.
- Add UI elements: target input and restart button; wire events.
- Update `runLoop` to:
  - Capture `runId` and check `running` + `runId` after each await.
  - When queue is empty and `queueBuilding` is true, do not stop.
- Update pause behavior to check `running` before navigation.

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`
Expected: PASS (logic tests still green)

**Step 5: Commit**

Skip: no git repo / not requested.

---

### Task 4: Update panel styles

**Files:**
- Modify: `style.css`

**Step 1: Write the failing test**

Not applicable.

**Step 2: Run test to verify it fails**

Not applicable.

**Step 3: Write minimal implementation**

Add styles for numeric input and restart button layout.

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`
Expected: PASS

**Step 5: Commit**

Skip: no git repo / not requested.

---

### Task 5: Update README

**Files:**
- Modify: `README.md`

**Step 1: Write the failing test**

Not applicable.

**Step 2: Run test to verify it fails**

Not applicable.

**Step 3: Write minimal implementation**

- Update default target count and delay range.
- Mention the new target count input and restart button.

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`
Expected: PASS

**Step 5: Commit**

Skip: no git repo / not requested.
