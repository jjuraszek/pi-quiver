# Message timestamps: one fixed `YYYY-MM-DD HH:mm` time, no footer label

**Goal:** The `message-timestamps` extension shows every time as `YYYY-MM-DD HH:mm` (`2026-11-22 15:24`) in the machine's local time zone, the same for every system language, in both the footer status and the transcript time lines; the footer status is that time alone, without the `last message` label.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Ticket:** none
**Branch:** `jacek/footer-timestamp-24h` (base `main` @ 852fba4)

## Problem

The footer status reads `last message Nov 22, 03:24 PM` on an `en-US` machine. The label is noise next to the other statuses on the row, and the clock is 12-hour because the formatter leaves that choice to the system language. The user asked for the label to go and for a 24-hour time, then fixed the shape in the questionary: `single formata 2026-11-22 15:24 not exception. local timezone always`. That answer replaces the request's first example (`Nov 22, 15:24`): the shape is one numeric form for every system language and for both displays, and no setting or per-display exception exists.

Original request, verbatim: `message ts info on status bar is prefixed with "last message". it should go away as this is noice, only ts in format like "Nov 22, 15:24" (24h clock)`; later `be minimal`. No ticket; the request arrived as free text after a triage that confirmed the behavior.

Framing: kept

Assumption stated in the opening message and not contested: the new shape applies to the transcript time lines too, because both displays call the one formatter; the questionary answer ("not exception") confirms it.

Checked claims (2026-11-22, worktree at `852fba4`, Node v26.13.0 and v24.21.0, system language `en-US`, zone `Europe/Warsaw`):

| Claim | Lookup | Result |
|---|---|---|
| The footer text carries the literal `last message ` | read `extensions/message-timestamps.ts:63-66` | held |
| `formatTime` sets no hour cycle, so the system language picks 12 or 24 hours | read `extensions/message-timestamps.ts:26-30` | held |
| The transcript time lines use the same `formatTime` and store only the entry time | read `extensions/message-timestamps.ts:54-61`; `rg formatTime` finds callers at `:60` and `:66` only | held |
| The Date's local-clock getters with two-digit padding give the fixed shape | `node -e` on both Node versions: `getFullYear`, `getMonth() + 1`, `getDate`, `getHours`, `getMinutes` with `padStart(2, "0")` on `new Date("2026-11-22T15:24:00")` and `new Date(2026, 0, 2, 0, 5)` | held: `2026-11-22 15:24`, `2026-01-02 00:05` |
| `Intl.DateTimeFormat("sv-SE", ...)` gives the same shape | same two dates on both Node versions (ICU 78.3) | held on these two builds; the shape comes from Swedish language data, not from an option, so this route was rejected |
| `en-CA` and `en-US` with `hourCycle: "h23"` do not give the shape | same probe | held: `2026-11-22, 15:24`, `11/22/2026, 15:24` |
| `hourCycle: "h23"` gives `Nov 22, 15:24` in `en-US`; `hour12: false` is not equivalent | `Intl.DateTimeFormat` probes, including `en-US-u-hc-h24` at 00:05 | held (`hour12: false` gives `24:05`); superseded by the fixed-shape answer |
| A 24-hour option alone leaves date order and month name to the system language | same probe, `en-GB` and `pl-PL` | held: `22 Nov, 15:24`, `22 lis, 15:24`; superseded by the fixed-shape answer |
| Tests pin the 12-hour string and the label | read `test/message-timestamps.test.ts:86,120-121,194-196,692`; `rg -i "last message"` lists `:121,202,205,277,374,400,526,541,692` | held; `:120` builds its own formatter, `:692` uses the label as the "footer shows a time" check |
| Tests pin a zone only through `formatTime`'s `locale`/`timeZone` parameters | `rg` in the test file: `:86` and `:194` pass `"en-US", "UTC"`; mocked clocks start from `Date.parse("2026-11-19T14:59:00Z")` at `:110,247,361,390,514,530` and `T14:58` at `:156`; every other expectation calls `formatTime(date)` | held: a clock built from local fields (`new Date(2026, 10, 19, 14, 58)`) gives literal expectations that hold in any zone |
| An unreadable saved time behaves differently under the new formatter | `node -e` with `new Date(NaN)`, year padded to four digits and the other fields to two | held: the padded fields return `0NaN-NaN-NaN NaN:NaN`; the current formatter throws `RangeError: Invalid time value` |
| A valid year shorter than four digits needs its own padding | `node -e` with `new Date("0999-01-02T00:05:00")` | held: the unpadded year gives `999-01-02 00:05`; `padStart(4, "0")` on the year gives `0999-01-02 00:05` |
| Both callers build the date from a saved entry's time | read `extensions/message-timestamps.ts:32-38,60,63-66`; council probe of pi's `dist/core/session-manager.js:314-368,727-758` | held: `new Date(entry.timestamp)` at both callers. Pi writes valid times on append, but its loader checks the session header and not each entry's timestamp, so a saved record with a malformed time (`timestamp: "bad"`) reaches replay unchanged; that input is unsupported |
| README states neither the label nor the old shape | read `README.md:147-160` | held: "local date and time" in both switch rows stays accurate |
| CHANGELOG has no `## Unreleased` heading | read `CHANGELOG.md:1-8` | held: newest heading is `## v6.17.0 - 2026-11-20` |
| No other doc describes the time shape | `rg -i timestamp doc/*.md AGENTS.md skills` | held: only `AGENTS.md:3` names the extension, without a format |
| The predecessor spec fixes the format and the label, and already carries a supersession banner | read `doc/specs/2026-11-19-gh-44-message-timestamps-footer-transcript.md:3,28,166,170,187,262` | held: `:3` is the `> **Superseded by:**` banner pointing at this spec, with the same scope as the supersedes clause in Design, `:28` the questionary time-format decision, `:166` "Time format", `:170` the footer status text, `:187` the renderer, `:262` the `formatTime` test row |
| Ticket #44 is closed with no reporter notes | `gh issue view 44 --json comments` | held: closed 2026-11-20, two comments, no `Reporter note:` section |
| The host footer joins extension statuses with one space, sorted by key | read `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js:252-260` (pi 1.6.0) | held: the unlabeled time sits beside other statuses with no separator of its own |
| The automatic check's runners (ubuntu and windows, Node 24) format the same way | read `.github/workflows/test.yml:13,20`, `package.json:30` | not run on Windows; the chosen formatter reads no language data, so the output cannot differ by runner language |

Implicit dependencies recorded missing or not checkable:

- `../pi-condense`, `../pi-cohort` relative to the worktree - `ls` - not found; cited only by the predecessor spec, not needed by the extension or its tests.
- Live terminal observation of the footer and a replayed transcript line - no TUI in this session - not checkable; the test that draws the real `FooterComponent` (`test/message-timestamps.test.ts:668-698`) stands in.

## Acceptance criteria

Drafted from the design, no ticket rows:

- [ ] With the footer switch on and the newest saved message at local 14:59 on 19 Nov 2026, the `message-timestamps` footer status text is exactly `2026-11-19 14:59`.
  in-scope
- [ ] With the transcript switch on, the time line for an entry saved at local 14:59 on 19 Nov 2026 reads `2026-11-19 14:59`.
  in-scope
- [ ] A time at local 00:05 on 2 Jan 2026 is shown as `2026-01-02 00:05`.
  in-scope

## Legs

### Leg: jjuraszek/pi-quiver
branch: jacek/footer-timestamp-24h
contract:
- create: git worktree add <home> -b <branch>
- destroy: git worktree remove <home> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: env -u PI_CODING_AGENT_DIR npm run test:all (run in the worktree)
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/fetch.md
Rules: doc/doc-to-md.md
Rules: doc/provider-stall-watchdog.md
Rules: doc/slack.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
Rules: eval/elevator/README.md
scope: AC 1, AC 2, AC 3
design: owns `extensions/message-timestamps.ts` (`formatTime` and the footer status text), `test/message-timestamps.test.ts`, `CHANGELOG.md` (one `## Unreleased` bullet); observable outcomes are the `message-timestamps` footer status text and the dim `message-timestamp` transcript lines.

## Design

supersedes `doc/specs/2026-11-19-gh-44-message-timestamps-footer-transcript.md`, "Time format" section (`:166`), the status text clause of "Footer" (`:170`), the questionary "Time format" decision (`:28`: system locale and time zone, `Nov 19, 02:59 PM` in `en-US`), and the Tests row that asserts the old `formatTime` signature and output (`:262`: `formatTime(new Date("2026-11-19T14:59:00Z"), "en-US", "UTC")` is `Nov 19, 02:59 PM`). Everything else in that spec stays current.

### Time format

`formatTime(date: Date): string` in `extensions/message-timestamps.ts` returns `YYYY-MM-DD HH:mm`: the date's local-clock year padded to four digits with `padStart(4, "0")` (a valid year shorter than four digits gets leading zeros: `0999`), then month (`getMonth() + 1`), day, hour and minute, each of those four padded to two digits with `padStart(2, "0")`, joined as `<year>-<month>-<day> <hour>:<minute>`. The hour runs 00 to 23. The function reads no language data and takes no time zone, so the machine's local zone is the only one it can use and the system language cannot change the output.

### Footer

The footer status text is `formatTime(new Date(timestamp))` alone, still passed through `ctx.ui.theme.fg("dim", ...)`. Which message it follows, when it refreshes, and when it clears are unchanged.

### Transcript lines

The entry renderer keeps calling `formatTime(new Date(entry.timestamp))`, so the time lines take the new shape with no edit to the renderer. Saved sessions store the moment, never the text, so records written before this change redraw in the new shape on resume; no migration exists.

### Unchanged

The two switches, the `/timestamps` command, the `message-timestamp` record type, the `quiver.messageTimestamps` settings keys, the status key `message-timestamps`, and `README.md`.

### Moving parts

Implementation scope is three files: `extensions/message-timestamps.ts`, `test/message-timestamps.test.ts` and `CHANGELOG.md`. The two spec artifacts - this spec and the predecessor's supersession banner - are not implementation deliverables; the list neither removes nor excludes them. The implementation adds no new file, function, setting or dependency.

- Remove: `formatTime`'s `locale` and `timeZone` parameters and its `Intl.DateTimeFormat` call (`extensions/message-timestamps.ts:26-30`).
- Remove: the `last message ` text in the footer status template (`extensions/message-timestamps.ts:66`).
- Remove: in `test/message-timestamps.test.ts`, the `"en-US", "UTC"` arguments at `:86` and `:194`; the `Nov 19, ... PM` literals at `:86` and `:195-196`; the test's own `Intl.DateTimeFormat` at `:120`; the `last message ` prefix at `:121,202,205,277,374,400,526,541`; the `includes("last message ")` check at `:692`.
- Add: the padded local-field string inside `formatTime`.
- Add: in "formatTime renders date and time", the two literal cases `formatTime(new Date(2026, 10, 19, 14, 59))` equals `2026-11-19 14:59` and `formatTime(new Date(2026, 0, 2, 0, 5))` equals `2026-01-02 00:05`.
- Add: in "footer follows the prompt and the final reply", a mocked clock starting at `new Date(2026, 10, 19, 14, 58).getTime()` and the literal expected statuses `["2026-11-19 14:58", "2026-11-19 14:59"]`.
- Add: in "multi-tool run writes two records in order", a mocked clock starting at `new Date(2026, 10, 19, 14, 58).getTime()` and `run.map((entry) => formatTime(new Date(entry.timestamp)))` equal to the ten literals `2026-11-19 14:59` through `2026-11-19 15:08`, one minute apart.
- Add: in "deferred shell output follows the settle line live but precedes it on replay", a mocked clock starting at `new Date(2026, 10, 19, 14, 59).getTime()` (replacing `Date.parse("2026-11-19T14:59:00Z")` at `:247`) and `promptLine` as the literal `dim:2026-11-19 14:59` (replacing `` `dim:${formatTime(new Date())}` `` at `:258`), so the existing `assert.deepEqual(live, [promptLine, settleLine, "deferred"])` compares the rendered prompt time line against a literal.
- Add: in the two tests that draw the real footer ("footer shares the status row", "footer adds one row when alone"), `/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(rows.at(-1)!)` equals `footer`.
- Add: a `## Unreleased` section in `CHANGELOG.md`, after the preamble (lines 1-4) and before `## v6.17.0 - 2026-11-20`, with one bullet (see Documentation impact).

The seven label-only expectations (`:202,205,277,374,400,526,541`, in six tests) keep comparing against `formatTime(...)` of the entry time; only the prefix goes.

### Paid or external actions

None. Building and verifying this needs no paid or external action; approving the spec authorizes none.

## Errors and edge cases

- Midnight and single-digit months, days, hours and minutes pad to two digits: `2026-01-02 00:05`.
- The text carries no zone marker, so when clocks go back the repeated local hour shows the same text twice. This follows from "local timezone always" with no exception and is accepted.
- A date that cannot be read (`new Date(NaN)`) yields `0NaN-NaN-NaN NaN:NaN` where the old formatter threw. Pi writes valid entry times, but it replays a saved record without checking its timestamp, so a malformed saved time can reach the formatter. That input is unsupported; no guard is added.
- Records saved before this change hold only the moment and redraw in the new shape; nothing is rewritten on disk.

## Tests

All in `test/message-timestamps.test.ts`; verification is `env -u PI_CODING_AGENT_DIR npm run test:all` in the worktree, plus one focused run of the formatter test in a zone that is not UTC: `env -u PI_CODING_AGENT_DIR TZ=Asia/Kathmandu node --test --test-name-pattern="formatTime renders date and time" test/message-timestamps.test.ts`. In UTC the literal cases cannot tell UTC getters from local getters; in `Asia/Kathmandu` (UTC+05:45) UTC getters turn local 14:59 into `09:14` and the cases fail. The full suite and the CI matrix stay as they are.

- The footer status is exactly `2026-11-19 14:58` after the prompt and `2026-11-19 14:59` after the final reply, with no label (AC 1) - "footer follows the prompt and the final reply"
- The rendered prompt time line is exactly `dim:2026-11-19 14:59` with the clock at local 14:59 on 19 Nov 2026 (AC 2) - "deferred shell output follows the settle line live but precedes it on replay"
- Run order and entry times: the run's ten entries sit in the expected order with entry times `2026-11-19 14:59` through `2026-11-19 15:08`, one minute apart; the 14:59 entry is the user message, and the two time-line records (15:00 and 15:08) render as `dim:` plus `formatTime` of the record's entry time - "multi-tool run writes two records in order"
- `2026-01-02 00:05` for local 00:05 on 2 Jan 2026, and `2026-11-19 14:59` for local 14:59 on 19 Nov 2026 (AC 3, padding edge) - "formatTime renders date and time"
- The row drawn by pi's real footer component contains a `YYYY-MM-DD HH:mm` time exactly when the footer switch is on - "footer shares the status row", "footer adds one row when alone"
- The seven other footer status expectations (two in the multi-tool run, one each in deferred shell output, aborted run, saved entry time, resume, tree navigation) equal `formatTime` of the followed entry with no label - their existing tests
- Records saved before the change redraw in the new shape - none: a stored record holds only the moment, so an old record is indistinguishable from the one "multi-tool run writes two records in order" reopens
- Repeated local hour when clocks go back - none: accepted behavior with no code path of its own
- Unreadable saved time - none: a malformed saved time is unsupported input and the design adds no guard

## Documentation impact

Per `reference/documentation-impact.md`:

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - new `## Unreleased` section with one bullet: `message-timestamps` shows times as `2026-11-22 15:24` (`YYYY-MM-DD HH:mm`, local time zone, same for every system language) in the footer and the transcript, and the footer no longer prefixes the time with `last message`. Clears "Major procedures / conventions": the release flow promotes `## Unreleased`, and a user-visible display change without a bullet ships unannounced.
- Derived / memory docs invalidated: none

`README.md` says "local date and time" in both switch rows and stays accurate, so it is not edited.

## Out of scope

- A setting or command option for the time format.
- A different shape for the footer than for the transcript lines.
- Seconds, a zone marker, or a UTC option.
- Rewriting saved `message-timestamp` records.
- A guard for unreadable dates.
- Edits to `README.md`, `AGENTS.md`, or the released `## v6.17.0` changelog entry.

## Open questions

None.
