# One condensed warning for unknown or misplaced pi-quiver settings keys

Ticket: GitHub issue #14 (jjuraszek/pi-quiver#14).

## Problem

Settings under `quiver.*` are resolved per block by `resolveConfig` (`lib/extension-config.ts`). Each block's coercer copies only the fields it knows, so a typo like `quiver.providerStallWatchdog.timeoutMs` is silently dropped and the default (20s) applies. Nobody sees the whole `quiver` object, so a misspelled block name (`quiver.fastmode`) is silent too. A flat legacy key (`"fastMode": true` at top level) is still honoured and never mentioned - the only flat-related warning today is the flat+nested conflict.

Issue #14 asks for one warning per unknown key. The user chose a different granularity: **one condensed warning** covering flat-key use, unknown block names, and unknown fields across both settings files, clearly branded pi-quiver, stating that defaults apply to what was not understood. This deviates from issue #14 AC 3 and AC 4 (two unknown keys -> two warnings; same key in two files -> two warnings) - deliberately: the settings file is what the user opens to fix things, and one message per typo is noisy in the TUI.

## Decisions

| Question | Decision |
|---|---|
| Granularity | One condensed warning, all structural findings from both files, deduped by exact text per process |
| Emission point | Inside `resolveConfig`'s existing per-file loop, every call, deduped by the existing `emitWarning`; no new extension, no new flag, no extra file reads |
| Accepted keys | Static registry `QUIVER_CONFIG_KEYS` in `lib/extension-config.ts`, all six blocks; `docToMd` derived from `DOC_TO_MD_OPTIONS` |
| Flat legacy keys | Use of a flat key now warns (deprecation-style) but remains honoured as fallback; the flat set stays frozen to `LEGACY_FLAT_KEYS` |
| Existing warnings | Structural findings fold into the condensed message; per-block "unrecognized value" sentence stays; the resolver's normalization/selection logic is untouched |
| Headless delivery | `fast-mode`, `session-name`, `slack` pass `ctx.hasUI ? ctx.ui.notify : console.warn`; `sword-header` is TUI-only already |
| Rendering | Plain text, header + one indented line per finding, inline accepted list, absolute paths as today; no box |

## Design

Resolver changes live in `lib/extension-config.ts`.

### `QUIVER_CONFIG_KEYS` (exported)

`Record<string, readonly string[]>`: block name -> accepted field names, in declaration order. It is the **lint allowlist** and the single place a pi-quiver config key is declared for validation purposes; a key added to an extension's config type without a registry entry warns as unknown, which is how a forgotten registration surfaces.

| Block | Fields |
|---|---|
| `fastMode` | `enabled` |
| `sessionAutoName` | `enabled`, `ghosttyTab`, `herdrTab`, `rules`, `deny`, `revisitFirstTurn`, `revisitEveryTurns` |
| `swordHeader` | `enabled` |
| `providerStallWatchdog` | `enabled`, `firstEventMs`, `warningMs`, `recoveryMs`, `maxStallRetries` |
| `slack` | `enabled`, `cachePath`, `policyPath`, `userTokenEnv`, `botTokenEnv`, `uploadThresholdChars` |
| `docToMd` | `DOC_TO_MD_OPTIONS.filter(o => o.settable).map(o => o.key)` imported from `lib/doc-to-md-options.ts` - not retyped |

The import is eager and cycle-free: `lib/doc-to-md-options.ts` imports nothing from `lib/extension-config.ts`.

`LEGACY_FLAT_KEYS` stays unchanged: it answers a different question (which blocks may still appear flat) and remains frozen.

### Lint inside `resolveConfig`

`resolveConfig` already loops `settingsPaths(cwd)` and parses each file once. The lint collects findings from that same parsed object, in the same loop - no second read. Per file, in this order; within a category, JSON insertion order:

1. each `LEGACY_FLAT_KEYS` member present at top level -> `"<key>" at top level - move under "quiver"`
2. `quiver` present and not a plain object (`null`, array, or non-object - the predicate the resolver already uses) -> `"quiver" is not an object - ignored`; steps 3-4 skipped for this file
3. each `quiver.<x>` with `x` not in `QUIVER_CONFIG_KEYS` -> `"quiver.<x>" - unknown block; accepted: <block names in registry order>`; the value is not inspected further, whatever its type
4. each `quiver.<block>` with `block` in the registry whose value is a plain object, each field not in its list -> `"quiver.<block>.<field>" - unknown; accepted: <fields in registry order>`

Non-object block values (`"fastMode": true`, a string, an array) are not field-walked - a wrong value type is the block coercer's job and keeps its existing "unrecognized value" sentence.

After the loop: zero findings -> nothing. Otherwise one newline-joined string goes through the existing `emitWarning(warn, message)`. Its `emittedWarnings` set dedups by exact text, so the message prints once per process **per distinct finding set** - if settings are edited mid-session and re-read (fast-mode's `/fast` command resolve, the watchdog's first `before_provider_request`, `doc_to_md` per call), a changed set prints once more. That is the guarantee the README states.

The resolver's own logic is unchanged: the `root = undefined` normalization for a non-object `quiver` stays (it guards the `Object.hasOwn` below it), nested-vs-flat selection stays, `nestedSeen`/`flatSeen` and the `emitWarning` calls for the non-object root and the flat+nested conflict are deleted (both are now lint lines; the flat line reads "move under quiver" whether or not a nested twin exists).

### Message format

Paths are the absolute strings `settingsPaths(cwd)` returns - exactly what today's warnings print. No `~` shortening, no relative paths: absolute paths keep messages distinct per cwd/agent dir (dedup correctness, test isolation) and need no platform handling. One contributing file - path in the header:

```
pi-quiver settings (/Users/x/.pi/agent/settings.json): unknown or misplaced keys - unknown ones fall back to defaults
  "providerStallWatchdog" at top level - move under "quiver"
  "quiver.slack.uploadTreshold" - unknown; accepted: enabled, cachePath, policyPath, userTokenEnv, botTokenEnv, uploadThresholdChars
  "quiver.fastmode" - unknown block; accepted: fastMode, sessionAutoName, swordHeader, providerStallWatchdog, slack, docToMd
```

Both files contributing - path becomes a sub-header per file:

```
pi-quiver settings: unknown or misplaced keys - unknown ones fall back to defaults
  /Users/x/.pi/agent/settings.json
    "fastMode" at top level - move under "quiver"
  /Users/x/repo/.pi/settings.json
    "quiver.providerStallWatchdog.timeoutMs" - unknown; accepted: enabled, firstEventMs, warningMs, recoveryMs, maxStallRetries
```

In the TUI `ctx.ui.notify(m, "warning")` renders a chat `Text` block prefixed `Warning: ` in the warning colour (`interactive-mode.js` `showWarning`) with width wrapping - long accepted lists wrap, which is acceptable; the message carries no box and no own "Warning" word. Headless it is `console.warn` to stderr, never stdout.

### `coerceDocToMdSettings` and the CLI (`lib/doc-to-md-options.ts`, `bin/pi-quiver.ts`)

`coerceDocToMdSettings` deletes its `is not a tunable setting; ignored` warning; type-reason warnings stay; unknown keys are still skipped when building the patch. The pi path gets key-name validation from the lint. The CLI's `readCliSettings` never calls `resolveConfig` (it is pi-free), so it takes over the check it just lost: after parsing `quiver.docToMd`, it warns once per file for keys not in the settable option list, using the existing `warn`. The check moves; it is not duplicated on any one path.

### Call-site changes (three one-liners)

`extensions/fast-mode.ts`, `extensions/session-name.ts`, `extensions/slack.ts` currently pass `(m) => ctx.ui.notify(m, "warning")`. They pass `(m) => ctx.hasUI ? ctx.ui.notify(m, "warning") : console.warn(m)` instead. Without this, headless `ctx.ui.notify` is a no-op (`core/extensions/runner.js`) and the lint is lost. `sword-header` returns before resolving when `ctx.mode !== "tui"`, so its `console.warn` arm could never run - no change there. `doc_to_md` already passes `console.warn`; the watchdog already branches on `hasUI`.

### Edge cases

- **Different `cwd` across calls** produces a different message (absolute paths) and therefore a second warning. All `session_start` callers receive the same `ctx.cwd`, so this does not happen in practice.
- **Malformed JSON / missing file**: `readSettings` returns `undefined`; that file contributes nothing. Same as today.
- **Disabled extensions** still call `resolveConfig` (that is how they learn they are disabled): `fast-mode`, `session-name`, `slack` at `session_start`, `sword-header` at `session_start` in TUI only, the watchdog lazily on the first `before_provider_request`. In a session that loads pi-quiver, the lint therefore runs at startup via the first three and no later than the first provider request.
- **Out of scope, stated**: field-walking a flat legacy block object (`"fastMode": { "enabld": true }` at top level gets only the "move under quiver" line - fields are checked once it is moved); an array-valued block (`quiver.fastMode: []`) coerces to an empty patch as today with no lint line; typo suggestions ("did you mean fastMode?") - the inline accepted list is the hint.
- **Arbitrary pi-owned top-level keys** (`retry`, `theme`, ...): never inspected. Only `LEGACY_FLAT_KEYS` members and the `quiver` subtree are read. A flat `slack`/`docToMd` block stays silently ignored as today - the flat set is frozen.

## Issue #14 acceptance criteria - disposition

| AC | Disposition |
|---|---|
| 1 one warning naming path, `timeoutMs`, accepted watchdog keys; watchdog still arms at 20s | Met (path in header, key + accepted list on the line; resolution asserted unchanged) |
| 2 recognised-only block -> no warning | Met |
| 3 two unknown keys -> two warnings | **Superseded**: two lines in one warning |
| 4 same key in both files -> two warnings each naming its file | **Superseded**: one warning, per-file sub-headers |
| 5 re-resolving does not repeat | Met (`emitWarning` dedup) |
| 6 `fastMode`/`sessionAutoName`/`swordHeader` object-form warn, boolean-form does not | Met; `slack` and `docToMd` added |
| 7 print/json -> stderr, never stdout | Met via call-site `hasUI` branch, asserted with a `hasUI: false` context |
| 8 README + CHANGELOG | Met (below) |
| 9 unit tests | Met (below) |

## Testing

`test/extension-config.test.ts` - new cases (each test uses fresh temp dirs; absolute paths in the message keep texts distinct, so `emittedWarnings` never suppresses a test's own warning and no reset hook is needed):

- flat legacy key alone -> one warning containing the "move under quiver" line (behaviour change from silent)
- unknown block, unknown field, non-object `quiver` -> one message, one line each, accepted list present, lines in the specified order
- both files contribute -> two path sub-headers; one file -> path in header
- second `resolveConfig` call with the same files -> no second warning; clean files -> no warning
- non-object block value (`"fastMode": true`) and unknown-block object value -> no field lines
- registry consistency: for each of `fast-mode`, `session-name`, `sword-header`, `provider-stall-watchdog`, `slack-core`, every key of that module's default config object is in `QUIVER_CONFIG_KEYS[block]` (superset check - the watchdog's `DEFAULT_CONFIG` omits the optional `maxStallRetries`, and `DEFAULT_CANDIDATE.blockIsObject` is internal, so test against `DEFAULT_CONFIG`); `QUIVER_CONFIG_KEYS.docToMd` equals the settable option keys

`test/extension-config.test.ts` - existing tests to rewrite. The suite's synthetic `Cfg` (`label` field) and synthetic block names (`slackDedupe`, `swordPin`) now produce lint lines. Rule: assertions about value warnings filter the lint message out by its fixed header prefix `pi-quiver settings`, and assertions about the lint check for it explicitly.

- `non-object quiver root is ignored, flat resolution unaffected` - asserts the deleted sentence; retarget at the `"quiver" is not an object - ignored` line
- `warning: malformed flat legacy candidate` - now yields the lint (flat use) plus the kept "unrecognized value" sentence; assert both
- `warning: flat/nested duplicate in the same layer`, `... across layers`, `... also covers a non-legacy key in both shapes` - the `DUPLICATE` sentence is gone; the first two retarget at the flat "move under quiver" line; the third (non-legacy `slack` flat) now warns for the unknown-field/unknown-block situation it constructs, or is dropped if it only pinned the deleted sentence
- `warning dedupe: second resolution emits nothing`, `detectability pins ...` - warning counts gain the lint line; filter or assert it

Other suites:

- `test/slack-config.test.ts` `unknown subkey is dropped silently, no warning` - return value still `enabled: true`; the zero-warnings assertion becomes one warning containing `"quiver.slack.bogus" - unknown`
- `test/doc-to-md-options.test.ts` `coerceDocToMdSettings: unknown and ill-typed keys ...` - `bogus` and `pages` no longer warn from the coercer; only the `imageDpi` type warning remains (count 3 -> 1)
- `test/doc-to-md-cli.test.ts` - `bogus` still warned via `readCliSettings`; unchanged assertion
- `test/fast-mode.test.ts` `harness()` - add `hasUI: true` so `session_start` warnings still reach the notify spy; add one case with `hasUI: false` asserting the warning reaches `console.warn` and not `notify` (AC 7)
- `test/provider-stall-watchdog.test.ts` - add: `quiver.providerStallWatchdog: { enabled: true, timeoutMs: 720000 }` resolves `firstEventMs: 20_000` and the lint names `timeoutMs` (AC 1)

`npm run test:all` before commit.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` - the configuration section (one condensed pi-quiver settings warning, once per distinct finding set; unknown keys fall back to defaults; `QUIVER_CONFIG_KEYS` is where a new key is registered) and the `### Migrating from flat keys` section (a flat key alone now warns; the duplicate-specific sentence is gone); `CHANGELOG.md` entry
- Derived / memory docs invalidated: `AGENTS.md` layout line for `lib/extension-config.ts` (add "+ `QUIVER_CONFIG_KEYS` registry and settings lint") and the "Adding an extension" workflow bullet (new config key -> add to the registry)

## Out of scope

- Per-key warnings (issue #14 AC 3/4 as written)
- Fuzzy "did you mean" suggestions
- Validating pi-owned top-level settings or flat non-legacy blocks
- Field-walking flat legacy block objects or array-valued blocks
- Refactoring block coercers to report type-error reasons into the condensed message
- A per-block "not settable here" wording for `docToMd` per-call options (`pages`, `outputDir`): they are reported as unknown with the settable list inline, one wording for all blocks
