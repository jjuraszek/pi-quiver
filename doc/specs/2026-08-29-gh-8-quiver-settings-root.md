# Optional `quiver` settings root with legacy flat fallback (gh-8)

Ticket: https://github.com/jjuraszek/pi-quiver/issues/8

## Problem

pi-quiver's four opt-in extensions each read one flat top-level key from pi's
layered `settings.json` (`fastMode`, `sessionAutoName`, `swordHeader`,
`providerStallWatchdog`). Flat keys are scattered among unrelated settings and
generic names risk collision with pi core or other packages. Issue #7's
upcoming `slack` extension would add a fifth.

## Goal

All pi-quiver settings group under an optional `"quiver"` root object.
Flat keys keep working for the four existing legacy keys only; every new key
(starting with `slack`) is nested-only. The change lives in
`lib/extension-config.ts` plus a one-line `warn` hookup per consumer.

## Deviation from ticket

Issue #8 lists "no warning when both shapes are present" as out of scope and
AC3 confines the diff to `lib/extension-config.ts` + tests. The user amended
both during design: warnings ARE required (one sentence per malformed or
duplicated key), and `resolveConfig` gains an optional `warn` callback that
each consumer wires up. AC3 is therefore relaxed to: resolution logic
confined to `lib/extension-config.ts`; consumers change only to thread the
callback (a one-liner for three of the four; the watchdog needs a small
signature change - see Consumer hookup).

## Resolution semantics

Signature:

```ts
export function resolveConfig<T extends object>(
  cwd: string,
  key: string,
  defaults: T,
  coerce: (raw: unknown) => Partial<T> | undefined,
  warn?: (message: string) => void,
): T
```

`LEGACY_FLAT_KEYS` is an internal constant in `lib/extension-config.ts`,
frozen forever to exactly: `fastMode`, `sessionAutoName`, `swordHeader`,
`providerStallWatchdog`.

Per layer (global `<agentDir>/settings.json` then project `.pi/settings.json`,
unchanged order), for the requested `key`:

1. **Quiver root validation.** If the layer's `quiver` value exists but is not
   a plain object (string, array, number, null, ...), warn and treat the root
   as absent for that layer; flat resolution is unaffected (issue AC4).
2. **Nested wins by presence.** If `quiver.<key>` is present (the key exists
   in the quiver object, regardless of value), that value is the layer's
   candidate, taken whole (scalar or object, no reshaping). Flat `<key>` is
   ignored for that key in that layer - even when the nested value is
   malformed. Presence suppresses flat; there is no nested-then-flat retry, so
   `coerce` runs at most once per key per layer.
3. **Legacy flat fallback.** Otherwise, if `key` is in `LEGACY_FLAT_KEYS`,
   flat `<key>` is the candidate. Non-legacy keys never consult flat
   top-level entries (issue AC2).
4. **Unchanged merge.** The candidate goes through the consumer's `coerce`
   exactly once; a returned patch is `Object.assign`ed over the accumulator
   as today. Cross-layer project-over-global precedence is unchanged and
   shape-independent: global nested vs project flat (and the inverse) merge
   exactly as two flat layers would.

A `quiver` object in one layer never shadows unrelated flat keys anywhere
(resolution is strictly per requested key).

`resolveRetryMaxRetries` in `extensions/provider-stall-watchdog.ts` (lines
82-92) mirrors pi-core's own `retry.maxRetries` resolution and does not use
`resolveConfig`. It stays flat-only and untouched; `quiver.retry` is never
consulted (issue AC5).

## Warnings

Emitted through the optional `warn` callback; when the callback is absent,
warnings are silently dropped (no `console` fallback - the resolver stays
side-effect free). Each unique message is emitted at most once per process
(module-level `Set<string>` dedupe), so repeated lazy resolutions don't spam.
One sentence per affected key:

- **Malformed candidate**: the selected candidate (nested or flat) is present
  but `coerce` returned `undefined` ->
  `pi-quiver: "<key>" in <file> has an unrecognized value; ignored.`
- **Flat/nested duplicate**: `quiver.<key>` is present anywhere across the two
  layers AND flat `<key>` is present anywhere across the two layers ->
  `pi-quiver: "<key>" is set both flat and under "quiver" (nested wins within a layer; across layers the project layer wins regardless of shape) - move the flat entry under "quiver".`
  The message states the true precedence rule rather than claiming nested
  always wins: with global `quiver.<key>` + project flat `<key>`, the project
  flat value still wins per field (Resolution semantics, rule 4). Duplication
  is a warning, not an error; resolution proceeds per the rules above.

Stacking rule: every matching warning kind is emitted independently -
malformed is per layer/file (two bad layers for one key = two sentences),
duplicate is per key (process-wide, no `<file>` in the message), non-object
root is per file. A single key may therefore produce multiple sentences.
- **Non-object quiver root**:
  `pi-quiver: "quiver" in <file> is not an object; ignored.`

Detectability limit (documented, accepted): the malformed-candidate warning
fires only when `coerce` returns `undefined`; the resolver never
second-guesses consumer coercion, and this change does not touch any coercer.
What that means per consumer, against the coercers as they exist today:

- `fast-mode`, `sword-header`, `session-name`: wrong top-level type
  (string/number/null where boolean-or-object is expected) -> `coerce`
  returns `undefined` -> resolver warning fires. Objects or arrays whose
  recognized fields have wrong types (e.g. `{ "enabled": "yes" }`, `[]`)
  yield an empty patch, not `undefined` -> NO resolver warning; the value is
  silently ineffective, exactly as it is for flat keys today.
- `provider-stall-watchdog`: its `coerce` preserves malformed recognized
  fields for downstream fail-closed validation and never returns `undefined`
  for a present value -> the resolver malformed warning never fires for this
  key; bad values surface via the watchdog's existing validation/announce
  path.

Sharpening the coercers to detect wrong-typed fields is explicitly out of
scope (it would change consumer validation contracts, not resolution).
Tests pin this boundary so implementers don't assume broader coverage.

A flat-only non-legacy key (e.g. flat top-level `slack` with no `quiver`
entry anywhere) is silently ignored with no warning - deliberate, per the
user's warning rules (malformed + duplicate only); the duplicate warning
still covers a non-legacy key present in both shapes.

Warnings never throw; missing or unreadable settings files behave exactly as
today (silently skipped).

## Consumer hookup

Three extensions pass a `warn` callback directly at their existing
`resolveConfig` call site, using the established notify pattern
(`(m) => ctx.ui.notify(m, "warning")`):

- `extensions/fast-mode.ts:118-120`
- `extensions/session-name.ts:98-99`
- `extensions/sword-header.ts:69`

The watchdog is a two-hop path: its `resolveConfig` call sits inside the
exported `resolveWatchdogConfig(cwd)` (`extensions/provider-stall-watchdog.ts:94-99`),
which has no `ctx`. `resolveWatchdogConfig` gains an optional second
parameter `warn?: (msg: string) => void`, threaded to `resolveConfig`; the
`before_provider_request` handler (which holds `ctx.ui`/`ctx.hasUI`) passes
the watchdog's existing notify-or-`console.warn` pattern (its `announce`
helper) so settings warnings behave like the watchdog's other diagnostics,
including in no-UI modes. Direct test callers keep calling
`resolveWatchdogConfig(cwd)` with no callback.

Where a call site has no UI handle, the callback is omitted and warnings
don't emit there. `notify(msg, "warning")` appends a new line per call in the
TUI (verified against the installed peer, pi 0.84.4,
`dist/modes/interactive/interactive-mode.js`: `showExtensionNotify` routes
`"warning"` to `showWarning`, which always appends; only the `"info"` type
goes to `showStatus`, which coalesces consecutive status lines). Multiple
boot-time warnings from different extensions therefore cannot overwrite each
other. Cited by function name deliberately - line numbers drift with the
peer dep.

## Testing

New `test/extension-config.test.ts`, using the isolated global/project
settings-fixture pattern from `test/provider-stall-watchdog.test.ts:107-116`
(`PI_CODING_AGENT_DIR` + temp project dir), driving `resolveConfig` directly
with a simple coercer. Cases:

- nested-only; flat-only (legacy key); both-in-one-layer (nested value used
  whole, flat ignored)
- presence-suppresses-flat: nested present but malformed -> no patch from that
  layer, flat NOT consulted
- cross-layer: global flat + project nested, and the inverse (project wins
  per field either way)
- mixed per-key shapes in one layer (one key nested, another flat)
- non-legacy key (a `slack`-style test key): flat top-level entry ignored,
  only `quiver.<key>` consulted
- non-object `quiver` root: ignored + warned, flat resolution unaffected
- warnings: malformed candidate; flat/nested duplicate (same layer and
  cross-layer); dedupe (second resolution emits nothing); no callback -> no
  throw. The dedupe `Set` is process-global and the duplicate message
  contains no `<file>`, so every warning test case MUST use a distinct
  settings key - no test-only reset export is added.
- detectability-boundary pins: `{ "enabled": "yes" }` and `[]` through a real
  boolean-or-object coercer emit NO resolver warning (empty patch, not
  `undefined`); a string where an object is expected DOES warn
- one end-to-end case through an existing consumer's real `coerce`
  (issue AC3's identical-coercion requirement)
- consumer wiring: per-extension assertions (in the existing per-extension
  test files) that an emitted warning reaches the consumer's notify path with
  type `"warning"`, including the watchdog's two-hop
  handler -> `resolveWatchdogConfig(cwd, warn)` -> `resolveConfig` route

`retry.maxRetries` staying flat-only is covered by the existing watchdog
suite remaining green (it exercises `resolveRetryMaxRetries` against layered
fixtures); add one watchdog test asserting `quiver.retry` is not consulted
(lives in `test/provider-stall-watchdog.test.ts`, alongside the code it
tests - issue AC3's confinement reads on the implementation diff, not test
placement).

Verification: `npm run test:all` (unit tests + typecheck + AGENTS-core check).

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` - all top settings sections
  (currently flat-only examples at lines 137-156 and per-extension config
  blocks, including the watchdog block at lines 164-179 where
  `providerStallWatchdog` nests under `quiver` while pi-core's `retry` stays
  flat) rewritten to show `quiver.<key>` examples only. Per issue AC6, the
  settings documentation also states the per-key resolution rule
  (within-layer nested-over-flat; cross-layer project-over-global unchanged
  and shape-independent), shows one worked mixed-shape example (e.g. global
  flat + project nested), and enumerates the four legacy keys. New
  "Migrating from flat keys" section near the bottom of the settings
  documentation stating: flat form is the outdated configuration style,
  legacy-frozen to the four named keys; migration guide (wrap existing keys
  under `"quiver": { ... }`, delete the flat copies, duplicates resolve per
  the stated precedence and emit a warning until removed); every new key is
  nested-only. Plus a `CHANGELOG.md` entry.
- Derived / memory docs invalidated: none (`AGENTS.md` does not enumerate
  settings keys)

## Out of scope

- Nesting `retry.maxRetries` (pi-core-owned) under `quiver`
- Any automated migration tooling for flat keys
- Issue #7's slack extension itself (it consumes this contract once shipped)
- Reserving the `quiver` name against other packages (pi has no settings
  namespace registry; grouping reduces, not eliminates, collision risk)
- Removing flat support for the four legacy keys (explicitly frozen, never
  extended, never removed by this change)

## Open questions

None.
