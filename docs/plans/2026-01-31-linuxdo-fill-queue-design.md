# Linuxdo fill-queue design

## Goal
Make the queue fill as much as possible in a single run so the progress quickly reaches the target count, while preserving backoff and safety when the API rate limits.

## Approach
Add a dedicated fill step that loops API fetches until one of these conditions is met: (1) queue size reaches target, (2) no more pages are returned, (3) rate limit or error triggers a cooldown. This fill step reuses the existing `fetchMoreFromApi` logic for requests, de-duplication, and history filtering, but calls it repeatedly in one run rather than waiting for low-water triggers.

## Data flow
- `runLoop` enters `queueBuilding` or empty-queue path and calls `fillQueueFromApi(runId)`.
- `fillQueueFromApi` checks active ownership, then loops `fetchMoreFromApi(runId)` and inspects results.
- If the queue reaches target, exit. If API returns no next page or zero adds, exit and optionally fall back to DOM build if still empty.
- If a 429 or fetch error occurs, respect `nextFetchAt` and stop this fill pass. A later run can resume.

## Limits and safety
- Increase the per-fill page cap to avoid infinite loops (`maxPagesPerFill`, e.g. 50).
- Keep the existing exponential backoff for 429 and cooldown UI status.
- Keep history and seen de-duplication as-is.

## Risks
More pages per fill can trigger rate limiting more often. Cooldown handling must remain intact so the extension does not hammer the API.

## Testing
Add unit tests around the new fill loop to ensure it stops when target is reached, when no more pages, and when rate limiting is hit.
