# Herdr tab sink: tolerate the `* ` armed prefix

> **Superseded by:** [doc/specs/2026-09-16-herdr-tab-reorder-resilience.md](./2026-09-16-herdr-tab-reorder-resilience.md) - ownership comparison at claim time in `## Design` only (prefix tolerance stands)

Ticket: jjuraszek/pi-quiver#19. Supersedes the ownership-comparison scope of
[doc/specs/2026-09-01-herdr-tab-name-sync.md](./2026-09-01-herdr-tab-name-sync.md)
(`### Write path and claim-once state machine`, `### Restore on shutdown`,
`### Edge cases`); its transport, config, position math, gates, and
serialization stand.

## Problem

`herdr-ntfy-notify` 1.1.0 marks an armed tab by prefixing its Herdr label with
exactly `* ` (asterisk, space) and removes exactly one such prefix on disarm.
Evidence (herdr-ntfy-notify, branch `gh-1-per-tab-arming`, commit 51c0f95,
`lib.mjs`): `const PREFIX = "* "`; `addPrefix(label)` is idempotent (never
`* * `); `stripPrefix(label)` removes exactly one leading `PREFIX`. Its spec
`doc/specs/2026-09-13-gh-1-per-tab-arming-indicator.md` drops the ticket's
"re-apply on next event" AC - the event hook never spawns `herdr`, so a prefix
lost to a foreign rename stays lost until the user re-arms. A future
ntfy-notify version using a different marker is outside this contract.

The `session-name` Herdr sink (`extensions/session-name.ts:499-567`) is
claim-once with exact label equality:

- unclaimed: claims only when `own.label === String(position)` (line 527);
- claimed: `live.label !== herdrClaim.lastWritten` flips the claim to
  `"backed-off"` for the rest of the pi session (line 538);
- restore: writes `String(position)` only when `live.label === lastWritten`
  (lines 557-563).

Arming a claimed tab therefore permanently kills auto-naming for that session,
and arming a default tab before the first rename blocks the claim entirely.
Conversely, if the sink did rename an armed tab it would write a bare label and
silently disarm the notification.

## Constraint (user-confirmed)

Zero new config, probing, or dependency. The prefix is passive label state:
pi-quiver never detects `herdr-ntfy-notify`, and a `* ` prefix is tolerated
whoever wrote it. Users without Herdr (`isHerdrActive()` false: `HERDR_ENV`,
`HERDR_TAB_ID`, `HERDR_SOCKET_PATH`, TTY) see no change and no socket I/O, as
today. Transport failures keep resolving to `null` and stay transient.

## Design

All changes live in `extensions/session-name.ts`. `lib/herdr-tab.ts` is
untouched: the transport stays ignorant of label content.

### `matchOwned(live, expected)`

Pure helper, module-local, not exported (all tests go through the fake socket):

```ts
const ARMED_PREFIX = "* ";
function matchOwned(live: string, expected: string): { owned: boolean; armed: boolean } {
  if (live === expected) return { owned: true, armed: false };
  if (live === ARMED_PREFIX + expected) return { owned: true, armed: true };
  return { owned: false, armed: false };
}
```

A live label is ours iff it equals what we expect, or exactly `* ` plus what
we expect. Nothing is stripped from `expected`, so a sink-chosen name that
itself begins with `* ` (`toTabLabel("* urgent fix")` keeps the prefix;
`extensions/session-name.ts:175-182`) keeps working: live `* urgent fix` is
owned and not armed; live `* * urgent fix` is owned and armed. `* * Old`
against expected `Old` is foreign.

### Ownership comparison

Every comparison of a live label goes through `matchOwned`:

| Path | Today | New |
|---|---|---|
| unclaimed (527) | `own.label === String(position)` | `matchOwned(own.label, String(position)).owned` |
| claimed (538) | `live.label !== lastWritten` -> back off | `!matchOwned(live.label, lastWritten).owned` -> back off |
| restore (557) | `live.label === lastWritten` | `matchOwned(live.label, lastWritten).owned` |

`herdrClaim` keeps its shape `{ lastWritten: string } | "backed-off" | null`;
`lastWritten` stores exactly the name the sink chose, as today. Armed state is
not stored - it is re-derived from the live read in every cycle.

### Writes preserve the observed prefix

Each write re-attaches the prefix iff `matchOwned` on the label read in the
same cycle reported `armed`:

- rename: `(armed ? ARMED_PREFIX : "") + label`, then `lastWritten = label`;
- initial claim: same, `armed` from the `listTabs` entry's label;
- restore: `(armed ? ARMED_PREFIX : "") + String(position)`, `armed` from the
  `getTab` read that gates the restore - never from the later `listTabs`
  call, which serves only the position.

The sink never adds a prefix that was not there and never removes one that
was. The same-name short-circuit (`label === lastWritten` -> return) stays
before the write, so an arm/disarm flip without a name change produces no
write: the prefix is `herdr-ntfy-notify`'s state to toggle.

### Behavior matrix

| live label | `lastWritten` | result |
|---|---|---|
| `Ratatui-sink` | `Ratatui-sink` | rename to `New` (unchanged behavior) |
| `* Ratatui-sink` | `Ratatui-sink` | rename to `* New` |
| `Ratatui-sink` (disarmed after `* Ratatui-sink`) | `Ratatui-sink` | rename to `New`; claim kept |
| `* 3` (armed before first rename, position 3) | `null` | claim; write `* <name>` |
| `Foo` or `* Foo` | `Ratatui-sink` | backed-off (unchanged) |
| `* * Ratatui-sink` | `Ratatui-sink` | backed-off (base is `* Ratatui-sink`) |
| `* Ratatui-sink` at shutdown, position 2 | `Ratatui-sink` | restore writes `* 2` |
| `* urgent fix` (sink's own name) | `* urgent fix` | owned, not armed; rename writes bare `New` |
| `* * urgent fix` (armed sink name) | `* urgent fix` | owned, armed; rename writes `* New` |
| `* ` | anything | backed-off (matches nothing) |

### Edge cases

- **Race with `herdr-ntfy-notify` between read and write.** `tab.rename` has
  no compare-and-swap; last write wins. Two ordering-dependent outcomes,
  both accepted: (a) ntfy-notify arms after our read and before our write -
  our bare write drops the marker, nothing repairs it (ntfy-notify never
  re-applies), the user re-arms; (b) ntfy-notify reads the old label before
  our write and commits `* <oldName>` after it - our next cycle sees a
  foreign label and backs off, exactly as the 2026-09-01 spec already accepts
  for any non-atomic external write. The same window exists on the unclaimed
  path between `listTabs` and `renameTab`. The README sentence therefore says
  "preserved", not "guaranteed".
- **Restore keeps the tab armed.** Writing `* <position>` matches
  ntfy-notify's own semantics (disarm on `* 1` yields custom `1`). Restore
  never decides arm state.
- **Leading `* ` typed by a human.** Indistinguishable from arming; treated as
  armed. Accepted, same collision `herdr-ntfy-notify` accepts.
- **Failures.** Unchanged: `null` from `getTab`/`listTabs` leaves the claim as
  is and retries next cycle; a failed `renameTab` leaves `lastWritten`
  unchanged.

### Out of scope

- Any prefix other than exactly one leading `* `; configurable markers.
- Detecting or depending on `herdr-ntfy-notify`; any settings key.
- Changes to `lib/herdr-tab.ts`, the TUI/TTY/env gates, `herdrChain`, or
  position math.
- Clearing a label to Herdr-automatic (no API exists).

## Testing

Extend the `herdr sync: ...` block of `test/session-name.test.ts` (from
`"herdr sync: claims and renames on position-default label"` onward) using the
existing `fakeHerdr(` helper (real nested `result.tab` / `result.tabs`
envelopes, label mutation on `tab.rename`, request recording). No new mock.
New cases:

1. claimed tab externally set to `* Old` -> next rename writes `* New`, claim
   kept (`lastWritten === "New"`, verified by a following rename succeeding);
2. default tab pre-armed as `* 3` at position 3 -> initial claim succeeds,
   write is `* <name>`;
3. `* Old` then externally `Old` (disarm) -> next rename writes bare `New`;
4. shutdown with live `* <name>` -> restore writes `* <position>`;
5. `* Foo` with `lastWritten = Old` -> backed-off, no write; `* * Old` ->
   backed-off;
6. same name, live label flips `Old` -> `* Old` -> no `tab.rename` request;
7. sink name starting with `* `: claim writes `* urgent fix`, live stays
   `* urgent fix` -> next rename to `New` writes bare `New`; and after an
   external arm to `* * urgent fix` -> rename writes `* New`.

Existing Herdr tests must pass unchanged. Run `npm run test:all` (with
`env -u PI_CODING_AGENT_DIR` in a pi harness shell).

## Documentation impact

Materiality bar: `reference/documentation-impact.md` in the brainstorming skill
directory.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` `herdrTab` paragraph (~line
  203) gains one sentence - a leading `* ` (herdr-ntfy-notify's armed marker)
  is not a human rename: it is preserved across renames and the shutdown
  restore, and its removal keeps the claim; the sink's contract comment at
  `extensions/session-name.ts:499-502` ("a human rename ... wins
  permanently") gains the same one-clause exception; `CHANGELOG.md`
  `## Unreleased` bullet
- Derived / memory docs invalidated: `doc/specs/2026-09-01-herdr-tab-name-sync.md`
  receives the supersession banner with the scope named at the top of this
  spec

## Open questions

None.
