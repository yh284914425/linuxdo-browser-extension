# 自动回复通知与默认关闭设计

## 目标
当抽奖监控自动回复成功时，弹出系统通知提醒用户；同时将“抽奖监控”默认状态改为关闭，避免首次启用即自动回复。通知只针对本次自动回复成功，不对历史同步触发。

## 架构与组件
- content script（`content.js`）：在自动回复成功的分支中发送 `chrome.runtime.sendMessage`，携带话题标题、URL、时间等信息。
- service worker（`background.js`）：监听消息，进行通知节流后调用 `chrome.notifications.create`。
- 默认值（`logic.js` + `content.js`）：新增 `MONITOR_DEFAULTS.enabledByDefault=false`，并在 `DEFAULT_STATE.monitorEnabled` 中使用该默认值。

## 数据流
1) 抽奖监控识别命中话题 → 通过 `/t/{id}.json` 判断可回复 → `postReply` 成功。
2) 成功后立即发送 `notify-reply` 消息（包含 `topicTitle/url/timeLabel`）。
3) 后台收到消息，执行节流（如 10 秒内最多 3 条），通过 `chrome.notifications.create` 弹出系统通知。
4) 通知只用于提醒，不影响监控逻辑，也不触发重复回复。

## 错误处理与节流
- 若 `chrome.notifications` 不可用或权限缺失，后台仅 `console.warn`，不影响主流程。
- 通知节流防止短时间刷屏，使用简单时间窗口计数，允许重启后重置。

## 测试与验收
- 重新加载扩展，确认权限包含 `notifications`。
- 触发自动回复后应有系统通知，内容包含“自动回复成功”和话题标题/时间。
- 同步历史记录不会触发通知；429 限流或扩展重载不会导致通知风暴。
- 默认进入页面时监控开关为关闭状态。
