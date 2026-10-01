# Early Initial Session Naming

**Goal:** Give enabled, unnamed sessions a title during long investigations by starting initial naming after three model/tool round trips, without making the agent wait for naming.

## Problem

Initial naming in `extensions/session-name.ts:665-679` runs only on `agent_end` and awaits generation. A long first agent chain stays unnamed until all its model/tool rounds finish; the naming request can then delay returning control. A credential-free replay observed zero naming calls across 30 rounds and one call only after `agent_end`. The active laptop profile already enables automatic naming, so this is a scheduling limitation rather than a disabled setting.

The user selected three round trips as the default threshold and required that naming cannot get stuck or block the investigation. "Default" changes the timing for enabled automatic naming; `quiver.sessionAutoName` remains opt-in. A short chain still gets an initial naming attempt when it ends, but that attempt must also run in the background.

## Acceptance criteria

none - no ticket

## Design

### Trigger and counting

1. For an enabled, unnamed session, start the initial naming attempt at the third `turn_end` of its current agent run. A round is one Pi-completed assistant turn and its tool results, regardless of how many tools ran. Count the Pi events, including terminal error/aborted turns; do not invent a second success classification. Count within the current run, not across persisted history.
2. `agent_end` starts the same attempt when no initial attempt has started, including runs shorter than three rounds. It never starts a second attempt while an early attempt is pending or after one has finished or failed.
3. Use the existing initial-attempt guard as the single one-shot authority. Mark the attempt started before dispatching asynchronous work. No automatic retry occurs during that session activation; reopening an unnamed session can try again on its next agent run. A named resumed session skips initial generation.
4. Both triggers check the existing enabled/name gates. Add no setting for the threshold or deadline and no persistence entry for attempt state. Disabled automatic naming performs no naming requests or timer setup. Pi still constructs boundary context for registered `turn_end` handlers, including callbacks that return at their enabled gate; disabled naming is not a claim of zero host hook overhead. Retain this boundary because the assistant response and its tool results are already persisted.

### Background execution and deadline

5. Start the attempt without returning or awaiting its promise from `turn_end` or `agent_end`. No subsequent round, editor return, session replacement, or shutdown joins the naming request. Catch its asynchronous failures inside the background task; never produce an unhandled rejection.
6. The initial attempt has a fixed 30,000 ms local deadline starting before generation preparation. It covers transcript/model preparation, credential lookup, lazy completion loading, and the model request. Enforce local abandonment independently of whether those operations accept or honor cancellation.
7. On expiry, invalidate the attempt, release its active bookkeeping, and request cancellation through an attempt-local `AbortSignal` passed to the existing completion path. Do not await provider cancellation or clear the one-shot guard. A late resolution or rejection is consumed without applying a name, emitting a notification, or starting a later request stage. After an asynchronous preparation step returns, check cancellation before proceeding to another stage.
8. Clear the deadline and any attempt-owned cancellation listeners on completion, failure, or invalidation. The deadline timer must not keep Node running by itself. Preserve the distinction between abandoning an asynchronous operation and forcing third-party code to stop: the extension guarantees no main-flow await on naming I/O, not preemption of synchronous deadlocks or provider-side request scheduling.
9. Never invoke `ctx.abort()` or lifecycle command operations to cancel naming. The naming request owns its cancellation controller; it cannot cancel the investigation. Normal `agent_end`, including a user's stop of the run, does not itself invalidate the attempt: a title can arrive while the same session remains idle.

### Session ownership and applying results

10. Associate each attempt with the session activation that launched it. Shutdown invalidates the attempt before requesting cancellation and never awaits it; session initialization also invalidates any prior attempt before its enabled gate or any early return, then resets activation state. Repeated cleanup is safe. An old attempt's completion or cleanup cannot name a successor session, access a replaced context, notify through it, or clear a successor attempt's state.
11. Capture generation inputs and required context-owned values while that context is valid. Following asynchronous boundaries, require a still-valid attempt before accessing session/runtime APIs or applying side effects. A request-local cancellation signal must remain effective even when the Pi event context has no operation signal.
12. A human name takes precedence. Existing names suppress initial generation; any manual or external rename while generation is pending prevents applying that result. The final validity and ownership checks occur immediately before the synchronous name write, with no intervening await.
13. Apply accepted names through the existing `setName` path: naming rules, deny-list handling, `pi-quiver.session-name-author` provenance, curated tab labels, Ghostty gating, and Herdr ownership remain intact. Event handlers never await the initial attempt; the detached task may await `setName` and its existing bounded sink synchronization. Existing bounded Herdr synchronization/restoration remains; this change does not replace terminal ownership or shutdown restoration.
14. The deadline bounds preparation/generation, not an already-accepted name's bounded sink synchronization. Do not roll back a name already persisted. Recheck activation/name ownership before any post-synchronization notification; never emit a late naming notification through a replaced context.

### Existing boundaries

- Keep the change within `extensions/session-name.ts` and its existing tests. Extend the injected-generator test seam only as needed to control completion, cancellation, and observe local task cleanup; add no general background-job framework, helper process, or new extension.
- Preserve the existing provider/authentication path, including environment-key handling, auth-specific base URLs, and lazy Pi AI compatibility loading. Thread request cancellation into that path rather than migrating providers as part of this timing change.
- Preserve initial prompt sampling: the first 4,000 characters of persisted conversation, skill-body stripping, and tool-result snippets capped at 400 characters. At `turn_end`, the completed response and tool results have already been persisted. This changes timing, not the transcript selection algorithm.
- Keep configured revisits on `agent_settled`, with their existing cadence and human-name protection. Earlier initial naming must not move revisits into an active run or turn an initial timeout into a retry. No new revisit deadline policy is introduced.
- Keep `/session-name` available while automatic naming is disabled. Preserve its existing explicit user-command behavior; it is not the background initial-name trigger.

## Errors and edge cases

| Situation | Required result |
|---|---|
| Rounds one and two of a longer run | No initial naming request yet. |
| Third completed round | Start one attempt without waiting; the next round remains runnable. |
| Run finishes before three rounds | Start one background attempt at `agent_end`; return control without waiting. |
| Run ends while an attempt is pending | Do not duplicate or join it; it may finish while the same session remains active. |
| Run settles while initial generation is pending and the session remains unnamed | The existing revisit handler skips without advancing its cadence; a crossed cadence point stays eligible at the next settle after naming succeeds. |
| Missing model/credentials, invalid reply, `KEEP`, or provider failure | Leave the session unnamed, consume failure, and do not automatically retry. |
| Credential lookup or completion never resolves | Abandon locally at 30 seconds without requiring upstream cancellation to settle. |
| Preparation returns after abandonment | Do not start a subsequent naming request stage. |
| Late success/rejection after timeout or shutdown | Consume it without naming, notifying, or touching an invalid context. |
| Manual/external rename during generation | Preserve the human name and existing tab-ownership rules. |
| Session replacement or reload | Invalidate old work; initialize independent attempt state for the new activation. |
| Process exits before naming finishes | Do not delay exit to obtain a title; an unnamed session is acceptable. |

## Tests

Extend the existing injected-generator harness in `test/session-name.test.ts`. Keep tests credential-free, use controlled promises and a controllable clock/deadline rather than 30-second sleeps, and verify effects instead of relying on elapsed-time luck.

1. Drive `agent_start` and `turn_end`: no request after rounds one/two, exactly one after round three, and no extra request after round four or `agent_end`. Multiple tool results in one event count as one round. Cover terminal error/aborted events consistently with the event-count rule.
2. Keep generation unresolved and assert the third-round handler, next-round hooks, and `agent_end` return before it settles. Repeat for a short run's `agent_end` fallback.
3. Resolve a pending attempt after normal `agent_end` and assert its name applies to the same still-active session through existing rule/provenance/tab handling.
4. Advance the local deadline with a generator that ignores cancellation. Assert cancellation is requested, local bookkeeping settles, no retry occurs, and late fulfillment/rejection has no effects or unhandled rejection.
5. Hold credential preparation unresolved until after expiry; when released, assert no model request starts. Check that a completion begun before expiry receives the attempt's cancellation signal. Use a narrow test seam if the existing generator injection cannot observe this production path.
6. Shut down with naming unresolved. Assert shutdown does not join naming, old results never access the invalid context, and repeated cleanup is safe. Start a successor session before settling the old promise and prove neither old fulfillment nor cleanup changes its name or attempt state. Include a successor with automatic naming disabled, proving invalidation precedes that enabled gate.
7. Manually rename during a pending request through both `/session-name` and external session-name notification. Resolve the old request and assert human name/provenance is preserved.
8. Verify disabled configuration and already-named resumed sessions create no request or deadline; an unnamed resumed session counts its next run independently of old transcript history.
9. Assert deadline/listener cleanup on success, failure, timeout, and shutdown; assert the deadline timer is non-keeping-alive. Keep existing auth, prompt, deny-list, revisit, and terminal-sink regression coverage.

Implementation verification uses `env -u PI_CODING_AGENT_DIR node --test test/session-name.test.ts` and the repository's `env -u PI_CODING_AGENT_DIR npm run test:all`. Real-provider latency/title quality are not prerequisites for these deterministic guarantees; any live smoke test is separately authorized and must not be represented as already performed.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: README.md; CHANGELOG.md
- Derived / memory docs invalidated: none

Apply `reference/documentation-impact.md`. README.md's "Opt-in extension config" section is the existing owner and must explain the default three-round timing, the shorter-run fallback, and best-effort non-blocking behavior; this is the operations/configuration contract, not a code walkthrough. CHANGELOG.md receives an `Unreleased` entry for the changed automatic-naming behavior and non-blocking fallback, a user-facing compatibility decision. Do not add a standalone naming guide. Update touched source comments that otherwise confuse initial naming with settle-only revisits.

## Out of scope

- Enabling automatic naming for all users, adding timing settings, or changing naming models/prompts/context budgets.
- Renaming during a run via the revisit feature, changing revisit cadence, or adding retry/backoff machinery.
- A provider API migration, process isolation, generic task scheduler, or forced termination of uncooperative third-party code.
- Reworking manual naming, Ghostty/Herdr ownership, or existing bounded terminal-sink operations.

## Open questions

None block the design. Third-round title quality and real-provider cancellation behavior have not been measured; the guarantees are local scheduling, deadline enforcement, ownership, and stale-result rejection, not a promise that every title appears before round four.
