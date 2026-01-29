# Linuxdo Auto Browse Design (2026-01-29)

Goal: fix run loop stop issues, add target count control (default 1000), and add a restart action.

Architecture:
- Add `logic.js` with pure functions for state transitions and input validation.
- Load `logic.js` before `content.js` via `manifest.json` content_scripts order.
- Keep `content.js` as the orchestration layer and call into `LinuxdoLogic`.

State updates:
- Add `targetCount` to state, stored in `chrome.storage.local`.
- Add `runId` to state; increment on start/restart. `runLoop` uses it to cancel stale loops.
- Keep `queueBuilding` as the flag for DOM queue build; when navigation to `/latest` is required, do not stop running if `queueBuilding` remains true.

UI:
- Add a numeric input in the panel for target count (min 1, max 1000, default 1000).
- Add a `Restart` button that clears queue and index, sets `queueBuilding` and `running` to true, and rebuilds from `/latest`.

Behavior changes:
- `runLoop` re-checks `running` and `runId` after each awaited step.
- When queue is empty and `queueBuilding` is true, do not stop; allow the page redirect to `/latest` to complete and resume.
- Restart always rebuilds the queue from `/latest`.

Testing:
- Add a minimal Node test file for `logic.js` that asserts input validation, queue-empty stop logic, and runId behavior.
