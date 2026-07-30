# provider-stall-watchdog: fast-fail on unresponsive provider requests

**Status:** implemented on branch `jacek/watchdog-fast-fail`
**Worktree:** `.worktrees/jacek/watchdog-fast-fail`, branch `jacek/watchdog-fast-fail`, base `2f1a452` (v3.3.2)
**Touches:** `provider-stall-watchdog.ts`, `provider-stall-watchdog.test.ts`, `README.md`, `CHANGELOG.md`, `AGENTS.md`

## Problem

A provider request that produces no stream events is currently detected only by the watchdog's
mid-stream `recoveryMs` timer at **240 s**. Recovery is therefore 240 s + a 2 s retry backoff,
and detection is ~99 % of that latency.

Two structural reasons:

1. **One clock.** `lastSemanticAt` is written at `before_provider_request` and again on every
   `text_delta` / `thinking_delta` / `toolcall_delta` with non-empty `delta`. Silence before the
   first stream event and silence mid-stream are measured by the same threshold, and that
   threshold must be sized for the worst legitimate thinking gap - so it can never be short.
2. **Interactive TUI only.** `before_agent_start` and `before_provider_request` each bail on
   `ctx.mode !== "tui"`, and the `input` handler additionally filters
   `event.source === "interactive"`. Print / json / rpc runs, and extension-origin turns, get no
   watchdog at all.

A request that never produces a first stream event is broken regardless of where it originated,
and that case is categorically cheaper to abort than a mid-stream stall: nothing has been
streamed to discard, whereas aborting at 240 s throws away billed output tokens already
generated. This spec makes that first case fast and origin-independent. It deliberately does
**not** extend mid-stream recovery to unattended runs (D6), so headless
first-event-then-silence still falls through to the transport timeout - see
[Edge cases](#error-handling-and-edge-cases).

## Goals

- Detect and recover a request that produces no first stream event in ~20 s instead of 240 s.
- Cover **every** provider request regardless of origin: print / json / rpc modes, and
  extension-origin turns that never emit `before_agent_start`.
- Do not shorten the mid-stream budget, and do not change mid-stream behaviour off-TUI.
- **Reduce** (not eliminate) the abort-hang exposure the change makes more frequent.
- **Accepted contract change:** `maxStallRetries: 0` becomes legal and means "detect and fail
  fast, never auto-retry"; a layered `retry.maxRetries: 0` is honoured instead of silently
  becoming 3. This inverts two existing test assertions and is signed off here rather than
  inherited as an unremarked ride-along.

## Non-goals

- Time-to-first-event telemetry (recording `now - requestStart` per model/provider to derive an
  empirical p99 for `firstEventMs`) - drafted as an issue, roasted, **rejected; not filed**. The
  problem is manufactured: an operator behind a slow provider already has a documented fix (raise
  `firstEventMs`; the README warns about exactly this case per D8), and the false-abort cost is
  bounded by `maxStallRetries`. A local opt-in JSONL sink on one operator's machine cannot
  establish a package-wide default anyway - the interval depends on endpoint, context size, cache
  state, client location, and network path, none of which the proposed model/provider/effort key
  captures. If the D2 default is questioned again, the cheap answer is a one-off local measurement
  plus actual false-abort reports, not a shipped telemetry subsystem.
- Removing per-delta timer churn (`clearTimers()` + `schedule()` on every semantic delta, ~100
  timer allocations/sec at 50 t/s) - drafted as an issue, roasted, **rejected; not filed**. Two
  reasons, the second load-bearing: it is an unmeasured micro-optimization, **and the proposed
  change is incorrect.** Once the warning timer *fires* it is gone. Reducing `message_update` to
  "update `lastSemanticAt`, clear `warned`, let the pending timer re-arm itself" leaves no warning
  timer to re-arm after a warning has fired - only the recovery timer remains - so a second silence
  window in the same generation would never produce its warning. The current unconditional
  `clearTimers(); schedule(ctx);` is exactly what restores the warning timer after progress. A
  correct version needs an independently re-armable warning timer or a redesigned single scheduler,
  far more than the "cosmetic" change the original assessment described. Note also that
  `deadlineEpoch` is shared by both timers, so re-arming only the warning cannot naively reuse
  `schedule()`: bumping the shared epoch would stale the still-pending recovery callback. Pinned by
  the unit case in [Testing](#testing) that asserts a **second warning notification**, not a timer
  count.
- Changing pi's transport defaults. `httpIdleTimeoutMs` is documented, not modified.
- Repository file layout (all `*.ts` at repo root) - deliberately excluded; roasted and filed
  shrunk as issue #4, to be handled in its own spec.

## Ground truth

Verified by direct source reads and, where noted, direct execution in this worktree's
`node_modules`. Cited by file:line so each can be re-checked against a future pi version.

| Ref | Fact |
|---|---|
| F1 | `message_start` marks the **first assistant stream event**, not response headers. Most pi-ai implementations push `{type:"start"}` immediately after the HTTP response resolves (`api/anthropic-messages.js:370-372`), but **not all**: `api/bedrock-converse-stream.js:145-149` pushes it only after reading a body `messageStart` item, i.e. after `onResponse`; `api/pi-messages.js:115` forwards a converted start event from the remote stream. The tier therefore covers headers **and** post-header pre-stream silence. |
| F2 | `message_start` also fires for user and toolResult messages; consumers must filter `event.message.role === "assistant"`. |
| F2b | `pi-agent-core/dist/agent-loop.js:238,251` emits an assistant `message_start` for the final error/aborted message when no partial was added - so the watchdog always sees an assistant start an instant before that message's own `message_end`. What that start does depends on whether the watchdog aborted the generation; both branches are spelled out in [Edge cases](#error-handling-and-edge-cases). |
| F3 | **`isRetryableAssistantError` IS importable from the package root.** `pi-ai/dist/index.js:17` is `export * from "./utils/retry.js"` and `index.d.ts:30` mirrors it. Verified by execution: `import { isRetryableAssistantError } from "@earendil-works/pi-ai"` resolves to a function and returns `true` for both the phase-1 and phase-2 synthetic strings. A grep for the name in `dist/*.d.ts` misses it because it is a star re-export. |
| F3b | The predicate requires `stopReason === "error" && errorMessage`, and `RETRYABLE_PROVIDER_ERROR_PATTERN` (`pi-ai/dist/utils/retry.js:19-70`) matches the bare token `timeout`. |
| F4 | pi already has a transport timeout: `configureHttpDispatcher` sets undici `headersTimeout` **and** `bodyTimeout` from the single `httpIdleTimeoutMs` setting, default `300_000`. Because one knob drives both, lowering it to get fast pre-stream failure also shortens the mid-stream budget - which is why the watchdog, not the transport knob, is the right layer. |
| F5 | undici's `Headers Timeout Error` lands verbatim in `errorMessage` and matches F3b, so pi already auto-retries transport timeouts - just at 300 s, which the watchdog's 240 s currently preempts. |
| F6 | The Anthropic SDK is constructed with `maxRetries: 0` and no `timeout`; nothing below undici shortens a stale request. |
| F7 | Post-conversion backoff is `2000 * 2 ** (attempt-1)` = 2 s / 4 s / 8 s. Detection dominates. |
| F8 | On abort, `api/anthropic-messages.js:567-575` catches, sets `stopReason = "aborted"`, and pushes `{type:"error", reason:"aborted", error: output}`. The agent loop surfaces this as the terminal message, so a watchdog abort **does** reach the `message_end`-keyed conversion path. |
| F9 | Abort-hang is real: on a watchdog abort the signal listener does not disarm and `clearTimers()` has already run, so if `ctx.abort()` never yields `message_end`, nothing escalates. |
| F10 | `isPositiveInteger` requires `> 0`, so an explicit `maxStallRetries: 0` fails validation and disables the extension, and `resolveRetryMaxRetries` skips a layered `retry.maxRetries: 0` and returns 3 - diverging from pi's own `?? 3`, which honours 0. |
| F12 | `agent-session.js:1092-1093` runs `_runAgentPrompt(appMessage)` directly for `sendMessage(..., { triggerTurn: true })`, bypassing the `prompt()` path that emits `before_agent_start` and the `input` event. Any activation keyed on those two events misses extension-origin turns entirely. |
| F13 | `ctx.ui` is never undefined; print/json get `noOpUIContext` whose `notify` is `() => {}` (`extensions/runner.js:88-108,152`). Headless visibility needs `console.warn` (stderr; json mode's stdout protocol tolerates it). |
| F14 | `ctx.hasUI` is `uiContext !== noOpUIContext` (`runner.js:246`). RPC binds a **real** `notify` that ships an `extension_ui_request` to the client (`modes/rpc/rpc-mode.js:82-95,230`), so `hasUI` is true in TUI and RPC and false in print/json. It is the correct predicate for "a notify is actually delivered" - `mode !== "tui"` would double-report in RPC. |
| F15 | `provider-stall-watchdog.test.ts` contains **zero** occurrences of `message_start`; the runtime harness hardcodes `mode: "tui"` and sets only `warningMs`/`recoveryMs`. The phase split breaks far more than the two documented assertion inversions - see [Testing](#testing). |
| F11 | Baseline `npm run test:all` on this branch: 119 pass / 0 fail, typecheck clean. |

## Decisions

| ID | Decision |
|---|---|
| D1 | Hybrid: add a `firstEventMs` tier to the watchdog **and** document `httpIdleTimeoutMs` as the transport backstop that stays at its default (F4 makes lowering it a bad trade). |
| D2 | `firstEventMs` default `20_000`, tunable in `settings.json` like every other watchdog key. Chosen by the user against the stated tradeoff: too low costs a full context re-upload per false abort, bounded by `maxStallRetries`. Kept despite the council's raise-the-default finding; mitigated by the README warning in D8 rather than by moving the number. |
| D3 | Single-stage, shared budget. On expiry: abort + convert immediately, no warning stage, consuming one `maxStallRetries` slot. A phase-1 and a phase-2 abort draw on the same counter. |
| D4 | Ride-along fixes: the `maxStallRetries: 0` / `retry.maxRetries: 0` defect (F10) and the abort-hang guard (F9). The retry-predicate concern is **resolved, not accepted as risk** - F3 shows the predicate is importable and can be asserted in a test. |
| D5 | The `firstEventMs` tier runs for **every** provider request: all modes, all input sources, including extension-origin turns with no `before_agent_start` (F12). |
| D6 | Only the `firstEventMs` tier is origin-independent. `warningMs` / `recoveryMs` stay TUI-only: a mid-stream stall is a heuristic guess about expensive in-flight work, and an unattended abort discards billed tokens with nobody watching. |
| D7 | Activation moves into `before_provider_request` (lazy, memoized). The `input` handler and the activation branch of `before_agent_start` are **deleted** - they cannot cover F12's bypass, and with lazy arming they have no remaining job. |
| D8 | The 20 s default gets a README warning: queueing gateways, throttled providers that hold the connection, and busy single-slot local model servers can legitimately exceed it; such setups must raise `firstEventMs`. This is the mitigation for D2. |
| D9 | `coerce` accepts a boolean as shorthand for `{ enabled: <bool> }`, matching `sword-header`, `fast-mode`, and `session-name`. Ratified at the finish gate, not part of the original scope: the published README already documented `"providerStallWatchdog": false`, which the code rejected as "must be an object". D5's widened activation turned that latent doc-vs-code mismatch into a config error printed to stderr on every headless run, so the branch that caused the exposure carries the repair. |

## Design

### Two phases, not one clock

Each provider request has two non-overlapping phases:

- **Phase 1 (pre-first-event)** - armed at `before_provider_request`. One timer, `firstEventMs`.
  Active for **every** request, every mode, every origin.
- **Phase 2 (streaming)** - entered on the first assistant `message_start` of the active
  generation, unless the watchdog already aborted that generation, in which case
  `postAbortStreamEvent()` intercepts the start first (see
  [Edge cases](#error-handling-and-edge-cases)). Permanently clears the phase-1 timer, resets
  `lastSemanticAt`, arms the existing `warningMs` / `recoveryMs` pair. Armed **only** when
  `ctx.mode === "tui"`.

Phase separation is the mechanism that makes D6 cheap: headless never enters phase 2, so no
per-timer mode branching is needed inside `schedule()`. It also removes any ordering constraint
between `firstEventMs` and `warningMs` - the two tiers can never race, which is precisely
today's defect, where `before_provider_request` arms the mid-stream timers during the
pre-first-event window.

### Components

**Config.** `WatchdogConfig` and `DEFAULT_CONFIG` gain `firstEventMs: 20_000`. `coerce`'s key
list and `validateConfig` gain it, validated with the existing `isTimerDelay` (positive integer
`<= MAX_TIMER_MS`). No ordering constraint couples it to `warningMs`; the existing
`warningMs < recoveryMs` check is untouched. Per D9, `coerce` also maps a boolean `raw` to
`{ blockIsObject: true, enabled: raw }`, so `"providerStallWatchdog": false` validates instead of
failing closed.

**Timer state.** The post-change type:

```ts
type Timer = { firstEvent?: unknown; warning?: unknown; recovery?: unknown; abortGuard?: unknown };
```

Handles are opaque (`runtime.setTimeout` returns `unknown`); the type does not need
`ReturnType<WatchdogRuntime["setTimeout"]>` to say so. `clearTimers()` remains the single
teardown point and clears all four.

**Run state.** Two new per-request flags: `midStreamEnabled` (from `ctx.mode === "tui"`) and
`firstEventSeen` (reset at each `before_provider_request`). The settings read is memoized as a
plain `config: WatchdogConfig | undefined` plus a separate `disabled: boolean`, not a tagged
result type - `before_provider_request` resolves once when `config` is still `undefined`, sets
`disabled = true` and announces once on invalid config, or caches the resolved `config` on
success; either way the filesystem is hit at most once per session. Both are cleared on
`session_shutdown`.

**Activation (D7).** Delete the `input` handler and the activation branch of
`before_agent_start`. `before_provider_request` resolves the memoized config, emits the
disabled-warning once on invalid config, sets `midStreamEnabled` from `ctx.mode`, captures
`{ ui, hasUI }` from `ctx`, and arms phase 1. This is the only lifecycle guaranteed to run for
every provider call, including F12's `triggerTurn` bypass.

**Conversion path generalised.** Today the error string hardcodes `config.recoveryMs`. Replace
with a `pendingTimeoutReason: string | undefined` recorded at the abort site and consumed by
`message_end`:

- Phase 1: `Provider first-event timeout after ${firstEventMs} ms without a stream event`
- Phase 2: unchanged - `Provider semantic timeout after ${recoveryMs} ms without progress`

Both satisfy pi's real predicate (F3, F3b), and a unit test asserts that directly against the
imported `isRetryableAssistantError` rather than against a copy of the regex - so a future pi
change that breaks the contract fails the suite instead of silently degrading recovery to
manual resubmission.

These `errorMessage` strings deliberately keep raw milliseconds (`${firstEventMs} ms`,
`${recoveryMs} ms`) rather than routing through `formatElapsed` - they are machine-facing input
to `isRetryableAssistantError`'s pattern match (F3, F3b), not UI text, and a "consistency" pass
that reformats them would change what pi's retry predicate matches against. Do not conflate
them with the human-facing notices below, which do use `formatElapsed`.

A phase-1 abort does reach this path: pi-ai catches the aborted request and pushes a terminal
`{type:"error", reason:"aborted"}` carrying `stopReason: "aborted"` (F8), which the agent loop
surfaces as `message_end`.

**Notices.** A new `announce(text, type)` helper replaces bare `ui.notify` calls. It consumes
the `{ ui, hasUI }` pair captured at the arm site (the timer callbacks and `agent_settled` have
no `ctx` in scope), always calls `ui.notify`, and additionally calls `console.warn(text)` when
`!hasUI` - i.e. print/json only, since RPC delivers notifications for real (F14).

Phase-1 strings, distinct from the phase-2 wording because "semantic progress" and "returned to
the editor" are wrong for this tier and for headless runs. Unlike the `errorMessage` strings
above, these are notice text shown to a human (or `console.warn`'d headless), so the threshold
is rendered through `formatElapsed` - a 20000 ms default reads as `20s`, not `20000 ms`:

- retrying: `` Provider sent no response for ${formatElapsed(config.firstEventMs)}; stopping and retrying the request. ``
- exhausted: `` Provider sent no response for ${formatElapsed(config.firstEventMs)} and the stall-retry budget is spent; the request was stopped. ``

### Event flow

```
before_provider_request  -> resolve memoized config; midStreamEnabled = (ctx.mode === "tui")
                            capture { ui, hasUI }; firstEventSeen = false
                            arm firstEvent(firstEventMs)              [every request]
  |
  |- no assistant message_start within firstEventMs
  |     -> clearTimers(); watchdogAbortedGeneration = capturedGeneration
  |     -> arm abortGuard(ABORT_GRACE_MS)   [before ctx.abort(), so a synchronous teardown
  |                                          inside it cannot orphan the timer]
  |     -> if budget remains: pendingTimeoutReason = phase-1 reason; stallRetriesUsed++
  |     -> announce(phase-1 retrying | phase-1 exhausted); ctx.abort()
  |
  `- assistant message_start (active generation, first of this request)
        -> clear firstEvent permanently; firstEventSeen = true
        -> if midStreamEnabled: lastSemanticAt = now; arm warning + recovery
message_update (delta)   -> only when midStreamEnabled && firstEventSeen   [unchanged]
stream event on an already-aborted generation (postAbortStreamEvent)
                         -> re-arm abortGuard(ABORT_GRACE_MS); handler returns  [no re-entry into the stall cycle]
abortGuard fires         -> announce(ABORT_STUCK_NOTICE, "error"); clearTimers()
                            [generation stays armed; pendingTimeoutReason survives]
message_end              -> clear abortGuard; disarm; convert when pendingTimeoutReason is set
                            AND stopReason === "aborted" AND activeGeneration is the aborted one
```

Result: recovery for a request that produces no stream event drops from ~240 s to ~22 s.
Detection stops dominating and pi's 2 s backoff becomes the visible cost.

### Error handling and edge cases

- **`maxStallRetries: 0` (F10).** Introduce `isNonNegativeInteger` and use it for
  `maxStallRetries` in `validateConfig` and for the layered value in `resolveRetryMaxRetries`.
  `isTimerDelay` keeps `> 0` - a 0 ms timer is meaningless. Behaviour at 0 already works:
  `0 >= 0` takes the exhausted branch, aborting without conversion.
- **Abort hang (F9).** Arm `abortGuard` with a fixed `ABORT_GRACE_MS = 10_000` (not
  configurable - YAGNI) after **every** watchdog-initiated abort, converting **and** exhausted.
  Scoping it to conversion aborts only would leave the exhausted path with the full original
  exposure. `message_end` clears it. On expiry it announces the dedicated `ABORT_STUCK_NOTICE`
  at severity `"error"` (`DEGRADATION_NOTICE` is retained solely for its original
  `agent_settled` use) and calls `clearTimers()` - **not** `disarm()`. This **reduces** the
  exposure - it does not force the provider operation to terminate. After the guard fires,
  undici's `headersTimeout` / `bodyTimeout` (F4, 300 s default) are the remaining backstop,
  which matters most for unattended runs where nobody reads the notice.
- **Why the guard clears timers instead of disarming.** `disarm()` nulls `activeGeneration`,
  which would forfeit the pending conversion: a `message_end` arriving after the grace period
  would then fail `matchesWatchdogAbort`'s `activeGeneration === watchdogAbortedGeneration`
  check, so the turn would end aborted with no retry even though a stall retry had already been
  spent. Keeping the generation armed lets the announcement happen without throwing away the
  retry the increment paid for.
- **Post-abort stream events re-arm, they do not clear.** `postAbortStreamEvent()` runs at the
  head of both `message_start` (after the `role === "assistant"` filter, F2) and
  `message_update`. When the event belongs to a generation the watchdog already aborted
  (`watchdogAbortedGeneration === activeGeneration`) it re-arms `abortGuard` for a fresh
  `ABORT_GRACE_MS` and returns `true`, making the handler a no-op. Two properties fall out:
  bytes prove the connection is alive at that instant, so escalating would be a false alarm -
  but clearing outright would turn a point-in-time observation into a permanent conclusion, so
  a stream that goes chatty and then wedges still escalates one grace period after its last
  event. The no-op is also what stops a straggler delta from re-entering the warn/recover cycle
  and burning a second stall retry.
- **No `timeoutConversionPending`.** Conversion is keyed on `pendingTimeoutReason`, recorded at
  the abort site and consumed (and cleared) by `message_end`, together with `matchesWatchdogAbort`'s
  `stopReason === "aborted"` + `activeGeneration === watchdogAbortedGeneration` checks. There is no
  separate boolean to keep in sync.
- **Shared budget (D3).** A phase-1 and a phase-2 abort both increment `stallRetriesUsed`, so a
  session hitting one of each has one retry left rather than two. Accepted.
- **Non-assistant `message_start` (F2).** Filtered on `role === "assistant"`. Phase 1 is cleared
  by the **first** qualifying start per provider request; `firstEventSeen` makes later starts in
  the same request no-ops.
- **Watchdog-aborted final message (F2b).** This is the only case that ever converts. The
  failure message's own assistant `message_start` hits `postAbortStreamEvent()` **before** the
  phase-1 clear (the call sits at the head of the handler, right after the `role === "assistant"`
  filter), so phase 1 is not cleared and phase 2 is **not** armed - the abort guard is re-armed
  instead, per the post-abort bullet above. The `message_end` an instant later disarms and
  converts. Pinned by a test that asserts exactly one armed timer (the re-armed guard) between
  the start and the end.
- **Non-watchdog error/aborted final message (F2b).** With no watchdog abort in this generation,
  `postAbortStreamEvent()` returns `false`, so the start does clear phase 1 and, in TUI, does arm
  phase 2; the following `message_end` disarms **without** converting, because
  `pendingTimeoutReason` is undefined. The two cases are mutually exclusive: the branch that arms
  phase 2 never converts, and the branch that converts never arms phase 2.
- **First event arrives, then silence, headless.** No phase 2 off-TUI, so this falls through to
  undici's `bodyTimeout` (300 s default). Documented limitation, not fixed here.
- **Multi-turn runs.** Every `before_provider_request` re-arms phase 1, so each tool-loop turn
  gets its own pre-first-event budget.
- **Slow-header providers (D8).** A provider that legitimately takes >20 s to first event will
  be aborted and retried up to `maxStallRetries`, then fail. README warns; the knob is the fix.
- **Generation guard; no `epoch` counter.** The `epoch` counter is deleted. `generation` is
  monotonic - its only mutation is `activeGeneration = ++generation`, never a reset - and
  `session_shutdown` -> `resetRunState()` -> `disarm()` already sets
  `activeGeneration = undefined`, so `capturedGeneration !== activeGeneration` subsumes every
  case `capturedEpoch !== epoch` caught. `deadlineEpoch` is a **different** counter and is
  retained: it is meant to disambiguate two arms within one generation when `schedule()` re-arms
  per delta, so it is not deleted along with `epoch`. Its load-bearingness is **unverified** - no
  current test distinguishes it; removing the guards in both `schedule()` and `armFirstEvent()`
  leaves the suite green, plausibly because `clearTimers()` already drops the previous handle
  before every re-arm. Open question worth resolving: add a test that pins the counter, or remove
  it as belt-and-suspenders (AGENTS.md discourages duplicate guarding). Until then, neither treat
  it as verified nor delete it casually. Guard sets differ per callback: the phase-1 callback
  carries `capturedGeneration` + `capturedDeadlineEpoch` + `activeRun` + `firstEventSeen` (the
  last one makes a start that already happened cancel the tier); the mid-stream `warning` /
  `recovery` pair carries `capturedGeneration` + `capturedDeadlineEpoch` + `activeRun` and
  **not** `firstEventSeen`; the `abortGuard` callback carries
  `capturedGeneration` + `activeRun` only - it is armed once per abort and never re-scheduled
  in place, so it has no deadline epoch to disambiguate.

## Testing

**Migration of existing tests (F15) - required, not optional.** The phase split changes when
mid-stream timers arm, so the current suite does not merely need two assertions inverted:

- Every mid-stream unit case arms via `before_provider_request` + `advance()` and never emits a
  start. Each needs a `messageStart()` emit inserted before the `advance()` that expects
  warning/recovery.
- All three runtime `stall` scripts never push `{type:"start"}`, and the runtime harness
  settings set only `warningMs: 10` / `recoveryMs: 20`. Without a `firstEventMs` in those
  settings, phase 1 fires at the 20 s default while `waitBounded` rejects at 5 s - the existing
  runtime tests hang-fail as written. Add `firstEventMs` to the harness settings and a
  start-then-stall script for the cases that mean to exercise phase 2.
- The runtime harness hardcodes `mode: "tui"`. Parameterize the bound `mode` and `uiContext`.
- Two assertions invert deliberately: `maxStallRetries: 0` now validates, and a layered
  `retry.maxRetries: 0` now resolves to 0.

**New unit cases** (extending `watchdogHarness`, adding `hasUI` to its `ctx` stub and a
`messageStart(role = "assistant")` helper beside the existing `semantic()`):

- Phase 1 fires at `firstEventMs` when no assistant `message_start` arrives.
- An assistant `message_start` cancels phase 1 permanently; a later `firstEventMs`-sized gap
  does not re-trigger it; a second start in the same request is a no-op.
- A non-assistant `message_start` does not cancel phase 1.
- Phase 2 arms only when `mode === "tui"`; in `print` mode phase 1 arms and phase 2 never does.
- Phase 1 arms with no preceding `input` or `before_agent_start` event (F12's bypass).
- The converted error carries the phase-1 wording and `firstEventMs`.
- **Both** synthetic strings satisfy `isRetryableAssistantError` imported from
  `@earendil-works/pi-ai` (F3).
- `maxStallRetries: 0` validates and the first stall aborts without conversion; a layered
  `retry.maxRetries: 0` resolves to 0.
- `abortGuard` fires, announces `ABORT_STUCK_NOTICE` at `"error"`, and escalates exactly once
  when `message_end` never arrives - and a `message_end` after the grace period still converts,
  proving the guard did not disarm the generation.
- `abortGuard` is armed on the exhausted path too, and `message_end` clears it.
- Post-abort stream events push the grace deadline out without re-aborting or re-notifying; a
  straggler followed by silence escalates one grace period after the last event; a
  non-assistant `message_start` after the abort does not count as liveness.
- A watchdog-aborted generation's final message: its own assistant `message_start` re-arms the
  grace deadline and does **not** arm phase 2, and the following `message_end` still converts and
  leaves no armed timers (F2b).
- Warning -> semantic progress -> a second full silence window emits a **second warning
  notification**. Asserting the notification, not `timers.size`, is what pins the re-arm invariant
  in [Non-goals](#non-goals); a timer-count assertion alone passes under the rejected
  "optimization".
- Headless (`hasUI: false`) abort writes to `console.warn`; RPC (`hasUI: true`) does not.

**New runtime integration cases:** a script that never emits `{type:"start"}`, asserting
conversion and retry at the phase-1 threshold; the same in `print` mode, asserting the headless
path end to end and that diagnostics never reach stdout; and a `sendMessage({triggerTurn: true})`
turn, asserting phase 1 arms.

**Excluded, deliberately: an `abortGuard` runtime case.** A stream that ignores `abort()` and
emits no terminal event is **not** covered at the runtime layer. `ABORT_GRACE_MS` is fixed at
`10_000` and stays fixed (making it configurable is rejected above as YAGNI), while the runtime
harness's `waitBounded` rejects at `5_000`. Covering it would mean either a ~15 s wait on every
CI run on both ubuntu and windows, or making a deliberately-fixed constant configurable purely
to enable a test. Both guard paths - conversion and exhausted - plus the re-arm behaviour are
covered in the fake-clock unit harness, where the logic is fully observable and free.

Verification command is the repo standard, `npm run test:all` (check:agents-core + `node --test
"*.test.ts"` + tsc). Baseline before migration: 119 pass / 0 fail (F11); after the change:
139 pass / 0 fail, check:agents-core OK, typecheck clean.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (new `firstEventMs` key and default; the
  two-phase activation boundary; the D8 slow-provider warning; a note that `httpIdleTimeoutMs`
  is the transport backstop - default 300 s, couples `headersTimeout` and `bodyTimeout` per F4,
  leave at default; `maxStallRetries: 0` now legal and meaning "never auto-retry"),
  `CHANGELOG.md` (minor bump: new config key, widened activation, two behaviour contract
  changes)
- Derived / memory docs invalidated: `AGENTS.md` - the `provider-stall-watchdog` runtime-boundary
  paragraph ("OFF by default; only confirmed human interactive TUI runs can arm it. JSON/RPC/
  print/subagent runs remain inert by activation, not environment or session lineage") is false
  for phase 1 once this lands and must be rewritten as the two-phase boundary

Materiality bar:
`/Users/jacek/.pi/agent.anthropic/npm/node_modules/pi-gauntlet/skills/brainstorming/reference/documentation-impact.md`.

## Open questions

All questionary decisions are recorded in the Decisions table. One implementation question is
left open deliberately, surfaced rather than auto-fixed:

- **Is `deadlineEpoch` load-bearing?** Deleting its guards in both `schedule()` and
  `armFirstEvent()` leaves the watchdog suite green (52/52, verified on a scratch copy of the
  source), so nothing currently pins it and `clearTimers()` may already subsume it. Resolve by
  adding a test that distinguishes the counter, or by removing it - see
  [Edge cases](#error-handling-and-edge-cases).
