# Herdr tab sink: claim any numeric label, reset the claim per session

Supersedes the claim rule and per-session state scope of
[doc/specs/2026-09-01-herdr-tab-name-sync.md](./2026-09-01-herdr-tab-name-sync.md)
(`### Write path and claim-once state machine`, `### Restore on shutdown`,
`### Edge cases`) and of
[doc/specs/2026-09-13-gh-19-herdr-armed-prefix-tolerance.md](./2026-09-13-gh-19-herdr-armed-prefix-tolerance.md)
(ownership comparison in `## Design`). Transport, config, position math,
gates, serialization, and the `* ` armed-prefix tolerance stand.

## Problem

Reported: a Herdr tab moved to another position before pi's first auto-name
stays numbered (`1`, `4`) and pi-quiver never renames it. Verified on the
reporter's machine (Herdr 0.9.0, `~/.config/herdr/session.json`): every
numeric-looking tab carries `custom_name: "<n>"`, not `custom_name: null`,
including `w9:tH`, whose pane runs a session already auto-named
`Verify E-3108 Leg 2 Delivery Simulation` while the tab shows `1`.

Root cause in `extensions/session-name.ts`:

1. **Restore poisons the claim.** `restoreHerdrTab` (`:561-580`) writes
   `String(position)` through `tab.rename`. Herdr's `handle_tab_rename` calls
   `set_custom_name`, so the number becomes a permanent custom label:
   `tab_display_name` (herdr v0.9.0 `src/workspace.rs:446-453`) returns
   `custom_name` when set and derives the position only for `None`;
   `move_tab` (`src/workspace.rs:595-618`) never touches `custom_name`. After
   a reorder the label (`4`) differs from the live position (`1`), and the
   successor's first claim - `matchOwned(own.label, String(position))`
   (`:535`) - flips `herdrClaim` to `"backed-off"` for the whole pi session.
2. **`/new` hits the same rule.** In the installed pi (0.85.x) `/new`,
   `/resume`, and fork await `teardownCurrent` (which awaits
   `session_shutdown`, hence the chained restore) and then build a new runtime
   that re-invokes the extension factory
   (`dist/core/agent-session-runtime.js:102-161`,
   `dist/core/extensions/loader.js:459-481`), so `herdrClaim` starts `null`
   in the successor. The successor fails for reason 1: the restored number is
   compared against the live position. `herdrClaim` survives only in
   same-install reuse (settings reload, the test harness); the `session_start`
   reset below covers that path and pins the fresh-process contract.

Herdr's socket API offers no "clear to auto" and no auto-vs-custom flag on
`tab.list`; Herdr itself never writes a numeric custom label. Every bare
number on a tab was written through the API - by this extension's restore,
or by `herdr-ntfy-notify` in a stale-read race (its `toggle.mjs` reads the
live label, then writes `addPrefix`/`stripPrefix` of that read; a read before
our rename and a write after it re-applies the old number). Observed
2026-09-16T12:05Z: `~/.local/state/herdr/plugins/jjuraszek.ntfy-notify/armed.json`
= `{"tabs":["w1:t1H"]}` (one armed tab), no `* ` label on any tab in
`session.json`, and none of the numeric-labelled tabs is `w1:t1H`. The
reported failure is explained by the restore alone; ntfy is a possible
secondary source, handled by the same rule.

Secondary hazard surfaced during design: the naming prompt (`:333-343`) asks
to preserve IDs like `#99` but does not forbid a digits-only `TAB:` reply.
Under the new claim rule a digits-only label of our own would look like an
unnamed tab to any successor.

## Decisions (user-confirmed)

- **Ownership rule:** a live label that is only digits (`^\d+$`), optionally
  behind exactly one `* ` armed prefix, is claimable regardless of the tab's
  position. A human who deliberately names a tab `3` gets overwritten -
  accepted; a numeric label is Herdr's visual vocabulary for "unnamed".
- **`/new` semantics = fresh process.** `session_start` resets the Herdr
  claim state; the shutdown restore stays; the successor re-claims on its
  first name write.
- **Refresh:** no timer. `turn_start` keeps re-asserting. A live label that
  is a bare number is claimed - whether the tab is currently claimed or backed
  off - because a numeric label means "unnamed" at any point in time. A
  non-numeric foreign label backs off until the label becomes numeric again
  or the next `session_start`.
- **ID labels:** the prompt asks for `PR 1234` / `issue 123` /
  `ticket ABC-123` instead of a bare ID; a digits-only label is post-processed
  to `#<digits>`.
- **Not changed:** `revisitFirstTurn` / `revisitEveryTurns` defaults (both
  `0`), the user's local `settings.json`, `lib/herdr-tab.ts`,
  `lib/extension-config.ts` (zero new settings). Durable ownership files,
  Herdr event subscriptions, and clear-to-auto stay out of scope.

## Design

All changes live in `extensions/session-name.ts`; tests in
`test/session-name.test.ts`.

### Claimable test replaces position match

`matchOwned(live, expected)` keeps its role for the *owned* check (live equals
`lastWritten` modulo one `* `). A new sibling covers the *claimable* check:

```ts
const NUMERIC = /^\d+$/;
const matchClaimable = (live: string): { claimable: boolean; armed: boolean } => {
	if (NUMERIC.test(live)) return { claimable: true, armed: false };
	if (live.startsWith(ARMED_PREFIX) && NUMERIC.test(live.slice(ARMED_PREFIX.length))) return { claimable: true, armed: true };
	return { claimable: false, armed: false };
};
```

`syncHerdrTab`, `herdrClaim === null` branch: `listTabs` is no longer needed
for the claim decision - `getTab` suffices. `positionOf` remains in use by the
restore. Flow:

```
live = getTab()              null -> return (transient)
c = matchClaimable(live.label)
!c.claimable                 -> herdrClaim = "backed-off"
renameTab((c.armed ? "* " : "") + label) ok -> herdrClaim = { lastWritten: label }
```

### Re-claim on `turn_start`

`syncHerdrTab` no longer returns early on `"backed-off"`. Claimed and
backed-off branches both `getTab`; claimed first runs `matchOwned`, and when
that fails (or in the backed-off branch):

```
c = matchClaimable(live.label)
c.claimable  -> renameTab((c.armed ? "* " : "") + label); on ok herdrClaim = { lastWritten: label }
otherwise    -> herdrClaim = "backed-off"
```

Covers any revert to a bare number: a human renumbering the tab, or an ntfy
read/write race with our rename. A non-numeric foreign label is never
overwritten. Cost: one `tab.get` per turn in the backed-off state, the same
as the claimed state pays today.

### Per-session reset

`herdrClaim = null` is the first statement of the `session_start` handler,
before `loadConfig` and the `enabled` gate (`enabled: false, herdrTab: true`
is a supported config where `/session-name` still claims). The fresh branch
keeps its existing resets. `restoreHerdrTab` keeps reading `herdrClaim` when
its serialized `run` executes: pi awaits `session_shutdown` handlers, and the
extension's handler awaits the chained restore, so the restore has completed
before `session_start` resets. Resume (`current` set) takes the same path:
reset, then `setName` claims the numeric label.

### Numeric-label guard

`toTabLabel` is the single derivation point for tab labels (used by
`parseGeneratedName` and `setName`). Append one rule: when the joined result
matches `^\d+$`, return `#` + digits. `1234` -> `#1234`; `PR 1234`,
`#1234`, `Refine ABC-123` unchanged. Applies to model output and to
`/session-name 1234` alike.

### Prompt rule

`buildNamingPrompt` gains one built-in rule after the "Preserve ticket/issue
IDs" line:

```
- If the whole TAB would be just an ID, say what it is: PR 1234, issue 123, ticket ABC-123. Never reply with digits only.
```

Precedence: the typed-ID rule applies when the ID is the entire label; the
existing "preserve IDs verbatim" rule applies when the ID sits inside a longer
label (`Refine ABC-123`). User `rules` still land after built-ins and win on
conflict.

### Data flow, reported failure

```
shutdown: restore writes "4"          (custom label, position 4)
user moves tab to slot 1              (label stays "4")
new pi: first auto-name -> getTab "4" -> claimable -> rename "Verify E-3108 Leg 2"
later reorders                        (custom labels are position-independent; owned check still passes)
```

## Edge cases

| Case | Behaviour |
|---|---|
| Human names a tab `3` deliberately | Claimed and overwritten (accepted; documented in README) |
| Human names a tab `Deploy` before first auto-name | Not claimable -> `"backed-off"` for the session |
| Live `* 4` (armed) at claim | Claimable, armed; write `* <label>` |
| Tab reverts to a bare number after our claim (human renumber, ntfy race) | `turn_start`: owned fails, claimable -> rewritten |
| Human renames the tab after our claim | Owned fails, not claimable -> `"backed-off"`; restore skipped |
| Backed-off tab later shows a bare number | `turn_start`: claimable -> claimed and renamed |
| Model replies `TAB: 1234` | `toTabLabel` -> `#1234` |
| Session name is digits only, no TAB line | `#<digits>` |
| `/new` while Herdr unreachable | Reset happens; `getTab` null -> no claim, retried next sync |
| Stale `HERDR_TAB_ID` (pane moved) | `getTab` null -> no-op, as today |
| Two pi processes in one tab | Last writer wins, as today; out of scope |
| Non-TUI mode, Herdr inactive, `herdrTab: false` | Unchanged gates: no socket I/O |

## Testing

`test/session-name.test.ts`, existing `extensionHarness` + `fakeHerdr`
(`:252-370`); no new mocks. Every fixture below that claims a numeric label
places it at a position that differs from the number, so it is red before the
fix.

New regressions (red before, green after):

1. Claim when live label is `4` while the tab sits at position 1 (the report).
2. Claim when live is `* 7` at position 1; written label is `* <label>`.
3. Claimed, then live reverts to `2`: next `turn_start` rewrites the label
   and `lastWritten` is updated.
4. Claimed, then live becomes `Deploy` (backed off), then live becomes `5`:
   next `turn_start` claims and renames.
5. `/new` in one install: `session_shutdown` (restore writes the position)
   -> `session_start` fresh -> `agent_end` auto-name renames the tab again;
   `renames` records `["<old>", "<n>", "<new>"]` in order. Before the fix
   the surviving `herdrClaim` backs off at the third step.
6. Resume in one install (`session_start` with a name) with live label `3`
   at position 1: claim happens.
7. Delayed first claim then shutdown: `turn_start` sync with a delayed
   `tab.get` reply, `session_shutdown` enqueued before it resolves; restore
   still writes the position number (it reads `herdrClaim` when it runs).
8. `toTabLabel("1234") === "#1234"`.
9. `parseGeneratedName("SESSION: Review pull request 1234\nTAB: 1234")`
   yields `tabLabel: "#1234"`.
10. `buildNamingPrompt` output contains the typed-ID rule line; a user rule
    still follows it.

Retained invariants (already green; keep as guards): back-off on a
non-numeric label before the claim (`:612`), no restore after a foreign
rename (`:740`), `toTabLabel("PR 1234")` and `toTabLabel("#1234")`
unchanged.

Existing assertion that the redesign breaks: `test/session-name.test.ts:945`
`assert.deepEqual(fake.requests, ["tab.list", "tab.rename"])` becomes
`["tab.get", "tab.rename"]` (the claim path swaps `listTabs` for `getTab`);
the overlap-order assertions that follow stay.

Verification: `env -u PI_CODING_AGENT_DIR npm run test:all`.

## Documentation impact

Materiality bar: `reference/documentation-impact.md` (pi-gauntlet brainstorming skill).

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` session-name Herdr section
  (claim rule: any numeric label is treated as unnamed and taken over, a
  non-numeric human name is respected until the label is numeric again;
  `/new`/resume re-claim; digits-only labels become `#<digits>`; typed-ID
  naming rule); `CHANGELOG.md` `## Unreleased`
  bullet
- Derived / memory docs invalidated: supersession banners on
  `doc/specs/2026-09-01-herdr-tab-name-sync.md` and
  `doc/specs/2026-09-13-gh-19-herdr-armed-prefix-tolerance.md`

## Open questions

None.
