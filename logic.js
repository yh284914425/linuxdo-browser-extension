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

  const OWNER_DEFAULTS = {
    ttlMs: 15000
  };

  const HISTORY_DEFAULTS = {
    maxEntries: 3000,
    ttlMs: 30 * 24 * 60 * 60 * 1000
  };

  const BATCH_DEFAULTS = {
    batchSize: 150,
    lowWater: 30,
    maxPages: 3,
    jitterMs: [2000, 5000],
    backoffBaseMs: 30000,
    backoffMaxMs: 10 * 60 * 1000
  };

  const MONITOR_DEFAULTS = {
    intervalMs: 30000,
    maxPages: 2,
    replyHistoryMax: 3000,
    replyHistoryTtlMs: 90 * 24 * 60 * 60 * 1000,
    replySyncIntervalMs: 10 * 60 * 1000,
    replySyncMaxPages: 2,
    replyItemsMax: 30,
    enabledByDefault: false,
    notifyThrottleMs: 10 * 1000,
    notifyMaxPerWindow: 3
  };

  const KEYWORD_DEFAULTS = [
    '抽奖',
    '福利',
    '抽',
    '开奖',
    '抽取',
    '抽中',
    '赠送',
    '送福利',
    '随机',
    '中奖'
  ];

  const REPLY_TEMPLATES = [
    '参与抽奖，谢谢',
    '支持活动，感谢',
    '来参与一下',
    '感谢福利分享',
    '蹲一个好运',
    '支持一下活动',
    '来试试手气',
    '参与支持一下',
    '感谢大佬分享',
    '路过参与一下',
    '参与活动支持',
    '感谢福利活动'
  ];

  function normalizeKeywords(list) {
    const safe = Array.isArray(list) ? list : [];
    return safe
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0);
  }

  function matchTitleKeywords(title, list = KEYWORD_DEFAULTS) {
    const text = String(title || '');
    const keywords = normalizeKeywords(list);
    return keywords.some((key) => key && text.includes(key));
  }

  function pickReplyTemplate(list = REPLY_TEMPLATES, options = {}) {
    const safe = Array.isArray(list)
      ? list.filter((item) => typeof item === 'string' && item.trim().length >= 4)
      : [];
    if (safe.length === 0) return '';
    const random = typeof options.random === 'function' ? options.random : Math.random;
    const idx = Math.min(Math.floor(random() * safe.length), safe.length - 1);
    return safe[idx];
  }

  function sanitizeTargetCount(value, defaults = DEFAULTS) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return defaults.defaultTarget;
    }
    if (parsed < defaults.minTarget) return defaults.minTarget;
    if (parsed > defaults.maxTarget) return defaults.maxTarget;
    return parsed;
  }

  function ensureJsonApiUrl(url, options = {}) {
    if (!url) return null;
    const base = options.base || options.origin;
    try {
      const resolved = base ? new URL(url, base) : new URL(url);
      let pathname = resolved.pathname || '';
      if (pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      if (!pathname.endsWith('.json')) {
        pathname = `${pathname}.json`;
      }
      resolved.pathname = pathname;
      return resolved.href;
    } catch (err) {
      return url;
    }
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

  function isOwnerActive(ownerId, heartbeat, options = {}) {
    if (!ownerId || !Number.isFinite(heartbeat)) {
      return false;
    }
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
    if (!Number.isFinite(id)) {
      return pruneHistory(entries, options);
    }
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

  function computeNotifyThrottle({ timestamps, now, windowMs, maxPerWindow } = {}) {
    const ts = Number.isFinite(now) ? now : Date.now();
    const windowSize = Number.isFinite(windowMs) ? windowMs : 10_000;
    const limit = Number.isFinite(maxPerWindow) ? maxPerWindow : 3;
    const safe = Array.isArray(timestamps) ? timestamps : [];
    const cutoff = ts - windowSize;
    const filtered = safe.filter((item) => Number.isFinite(item) && item >= cutoff);
    if (filtered.length >= limit) {
      return { allowed: false, timestamps: filtered.slice(0, limit) };
    }
    return { allowed: true, timestamps: [ts, ...filtered].slice(0, limit) };
  }

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

  function computeFillPlan({ queueLength, targetCount, pagesFetched, maxPages, nextUrl, status }) {
    const hasCapacity = Number.isFinite(targetCount) ? queueLength < targetCount : true;
    const underMax = Number.isFinite(maxPages) ? pagesFetched < maxPages : true;
    const ok = status === 200;
    const hasNext = Boolean(nextUrl);
    return { shouldContinue: hasCapacity && underMax && ok && hasNext };
  }

  function computeStaleFlagPatch(state, options = {}) {
    const ownerActive = isOwnerActive(state.ownerId, state.ownerHeartbeat, options);
    if (ownerActive) return {};
    const next = {};
    if (state.fetching) next.fetching = false;
    if (state.queueBuilding) next.queueBuilding = false;
    return next;
  }

  function computeFetchSchedulePatch({ status, backoffCount, now, jitterMs } = {}) {
    const schedule = computeNextFetchAt({ status, backoffCount, now, jitterMs });
    return {
      nextFetchAt: schedule.nextFetchAt,
      backoffCount: schedule.backoffCount
    };
  }

  return {
    DEFAULTS,
    OWNER_DEFAULTS,
    HISTORY_DEFAULTS,
    BATCH_DEFAULTS,
    MONITOR_DEFAULTS,
    KEYWORD_DEFAULTS,
    REPLY_TEMPLATES,
    normalizeKeywords,
    matchTitleKeywords,
    pickReplyTemplate,
    sanitizeTargetCount,
    ensureJsonApiUrl,
    shouldStopWhenQueueEmpty,
    buildStartPatch,
    buildRestartPatch,
    isOwnerActive,
    pruneHistory,
    addHistoryEntry,
    historyToSet,
    computeNotifyThrottle,
    computeNextFetchAt,
    shouldFetchMore,
    computeBatchPlan,
    computeFillPlan,
    computeStaleFlagPatch,
    computeFetchSchedulePatch
  };
});
