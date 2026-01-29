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
