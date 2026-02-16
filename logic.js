(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.LinuxdoLogic = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // 逻辑层纯函数：供 content/background 复用并可被单测覆盖。
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
    topicDelayMinMs: 600,
    topicDelayMaxMs: 1200,
    enabledByDefault: false,
    notifyThrottleMs: 10 * 1000,
    notifyMaxPerWindow: 3
  };

  const PANEL_DEFAULTS = {
    collapsedByDefault: false
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

  const TAG_DEFAULTS = ['抽奖'];

  const REPLY_TEMPLATES = [
    '参与一下，谢谢',
    '感谢大佬',
    '来参与一下',
    '感谢福利分享',
    '求中求中',
    '来试试手气',
    '参与支持一下',
    '来啦来啦',
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

  function parseUsernameFromAvatarSrc(src) {
    // 兼容普通头像和 letter_avatar 两类 URL。
    const raw = String(src || '').trim();
    if (!raw) return null;
    const matchers = [
      /\/user_avatar\/[^/]+\/([^/]+)\//i,
      /\/letter_avatar\/([^/]+)\//i
    ];
    for (const matcher of matchers) {
      const match = raw.match(matcher);
      if (!match || !match[1]) continue;
      try {
        return decodeURIComponent(match[1]);
      } catch (err) {
        return match[1];
      }
    }
    return null;
  }

  function computeMonitorUserStatus(userInfo = {}) {
    // 只要拿到 id 或 username 就视为“可用用户态”。
    const id = Number.isFinite(userInfo.id) ? userInfo.id : null;
    const username = typeof userInfo.username === 'string' ? userInfo.username.trim() : '';
    const status = Number.isFinite(userInfo.status) ? userInfo.status : 0;
    if (Number.isFinite(id) || username) {
      return 200;
    }
    return status;
  }

  function matchTopicTags(tags, requiredTags = TAG_DEFAULTS) {
    // 兼容 tags: string[] / {name,slug}[]。
    const safeTags = Array.isArray(tags) ? tags : [];
    const required = Array.isArray(requiredTags) ? requiredTags : [];
    if (required.length === 0) return false;
    const normalizedTags = safeTags
      .flatMap((item) => {
        if (item == null) return [];
        if (typeof item === 'string' || typeof item === 'number') {
          return [item];
        }
        if (typeof item === 'object') {
          const values = [];
          if (typeof item.name === 'string') values.push(item.name);
          if (typeof item.slug === 'string') values.push(item.slug);
          return values;
        }
        return [String(item)];
      })
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0)
      .map((item) => item.toLowerCase());
    const normalizedRequired = required
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0)
      .map((item) => item.toLowerCase());
    if (normalizedRequired.length === 0) return false;
    return normalizedRequired.some((tag) => normalizedTags.includes(tag));
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

  function buildReplyText(list = REPLY_TEMPLATES, options = {}) {
    // 回复内容兜底：长度过短时补“参与”。
    let text = `${pickReplyTemplate(list, options) || ''}`.trim();
    if (text.length < 4) {
      text = `${text}参与`;
    }
    return text;
  }

  function computeMonitorTopicDelayMs({ minMs, maxMs, random } = {}) {
    const min = Math.max(
      0,
      Number.isFinite(minMs) ? minMs : MONITOR_DEFAULTS.topicDelayMinMs
    );
    const maxCandidate = Number.isFinite(maxMs) ? maxMs : MONITOR_DEFAULTS.topicDelayMaxMs;
    const max = Math.max(min, maxCandidate);
    const rand = typeof random === 'function' ? random : Math.random;
    const value = rand();
    const ratio = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
    return Math.round(min + (max - min) * ratio);
  }

  // 监控循环中，哪些状态需要终止当前批次（避免连续失败放大请求）。
  function shouldBreakMonitorTopicLoop(status) {
    if (!Number.isFinite(status)) return false;
    if (status === 429) return true;
    if (status === 0) return true;
    return status >= 500;
  }

  function formatDayKeyByOffset(ts, offsetMinutes) {
    const shifted = new Date(ts + offsetMinutes * 60 * 1000);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // “今天”判断以本地时区为准，可通过 options.offsetMinutes 显式覆盖。
  function isTopicFromToday(createdAt, options = {}) {
    const raw = typeof createdAt === 'string' ? createdAt.trim() : '';
    if (!raw) return false;
    const createdTs = Date.parse(raw);
    if (!Number.isFinite(createdTs)) return false;
    const nowTs = Number.isFinite(options.now) ? options.now : Date.now();
    const localOffset = -new Date(nowTs).getTimezoneOffset();
    const offsetMinutes = Number.isFinite(options.offsetMinutes) ? options.offsetMinutes : localOffset;
    return formatDayKeyByOffset(createdTs, offsetMinutes) === formatDayKeyByOffset(nowTs, offsetMinutes);
  }

  function classifyReplyFailure({ status, payload } = {}) {
    const code = Number.isFinite(status) ? status : 0;
    const texts = [];
    if (payload && typeof payload === 'object') {
      if (Array.isArray(payload.errors)) texts.push(...payload.errors);
      if (Array.isArray(payload.messages)) texts.push(...payload.messages);
      if (typeof payload.error === 'string') texts.push(payload.error);
      if (typeof payload.message === 'string') texts.push(payload.message);
      if (typeof payload.detail === 'string') texts.push(payload.detail);
      if (typeof payload.error_type === 'string') texts.push(payload.error_type);
    }
    const errors = texts
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0);
    const joined = errors.join(' ').toLowerCase();

    const contains = (list) => list.some((item) => joined.includes(item));
    const rateKeywords = ['too many', 'too fast', 'rate limit', 'slow down', '请稍后', '太快', '频率', '429'];
    if (code === 429 || contains(rateKeywords)) {
      return { kind: 'rate_limited', markAsReplied: false, errors };
    }

    if (code !== 422) {
      return { kind: 'failed', markAsReplied: false, errors };
    }

    const alreadyKeywords = ['already replied', 'already posted', '你已经回复', '已经回复', '已回复'];
    if (contains(alreadyKeywords)) {
      return { kind: 'already_replied', markAsReplied: true, errors };
    }

    const duplicateKeywords = ['similar to what you posted', 'duplicate', '重复', '相似', 'same as'];
    if (contains(duplicateKeywords)) {
      return { kind: 'duplicate', markAsReplied: true, errors };
    }

    return { kind: 'rejected', markAsReplied: false, errors };
  }

  function sanitizePanelCollapsed(value, defaults = PANEL_DEFAULTS) {
    if (typeof value === 'boolean') {
      return value;
    }
    return Boolean(defaults && defaults.collapsedByDefault);
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
    PANEL_DEFAULTS,
    KEYWORD_DEFAULTS,
    TAG_DEFAULTS,
    REPLY_TEMPLATES,
    normalizeKeywords,
    matchTitleKeywords,
    parseUsernameFromAvatarSrc,
    computeMonitorUserStatus,
    matchTopicTags,
    pickReplyTemplate,
    buildReplyText,
    computeMonitorTopicDelayMs,
    shouldBreakMonitorTopicLoop,
    isTopicFromToday,
    classifyReplyFailure,
    sanitizePanelCollapsed,
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
