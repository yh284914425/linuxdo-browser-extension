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
  computeBatchPlan,
  computeFillPlan,
  matchTitleKeywords,
  pickReplyTemplate,
  computeStaleFlagPatch,
  computeFetchSchedulePatch
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

function testKeywordHelpers() {
  const keywords = ['抽奖', '福利', '抽'];
  assert.strictEqual(matchTitleKeywords('今晚有抽奖', keywords), true);
  assert.strictEqual(matchTitleKeywords('福利大放送', keywords), true);
  assert.strictEqual(matchTitleKeywords('抽空看看', keywords), true);
  assert.strictEqual(matchTitleKeywords('不相关标题', keywords), false);
}

function testPickReplyTemplate() {
  const templates = ['参与一下', '支持活动', '感谢福利'];
  const pick = pickReplyTemplate(templates, { random: () => 0.0 });
  assert.strictEqual(pick, '参与一下');
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

function testStaleFlagPatch() {
  const now = 10_000;
  const active = computeStaleFlagPatch(
    { ownerId: 'a', ownerHeartbeat: now - 1000, fetching: true, queueBuilding: true },
    { now, ttlMs: 5000 }
  );
  assert.deepStrictEqual(active, {});

  const stale = computeStaleFlagPatch(
    { ownerId: 'a', ownerHeartbeat: now - 6000, fetching: true, queueBuilding: true },
    { now, ttlMs: 5000 }
  );
  assert.deepStrictEqual(stale, { fetching: false, queueBuilding: false });

  const staleNoFlags = computeStaleFlagPatch(
    { ownerId: 'a', ownerHeartbeat: now - 6000, fetching: false, queueBuilding: false },
    { now, ttlMs: 5000 }
  );
  assert.deepStrictEqual(staleNoFlags, {});
}

function testFetchSchedulePatch() {
  const now = 20_000;
  const rateLimit = computeFetchSchedulePatch({ status: 429, backoffCount: 0, now });
  assert.strictEqual(rateLimit.backoffCount, 1);
  assert.strictEqual(rateLimit.nextFetchAt, now + 30000);

  const serverErr = computeFetchSchedulePatch({ status: 500, backoffCount: 2, now, jitterMs: [2000, 5000] });
  assert.strictEqual(serverErr.backoffCount, 0);
  assert.strictEqual(serverErr.nextFetchAt >= now + 2000 && serverErr.nextFetchAt <= now + 5000, true);

  const networkErr = computeFetchSchedulePatch({ status: 0, backoffCount: 1, now, jitterMs: [2000, 5000] });
  assert.strictEqual(networkErr.backoffCount, 0);
  assert.strictEqual(networkErr.nextFetchAt >= now + 2000 && networkErr.nextFetchAt <= now + 5000, true);
}

testSanitizeTargetCount();
testQueueEmptyStop();
testRunIdPatches();
testOwnerActive();
testHistoryHelpers();
testBatchBackoffHelpers();
testKeywordHelpers();
testPickReplyTemplate();
testFillPlan();
testEnsureJsonApiUrl();
testStaleFlagPatch();
testFetchSchedulePatch();
console.log('logic tests passed');
