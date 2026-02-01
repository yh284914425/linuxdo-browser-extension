importScripts('logic.js');

const LOGIC = globalThis.LinuxdoLogic || {};
const THROTTLE_MS = LOGIC.MONITOR_DEFAULTS?.notifyThrottleMs ?? 10_000;
const MAX_PER_WINDOW = LOGIC.MONITOR_DEFAULTS?.notifyMaxPerWindow ?? 3;
let notifyTimestamps = [];

function truncate(text, limit = 120) {
  const safe = String(text || '').trim();
  if (safe.length <= limit) return safe;
  return safe.slice(0, limit - 1) + '...';
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
