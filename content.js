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
  const FILL_MAX_PAGES = LOGIC && LOGIC.FILL_DEFAULTS ? LOGIC.FILL_DEFAULTS.maxPages : 50;
  const BATCH_JITTER = Array.isArray(BATCH_DEFAULTS.jitterMs) ? BATCH_DEFAULTS.jitterMs : [2000, 5000];
  const HEARTBEAT_INTERVAL_MS = Math.max(2000, Math.floor(OWNER_TTL_MS / 2));
  const FETCH_TIMEOUT_MS = 8000;
  const SESSION_ID_KEY = "__linuxdoAutoInstanceId";
  const INSTANCE_ID = (() => {
    try {
      const existing = sessionStorage.getItem(SESSION_ID_KEY);
      if (existing) {
        return existing;
      }
      const newId = crypto.randomUUID();
      sessionStorage.setItem(SESSION_ID_KEY, newId);
      return newId;
    } catch (err) {
      const fallback = `linuxdo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        sessionStorage.setItem(SESSION_ID_KEY, fallback);
      } catch (e) {
        // ignore
      }
      return fallback;
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

  function ensureJsonApiUrl(url) {
    if (LOGIC && LOGIC.ensureJsonApiUrl) {
      return LOGIC.ensureJsonApiUrl(url, { base: location.origin });
    }
    if (!url) return null;
    try {
      const resolved = new URL(url, location.origin);
      let pathname = resolved.pathname || "";
      if (pathname.endsWith("/")) {
        pathname = pathname.slice(0, -1);
      }
      if (!pathname.endsWith(".json")) {
        pathname = `${pathname}.json`;
      }
      resolved.pathname = pathname;
      return resolved.href;
    } catch (err) {
      return url;
    }
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
      const l = left[i];
      const r = right[i];
      if (!l || !r || l.id !== r.id || l.ts !== r.ts) {
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

  function computeStaleFlagPatchState(state, options = {}) {
    if (LOGIC && LOGIC.computeStaleFlagPatch) {
      return LOGIC.computeStaleFlagPatch(state, options);
    }
    const ownerActive = isOwnerActive(state.ownerId, state.ownerHeartbeat);
    if (ownerActive) return {};
    const next = {};
    if (state.fetching) next.fetching = false;
    if (state.queueBuilding) next.queueBuilding = false;
    return next;
  }

  function computeFetchSchedulePatchState({ status, backoffCount, now, jitterMs } = {}) {
    if (LOGIC && LOGIC.computeFetchSchedulePatch) {
      return LOGIC.computeFetchSchedulePatch({ status, backoffCount, now, jitterMs });
    }
    const schedule = computeNextFetchAt({ status, backoffCount });
    return {
      nextFetchAt: schedule.nextFetchAt,
      backoffCount: schedule.backoffCount
    };
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

  function computeFillPlanState({ queueLength, targetCount, pagesFetched, maxPages, nextUrl, status }) {
    if (LOGIC && LOGIC.computeFillPlan) {
      return LOGIC.computeFillPlan({ queueLength, targetCount, pagesFetched, maxPages, nextUrl, status });
    }
    const hasCapacity = Number.isFinite(targetCount) ? queueLength < targetCount : true;
    const underMax = Number.isFinite(maxPages) ? pagesFetched < maxPages : true;
    const ok = status === 200;
    const hasNext = Boolean(nextUrl);
    return { shouldContinue: hasCapacity && underMax && ok && hasNext };
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
      <div class="button-row" id="linuxdo-takeover-row" style="display:none;">
        <button id="linuxdo-takeover" class="warning">强制接管</button>
      </div>
    `;

    document.body.appendChild(panel);

    const toggleBtn = panel.querySelector("#linuxdo-toggle");
    const restartBtn = panel.querySelector("#linuxdo-restart");
    const targetInput = panel.querySelector("#linuxdo-target");
    const takeoverBtn = panel.querySelector("#linuxdo-takeover");
    const takeoverRow = panel.querySelector("#linuxdo-takeover-row");

    takeoverBtn.addEventListener("click", async () => {
      await stateLoaded;
      await setState({
        ownerId: null,
        ownerHeartbeat: 0,
        running: false,
        fetching: false,
        queueBuilding: false
      });
      updatePanel();
    });

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
    const takeoverRow = panel.querySelector("#linuxdo-takeover-row");

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
    if (takeoverRow) {
      takeoverRow.style.display = otherOwnerActive ? "flex" : "none";
    }
  }

  let storageListenerAdded = false;

  function loadState() {
    chrome.storage.local.get(DEFAULT_STATE, (state) => {
      currentState = { ...DEFAULT_STATE, ...state };
      updatePanel();
      stateLoadedResolve();
    });

    if (!storageListenerAdded) {
      storageListenerAdded = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        for (const [key, change] of Object.entries(changes)) {
          currentState[key] = change.newValue;
        }
        updatePanel();
      });
    }
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

  async function fillQueueFromApi(runId) {
    const isActive = () => currentState.running && currentState.runId === runId && isOwnerSelf();
    let pagesFetched = 0;
    let status = 200;

    while (isActive()) {
      const targetCount = getTargetCount();
      const queueLength = currentState.queue ? currentState.queue.length : 0;
      const nextUrl = currentState.nextApiUrl ? ensureJsonApiUrl(currentState.nextApiUrl) : null;
      const plan = computeFillPlanState({
        queueLength,
        targetCount,
        pagesFetched,
        maxPages: FILL_MAX_PAGES,
        nextUrl,
        status
      });
      if (!plan.shouldContinue) {
        break;
      }

      const result = await fetchMoreFromApi(runId);
      if (!result) {
        break;
      }
      pagesFetched += Number.isFinite(result.pagesFetched) ? result.pagesFetched : 0;
      status = Number.isFinite(result.status) ? result.status : status;
      if (status !== 200) {
        break;
      }
    }
  }

  async function fetchMoreFromApi(runId) {
    const isActive = () => currentState.running && currentState.runId === runId && isOwnerSelf();
    if (!isActive()) {
      console.log("[linuxdo-auto] fetchMoreFromApi: 不活跃，跳过");
      return null;
    }
    if (currentState.fetching) {
      console.log("[linuxdo-auto] fetchMoreFromApi: 已在获取中，跳过");
      return null;
    }

    const targetCount = getTargetCount();
    const existingQueue = Array.isArray(currentState.queue) ? currentState.queue : [];
    if (existingQueue.length >= targetCount) {
      console.log(`[linuxdo-auto] fetchMoreFromApi: 队列已满 ${existingQueue.length}>=${targetCount}，跳过`);
      return { added: 0 };
    }

    const batchSize = Math.min(
      Number.isFinite(currentState.batchSize) ? currentState.batchSize : BATCH_DEFAULTS.batchSize,
      targetCount - existingQueue.length
    );
    if (batchSize <= 0) {
      console.log("[linuxdo-auto] fetchMoreFromApi: batchSize<=0，跳过");
      return { added: 0 };
    }

    const maxPages = Number.isFinite(currentState.maxPages) ? currentState.maxPages : BATCH_DEFAULTS.maxPages;
    let nextUrl = ensureJsonApiUrl(currentState.nextApiUrl || API_LATEST_URL);
    if (!nextUrl) {
      console.log("[linuxdo-auto] fetchMoreFromApi: 没有下一页URL，跳过");
      return { added: 0 };
    }

    console.log(`[linuxdo-auto] fetchMoreFromApi: 开始获取，目标=${targetCount}，当前队列=${existingQueue.length}，batchSize=${batchSize}`);

    const historySet = historyToSet(getPrunedHistory());
    console.log(`[linuxdo-auto] fetchMoreFromApi: 历史记录数=${historySet.size}`);
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
        console.log(`[linuxdo-auto] fetchMoreFromApi: 等待冷却 ${Math.ceil((nextFetchAt - now) / 1000)}秒`);
        await sleep(nextFetchAt - now);
        if (!isActive()) break;
      }

      console.log(`[linuxdo-auto] fetchMoreFromApi: 请求 ${nextUrl}`);
      let res;
      try {
        res = await fetchWithTimeout(nextUrl, { credentials: "include" });
      } catch (err) {
        console.log(`[linuxdo-auto] fetchMoreFromApi: 请求失败 ${err.message}`);
        status = 0;
        const schedule = computeFetchSchedulePatchState({
          status,
          backoffCount,
          now: Date.now(),
          jitterMs: BATCH_JITTER
        });
        backoffCount = schedule.backoffCount;
        nextFetchAt = schedule.nextFetchAt;
        break;
      }

      lastFetchAt = Date.now();
      if (res.status === 429) {
        status = 429;
        const schedule = computeFetchSchedulePatchState({
          status: 429,
          backoffCount,
          now: Date.now(),
          jitterMs: BATCH_JITTER
        });
        backoffCount = schedule.backoffCount;
        nextFetchAt = schedule.nextFetchAt;
        console.log(`[linuxdo-auto] fetchMoreFromApi: 429限流，下次获取时间=${new Date(nextFetchAt).toLocaleTimeString()}，backoffCount=${backoffCount}`);
        break;
      }
      if (!res.ok) {
        status = res.status;
        const schedule = computeFetchSchedulePatchState({
          status: res.status,
          backoffCount,
          now: Date.now(),
          jitterMs: BATCH_JITTER
        });
        backoffCount = schedule.backoffCount;
        nextFetchAt = schedule.nextFetchAt;
        console.log(`[linuxdo-auto] fetchMoreFromApi: HTTP错误 ${res.status}`);
        break;
      }

      let data;
      try {
        data = await res.json();
      } catch (err) {
        console.log(`[linuxdo-auto] fetchMoreFromApi: JSON解析失败`);
        status = 0;
        const schedule = computeFetchSchedulePatchState({
          status,
          backoffCount,
          now: Date.now(),
          jitterMs: BATCH_JITTER
        });
        backoffCount = schedule.backoffCount;
        nextFetchAt = schedule.nextFetchAt;
        break;
      }

      const topics = data && data.topic_list && Array.isArray(data.topic_list.topics)
        ? data.topic_list.topics
        : [];

      console.log(`[linuxdo-auto] fetchMoreFromApi: 获取到 ${topics.length} 个帖子`);

      if (topics.length === 0) {
        console.log(`[linuxdo-auto] fetchMoreFromApi: 没有更多帖子`);
        break;
      }

      let skippedHistory = 0;
      let skippedSeen = 0;
      for (const topic of topics) {
        if (!topic || !topic.slug || !topic.id) continue;
        if (historySet.has(topic.id)) {
          skippedHistory++;
          continue;
        }
        const href = new URL(`/t/${topic.slug}/${topic.id}`, location.origin).href;
        const normalized = normalizeUrl(href);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          queue.push(href);
          fetchedCount += 1;
        } else {
          skippedSeen++;
        }
        if (fetchedCount >= batchSize) break;
      }
      console.log(`[linuxdo-auto] fetchMoreFromApi: 添加=${fetchedCount}，跳过(历史)=${skippedHistory}，跳过(已见)=${skippedSeen}`);

      const more = data && data.topic_list && data.topic_list.more_topics_url
        ? data.topic_list.more_topics_url
        : null;
      nextUrl = more ? ensureJsonApiUrl(more) : null;
      console.log(`[linuxdo-auto] fetchMoreFromApi: 下一页=${nextUrl || '无'}`);

      pagesFetched += 1;
      const plan = computeBatchPlanState({
        batchSize,
        maxPages,
        pagesFetched,
        fetchedCount
      });
      if (!plan.shouldContinue) {
        console.log(`[linuxdo-auto] fetchMoreFromApi: 批次完成，pagesFetched=${pagesFetched}，fetchedCount=${fetchedCount}`);
        break;
      }

      const schedule = computeNextFetchAt({ status: 200, backoffCount: 0 });
      backoffCount = schedule.backoffCount;
      nextFetchAt = schedule.nextFetchAt;
    }

    console.log(`[linuxdo-auto] fetchMoreFromApi: 结束，总添加=${fetchedCount}，最终队列=${queue.length}，status=${status}`);

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

    return { added: fetchedCount, status, pagesFetched };
  }

  async function maybeFetchMore(runId, { force = false } = {}) {
    const isActive = () => currentState.running && currentState.runId === runId && isOwnerSelf();
    if (!isActive()) {
      console.log("[linuxdo-auto] maybeFetchMore: 不活跃，跳过");
      return null;
    }

    const targetCount = getTargetCount();
    const totalQueued = currentState.queue ? currentState.queue.length : 0;
    if (totalQueued >= targetCount) {
      console.log(`[linuxdo-auto] maybeFetchMore: 队列已满 ${totalQueued}>=${targetCount}，跳过`);
      return null;
    }

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

    console.log(`[linuxdo-auto] maybeFetchMore: remaining=${remaining}, lowWater=${lowWater}, canFetch=${canFetch}, force=${force}, nextFetchAt=${currentState.nextFetchAt ? new Date(currentState.nextFetchAt).toLocaleTimeString() : 'N/A'}`);

    if (!canFetch) {
      if (force && remaining === 0 && Number.isFinite(currentState.nextFetchAt) && now < currentState.nextFetchAt) {
        const waitMs = currentState.nextFetchAt - now;
        console.log(`[linuxdo-auto] maybeFetchMore: force模式，等待 ${Math.ceil(waitMs / 1000)} 秒后重试`);
        await sleep(waitMs);
        if (!isActive()) return null;
        return await maybeFetchMore(runId, { force: true });
      }
      console.log("[linuxdo-auto] maybeFetchMore: 条件不满足，跳过");
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
    if (!isActive()) {
      console.log("[linuxdo-auto] runLoop: 不活跃，退出");
      return;
    }

    if (window.__linuxdoAutoRunning) {
      console.log("[linuxdo-auto] runLoop: 已在运行中，退出");
      return;
    }
    window.__linuxdoAutoRunning = true;

    console.log(`[linuxdo-auto] runLoop: 开始，runId=${runId}, index=${currentState.index}, queue=${currentState.queue?.length || 0}`);

    try {
      const targetCount = getTargetCount();
      console.log(`[linuxdo-auto] runLoop: targetCount=${targetCount}`);

      if (currentState.queueBuilding) {
        console.log("[linuxdo-auto] runLoop: queueBuilding=true，尝试获取更多");
        await fillQueueFromApi(runId);
        if (!isActive()) return;
        if (!currentState.queue || currentState.queue.length === 0) {
          console.log("[linuxdo-auto] runLoop: 队列为空，从DOM构建");
          const queue = await buildQueueFromDom(targetCount, runId);
          if (!isActive()) return;
          if (!queue || queue.length === 0) {
            console.log("[linuxdo-auto] runLoop: DOM构建失败，停止");
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
        console.log("[linuxdo-auto] runLoop: 队列为空，尝试获取");
        await fillQueueFromApi(runId);
        if (!isActive()) return;
        if (!currentState.queue || currentState.queue.length === 0) {
          console.log("[linuxdo-auto] runLoop: 仍为空，从DOM构建");
          const queue = await buildQueueFromDom(targetCount, runId);
          if (!isActive()) return;
          if (!queue || queue.length === 0) {
            console.log("[linuxdo-auto] runLoop: DOM构建失败，停止");
            await stopRunning();
            return;
          }
        }
      }

      if (currentState.index >= targetCount) {
        console.log(`[linuxdo-auto] runLoop: 已达目标 ${currentState.index}>=${targetCount}，停止`);
        await stopRunning();
        return;
      }

      if (currentState.index >= (currentState.queue ? currentState.queue.length : 0)) {
        console.log(`[linuxdo-auto] runLoop: index(${currentState.index}) >= queue.length(${currentState.queue?.length})，尝试获取更多`);
        await maybeFetchMore(runId, { force: true });
        if (!isActive()) return;
        if (currentState.index >= (currentState.queue ? currentState.queue.length : 0)) {
          // 如果还在冷却中且未达到目标，等待后重试
          if (currentState.index < targetCount && currentState.backoffCount > 0 && currentState.nextFetchAt > Date.now()) {
            const waitMs = currentState.nextFetchAt - Date.now();
            console.log(`[linuxdo-auto] runLoop: 429 冷却中，等待 ${Math.ceil(waitMs / 1000)} 秒后重试...`);
            await sleep(waitMs);
            if (!isActive()) return;
            await maybeFetchMore(runId, { force: true });
            if (!isActive()) return;
            if (currentState.index < (currentState.queue ? currentState.queue.length : 0)) {
              console.log(`[linuxdo-auto] runLoop: 冷却后获取成功，继续`);
              location.href = currentState.queue[currentState.index];
              return;
            }
          }
          console.log("[linuxdo-auto] runLoop: 无法获取更多，停止");
          await stopRunning();
          return;
        }
      }

      void maybeFetchMore(runId);

      const targetUrl = currentState.queue[currentState.index];
      const current = normalizeUrl(location.href);
      const target = normalizeUrl(targetUrl);

      console.log(`[linuxdo-auto] runLoop: 当前=${current}, 目标=${target}`);

      if (current !== target) {
        console.log(`[linuxdo-auto] runLoop: 跳转到 ${targetUrl}`);
        location.href = targetUrl;
        return;
      }

      const delay = rand(currentState.minDelay, currentState.maxDelay) * 1000;
      console.log(`[linuxdo-auto] runLoop: 等待 ${Math.ceil(delay / 1000)} 秒`);
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
      console.log(`[linuxdo-auto] runLoop: 完成 ${currentState.index}/${targetCount}`);
      if (!isActive()) return;

      if (currentState.index >= targetCount) {
        console.log(`[linuxdo-auto] runLoop: 已达目标，停止`);
        await stopRunning();
        return;
      }

      if (currentState.index >= (currentState.queue ? currentState.queue.length : 0)) {
        console.log(`[linuxdo-auto] runLoop: 队列用完，尝试获取更多`);
        await maybeFetchMore(runId, { force: true });
        if (!isActive()) return;
        if (currentState.index >= (currentState.queue ? currentState.queue.length : 0)) {
          // 如果还在冷却中且未达到目标，等待后重试
          if (currentState.index < targetCount && currentState.backoffCount > 0 && currentState.nextFetchAt > Date.now()) {
            const waitMs = currentState.nextFetchAt - Date.now();
            console.log(`[linuxdo-auto] runLoop: 429 冷却中，等待 ${Math.ceil(waitMs / 1000)} 秒后重试...`);
            await sleep(waitMs);
            if (!isActive()) return;
            await maybeFetchMore(runId, { force: true });
            if (!isActive()) return;
            if (currentState.index < (currentState.queue ? currentState.queue.length : 0)) {
              console.log(`[linuxdo-auto] runLoop: 冷却后获取成功，继续`);
              location.href = currentState.queue[currentState.index];
              return;
            }
          }
          console.log("[linuxdo-auto] runLoop: 无法获取更多，停止");
          await stopRunning();
          return;
        }
      }

      console.log(`[linuxdo-auto] runLoop: 跳转到下一个 ${currentState.queue[currentState.index]}`);
      location.href = currentState.queue[currentState.index];
    } catch (err) {
      console.error("[linuxdo-auto] runLoop error:", err);
      await stopRunning();
    } finally {
      window.__linuxdoAutoRunning = false;
    }
  }

  async function resumeIfNeeded() {
    await stateLoaded;
    await ensureHistoryPruned();
    const stalePatch = computeStaleFlagPatchState(currentState, { ttlMs: OWNER_TTL_MS });
    if (stalePatch && Object.keys(stalePatch).length > 0) {
      await setState(stalePatch);
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
