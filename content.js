(() => {
  const DEFAULT_MIN = 1;
  const DEFAULT_MAX = 3;
  const PANEL_ID = "linuxdo-auto-panel";
  const LOGIC = window.LinuxdoLogic || null;
  const TARGET_DEFAULT = LOGIC && LOGIC.DEFAULTS ? LOGIC.DEFAULTS.defaultTarget : 1000;
  const TARGET_MIN = LOGIC && LOGIC.DEFAULTS ? LOGIC.DEFAULTS.minTarget : 1;
  const TARGET_MAX = LOGIC && LOGIC.DEFAULTS ? LOGIC.DEFAULTS.maxTarget : 1000;

  const DEFAULT_STATE = {
    running: false,
    queue: [],
    index: 0,
    minDelay: DEFAULT_MIN,
    maxDelay: DEFAULT_MAX,
    queueBuilding: false,
    targetCount: TARGET_DEFAULT,
    runId: 0
  };

  let currentState = { ...DEFAULT_STATE };
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
      await setState({ targetCount: finalValue });
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
        await setState({ running: false, queueBuilding: false });
        updatePanel();
        return;
      }
      const patch = LOGIC && LOGIC.buildStartPatch
        ? LOGIC.buildStartPatch(currentState)
        : { running: true, runId: (currentState.runId || 0) + 1 };
      await setState(patch);
      updatePanel();
      await runLoop();
    });

    restartBtn.addEventListener("click", async () => {
      await stateLoaded;
      const patch = LOGIC && LOGIC.buildRestartPatch
        ? LOGIC.buildRestartPatch(currentState)
        : {
          running: true,
          queue: [],
          index: 0,
          queueBuilding: true,
          runId: (currentState.runId || 0) + 1
        };
      await setState(patch);
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

    let status = "空闲";
    if (currentState.queueBuilding) {
      status = "构建中";
    } else if (currentState.running) {
      status = "运行中";
    } else if (currentState.queue && currentState.queue.length > 0 && currentState.index >= currentState.queue.length) {
      status = "已完成";
    }

    statusEl.textContent = status;
    progressEl.textContent = `${done}/${total}`;
    toggleBtn.textContent = currentState.running ? "暂停" : "开始";
    toggleBtn.disabled = currentState.queueBuilding;
    restartBtn.disabled = currentState.queueBuilding;
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

  async function buildQueueFromApi(target) {
    const urls = [];
    const seen = new Set();
    let nextUrl = "https://linux.do/latest.json";
    let lastUrl = null;
    let pages = 0;

    while (nextUrl && urls.length < target && pages < 80) {
      if (nextUrl === lastUrl) {
        break;
      }
      lastUrl = nextUrl;
      const res = await fetch(nextUrl, { credentials: "include" });
      if (!res.ok) {
        return null;
      }

      let data;
      try {
        data = await res.json();
      } catch (err) {
        return null;
      }

      const topics = data && data.topic_list && Array.isArray(data.topic_list.topics)
        ? data.topic_list.topics
        : [];

      if (topics.length === 0) {
        break;
      }

      for (const topic of topics) {
        if (!topic || !topic.slug || !topic.id) continue;
        const href = new URL(`/t/${topic.slug}/${topic.id}`, location.origin).href;
        if (!seen.has(href)) {
          seen.add(href);
          urls.push(href);
        }
        if (urls.length >= target) break;
      }

      const more = data && data.topic_list && data.topic_list.more_topics_url
        ? data.topic_list.more_topics_url
        : null;
      nextUrl = more ? new URL(more, location.origin).href : null;
      pages += 1;
    }

    return urls.length ? urls : null;
  }

  async function buildQueueFromDom(target) {
    await setState({ queueBuilding: true });

    if (location.pathname !== "/latest") {
      location.href = "https://linux.do/latest";
      return null;
    }

    await waitForTopics(15000);

    const urls = [];
    const seen = new Set();
    let noNew = 0;

    for (let i = 0; i < 300 && urls.length < target && noNew < 6; i += 1) {
      if (!currentState.running) {
        break;
      }

      const links = Array.from(document.querySelectorAll("a.title"));
      const before = seen.size;

      for (const link of links) {
        if (!link || !link.href) continue;
        const href = link.href;
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

  async function ensureQueue() {
    if (currentState.queue && currentState.queue.length > 0) {
      return currentState.queue;
    }
    const targetCount = getTargetCount();
    const apiQueue = await buildQueueFromApi(targetCount);
    if (apiQueue && apiQueue.length > 0) {
      await setState({ queue: apiQueue, index: 0 });
      return apiQueue;
    }
    return await buildQueueFromDom(targetCount);
  }

  async function runLoop() {
    await stateLoaded;
    const runId = currentState.runId;
    const isActive = () => currentState.running && currentState.runId === runId;
    if (!isActive()) return;

    if (window.__linuxdoAutoRunning) {
      return;
    }
    window.__linuxdoAutoRunning = true;

    try {
      if (currentState.queueBuilding) {
        const queue = await buildQueueFromDom(getTargetCount());
        if (!isActive()) return;
        if (!queue || queue.length === 0) {
          if (LOGIC && LOGIC.shouldStopWhenQueueEmpty) {
            if (LOGIC.shouldStopWhenQueueEmpty(currentState)) {
              await setState({ queueBuilding: false, running: false });
            }
          } else {
            await setState({ queueBuilding: false, running: false });
          }
          return;
        }
      }

      const queue = await ensureQueue();
      if (!isActive()) return;
      if (!queue || queue.length === 0) {
        if (LOGIC && LOGIC.shouldStopWhenQueueEmpty) {
          if (LOGIC.shouldStopWhenQueueEmpty(currentState)) {
            await setState({ running: false, queueBuilding: false });
          }
        } else {
          await setState({ running: false, queueBuilding: false });
        }
        return;
      }

      if (currentState.index >= queue.length) {
        await setState({ running: false });
        return;
      }

      const targetUrl = queue[currentState.index];
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

      await setState({ index: currentState.index + 1 });
      if (!isActive()) return;

      if (currentState.index >= queue.length) {
        await setState({ running: false });
        return;
      }

      location.href = queue[currentState.index];
    } finally {
      window.__linuxdoAutoRunning = false;
    }
  }

  async function resumeIfNeeded() {
    await stateLoaded;

    if (currentState.queueBuilding) {
      await buildQueueFromDom(getTargetCount());
    }

    if (currentState.running) {
      await runLoop();
    }
  }

  createPanel();
  loadState();
  resumeIfNeeded();
})();
