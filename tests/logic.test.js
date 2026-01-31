const assert = require('assert');
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
  ensureJsonApiUrl,
  computeNextFetchAt,
  shouldFetchMore,
  computeBatchPlan
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

function testEnsureJsonApiUrl() {
  const base = 'https://linux.do';
  assert.strictEqual(
    ensureJsonApiUrl('/latest?no_definitions=true&page=1', { base }),
    'https://linux.do/latest.json?no_definitions=true&page=1'
  );
  assert.strictEqual(
    ensureJsonApiUrl('https://linux.do/latest.json?no_definitions=true&page=2', { base }),
    'https://linux.do/latest.json?no_definitions=true&page=2'
  );
}

testSanitizeTargetCount();
testQueueEmptyStop();
testRunIdPatches();
testOwnerActive();
testHistoryHelpers();
testBatchBackoffHelpers();
testEnsureJsonApiUrl();
console.log('logic tests passed');
