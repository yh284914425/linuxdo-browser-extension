# 自动回复通知与默认关闭 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 自动回复成功时弹出系统通知，并将抽奖监控默认关闭。

**Architecture:** content script 在自动回复成功后发送消息；service worker 统一触发系统通知并进行节流；默认开关状态通过 `logic.js` 默认值控制。

**Tech Stack:** Chrome Extension MV3, content script, service worker, `chrome.notifications`, Node.js unit tests.

---

### Task 1: 增加通知节流与默认值（逻辑层）

**Files:**
- Modify: `logic.js`
- Test: `tests/logic.test.js`

**Step 1: Write the failing test**

在 `tests/logic.test.js` 追加测试：

```js
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
```

并在文件底部调用测试函数。

**Step 2: Run test to verify it fails**

Run:

```bash
node tests/logic.test.js
```

Expected: FAIL，提示 `MONITOR_DEFAULTS.enabledByDefault` 或 `computeNotifyThrottle` 不存在。

**Step 3: Write minimal implementation**

在 `logic.js`：
- 在 `MONITOR_DEFAULTS` 中加入：
  - `enabledByDefault: false`
  - `notifyThrottleMs: 10 * 1000`
  - `notifyMaxPerWindow: 3`
- 新增并导出 `computeNotifyThrottle`：

```js
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
```

**Step 4: Run test to verify it passes**

```bash
node tests/logic.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/logic.test.js logic.js
git commit -m "feat: add notify defaults and throttle helper"
```

---

### Task 2: 集成系统通知与默认关闭

**Files:**
- Create: `background.js`
- Create: `icons/notify.png`
- Modify: `manifest.json`
- Modify: `content.js`

**Step 1: Write the failing test**

无自动化测试；使用手动验证（见 Step 4）。

**Step 2: Implement minimal code**

1) `manifest.json`：
- 增加权限 `"notifications"`
- 增加后台脚本：

```json
"background": { "service_worker": "background.js" }
```

2) `background.js`（核心逻辑）：

```js
importScripts('logic.js');

const LOGIC = globalThis.LinuxdoLogic || {};
const THROTTLE_MS = LOGIC.MONITOR_DEFAULTS?.notifyThrottleMs ?? 10_000;
const MAX_PER_WINDOW = LOGIC.MONITOR_DEFAULTS?.notifyMaxPerWindow ?? 3;
let notifyTimestamps = [];

function truncate(text, limit = 120) {
  const safe = String(text || '').trim();
  if (safe.length <= limit) return safe;
  return safe.slice(0, limit - 1) + '…';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'linuxdo:notify-reply') return;
  if (!chrome.notifications) return;

  const now = Date.now();
  const throttle = LOGIC.computeNotifyThrottle
    ? LOGIC.computeNotifyThrottle({
        timestamps: notifyTimestamps,
        now,
        windowMs: THROTTLE_MS,
        maxPerWindow: MAX_PER_WINDOW
      })
    : { allowed: true, timestamps: notifyTimestamps };

  notifyTimestamps = throttle.timestamps;
  if (!throttle.allowed) return;

  const title = '自动回复成功';
  const line = truncate(msg.topicTitle || '');
  const time = String(msg.timeLabel || '').trim();
  const message = [line, time].filter(Boolean).join(' · ');

  chrome.notifications.create({
    type: 'basic',
    title,
    message: message || '已自动回复抽奖话题',
    iconUrl: chrome.runtime.getURL('icons/notify.png')
  });
});
```

3) `content.js`：
- 默认关闭：

```js
monitorEnabled: LOGIC && LOGIC.MONITOR_DEFAULTS
  ? Boolean(LOGIC.MONITOR_DEFAULTS.enabledByDefault)
  : false,
```

- 在 `postReply` 成功后发送消息（只在自动回复成功分支）：

```js
function notifyAutoReply(topic, timeLabel) {
  if (!chrome?.runtime?.sendMessage) return;
  try {
    chrome.runtime.sendMessage({
      type: 'linuxdo:notify-reply',
      topicId: topic.id,
      topicTitle: topic.title || '',
      url: buildReplyItemFromTopic(topic)?.url || '',
      timeLabel
    });
  } catch (_) {
    // ignore
  }
}
```

并在 `posted.ok` 分支中调用，`timeLabel` 可用 `formatReplyItemTime(Date.now())`。

4) 添加 `icons/notify.png`（128x128 简单图标）。

**Step 3: Manual verification**

- 重新加载扩展（`chrome://extensions` → Reload）。
- 打开 `linux.do`，确认“抽奖监控”默认是关闭。
- 触发自动回复成功后，出现系统通知，内容包含话题标题与时间。
- 多条短时间回复时，通知数量被节流（10 秒内最多 3 条）。

**Step 4: Commit**

```bash
git add manifest.json background.js content.js icons/notify.png
git commit -m "feat: add auto-reply system notifications"
```
