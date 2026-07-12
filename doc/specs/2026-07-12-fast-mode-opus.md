# Fast mode for Opus 4.8

## Problem

Anthropic ships a "fast mode" for Claude Opus: requests carrying `speed: "fast"`
in the body **and** the `anthropic-beta: fast-mode-2026-02-01` header are served
at up to 2.5x output tokens/sec (premium pricing). pi-ai has no native fast-mode
support and pi exposes no built-in switch. We want an opt-in pi-quiver extension
that injects both signals into every qualifying Opus request, controllable from
three surfaces: `settings.json`, a `--fast` launch flag, and a `/fast` live
toggle.

## Goal

Ship `fast-mode.ts` as a new pi-quiver extension that, when enabled, adds the
fast-mode `speed` payload field and beta header to every qualifying Opus request
routed through the `anthropic-messages` API - regardless of thinking level - and
does nothing otherwise. OFF by default, matching the repo's opt-in extensions
(`session-name`, `sword-header`).

## Ground truth (verified against the pinned pi runtime + Anthropic docs)

Anthropic fast-mode contract (source:
`https://platform.claude.com/docs/en/build-with-claude/fast-mode`, via Context7
`/llmstxt/platform_claude_llms_txt`):

- **Both signals are mandatory.** The docs' cURL/SDK examples set `speed: "fast"`
  in the body AND send `anthropic-beta: fast-mode-2026-02-01`. Payload-only does
  not enable fast mode; the header cannot be dropped.
- **Applies to Claude Opus 4.8 and Opus 4.7** ("up to 2.5x higher output tokens
  per second for Claude Opus 4.8 and Claude Opus 4.7"). See Open Decision D1.

pi runtime facts, confirmed by reading `node_modules/@earendil-works/*`:

- **`claude-opus-4-8` exists** in `providers/anthropic.models.js` with
  `api: "anthropic-messages"`, `provider: "anthropic"`, `compat.forceAdaptiveThinking: true`.
- **Bedrock's `claude-opus-4-8` uses `api: "bedrock-converse-stream"`**, not
  `anthropic-messages`, so the API gate already excludes it - no Bedrock handling
  needed.
- **Proxy providers ship `claude-opus-4-8` under `api: "anthropic-messages"`**:
  `opencode.models.js` and `cloudflare-ai-gateway.models.js` define it with
  `provider: "opencode"` / `"cloudflare-ai-gateway"` (third-party passthrough
  baseUrls). An api+id-only gate would leak fast-mode signals to these. See Open
  Decision D2.
- **`before_provider_request`** (sdk.js `onPayload`): handler `(event, ctx)`;
  `event.payload: unknown` is the outbound body; returning a value replaces it.
- **`before_provider_headers`** (sdk.js:187-196): handler `(event, ctx)`;
  `event.headers` is `ProviderHeaders = Record<string, string | null>` (a `null`
  value is a delete signal from an earlier handler); mutate in place.
- **`anthropic-beta` is assembled AFTER the header hook, and the hook's output is
  merged LAST.** pi-ai builds the beta list inside `createClient`
  (`api/anthropic-messages.js:633/648/660`) - *after* `before_provider_headers`
  fires - then `mergeHeaders(...)` (`:119-127`) is a last-wins `Object.assign`
  with the hook's headers applied last. So at hook time `event.headers` has **no**
  `anthropic-beta` key, and any `anthropic-beta` the extension sets **replaces**
  pi's list rather than extending it. pi's list includes, per auth mode:
  OAuth -> `claude-code-20250219,oauth-2025-04-20` (identity betas, load-bearing
  for OAuth auth) [+ fine-grained]; API-key -> fine-grained-tool-streaming when
  applicable; interleaved-thinking is skipped for Opus 4.8 (`forceAdaptiveThinking`).
  Naively setting the header therefore risks 401-ing OAuth (Max-plan) users. This
  is the central design risk. See Open Decision D3.
- **API surface:** `registerFlag(name, { type: "boolean", ... })`,
  `getFlag(name): boolean | string | undefined`, `registerCommand(name, {...})`,
  `ctx.ui.setStatus(key, text | undefined)`. `setStatus` is an inert no-op in the
  headless runner UI (`runner.js:93`) and implemented in RPC mode
  (`rpc-mode.js:100`), so calling it is always safe - **no headless guard needed**.
- **The extension factory receives only `ExtensionAPI`, not a context/cwd**
  (`fetch.ts`, `sword-header.ts`). `resolveConfig(ctx.cwd, ...)` and
  `pi.getFlag(...)` are therefore **not resolvable at module load** - flag values
  are written into the runtime only after all extensions load. Sibling
  `session-name.ts` resolves config inside handlers for exactly this reason.
- **Shared config:** `resolveConfig(cwd, key, defaults, coerce)` from
  `extension-config.ts` layers global (`getAgentDir()/settings.json`) then project
  (`cwd/.pi/settings.json`), project winning.

## Architecture

Single module `fast-mode.ts`, default-exporting `function (pi: ExtensionAPI)`,
added to `package.json` `pi.extensions`, the `files` allowlist, and the
`typecheck` script's file list (`fast-mode.ts fast-mode.test.ts`). Same shape as
`session-name.ts` / `sword-header.ts`.

Module-scoped mutable state: `enabled: boolean` plus a `liveOverride: boolean |
null` (null = no live toggle yet). The factory only **registers** the flag,
command, and event handlers; all `ctx`-dependent resolution happens in handlers.

Registrations and hooks:

- `registerFlag("fast", { type: "boolean", description })` - registered in the
  factory; its value is **read via `pi.getFlag("fast")` inside `resolveState`**,
  never at load.
- `registerCommand("fast", { ... })` - `/fast [on|off|status]` (grammar below).
- `pi.on("session_start", (_e, ctx) => resolveState(ctx))` - (re)establishes the
  config+flag baseline and refreshes status.
- `pi.on("model_select", (_e, ctx) => refreshStatus(ctx))` - status follows model.
- `pi.on("before_provider_request", handler)` - inject `speed`.
- `pi.on("before_provider_headers", handler)` - inject/merge the beta header.

### State lifecycle (`resolveState(ctx)`)

Idempotent; called on `session_start` and safe to call again. Resolves, in
precedence order (lowest to highest):

1. **Config** `enabled` via `resolveConfig(ctx.cwd, "fastMode", DEFAULT_CONFIG, coerce)`.
2. **`--fast` flag**: if `pi.getFlag("fast") === true`, force `enabled = true`
   (a launch flag cannot force-off; absence is not a signal).
3. **Live override**: if `liveOverride !== null`, it wins.

`session_start` re-runs steps 1-2 (re-reading settings + flag) but **preserves**
an existing `liveOverride` - a `/fast` toggle persists across `/new` and session
switches for the life of the process until the user changes it again. The provider
hooks read the module `enabled` directly (already resolved by the most recent
`session_start`); they do not call `resolveConfig`.

## The injection gate

Both hooks apply an identical gate, factored into a pure
`shouldInject(enabled, model)`:

```
inject when: enabled === true
         AND model?.provider === "anthropic"          // see D2
         AND model?.api === "anthropic-messages"
         AND FAST_MODE_MODEL_PREFIXES.some(p => model.id?.startsWith(p))
```

`FAST_MODE_MODEL_PREFIXES` defaults to `["claude-opus-4-8"]` (see D1). Thinking
level is never consulted. Gate fail -> both hooks no-op on their input.

- **Payload hook:** on pass, return `{ ...payload, speed: "fast" }`. Skip unless
  payload is a plain object (`typeof x === "object" && x !== null &&
  !Array.isArray(x)`). Overwriting an existing `speed` to `"fast"` is idempotent.
- **Header hook (D3 - merge strategy):** on pass, set
  `event.headers["anthropic-beta"]` to the union of the fast-mode beta with pi's
  beta list. Because pi's list is not present at hook time (see Ground truth), the
  extension **reconstructs** the betas pi will send, keyed on auth mode detected
  from the headers/model available in the hook, unions in `fast-mode-2026-02-01`,
  de-dupes, and writes the full value. `addBeta(existing: string | undefined):
  string` handles the string-merge half (split on `,`, `trim`, drop empties,
  append iff absent, join with `,`); a `null` existing value is treated as absent
  (build fresh, do not resurrect a delete). The auth-mode reconstruction is
  **explicitly coupled to pi-ai internals** and documented as a known-fragile
  point in `fast-mode.ts`; a test asserts pi's OAuth identity betas survive
  alongside the fast-mode beta. See D3 for the alternative.

The model gate is **absolute**: `/fast on` / `--fast` control the on/off *state*
only; the model match controls *applicability*.

## Config schema & precedence

Settings key `fastMode` (unprefixed, matching sibling `sessionAutoName`).
Boolean shorthand or object; OFF by default:

```jsonc
"fastMode": true                 // shorthand: enabled
"fastMode": { "enabled": true }  // object form
// absent / false / junk / malformed enabled => disabled (layer skipped)
```

`coerce(raw)` mirrors `session-name.ts`: `undefined` -> skip layer; `boolean` ->
`{ enabled: raw }`; object with **boolean** `enabled` -> `{ enabled }`; any other
shape (incl. non-boolean `enabled` like `"yes"`) -> skip. `DEFAULT_CONFIG =
{ enabled: false }`. Precedence is defined by `resolveState` above.

## `/fast` command grammar

Mirrors the reference package's contract:

- `/fast` (no arg) -> toggle current `enabled`, persist as `liveOverride`, notify.
- `/fast on` | `/fast off` -> set state, persist as `liveOverride`, notify.
- `/fast status` -> report **without** mutating state: current on/off, effective
  source (config / flag / live), current model, and whether that model qualifies.
  When `ctx.model` is undefined, report "no model selected".
- invalid/extra args -> `notify("Usage: /fast [on|off|status]", "warning")`, no
  state change.

Argument completion offers `on|off|status`.

## Status indicator

`ctx.ui.setStatus("fast-mode", ...)` updated by `resolveState`, `model_select`,
and the `/fast` handler:

- enabled + current model qualifies -> `"\u26a1 fast"`.
- enabled + current model does not qualify -> `"\u26a1 n/a"`.
- disabled -> `setStatus("fast-mode", undefined)` (cleared).

No headless guard (the call is always safe).

## Errors & edge cases

Boundary-only, no belt-and-suspenders:

- Payload not a plain object -> payload hook skips.
- `event.headers` missing -> header hook skips; `anthropic-beta` present as `null`
  -> treated as absent.
- `ctx.model` undefined -> gate fails -> no-op; `/fast status` reports "no model".
- `speed` already set -> overwrite to `"fast"` (idempotent).
- Fast-mode beta already present -> not re-added (dedup).

## Testing approach

`fast-mode.test.ts` under `node --test` (auto-collected by the `*.test.ts` glob;
`typecheck` script updated to list it). Two layers:

- **Pure helpers:** `coerce` (bool/object/undefined/malformed-enabled/junk);
  `shouldInject` (opus-4-8 on, opus-4-7 per D1, non-anthropic provider off,
  bedrock api off, disabled off, undefined model off); `injectSpeed` (adds,
  overwrites, skips non-object); `addBeta` (append preserving order, dedup,
  null/undefined -> fresh, trims + drops empty tokens); precedence resolution as
  a pure function over (config, flag, liveOverride).
- **Integration harness:** a fake `ExtensionAPI`/`ExtensionContext` that loads the
  default export, captures registered flag/command/hooks, drives config + flag +
  live toggle through `resolveState`, and asserts the real hook outputs - payload
  gains `speed`, header value contains the fast-mode beta **and** the reconstructed
  pi betas (OAuth-identity-beta preservation), and non-qualifying models are
  untouched.

## Resolved decisions (approved at the review gate)

- **D1 - model scope: Opus 4.8 only.** `FAST_MODE_MODEL_PREFIXES =
  ["claude-opus-4-8"]`. Opus 4.7 is supported by Anthropic but out of scope here;
  adding it later is a one-line prefix addition.
- **D2 - proxy providers: keep the `provider === "anthropic"` gate.** opencode /
  cloudflare-ai-gateway passthroughs of `claude-opus-4-8` are excluded; fast-mode
  signals are never sent to third-party proxies.
- **D3 - header merge: reconstruct-and-union.** The extension reconstructs pi's
  beta list keyed on detected auth mode, unions in `fast-mode-2026-02-01`,
  de-dupes, and writes the full value. The pi-ai coupling is documented as
  known-fragile in `fast-mode.ts` and guarded by the OAuth-identity-beta
  preservation test. The upstream-additive-beta alternative was rejected (blocks
  shipping).

## Documentation impact

- Feature / user-facing docs introduced: none (a new extension is documented in
  the existing `README.md` extension section; no new standalone doc).
- Materially amended existing docs: `README.md` (extension list + `fastMode`
  config + fast-mode behavior/limitations), `CHANGELOG.md` (new entry),
  `package.json` (`pi.extensions` + `files` allowlist + `typecheck` file list),
  `AGENTS.md` (repo-summary extension inventory + `Layout` block).
- Derived / memory docs invalidated: the `AGENTS.md` top-of-file extension
  inventory sentence and `Layout` block go stale once `fast-mode.ts` ships; update
  in the same commit.
