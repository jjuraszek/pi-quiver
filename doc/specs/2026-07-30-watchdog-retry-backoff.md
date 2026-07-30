# Anthropic retry budget activation

## Status

Decision record for an operational incident. The desired local configuration already exists. No `pi-quiver` implementation or tracked configuration change is required.

## Problem

The Anthropic session at `/Users/jacek/.pi/agent.anthropic/sessions/--Users-jacek-repos-gridstrong--/2026-07-30T06-23-07-332Z_019fb1b0-e244-77a0-8dc2-c97e64b66e26.jsonl` exhausted three automatic retries during repeated first-event stalls. A later manual submission succeeded, raising two possibilities: the retry budget was too small, or retries were happening without enough delay.

The session timing disproves the missing-delay theory. The clean sequence records watchdog timeout errors at `06:59:44.256`, `07:00:06.266`, and `07:00:30.277`, then final exhaustion at `07:00:58.285`. After subtracting each 20-second first-event timeout, the gaps are approximately 2, 4, and 8 seconds. Pi's exponential backoff was active.

The three persisted errors represent retryable failures, not all provider attempts. The sequence contains an initial request plus three automatic retries. All four provider requests failed before their first stream event. A manual submission at `07:01:24.370` acted as the fifth provider request and succeeded at `07:01:36.910`.

Load-bearing events extracted from the session JSONL are retained here because the source file is outside the repository:

```text
06:59:44.256  error    Provider first-event timeout after 20000 ms without a stream event
07:00:06.266  error    Provider first-event timeout after 20000 ms without a stream event
07:00:30.277  error    Provider first-event timeout after 20000 ms without a stream event
07:00:58.285  aborted  Aborted after 3 retry attempts
07:01:24.370  user     Manual submission
07:01:36.910  assistant response received
```

## Decision

Use five automatic retries and Pi's existing exponential backoff. The effective local policy is:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 5,
    "baseDelayMs": 2000
  },
  "providerStallWatchdog": {
    "enabled": true,
    "warningMs": 120000,
    "recoveryMs": 240000
  }
}
```

`providerStallWatchdog.maxStallRetries` remains omitted. `resolveWatchdogConfig` inherits the value from `retry.maxRetries`, making the configured count a single source of truth across Pi and the watchdog. Five retries permit at most six provider attempts: the initial request followed by delays of 2, 4, 8, 16, and 32 seconds before retries. Pi's session retry loop has no separate delay cap; at this budget its longest delay is naturally 32 seconds. SDK-level `retry.provider.maxRetryDelayMs` is a separate mechanism and is out of scope.

The selected policy already exists in `/Users/jacek/.pi/agent.anthropic/settings.json`. No local settings edit remains to be made.

## Architecture and responsibilities

Pi owns retry eligibility, scheduling, and exponential delays for converted errors. The watchdog owns first-event and mid-stream stall detection plus the stall-conversion ceiling enforced by `stallRetriesUsed >= maxStallRetries`. It does not add a cooldown, resubmit prompts, or convert a terminal stall after its ceiling is reached.

The watchdog resolves and caches its configuration on the first provider request of an extension instance (`provider-stall-watchdog.ts:280`, with resolution at lines 96-97). Ordinary settings edits do not mutate that instance. A new session or an explicit Pi reload re-instantiates the extension and resolves current settings on the next provider request; there is no implicit hot reload during an active request sequence.

A filesystem `stat` of the local settings file records modification at `2026-07-30 06:35:52Z`, after the referenced session had initialized with a retry budget of 3. The later failure sequence therefore continued using the cached value 3 even though the file already contained 5. A new session or explicit reload activates the existing value 5.

## Request flow

1. A fresh Pi session loads `retry.maxRetries: 5` and `retry.baseDelayMs: 2000`.
2. The watchdog resolves no explicit `maxStallRetries`, so it inherits 5.
3. A provider request that emits no stream event for 20 seconds is aborted by the watchdog.
4. While watchdog retry capacity remains, the aborted assistant message is converted to a retryable error.
5. Pi schedules the next attempt using its exponential backoff.
6. A successful stream event clears the first-event timer and the successful turn resets watchdog retry state.
7. If the initial attempt and all five retries stall, the watchdog aborts the sixth stall without converting it. Pi schedules no further retry, and the turn ends aborted after five retries. The watchdog performs no manual resubmission.

Mid-stream behavior remains unchanged and TUI-only. The same watchdog counter remains shared across first-event and mid-stream stalls within a retry sequence.

## Error handling and edge cases

- A local settings edit during an active session applies after a new session or explicit reload, not implicitly during the current extension instance.
- An explicit `providerStallWatchdog.maxStallRetries: 5` would be behaviorally equivalent today but is rejected because it duplicates the host policy and can drift.
- A watchdog-owned cooldown is rejected because it would stack with Pi's verified exponential delay and blur scheduler ownership.
- Extension-owned resubmission after Pi exhaustion is rejected because it duplicates host retry behavior and risks repeated prompts or context.
- Real Anthropic stalls are nondeterministic. A fresh session that succeeds before using all retries does not invalidate the configuration.

## Verification

Verification is operational and static because there is no proposed code change:

1. Start a new Pi session under the `agent.anthropic` agent directory.
2. Confirm the local settings still specify `retry.maxRetries: 5` and `baseDelayMs: 2000` with no explicit watchdog retry limit.
3. Confirm `provider-stall-watchdog.ts:96-97,280` resolves omitted `maxStallRetries` from the layered Pi retry setting once per extension instance.
4. If repeated Anthropic first-event stalls occur naturally, confirm that the watchdog can convert up to five stalls into retryable errors before leaving the terminal stall aborted, and that Pi delays converted retries according to the existing exponential schedule.

No forced live-provider failure test is required. `provider-stall-watchdog.test.ts:138-179` covers inheritance from layered `retry.maxRetries`; lines 502-552 cover conversion until `maxStallRetries` is exhausted. No new test is justified without a source change.

## Non-goals

- Changing `pi-quiver` source code, defaults, tests, README, or changelog.
- Changing Anthropic SDK retry behavior.
- Adding provider-specific retry scheduling or cooldowns.
- Hot-reloading watchdog configuration inside an active session.
- Guaranteeing that six provider attempts always succeed.

## Acceptance criteria

- A fresh Pi session resolves both Pi and watchdog stall retry capacity to 5 from the existing local setting.
- Pi remains the only owner of retry delays, using the configured 2-second exponential base.
- The watchdog adds no separate cooldown or resubmission path.
- The incident is explained by per-session configuration caching rather than absent backoff.
- No repository implementation or tracked documentation change is produced beyond this decision record.

The assessment applies Gauntlet's materiality bar at `reference/documentation-impact.md` (relative to the brainstorming skill): this local operational decision introduces no user-facing document, materially amended document, or invalidated memory document.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: none
- Derived / memory docs invalidated: none
