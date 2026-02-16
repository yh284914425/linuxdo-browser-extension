const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEFAULTS,
  TAG_DEFAULTS,
  MONITOR_DEFAULTS,
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
  computeFetchSchedulePatch,
  matchTopicTags,
  computeNotifyThrottle,
  parseUsernameFromAvatarSrc,
  computeMonitorUserStatus,
  buildReplyText,
  sanitizePanelCollapsed,
  PANEL_DEFAULTS,
  classifyReplyFailure,
  computeMonitorTopicDelayMs,
  isTopicFromToday,
  shouldBreakMonitorTopicLoop
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

function testTagHelpers() {
  const tags = ['抽奖', '福利'];
  assert.strictEqual(matchTopicTags(tags, ['抽奖']), true);
  assert.strictEqual(matchTopicTags(tags, ['不存在']), false);
  assert.strictEqual(matchTopicTags([], ['抽奖']), false);
  const objectTags = [
    { id: 10, name: '抽奖', slug: '10-tag' },
    { id: 1514, name: '高级推广', slug: '1514-tag' }
  ];
  assert.strictEqual(matchTopicTags(objectTags, ['抽奖']), true);
  assert.strictEqual(matchTopicTags(objectTags, ['10-tag']), true);
  assert.strictEqual(matchTopicTags(objectTags, ['lottery']), false);
  assert.strictEqual(Array.isArray(TAG_DEFAULTS), true);
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

function testMonitorDefaultsForNotify() {
  assert.strictEqual(MONITOR_DEFAULTS.enabledByDefault, false);
  assert.strictEqual(MONITOR_DEFAULTS.notifyThrottleMs, 10000);
  assert.strictEqual(MONITOR_DEFAULTS.notifyMaxPerWindow, 3);
}

function testComputeNotifyThrottle() {
  const now = 10_000;
  const res1 = computeNotifyThrottle({
    timestamps: [],
    now,
    windowMs: 10_000,
    maxPerWindow: 3
  });
  assert.strictEqual(res1.allowed, true);
  assert.deepStrictEqual(res1.timestamps, [now]);

  const res2 = computeNotifyThrottle({
    timestamps: [now - 1000, now - 2000],
    now,
    windowMs: 10_000,
    maxPerWindow: 3
  });
  assert.strictEqual(res2.allowed, true);
  assert.strictEqual(res2.timestamps.length, 3);

  const res3 = computeNotifyThrottle({
    timestamps: [now - 1000, now - 2000, now - 3000],
    now,
    windowMs: 10_000,
    maxPerWindow: 3
  });
  assert.strictEqual(res3.allowed, false);
  assert.deepStrictEqual(res3.timestamps, [now - 1000, now - 2000, now - 3000]);
}

function testParseUsernameFromAvatarSrc() {
  assert.strictEqual(
    parseUsernameFromAvatarSrc('/user_avatar/linux.do/shengmaomao/96/123.png'),
    'shengmaomao'
  );
  assert.strictEqual(
    parseUsernameFromAvatarSrc('/letter_avatar/shengmaomao/96/5_c16b2ee14fe83ed9a59fc65fbec00f85.png'),
    'shengmaomao'
  );
  assert.strictEqual(
    parseUsernameFromAvatarSrc('https://linux.do/user_avatar/linux.do/foo%20bar/96/123.png'),
    'foo bar'
  );
  assert.strictEqual(parseUsernameFromAvatarSrc('/assets/no-avatar.png'), null);
}

function testComputeMonitorUserStatus() {
  assert.strictEqual(computeMonitorUserStatus({ id: 1, username: 'abc', status: 200 }), 200);
  assert.strictEqual(computeMonitorUserStatus({ id: null, username: 'abc', status: 0 }), 200);
  assert.strictEqual(computeMonitorUserStatus({ id: null, username: null, status: 429 }), 429);
  assert.strictEqual(computeMonitorUserStatus({ id: null, username: null, status: 500 }), 500);
  assert.strictEqual(computeMonitorUserStatus({ id: null, username: null, status: 0 }), 0);
}

function testBuildReplyText() {
  const templates = ['参与抽奖，谢谢', '支持活动，感谢'];
  assert.strictEqual(
    buildReplyText(templates, { random: () => 0 }),
    '参与抽奖，谢谢'
  );
  assert.strictEqual(
    buildReplyText(['好'], { random: () => 0 }),
    '参与'
  );
}

function testSanitizePanelCollapsed() {
  assert.strictEqual(sanitizePanelCollapsed(true, PANEL_DEFAULTS), true);
  assert.strictEqual(sanitizePanelCollapsed(false, PANEL_DEFAULTS), false);
  assert.strictEqual(sanitizePanelCollapsed(undefined, PANEL_DEFAULTS), false);
  assert.strictEqual(
    sanitizePanelCollapsed(undefined, { collapsedByDefault: true }),
    true
  );
}

function testClassifyReplyFailure() {
  const already = classifyReplyFailure({
    status: 422,
    payload: { errors: ['You have already replied to this topic'] }
  });
  assert.strictEqual(already.kind, 'already_replied');
  assert.strictEqual(already.markAsReplied, true);

  const duplicate = classifyReplyFailure({
    status: 422,
    payload: { errors: ['is similar to what you posted before'] }
  });
  assert.strictEqual(duplicate.kind, 'duplicate');
  assert.strictEqual(duplicate.markAsReplied, true);

  const rejected = classifyReplyFailure({
    status: 422,
    payload: { errors: ['Body is too short'] }
  });
  assert.strictEqual(rejected.kind, 'rejected');
  assert.strictEqual(rejected.markAsReplied, false);

  const rate = classifyReplyFailure({
    status: 429,
    payload: { errors: ['Too many requests'] }
  });
  assert.strictEqual(rate.kind, 'rate_limited');
  assert.strictEqual(rate.markAsReplied, false);
}

function testComputeMonitorTopicDelayMs() {
  assert.strictEqual(
    computeMonitorTopicDelayMs({ minMs: 600, maxMs: 1200, random: () => 0 }),
    600
  );
  assert.strictEqual(
    computeMonitorTopicDelayMs({ minMs: 600, maxMs: 1200, random: () => 1 }),
    1200
  );
  assert.strictEqual(
    computeMonitorTopicDelayMs({ minMs: 1200, maxMs: 600, random: () => 0.5 }),
    1200
  );
}

function testIsTopicFromToday() {
  const now = Date.parse('2026-02-14T08:00:00+08:00');
  const offsetMinutes = 8 * 60;
  assert.strictEqual(
    isTopicFromToday('2026-02-14T00:01:00+08:00', { now, offsetMinutes }),
    true
  );
  assert.strictEqual(
    isTopicFromToday('2026-02-13T23:59:59+08:00', { now, offsetMinutes }),
    false
  );
  assert.strictEqual(
    isTopicFromToday('invalid-date', { now, offsetMinutes }),
    false
  );
  assert.strictEqual(
    isTopicFromToday('', { now, offsetMinutes }),
    false
  );
}

function testShouldBreakMonitorTopicLoop() {
  assert.strictEqual(shouldBreakMonitorTopicLoop(200), false);
  assert.strictEqual(shouldBreakMonitorTopicLoop(400), false);
  assert.strictEqual(shouldBreakMonitorTopicLoop(422), false);
  assert.strictEqual(shouldBreakMonitorTopicLoop(429), true);
  assert.strictEqual(shouldBreakMonitorTopicLoop(500), true);
  assert.strictEqual(shouldBreakMonitorTopicLoop(503), true);
  assert.strictEqual(shouldBreakMonitorTopicLoop(0), true);
}

function testReplyTemplatesSingleSource() {
  const contentPath = path.join(__dirname, '..', 'content.js');
  const source = fs.readFileSync(contentPath, 'utf8');
  assert.strictEqual(source.includes('const REPLY_TEMPLATES ='), false);
}

testSanitizeTargetCount();
testQueueEmptyStop();
testRunIdPatches();
testOwnerActive();
testHistoryHelpers();
testBatchBackoffHelpers();
testKeywordHelpers();
testTagHelpers();
testPickReplyTemplate();
testFillPlan();
testEnsureJsonApiUrl();
testStaleFlagPatch();
testFetchSchedulePatch();
testMonitorDefaultsForNotify();
testComputeNotifyThrottle();
testParseUsernameFromAvatarSrc();
testComputeMonitorUserStatus();
testBuildReplyText();
testSanitizePanelCollapsed();
testClassifyReplyFailure();
testComputeMonitorTopicDelayMs();
testIsTopicFromToday();
testShouldBreakMonitorTopicLoop();
testReplyTemplatesSingleSource();
console.log('logic tests passed');
