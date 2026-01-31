# Linuxdo Lottery Monitor & Auto Reply Design

**Date:** 2026-01-31

**Goal:** Monitor new topics whose titles match lottery/giveaway keywords and auto-reply with varied content, while remembering replied topics and allowing a toggle to disable monitoring.

## Context
The extension runs as a content script, stores state in `chrome.storage.local`, and already has ownership + heartbeat coordination across tabs. New monitoring must be independent of the auto-browse run loop, but still avoid duplicate work across tabs.

## Proposed Approach
1) **Independent monitor loop**: Add a scheduler that periodically fetches `latest.json` and scans topic titles for keywords. This loop runs when `monitorEnabled` is true, even if auto-browse is paused.

2) **Ownership isolation**: Introduce `monitorOwnerId` + `monitorOwnerHeartbeat` to ensure only one tab performs monitoring. Keep this separate from the browsing owner to avoid blocking manual runs.

3) **Reply workflow**:
   - Fetch `session/current.json` to get current user id.
   - For matched topics, fetch `t/{id}.json` to verify the user has not replied and that the topic is replyable.
   - Post a reply via `POST /posts.json` using CSRF token from the page.
   - Record replied topic ids in persisted history to avoid duplicates across refreshes.

4) **Keyword matching & replies**:
   - Match title keywords including “抽奖 / 福利 / 抽” plus a small curated list of related phrases.
   - Reply text is selected from a template pool (>=4 chars per item) with a small random suffix to reduce duplication.

5) **Backoff & safety**:
   - On 429 or errors, schedule a cooldown using existing backoff helpers.
   - Limit per-check pages (e.g. max 2–3 pages) to avoid excessive requests.

## State Additions
- `monitorEnabled` (default true)
- `monitorOwnerId`, `monitorOwnerHeartbeat`
- `monitorLastCheckAt`, `monitorNextCheckAt`, `monitorBackoffCount`
- `monitorReplyHistory` (persisted list with TTL + max entries)
- `monitorUserId` (cached)

## UI Changes
Add a “抽奖监控” toggle to the panel. Default: enabled. When disabled, stop the monitor loop and release ownership. If another tab owns monitoring, show status and disable the toggle in this tab.

## Testing Strategy
- Unit tests in `tests/logic.test.js` for keyword matching, template selection, and helper behavior.
- Manual verification in browser for end-to-end auto-reply flow.

## Expected Outcomes
- Newly created lottery/giveaway topics are detected quickly.
- Each matched topic receives at most one reply per account.
- Monitoring can be enabled/disabled without affecting auto-browse.
