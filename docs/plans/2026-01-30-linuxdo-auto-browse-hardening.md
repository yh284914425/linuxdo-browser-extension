# Linuxdo Auto Browse Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce single-tab ownership, make target-count changes take effect immediately, and persist de-dup history to avoid repeat browsing on restart.

**Architecture:** Extend `logic.js` with pure helpers for ownership TTL and history pruning/updates; wire `content.js` to claim/release ownership with heartbeat, filter queues by history, restart runs on target changes, and guard fetch with timeouts. State is persisted via `chrome.storage.local`.

**Tech Stack:** Vanilla JS (MV3 content scripts), Node for unit tests.

---

### Task 1: Add logic helpers + tests (ownership + history)

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
  historyToSet
} = require('../logic');

function testOwnerActive() {
  const now = 10_000;
  assert.strictEqual(isOwnerActive('a', now - 1000, { now, ttlMs: 5000 }), true);
  assert.strictEqual(isOwnerActive('a', now - 6000, { now, ttlMs: 5000 }), false);
  assert.strictEqual(isOwnerActive(null, now - 1000, { now, ttlMs: 5000 }), false);
}

function testHistoryHelpers() {
  const now = 20_000;
  const entries = [
    { id: 1, ts: now - 1000 },
    { id: 2, ts: now - 40_000 }
  ];
  const pruned = pruneHistory(entries, { now, ttlMs: 30_000, maxEntries: 10 });
  assert.deepStrictEqual(pruned.map((e) => e.id), [1]);

  const added = addHistoryEntry(pruned, 3, { now: now + 1000, ttlMs: 30_000, maxEntries: 2 });
  assert.deepStrictEqual(added.map((e) => e.id), [3, 1]);

  const deduped = addHistoryEntry(added, 1, { now: now + 2000, ttlMs: 30_000, maxEntries: 5 });
  assert.deepStrictEqual(deduped.map((e) => e.id), [1, 3]);

  const set = historyToSet(deduped);
  assert.strictEqual(set.has(1), true);
  assert.strictEqual(set.has(3), true);
}

// add new calls near the bottom
testOwnerActive();
testHistoryHelpers();
```

**Step 2: Run test to verify it fails**

Run: `node tests/logic.test.js`
Expected: FAIL with `isOwnerActive is not a function` (or similar)

**Step 3: Write minimal implementation**

Add to `logic.js` (below DEFAULTS):

```js
const OWNER_DEFAULTS = {
  ttlMs: 15_000
};

const HISTORY_DEFAULTS = {
  maxEntries: 3000,
  ttlMs: 30 * 24 * 60 * 60 * 1000
};

function isOwnerActive(ownerId, heartbeat, options = {}) {
  if (!ownerId || !Number.isFinite(heartbeat)) return false;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : OWNER_DEFAULTS.ttlMs;
  return now - heartbeat <= ttlMs;
}

function pruneHistory(entries, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : HISTORY_DEFAULTS.ttlMs;
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : HISTORY_DEFAULTS.maxEntries;
  const safe = Array.isArray(entries) ? entries : [];
  const filtered = safe.filter((entry) => {
    return entry && Number.isFinite(entry.id) && Number.isFinite(entry.ts) && now - entry.ts <= ttlMs;
  });
  filtered.sort((a, b) => b.ts - a.ts);
  return filtered.slice(0, maxEntries);
}

function addHistoryEntry(entries, id, options = {}) {
  if (!Number.isFinite(id)) return pruneHistory(entries, options);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const safe = Array.isArray(entries) ? entries : [];
  const next = [{ id, ts: now }, ...safe.filter((entry) => entry && entry.id !== id)];
  return pruneHistory(next, { ...options, now });
}

function historyToSet(entries) {
  const safe = Array.isArray(entries) ? entries : [];
  const ids = safe.map((entry) => entry && entry.id).filter(Number.isFinite);
  return new Set(ids);
}
```

Export in the return block:

```js
  return {
    DEFAULTS,
    OWNER_DEFAULTS,
    HISTORY_DEFAULTS,
    sanitizeTargetCount,
    shouldStopWhenQueueEmpty,
    buildStartPatch,
    buildRestartPatch,
    isOwnerActive,
    pruneHistory,
    addHistoryEntry,
    historyToSet
  };
```

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`
Expected: PASS and prints `logic tests passed`

**Step 5: Commit**

Skip (not requested).

---

### Task 2: Enforce single-tab ownership + heartbeat

**Files:**
- Modify: `content.js`

**Step 1: Write the failing test**

Not applicable (content-script wiring). Covered by Task 1 unit tests.

**Step 2: Run test to verify it fails**

Not applicable.

**Step 3: Write minimal implementation**

Add constants and state:
- Add `OWNER_TTL_MS`, `HEARTBEAT_INTERVAL_MS`, `INSTANCE_ID` (use `crypto.randomUUID()` with fallback).
- Extend `DEFAULT_STATE` with `ownerId: null` and `ownerHeartbeat: 0`.

Add helpers:
- `isOwnerActive()` using `LOGIC.isOwnerActive` fallback.
- `isOwner()` check for `currentState.ownerId === INSTANCE_ID`.
- `claimOwnership()` set `ownerId` + `ownerHeartbeat` if no active owner or owner is self.
- `releaseOwnership()` clears owner fields if self.
- `startHeartbeat()`/`stopHeartbeat()` interval that updates `ownerHeartbeat` while owner.

Wire start/restart buttons:
- Before starting, call `claimOwnership()`; if false, just `updatePanel()` and return.
- When pausing, call `setState({ running: false, queueBuilding: false })` then `releaseOwnership()` and `stopHeartbeat()`.

Update `runLoop` active check:
- `isActive` must require `currentState.running`, `runId` match, and `isOwner()`.

Update `resumeIfNeeded`:
- If `currentState.running` and no active owner, auto-claim and start heartbeat.

Update `updatePanel` UI state:
- If running and owner active but not `isOwner()`, show status `其他标签运行` and disable start/restart/target input.

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`
Expected: PASS

**Step 5: Manual verification**

1. Load extension, open two `linux.do` tabs.
2. Start in tab A → should run.
3. Tab B should show `其他标签运行` and controls disabled.
4. Pause in tab A → tab B can start.

**Step 6: Commit**

Skip (not requested).

---

### Task 3: History de-dup + immediate target effect + fetch timeout

**Files:**
- Modify: `content.js`
- (Optional) Modify: `README.md`

**Step 1: Write the failing test**

Not applicable (content-script wiring). Covered by Task 1 unit tests for history helpers.

**Step 2: Run test to verify it fails**

Not applicable.

**Step 3: Write minimal implementation**

History + queue filtering:
- Add constants `HISTORY_MAX`, `HISTORY_TTL_MS` (match `logic.js` defaults).
- Add `history` to `DEFAULT_STATE` (array of `{ id, ts }`).
- Add helper `extractTopicId(url)` that returns numeric id from `/t/<slug>/<id>`.
- Add helper `getPrunedHistory()` using `LOGIC.pruneHistory` fallback; on load, prune and persist if changed.
- Build a `historySet` via `LOGIC.historyToSet` and skip visited ids in `buildQueueFromApi` and `buildQueueFromDom`.

Record visits:
- After delay/scroll, before incrementing index, add visited id with `LOGIC.addHistoryEntry` and include `history` in the same `setState` that increments `index`.

Immediate target effect:
- In `commitTarget`, after setting `targetCount`, if running then restart run (increment runId, clear queue, set `queueBuilding: true`) and call `runLoop()`.
- If not running and queue exists, shrink queue when target decreases; clear queue when target increases so next start rebuilds with the new target.

Fetch timeout:
- Add `fetchWithTimeout(url, options, timeoutMs)` using `AbortController`.
- Use it inside `buildQueueFromApi` and return `null` on timeout or JSON parse errors.

Guard stale queue builds:
- In `buildQueueFromDom`, capture `const buildRunId = currentState.runId` and abort if `currentState.runId` changes; avoid calling `setState` when stale.

README:
- Add notes about single-tab mode, de-dup history (bounded), and immediate target-count changes.

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`
Expected: PASS

**Step 5: Manual verification**

1. Start run, let it visit a few topics.
2. Click “重新开始” → should skip already visited items.
3. While running, change target count → should restart quickly and show new target.
4. Simulate API blocked (offline) → should fall back to DOM without hanging.

**Step 6: Commit**

Skip (not requested).
```
