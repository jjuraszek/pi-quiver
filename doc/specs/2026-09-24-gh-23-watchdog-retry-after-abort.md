# Watchdog re-drive after a session-level abort (pi >= 0.86)

## Status

Approved design for [GitHub issue #23](https://github.com/jjuraszek/pi-quiver/issues/23). Supersedes the "Recovery flow" section of [`doc/specs/2026-07-17-provider-stall-watchdog-scope.md`](./2026-07-17-provider-stall-watchdog-scope.md): policy D ("abort, convert, let pi retry") is replaced by a quiver-owned re-drive whenever pi declines to retry.

## Problem

pi 0.86.0 made `AgentSession.abort()` fence the whole logical run: it sets `_agentRunAbortRequested`, and `_willRetryAfterAgentEnd` returns `false` on that flag before it reads `retry.enabled`, `retry.maxRetries`, or the error text (`dist/core/agent-session.js:629-630, 1608-1618` in the host install `0.87.1`). Every abort route an extension has - `ctx.abort()` in the TUI (via the interactive abort handler) or headless (`session.abort()`) - lands on that same path. The watchdog's contract since `2026-07-17` was: abort the stalled request, rewrite the aborted assistant message to a retryable timeout error, and let pi's own retry loop issue the replacement request. On pi >= 0.86 the rewrite still happens, but the loop never runs, so a stall ends with the degradation notice and the user resubmits by hand.

Answer to the ticket's question ("must config change, or can it just work again?"): config cannot help and no new key is warranted. No `quiver.providerStallWatchdog.*` value, and no pi `retry.*` or `httpIdleTimeoutMs` value, influences the session flag. The fix is code; the existing keys (`enabled`, `firstEventMs`, `warningMs`, `recoveryMs`, `maxStallRetries`) stay the only watchdog inputs.

Premises verified against the installed pi 0.87.1 (all supported; the only correction is that this repo's `node_modules` pins pi `0.84.4`, so the existing runtime tests cannot exercise the flag):

- `pi-agent-core/dist/agent-loop.js:143-153`: on an `aborted`/`error` assistant message the loop calls `finishTurn` and discards its decision; `turn_end` `continue: true` cannot re-drive.
- `turn_end` still fires after an abort and its `entries` drafts are committed (`agent-session.js:332-364`); a `context_edit` with `replacement: null` is the same omission pi performs in `_omitRecoveryAttempt` (`:667-683`). The runner replaces the accumulated draft list with a handler's returned `entries` (`dist/core/extensions/runner.js:677-678`), so a handler must return `[...event.entries, draft]`.
- `agent_before_settle` does not fire after an abort (`:1083-1099`).
- `agent_settled` handlers are awaited (`:531-554`); `sendMessage(..., { triggerTurn: true })` called while the handler runs is pushed to `_deferredSettledActions` and awaited before the session resolves idle (`:1503-1506`), so `session.prompt()` / `waitForIdle()` callers (print mode, RPC, subagents) do not return until the re-driven run ends. A `session.prompt()` issued during that window is deferred too (`:1208-1210`), so the `input` event does not fire during the wait.
- `sendCustomMessage(..., { triggerTurn: true })` while idle runs `_runAgentPrompt`, which resets the abort flag (`:1079, 1481-1519`). `pi.sendMessage` returns `void`; the host attaches its own `.catch` and routes async failures to `emitError` (`:2397-2404`), so the extension cannot observe them.
- A custom message projects to the model as a `user` message (`dist/core/messages.js:89-96`).
- pi's native retry wait shows `RetryStatusIndicator` ("Retrying (n/m) in Ns... (Esc to cancel)") and rebinds Esc to `abortRetry()` (`dist/modes/interactive/interactive-mode.js:2922-2931`); idle Esc with an empty editor does not abort anything (`:2332-2345`). `ctx.ui.setStatus`, `ctx.ui.onTerminalInput` exist (`types.d.ts:79-83`).
- pi reads `retry.*` live at each retry decision (`settings-manager.js:607-623`); the RPC `set_auto_retry` command and the TUI toggle write the global file mid-session.
- No open upstream issue or PR asks for a request-scoped extension abort; `main` and `v0.87.1` `agent-session.ts` are byte-identical.

## Acceptance criteria

Ticket gh-23, "Acceptance Criteria" heading, rows verbatim:

- [ ] On pi 0.87.1 (the release the failure was observed on), with the watchdog enabled, a stalled provider request - either no first stream event within the configured window or no progress mid-stream - is stopped and a replacement provider request is issued without any user input. Evidence: a scripted manual repro against a real installed pi 0.87.1 (real AgentSession and abort path - an injected-runtime unit test alone cannot exercise the defect), documented in the closing commit; an automated integration test exercising the real host path is welcome if feasible but not required.
  in-scope
- [ ] Automatic recovery respects the host's retry settings: no re-issue when retry is disabled, at most `maxRetries` re-issues with the configured backoff, and after the budget is exhausted no further request is issued and the full degradation notice ("The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually.") does appear. Shown by tests or scripted repros for the disabled and exhausted cases.
  deviates: the re-issue cap is the watchdog's existing `maxStallRetries` (which already defaults to the layered pi `retry.maxRetries`), not pi's `retry.maxRetries` read a second time; a user who sets both gets the watchdog value. Everything else in the row - `retry.enabled` gating, pi's configured backoff, no request after exhaustion, the full degradation notice at exhaustion - is a Design clause below (D3, D4, D5).
- [ ] On successful recovery, that degradation notice does not appear.
  in-scope

## Goals

- Restore automatic recovery from a first-event or mid-stream stall on pi >= 0.86 with public extension hooks only, in every mode (TUI, print, RPC).
- Keep the user-visible experience as close to pi <= 0.85 as public hooks allow: the existing watchdog notices, the aborted attempt rendered as a timeout error, a retry countdown in the status bar, Esc cancels the pending retry, no new visible transcript block. The deltas that remain are listed in D7.
- Honor pi's `retry.enabled` and backoff formula so `retry.enabled: false` means "no automatic retries" everywhere.
- Keep the change deletable: once pi ships a request-scoped abort, the re-drive path is removed and policy D returns.

## Non-goals

- A new settings key. Rejected: the ticket rules out misconfiguration and every needed input exists.
- Provider-stream wrapping through `pi.registerProvider(id, { api, streamSimple })`. Rejected: it shadows custom base streams for that `api` (codex, copilot, radius) and needs re-registration on every model switch (`dist/core/provider-composer.js:336-351`).
- Upstream-only (file an issue, document degradation, leave #23 blocked). Rejected: leaves the watchdog's main feature dead for every current pi user. The upstream issue is filed anyway (D9) as the exit path.
- Re-sending the original user prompt via `sendUserMessage`. Rejected: duplicates the user turn in the session file and re-fires user-turn hooks (prompt templates, sibling extensions).
- A CI job running a real pi 0.87.1 TUI session. The installed-runtime suite (D10) covers the real `AgentSession` abort path headless; the TUI repro is manual and documented (D11).

## Design

### Decisions

| # | Decision |
|---|---|
| D1 | The stall-detection front half keeps its timers, generations, notices, and the `message_end` rewrite of the watchdog-owned aborted assistant message to `stopReason: "error"` with the timeout reason. The rewrite keeps the TUI rendering and error text identical and keeps the native path alive on any pi that still retries. One change: the exhausted branch of `abortStall` records `exhaustedAbortGeneration = capturedGeneration` (today it only announces and aborts). The exhausted attempt is still neither converted nor omitted; it stays `stopReason: "aborted"` in the transcript as today. |
| D2 | Re-drive eligibility is computed once per converted abort, at `turn_end`, from inputs all knowable there: `redrivePending` (set only by the `message_end` that converted the watchdog-aborted generation, i.e. `activeGeneration === watchdogAbortedGeneration`, and cleared by that turn's `turn_end`, so this turn's assistant entry is the converted watchdog abort) and layered pi `retry.enabled` (read at this moment, not cached). Budget is not re-checked here: `abortStall` already refuses to convert once `stallRetriesUsed >= maxStallRetries`, so a converted abort is by construction within budget. The result is stored as `redriveEligible`. |
| D3 | `turn_end`, when `redriveEligible`: return `{ entries: [...event.entries, { type: "context_edit", targetId: event.messageEntryId, replacement: null }] }`. The model never sees the dead attempt; the TUI still shows it. When not eligible (retry disabled, or the entry is not a converted watchdog abort) the drafts pass through untouched, so with `retry.enabled: false` the error assistant message stays last in context exactly as today (pi's own `_omitRecoveryAttempt` also runs only after its `enabled` check). |
| D4 | Re-drive delay is pi's agent formula, read from layered `settings.json` at the D2 decision with the same helper style and non-negative-integer validation as `resolveRetryMaxRetries`: `min(baseDelayMs * 2^(attempt-1), maxAgentDelayMs)`, `attempt = stallRetriesUsed`, defaults `baseDelayMs = 2000`, `maxAgentDelayMs = 60000`; the result is clamped to `2147483647` (Node's timer ceiling). pi's `retry.maxRetries` is not read as a second cap. |
| D5 | `agent_settled` decision, in order: (1) `exhaustedAbortGeneration` matches the last watchdog abort -> announce `DEGRADATION_NOTICE` (the exhausted notice already went out from `abortStall`; it is not repeated), full reset. (2) `convertedTimeout && continuationStarted` -> pi retried natively (pi <= 0.85); full reset, nothing announced. (3) `convertedTimeout && !continuationStarted && !redriveEligible` -> retry disabled; announce `DEGRADATION_NOTICE`, full reset. (4) `redriveEligible && !continuationStarted` -> re-drive per D6. (5) otherwise full reset as today. |
| D6 | Re-drive mechanics depend on mode, because the hosts settle differently. **Awaited** (`ctx.mode === "print"` or `"json"`, the one-shot hosts): the async `agent_settled` handler awaits the D4 delay via `runtime.setTimeout`, then calls `pi.sendMessage(...)` before returning; pi defers and awaits the run before resolving idle, so `session.prompt()` returns only after the replacement request finished. **Timer** (`ctx.mode === "tui"` or `"rpc"`, the long-lived interactive hosts): the handler returns immediately after arming `redriveTimer` for the D4 delay; on expiry it calls `pi.sendMessage(...)`, which runs `_runAgentPrompt` on the now-idle session. Interactive hosts cannot use the awaited form because a user prompt sent during the wait would be deferred behind our re-drive (`agent-session.js:1208-1210`) and, after the timer, the re-drive would run after the user's new prompt (`:1503-1506`) and the `input` cancel hook could not fire. RPC hosts supply `setStatus` and `onTerminalInput` (`rpc-mode.js:97-106`; the latter is a no-op there, so Esc-cancel is inert and RPC cancels via `input`), so D7 applies on the timer path in both modes. |
| D7 | Timer-path (TUI, RPC) wait presentation and cancellation, so the wait is neither invisible nor uncancellable: while `redriveTimer` is armed, `ctx.ui.setStatus("providerStallWatchdog", "Retrying (n/m) in Ns... (Esc to cancel)")` is refreshed once per second with `n = stallRetriesUsed`, `m = maxStallRetries`, and cleared (`undefined`) when the timer fires or is cancelled. A `ctx.ui.onTerminalInput` subscription active only during the wait consumes a lone `\x1b` (Esc) and cancels the re-drive: clear timer and status, announce `RETRY_CANCELLED_NOTICE` ("Automatic retry cancelled; submit the message again to retry manually."), full reset. Remaining deltas from pi's native wait, documented in `doc/provider-stall-watchdog.md`: the status lives in the footer status bar rather than the streaming indicator row, the editor is enabled during the wait, and the session emits `agent_settled` before the retry (see D8). |
| D8 | Ownership and cancellation of a pending timer-path re-drive. Any of the following cancels it (clear timer, clear status, full reset, no notice): `input` (user submitted a prompt), `before_provider_request` (a run started that the watchdog did not trigger - it is treated as the user's continuation and gets a fresh chain), `session_before_tree`, `session_before_compact`, `session_shutdown`. When the timer itself fires, `redriveInFlight = true` is set before `pi.sendMessage`; the next `before_provider_request` consumes it, sets `continuationStarted = true`, and keeps `stallRetriesUsed` so the chain counter spans the re-driven runs. An `input` event while `redriveInFlight` is still set (a user prompt landing between the send and the re-driven run's first provider request) also performs the full reset, so that run is the user's own and starts a fresh chain instead of being counted as the watchdog's continuation. Native continuation (pi <= 0.85 `agent.continue()`) also reaches `before_provider_request` with `convertedTimeout` set and marks `continuationStarted = true` as today; it never resets `stallRetriesUsed`, so a watchdog cap smaller than pi's cap still binds. `agent_start` is not hooked: native retry emits it too, so it cannot discriminate owners. |
| D9 | File one upstream pi issue asking for a request-scoped abort (e.g. `ctx.abort({ scope: "request" })`) that stops the provider request without fencing the run, link it from #23, and reference it in a code comment on the re-drive path as the deletion trigger. Filing is a write outside the repo and gets its own go-ahead at implementation time. |
| D10 | Bump devDependencies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` together to `^0.87.1` so the compiled-against `.d.ts` and the runtime harness's `pi-ai` stream helpers match one pi version. Type breaks in other extensions are fixed only where compilation fails. The existing installed-runtime suite is ported (Testing). |
| D11 | The TUI repro for AC 1 is manual, documented in `doc/provider-stall-watchdog.md`, and uses a committed artifact `test/manual/stall-provider.mjs`: a local HTTP server with two routes, one that accepts the request and never writes a byte (first-event stall), one that writes a single SSE chunk and then hangs (mid-stream stall), wired as an `openai-completions` provider in a temporary `models.json`. The doc gives the exact commands and the expected notices for the recovered, `retry.enabled: false`, and `maxStallRetries: 0` cases. |

### Data flow of one stall on pi >= 0.86

1. Timer expires -> `abortStall` -> `ctx.abort()`; on the exhausted branch `exhaustedAbortGeneration` is recorded instead of converting (D1).
2. `message_end` for the watchdog-owned aborted assistant message -> rewritten to a timeout error; `redrivePending = true`, `convertedTimeout = true` (D1).
3. `turn_end` -> D2 decision; if eligible, the omission draft is appended (D3).
4. `agent_end` -> `agent_settled` -> D5 branch. Eligible: print/json await the delay and send inside the handler; TUI/RPC arm `redriveTimer`, status countdown, Esc hook (D6, D7).
5. `pi.sendMessage({ customType: "provider-stall-watchdog", content: REDRIVE_TEXT, display: false }, { triggerTurn: true })` with `REDRIVE_TEXT = "The previous provider request stalled before completing and was retried automatically. Continue."` - one fixed sentence so condensers see a stable marker. It persists in the session file (`display: false` hides it from the TUI only); accepted as the record that a retry happened. Projected context then ends `[..., user, user(custom)]`; two consecutive user turns are accepted by the Anthropic and OpenAI conversions, and the manual repro runs against the user's configured provider to confirm the others.
6. New run: `before_provider_request` consumes `redriveInFlight`, sets `continuationStarted`; a stream event within `firstEventMs` and progress thereafter -> a successful assistant message resets `stallRetriesUsed` and `convertedTimeout` (existing code plus the `convertedTimeout` clear). Another stall -> back to step 1 with `stallRetriesUsed + 1`.

### State

| Field | Set by | Cleared by |
|---|---|---|
| `stallRetriesUsed` (existing) | `abortStall` converting branch (`+= 1`) | successful assistant `message_end`; full reset |
| `convertedTimeout` (existing) | `message_end` converting a watchdog abort | successful assistant `message_end`; full reset |
| `redrivePending` (new) | `message_end` converting a watchdog abort (`activeGeneration === watchdogAbortedGeneration`) | that turn's `turn_end`; successful assistant `message_end`; full reset |
| `continuationStarted` (existing) | `before_provider_request` when `convertedTimeout` or `redriveInFlight` | `message_end` converting a watchdog abort; full reset |
| `exhaustedAbortGeneration` (new) | `abortStall` exhausted branch | full reset |
| `redriveEligible` (new) | `turn_end` (D2) | full reset |
| `redriveTimer` (new, timer path) | `agent_settled` branch 4 | timer expiry; D8 cancellations |
| `redriveInFlight` (new) | timer expiry / just before the awaited-path `sendMessage` | `before_provider_request`; full reset |
| status key + Esc unsubscribe (new, timer path) | with `redriveTimer` | with `redriveTimer` |

"Full reset" is `resetRunState`, extended to clear the new fields and cancel `redriveTimer`. It runs at `agent_settled` branches 1, 2, 3, 5, after a re-driven run settles without a further stall, on every D8 cancellation, and on `session_shutdown`. It does **not** run at `agent_settled` branch 4, so the chain state survives into the re-driven run.

New hooks registered: `turn_end`, `input`, `session_before_tree`, `session_before_compact` (the last three cancel only; they return nothing).

### Settings read

Existing: `quiver.providerStallWatchdog.*`, pi `retry.maxRetries` (for the `maxStallRetries` default, still resolved once per session). New reads of existing pi keys at each D2 decision, same layering and validation as `resolveRetryMaxRetries`: `retry.enabled` (default `true`), `retry.baseDelayMs` (default `2000`), `retry.maxAgentDelayMs` (default `60000`).

## Error handling and edge cases

- `retry.enabled: false` -> no omission, no re-drive, degradation notice only (D3, D5 branch 3). Identical to today, including the error assistant message staying last in context.
- `maxStallRetries` exhausted (including `maxStallRetries: 0`) -> exhausted notice at abort, degradation notice at settle, no request, the final attempt stays `aborted` (D1, D5 branch 1).
- Esc during the TUI wait -> cancelled with `RETRY_CANCELLED_NOTICE` (D7). A submitted prompt, a tree switch, a manual `/compact`, or shutdown during the wait -> cancelled silently (D8).
- Native retry fires (pi <= 0.85) -> `continuationStarted` is set before `agent_settled`, so branch 2 resets and no re-drive is issued. The D3 omission and pi's own omission then target the same entry; `_applyBoundaryDrafts` accepts a second `replacement: null` on an already-omitted entry.
- The re-driven run stalls again -> same path, counter increments, delay doubles up to the cap; exhaustion ends in branch 1.
- `pi.sendMessage` is `void`; only a synchronous throw (stale extension instance) is catchable and resets the chain. Async failures are the host's (`emitError`); the chain state then clears at the next `before_provider_request` or `session_shutdown`.
- Sibling extensions observe an `agent_settled` before the retry. `session-name` treats settle as "no continuation pending" for its revisit; the new doc states that a stalled run settles once before its re-drive so that consumers can account for it. No sibling code changes ride in this spec.
- One-shot hosts (`print`, `json`): the awaited handler delays later extensions' `agent_settled` handlers by the backoff. Accepted; the alternative (timer after settle) lets `session.prompt()` resolve and the runtime dispose before the re-drive fires.

## Testing

`test/provider-stall-watchdog.test.ts`, fake-harness tests (existing fake `pi`, extended with `turn_end`, `input`, `session_before_tree`, `session_before_compact`, `sendMessage` capture, `ui.setStatus` / `onTerminalInput` capture, and the injected timer map):

- converted abort with `retry.enabled` true -> `turn_end` returns `[...event.entries, omission]` with a pre-seeded sibling draft preserved.
- print: `agent_settled` awaits `baseDelayMs` then calls `sendMessage` once with `triggerTurn: true`, `display: false`, `REDRIVE_TEXT`; a second stall waits `2 * baseDelayMs`; the delay caps at `maxAgentDelayMs`.
- TUI: `agent_settled` returns immediately, status text `Retrying (1/3) in 2s... (Esc to cancel)` is set and ticks, `sendMessage` fires at expiry, status is cleared; Esc during the wait cancels with `RETRY_CANCELLED_NOTICE`; `input`, `session_before_tree`, `session_before_compact`, and a foreign `before_provider_request` cancel silently.
- `retry.enabled: false` -> no omission draft, degradation notice, no `sendMessage`.
- `maxStallRetries: 0` and `maxStallRetries: 2` with three stalls -> exhausted notice then degradation notice, no `sendMessage` after exhaustion, final attempt not converted.
- native retry observed (`before_provider_request` before `agent_settled`) -> no `sendMessage`, `stallRetriesUsed` preserved across the native continuation (cap 1 with pi cap 3 still stops at 1).
- successful re-driven run -> its `turn_end` produces no omission draft; `stallRetriesUsed` and `convertedTimeout` reset.
- layering and live re-read of `retry.enabled`, `retry.baseDelayMs`, `retry.maxAgentDelayMs` mirror the existing `retry.maxRetries` test; a mid-session flip of `retry.enabled` to `false` before the next stall yields the disabled path.

Installed-runtime suite (existing `runtimeWatchdogHarness`, real `createAgentSession`, ported to 0.87.1 per D10): the harness writes the `retry` block into its `settings.json` instead of `SettingsManager.inMemory` so pi and the watchdog read the same values; each test awaits the re-driven run (`session.prompt()` now resolves after it in headless mode) and asserts the request count, the last assistant message via `sessionManager.getBranch()`, and the projected context. Cases: recovered first-event stall, recovered mid-stream stall (headless first-event only where mid-stream tiers are TUI-only), `retry.enabled: false`, exhaustion, and the existing tool-non-replay and follow-up-restoration invariants. This suite is the "automated integration test exercising the real host path" AC 1 welcomes.

Manual TUI repro (AC 1, D11): documented commands in `doc/provider-stall-watchdog.md` against `test/manual/stall-provider.mjs` on the host pi 0.87.1, observing the countdown, the replacement request, and the absence of the degradation notice; repeated with `retry.enabled: false` and `maxStallRetries: 0` for the two notices. The observations are recorded in the closing commit body.

## Documentation impact
- Feature / user-facing docs introduced: `doc/provider-stall-watchdog.md` - why pi >= 0.86 needs the re-drive, the hidden custom message and the resulting context shape, which pi `retry.*` keys are honored, the TUI wait deltas (D7), the intermediate `agent_settled` for extension consumers, the manual repro
- Materially amended existing docs: `README.md` watchdog rows (line 72 policy-D sentence, the `Opt-in extension config` watchdog section: point at the new doc, state that pi `retry.enabled` gates the re-drive); `CHANGELOG.md` `## Unreleased` bullet
- Derived / memory docs invalidated: `AGENTS.md` routing row `provider-stall-watchdog tiers and retry budget` retargets from the README anchor to `doc/provider-stall-watchdog.md`

Materiality per `reference/documentation-impact.md`: the new file exists because the README is an extension list and no doc owns the watchdog's runtime behavior; the ticket is not a doc.

## Open questions

None blocking. The upstream issue (D9) is filed at implementation time after its own go-ahead.
