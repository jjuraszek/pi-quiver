# Herdr tab-name sync for session-name

Extend the `session-name` extension so the session name also drives the Herdr
tab label, alongside the existing Ghostty tab title. Verified against herdr
0.8.2 (socket protocol 20) live in this workspace.

## Problem

Under Herdr, the existing Ghostty OSC 2 write is inert for the tab bar: Herdr
stores OSC 0/2 titles as the server-owned, ephemeral `terminal_title` field
("the latest OSC 0/2 title after safety normalization", socket-api docs),
which never becomes the tab label, and no config key derives one from the
other (checked against the herdr 0.8.2 config reference: `ui.window_title`
templates only the outer terminal's title; `ui.sidebar.agents.rows` has no
`title` token). Tabs stay on numeric defaults (`1`, `2`), indistinguishable
when many tabs share a space. Herdr exposes `tab.rename` over its unix
socket; the pane env provides `HERDR_TAB_ID` and `HERDR_SOCKET_PATH`
directly.

Pane metadata (`pane.report_metadata` `title`) was considered and rejected:
it is invisible in the default UI (no `title` token in the default
`ui.sidebar.agents.rows`; probe-verified live - setting/clearing it changed
nothing on screen).

## Herdr tab-label model (verified, load-bearing)

- RPC envelope: request `{id: string, method, params}` newline-terminated;
  success `{id, result: {type: "tab_info", tab: TabInfo}}` for
  `tab.get`/`tab.rename`; `tab.list` returns
  `{result: {type: "tab_list", tabs: TabInfo[]}}`; errors are
  `{id, error: {code, message}}`. Implementations read `result.tab` /
  `result.tabs` - never a flattened `{label, number}`.
- `TabInfo.number` is a **stable creation-time counter**; the *displayed
  default label* of an unnamed tab is its **live 1-based position** among its
  workspace's tabs (`custom_name.unwrap_or(tab_idx+1)` in herdr source),
  recomputed on close/reorder. `number` and the default label diverge after
  any tab closes. Default detection must therefore use the tab's index in
  `tab.list` (filtered to `workspace_id`, list order), not `number`.
- `tab.rename` unconditionally sets a custom name. The API has **no
  clear-to-auto primitive** (methods: tab.create/list/get/focus/rename/move/
  close). "Restore" can only write a numeric string that *looks* like the
  default; the tab remains custom-named internally and will no longer
  renumber on future closes/reorders. Accepted limitation, documented in the
  README caveat.

## Design

### New module: `lib/herdr-tab.ts` (pi-free)

Pi-free core module. `test/layout.test.ts` currently hardcodes pi-free
import checks only for `fetch-core.ts` and `doc-to-md-core.ts`; the
implementation **adds a third check** ("herdr-tab core imports no
`@earendil-works` packages"). Exports:

- `isHerdrActive(env, isTTY)`: `env.HERDR_ENV === "1"` and `HERDR_TAB_ID`
  and `HERDR_SOCKET_PATH` non-empty, and `isTTY` true. The extension
  additionally gates on `ctx.mode === "tui"`, threaded from the call sites (same
  boundary Herdr's own pi integration uses): the TTY check alone blocks
  pi-cohort background subagents (spawned with `env: {...process.env}` and
  piped stdio, pi-cohort `src/runs/background/subagent-runner.ts:243-250`),
  but a `pi -p` run from an attached terminal can still report a TTY - the
  mode check closes that hole. Windows: `HERDR_ENV` unset means inactive.
- `herdrRequest(socketPath, method, params, timeoutMs = 1500)`: one-shot
  newline-delimited JSON RPC over `node:net` - connect, write
  `{id, method, params}\n` (string `id`), read one line, parse, destroy.
  On win32, prefix the socket path with `\\.\pipe\` at connect time (same
  mapping as Herdr's own integration). Every failure mode (ENOENT,
  ECONNREFUSED, timeout, `{"error":...}` response, malformed line) resolves
  `null` - a dead or wedged Herdr must never break a session. No retry
  loop: calls fire at session/turn boundaries; the next turn is the retry.
- `getTab(socketPath, tabId)`: `tab.get` -> `result.tab` (`TabInfo`) or
  `null`.
- `listTabs(socketPath)`: `tab.list` -> `result.tabs` or `null`.
- `renameTab(socketPath, tabId, label)`: `tab.rename` with
  `{tab_id, label}` -> `true` on success, else `null`.

No CLI spawn, no PATH dependency, no dependency on the Herdr-managed
`herdr-agent-state.ts` file (shared wire protocol only; that file is
overwritten on reinstall and is never imported).

### Config

New key `herdrTab: boolean`, default `true`, beside `ghosttyTab` in the
existing `quiver.sessionAutoName` object, resolved via `lib/extension-config.ts`
layering. The `coerce` function (`extensions/session-name.ts:77-97`) is
**extended**: the boolean-shorthand branch sets `herdrTab: raw` (today it
returns only `{enabled, ghosttyTab}`), and the object branch reads
`o.herdrTab`. Without this, `"sessionAutoName": false` would leave the
default `herdrTab: true` live for the manual `/session-name` command. The
extension as a whole stays OFF by default (`enabled: false`).

### Write path and claim-once state machine

Ordinary Herdr writes flow through `syncHerdrTab(cfg: Config, label: string, mode)`; the shutdown
restore runs through `restoreHerdrTab`, both sharing one install-scoped chain.
`label` is the **curated tab label** (`currentTabLabel`, i.e.
`toTabLabel(applyDenyList(...))` - the exact string the Ghostty sink writes),
so both sinks always show the same text. Call sites and gating:

- `setName` (`extensions/session-name.ts:454-467`): becomes async; awaits
  `syncHerdrTab` after the Ghostty write. Gated on `cfg.herdrTab` only
  (matches Ghostty's `cfg.ghosttyTab`-only gate there - the manual
  `/session-name` command works even when `enabled: false`).
- `turn_start` handler (`:543-545`): awaits `syncHerdrTab` gated on
  `cfg.enabled && cfg.herdrTab`, **not** inside `syncTab` (whose first line
  returns on `!cfg.ghosttyTab`, which would tie Herdr to the Ghostty
  toggle). The sinks stay fully independent: `ghosttyTab: false,
  herdrTab: true` and the inverse both work.
- `session_shutdown`: awaits the restore (below).

**Serialization:** `syncHerdrTab` chains on an install-scoped in-flight promise
(each call awaits the previous one). Overlapping `setName`/`turn_start`/
shutdown syncs would otherwise interleave read and write, mis-read a label
mid-rename, and falsely back off.

Per-session in-memory state:
`herdrClaim: { lastWritten: string } | "backed-off" | null`.

1. **`null` (unclaimed)** - first sync: `listTabs()`, find our
   `HERDR_TAB_ID`, compute its 1-based position among tabs with the same
   `workspace_id` in list order.
   - `label === String(position)` (the live default) -> claim:
     `renameTab(label)`, set `lastWritten`.
   - Anything else -> a human (or a crashed predecessor) named it: set
     `"backed-off"`. One read, zero writes, terminal for the session.
   - `listTabs` returned `null` -> abort; retry next sync, still unclaimed.
2. **Claimed** - each sync: `getTab` first.
   - `null` (transient failure) -> abort this sync, **stay claimed** (a
     failed read is not a human rename).
   - Live label `!== lastWritten` -> human intervened -> `"backed-off"`
     (their label wins, no restore).
   - Else if the curated label changed, `renameTab` and update
     `lastWritten`; if unchanged, skip the write (steady-state turn cost:
     one local-socket read).
   - `renameTab` returning `null` leaves `lastWritten` unchanged; an
     indeterminate timeout (write applied but ack lost) self-heals on the
     next sync's read: the live label equals the value we attempted, which
     differs from `lastWritten`, -> back-off. Accepted as a rare, safe
     failure direction (never clobbers, at worst stops syncing).
3. **`"backed-off"`** - no reads, no writes.

An empty/absent name never writes (matches Ghostty). External renames via
`session_info_changed` reach Herdr the same way they reach Ghostty today: on
the next `turn_start` re-assert (the handler only calls `setName` directly
when a deny-rule rewrites the name). Claim-once has deliberately no Ghostty
counterpart: OSC is write-only, so the Ghostty sink stays unconditional.

**Claim race (accepted):** `tab.get`/`tab.list` then `tab.rename` is not
atomic and Herdr has no compare-and-set. Two sessions claiming the same tab
simultaneously can both pass the default check once; the loser detects the
foreign label on its next sync and backs off. Window is one turn boundary,
worst case is a one-turn label flap, self-healing. No `pane_count` guard
needed.

### Restore on shutdown

On `session_shutdown` - **every** reason (`quit`/`reload`/`new`/`resume`/
`fork`; `SessionShutdownEvent` in
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:464-469`,
handlers awaited, SIGHUP reaches graceful teardown via
`interactive-mode.js:3202-3206`): if claimed and the live label (fresh
`getTab`) equals `lastWritten`, **recompute** the tab's current default
(`listTabs` position, as at claim time - the position may have changed since)
and `renameTab` to that string; otherwise leave the tab alone. Shutdown calls
use `timeoutMs = 500`; worst case a wedged Herdr adds ~1.5s (three calls) to
quit - the bound, not "never stalls". Restoring on every reason keeps
claim-once sound for successor sessions in the same pane (`/new`, resume):
they find a label matching the live position and claim cleanly. The restored
label is internally a custom name (no clear-to-auto API); it looks identical
but will not renumber on future tab closes - accepted, in the README caveat.
A hard crash (`kill -9`) leaves a stale label; the successor backs off and
recovery is a manual rename. No durable state, no marker files.

### Edge cases

- **Multiple pi sessions, one tab (split panes):** first claimer wins; the
  second reads a non-default label it did not write and backs off (or loses
  the claim race above and backs off one turn later).
- **Tab closed / pane moved:** RPC error -> `null`; `HERDR_TAB_ID` is stale
  by design (pane moves mint new IDs). Syncs abort harmlessly; do not chase
  the pane.
- **Label collisions across tabs:** accepted, no dedupe/suffix machinery.
- **Background subagents:** blocked by the TTY gate (piped stdio).
  **`pi -p` / json / rpc modes:** blocked by the `ctx.mode === "tui"` gate.

### Out of scope

Pane metadata `title` / `display_agent`, sidebar row configuration, label
dedupe or suffixing, durable claim markers, Herdr event subscriptions
(`tab.renamed`), `client.window_title.set`, upstream Herdr API changes
(compare-and-set rename, clear-to-auto), and any change to the Ghostty
sink's semantics.

## Testing

Unit tests in `test/session-name.test.ts` plus `lib/` coverage, existing
`node --test` conventions:

- `isHerdrActive` gating table: each env var missing, `HERDR_ENV !== "1"`,
  no TTY -> false; all present + TTY -> true (mirrors the `isGhosttyActive`
  matrix, `test/session-name.test.ts:408-419`). Mode gating covered via the
  hook harness (non-`tui` ctx never dispatches a sync).
- Claim-once state machine against a **fake socket server**
  (`net.createServer`; on win32 listen on a `\\.\pipe\...` name, matching
  the production mapping - CI runs ubuntu + windows) speaking the real
  envelope (`result.tab` / `result.tabs`, string ids): claim on
  position-default label; back-off on non-default first read; back-off on
  mid-session external rename; steady-state no-op when the curated label is
  unchanged; **stay-claimed on `null` read**; restore-to-recomputed-position
  on shutdown when live label matches `lastWritten`; no restore when it
  differs; overlapping syncs serialize (no interleaved read/write).
- `herdrRequest` transport: timeout, error response, malformed line - each
  resolves `null`.
- Config coercion: boolean shorthand sets `herdrTab`; object branch reads
  it; `ghosttyTab: false, herdrTab: true` and the inverse drive exactly one
  sink each.
- `test/layout.test.ts`: new hardcoded check that `lib/herdr-tab.ts` imports
  no `@earendil-works` packages.

**Real-process smoke test (required by the user, manual, not under CI):**
against an isolated named Herdr session - each named session has its own
state dir and socket (`~/.config/herdr/sessions/<name>/herdr.sock`), fully
sandboxed from `default`. Boot/teardown recipe (verified live end-to-end):

```bash
# boot (scrub HERDR_* - env HERDR_SOCKET_PATH silently overrides HERDR_SESSION,
# observed live; forgetting this talks to the user's real session)
env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_TAB_ID -u HERDR_PANE_ID \
    -u HERDR_WORKSPACE_ID -u HERDR_BIN_PATH \
    script -q /dev/null herdr session attach pq-smoke &   # pty wrapper
SOCK=~/.config/herdr/sessions/pq-smoke/herdr.sock
# discover the tab id:
env -u HERDR_SOCKET_PATH HERDR_SESSION=pq-smoke herdr tab list
# drive: run pi (TUI, this repo's extension) inside a pty with
#   HERDR_ENV=1 HERDR_TAB_ID=<id from list> HERDR_SOCKET_PATH=$SOCK
# assert after each step with:
env -u HERDR_SOCKET_PATH HERDR_SESSION=pq-smoke herdr tab list
# teardown
env -u HERDR_SOCKET_PATH herdr session stop pq-smoke
env -u HERDR_SOCKET_PATH herdr session delete pq-smoke
```

Run as **separate scenarios** (back-off intentionally prevents restore, so
one run cannot verify both): (a) claim + rename visible in `tab list`, then
clean quit -> label back to the position default; (b) mid-session
`herdr tab rename` by hand -> extension backs off, label survives quit.
Re-assert no-op evidence: with the fake-socket unit test, not the smoke run
(`tab list` cannot prove absence of a request).

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` session-name section
  (`herdrTab` key, claim-once + restore semantics, crash-stale-label caveat,
  restored-label-is-custom caveat); `CHANGELOG.md` entry
- Derived / memory docs invalidated: `AGENTS.md` session-name one-liners
  (repo intro + Layout comment: "Ghostty tab rename" -> "Ghostty/Herdr tab
  rename")

## Open questions

None. All design decisions were resolved in the questionary (surface,
ownership, dedupe, gating, restore, transport) and verified against the live
herdr 0.8.2 socket API; the spec council's blockers (RPC envelope nesting,
position-based default labels, no clear-to-auto primitive) are incorporated
above.
