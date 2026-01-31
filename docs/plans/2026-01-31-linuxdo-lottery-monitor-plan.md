# Lottery Monitor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an independent lottery monitor that detects keyword-matched topics and auto-replies once per topic, with a UI toggle and persisted reply history.

**Architecture:** Keep logic-heavy decisions in `logic.js` (keyword match, template selection) with unit tests. Implement monitoring loop, ownership, and reply side effects in `content.js`, using existing fetch/backoff helpers and new state fields.

**Tech Stack:** MV3 content script, Chrome storage, Node-based unit tests.

---

### Task 1: Add keyword/template helpers (TDD)

**Files:**
- Modify: `tests/logic.test.js`
- Modify: `logic.js`

**Step 1: Write the failing test**

Add tests for keyword matching and template selection:

```js
function testKeywordHelpers() {
  const keywords = ['抽奖', '福利', '抽'];
  assert.strictEqual(matchTitleKeywords('今晚有抽奖', keywords), true);
  assert.strictEqual(matchTitleKeywords('福利大放送', keywords), true);
  assert.strictEqual(matchTitleKeywords('抽空看看', keywords), true);
  assert.strictEqual(matchTitleKeywords('不相关标题', keywords), false);
}

function testPickReplyTemplate() {
  const templates = ['参与一下', '支持活动', '感谢福利'];
  const pick = pickReplyTemplate(templates, { random: () => 0.0 });
  assert.strictEqual(pick, '参与一下');
}
```

Also import `matchTitleKeywords` and `pickReplyTemplate` at the top, and call both tests at the bottom.

**Step 2: Run test to verify it fails**

Run: `node tests/logic.test.js`

Expected: FAIL with `matchTitleKeywords is not a function`.

**Step 3: Write minimal implementation**

In `logic.js`, add and export:

```js
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
  return safe.map((item) => String(item || '').trim()).filter((item) => item.length > 0);
}

function matchTitleKeywords(title, list = KEYWORD_DEFAULTS) {
  const text = String(title || '');
  const keywords = normalizeKeywords(list);
  return keywords.some((key) => key && text.includes(key));
}

function pickReplyTemplate(list = REPLY_TEMPLATES, options = {}) {
  const safe = Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim().length >= 4) : [];
  if (safe.length === 0) return '';
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const idx = Math.min(Math.floor(random() * safe.length), safe.length - 1);
  return safe[idx];
}
```

Export `KEYWORD_DEFAULTS`, `REPLY_TEMPLATES`, `normalizeKeywords`, `matchTitleKeywords`, `pickReplyTemplate`.

**Step 4: Run test to verify it passes**

Run: `node tests/logic.test.js`

Expected: PASS and `logic tests passed`.

**Step 5: Commit**

```bash
git add tests/logic.test.js logic.js
git commit -m "feat: add lottery keyword and reply helpers"
```

---

### Task 2: Add monitor state + loop + reply workflow

**Files:**
- Modify: `content.js`
- Modify: `style.css`

**Step 1: Add monitor defaults and state**

Add constants (interval, keywords, reply templates, reply history TTL) and extend `DEFAULT_STATE` with monitor fields.

**Step 2: Implement monitor helpers**

Add helper functions:
- `getCurrentUserId()` via `/session/current.json`
- `getPrunedReplyHistory()` + persistence
- `matchTitleKeywords` usage (from `LOGIC`)
- `buildReplyText()` with random suffix

**Step 3: Implement monitor loop**

Add ownership/heartbeat for monitor, plus `monitorTick()` that:
- checks `monitorEnabled`
- fetches `latest.json` (1–2 pages)
- filters by keywords
- verifies replyable + not yet replied
- posts reply via `POST /posts.json`
- records topic id in reply history
- schedules cooldown on 429/errors

**Step 4: UI toggle**

Add a “抽奖监控” toggle row in panel, default on. Disable it if another tab owns monitoring. Toggle should update storage and start/stop the monitor loop.

**Step 5: Manual check**

Run: `node tests/logic.test.js`

Manual: open `https://linux.do/latest`, confirm:
- 监控默认开启
- 命中关键词时自动回复
- 已回复话题不再重复回复

**Step 6: Commit**

```bash
git add content.js style.css
git commit -m "feat: add lottery monitor and auto reply"
```
