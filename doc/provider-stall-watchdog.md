# provider-stall-watchdog

Opt-in recovery from provider requests that stall: no first stream event within `firstEventMs` (every mode), or no parsed semantic progress for `recoveryMs` mid-stream (TUI only). Settings live under `quiver.providerStallWatchdog` in `settings.json`; the key table and recommended values are in [`README.md`](../README.md#opt-in-extension-config). This guide covers what happens after the watchdog aborts.

## Why the watchdog re-drives the request itself

pi >= 0.86 fences the whole run when `AgentSession.abort()` is called: the run's abort flag makes pi's retry loop return before it reads `retry.enabled`, `retry.maxRetries`, or the error text. Every abort route an extension has lands on that path, so the earlier handshake (abort, rewrite the aborted message to a retryable timeout error, let pi retry) no longer produces a replacement request. The watchdog therefore issues the replacement request itself. Once pi offers a request-scoped abort, this re-drive path can be removed and the native handshake restored.

## Recovery flow

|Step|Hook|Effect|
|---|---|---|
|1|stall timer|`ctx.abort()`; the existing stall notice|
|2|`message_end`|the watchdog-owned aborted assistant message is rewritten to `stopReason: "error"` with the timeout reason (TUI rendering unchanged)|
|3|`turn_end`|if pi's layered `retry.enabled` is `true`, a `context_edit` omits that message from the model's context (the transcript still shows it)|
|4|`agent_settled`|One-shot hosts (`print`, `json`): the handler waits pi's backoff and sends the re-drive before returning, so `session.prompt()` resolves after the replacement run. Interactive hosts (`tui`, `rpc`): a countdown timer is armed and the handler returns, so a prompt sent during the wait cancels it instead of queueing behind it.|
|5|re-drive|`pi.sendMessage({ customType: "provider-stall-watchdog", display: false }, { triggerTurn: true })` with the fixed text `The previous provider request stalled before completing and was retried automatically. Continue.`|
|6|new run|the chain counter (`n/maxStallRetries`) carries over; a successful assistant message resets it|

The interactive timer path is necessary because a prompt sent during an awaited settle would be deferred behind the re-drive, preventing its `input` event from cancelling the wait.

## Which pi `retry.*` keys are honored

Read live from the layered `settings.json` files at each stall (pi's own defaults apply), except for the session-scoped `maxStallRetries` default:

|Key|Default|Use|
|---|---|---|
|`retry.enabled`|`true`|`false` -> no omission, no re-drive; the degradation notice prints|
|`retry.baseDelayMs`|`2000`|backoff `baseDelayMs * 2^(attempt-1)`|
|`retry.maxAgentDelayMs`|`60000`|backoff cap|
|`retry.maxRetries`|`3`|only as the default for `quiver.providerStallWatchdog.maxStallRetries`, read once per session|

`maxStallRetries` is the single re-issue cap. When it is exhausted the exhausted notice prints at the abort and the degradation notice (`The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually.`) prints when the run settles; the final attempt stays `aborted` in the transcript.

## What the model and the transcript see

The re-drive message is hidden from the TUI (`display: false`) but persists in the session file and reaches the model as a `user` turn, so the projected context ends `[..., user, user]` - the original prompt, then the fixed sentence. Anthropic and OpenAI conversions accept consecutive user turns; the manual repro below runs against your configured provider to confirm others.

## TUI and RPC wait: what differs from pi's native retry

- The countdown `Retrying (n/m) in Ns... (Esc to cancel)` uses status key `providerStallWatchdog` and lives in the footer status bar (`ctx.ui.setStatus`), not the streaming indicator row. Both TUI and RPC use the timer path; RPC renders the countdown through `setStatus`.
- The TUI editor stays enabled during the wait. Submitting a prompt, switching the session tree, or running `/compact` cancels the pending retry silently; Esc cancels it with `Automatic retry cancelled; submit the message again to retry manually.` During the wait the watchdog consumes every lone Esc keystroke, including one intended to close an overlay.
- RPC's `onTerminalInput` is a no-op, so Esc cancellation is inert there; a new prompt (`input`) cancels the timer instead.
- The session emits `agent_settled` before the retry. Extensions that treat settle as "no continuation pending" (for example `session-name`'s revisit) see one extra settle per stall.
- A prompt arriving after the re-drive is sent but before its first provider request also resets the chain: the user's run starts fresh at `(1/m)`.

## Manual repro (pi 0.87.1, TUI)

1. Start the stalling provider: `node test/manual/stall-provider.mjs` (listens on `127.0.0.1:8765`; `PORT=` overrides).
2. Point a throwaway agent dir at it. Create `/tmp/stall-agent/models.json`:

   ```json
   {
     "providers": {
       "stall-first": { "baseUrl": "http://127.0.0.1:8765/first-event", "apiKey": "x", "api": "openai-completions", "models": [{ "id": "stall", "name": "first-event stall" }] },
       "stall-mid": { "baseUrl": "http://127.0.0.1:8765/mid-stream", "apiKey": "x", "api": "openai-completions", "models": [{ "id": "stall", "name": "mid-stream stall" }] }
     }
   }
   ```

   and `/tmp/stall-agent/settings.json`:

   ```json
   { "quiver": { "providerStallWatchdog": { "enabled": true, "firstEventMs": 3000, "warningMs": 4000, "recoveryMs": 6000, "maxStallRetries": 2 } }, "retry": { "enabled": true, "baseDelayMs": 1000 } }
   ```

3. First-event stall: `PI_CODING_AGENT_DIR=/tmp/stall-agent pi -e ./extensions/provider-stall-watchdog.ts --model stall-first/stall`, send any prompt. Expected: `Provider sent no response for 3s; stopping and retrying the request.`, the aborted message rendered as a timeout error, the footer shows `Retrying (1/2) in 1s... (Esc to cancel)`, a second request hits the server (its stderr logs `client aborted` then a new `first-event stall`), then `(2/2)`, then `Provider sent no response for 3s and the stall-retry budget is spent; the request was stopped.` followed by the degradation notice. No degradation notice appears between the retries.
4. Mid-stream stall: same with `--model stall-mid/stall`. Expected: `Thinking about it` streams, then `No model progress for 4s; aborting and asking Pi to retry in 2s (Esc aborts now)`, followed at 6s by `No model progress for 6s; aborting now. Pi will retry (1/2) if retry is enabled and capacity remains. Pending follow-ups are returned to the editor.`, the countdown, and a replacement request.
5. `retry.enabled: false` in `settings.json`: one stall, the degradation notice, no second request on the server.
6. `maxStallRetries: 0`: the exhausted notice at the abort, the degradation notice at settle, no second request.
7. Repeat the first-event case with your normally configured model and default agent dir: run `pi -e ./extensions/provider-stall-watchdog.ts` and send a real prompt. Temporarily set `quiver.providerStallWatchdog.firstEventMs` very low (for example, `50`) so the request trips the watchdog. The replacement request completes and the model answers normally after the hidden `Continue.` turn, confirming this provider accepts `[..., user, user]`. Anthropic and OpenAI-compatible conversions already accept consecutive user turns; this check confirms other configured providers.
