# Fast mode: discover pi's beta list via probe (gh-11)

Fixes [jjuraszek/pi-quiver#11](https://github.com/jjuraszek/pi-quiver/issues/11):
fast mode's rebuilt `anthropic-beta` header drops pi's conditional
`server-side-fallback-2026-07-01` beta while the request body still carries
`fallbacks`, so Anthropic 400s every fast-mode request on `claude-opus-5` under
any auth mode (`invalid_request_error: "fallbacks: Extra inputs are not
permitted"`).

Partially supersedes `doc/specs/2026-07-12-fast-mode-opus.md`: its D3
("reconstruct-and-union") assumption that *the only betas worth preserving are
the OAuth identity betas* is invalidated. The rest of that design (injection
gates, config surfaces, cost model) stays live.
`doc/specs/2026-08-04-fast-mode-cost-correction.md` is unaffected.

## Problem

Since pi 0.84.3, pi-ai attaches a server-side-fallback declaration to eligible
Anthropic requests in two coupled places: `fallbacks: [{model: ...}]` in the
body (`anthropic-messages.js:827-830`) and the
`server-side-fallback-2026-07-01` beta in the header, gated on
`(model.compat?.allowedFallbackModels?.length ?? 0) > 0` (:113-116). The
extension's `before_provider_headers` hook runs before pi-ai assembles its
header, and the hook's `anthropic-beta` value replaces pi's entire list
(last-write-wins). `buildBetaHeader` reconstructs only OAuth identity betas +
the fast-mode beta, so the fallback beta is dropped while the body still
advertises `fallbacks` - Anthropic rejects the mismatch with a 400.

Catalog facts (pi-ai 0.84.4 bundled catalog, cross-checked against
`~/.pi/agent.experimental/models-store.json`):

- `claude-opus-5`: `allowedFallbackModels = [claude-opus-4-8]` - exhibits the bug.
- `claude-opus-4-8`: no `allowedFallbackModels` - never affected; issue AC #1's
  opus-4-8 clause is a pure regression guard.
- `claude-fable-5`: falls back to both Opus models but is outside
  `FAST_MODE_MODEL_PREFIXES`, so fast mode never touches it.

The bug is auth-mode-agnostic (pi-ai's gate reads only the model catalog;
`isOAuth` only changes identity-beta seeding), so API-key auth is affected too,
though the issue's ACs exercise OAuth only.

Issue acceptance criteria (verbatim from #11):

1. With `quiver.fastMode: true` (or `/fast on`) and OAuth (`sk-ant-oat`)
   credentials, `pi -p "say OK" --model anthropic/claude-opus-5` **and** the
   same on `anthropic/claude-opus-4-8` succeed with no
   `invalid_request_error` (verified locally).
2. The opus-5 request carries `speed: "fast"` in the payload **and both**
   `fast-mode-2026-02-01` and `server-side-fallback-2026-07-01` in the
   `anthropic-beta` header (observable with a request-logging extension).
3. With fast mode off, the opus-5 wire shape is unchanged (no `speed` field,
   no fast-mode beta) and the request succeeds.

Root cause class: the extension guesses pi's beta list instead of knowing it.
The same replacement already silently drops pi-ai's fine-grained-tool-streaming
and interleaved-thinking betas (tolerated - no body counterpart, so no 400).
The file-top comment in `extensions/fast-mode.ts` explicitly flagged this
fragility ("If pi later adds betas for these models, revisit
`buildBetaHeader`").

## Decisions

- **D1 - discovery over hardcoding (user decision).** No
  `SERVER_SIDE_FALLBACK_BETA` constant in pi-quiver, no replicated catalog
  predicate. The extension discovers pi's beta list at runtime by probing
  pi-ai's own request assembly.
- **D2 - probe mechanism.** The probe imports `anthropicMessagesApi()`
  (returning `{ stream }`) from
  `@earendil-works/pi-ai/api/anthropic-messages.lazy` - the package **root
  does not export it** (verified: `dist/index.d.ts`), and the alternative
  `/compat` entrypoint is documented-temporary ("deleted with the coding-agent
  ModelManager migration"), so the deep lazy path is the supported choice.
  Because `@earendil-works/pi-ai` is an **optional peer dep**
  (`peerDependenciesMeta.optional: true`) and the extension today has only an
  erased `import type`, the probe resolves the module via a **guarded dynamic
  `import()` inside `probePiBetaHeader`** - a missing or future-incompatible
  peer is caught and degrades per D4 instead of failing extension load.
  `StreamOptions` accepts `apiKey`, `headers`, `fetch`, and `maxRetries`
  (typed public surface). The probe calls `stream(ctx.model, PROBE_CONTEXT,
  { apiKey, headers, fetch: capturingFetch, maxRetries: 0 })`; everything up to the
  SDK's `fetch` call is local computation (verified in dist:
  `options?.fetch` -> `createClient` -> `new Anthropic({..., fetch,
  defaultHeaders: mergeClientHeaders(...betaFeatures...)})` at
  anthropic-messages.js:368/:683/:699/:722; the sole network touchpoint is
  `client.messages.create(...).asResponse()` at :382, routed through the
  injected fetch). The capturing fetch records the request headers **first**,
  then returns a synthetic failure - a post-capture failure still returns the
  capture. **Zero network, zero tokens, per request** (no cache, no staleness
  machinery); CPU is sub-millisecond once warmed - the first probe also pays
  pi-ai's one-time lazy adapter import (~tens of ms). The no-network/no-token
  property is the testable guarantee.
- **D3' - rejected alternatives.** (a) Hardcoded token + catalog gate: rejected
  by the user - repeats the guess-based fragility class. (b) Payload
  inspection: cannot work - `createClient` finalizes the Anthropic SDK
  client's headers before `buildParams`/`onPayload` run, so by the time any
  payload hook sees `fallbacks` the header is already locked (the payload hook
  does see `fallbacks`; it just cannot fix the header). (c)
  Upstream pi-ai change (export the constant / merge extension headers before
  beta assembly): couples shipping to a pi-ai release; original spec's D3
  rejected it for the same reason, precedent holds.
- **D4 - probe failure degrades to status quo.** On probe error or missing
  captured header, fall back to today's reconstruction (OAuth identity betas +
  fast beta). Degraded, never fatal, never a new failure mode.
- **D5 - fast + fallback coexist.** There is no separate "fallback route"
  request to detect: pi declares fallbacks in every eligible request and
  Anthropic picks the serving model server-side, reported only in the
  response's `model` field. Blocking fast on fallback-served requests is not
  expressible at request time and is the issue's explicit non-goal. The fix
  re-adds the beta so one request carries both fast mode and the fallback
  declaration. (Whether Anthropic honors fast speed on a fallback-served
  request is server behavior, unobservable offline; the fallback target
  opus-4-8 is itself fast-capable.)
- **D6 - partial supersession.** Banner on `2026-07-12-fast-mode-opus.md`
  scoped to the D3 beta-header reconstruction assumption (user-confirmed).

## Design

All changes in `extensions/fast-mode.ts`; no new files, no new settings, no
new state fields, no package.json change (`@earendil-works/pi-ai` is already a
peer dep).

### Components

- **`probePiBetaHeader(model, auth, fetchImpl?): Promise<string | null>`**
  (new, exported for tests): `auth` is the successful `ResolvedRequestAuth`
  (`{ apiKey?, headers? }` - `apiKey` is optional; a valid resolution may
  carry only auth headers, and both are forwarded into `StreamOptions` so
  headers-only auth probes correctly instead of failing pre-capture).
  `fetchImpl` is a test-only injection seam defaulting to the internal
  capturing fetch. The function dynamically imports the lazy pi-ai entrypoint
  (D2), runs the probe, drains the stream via
  `await stream.result().catch(() => {})`, and returns the captured
  `anthropic-beta` value or `null` (module-load failure, nothing captured,
  missing header key, or probe threw pre-capture). Failure contract: capture
  request headers first, then reject to terminate - a post-capture synthetic
  failure still returns the capture. The capturing fetch normalizes both
  `Headers`-object and plain-record shapes and is idempotent (last capture
  wins). `PROBE_CONTEXT` is a module-level minimal context: one short user
  message, no tools, no system prompt.
- **`buildBetaHeader(existing, isOAuth, probedBetas: string | null)`**
  (signature extended): non-null `probedBetas` seeds the list (it already
  contains identity betas under OAuth); `null` falls back to today's exact
  seeding (`isOAuth` -> `OAUTH_IDENTITY_BETAS` first). Then merges `existing`
  and appends `FAST_MODE_BETA`, with the current trim/dedup semantics
  unchanged.
- **`before_provider_headers` hook**: `detectOAuth` is reshaped into a single
  auth resolver that returns the resolved auth (`ResolvedRequestAuth`) plus
  the OAuth flag, so auth is resolved once - failure still bails with no
  header mutation. The hook then calls `probePiBetaHeader(ctx.model, auth)`
  and passes the result to `buildBetaHeader`. `pendingFastHeader` semantics
  unchanged.
- **Comment rewrite**: the file-top "only betas to preserve are OAuth identity
  betas / revisit if pi changes" caveat is deleted and replaced with a
  description of the probe. `OAUTH_IDENTITY_BETAS` stays, demoted to
  fallback-only seeding.

`before_provider_request` (`speed: "fast"` injection) and the `message_end`
cost correction are untouched.

### Request flow (opus-5, OAuth, fast on)

1. `before_provider_headers`: gates pass; probe captures pi's assembled list
   (identity betas + `server-side-fallback-2026-07-01`).
2. `buildBetaHeader` unions probed list + existing hook-visible values +
   `fast-mode-2026-02-01`; hook writes `event.headers["anthropic-beta"]`.
3. `before_provider_request` adds `speed: "fast"` (hook order confirmed by the
   cost-correction spec).
4. pi-ai's real request: hook header wins (unchanged mechanism), body carries
   `fallbacks` - now matched by the declared beta. Anthropic accepts; opus-5
   or opus-4-8 serves.
5. `message_end`: cost correction applies the fast multiplier as today,
   including over the fallback-served cost pi-ai swaps in when `output.model`
   differs (anthropic-messages.js:394-397).

Variants: API-key auth - identical flow, probe captures no identity betas.
opus-4-8 - probe captures no fallback beta; header matches today's shape.
Fast off / non-Opus / non-anthropic - gated out before any probe; wire shape
untouched (issue AC #3).

### Error handling and edge cases

- **Probe failure** -> `null` -> status-quo reconstruction (D4). On opus-5 the
  request may then 400 exactly as today; the probe is never retried and never
  blocks the pipeline.
- **Retry re-invocation**: `maxRetries: 0` stops pi-ai's retry wrapper from
  re-driving the failing probe fetch.
- **Zero-beta capture** (future auth mode): missing `anthropic-beta` key ->
  `null` -> fallback path.
- **Option-dependent betas**: interleaved-thinking and fine-grained-streaming
  betas depend on per-request options/context the hook cannot see; the probe
  captures them under fixed defaults (tool-less minimal context). This is
  status-quo-or-better (current code drops them entirely), they have no body
  counterpart (no 400 risk), and the fast-mode allowlist models use adaptive
  thinking (`forceAdaptiveThinking: true`) where the interleaved beta does not
  apply. Known limit: the tool-less probe context is sufficient only while
  the allowlisted models' compat defaults hold; a future allowlisted model
  with tool- or thinking-conditional betas would have those dropped by
  last-write-wins, same as today.
- **Missing/incompatible pi-ai peer**: the optional peer dep may be absent
  from the host tree, or a future pi-ai may delete the lazy entrypoint; the
  guarded dynamic `import()` catches both -> `null` -> D4 fallback. Extension
  load never fails on the probe's account.
- **Fallback-served response**: fast multiplier over opus-4-8's swapped-in
  cost - accepted as correct (fast pricing applies to whichever model served);
  covered by a unit test.
- **Model without `compat`**: no branching needed - the probe captures
  whatever pi-ai assembles; the extension never consults the catalog directly.
- **pi-ai beta changes**: absorbed automatically. Residual coupling is the
  probe surface itself (the `api/anthropic-messages.lazy` entrypoint and
  `StreamOptions.apiKey/headers/fetch/maxRetries` - typed public API, not
  internals - plus the entrypoint's existence, guarded as above).

## Testing

Unit tests in `test/fast-mode.test.ts`, extending existing patterns
(`npm run test:all` green - same command as CI):

- `probePiBetaHeader` against the real installed pi-ai with the capturing
  fetch: opus-5-shaped fixture (`compat.allowedFallbackModels: [opus-4-8]`)
  captures a header containing `server-side-fallback-2026-07-01`; a fixture
  without fallback models captures one without it; OAuth-shaped key
  (`sk-ant-oat...`) captures identity betas, API key does not; headers-only
  auth (no `apiKey`) still probes; a pre-capture-throwing injected `fetchImpl`
  yields `null`; a post-capture failure still returns the capture. Doubles as
  a canary: a pi-ai upgrade that changes probe-relevant behavior fails CI.
  **Fixture requirement:** probe-exercising model fixtures carry a `compat`
  block matching the production catalog (`forceAdaptiveThinking: true`) -
  pi-ai emits the interleaved-thinking beta for any model where
  `compat.forceAdaptiveThinking !== true`, so bare `{id, api, provider}` stubs
  would break exact-string header assertions that production models never see.
  Every existing integration test that asserts exact `anthropic-beta` strings
  through the live hook (OAuth identity betas, fast-flag, and the cost cases
  that depend on the header hook succeeding) is migrated onto catalog-shaped
  fixtures, not just the `buildBetaHeader` unit cases.
- `buildBetaHeader` pure tests: probed-seed path (dedup against existing +
  fast beta) and `null` fallback path, preserving today's assertions
  unchanged.
- Harness integration: `before_provider_headers` end-to-end with a
  `compat`-bearing model on both auth paths; fast-off wire-shape regression;
  `message_end` cost correction unchanged when the header path ran with a
  probed header.

**Conformance smoke (manual, post-implementation, user-authorized):** patch
the built fix into the experimental preset's installed pi-quiver
`node_modules` in place (preset has its own OAuth `auth.json`; from bash:
`PI_CODING_AGENT_DIR=~/.pi/agent.experimental pi ...` - `pi-experimental` is a
fish function setting that env var), then with fast mode on:

- `pi -p "say OK" --model anthropic/claude-opus-5` - no
  `invalid_request_error` (issue AC #1).
- Same on `anthropic/claude-opus-4-8` - regression guard.
- Optionally verify via a request-logging extension: payload `speed: "fast"`,
  header carries both `fast-mode-2026-02-01` and
  `server-side-fallback-2026-07-01` (issue AC #2).

## Out of scope

- Blocking or altering fast mode on fallback-served requests (not expressible
  request-time; issue non-goal - D5).
- Upstream pi-ai changes (D3').
- `claude-fable-5` handling (outside the fast-mode allowlist).
- GridStrong preset pin lifecycle (separate repo; background motivation only).

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: README.md fast-mode section (header
  behavior now probe-based); CHANGELOG.md entry (next-version, dated, per repo
  convention)
- Derived / memory docs invalidated: AGENTS.md pi-quiver intro line if it
  mentions header reconstruction (check at implementation);
  `doc/specs/2026-07-12-fast-mode-opus.md` receives the partial supersession
  banner (D3 assumption scope only)
