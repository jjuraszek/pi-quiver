# Provider stall watchdog

## Status

Proposed design for [GitHub issue #3](https://github.com/jjuraszek/pi-quiver/issues/3). This spec intentionally amends the issue in two places:

- Monitoring is limited to a human-originated TUI agent run, not every Pi process that loads the extension.
- Recovery uses policy D now through Pi's public extension hooks and existing retry loop, guarded by an installed-runtime contract test. It does not wait for a new explicit replay API.

## Goal

Add an opt-in, provider-neutral watchdog for a provider request that produces no parsed semantic progress. It warns after a configured silence interval, aborts after a longer interval, and gives Pi one opportunity to continue the same turn through its existing retry mechanism. A second semantic stall in the same human agent run is aborted without another watchdog-induced retry.

The watchdog must never arm in non-TUI modes or for runs that did not originate from interactive human input. This activation boundary protects delegated JSON-mode processes without relying on session lineage, model identity, provider identity, environment variables, or a nonexistent `isSubagent` API.

## Non-goals

- Detecting raw transport heartbeats, raw SSE activity, or network liveness.
- Replacing Pi's transport timeout or general provider retry policy.
- Sending a synthetic prompt, duplicating the user's message, or calling private session APIs.
- Replaying completed tools or rebuilding conversation state.
- Supporting RPC, JSON, or print mode.
- Exposing policy selection as configuration; enabled watchdogs always use policy D.
- Automatically enabling or changing Pi's own retry settings.

## Architecture

Add one extension, `provider-stall-watchdog.ts`, registered through the existing package extension list. The extension owns session-local state and small pure state transitions. It uses existing public events:

- `input` establishes human TUI origin.
- `before_provider_request` creates a request generation and starts deadlines.
- `message_update` recognizes parsed semantic deltas.
- `message_end` finalizes a request and may convert one watchdog abort into a retryable timeout error.
- `agent_end` and `agent_settled` provide cleanup and recovery-result boundaries.
- `session_shutdown` invalidates all state and captured contexts.

The extension does not launch a second model call. At recovery, it calls `ctx.abort()`. For the first watchdog abort in a human agent run, its `message_end` handler preserves the assistant message fields but replaces `stopReason: "aborted"` with `stopReason: "error"` and a timeout-classified `errorMessage`. Pi's existing retry loop then removes that failed result from live model context and invokes `agent.continue()` on the current turn. This retains the original user message and completed tool results without appending or replaying either.

This composition is verified against installed `@earendil-works/pi-coding-agent` 0.80.10. Its effective defaults are `retry.enabled ?? true`, `retry.maxRetries ?? 3`, and `retry.baseDelayMs ?? 2000`. Its case-insensitive retry classifier accepts error text containing `timeout`, `timed out`, or `time out`. A `message_end` replacement mutates the assistant message before Pi assigns the result used for retry evaluation; retry preparation excludes that failed assistant result from live model context, retains it in session history, and calls `agent.continue()` without duplicating the user message or completed tool results. The watchdog uses the exact error template ``Provider semantic timeout after ${recoveryMs} ms without progress``. The implementation uses only public extension hooks even though Pi does not expose a direct `ctx.retry()` method.

## Activation boundary

The watchdog arms only when both conditions hold:

1. `ctx.mode === "tui"`.
2. The current agent run was activated by an `input` event whose `source === "interactive"`.

The `input` handler records a pending origin rather than activating immediately. Every input replaces that pending origin: `interactive` sets it; `rpc` and `extension` clear it. `before_agent_start` promotes a pending interactive origin to an active human run and consumes the pending flag. This prevents a handled or failed interactive input from directly activating monitoring; a subsequent extension-originated prompt first emits its own `input` event and clears the stale pending flag. Interactive steering or follow-up input during an already active run does not reset watchdog retry eligibility. The run remains active across tool calls, provider requests, compaction, and Pi's automatic continuation. `agent_settled` ends it and resets pending and run-level state.

A TUI process with no confirmed qualifying run remains inert. Inputs from `rpc` or `extension` do not activate it. All requests in `json`, `rpc`, and `print` modes remain unchanged. Session ancestry and `parentSession` are deliberately ignored because they identify persisted forks but not fresh delegated processes.

## Configuration

Use the established global-then-project `resolveConfig()` layering. Package defaults are:

```json
{
  "providerStallWatchdog": {
    "enabled": false,
    "warningMs": 120000,
    "recoveryMs": 240000
  }
}
```

At the first eligible arm, merge settings and validate the complete candidate without substituting defaults for invalid supplied values. The `resolveConfig()` coerce callback must preserve every supplied recognized value as `unknown`, including wrong-typed values, and carry whether the layer's whole watchdog block was an object. Each later layer wins per recognized field. A later valid object repairs an invalid earlier whole-block shape; an invalid project block overrides a valid global block and fails closed. After merging, validate once. Valid watchdog configuration requires:

- `enabled` is boolean.
- `warningMs` and `recoveryMs` are finite positive integers no greater than Node's maximum timer delay, `2_147_483_647` ms.
- `warningMs < recoveryMs`.

An invalid merged configuration disables the watchdog for the rest of the session, logs one `console.warn`, emits one visible TUI warning, and never starts timers or calls `ctx.abort()`. Reload tears down that extension instance; the replacement session resolves configuration from scratch and may enable the watchdog if the candidate is then valid.

Recommended explicit settings for policy D are:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  },
  "providerStallWatchdog": {
    "enabled": true,
    "warningMs": 120000,
    "recoveryMs": 240000
  }
}
```

Current Pi 0.80.10 already has those retry defaults, so the `retry` block is not technically required on that version. Documenting it explicitly prevents default or local-setting drift. Automatic recovery requires `retry.enabled === true`, `retry.maxRetries >= 1`, and an unused Pi retry attempt when the watchdog converts the abort. The extension cannot inspect or modify that retry budget.

## State and invariants

Session-local state contains:

- The pending input origin and whether a confirmed human TUI run is active.
- A monotonically increasing provider-request generation.
- The active generation and its last semantic-progress timestamp.
- Whether the current silence interval has warned.
- Timer handles for warning and recovery deadlines.
- The generation aborted by this watchdog, if any, and whether its captured `ctx.signal` was aborted externally first.
- The active signal listener, removed on every terminal or invalidation path.
- Whether timeout conversion is pending.
- Whether the one watchdog retry has been consumed for this human run.
- Whether a continuation request started after conversion.
- A session epoch that invalidates callbacks across shutdown or replacement.

Every `before_provider_request` in an active human run increments the generation, including requests after tools and the automatic continuation. Timer callbacks capture generation and epoch and must no-op unless both still match current state.

`stallRetryConsumed` is run-level state. Semantic output, a successful provider request, a tool call, or additional user steering does not clear it. Only `agent_settled` or session invalidation resets it. Therefore no human run can receive more than one watchdog-induced retry.

## Semantic-silence timing

At each eligible `before_provider_request`, capture `ctx.signal`, attach an abort listener, record request start from an injected monotonic clock as `lastSemanticAt`, and schedule both deadlines. If the signal aborts before the watchdog marks that generation, classify the abort as external and disarm conversion. A semantic delta is exactly one of:

- `text_delta` with `delta.length > 0`.
- `thinking_delta` with `delta.length > 0`.
- `toolcall_delta` with `delta.length > 0`.

The rule is exactly JavaScript `delta.length > 0`: ASCII or Unicode whitespace, zero-width characters, and any other non-empty string count as semantic progress. Empty deltas do not count. `start`, content start/end, `done`, headers, `after_provider_response`, lifecycle events, tool execution, and elapsed tool time do not reset deadlines. Deltas arriving after a generation is marked watchdog-aborted are ignored.

On semantic progress:

1. Record the current time.
2. Clear the keyed warning status.
3. Clear the warning latch.
4. Reschedule warning and recovery relative to that progress.

Timer callbacks calculate elapsed time from the same monotonic clock and act only when `elapsed >= threshold`; no tolerance window is used. If an early callback observes a smaller elapsed value, it reschedules the positive remaining interval. Configuration's timer-delay cap prevents clamped-delay reschedule loops. The warning callback writes keyed status such as `No model progress for 2m; aborting and asking Pi to retry once in 2m (Esc aborts now)`. Later semantic progress clears that status and permits one warning in a new silence interval.

`message_end` for the active assistant request disarms its timers and clears keyed status. `agent_end`, `agent_settled`, and `session_shutdown` are cleanup backstops. User and tool-result message completion must not accidentally disarm an active provider generation.

## Recovery flow

At the first recovery deadline in a human run:

1. Verify current epoch, generation, active run, valid config, elapsed boundary, and that the captured signal was not already aborted externally.
2. Clear timers and `ctx.ui.setStatus("providerStallWatchdog", undefined)` synchronously.
3. Mark that generation as watchdog-aborted and timeout conversion as pending before invoking abort, so the synchronous signal event remains attributable to the watchdog.
4. Set the run-level retry-consumed latch before aborting.
5. Call `ctx.ui.notify()` with the template: ``No model progress for ${elapsed}; aborting now. Pi will retry once if retry is enabled and capacity remains. Pending follow-ups are returned to the editor.``
6. Call `ctx.abort()`.

In TUI mode, `ctx.abort()` intentionally restores queued steering and follow-up messages to the editor. They are not included in the automatic continuation and are not lost; the user may submit them later. No public queue-preserving abort is used.

The following `message_end` replacement occurs only when all of these match:

- The message role is `assistant`.
- Its `stopReason` is `aborted`.
- The active generation is the generation marked by the watchdog.
- Timeout conversion is still pending.
- The watchdog retry has been consumed for this run.

The handler preserves all other assistant fields, sets `stopReason` to `error`, and sets an error string containing `timeout`. It then clears the pending conversion marker. Stale messages, user-triggered aborts, provider-triggered aborts, and unrelated errors remain untouched.

If Pi has retry capacity, its normal retry loop starts another provider request in the same turn. That request receives a new generation and is monitored, but retry eligibility is not restored. If it also reaches recovery, the extension warns, clears status, and aborts it without converting the resulting aborted message. The run then settles.

If `agent_settled` occurs after timeout conversion without a continuation request, Pi retry was disabled, exhausted, declined, or incompatible. The public API cannot distinguish these causes. The extension uses the cause-neutral notice: `The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually.` This is policy-B degradation: the stalled request is still aborted safely, with no synthetic fallback.

## Error handling and edge cases

- A new provider generation invalidates all callbacks from the previous generation.
- Session shutdown, reload, new session, resume, or fork increments the epoch, clears keyed status and timers, and prevents captured contexts from being used afterward.
- Normal completion and non-watchdog errors are never rewritten.
- A manual or provider abort observed on the captured signal before the watchdog marker disarms conversion, even if `message_end` is delayed. If the watchdog marks first, its synchronous abort owns the outcome; a later Esc occurs after recovery has already begun.
- Arrival of response headers without semantic deltas does not suppress warning or recovery.
- Tool execution is outside provider-silence measurement. A request after a tool starts a fresh generation and deadline window.
- Retry exhaustion is not treated as an extension error because the public extension context exposes no retry-budget query. Settlement triggers the documented manual fallback.
- Timer callbacks do not send prompts, queue messages, invoke tools, or directly mutate conversation history. TUI `ctx.abort()` may move already queued messages back to the editor as documented above.
- Warning uses only the keyed `providerStallWatchdog` status slot. Recovery, second-stall, invalid-config, and degradation messages use `ctx.ui.notify()`. Every terminal and invalidation path clears keyed status.
- On Pi 0.80.10, the second non-converted abort may be followed by Pi's cosmetic `auto_retry_end` success event because the retry loop itself ended. The watchdog's notice is explicit: `The retry also stopped making progress; aborting without another automatic retry. Submit the message again manually.`

## Testing

### Deterministic unit tests

Use an injected clock and fake scheduler. Cover:

- Warning and recovery at exact `elapsed >=` boundaries.
- Early timer callbacks rescheduling rather than acting.
- One warning per silence interval and a later warning after semantic progress.
- Non-empty text, thinking, and tool-call deltas resetting both deadlines.
- Empty deltas and non-semantic events not resetting deadlines.
- Whitespace deltas counting as progress.
- Request-generation and session-epoch isolation for stale callbacks.
- Pending interactive origin promoted only by `before_agent_start`, plus handled/preflight-failed interactive input followed by an extension-originated run remaining inert.
- Interactive TUI activation and inert JSON, RPC, print, RPC-input, and extension-input cases.
- Interactive steering during an active run not resetting retry consumption.
- Invalid merged settings disabling the session without timers or aborts.
- First-stall conversion, second-stall abort without conversion, and reset only at settlement.
- Delayed-`message_end` abort races: manual-first remains aborted without retry; watchdog-first converts and retries.
- Manual and unrelated provider aborts remaining unchanged.
- Global/project configuration matrices, including invalid values, invalid whole blocks, project invalidation, and valid project repair of invalid global shape or fields.
- Maximum timer delay accepted and one millisecond above it rejected.
- Cleanup on assistant `message_end`, `agent_end`, `agent_settled`, and `session_shutdown`.
- Manual-resubmission notice when settlement occurs without a continuation request.

Configuration tests set `PI_CODING_AGENT_DIR` to an isolated temporary directory so operator-global settings cannot affect results.

### Installed-runtime contract test

Use public `createAgentSession` with a controllable provider/model and the packaged extension. Do not call private session methods. Prove:

1. A human-TUI-equivalent run is activated through the public SDK: obtain `session` from `createAgentSession()`, call `session.extensionRunner.setUIContext(stubUiContext, "tui")`, then call `session.prompt()` with its default `source: "interactive"`.
2. A silent request is watchdog-aborted and finalized as an assistant abort.
3. `message_end` replacement makes that result a retryable timeout before retry evaluation.
4. Pi performs exactly one continuation using the same effective conversation.
5. The original user message appears once in effective model context.
6. Completed tool results remain in context and tool handlers are not invoked again.
7. A successful continuation completes normally.
8. A continuation that also stalls aborts and settles without recursion.
9. Disabled or exhausted Pi retry degrades to the cause-neutral manual-resubmission notice.
10. Requests around a tool boundary receive distinct generations and timing windows.
11. A follow-up queued during a stall is returned to the TUI editor by recovery and is absent from the automatic continuation.

This contract test is the compatibility pin for policy D. CI must fail if the installed supported Pi runtime stops applying `message_end` replacement before retry classification, stops classifying timeout errors as retryable, or stops continuing without duplicating user/tool effects.

## Packaging and documentation

- Add `provider-stall-watchdog.ts` to the npm files allowlist and `pi.extensions`; add the extension and its test file to the explicit typecheck inputs. The existing `*.test.ts` test command discovers the test without shipping it.
- Extend `README.md` with the opt-in default, human-TUI scope, thresholds, policy D, exact settings, automatic-recovery prerequisites, invalid-config behavior, verified Pi version, and policy-B/manual-resubmission fallback.
- Update `CHANGELOG.md` with the feature, safety boundary, policy choice, and tested runtime compatibility.
- Update `AGENTS.md` extension inventory, layout, and runtime notes without duplicating the state machine.
- Verify publishability with `npm pack --dry-run`.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` - watchdog enablement, thresholds, policy D prerequisites, fallback, and recovery procedure; `CHANGELOG.md` - shipped behavior and compatibility contract
- Derived / memory docs invalidated: `AGENTS.md` extension inventory, layout, and runtime notes

This section applies the brainstorming workflow's materiality bar in `reference/documentation-impact.md`; that workflow reference is not a repository implementation input.

## Acceptance criteria

- The extension is disabled by default and invalid merged config fails closed for the session.
- Only a run originating from interactive input in TUI mode can arm it.
- Every eligible provider request receives an isolated generation and deadlines measured from request start or the latest non-empty semantic delta.
- Warning and recovery use exact elapsed-time comparisons and warning repeats only after real semantic progress.
- The first stall in a human run aborts and is offered once to Pi's existing retry loop without synthetic input or repeated tool execution.
- A second stall aborts without another watchdog-induced retry.
- Unavailable Pi retry degrades to an explicit manual-resubmission path.
- Non-TUI and non-interactive processes remain unchanged.
- Unit, installed-runtime, typecheck, full-suite, and package-dry-run verification pass.
- User-facing documentation includes the exact required settings and conditions under which policy D actually continues automatically.
