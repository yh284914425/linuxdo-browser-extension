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
