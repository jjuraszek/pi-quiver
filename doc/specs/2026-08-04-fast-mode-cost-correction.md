# Fast-Mode Cost Correction

Issue: [jjuraszek/pi-quiver#6](https://github.com/jjuraszek/pi-quiver/issues/6)

## Problem

The `fast-mode` extension injects `speed:"fast"` + the `fast-mode-2026-02-01`
beta header for Opus 4.8/5, opting into Anthropic fast-mode pricing (2x standard:
`$10`/`$50` per MTok input/output vs `$5`/`$25`, with cache multipliers stacking
on top). But `pi-ai` prices every request at **standard** rates: its `Usage` type
has no `speed` field, and `calculateCost` has no request-level pricing modifier.
So every fast request's reported `usage.cost` - shown in the statusline,
aggregated by pi-cohort's `Σ$`, and persisted to the session JSONL - is
**understated by ~2x**. The user opted into premium pricing but the agent's own
accounting hides it.

## Goal

Correct the reported cost of requests that *this extension* made fast, in the
same process, at `message_end`, via a returned replacement message. Concretely,
after this change:

- **pi's own finalized message + statusline** reflect the true fast cost (they
  read the message after `message_end` applies the replacement).
- **the persisted session JSONL** stores the corrected cost (the replacement is
  applied before `appendMessage`), so resume and any post-hoc analysis are exact.
- **pi-cohort's `Σ$`** is corrected **live only when** pi-quiver's `message_end`
  handler runs before pi-cohort's, and is corrected unconditionally after
  pi-cohort's next `session_start` resync (it re-seeds from the corrected JSONL).
  Live `Σ$` under a pi-cohort-first load order is explicitly **best-effort** - see
  [Load order vs pi-cohort](#load-order-vs-pi-cohort). This is a deliberate scope
  boundary, not an oversight.

Nothing else about fast mode changes.

## Scope

- **In:** local `message_end` cost correction inside `fast-mode.ts`; an exported
  `FAST_MODE_COST_MULTIPLIER`; a pure `scaleCost` helper; per-request snapshot
  flags; tests; README + CHANGELOG.
- **Out:** the upstream `pi-ai` fix (teach `Usage`/`calculateCost` about
  `usage.speed`). That is the better long-term fix but is tracked separately and
  does **not** block this correction (issue AC #8, dropped from this deliverable
  per brainstorming Q1). No cross-org filing obligation here.
- **Out:** any cross-package handler-ordering enforcement mechanism. pi-quiver
  cannot control the relative `message_end` order of a separate package; the live
  `Σ$` best-effort boundary above is accepted rather than engineered around.
- **Out:** cross-process subagent-leg correction. Not needed - see
  [Non-issue: subagent legs](#non-issue-subagent-legs).

## Relationship to prior spec

Additive to [doc/specs/2026-07-12-fast-mode-opus.md](./2026-07-12-fast-mode-opus.md),
which owns injection, state lifecycle, the `/fast` command, and the status
indicator. That spec is **not superseded** - this one only adds a cost-correction
concern to the same extension. No supersession banner is written.

## Ground truth (verified this session)

Every runtime claim below is cited to installed source
(`@earendil-works/pi-coding-agent@0.80.10` and its bundled `pi-ai`).

- **Provider-hook firing order: `before_provider_headers` fires BEFORE
  `before_provider_request`.** This corrects an earlier assumption (the reverse).
  Wiring: `dist/core/sdk.js:188` maps `transformHeaders -> before_provider_headers`;
  `dist/core/sdk.js:196` maps `onPayload -> before_provider_request`. Order:
  `dist/core/model-runtime.js` `streamSimple` (line 330) `await`s `prepareRequest`
  (line 332), which runs `transformHeaders` (lines 305-306) and returns, **before**
  it calls `prepared.provider.streamSimple` (line 333); that provider call reaches
  `pi-ai/dist/api/anthropic-messages.js:361` `options.onPayload`. So headers are
  finalized first, payload second. **The design below does not depend on this
  order** (each hook owns its own flag), but the order is stated so the tests
  drive hooks realistically and any future reader is not misled again.
- **Return-replacement from `message_end` is honored and persists.**
  `dist/core/extensions/runner.js` `emitMessageEnd` (~lines 570-607) threads
  `currentMessage = handlerResult.message` handler-to-handler and returns the
  final; `dist/core/agent-session.js` applies it via
  `_replaceMessageInPlace(event.message, normalized)` (lines ~479-490) before
  `appendMessage(event.message)` (~line 361). So a returned `{ message }` reaches
  later handlers (pi-cohort) live and is what gets persisted. This contradicts
  issue comment #4's claim that message_end returns are discarded; the installed
  `docs/extensions.md` even documents a worked example rewriting `usage.cost`. The
  repo's own `provider-stall-watchdog.ts` uses the return idiom. The runner
  enforces same-role; the replacement preserves `role:"assistant"`.
- **`injectSpeed` no-ops on non-object payloads.** `fast-mode.ts` `injectSpeed`
  returns the payload **unchanged** when it is not a plain object
  (`typeof !== "object" || null || Array.isArray`), and otherwise returns
  `{ ...payload, speed:"fast" }` (a new object). So "we injected speed" must be
  derived from the *output*, not from the `shouldInject` gate alone.
- **Cost shape.** `Usage.cost = { input, output, cacheRead, cacheWrite, total }`
  (`cacheWrite1h` is a token subset, not a cost field). `calculateCost` is
  pure-linear in token counts x rates, so a flat per-component multiplier is
  arithmetically exact. All four component fields are always populated by `pi-ai`
  for a successful response.
- **Pricing = exactly 2x, with cache stacking, verbatim from Anthropic.** Fast
  rate card (retrieved 2026-08-04,
  https://docs.claude.com/en/docs/build-with-claude/fast-mode): "Fast mode is
  priced at a multiplier on standard rates across the full context window,
  including requests over 200k input tokens." The published table gives Opus 5 /
  Opus 4.8 fast `Input $10 / MTok`, `Output $50 / MTok` - exactly 2x standard
  (`$5`/`$25`). Cache stacking, verbatim: "Prompt caching multipliers apply on top
  of fast mode pricing" (and "Data residency multipliers apply on top of fast mode
  pricing"). Standard cache rates for `claude-opus-4-8` (`cacheRead $0.5`,
  `cacheWrite $6.25`) therefore also scale 2x. One multiplier of `2` is correct
  for all four components.
- **Supported models never silently downgrade.** For Opus 5 / Opus 4.8, a
  `speed:"fast"` request either succeeds at fast speed or returns an error
  (`429`/`529` on rate limit/capacity); it does **not** silently run standard.
  Only Opus 4.6 silently downgrades (`usage.speed:"standard"`), and 4.6 is out of
  scope (not in `FAST_MODE_MODEL_PREFIXES`). Consequence: for in-scope models,
  "we shipped both signals AND got a costed response" soundly implies the request
  was billed fast. `usage.speed` is the authoritative signal, but `pi-ai` discards
  it (the root problem); our two-flag proxy is the best available and is sound
  here.

## Design

All changes land in `fast-mode.ts` (the fast enabler extension itself) plus its
test file, README, and CHANGELOG. No new file, no new `pi.extensions` entry. The
correction is deliberately coupled to injection in one module: fast pricing only
ever occurs because this module injected the signals, so this module is also the
only place that can know to correct it.

### Constant and helper (defined before use)

```ts
// Anthropic bills Opus 4.8/5 fast mode at exactly 2x standard rates; input,
// output, and cache read/write all scale by the same factor because caching
// multipliers "apply on top of fast mode pricing". Rate card:
// https://docs.claude.com/en/docs/build-with-claude/fast-mode (retrieved 2026-08-04).
export const FAST_MODE_COST_MULTIPLIER = 2;

export function scaleCost(cost: Usage["cost"], multiplier: number): Usage["cost"] {
  const input = cost.input * multiplier;
  const output = cost.output * multiplier;
  const cacheRead = cost.cacheRead * multiplier;
  const cacheWrite = cost.cacheWrite * multiplier;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
```

`Usage` is imported as a type from `@earendil-works/pi-ai`. `total` is recomputed
as the sum of scaled components (not `total * multiplier`) so the object is
internally consistent. **Precondition:** all four component fields are present
(guaranteed by `pi-ai` for a costed response); the `message_end` gate below
returns early when `usage.cost` is absent, so `scaleCost` never sees a partial
object.

### Per-request snapshot (order-independent)

Two module-scoped booleans, declared at the top of the extension's default
export beside the existing state (`let liveOverride: boolean | null = null;` and
`let enabled = false;`):

```ts
let pendingFastSpeed = false;
let pendingFastHeader = false;
```

The invariant that makes this correct regardless of hook order: **each hook
overwrites its own flag on every request** to reflect what it actually did this
request - it never resets the *other* hook's flag. So whichever hook fires first,
both flags end up reflecting the final outgoing request by the time `message_end`
reads them. `message_end` then **consumes** (clears both) so a second
`message_end` for the same snapshot cannot double-correct. This removes the need
for any "reset at request start" step (the source of the earlier reversed-order
bug) and is inherently retry-safe (a re-fired hook re-sets its own flag to the
same value).

### Hook changes (faithful to current bodies)

`before_provider_headers` (fires first) - add the two flag assignments:

```ts
pi.on("before_provider_headers", async (event, ctx) => {
  if (!shouldInject(enabled, ctx.model) || !event.headers) { pendingFastHeader = false; return; }
  const isOAuth = await detectOAuth(ctx);
  if (isOAuth === null) { pendingFastHeader = false; return; }
  event.headers[BETA_HEADER] = buildBetaHeader(event.headers[BETA_HEADER], isOAuth);
  pendingFastHeader = true;
});
```

`before_provider_request` (fires second) - set the speed flag from the *output*:

```ts
pi.on("before_provider_request", (event, ctx) => {
  if (!shouldInject(enabled, ctx.model)) { pendingFastSpeed = false; return; }
  const next = injectSpeed(event.payload);
  pendingFastSpeed =
    typeof next === "object" && next !== null && (next as Record<string, unknown>).speed === FAST_SPEED;
  return next;
});
```

Gating `pendingFastSpeed` on `next.speed === FAST_SPEED` (not on `shouldInject`
alone) closes the non-object-payload gap: if an upstream extension replaced the
payload with a non-object, `injectSpeed` no-ops, the flag reads false, and a
standard-priced response is never doubled.

### Correction at message_end (consume on the assistant message)

```ts
pi.on("message_end", (event) => {
  const msg = event.message;
  if (msg.role !== "assistant") return;              // ignore non-assistant; do not consume
  const corrected = pendingFastSpeed && pendingFastHeader && !!msg.usage?.cost;
  pendingFastSpeed = false;                            // consume on the assistant message_end
  pendingFastHeader = false;
  if (!corrected) return;
  return {
    message: {
      ...msg,
      usage: { ...msg.usage, cost: scaleCost(msg.usage.cost, FAST_MODE_COST_MULTIPLIER) },
    },
  };
});
```

Consuming only on the assistant `message_end` (not on interleaved non-assistant
ones) means the correction is not cleared before the message it belongs to
arrives. Requiring **both** flags exactly tracks "was this request billed fast":
Anthropic fast-prices only with both the `speed:"fast"` payload field and the
beta header, so a mid-flight `/fast` toggle (which leaves at most one flag set)
correctly yields no correction - matching the server.

## Data flow (one request)

1. `before_provider_headers` (first): set `pendingFastHeader` to whether the beta
   header was actually written this request.
2. `before_provider_request` (second): set `pendingFastSpeed` to whether the
   outgoing payload actually carries `speed:"fast"`.
3. Provider responds (or errors).
4. `message_end` for the assistant message: read both flags, clear both, and if
   both were set and `usage.cost` exists, return the replacement with
   `scaleCost(cost, 2)`.

## Edge cases

The two flags are **request-level** (set by the hooks); `role`/`usage.cost` are
**per-message** guards in `message_end`. Kept orthogonal:

| Case | Behaviour | Why correct |
|---|---|---|
| Auth unresolvable (`detectOAuth === null`) | `pendingFastHeader=false` -> no correction | no beta header shipped -> server did not fast-price |
| Non-object payload (`injectSpeed` no-ops) | `pendingFastSpeed=false` -> no correction | `speed:"fast"` not actually sent |
| `/fast` toggled mid-flight (either direction) | at most one flag set -> no correction | matches server (needs both signals) |
| Fast request errors, no assistant `message_end` | next request's hooks overwrite both flags | no stale correction leaks |
| Fast request errors WITH assistant `message_end`, no cost | flags consumed, `!usage.cost` -> no correction | nothing to scale; no leak |
| Transport/SDK retry re-fires a hook | flag idempotently re-set to same value | exactly one correction at the single `message_end` |
| Second assistant `message_end`, no intervening hooks | flags already consumed -> no correction | cannot double-scale (2x -> 4x) |
| Non-assistant `message_end` | returns early, flags untouched | doesn't consume another request's snapshot |
| Non-Opus / fast-off (`shouldInject` false) | both flags false | standard price, nothing to correct |

### Load order vs pi-cohort

The return-replacement corrects the persisted JSONL unconditionally (applied
before `appendMessage`), so resume and pi-cohort's next-`session_start` re-seed
are always exact. The **live** `Σ$` statusline reflects the correction only if
pi-quiver's `message_end` handler runs before pi-cohort's, because pi-cohort
accumulates `mainCost` from `event.message.usage.cost.total` in its own
`message_end` handler and does not re-reconcile mid-session. pi-quiver cannot
enforce cross-package handler order, so this is documented as a known best-effort
limitation (see [Goal](#goal)), not engineered around. pi's own native cost
display is unaffected (it reads the finalized, replaced message).

### Non-issue: subagent legs

Fast-mode 2x pricing only ever occurs because pi-quiver injected `speed:"fast"`,
which only happens where pi-quiver is loaded and enabled. The correction lives in
that same module, gated on the per-request snapshot. So every `pi` process is
self-consistent: it either injected fast **and** corrects, or did neither
(standard price, nothing to correct). A fast-priced-but-uncorrected leg cannot
exist; no cross-process caveat is needed.

## Testing

Follows `fast-mode.test.ts` conventions: pure-function `node:test` plus the
existing `harness()`. `harness()`'s `pi.on` captures every registered hook into a
generic `h.hooks` map (`on: (event, h) => hooks.set(event, h)`), so the new
`message_end` handler is exercised via `h.hooks.get("message_end")!({ message }, h.ctx)`
with **no** harness change. Build the assistant message using the shape in
`provider-stall-watchdog.test.ts` (`role:"assistant"`, `api`/`provider`/`model`,
`usage:{ input, output, cacheRead, cacheWrite, totalTokens, cost:{ input, output,
cacheRead, cacheWrite, total } }`).

Pure `scaleCost`:
- Scales all four components by 2; `total` equals the sum of scaled parts.
- Zero-cost object -> all zeros, no `NaN`.
- Fractional cents preserved (e.g. `0.0125 -> 0.025`).

Integration (drive the real hooks in the verified order: headers, then request,
then `message_end`):
- Fast request (both hooks inject) -> `message_end` returns a replacement with
  cost x2; `role` and all non-cost `usage`/message fields preserved (spread).
- `shouldInject` false (fast off / non-Opus model) -> both flags false ->
  `message_end` returns nothing.
- Speed injected but header bailed (`detectOAuth === null` via `authFails` /
  non-OAuth harness option) -> no correction.
- Non-object payload: `before_provider_request` given `{ payload: 42 }` (or a
  string) -> `pendingFastSpeed` false -> no correction even if the header flag set.
- `/fast` toggled between the two hooks, each direction: call
  `before_provider_headers`, then `commands.get("fast").handler("off"/"on", ctx)`,
  then `before_provider_request`, then `message_end` -> no correction.
- Non-assistant `message_end` (`role:"user"`), and assistant message with no
  `usage.cost` -> untouched, no throw.
- Idempotency: after a correcting `message_end`, feed the returned replacement
  message into a **second** `message_end` with no intervening hooks -> returns
  nothing (asserts consume-clears-flags; no 2x -> 4x).

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (fast-mode section - reported and
  persisted cost is corrected locally to 2x because `pi-ai` prices fast requests
  at standard rate; note that live pi-cohort `Σ$` correction is best-effort and
  depends on extension load order while persisted/resumed cost is always exact;
  the upstream `pi-ai` fix is the better long-term path, tracked separately, no
  link obligation); `CHANGELOG.md` (dated entry).
- Derived / memory docs invalidated: none (AGENTS.md's fast-mode line is generic
  and needs no change).

## Open questions

None. Cache-rate doubling is derived from Anthropic's "Prompt caching multipliers
apply on top of fast mode pricing" (quoted above), not a published cache column;
if Anthropic later publishes a non-2x cache fast rate, `scaleCost` would need
per-component multipliers - out of scope until that happens.
