(() => {
  // 仅保留“抽奖标签自动回复”能力：面板 + 监控 + 自动回复。
  const PANEL_ID = "linuxdo-auto-panel";
  const PANEL_HANDLE_ID = "linuxdo-auto-panel-handle";
  const LOGIC = window.LinuxdoLogic;
  if (!LOGIC) {
    console.error("[linuxdo-auto] logic.js 未加载，停止执行 content 脚本");
    return;
  }

  const API_LATEST_URL = "https://linux.do/latest.json";
  const MONITOR_DEFAULTS = LOGIC.MONITOR_DEFAULTS;
  const OWNER_TTL_MS = LOGIC.OWNER_DEFAULTS.ttlMs;
  const PANEL_DEFAULTS = LOGIC.PANEL_DEFAULTS;
  const MONITOR_INTERVAL_MS = MONITOR_DEFAULTS.intervalMs;
  const MONITOR_MAX_PAGES = MONITOR_DEFAULTS.maxPages;
  const MONITOR_TOPIC_DELAY_MIN_MS = MONITOR_DEFAULTS.topicDelayMinMs;
  const MONITOR_TOPIC_DELAY_MAX_MS = MONITOR_DEFAULTS.topicDelayMaxMs;
  const REPLY_SYNC_INTERVAL_MS = MONITOR_DEFAULTS.replySyncIntervalMs;
  const REPLY_SYNC_MAX_PAGES = MONITOR_DEFAULTS.replySyncMaxPages;
  const REPLY_ITEMS_MAX = MONITOR_DEFAULTS.replyItemsMax;
  const REPLY_HISTORY_MAX = MONITOR_DEFAULTS.replyHistoryMax;
  const REPLY_HISTORY_TTL_MS = MONITOR_DEFAULTS.replyHistoryTtlMs;
  const USER_ACTIONS_PAGE_SIZE = 30;
  const MONITOR_TAGS = LOGIC.TAG_DEFAULTS;
  const FETCH_TIMEOUT_MS = 8000;
  const SESSION_ID_KEY = "__linuxdoAutoInstanceId";

  // 每个标签页生成稳定实例 ID，用于“监控所有权”互斥。
  const INSTANCE_ID = (() => {
    try {
      const existing = sessionStorage.getItem(SESSION_ID_KEY);
      if (existing) return existing;
      const next = crypto.randomUUID();
      sessionStorage.setItem(SESSION_ID_KEY, next);
      return next;
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

  // 监控模式状态：不再包含自动浏览队列字段。
  const DEFAULT_STATE = {
    monitorEnabled: Boolean(MONITOR_DEFAULTS.enabledByDefault),
    monitorOwnerId: null,
    monitorOwnerHeartbeat: 0,
    monitorLastCheckAt: 0,
    monitorNextCheckAt: 0,
    monitorBackoffCount: 0,
    panelCollapsed: LOGIC.sanitizePanelCollapsed(undefined, PANEL_DEFAULTS),
    monitorReplyHistory: [],
    monitorReplyItems: [],
    monitorReplySyncAt: 0,
    monitorUsername: null,
    monitorUserId: null,
    monitorRunning: false
  };

  let currentState = { ...DEFAULT_STATE };
  let monitorHeartbeatTimer = null;
  let monitorTimer = null;
  let monitorTicking = false;
  let extensionContextInvalidated = false;
  let replyItemsInitRequested = false;
  let storageListenerAdded = false;
  let stateLoadedResolve;
  const stateLoaded = new Promise((resolve) => {
    stateLoadedResolve = resolve;
  });

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 将站点返回的相对/非 json URL 统一转换成 json 接口地址。
  function ensureJsonApiUrl(url) {
    return LOGIC.ensureJsonApiUrl(url, { base: location.origin });
  }

  // 通用活跃判断，供监控所有权复用。
  function isOwnerActive(ownerId, heartbeat) {
    return LOGIC.isOwnerActive(ownerId, heartbeat, { ttlMs: OWNER_TTL_MS });
  }

  function isMonitorOwnerActive(ownerId, heartbeat) {
    return isOwnerActive(ownerId, heartbeat);
  }

  function isMonitorOwnerSelf() {
    return currentState.monitorOwnerId === INSTANCE_ID;
  }

  // 争抢监控所有权：同一时刻只允许一个标签页跑监控。
  async function claimMonitorOwnership() {
    const active = isMonitorOwnerActive(currentState.monitorOwnerId, currentState.monitorOwnerHeartbeat);
    if (active && !isMonitorOwnerSelf()) return false;
    await setState({ monitorOwnerId: INSTANCE_ID, monitorOwnerHeartbeat: Date.now() });
    return true;
  }

  function stopMonitorHeartbeat() {
    if (!monitorHeartbeatTimer) return;
    clearInterval(monitorHeartbeatTimer);
    monitorHeartbeatTimer = null;
  }

  function stopMonitorSchedulers() {
    if (monitorTimer) {
      clearTimeout(monitorTimer);
      monitorTimer = null;
    }
    stopMonitorHeartbeat();
  }

  // 心跳续租，防止所有权在运行中失效。
  function startMonitorHeartbeat() {
    if (monitorHeartbeatTimer) return;
    const intervalMs = Math.max(2000, Math.floor(OWNER_TTL_MS / 2));
    const tick = async () => {
      if (!currentState.monitorEnabled || !isMonitorOwnerSelf()) {
        stopMonitorHeartbeat();
        return;
      }
      await setState({ monitorOwnerId: INSTANCE_ID, monitorOwnerHeartbeat: Date.now() });
    };
    monitorHeartbeatTimer = setInterval(tick, intervalMs);
    void tick();
  }

  // 释放监控所有权，并停止计时器。
  async function releaseMonitorOwnership(patch = {}) {
    stopMonitorSchedulers();
    const nextPatch = { monitorRunning: false, ...patch };
    if (isMonitorOwnerSelf()) {
      nextPatch.monitorOwnerId = null;
      nextPatch.monitorOwnerHeartbeat = 0;
    }
    await setState(nextPatch);
  }

  // 回复历史维护：按 TTL + 上限裁剪，避免存储无限增长。
  function getPrunedReplyHistory() {
    const now = Date.now();
    const safe = Array.isArray(currentState.monitorReplyHistory) ? currentState.monitorReplyHistory : [];
    const filtered = safe.filter((entry) => {
      return entry
        && Number.isFinite(entry.id)
        && Number.isFinite(entry.ts)
        && now - entry.ts <= REPLY_HISTORY_TTL_MS;
    });
    filtered.sort((a, b) => b.ts - a.ts);
    return filtered.slice(0, REPLY_HISTORY_MAX);
  }

  function historiesEqual(a, b) {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      const l = left[i];
      const r = right[i];
      if (!l || !r || l.id !== r.id || l.ts !== r.ts) return false;
    }
    return true;
  }

  function replyHistoryToSet(entries) {
    const safe = Array.isArray(entries) ? entries : [];
    return new Set(safe.map((entry) => entry && entry.id).filter(Number.isFinite));
  }

  function addReplyHistoryEntry(entries, id, options = {}) {
    if (!Number.isFinite(id)) {
      return getPrunedReplyHistory();
    }
    const now = Number.isFinite(options.ts) ? options.ts : Date.now();
    const safe = Array.isArray(entries) ? entries : [];
    const next = [{ id, ts: now }, ...safe.filter((entry) => entry && entry.id !== id)];
    const filtered = next.filter((entry) => {
      return entry
        && Number.isFinite(entry.id)
        && Number.isFinite(entry.ts)
        && now - entry.ts <= REPLY_HISTORY_TTL_MS;
    });
    filtered.sort((a, b) => b.ts - a.ts);
    return filtered.slice(0, REPLY_HISTORY_MAX);
  }

  // 面板展示用的回复记录（含标题/链接）。
  function getPrunedReplyItems(entries = currentState.monitorReplyItems) {
    const now = Date.now();
    const safe = Array.isArray(entries) ? entries : [];
    const filtered = safe.filter((entry) => {
      return entry
        && Number.isFinite(entry.id)
        && Number.isFinite(entry.ts)
        && now - entry.ts <= REPLY_HISTORY_TTL_MS;
    });
    filtered.sort((a, b) => b.ts - a.ts);
    return filtered.slice(0, REPLY_ITEMS_MAX);
  }

  function replyItemsEqual(a, b) {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      const l = left[i];
      const r = right[i];
      if (!l || !r) return false;
      if (l.id !== r.id || l.ts !== r.ts || l.title !== r.title || l.url !== r.url || l.postNumber !== r.postNumber) {
        return false;
      }
    }
    return true;
  }

  function addReplyItemEntry(entries, item = {}) {
    if (!item || !Number.isFinite(item.id)) {
      return getPrunedReplyItems(entries);
    }
    const now = Number.isFinite(item.ts) ? item.ts : Date.now();
    const safe = Array.isArray(entries) ? entries : [];
    const nextItem = {
      id: item.id,
      title: typeof item.title === "string" ? item.title.trim() : "",
      url: typeof item.url === "string" ? item.url : "",
      postNumber: Number.isFinite(item.postNumber) ? item.postNumber : null,
      ts: now
    };
    const next = [nextItem, ...safe.filter((entry) => entry && entry.id !== item.id)];
    const filtered = next.filter((entry) => {
      return entry
        && Number.isFinite(entry.id)
        && Number.isFinite(entry.ts)
        && now - entry.ts <= REPLY_HISTORY_TTL_MS;
    });
    filtered.sort((a, b) => b.ts - a.ts);
    return filtered.slice(0, REPLY_ITEMS_MAX);
  }

  function buildReplyItemFromTopic(topic, options = {}) {
    if (!topic || !Number.isFinite(topic.id)) return null;
    const slug = typeof topic.slug === "string" ? topic.slug.trim() : null;
    const url = slug ? `/t/${slug}/${topic.id}` : `/t/${topic.id}`;
    const ts = Number.isFinite(options.ts) ? options.ts : Date.now();
    return {
      id: topic.id,
      title: typeof topic.title === "string" ? topic.title : "",
      url,
      postNumber: Number.isFinite(options.postNumber) ? options.postNumber : null,
      ts
    };
  }

  function buildReplyItemFromAction(action) {
    if (!action || !Number.isFinite(action.topic_id)) return null;
    const slug = typeof action.slug === "string" ? action.slug.trim() : null;
    const postNumber = Number.isFinite(action.post_number) ? action.post_number : null;
    const url = slug
      ? `/t/${slug}/${action.topic_id}/${postNumber || 1}`
      : `/t/${action.topic_id}/${postNumber || 1}`;
    const parsed = action.created_at ? Date.parse(action.created_at) : NaN;
    const ts = Number.isFinite(parsed) ? parsed : Date.now();
    return {
      id: action.topic_id,
      title: typeof action.title === "string" ? action.title : "",
      url,
      postNumber,
      ts
    };
  }

  function formatReplyItemTime(ts) {
    if (!Number.isFinite(ts)) return "";
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // 自动回复成功后通知 background 触发系统通知。
  function notifyAutoReply(topic, timeLabel) {
    if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return;
    if (!topic || !Number.isFinite(topic.id)) return;
    try {
      const item = buildReplyItemFromTopic(topic);
      chrome.runtime.sendMessage({
        type: "linuxdo:notify-reply",
        topicId: topic.id,
        topicTitle: topic.title || "",
        url: item && item.url ? item.url : "",
        timeLabel: timeLabel || ""
      });
    } catch (err) {
      // ignore
    }
  }

  function renderReplyItems(listEl, items) {
    if (!listEl) return;
    listEl.textContent = "";
    if (!Array.isArray(items) || items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "reply-item empty";
      empty.textContent = "暂无记录";
      listEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      if (!item || !Number.isFinite(item.id)) continue;
      const li = document.createElement("li");
      li.className = "reply-item";
      const link = document.createElement("a");
      link.href = item.url || `/t/${item.id}`;
      link.textContent = item.title || `话题 ${item.id}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      const meta = document.createElement("span");
      meta.className = "reply-item-meta";
      const time = formatReplyItemTime(item.ts);
      const post = Number.isFinite(item.postNumber) ? `#${item.postNumber}` : "";
      meta.textContent = [time, post].filter(Boolean).join(" ");

      li.appendChild(link);
      if (meta.textContent) li.appendChild(meta);
      listEl.appendChild(li);
    }
  }

  async function ensureReplyHistoryPruned() {
    const pruned = getPrunedReplyHistory();
    if (!historiesEqual(pruned, currentState.monitorReplyHistory)) {
      await setState({ monitorReplyHistory: pruned });
    }
    return pruned;
  }

  async function ensureReplyItemsPruned() {
    const pruned = getPrunedReplyItems();
    if (!replyItemsEqual(pruned, currentState.monitorReplyItems)) {
      await setState({ monitorReplyItems: pruned });
    }
    return pruned;
  }

  function isPanelCollapsed(value = currentState.panelCollapsed) {
    return LOGIC.sanitizePanelCollapsed(value, PANEL_DEFAULTS);
  }

  // 面板渲染：状态文案、开关禁用态、收起/展开态统一在这里更新。
  function updatePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const monitorStatusEl = panel.querySelector("#linuxdo-monitor-status");
    const monitorToggle = panel.querySelector("#linuxdo-monitor-toggle");
    const panelCollapseBtn = panel.querySelector("#linuxdo-panel-collapse");
    const panelHandle = document.getElementById(PANEL_HANDLE_ID);
    const replySummaryEl = panel.querySelector("#linuxdo-reply-summary");
    const replyListEl = panel.querySelector("#linuxdo-reply-list");

    const collapsed = isPanelCollapsed();
    panel.classList.toggle("collapsed", collapsed);
    document.documentElement.classList.toggle("linuxdo-auto-panel-expanded", !collapsed);
    document.documentElement.classList.toggle("linuxdo-auto-panel-collapsed", collapsed);
    if (panelHandle) panelHandle.style.display = collapsed ? "inline-flex" : "none";
    if (panelCollapseBtn) {
      panelCollapseBtn.textContent = collapsed ? "展开" : "收起";
      panelCollapseBtn.setAttribute("aria-label", collapsed ? "展开面板" : "收起面板");
    }

    const monitorOwnerActive = isMonitorOwnerActive(currentState.monitorOwnerId, currentState.monitorOwnerHeartbeat);
    const monitorOtherOwnerActive = monitorOwnerActive && !isMonitorOwnerSelf();
    const monitorCoolingDown = currentState.monitorEnabled
      && currentState.monitorBackoffCount > 0
      && Number.isFinite(currentState.monitorNextCheckAt)
      && Date.now() < currentState.monitorNextCheckAt;

    if (monitorStatusEl) {
      let status = currentState.monitorEnabled ? "开启" : "关闭";
      let dotClass = "";
      if (monitorOtherOwnerActive) {
        status = "其他标签页运行中";
      } else if (currentState.monitorRunning) {
        status = "监控中";
        dotClass = "active";
      } else if (monitorCoolingDown) {
        status = "冷却中";
        dotClass = "cooling";
      } else if (currentState.monitorEnabled) {
        dotClass = "active";
      }
      const statusDot = panel.querySelector(".status-dot");
      if (statusDot) {
        statusDot.className = "status-dot" + (dotClass ? " " + dotClass : "");
      }
      const statusText = monitorStatusEl.querySelector(".status-text");
      if (statusText) {
        statusText.textContent = status;
      } else {
        monitorStatusEl.textContent = status;
      }
    }

    if (monitorToggle) {
      monitorToggle.checked = Boolean(currentState.monitorEnabled);
      monitorToggle.disabled = monitorOtherOwnerActive;
    }

    const items = getPrunedReplyItems();
    if (replySummaryEl) {
      const summaryText = replySummaryEl.querySelector(".summary-text");
      if (summaryText) {
        summaryText.textContent = `已回复话题（最近 ${items.length}/${REPLY_ITEMS_MAX}）`;
      } else {
        replySummaryEl.textContent = `📋 已回复话题（最近 ${items.length}/${REPLY_ITEMS_MAX}）`;
      }
    }
    renderReplyItems(replyListEl, items);
  }

  // 右侧嵌入面板 + 手柄按钮。
  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="title-row">
        <div class="title">🎰 Linux.do 抽奖自动回复</div>
        <button id="linuxdo-panel-collapse" class="panel-collapse-btn" type="button">收起</button>
      </div>
      <div class="status-card">
        <div class="row">
          <span class="row-label">监控状态</span>
          <span class="monitor-status" id="linuxdo-monitor-status"><span class="status-dot"></span><span class="status-text">关闭</span></span>
        </div>
        <div class="row">
          <span class="row-label">自动回复</span>
          <label class="switch">
            <input id="linuxdo-monitor-toggle" type="checkbox" />
            <span class="slider"></span>
          </label>
        </div>
      </div>
      <details class="reply-history" id="linuxdo-reply-history">
        <summary id="linuxdo-reply-summary"><span class="summary-text">📋 已回复话题</span></summary>
        <ul id="linuxdo-reply-list"></ul>
      </details>
    `;
    document.body.appendChild(panel);

    let panelHandle = document.getElementById(PANEL_HANDLE_ID);
    if (!panelHandle) {
      panelHandle = document.createElement("button");
      panelHandle.id = PANEL_HANDLE_ID;
      panelHandle.type = "button";
      panelHandle.textContent = "🎰 面板";
      panelHandle.setAttribute("aria-label", "显示面板");
      document.body.appendChild(panelHandle);
    }

    const monitorToggle = panel.querySelector("#linuxdo-monitor-toggle");
    const panelCollapseBtn = panel.querySelector("#linuxdo-panel-collapse");

    if (monitorToggle) {
      monitorToggle.addEventListener("change", async () => {
        await stateLoaded;
        const enabled = monitorToggle.checked;
        if (!enabled) {
          await releaseMonitorOwnership({
            monitorEnabled: false,
            monitorNextCheckAt: 0,
            monitorBackoffCount: 0
          });
          return;
        }
        await setState({ monitorEnabled: true });
        scheduleMonitor(0);
      });
    }

    if (panelCollapseBtn) {
      panelCollapseBtn.addEventListener("click", async () => {
        await stateLoaded;
        await setState({ panelCollapsed: !isPanelCollapsed() });
      });
    }

    if (panelHandle) {
      panelHandle.addEventListener("click", async () => {
        await stateLoaded;
        await setState({ panelCollapsed: false });
      });
    }

    updatePanel();
  }

  function setState(patch) {
    return new Promise((resolve) => {
      if (extensionContextInvalidated) {
        resolve();
        return;
      }
      currentState = { ...currentState, ...patch };
      if (!chrome || !chrome.storage || !chrome.storage.local || !chrome.runtime || !chrome.runtime.id) {
        updatePanel();
        resolve();
        return;
      }
      try {
        chrome.storage.local.set(patch, () => {
          updatePanel();
          resolve();
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err || "");
        if (message.includes("Extension context invalidated")) {
          extensionContextInvalidated = true;
          stopMonitorSchedulers();
          resolve();
          return;
        }
        console.error("[linuxdo-auto] setState failed", err);
        resolve();
      }
    });
  }

  // 首次读取持久化状态，并订阅 storage 变化。
  function loadState() {
    chrome.storage.local.get(DEFAULT_STATE, (state) => {
      currentState = {
        ...DEFAULT_STATE,
        ...state,
        panelCollapsed: isPanelCollapsed(state.panelCollapsed)
      };
      updatePanel();
      stateLoadedResolve();
      void syncReplyItemsOnStartup();
    });

    if (storageListenerAdded) return;
    storageListenerAdded = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      for (const [key, change] of Object.entries(changes)) {
        currentState[key] = change.newValue;
      }
      if (Object.prototype.hasOwnProperty.call(changes, "panelCollapsed")) {
        currentState.panelCollapsed = isPanelCollapsed(changes.panelCollapsed.newValue);
      }
      updatePanel();

      if (Object.prototype.hasOwnProperty.call(changes, "monitorEnabled")) {
        if (changes.monitorEnabled.newValue) {
          scheduleMonitor(0);
        } else if (isMonitorOwnerSelf()) {
          void releaseMonitorOwnership();
        }
      }
    });
  }

  // 所有网络请求都加超时，避免单次请求卡死监控循环。
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

  // 429 走指数退避，其他失败短延迟后重试。
  function computeNextFetchAt({ status, backoffCount }) {
    return LOGIC.computeNextFetchAt({
      now: Date.now(),
      status,
      backoffCount,
      jitterMs: [2000, 5000]
    });
  }

  function computeMonitorTopicDelayMs() {
    return LOGIC.computeMonitorTopicDelayMs({
      minMs: MONITOR_TOPIC_DELAY_MIN_MS,
      maxMs: MONITOR_TOPIC_DELAY_MAX_MS
    });
  }

  // 仅处理“今天发布”的话题；created_at 缺失或非法时按 false 处理。
  function isTopicFromToday(createdAt) {
    const offsetMinutes = -new Date().getTimezoneOffset();
    return LOGIC.isTopicFromToday(createdAt, { offsetMinutes });
  }

  function shouldBreakMonitorTopicLoop(status) {
    return LOGIC.shouldBreakMonitorTopicLoop(status);
  }

  // 标签匹配：兼容 string[] 和对象标签数组。
  function matchMonitorKeyword(tags) {
    return LOGIC.matchTopicTags(tags, MONITOR_TAGS);
  }

  function buildReplyText() {
    return LOGIC.buildReplyText();
  }

  function readUsernameFromAvatar() {
    const avatar = document.querySelector("header img.avatar") || document.querySelector("img.avatar");
    const src = avatar ? avatar.getAttribute("src") : null;
    if (!src) return null;
    return LOGIC.parseUsernameFromAvatarSrc(src);
  }

  // 获取当前用户信息，优先走本地可用数据，尽量减少接口请求。
  async function getCurrentUserInfo() {
    const cachedId = Number.isFinite(currentState.monitorUserId) ? currentState.monitorUserId : null;
    const cachedUsername = typeof currentState.monitorUsername === "string" ? currentState.monitorUsername.trim() : "";
    if (Number.isFinite(cachedId) || cachedUsername) {
      return { id: cachedId, username: cachedUsername || null, status: 200 };
    }

    const domUsername = readUsernameFromAvatar();
    if (domUsername) {
      await setState({ monitorUsername: domUsername });
      return { id: cachedId, username: domUsername, status: 200 };
    }

    try {
      const discourseUser = window.Discourse
        && window.Discourse.User
        && typeof window.Discourse.User.current === "function"
        ? window.Discourse.User.current()
        : null;
      const discourseId = discourseUser && Number.isFinite(discourseUser.id) ? discourseUser.id : null;
      const discourseUsername = discourseUser && typeof discourseUser.username === "string"
        ? discourseUser.username.trim()
        : "";
      if (Number.isFinite(discourseId) || discourseUsername) {
        const patch = {};
        if (Number.isFinite(discourseId)) patch.monitorUserId = discourseId;
        if (discourseUsername) patch.monitorUsername = discourseUsername;
        if (Object.keys(patch).length > 0) await setState(patch);
        return { id: discourseId, username: discourseUsername || null, status: 200 };
      }
    } catch (err) {
      // ignore
    }

    let res;
    try {
      res = await fetchWithTimeout("/session/current.json", { credentials: "include" });
    } catch (err) {
      console.log(`[linuxdo-auto] monitor: 获取用户信息失败 ${err.message}`);
      return { id: null, username: null, status: 0 };
    }

    if (!res || !res.ok) {
      const status = res && Number.isFinite(res.status) ? res.status : 0;
      console.log(`[linuxdo-auto] monitor: 获取用户信息失败 ${status || "unknown"}`);
      return { id: null, username: null, status };
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      console.log("[linuxdo-auto] monitor: 解析用户信息失败");
      return { id: null, username: null, status: 0 };
    }

    const id = data && data.current_user && Number.isFinite(data.current_user.id)
      ? data.current_user.id
      : data && data.user && Number.isFinite(data.user.id)
        ? data.user.id
        : null;
    const username = data && data.current_user && typeof data.current_user.username === "string"
      ? data.current_user.username.trim()
      : data && data.user && typeof data.user.username === "string"
        ? data.user.username.trim()
        : null;

    const patch = {};
    if (Number.isFinite(id)) patch.monitorUserId = id;
    if (username) patch.monitorUsername = username;
    if (Object.keys(patch).length > 0) await setState(patch);

    if (Number.isFinite(id) || username) {
      return { id: Number.isFinite(id) ? id : null, username: username || null, status: 200 };
    }
    return { id: null, username: null, status: 0 };
  }

  function shouldSyncReplyHistory(now = Date.now()) {
    if (!Number.isFinite(REPLY_SYNC_INTERVAL_MS) || REPLY_SYNC_INTERVAL_MS <= 0) return false;
    const lastSync = Number.isFinite(currentState.monitorReplySyncAt) ? currentState.monitorReplySyncAt : 0;
    return now - lastSync >= REPLY_SYNC_INTERVAL_MS;
  }

  // 从用户行为接口同步“我已回复过的话题”，避免重复回复。
  async function syncReplyHistoryFromUserActions(username) {
    if (!username) return { status: 0 };

    let offset = 0;
    let pagesFetched = 0;
    let status = 200;
    let merged = getPrunedReplyHistory();
    let mergedItems = getPrunedReplyItems();

    while (pagesFetched < REPLY_SYNC_MAX_PAGES) {
      let res;
      try {
        const url = `/user_actions.json?username=${encodeURIComponent(username)}&filter=5&offset=${offset}`;
        res = await fetchWithTimeout(url, { credentials: "include" });
      } catch (err) {
        status = 0;
        break;
      }

      if (res.status === 429) {
        status = 429;
        break;
      }
      if (!res.ok) {
        status = res.status;
        break;
      }

      let data;
      try {
        data = await res.json();
      } catch (err) {
        status = 0;
        break;
      }

      const actions = data && Array.isArray(data.user_actions) ? data.user_actions : [];
      if (actions.length === 0) break;

      for (const action of actions) {
        const item = buildReplyItemFromAction(action);
        if (!item) continue;
        merged = addReplyHistoryEntry(merged, item.id, { ts: item.ts });
        mergedItems = addReplyItemEntry(mergedItems, item);
      }

      pagesFetched += 1;
      offset += actions.length;
      if (actions.length < USER_ACTIONS_PAGE_SIZE) break;
    }

    if (status === 200) {
      const patch = { monitorReplySyncAt: Date.now() };
      if (!historiesEqual(merged, currentState.monitorReplyHistory)) {
        patch.monitorReplyHistory = merged;
      }
      if (!replyItemsEqual(mergedItems, currentState.monitorReplyItems)) {
        patch.monitorReplyItems = mergedItems;
      }
      await setState(patch);
    } else if (status !== 429) {
      console.log(`[linuxdo-auto] monitor: 同步回复历史失败 ${status}`);
    }

    return { status };
  }

  async function syncReplyHistoryIfNeeded(username) {
    if (!username) return { status: 0 };
    if (!shouldSyncReplyHistory()) return { status: 200 };
    return await syncReplyHistoryFromUserActions(username);
  }

  async function fetchTopicDetail(topicId) {
    const url = `/t/${topicId}.json?track_visit=true&forceLoad=true`;
    try {
      const res = await fetchWithTimeout(url, { credentials: "include" });
      if (!res.ok) return { status: res.status, data: null };
      const data = await res.json();
      return { status: res.status, data };
    } catch (err) {
      return { status: 0, data: null };
    }
  }

  function hasUserReplied(detail, userId) {
    if (!detail) return false;
    const posts = detail.post_stream && Array.isArray(detail.post_stream.posts) ? detail.post_stream.posts : [];
    if (posts.some((post) => post && post.yours)) return true;
    if (Number.isFinite(userId)) {
      return posts.some((post) => post && post.user_id === userId);
    }
    return false;
  }

  function isReplyAllowed(detail) {
    if (!detail) return false;
    if (detail.closed || detail.archived) return false;
    if (detail.details && detail.details.can_create_post === false) return false;
    return true;
  }

  // 发送回复请求，使用页面 CSRF token。
  async function postReply(topicId, raw) {
    const tokenMeta = document.querySelector('meta[name="csrf-token"]');
    const token = tokenMeta ? tokenMeta.getAttribute("content") : null;
    if (!token) {
      console.log("[linuxdo-auto] monitor: 缺少CSRF token");
      return { ok: false, status: 0 };
    }

    const body = new URLSearchParams();
    body.set("topic_id", String(topicId));
    body.set("raw", raw);

    const res = await fetchWithTimeout("/posts.json", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRF-Token": token,
        "X-Requested-With": "XMLHttpRequest"
      },
      body
    });

    if (res.ok) {
      return { ok: true, status: res.status, payload: null };
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch (err) {
      // ignore
    }
    return { ok: false, status: res.status, payload };
  }

  async function recordTopicAsReplied(topic, repliedSet) {
    const next = addReplyHistoryEntry(getPrunedReplyHistory(), topic.id);
    const replyItem = buildReplyItemFromTopic(topic);
    const nextItems = addReplyItemEntry(getPrunedReplyItems(), replyItem);
    const patch = { monitorReplyHistory: next };
    if (!replyItemsEqual(nextItems, currentState.monitorReplyItems)) {
      patch.monitorReplyItems = nextItems;
    }
    await setState(patch);
    repliedSet.add(topic.id);
    return replyItem;
  }

  // 单话题处理：命中标签 -> 可回复校验 -> 自动回复 -> 更新历史。
  async function handleMonitorTopic(topic, repliedSet, userId) {
    if (!topic || !Number.isFinite(topic.id) || !topic.title) {
      return { status: 200, checked: false };
    }
    const topicCreatedAt = typeof topic.created_at === "string" ? topic.created_at : "";
    if (topicCreatedAt && !isTopicFromToday(topicCreatedAt)) {
      return { status: 200, checked: false };
    }
    if (!matchMonitorKeyword(topic.tags)) {
      return { status: 200, checked: false };
    }
    if (repliedSet.has(topic.id)) {
      return { status: 200, checked: false };
    }

    const detail = await fetchTopicDetail(topic.id);
    if (!detail || detail.status === 429) return { status: 429, checked: true };
    if (!detail.data) return { status: detail.status || 0, checked: true };
    const detailCreatedAt = detail.data && typeof detail.data.created_at === "string"
      ? detail.data.created_at
      : topicCreatedAt;
    if (!isTopicFromToday(detailCreatedAt)) {
      return { status: 200, checked: true };
    }

    if (hasUserReplied(detail.data, userId)) {
      await recordTopicAsReplied(topic, repliedSet);
      return { status: 200, checked: true };
    }

    if (!isReplyAllowed(detail.data)) return { status: 200, checked: true };

    const replyText = buildReplyText();
    if (!replyText) return { status: 200, checked: true };

    const posted = await postReply(topic.id, replyText);
    if (!posted.ok) {
      const failure = LOGIC.classifyReplyFailure({ status: posted.status, payload: posted.payload });

      if (failure.kind === "rate_limited") {
        return { status: 429, checked: true };
      }
      if (failure.markAsReplied) {
        await recordTopicAsReplied(topic, repliedSet);
        return { status: 200, checked: true };
      }
      if (posted.status === 422 || failure.kind === "rejected") {
        const reason = Array.isArray(failure.errors) && failure.errors.length > 0
          ? failure.errors.join(" | ")
          : "unknown";
        console.log(`[linuxdo-auto] monitor: 回复被拒绝 topic=${topic.id} status=${posted.status} reason=${reason}`);
        return { status: 200, checked: true };
      }
      return { status: posted.status || 0, checked: true };
    }

    const replyItem = await recordTopicAsReplied(topic, repliedSet);
    notifyAutoReply(topic, replyItem ? formatReplyItemTime(replyItem.ts) : "");
    return { status: 200, checked: true };
  }

  // 单次监控检查：用户信息、历史同步、扫描 latest 并处理候选话题。
  async function runMonitorCheck() {
    await ensureReplyHistoryPruned();
    await ensureReplyItemsPruned();

    const userInfo = await getCurrentUserInfo();
    const userStatus = LOGIC.computeMonitorUserStatus(userInfo);

    if (userStatus === 429) return { status: 429 };
    if (userStatus !== 200) return { status: userStatus };

    const syncResult = await syncReplyHistoryIfNeeded(userInfo.username);
    if (syncResult && syncResult.status === 429) return { status: 429 };

    const repliedSet = replyHistoryToSet(getPrunedReplyHistory());
    const userId = userInfo.id;
    let nextUrl = API_LATEST_URL;
    let pagesFetched = 0;
    let status = 200;

    while (nextUrl && pagesFetched < MONITOR_MAX_PAGES) {
      let res;
      try {
        res = await fetchWithTimeout(nextUrl, { credentials: "include" });
      } catch (err) {
        status = 0;
        break;
      }

      if (res.status === 429) {
        status = 429;
        break;
      }
      if (!res.ok) {
        status = res.status;
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
      for (const topic of topics) {
        const result = await handleMonitorTopic(topic, repliedSet, userId);
        if (result && Number.isFinite(result.status) && result.status !== 200) {
          status = result.status;
          if (shouldBreakMonitorTopicLoop(status)) {
            break;
          }
        }
        if (result && result.checked) {
          await sleep(computeMonitorTopicDelayMs());
        }
      }
      if (shouldBreakMonitorTopicLoop(status)) break;

      const more = data && data.topic_list && data.topic_list.more_topics_url
        ? data.topic_list.more_topics_url
        : null;
      nextUrl = more ? ensureJsonApiUrl(more) : null;
      pagesFetched += 1;
    }

    return { status };
  }

  function scheduleMonitor(delayMs) {
    if (extensionContextInvalidated) return;
    if (monitorTimer) clearTimeout(monitorTimer);
    const delay = Math.max(0, delayMs);
    monitorTimer = setTimeout(() => {
      void monitorTick();
    }, delay);
  }

  // 监控主循环：互斥 + 检查 + 退避调度。
  async function monitorTick() {
    if (extensionContextInvalidated) return;
    if (monitorTicking) return;
    monitorTicking = true;
    try {
      await stateLoaded;
      if (!currentState.monitorEnabled) {
        await releaseMonitorOwnership({ monitorEnabled: false, monitorNextCheckAt: 0, monitorBackoffCount: 0 });
        return;
      }

      const ownerActive = isMonitorOwnerActive(currentState.monitorOwnerId, currentState.monitorOwnerHeartbeat);
      if (ownerActive && !isMonitorOwnerSelf()) {
        scheduleMonitor(MONITOR_INTERVAL_MS);
        return;
      }

      if (!isMonitorOwnerSelf()) {
        const claimed = await claimMonitorOwnership();
        if (!claimed) {
          scheduleMonitor(MONITOR_INTERVAL_MS);
          return;
        }
      }

      startMonitorHeartbeat();

      const now = Date.now();
      if (Number.isFinite(currentState.monitorNextCheckAt) && currentState.monitorNextCheckAt > now) {
        scheduleMonitor(currentState.monitorNextCheckAt - now);
        return;
      }

      await setState({ monitorRunning: true });
      const result = await runMonitorCheck();
      const status = result && Number.isFinite(result.status) ? result.status : 0;

      const nextPatch = { monitorRunning: false, monitorLastCheckAt: Date.now() };
      if (status === 429) {
        const schedule = computeNextFetchAt({ status: 429, backoffCount: currentState.monitorBackoffCount });
        nextPatch.monitorNextCheckAt = schedule.nextFetchAt;
        nextPatch.monitorBackoffCount = schedule.backoffCount;
      } else if (status !== 200) {
        nextPatch.monitorNextCheckAt = Date.now() + MONITOR_INTERVAL_MS;
        nextPatch.monitorBackoffCount = 0;
      } else {
        nextPatch.monitorNextCheckAt = 0;
        nextPatch.monitorBackoffCount = 0;
      }
      await setState(nextPatch);
    } finally {
      monitorTicking = false;
    }

    if (!extensionContextInvalidated) {
      scheduleMonitor(MONITOR_INTERVAL_MS);
    }
  }

  // 启动时若本地无记录，拉取一次历史用于面板展示。
  async function syncReplyItemsOnStartup() {
    if (replyItemsInitRequested) return;
    replyItemsInitRequested = true;
    const existing = getPrunedReplyItems();
    if (existing.length > 0) return;

    const userInfo = await getCurrentUserInfo();
    if (!userInfo || !userInfo.username) return;

    const result = await syncReplyHistoryFromUserActions(userInfo.username);
    if (result && result.status === 429) {
      const schedule = computeNextFetchAt({ status: 429, backoffCount: currentState.monitorBackoffCount });
      await setState({
        monitorNextCheckAt: schedule.nextFetchAt,
        monitorBackoffCount: schedule.backoffCount
      });
    }
  }

  async function resumeMonitorIfNeeded() {
    await stateLoaded;
    if (!currentState.monitorEnabled) return;
    scheduleMonitor(0);
  }

  createPanel();
  loadState();
  void syncReplyItemsOnStartup();
  void resumeMonitorIfNeeded();
})();
