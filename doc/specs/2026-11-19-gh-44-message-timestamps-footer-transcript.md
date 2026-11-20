# Message timestamps: last-message time in the footer, time lines in the transcript

**Goal:** A new `message-timestamps` extension shows the time of the newest saved message on pi's shared footer status row (on by default) and, when switched on, saves a dim time line after each prompt that reaches the model and after each settled run (off by default); the two displays are independent, each has a `quiver.messageTimestamps` switch and a session-only `/timestamps` toggle, no time record ever reaches the model, and nothing is written or shown outside the terminal UI.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Ticket:** #44 (jjuraszek/pi-quiver)
**Branch:** `jacek/gh-44-message-timestamps` (base `main` @ 5a7b44f)

## Problem

Pi shows no clock anywhere: not in the transcript and not in the footer. A user who comes back to a session after a gap cannot tell when the last message landed, and cannot tell how long a run took. The reporter's reference is an unlicensed gist (`https://gist.github.com/oboxodo/2784a9f5c44909edf3d550cbad519cb8`, one file `message-timestamps.ts`); its behavior is the model, its code is not copied. The gist couples both displays (one helper sets the footer and appends a transcript record whenever it runs), has no settings and no command, and is disabled only by deleting the file. Ticket #44 asks for the same two displays as a pi-quiver extension with independent switches.

Framing: kept (ticket #44) - the default-on footer is an exception to the repo's opt-in convention for screen-changing extensions (`README.md:21,36,86`; `AGENTS.md:3`); the ticket's title and Context record that exception as decided, so it is adopted, not asked.

Ticket requirements carried from the body (Context, Problem, Idea), beyond the acceptance rows:

- The footer time uses pi's existing shared status row, not a separate footer component and not a fixed extra row. "Should not make the screen taller" is qualified by the no-other-status case, which adds exactly one row.
- Transcript time lines are display-only session records, never sent to the model, across tool-loop requests and across resume.
- No record is written while the transcript switch is off or outside the terminal UI, even with both switches on in settings.
- Live toggles are session-only. Footer changes apply immediately; transcript changes apply from the next message on.
- No separate elapsed-duration output: the two time lines let the user read the duration.
- The issue has no comments and no `Reporter note:` sections (0 comments fetched, 1 page).

Questionary decisions (2026-11-19):

- Time format: date and time in the system locale and time zone, always (`Nov 19, 02:59 PM` in `en-US`). No today/older distinction, no timer.
- Footer source: the footer shows the newest saved message and moves during a run (every saved message: prompt, reply, tool result, system message, `!` shell result, saved custom message). Rejected: moving only at the prompt and at the end of the run (the gist's behavior), because the live footer then disagrees with the resumed footer after an interrupted or retried run and the two switches share one trigger.
- Names: settings block `quiver.messageTimestamps` with `footer` (default `true`) and `transcript` (default `false`), no `enabled` field; command `/timestamps [footer|transcript] [on|off]`.
- The extension does nothing outside `ctx.mode === "tui"`, rpc included.
- "Newest message" is any saved message, including a tool result, a `!` shell result, and a saved custom message. The display-only `message-timestamp` records are not messages and do not count.

Checked claims. Paths are relative to `node_modules/@earendil-works/pi-coding-agent/dist/` (installed 1.5.2) unless they start with a repo directory.

| Claim | Lookup | Result |
|---|---|---|
| Pi shows no clock in transcript or footer | `grep -rli 'showTimestamp\|messageTimestamp' dist`; pi `docs/settings.md`, `docs/tui.md`, `CHANGELOG.md` grep `timestamp` | held - only `/tree` label timestamps and `MarkdownTransformContext.timestamp` for saved entries |
| The built-in footer draws all extension statuses on one shared row, present only when a status is set | `modes/interactive/components/footer.js:252-261` | held - `size > 0` guard, sorted by key with `localeCompare`, joined by one space, truncated to width, not dimmed by the footer |
| Status keys in use | `extensions/fast-mode.ts:80` (`fast-mode`), `extensions/provider-stall-watchdog.ts:159` (`providerStallWatchdog`), pi-condense `src/types.ts:125` (`context-prune`) | held - `message-timestamps` collides with none |
| `ctx.ui.setStatus(key, undefined)` clears a status; `ctx.ui.theme` styles text | `core/extensions/types.d.ts:95,199` | held |
| Every screen-changing pi-quiver extension is off until enabled | `README.md:21,36,86` | held |
| Every settings block carries `enabled` | `lib/settings-core.ts:38-45` | corrected - `docToMd` has no `enabled` field; `messageTimestamps` is the second such block and the first for an extension that draws on screen |
| A `custom` session entry is never sent to the model | `core/extensions/types.d.ts:1298-1299,1316-1317`; `core/session-manager.js:179` (only `custom_message` projects) | held - `sendMessage` and `custom_message` would leak and are not used |
| A renderer that returns nothing leaves no row | `modes/interactive/interactive-mode.js:3242-3250`; `components/custom-entry.js:38-56`; `core/extensions/types.d.ts:1208-1212` | held - a rendered line costs the host's spacer plus the component; `undefined` adds neither |
| A live record lands after the prompt; replay uses the same renderer | `interactive-mode.js:2883-2889`, `3340-3356` | held |
| Extension `message_end` handlers run before the message is saved, once per saved message | `core/agent-session.js:810-830`, `:1544-1593`; `core/extensions/runner.js:876-881` | held - an append inside `message_end` for the prompt would precede the prompt entry, and pi awaits every handler before it stamps the entry, so the clock inside `message_end` is not the saved time. The first hook after a prompt's save is the next message's `message_start` when pi delivers more messages in the same batch (`[user, ...nextTurn, ...before_agent_start messages]`, or several queued prompts), otherwise `context` |
| Which messages `message_end` saves as ordinary messages | `core/agent-session.js:814-830`, `:3286-3302` | held - roles system, user, assistant, toolResult; `custom` goes to `appendCustomMessageEntry` (a `custom_message` entry); a `!` command is a `bashExecution` message that `recordBashResult` saves through `appendMessage` as a `type: "message"` entry, at once when idle and just before `agent_settled` when issued during a run; `recordBashResult` emits no extension event |
| `agent_settled` fires once per run after retries and queued continuations, carries `aborted`, and only from the agent run path | `core/agent-session.js:738-745,1512-1536`; `core/extensions/types.d.ts:820-825`; handled extension commands return earlier at `:1705`; `extensions/provider-stall-watchdog.ts:476-512` | held - a slash prompt template expands into a user prompt and runs (`core/agent-session.js:1742-1747`); a provider-stall-watchdog re-drive is a second run and settles separately |
| `session_tree` fires after the new branch is installed | `core/agent-session.js:3506-3516`; `interactive-mode.js:1616-1627,4845-4861` | held |
| At startup and resume, `session_start` runs before the transcript replay | `interactive-mode.js:819-822`, `385-388`, `1698-1713`, `1798-1807` | corrected - holds at process start only; in-TUI session replacement (`/resume`, `/new`, `/fork`, `/clone`) calls `rebindCurrentSession({ renderBeforeBind: true })` and replays the transcript before extensions bind and before `session_start` |
| On `/reload` the transcript is rebuilt before `session_start`, and extension factories re-run | `interactive-mode.js:5529-5541`; `core/agent-session.js:3130` | held - the renderer receives `(entry, options, theme)` and no context (`core/extensions/types.d.ts:1211`); closure state is lost on `/reload` and on session replacement. A factory-load read with `process.cwd()` is not used: pi never calls `process.chdir`, so it reads the launch directory's project settings, not the destination session's |
| Run modes are `tui`, `rpc`, `json`, `print`; subagent children run json | `core/extensions/types.d.ts:232-239`; pi-cohort `src/runs/foreground/execution.ts:147`, `src/runs/background/subagent-runner.ts:1171` (`--mode json -p`) | held - `ctx.mode === "tui"` excludes all three |
| A session-only toggle command that never writes settings exists to follow | `extensions/fast-mode.ts:206-228,318-350` | held |
| Every session entry has an ISO `timestamp`; `getBranch()` and `getLeafEntry()` are on the read-only session manager | `core/session-manager.d.ts:17-25,178,297,318` | held |
| The hooks exist on old hosts | pi `CHANGELOG.md:1722,1732,2153-2161`, `:3888` (`message_start`, 0.52.10), `:6207` (`turn_end`, 0.18.0); `package.json:68-73` (peer `*`); README states no minimum | held - all predate pi 1.0; no version guard |
| `CHANGELOG.md` has an `## Unreleased` section | `head -12 CHANGELOG.md` | corrected - the top section is `## v6.16.4 - 2026-11-19`; this change adds the heading |
| Ticket Out of scope: "time lines already on screen stay, and stored ones stay hidden, until the next resume" | `components/custom-entry.js:24-56`; `interactive-mode.js:3868-3884` (Ctrl+O), `1627,4861` (`/tree`), `5529-5541` (`/reload`) | corrected - pi re-invokes the renderer for mounted lines on Ctrl+O and for every record when it rebuilds the transcript; a record whose renderer returned nothing was never mounted (`interactive-mode.js:3242-3259`). The stated behavior would need a per-entry memo. Stated in the opening message and not overridden: a stored line follows the switch at pi's next redraw of it; the rule per redraw kind is in `## Errors and edge cases` |
| Pi's markdown transformer could draw time lines with no stored record | `core/extensions/types.d.ts:1189-1198`; `core/extensions/loader.js:286-288` | not viable - a live message has no timestamp there and the transformer re-runs on every redraw |
| An existing extension or pi setting already reads message times | `extensions/*.ts` listing; `setStatus` callers; pi `docs/settings.md` | not viable - none does |
| The gist states no license | `gh api gists/2784a9f5c44909edf3d550cbad519cb8` (gather) | held |
| Tests can drive pi's real session classes with a scripted model, a chosen mode, and a rendered footer | `test/provider-stall-watchdog.test.ts:1019-1024`; `core/agent-session.d.ts:168-175`; `modes/interactive/components/footer.d.ts:13-18`; `core/session-manager.d.ts:385,393`; pi-ai `dist/providers/faux.d.ts:19-24,102`; `modes/interactive/components/footer.js:1-5,245-262`; `dist/index.d.ts` | held - no network, no credentials. `FooterComponent.render` reads pi's module-level theme and throws until the exported `initTheme()` runs; the `FooterDataProvider` class is not exported, only the `ReadonlyFooterDataProvider` type |
| `Intl.DateTimeFormat` with short month, numeric day, two-digit hour and minute | `node -e` on Node v26.13.0 for `2026-11-19T14:59:00Z`, UTC | held - `en-US` gives `Nov 19, 02:59 PM`, `en-GB` gives `19 Nov, 14:59` |
| Event order in a live terminal session (prompt saved before the first `context`; two records for a multi-tool run) | not run in gather - no live session, fixture, or credentials | not checked - the tests below prove the order on pi's real session classes |

## Acceptance criteria

Ticket #44, checkbox list, rows verbatim:

- [ ] In a TUI session with no settings for this extension, sending a prompt sets a last-message time in the footer to that moment, and the end of the run sets it again.
  in-scope
- [ ] With another extension's status already showing in pi's built-in footer (for example the pruner status), the last-message time appears on that same row and the footer has the same number of rows as with the footer switch off.
  in-scope
- [ ] With no other extension status showing in pi's built-in footer, the last-message time adds exactly one footer row.
  in-scope
- [ ] Resuming a session shows the time of the newest message on the current branch in the footer before any new prompt is sent.
  in-scope
- [ ] Moving to another branch with `/tree` changes the footer time to that branch's newest message before any new prompt is sent.
  in-scope
- [ ] A session with no messages shows no last-message time.
  in-scope
- [ ] With the footer switch off in `settings.json`, a new session shows no last-message status.
  in-scope
- [ ] In a TUI session with no settings for this extension, the transcript shows no time lines and a completed turn adds no timestamp record to the session file.
  in-scope
- [ ] With the transcript switch on, a run that makes several tool calls adds exactly two dim time lines to the transcript: one directly after the prompt and one after the final reply.
  in-scope
- [ ] With the transcript switch on, resuming the session shows the same time lines in the same positions with their original times.
  in-scope
- [ ] With the transcript switch on, every request sent to the model during a run with several tool calls, and every request in the first turn after a resume, contains no time-line text and no timestamp record.
  in-scope
- [ ] With the transcript switch off, resuming a session that already holds stored time lines shows none of them and no blank rows in their place, and new turns add no timestamp record to the session file.
  in-scope
- [ ] In print, json, and rpc runs, including subagent runs, with both switches on, no timestamp record is written to the session file.
  in-scope
- [ ] A dedicated slash command turns either switch on or off in the running session without changing the other and without a restart.
  in-scope
- [ ] The slash command reports the current state of both switches.
  in-scope
- [ ] Turning the footer time off with the command removes the last-message status immediately; turning it on shows the newest message's time immediately.
  in-scope
- [ ] Turning the transcript lines off with the command stops new time lines from the next message on; turning them on adds time lines from the next message on.
  in-scope
- [ ] The slash command changes only the running session: it does not write `settings.json`, and a new session starts from the `settings.json` values.
  in-scope
- [ ] README documents the extension, both switches with their defaults, and the slash command, and its statements about which extensions are active without setup include the footer time.
  in-scope
- [ ] `CHANGELOG.md` lists the new extension under `## Unreleased`.
  in-scope

## Legs

### Leg: jjuraszek/pi-quiver
branch: jacek/gh-44-message-timestamps
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
scope: AC 1, AC 2, AC 3, AC 4, AC 5, AC 6, AC 7, AC 8, AC 9, AC 10, AC 11, AC 12, AC 13, AC 14, AC 15, AC 16, AC 17, AC 18, AC 19, AC 20
design: owns `extensions/message-timestamps.ts`, `lib/settings-core.ts` (one registry entry), `test/message-timestamps.test.ts`, `test/extension-config.test.ts` (one registry case and one per-layer settings case), `README.md`, `AGENTS.md` (intro sentence), `CHANGELOG.md`; observable outcomes are the `message-timestamps` footer status, the `message-timestamp` session records and their dim lines, the `/timestamps` command, and the `quiver.messageTimestamps` settings block.

## Design

One new extension file holds both displays. They share the time formatter and the two switches, and nothing else: the footer never reads or writes a transcript record, and the transcript triggers never touch the status.

Remove: nothing.

Add:

- `extensions/message-timestamps.ts`: default-exported extension; exported `DEFAULT_CONFIG`, `formatTime`, `newestMessageTime`, `parseArgs`; handlers for `session_start`, `session_tree`, `message_start`, `message_end`, `context`, `tool_execution_start`, `turn_end`, `agent_settled`; an entry renderer for custom type `message-timestamp`; the `/timestamps` command.
- `lib/settings-core.ts`: `messageTimestamps: ["footer", "transcript"]` in `QUIVER_CONFIG_KEYS`. Nothing is added to the frozen `LEGACY_FLAT_KEYS`.
- `test/message-timestamps.test.ts`: the tests listed under `## Tests`.
- `test/extension-config.test.ts`: one registry case for the new `DEFAULT_CONFIG` and one case for per-layer settings coercion.
- `README.md`, `AGENTS.md`, `CHANGELOG.md`: the edits listed under [Documentation edits](#documentation-edits).

`package.json` does not change: `pi.extensions` discovers `./extensions`, `files` ships it, and `@earendil-works/pi-tui` (`Text`) is already a peer dependency.

### Switches

- `DEFAULT_CONFIG = { footer: true, transcript: false }`. One resolver serves every read of the switches: pi's merged settings from `pi.getSettings()` (`quiver.messageTimestamps`; pi includes the project layer only for a project it trusts, `core/settings-manager.js:257-260`) laid over the global file resolved with `resolveConfigFrom([<agent dir>/settings.json], "messageTimestamps", DEFAULT_CONFIG, coerce, warn)` from `lib/settings-core.ts`. `coerce` keeps a field only when its value is a boolean, the shape of `extensions/fast-mode.ts:86-96`; any other value is dropped from that settings layer's patch, so the last valid layer stays in effect and the built-in default applies only when no layer supplies a valid value (`lib/settings-core.ts:86-92,103-117`). There is no boolean shorthand for the whole block.
- The resolved switches live in the extension closure. `session_start` resolves them through that resolver and warns through `ctx.ui.notify`.
- The switches of the session being shown must be in effect before pi's first transcript replay of that session in the terminal UI. Process start runs `session_start` first; `/reload` and in-TUI session replacement (`/resume`, `/new`, `/fork`, `/clone`) re-run the factory and replay before `session_start`. That replay uses the destination session's settings (its project layer included when pi trusts that project), never the launch directory's: there is no `process.cwd()` read and no silent fallback to it. pi binds the destination's settings before that replay, so the entry renderer resolves the switches on its first call through the same resolver when `session_start` has not run yet. The replay and the `session_start` that follows it apply one rule and agree, for an untrusted project too.
- Settings are resolved only in the terminal UI. No settings file is read at factory load or in any handler in `rpc`, `json`, or `print`.
- `/timestamps` changes the closure value only. It never writes `settings.json`. Every `session_start` (new session, resume, `/reload`) returns both switches to the `settings.json` values.

### Mode gate

Every handler, the `/timestamps` command handler included, returns at once unless `ctx.mode === "tui"`: no status, no record, no notification, and no settings read in `rpc`, `json`, or `print`. An rpc `notify` is a protocol event the client sees (`modes/rpc/rpc-mode.js:91-99`), so the command sends none. Subagent children run `--mode json -p`, so the json case covers them (row 13). The renderer is registered in every mode; only the terminal UI invokes it.

### Time format

`formatTime(date, locale?, timeZone?)` returns `new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(date)`. Callers in the extension pass only the date, so the system locale and time zone apply; the two optional arguments exist for tests. `en-US` gives `Nov 19, 02:59 PM`.

### Footer

- Status key `message-timestamps`; text `last message <formatTime>` wrapped in `ctx.ui.theme.fg("dim", ...)`, set with `ctx.ui.setStatus`. The extension never calls `setFooter`.
- At each refresh, the footer looks for the newest saved message among session entries of `type: "message"` in any role (`system`, `user`, `assistant`, `toolResult`, and the `bashExecution` result of a `!` command) and `type: "custom_message"` entries. `type: "custom"` entries, which include the `message-timestamp` records, are display-only and do not count. One predicate serves the live refresh and the branch scan. Prompt-line eligibility (`### Transcript lines`) is separate: only a delivered user message gets a prompt line.
- `newestMessageTime(branch)` returns the `timestamp` of the last counted entry in `ctx.sessionManager.getBranch()`, or `undefined`.
- Refresh: the status is set from `newestMessageTime`, or cleared with `setStatus(key, undefined)` when there is none or the footer switch is off. The footer never reads the clock; the live value and the resumed value for the same message are the same saved entry time.
- Refresh points: `session_start`, `session_tree`, `/timestamps footer on`, and during a run every hook that follows a save: `message_start`, `context`, `tool_execution_start` (after pi saves the assistant reply that called the tool), `turn_end`, and `agent_settled` (after the final save and after pi saves shell results deferred during the run). `message_end` is not a refresh point: it runs before the save. Row 1 reads as: the refresh at `context` shows the prompt's saved time before the first model request, each saved reply and tool result moves the status, and the refresh after the final reply's save is "the end of the run".
- `/timestamps footer off` clears the status at once.
- Behavior follows the delivered message, not the slash prefix. A local command that delivers no message (`/timestamps`) leaves the status alone. A slash prompt template (the shipped `/elevator`) expands into a delivered user prompt and moves the status like any prompt.
- A `!` shell result is a counted message. Issued during a run it is saved just before `agent_settled` and that refresh shows it. Issued while idle it is saved with no extension hook after it (`core/agent-session.js:3286-3306`), and so is a custom message another extension saves while idle without starting a turn (`core/agent-session.js:1985-1990`, session listeners only). The status shows either one at the next refresh point: the next prompt, `/tree`, `/timestamps footer on`, or session start.
- During a run, another extension can queue several custom messages for the end of the turn with `sendMessage(..., { triggerTurn: false })`. Pi saves them in one batch after `turn_end`, notifying session listeners but not extension handlers (`core/agent-session.js:849-855,1973-2002`). At the next refresh, the footer shows only the newest message's time. The extension adds no timer or polling.

### Transcript lines

- A line is a session record written with `pi.appendEntry("message-timestamp")`, no payload. Pi stamps the entry time and projects no `custom` entry into model context. `pi.sendMessage` and `custom_message` are not used.
- Prompt line: tracked per delivered user message, not by the session leaf. `message_end` for a `user` message marks one prompt line pending. The pending line is flushed once, with one append while the transcript switch is on, at the first hook after that prompt's save and before the next sibling is saved or displayed: the next `message_start` (a later prompt in the same batch, a saved `nextTurn` message, a `before_agent_start` handler message) or, for the last pending prompt, `context`. The flush clears the pending mark, so later `context` calls in the same tool loop, and a retry, write no second prompt line. The `context` handler returns nothing and never edits the message list.
- Settle line: in the `agent_settled` handler, with the transcript switch on, append one record, whether or not the run was aborted. One settle line per settled run: a provider-stall-watchdog re-drive is a second run and gets its own settle line.
- Only records on the selected branch show. After `/tree` to a run's final reply, that reply is the leaf and its settle record, a child of the reply, is off the branch.
- Keep the saved shell result before the settle record. Pi flushes deferred shell output to live chat after extension settle handlers return; do not delay the record with a timer.
- Renderer: `pi.registerEntryRenderer("message-timestamp", ...)` returns `new Text(theme.fg("dim", formatTime(new Date(entry.timestamp))), 1, 0)` while the transcript switch is on and `undefined` while it is off. The same renderer serves live insertion and replay, so a resumed line shows its original time.
- Row 17 reads as: after `/timestamps transcript off` no trigger appends; after `on` the next prompt that reaches the model and the next settle append.
- Row 2's "for example the pruner status" is an example; the test uses a second status under another key.

### Command

`/timestamps [footer|transcript] [on|off]`. `parseArgs(args)` returns one of: status (empty or whitespace-only arguments), set (`footer on`, `footer off`, `transcript on`, `transcript off`), or usage (anything else, including a target with no value). The handler:

- outside the terminal UI: returns at once, before any notification, switch change, or settings read;
- usage: notifies `Usage: /timestamps [footer|transcript] [on|off]` at warning level and changes nothing;
- set: changes that one switch, refreshes or clears the footer status for the footer switch, then reports;
- status and set both report `Message timestamps: footer <on|off>, transcript <on|off>` through `ctx.ui.notify`.

### Documentation edits

- `README.md` Architecture table (`README.md:65-73`): one row, `extensions/message-timestamps.ts` | `/timestamps` | both displays, footer ON by default, transcript lines OFF by default.
- `README.md` settings: a `messageTimestamps` section beside the other per-extension settings sections with a two-row table (`footer` `true`, `transcript` `false`), the `/timestamps` forms, the session-only rule, the terminal-UI-only rule, which saved items move the footer time (every saved message, shell results and saved custom messages included; not the time lines), the idle rule (a shell result or custom message saved while pi is idle moves the footer time at the next prompt, `/tree`, `/timestamps footer on`, or session start), the trust rule (a project `.pi/settings.json` applies only when pi trusts the project), and the redraw rule from `## Errors and edge cases` (Ctrl+O hides a drawn line, only a rebuild such as `/tree` reveals a stored one, `/reload` and session replacement reapply `settings.json`).
- `README.md:21`, `:36`, `:86`, `:146-148`: each statement that splits extensions into active-without-setup and opt-in names the footer time as active without setup and the transcript lines as opt-in.
- `AGENTS.md:3`: `message-timestamps` joins the shipped list, and "everything except `fetch` and `doc_to_md` is OFF by default" also excepts the `message-timestamps` footer time.
- `CHANGELOG.md`: a new `## Unreleased` heading above `## v6.16.4 - 2026-11-19` with one bullet for the extension ending `(#44)`.

### Paid or external actions

None. The tests script the model in process. Approving this spec authorizes no outside call.

## Errors and edge cases

- A `footer` or `transcript` value that is not a boolean is ignored in its settings layer: the last valid layer stays in effect, and the built-in default applies only when no layer supplies a valid value. Global `transcript: true` with a non-boolean project value resolves to `true`.
- Known limitation: a global `settings.json` that starts with a byte order mark. Pi strips the mark before parsing (`core/settings-manager.js:269`); the shared reader `readSettings` does not and returns nothing for that file (`lib/settings-core.ts:18-24`). Its values still reach the switches through pi's merged settings, so the file works on its own. They are lost only where a later layer holds a non-boolean value for the same switch: global `transcript: true` in such a file under a trusted project's non-boolean `transcript` resolves to `false`, not `true`. The gap belongs to the shared reader, which this change does not alter, and every extension that reads `quiver.*` settings shares it.
- Bad `/timestamps` arguments print the usage line and change nothing. Outside the terminal UI the command returns silently: no notification, no switch change, no settings read.
- Interrupted run (Esc): the settle line is still written; the footer shows the last saved message, not the prompt.
- Behavior follows the delivered message, not the slash prefix. A local command that delivers no message (`/timestamps`) writes no line and leaves the footer alone. A slash prompt template (the shipped `/elevator`) expands into a delivered user prompt and uses the normal triggers of both displays. A `!` shell command delivers no prompt and writes no line; its saved result is a counted message for the footer.
- A prompt queued during a run gets its own prompt line when it is delivered. Several prompts delivered in one batch each get their own line, directly after their own prompt. The run ends with one settle line.
- A message pi saves right after the prompt (a pending `nextTurn` message, a `before_agent_start` handler message) does not suppress or displace the prompt line: the line is flushed before that message is saved.
- An entry another extension appends between a prompt's save and the flush sits between the prompt and its line; the line is still written.
- A retry after a provider error writes no second prompt line: the pending mark was cleared at the first flush.
- One settle line per settled run. With `provider-stall-watchdog` on, a stalled run settles and the re-drive settles again: one prompt line and two settle lines for that prompt.
- Only records on the selected branch show: after `/tree` to a run's final reply, its settle line is not shown.
- A deferred shell result can appear below the settle line live and above it on replay; both show the same stored time.
- Transcript switched on mid-run: a settle line with no prompt line. Switched off mid-run: no settle line.
- Redraw rule. After `/timestamps transcript off`, a drawn line disappears at pi's next redraw of it (Ctrl+O) or rebuild (`/tree`). After `/timestamps transcript on`, a stored line that was omitted when the chat was built is not mounted, so Ctrl+O cannot reveal it; it appears only when pi rebuilds the transcript (`/tree`). `/reload` and session replacement (resume included) reapply the `settings.json` values, not the live `/timestamps` value. The command forces no redraw. This replaces the ticket's "stay as drawn until the next resume" (see `## Problem`).
- `/reload` and in-TUI session replacement re-run the extension factory, so both switches return to the `settings.json` values of the session being shown, as `/fast` does.
- Narrow terminal: pi truncates the shared status row; the extension does not replace the footer.
- The live footer and the resumed footer show the same saved entry time for the same message, however long other extensions' `message_end` handlers delay the save.
- No pi version guard: the repo states no minimum and every hook used predates pi 1.0.

## Tests

All in `test/message-timestamps.test.ts` unless a line names another file. Session tests drive pi's real `createAgentSession` with a scripted model and a recording `setStatus` sink, the harness shape of `test/provider-stall-watchdog.test.ts:1019-1024`. Footer tests call pi's exported `initTheme()` and back `FooterComponent` with a Map-backed `ReadonlyFooterDataProvider` fake fed by the recorded statuses. The dim assertion uses a theme stub that records the `fg` color argument the transcript renderer passes; `mock.timers.enable({ apis: ["Date"] })` fixes the clock where a line compares times. Each scripted model call records the messages it received.

Acceptance rows:

- Row 1: no settings, a prompt sets the status to the prompt's saved entry time before the first model request and the final reply sets it again - `footer follows the prompt and the final reply`
- Row 2: with a second status present, pi's `FooterComponent.render` returns the same row count with the footer switch on and off, and the status row contains both texts - `footer shares the status row`
- Row 3: with no other status, `FooterComponent.render` returns exactly one more row than with the footer switch off - `footer adds one row when alone`
- Row 4: a file session reopened with `SessionManager.open` shows the newest counted message's saved time after `session_start`, before any prompt - `resume shows the newest message time`
- Row 5: after `navigateTree` to an earlier branch the status equals that branch's newest counted message time - `tree navigation updates the footer`
- Row 6: a session with no messages gets `setStatus(key, undefined)` and no text - `empty session shows no time`
- Row 7: `footer: false` in `settings.json` leaves no status after a full turn - `footer off in settings shows no status`
- Row 8: no settings, a completed turn leaves no `message-timestamp` entry and the renderer is never given one - `default writes no record`
- Row 9: transcript on, a run with three tool calls leaves exactly two `message-timestamp` entries, in the branch order prompt, record, replies and tool results, final reply, record, and the renderer returns a one-row `Text` for each with the recorded `fg` color `dim`. In the same run the clock advances so each save falls in a different display minute: the shared status read after a saved tool result and before the final reply shows that tool result's time, not the prompt's, and `/timestamps footer off` then `footer on` at that point gives the same time - `multi-tool run writes two records in order`
- Row 10: reopen the session and compare both stored times and their positions relative to the prompt and replies. With deferred shell output, assert the host-specific live order and shell-first replay - `resume replays records with original times`.
- Row 11: every message list the scripted model received during the multi-tool run, and during the first turn after reopening, holds no `custom` entry and no formatted time text - `no record reaches the model`
- Row 12: transcript off, a reopened session holding stored records gets `undefined` from the renderer for each, and a new turn adds no record - `transcript off hides stored records and writes none`; the absence of a blank row for an `undefined` return - none: host behavior at `modes/interactive/interactive-mode.js:3242-3250`
- Row 13: both switches on, one turn plus a `/timestamps footer off` call in each of `print`, `json`, and `rpc` leaves no record, makes no `setStatus` call, sends no notification, changes no switch, and reads no settings file - `non-tui modes are inert`; a live subagent run - none: pi-cohort children run `--mode json -p`, covered by the json case
- Row 14: each of the four set forms changes one switch and leaves the other, with no new session - `command toggles one switch`
- Row 15: bare `/timestamps` and every set form notify `Message timestamps: footer <state>, transcript <state>` - `command reports both switches`
- Row 16: `/timestamps footer off` clears the status in the same call; `footer on` sets it to the newest counted message time in the same call - `footer toggle applies immediately`
- Row 17: `transcript off` then a turn adds no record; `transcript on` then a turn adds two - `transcript toggle applies from the next message`
- Row 18: `settings.json` is byte-identical after every command form, and a new session started afterwards has the `settings.json` values - `command never writes settings`
- Row 19: README content - none: prose, checked against the diff at conformance
- Row 20: CHANGELOG `## Unreleased` bullet - none: prose, checked against the diff at conformance

Design, error, and edge clauses:

- `formatTime(new Date("2026-11-19T14:59:00Z"), "en-US", "UTC")` is `Nov 19, 02:59 PM` - `formatTime renders date and time`
- `parseArgs` returns status for empty input, set for the four forms, usage for everything else including `footer` alone - `parseArgs accepts five forms`
- Non-boolean `footer` or `transcript` settings are ignored per layer: with no valid layer the defaults apply, and global `transcript: true` with a non-boolean project value resolves to `true` - `test/extension-config.test.ts`, `timestamp settings keep only booleans from each layer`
- A global settings file that starts with a byte order mark - none: a known limitation of the shared reader, recorded in `## Errors and edge cases`
- `newestMessageTime` counts `bashExecution` messages and `custom_message` entries, skips `custom` entries (the `message-timestamp` records included), and returns `undefined` for a branch with no counted message - `newestMessageTime counts every saved message`
- Bad arguments notify the usage line and change neither switch - `command rejects bad input`; the command outside the terminal UI - covered by `non-tui modes are inert`
- An aborted run leaves one prompt record and one settle record, and the footer equals the last saved counted message's time, not the prompt's - `aborted run still writes the settle record`
- A prompt queued during a run gets its own prompt record and the run ends with one settle record; several prompts delivered in one batch, and a prompt followed by an injected `before_agent_start` message, each leave one record directly after their own prompt, live and after reopening, with no duplicate after a retry - `queued prompt gets its own record`
- A scripted provider error followed by pi's retry leaves one prompt record - `retry writes no second prompt record`
- With another extension's `message_end` handler delaying the save under a controlled clock, the live status after the final save equals the status after reopening the session, for the same entry - `footer shows the saved entry time`
- Behavior by delivered message, not slash prefix - none: an expanded prompt template is an ordinary delivered prompt (rows 1 and 9), and a handled command returns before any run (`core/agent-session.js:1702-1710`)
- One settle line per settled run, a watchdog re-drive included - none: the handler appends once per `agent_settled`, held by `multi-tool run writes two records in order`; the re-drive is a second host run
- Only records on the selected branch show - none: pi's branch selection owns it
- Transcript switched on between the prompt and the settle leaves one record; switched off leaves the prompt record only - `mid-run toggle`
- A record mounted while the switch is on renders nothing on its next redraw after the switch goes off - `mounted line hides on redraw`
- A record replayed while the switch is off is not mounted; after the switch goes on a redraw of mounted lines does not show it and a full rebuild does - `omitted line appears only on rebuild`
- Replay before `session_start` uses the destination session's settings: for `/resume` and for `/reload`, with the launch project and the session project holding opposite `transcript` values, in both directions, the first replay shows the stored lines exactly when the session project's value is `true`; with an untrusted session project whose project layer sets `transcript: true` over a global `false`, the first replay shows no stored line and `/timestamps` then reports `transcript off` - `replay before session_start uses the destination settings`
- A fresh factory load plus `session_start` restores the `settings.json` values after a command changed them - `command never writes settings`
- `messageTimestamps` keys are registered - `test/extension-config.test.ts`, the new registry case
- Narrow-terminal truncation - none: pi's footer owns it
- No version guard - none: nothing to observe

## Documentation impact

Bar and template: `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (operations / tunable parameters: the `quiver.messageTimestamps` switches, their defaults, and `/timestamps`; architecture: the extension row and the active-without-setup statements); `CHANGELOG.md` (major procedures / conventions: the release flow promotes `## Unreleased`)
- Derived / memory docs invalidated: `AGENTS.md` intro sentence at `AGENTS.md:3` (shipped-extension list and "everything except `fetch` and `doc_to_md` is OFF by default")

## Out of scope

- Redrawing the transcript when a switch changes; a stored line follows the switch only at pi's own next redraw or rebuild of it.
- A per-entry memo that would keep already-drawn lines fixed until the next resume (the ticket's stated behavior, corrected in `## Problem`).
- A separate elapsed-duration display.
- A footer status or records in `rpc`, `json`, or `print`.
- Replacing pi's footer, or any workaround for a truncated status row.
- Persisting a `/timestamps` change to `settings.json`.
- A today/older format distinction or a timer that refreshes the footer.
- A pi version guard or feature detection.
- Copying code from the gist.
- Stripping a byte order mark in the shared settings reader (`lib/settings-core.ts`). It is a known limitation and no follow-up is tracked.

## Open questions

None.
