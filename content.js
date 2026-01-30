(() => {
  const DEFAULT_MIN = 1;
  const DEFAULT_MAX = 3;
  const PANEL_ID = "linuxdo-auto-panel";
  const LOGIC = window.LinuxdoLogic || null;
  const API_LATEST_URL = "https://linux.do/latest.json";
  const TARGET_DEFAULT = LOGIC && LOGIC.DEFAULTS ? LOGIC.DEFAULTS.defaultTarget : 1000;
  const TARGET_MIN = LOGIC && LOGIC.DEFAULTS ? LOGIC.DEFAULTS.minTarget : 1;
  const TARGET_MAX = LOGIC && LOGIC.DEFAULTS ? LOGIC.DEFAULTS.maxTarget : 1000;
  const OWNER_TTL_MS = LOGIC && LOGIC.OWNER_DEFAULTS ? LOGIC.OWNER_DEFAULTS.ttlMs : 15000;
  const HISTORY_MAX = LOGIC && LOGIC.HISTORY_DEFAULTS ? LOGIC.HISTORY_DEFAULTS.maxEntries : 3000;
  const HISTORY_TTL_MS = LOGIC && LOGIC.HISTORY_DEFAULTS ? LOGIC.HISTORY_DEFAULTS.ttlMs : 30 * 24 * 60 * 60 * 1000;
  const BATCH_DEFAULTS = LOGIC && LOGIC.BATCH_DEFAULTS ? LOGIC.BATCH_DEFAULTS : {
    batchSize: 150,
    lowWater: 30,
    maxPages: 3,
    jitterMs: [2000, 5000],
    backoffBaseMs: 30000,
    backoffMaxMs: 10 * 60 * 1000
  };
  const BATCH_JITTER = Array.isArray(BATCH_DEFAULTS.jitterMs) ? BATCH_DEFAULTS.jitterMs : [2000, 5000];
  const HEARTBEAT_INTERVAL_MS = Math.max(2000, Math.floor(OWNER_TTL_MS / 2));
  const FETCH_TIMEOUT_MS = 8000;
  const INSTANCE_ID = (() => {
    try {
      return crypto.randomUUID();
    } catch (err) {
      return `linuxdo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  })();

  const DEFAULT_STATE = {
    running: false,
    queue: [],
    index: 0,
    minDelay: DEFAULT_MIN,
    maxDelay: DEFAULT_MAX,
    queueBuilding: false,
    targetCount: TARGET_DEFAULT,
    runId: 0,
    ownerId: null,
    ownerHeartbeat: 0,
    history: [],
    batchSize: BATCH_DEFAULTS.batchSize,
    lowWater: BATCH_DEFAULTS.lowWater,
    maxPages: BATCH_DEFAULTS.maxPages,
    nextApiUrl: API_LATEST_URL,
    fetching: false,
    lastFetchAt: 0,
    nextFetchAt: 0,
    backoffCount: 0
  };

  let currentState = { ...DEFAULT_STATE };
  let heartbeatTimer = null;
  let stateLoadedResolve;
  const stateLoaded = new Promise((resolve) => {
    stateLoadedResolve = resolve;
  });

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function normalizeUrl(url) {
    const u = new URL(url, location.origin);
    let path = u.pathname;
    if (path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    return `${u.origin}${path}`;
  }

  function clampTargetCount(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return TARGET_DEFAULT;
    }
    if (parsed < TARGET_MIN) return TARGET_MIN;
    if (parsed > TARGET_MAX) return TARGET_MAX;
    return parsed;
  }

  function isOwnerActive(ownerId, heartbeat) {
    if (LOGIC && LOGIC.isOwnerActive) {
      return LOGIC.isOwnerActive(ownerId, heartbeat, { ttlMs: OWNER_TTL_MS });
    }
    if (!ownerId || !Number.isFinite(heartbeat)) {
      return false;
    }
    return Date.now() - heartbeat <= OWNER_TTL_MS;
  }

  function isOwnerSelf() {
    return currentState.ownerId === INSTANCE_ID;
  }

  async function claimOwnership() {
    const active = isOwnerActive(currentState.ownerId, currentState.ownerHeartbeat);
    if (active && !isOwnerSelf()) {
      return false;
    }
    await setState({ ownerId: INSTANCE_ID, ownerHeartbeat: Date.now() });
    return true;
  }

  async function stopRunning(patch = {}) {
    const shouldRelease = isOwnerSelf();
    stopHeartbeat();
    const nextPatch = { running: false, queueBuilding: false, fetching: false, ...patch };
    if (shouldRelease) {
      nextPatch.ownerId = null;
      nextPatch.ownerHeartbeat = 0;
    }
    await setState(nextPatch);
  }

  function startHeartbeat() {
    if (heartbeatTimer) {
      return;
    }
    const tick = async () => {
      if (!currentState.running || !isOwnerSelf()) {
        stopHeartbeat();
        return;
      }
      await setState({ ownerId: INSTANCE_ID, ownerHeartbeat: Date.now() });
    };
    heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    void tick();
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) {
      return;
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function extractTopicId(url) {
    try {
      const resolved = new URL(url, location.origin);
      const match = resolved.pathname.match(/\/t\/[^/]+\/(\d+)/);
      if (!match) return null;
      const id = Number.parseInt(match[1], 10);
      return Number.isFinite(id) ? id : null;
    } catch (err) {
      return null;
    }
  }

  function getPrunedHistory() {
    const safe = Array.isArray(currentState.history) ? currentState.history : [];
    if (LOGIC && LOGIC.pruneHistory) {
      return LOGIC.pruneHistory(safe, { ttlMs: HISTORY_TTL_MS, maxEntries: HISTORY_MAX });
    }
    const now = Date.now();
    const filtered = safe.filter((entry) => {
      return entry && Number.isFinite(entry.id) && Number.isFinite(entry.ts) && now - entry.ts <= HISTORY_TTL_MS;
    });
    filtered.sort((a, b) => b.ts - a.ts);
    return filtered.slice(0, HISTORY_MAX);
  }

  function historyToSet(entries) {
    if (LOGIC && LOGIC.historyToSet) {
      return LOGIC.historyToSet(entries);
    }
    const safe = Array.isArray(entries) ? entries : [];
    const ids = safe.map((entry) => entry && entry.id).filter(Number.isFinite);
    return new Set(ids);
  }

  function addHistoryEntry(entries, id) {
    if (LOGIC && LOGIC.addHistoryEntry) {
      return LOGIC.addHistoryEntry(entries, id, { ttlMs: HISTORY_TTL_MS, maxEntries: HISTORY_MAX });
    }
    const now = Date.now();
    const safe = Array.isArray(entries) ? entries : [];
    if (!Number.isFinite(id)) {
      const filtered = safe.filter((entry) => {
        return entry && Number.isFinite(entry.id) && Number.isFinite(entry.ts) && now - entry.ts <= HISTORY_TTL_MS;
      });
      filtered.sort((a, b) => b.ts - a.ts);
      return filtered.slice(0, HISTORY_MAX);
    }
    const next = [{ id, ts: now }, ...safe.filter((entry) => entry && entry.id !== id)];
    const filtered = next.filter((entry) => {
      return entry && Number.isFinite(entry.id) && Number.isFinite(entry.ts) && now - entry.ts <= HISTORY_TTL_MS;
    });
    filtered.sort((a, b) => b.ts - a.ts);
    return filtered.slice(0, HISTORY_MAX);
  }

  function historiesEqual(a, b) {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (left[i].id !== right[i].id || left[i].ts !== right[i].ts) {
        return false;
      }
    }
    return true;
  }

  async function ensureHistoryPruned() {
    const pruned = getPrunedHistory();
    if (!historiesEqual(pruned, currentState.history)) {
      await setState({ history: pruned });
    }
    return pruned;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const merged = { ...options, signal: controller.signal };
      return await fetch(url, merged);
    } finally {
      clearTimeout(timer);
    }
  }

  function computeNextFetchAt({ status, backoffCount }) {
    if (LOGIC && LOGIC.computeNextFetchAt) {
      return LOGIC.computeNextFetchAt({
        now: Date.now(),
        status,
        backoffCount,
        jitterMs: BATCH_JITTER
      });
    }
    const now = Date.now();
    if (status === 429) {
      const count = Number.isFinite(backoffCount) ? backoffCount : 0;
      const delay = Math.min(
        BATCH_DEFAULTS.backoffBaseMs * Math.pow(2, count),
        BATCH_DEFAULTS.backoffMaxMs
      );
      return { nextFetchAt: now + delay, backoffCount: count + 1 };
    }
    const min = Number.isFinite(BATCH_JITTER[0]) ? BATCH_JITTER[0] : 2000;
    const max = Number.isFinite(BATCH_JITTER[1]) ? BATCH_JITTER[1] : 5000;
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return { nextFetchAt: now + delay, backoffCount: 0 };
  }

  function shouldFetchMoreState({ remaining, now, nextFetchAt, fetching, lowWater }) {
    if (LOGIC && LOGIC.shouldFetchMore) {
      return LOGIC.shouldFetchMore({
        remaining,
        lowWater,
        fetching,
        now,
        nextFetchAt
      });
    }
    if (fetching) return false;
    const limit = Number.isFinite(lowWater) ? lowWater : BATCH_DEFAULTS.lowWater;
    if (!Number.isFinite(remaining) || remaining >= limit) return false;
    const ts = Number.isFinite(now) ? now : Date.now();
    const next = Number.isFinite(nextFetchAt) ? nextFetchAt : 0;
    return ts >= next;
  }

  function computeBatchPlanState({ batchSize, maxPages, pagesFetched, fetchedCount }) {
    if (LOGIC && LOGIC.computeBatchPlan) {
      return LOGIC.computeBatchPlan({ batchSize, maxPages, pagesFetched, fetchedCount });
    }
    const target = Number.isFinite(batchSize) ? batchSize : BATCH_DEFAULTS.batchSize;
    const max = Number.isFinite(maxPages) ? maxPages : BATCH_DEFAULTS.maxPages;
    const pages = Number.isFinite(pagesFetched) ? pagesFetched : 0;
    const count = Number.isFinite(fetchedCount) ? fetchedCount : 0;
    const shouldContinue = count < target && pages < max;
    return { shouldContinue, nextPagesFetched: pages + 1 };
  }

  function getRemainingCount() {
    const total = currentState.queue ? currentState.queue.length : 0;
    const idx = currentState.index || 0;
    return Math.max(0, total - idx);
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) {
      return;
    }

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="title">Linux.do 自动浏览</div>
      <div class="row">
        <span>目标数量</span>
        <input id="linuxdo-target" type="number" min="${TARGET_MIN}" max="${TARGET_MAX}" step="1" />
      </div>
      <div class="row"><span>状态</span><span class="status" id="linuxdo-status">空闲</span></div>
      <div class="row"><span>进度</span><span id="linuxdo-progress">0/${TARGET_DEFAULT}</span></div>
      <div class="button-row">
        <button id="linuxdo-toggle">开始</button>
        <button id="linuxdo-restart" class="secondary">重新开始</button>
      </div>
    `;

    document.body.appendChild(panel);

    const toggleBtn = panel.querySelector("#linuxdo-toggle");
    const restartBtn = panel.querySelector("#linuxdo-restart");
    const targetInput = panel.querySelector("#linuxdo-target");

    const commitTarget = async (value) => {
      const finalValue = LOGIC && LOGIC.sanitizeTargetCount
        ? LOGIC.sanitizeTargetCount(value, LOGIC.DEFAULTS)
        : clampTargetCount(value);
      const otherOwnerActive = isOwnerActive(currentState.ownerId, currentState.ownerHeartbeat) && !isOwnerSelf();
      if (otherOwnerActive) {
        updatePanel();
        return;
      }
      if (currentState.running) {
        const patch = LOGIC && LOGIC.buildRestartPatch
          ? LOGIC.buildRestartPatch(currentState)
          : {
            running: true,
            queue: [],
            index: 0,
            queueBuilding: true,
            runId: (currentState.runId || 0) + 1
          };
        await setState({
          ...patch,
          targetCount: finalValue,
          nextApiUrl: API_LATEST_URL,
          fetching: false,
          lastFetchAt: 0,
          nextFetchAt: 0,
          backoffCount: 0
        });
        startHeartbeat();
        updatePanel();
        await runLoop();
        return;
      }

      const patch = { targetCount: finalValue };
      if (currentState.queue && currentState.queue.length > 0) {
        if (finalValue < currentState.queue.length) {
          patch.queue = currentState.queue.slice(0, finalValue);
          patch.index = Math.min(currentState.index || 0, finalValue);
        } else if (finalValue > currentState.queue.length) {
          patch.queue = [];
          patch.index = 0;
        }
      }
      await setState(patch);
    };

    targetInput.addEventListener("change", async (event) => {
      await commitTarget(event.target.value);
    });
    targetInput.addEventListener("blur", async (event) => {
      await commitTarget(event.target.value);
    });
    targetInput.addEventListener("keydown", async (event) => {
      if (event.key === "Enter") {
        await commitTarget(event.target.value);
        targetInput.blur();
      }
    });

    toggleBtn.addEventListener("click", async () => {
      await stateLoaded;
      if (currentState.running) {
        await stopRunning();
        updatePanel();
        return;
      }
      const claimed = await claimOwnership();
      if (!claimed) {
        updatePanel();
        return;
      }
      const patch = LOGIC && LOGIC.buildStartPatch
        ? LOGIC.buildStartPatch(currentState)
        : { running: true, runId: (currentState.runId || 0) + 1 };
      await setState({
        ...patch,
        nextApiUrl: currentState.nextApiUrl || API_LATEST_URL
      });
      startHeartbeat();
      updatePanel();
      await runLoop();
    });

    restartBtn.addEventListener("click", async () => {
      await stateLoaded;
      const claimed = await claimOwnership();
      if (!claimed) {
        updatePanel();
        return;
      }
      const patch = LOGIC && LOGIC.buildRestartPatch
        ? LOGIC.buildRestartPatch(currentState)
        : {
          running: true,
          queue: [],
          index: 0,
          queueBuilding: true,
          runId: (currentState.runId || 0) + 1
        };
      await setState({
        ...patch,
        nextApiUrl: API_LATEST_URL,
        fetching: false,
        lastFetchAt: 0,
        nextFetchAt: 0,
        backoffCount: 0
      });
      startHeartbeat();
      updatePanel();
      await runLoop();
    });
  }

  function updatePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
      return;
    }

    const statusEl = panel.querySelector("#linuxdo-status");
    const progressEl = panel.querySelector("#linuxdo-progress");
    const toggleBtn = panel.querySelector("#linuxdo-toggle");
    const restartBtn = panel.querySelector("#linuxdo-restart");
    const targetInput = panel.querySelector("#linuxdo-target");

    const target = LOGIC && LOGIC.sanitizeTargetCount
      ? LOGIC.sanitizeTargetCount(currentState.targetCount, LOGIC.DEFAULTS)
      : clampTargetCount(currentState.targetCount);

    const total = currentState.queue && currentState.queue.length
      ? currentState.queue.length
      : target;
    const done = Math.min(currentState.index || 0, total);

    const ownerActive = isOwnerActive(currentState.ownerId, currentState.ownerHeartbeat);
    const otherOwnerActive = ownerActive && !isOwnerSelf();

    const now = Date.now();
    const coolingDown = currentState.running
      && currentState.backoffCount > 0
      && Number.isFinite(currentState.nextFetchAt)
      && now < currentState.nextFetchAt;

    let status = "空闲";
    if (otherOwnerActive) {
      status = "其他标签运行";
    } else if (currentState.queueBuilding) {
      status = "构建中";
    } else if (currentState.fetching) {
      status = "补充中";
    } else if (coolingDown) {
      status = "冷却中";
    } else if (currentState.running) {
      status = "运行中";
    } else if (currentState.queue && currentState.queue.length > 0 && currentState.index >= currentState.queue.length) {
      status = "已完成";
    }

    statusEl.textContent = status;
    progressEl.textContent = `${done}/${total}`;
    toggleBtn.textContent = currentState.running ? "暂停" : "开始";
    const controlsDisabled = currentState.queueBuilding || otherOwnerActive;
    toggleBtn.disabled = controlsDisabled;
    restartBtn.disabled = controlsDisabled;
    if (targetInput) {
      targetInput.disabled = otherOwnerActive;
    }
    if (targetInput && document.activeElement !== targetInput) {
      targetInput.value = target;
    }
  }

  function loadState() {
    chrome.storage.local.get(DEFAULT_STATE, (state) => {
      currentState = { ...DEFAULT_STATE, ...state };
      updatePanel();
      stateLoadedResolve();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      for (const [key, change] of Object.entries(changes)) {
        currentState[key] = change.newValue;
      }
      updatePanel();
    });
  }

  function setState(patch) {
    return new Promise((resolve) => {
      currentState = { ...currentState, ...patch };
      chrome.storage.local.set(patch, () => {
        updatePanel();
        resolve();
      });
    });
  }

  async function waitForTopics(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (document.querySelectorAll("a.title").length > 0) {
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  async function fetchMoreFromApi(runId) {
    const isActive = () => currentState.running && currentState.runId === runId && isOwnerSelf();
    if (!isActive()) return null;
    if (currentState.fetching) return null;

    const targetCount = getTargetCount();
    const existingQueue = Array.isArray(currentState.queue) ? currentState.queue : [];
    if (existingQueue.length >= targetCount) {
      return { added: 0 };
    }

    const batchSize = Math.min(
      Number.isFinite(currentState.batchSize) ? currentState.batchSize : BATCH_DEFAULTS.batchSize,
      targetCount - existingQueue.length
    );
    if (batchSize <= 0) {
      return { added: 0 };
    }

    const maxPages = Number.isFinite(currentState.maxPages) ? currentState.maxPages : BATCH_DEFAULTS.maxPages;
    let nextUrl = currentState.nextApiUrl || API_LATEST_URL;
    if (!nextUrl) {
      return { added: 0 };
    }

    const historySet = historyToSet(getPrunedHistory());
    const seen = new Set(existingQueue.map((url) => normalizeUrl(url)));
    let queue = [...existingQueue];
    let fetchedCount = 0;
    let pagesFetched = 0;
    let backoffCount = Number.isFinite(currentState.backoffCount) ? currentState.backoffCount : 0;
    let nextFetchAt = Number.isFinite(currentState.nextFetchAt) ? currentState.nextFetchAt : 0;
    let lastFetchAt = currentState.lastFetchAt || 0;
    let status = 200;

    await setState({ fetching: true });

    while (nextUrl && isActive()) {
      const now = Date.now();
      if (nextFetchAt && now < nextFetchAt) {
        await sleep(nextFetchAt - now);
        if (!isActive()) break;
      }

      let res;
      try {
        res = await fetchWithTimeout(nextUrl, { credentials: "include" });
      } catch (err) {
        status = 0;
        break;
      }

      lastFetchAt = Date.now();
      if (res.status === 429) {
        status = 429;
        const schedule = computeNextFetchAt({ status: 429, backoffCount });
        backoffCount = schedule.backoffCount;
        nextFetchAt = schedule.nextFetchAt;
        break;
      }
      if (!res.ok) {
        status = res.status;
        const schedule = computeNextFetchAt({ status: res.status, backoffCount });
        backoffCount = schedule.backoffCount;
        nextFetchAt = schedule.nextFetchAt;
        break;
      }

      let data;
      try {
        data = await res.json();
      } catch (err) {
        status = 0;
        break;
      }

      const topics = data && data.topic_list && Array.isArray(data.topic_list.topics)
        ? data.topic_list.topics
        : [];

      if (topics.length === 0) {
        break;
      }

      for (const topic of topics) {
        if (!topic || !topic.slug || !topic.id) continue;
        if (historySet.has(topic.id)) continue;
        const href = new URL(`/t/${topic.slug}/${topic.id}`, location.origin).href;
        const normalized = normalizeUrl(href);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          queue.push(href);
          fetchedCount += 1;
        }
        if (fetchedCount >= batchSize) break;
      }

      const more = data && data.topic_list && data.topic_list.more_topics_url
        ? data.topic_list.more_topics_url
        : null;
      nextUrl = more ? new URL(more, location.origin).href : null;

      pagesFetched += 1;
      const plan = computeBatchPlanState({
        batchSize,
        maxPages,
        pagesFetched,
        fetchedCount
      });
      if (!plan.shouldContinue) {
        break;
      }

      const schedule = computeNextFetchAt({ status: 200, backoffCount: 0 });
      backoffCount = schedule.backoffCount;
      nextFetchAt = schedule.nextFetchAt;
    }

    if (isActive()) {
      await setState({
        queue,
        fetching: false,
        nextApiUrl: nextUrl,
        lastFetchAt,
        nextFetchAt,
        backoffCount
      });
    } else {
      await setState({ fetching: false });
    }

    return { added: fetchedCount, status };
  }

  async function maybeFetchMore(runId, { force = false } = {}) {
    const isActive = () => currentState.running && currentState.runId === runId && isOwnerSelf();
    if (!isActive()) return null;

    const targetCount = getTargetCount();
    const totalQueued = currentState.queue ? currentState.queue.length : 0;
    if (totalQueued >= targetCount) return null;

    const remaining = getRemainingCount();
    const now = Date.now();
    const lowWater = Number.isFinite(currentState.lowWater) ? currentState.lowWater : BATCH_DEFAULTS.lowWater;
    const canFetch = shouldFetchMoreState({
      remaining,
      lowWater,
      fetching: currentState.fetching,
      now,
      nextFetchAt: currentState.nextFetchAt
    });

    if (!canFetch) {
      if (force && remaining === 0 && Number.isFinite(currentState.nextFetchAt) && now < currentState.nextFetchAt) {
        const waitMs = currentState.nextFetchAt - now;
        await sleep(waitMs);
        if (!isActive()) return null;
        return await maybeFetchMore(runId, { force: true });
      }
      return null;
    }

    return await fetchMoreFromApi(runId);
  }

  async function buildQueueFromDom(target, runId) {
    const buildRunId = Number.isFinite(runId) ? runId : currentState.runId;
    const isActive = () => currentState.running && currentState.runId === buildRunId && isOwnerSelf();
    if (!isActive()) {
      return null;
    }
    await setState({ queueBuilding: true });
    if (!isActive()) {
      return null;
    }

    if (location.pathname !== "/latest") {
      location.href = "https://linux.do/latest";
      return null;
    }

    await waitForTopics(15000);
    if (!isActive()) {
      return null;
    }

    const historySet = historyToSet(getPrunedHistory());
    const urls = [];
    const seen = new Set();
    let noNew = 0;

    for (let i = 0; i < 300 && urls.length < target && noNew < 6; i += 1) {
      if (!isActive()) {
        break;
      }

      const links = Array.from(document.querySelectorAll("a.title"));
      const before = seen.size;

      for (const link of links) {
        if (!link || !link.href) continue;
        const href = link.href;
        const topicId = extractTopicId(href);
        if (topicId && historySet.has(topicId)) {
          continue;
        }
        if (!seen.has(href)) {
          seen.add(href);
          urls.push(href);
        }
        if (urls.length >= target) break;
      }

      if (seen.size === before) {
        noNew += 1;
      } else {
        noNew = 0;
      }

      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1200);
    }

    if (!isActive()) {
      return null;
    }

    await setState({
      queue: urls,
      index: 0,
      queueBuilding: false
    });

    return urls;
  }

  function getTargetCount() {
    return LOGIC && LOGIC.sanitizeTargetCount
      ? LOGIC.sanitizeTargetCount(currentState.targetCount, LOGIC.DEFAULTS)
      : clampTargetCount(currentState.targetCount);
  }

  async function runLoop() {
    await stateLoaded;
    const runId = currentState.runId;
    const isActive = () => currentState.running && currentState.runId === runId && isOwnerSelf();
    if (!isActive()) return;

    if (window.__linuxdoAutoRunning) {
      return;
    }
    window.__linuxdoAutoRunning = true;

    try {
      const targetCount = getTargetCount();

      if (currentState.queueBuilding) {
        await maybeFetchMore(runId, { force: true });
        if (!isActive()) return;
        if (!currentState.queue || currentState.queue.length === 0) {
          const queue = await buildQueueFromDom(targetCount, runId);
          if (!isActive()) return;
          if (!queue || queue.length === 0) {
            if (LOGIC && LOGIC.shouldStopWhenQueueEmpty) {
              if (LOGIC.shouldStopWhenQueueEmpty(currentState)) {
                await stopRunning();
              }
            } else {
              await stopRunning();
            }
            return;
          }
        }
        if (currentState.queueBuilding) {
          await setState({ queueBuilding: false });
        }
      }

      if (!currentState.queue || currentState.queue.length === 0) {
        await maybeFetchMore(runId, { force: true });
        if (!isActive()) return;
        if (!currentState.queue || currentState.queue.length === 0) {
          const queue = await buildQueueFromDom(targetCount, runId);
          if (!isActive()) return;
          if (!queue || queue.length === 0) {
            await stopRunning();
            return;
          }
        }
      }

      if (currentState.index >= targetCount) {
        await stopRunning();
        return;
      }

      if (currentState.index >= (currentState.queue ? currentState.queue.length : 0)) {
        await maybeFetchMore(runId, { force: true });
        if (!isActive()) return;
        if (currentState.index >= (currentState.queue ? currentState.queue.length : 0)) {
          await stopRunning();
          return;
        }
      }

      void maybeFetchMore(runId);

      const targetUrl = currentState.queue[currentState.index];
      const current = normalizeUrl(location.href);
      const target = normalizeUrl(targetUrl);

      if (current !== target) {
        location.href = targetUrl;
        return;
      }

      const delay = rand(currentState.minDelay, currentState.maxDelay) * 1000;
      await sleep(delay);
      if (!isActive()) return;

      if (Math.random() < 0.7) {
        window.scrollBy({
          top: Math.floor(rand(300, 600)),
          left: 0,
          behavior: "smooth"
        });
        await sleep(600);
        if (!isActive()) return;
      }

      const topicId = extractTopicId(targetUrl);
      const nextHistory = addHistoryEntry(currentState.history, topicId);
      await setState({ index: currentState.index + 1, history: nextHistory });
      if (!isActive()) return;

      if (currentState.index >= targetCount) {
        await stopRunning();
        return;
      }

      if (currentState.index >= (currentState.queue ? currentState.queue.length : 0)) {
        await maybeFetchMore(runId, { force: true });
        if (!isActive()) return;
        if (currentState.index >= (currentState.queue ? currentState.queue.length : 0)) {
          await stopRunning();
          return;
        }
      }

      location.href = currentState.queue[currentState.index];
    } finally {
      window.__linuxdoAutoRunning = false;
    }
  }

  async function resumeIfNeeded() {
    await stateLoaded;
    await ensureHistoryPruned();
    if (currentState.fetching && !isOwnerSelf()) {
      await setState({ fetching: false });
    }

    if (currentState.running) {
      const ownerActive = isOwnerActive(currentState.ownerId, currentState.ownerHeartbeat);
      if (!ownerActive || isOwnerSelf()) {
        if (!isOwnerSelf()) {
          const claimed = await claimOwnership();
          if (!claimed) {
            updatePanel();
            return;
          }
        }
        startHeartbeat();
        await runLoop();
      } else {
        updatePanel();
      }
    }
  }

  createPanel();
  loadState();
  resumeIfNeeded();
})();
