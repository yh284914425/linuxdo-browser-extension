# Linuxdo Auto Browse Optimization Design

**Date:** 2026-01-31

**Goal:** Improve stability, performance, and maintainability of the linux.do auto-browse extension while keeping the user-facing behavior unchanged.

## Context
The extension runs entirely in a content script and persists state in `chrome.storage.local`. It already supports ownership, queue building, API fetch with backoff, and history-based de-duplication. Recent growth in features makes the control flow harder to reason about and risks subtle state bugs, especially across tabs.

## Proposed Approach
1) **Keep architecture stable**: stay within MV3 content scripts; do not add a background worker. This minimizes scope and preserves the current user workflow.

2) **Push decision logic into `logic.js`**: add or extend pure helpers that decide how to handle ownership, stale state cleanup, backoff, and target/queue consistency. `content.js` should call these helpers and only perform side effects (storage, navigation, DOM access).

3) **State consistency rules**:
- If owner heartbeat is stale, allow safe cleanup of `fetching`/`queueBuilding` flags without wiping a potentially valid queue.
- When `targetCount` changes, compute a consistent patch for `queue`/`index` in one place to avoid drift.
- Ensure `index` never exceeds `queue.length` without a planned fetch path.

4) **Unified error handling**:
- All recoverable errors (timeout, JSON parse errors, non-2xx) should feed into a consistent backoff schedule to avoid hot loops.
- For 429, keep exponential backoff, but prevent infinite idle loops: if cooling down and still empty, stop gracefully and release ownership.

## Testing Strategy
- Add unit tests in `tests/logic.test.js` for new/updated helpers: ownership TTL, history pruning, next-fetch scheduling, fetch gating, batch planning, and target-change consistency.
- Keep `content.js` manual verification light and focused on UI/UX and tab-ownership behavior to avoid brittle browser mocks.

## Expected Outcomes
- Fewer cross-tab state conflicts.
- Reduced risk of tight retry loops and unnecessary storage writes.
- Clearer separation of concerns and faster regression detection via tests.
