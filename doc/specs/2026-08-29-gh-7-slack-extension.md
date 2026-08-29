# Slack extension: context-safe search, threads, and posting (gh-7)

Ticket: https://github.com/jjuraszek/pi-quiver/issues/7
Depends on: gh-8 nested `quiver.*` settings root (shipped, `24a20db`; contract in
`doc/specs/2026-08-29-gh-8-quiver-settings-root.md`).

## Problem

pi has no native Slack access. Consumer repos each hand-roll token handling,
name->ID resolution, pagination, and posting mechanics; the transactional
headline+thread announce protocol (which must never re-post a headline) exists in
one repo's script and is unusable by others. Search results and long threads are
unbounded inputs - the same context-safety concern `fetch`/`doc_to_md` already
gate. An always-on Slack toolset would pollute every session's system prompt in
repos that never touch Slack.

## Goal

One opt-in, default-off `slack` extension exposing the full message-lifecycle
tool surface with dual-identity tokens (user + bot), a configurable name->ID
cache with a user-scope default, fetch-style size gating, and a transactional
headline+threaded-detail post with recovery. House policy (channel conventions,
tone, stricter length rules, identity conventions) stays out; consumer repos
layer thin proxy skills over these tools. This gives both existing consumer
implementations a near-mechanical migration path: their skills keep the policy,
the plumbing moves here.

## Architecture

TypeScript throughout - no Python, no shell. Three new files, mirroring the
fetch/doc_to_md adapter-over-core split:

- `extensions/slack.ts` - thin adapter and the only pi entry point. On
  `session_start` it resolves `quiver.slack`; if `enabled` is not `true` it
  registers nothing (zero tools in the system prompt, no `.env` read, no
  network, no cache I/O). If enabled, it registers the eight `slack_*` tools,
  each a small TypeBox schema + `renderCall`/`renderResult` wrapper delegating
  to the core. Toggling takes effect at the next session (registration-time
  gate, same convention as the other opt-in extensions). This is the first
  pi-quiver extension registering tools conditionally from a `session_start`
  handler; the runtime supports it (`registerTool` is callable from event
  handlers), but no in-repo precedent exists - the test plan covers it
  explicitly.
- `lib/slack-core.ts` - the data plane. All HTTP funnels through two injectable
  functions: `apiCall(method, token, params, {retry})` (POST to
  `https://slack.com/api/*`, form or JSON as the method requires, maps
  `ok:false` to structured errors; the single `Retry-After` retry happens only
  when the caller passes `retry: true` - retry policy is per-operation, not
  baked into the transport) and `uploadBytes(url, bytes)` (raw POST to a
  presigned upload URL). Every request runs with a 20s timeout (same value as
  fetch-core) and propagates pi's abort signal through calls and retry sleeps. Everything above the choke point is pure logic: identity/token
  resolution, search/thread shaping and size gating, the announce protocol,
  length pre-flight, pin/update/delete, upload orchestration. Uses the Node
  global `fetch`; no Slack SDK, no new runtime dependencies.
- `lib/slack-cache.ts` - name->ID resolution and cache persistence (see
  [Cache](#cache)).

A single discrete tool per verb (not one multiplexed `slack` tool with an
`action` discriminator): pi's convention is one tool = one typed schema, giving
per-verb validation and rendering. The multiplexed alternative is rejected.

## Configuration

All keys live under `quiver.slack`, nested-only - `slack` is never added to the
frozen `LEGACY_FLAT_KEYS`; a flat top-level `"slack"` key is silently ignored.
Boolean shorthand `"slack": true` under `quiver` means `{enabled: true}`.

| key | type | default | purpose |
|---|---|---|---|
| `enabled` | boolean | `false` | master switch; anything other than resolved `true` registers zero tools |
| `cachePath` | string | user cache dir, keyed by workspace | absolute, or repo-root-relative; parent dirs created on first write |
| `userTokenEnv` | string | `SLACK_USER_TOKEN` | name of the env var holding the user token |
| `botTokenEnv` | string | `SLACK_BOT_TOKEN` | name of the env var holding the bot token |
| `uploadThresholdChars` | number | `4000` | rendered-mrkdwn length above which `thread_body` becomes a threaded file upload |

Root discovery: "repo root" (for relative `cachePath` and `.env`) is
`git rev-parse --show-toplevel` from `ctx.cwd`, falling back to `ctx.cwd`
outside git. Settings resolution itself stays `ctx.cwd`-based - `resolveConfig`
is not modified.

### Resolution ladder

Per key, highest rung wins:

1. **Process env overrides**: `PI_QUIVER_SLACK_ENABLED`,
   `PI_QUIVER_SLACK_CACHE_PATH`, `PI_QUIVER_SLACK_USER_TOKEN_ENV`,
   `PI_QUIVER_SLACK_BOT_TOKEN_ENV`, `PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS`.
   Booleans parse `true`/`1`/`false`/`0`; numbers must parse as positive
   integers. A malformed value emits one deduped warning and the rung is
   skipped for that key.
2. **Repo**: `<repo>/.pi/settings.json`, `quiver.slack.{...}`.
3. **Pi-home**: `<getAgentDir()>/settings.json`, same shape.
4. Defaults (table above).

Rungs 2-4 are the existing `resolveConfig(cwd, "slack", defaults, coerce, warn)`
unchanged - per-field patch merge, project over global, warnings via
`ctx.ui.notify(m, "warning")`. The env rung is an overlay the slack extension
applies on top of `resolveConfig`'s result; the shared resolver is not modified.
`coerce` follows the boolean-or-object pattern: `undefined` for unrecognized
shapes (triggering the resolver's "unrecognized value; ignored" warning), a
partial patch otherwise; unknown subkeys are dropped silently (the gh-8
detectability boundary).

### Tokens

Token **values** ride a separate two-rung ladder and never appear in
`settings.json`:

1. `process.env[<configured env var name>]`.
2. Repo-root `.env`: line parse - optional leading whitespace, optional
   `export ` prefix, then exact `KEY=`; last match wins; one surrounding quote
   pair stripped; never shell-sourced. In a linked worktree whose own root
   lacks `.env`, the primary checkout's repo-root `.env` is consulted
   (worktrees share secrets with their source checkout); the primary checkout
   is discovered via `git rev-parse --path-format=absolute --git-common-dir`
   (its parent directory). If discovery fails, only the worktree root is
   consulted.

Identity is explicit everywhere it matters (`as: user|bot`). A missing token for
the requested identity is a hard per-call error naming the env var that was
empty - **never** a fallback to the other identity's token, and token values are
never logged or echoed in errors.

## Cache

Name->ID map (channels and users) keyed by Slack workspace.

- **Location**: single winning file - repo `cachePath` when configured
  (relative paths resolve against the repo root; may be git-tracked if the repo
  chooses); otherwise the per-OS user cache dir (same convention as
  `doc_to_md`'s managed venv), one file per workspace, keyed by team ID. The
  losing location is never read or merged. Team ID comes from `auth.test` on
  the calling identity's token (user preferred when both exist), memoized per
  token; `slack_cache_refresh` uses the user token when present, else the bot
  token. If both tokens resolve to different team IDs, tools error explicitly
  instead of mixing caches. No token at all is the standard per-call token
  error.
- **Format**: JSON - `{ team_id, channels: {name -> id}, users: {username ->
  {id, display_name, real_name}}, refreshed_at }`. Users are keyed by Slack
  username (unique per workspace); `@name` inputs match username first, then
  display name, then real name; an ambiguous display/real-name match is an
  error listing the candidate IDs, never a silent pick. JSON is chosen over the Markdown-table format some consumers
  use today because it is safer to parse and write atomically; migrating repos
  regenerate via `slack_cache_refresh` rather than importing old files. The
  format is an implementation detail of the extension, not a public contract.
- **Reads**: all tools resolve `#name` / `@name` / raw ID inputs through one
  shared resolution function against the winning file; raw IDs skip the cache
  entirely. `@name` is accepted only where a user is expected; a user name in a
  channel position is rejected (DM opening is out of scope).
- **Writes**: a cache miss triggers a live lookup - a client-side scan of
  paginated `conversations.list` / `users.list` until first match or
  exhaustion (the list APIs have no name filter); exhaustion is a
  `name_not_found` error. The lookup uses the calling identity's token. The hit
  is written back atomically: re-read the current file, merge the new key,
  write tmp, rename - so concurrently added entries are not dropped; a true
  simultaneous race remains last-writer-wins, accepted for an append-mostly
  map. Any tool that resolves names writes on miss - `slack_post` updates the
  cache as a side effect of resolution but does not own it.
- **Full refresh**: `slack_cache_refresh` regenerates the winning file from bulk
  paginated listings and replaces it atomically.
- **Staleness**: renamed channels resolve to the old ID silently until a refresh
  - documented limitation; the remedy is `slack_cache_refresh`.

## Tool surface

Eight tools, registered only when enabled. Each ships a one-line
`promptSnippet` (tools without one are omitted from the Available-tools prompt
section) and a self-sufficient `description` (verbs, `as` identity, name
forms, announce contract, throttle caveat). Mutating results echo `channel`
(ID), `ts`, and the API-derived permalink (`chat.getPermalink`, never hand-built);
deliberate exceptions: delete returns `{channel, ts}` (nothing left to link),
upload returns `{channel, fileId}` + the completed file's permalink (no message
`ts` in Slack's response). Follow-ups thus need no search. Mutation
success is authoritative: a `chat.getPermalink` failure degrades to a warning
field on the successful result, never a call-level error. All channel/user
parameters accept `#name`, `@name` (user positions only), or raw IDs. `blocks`
parameters accept a Block Kit JSON array passed through unvalidated - Slack's
own validation errors surface. Exact TypeBox schemas per tool are
implementation-plan territory; the contracts below are binding.

| tool | identity | behavior |
|---|---|---|
| `slack_search` | user (API constraint: `search.messages` accepts only user tokens) | query passed through in Slack's documented operator grammar (`in:#channel-name`, `from:@display-name` - names preserved, never rewritten to IDs; the search grammar is name-based); fetches a single page (`count` up to 100, optional `page` param - `search.messages` is offset-paginated, unlike the cursor-paginated `conversations.*`); result includes total/page counts; rendered compactly (author, channel, ts, permalink, text) and size-gated |
| `slack_thread` | user | input: channel+ts or a permalink (parsed); paginates `conversations.replies` by cursor until `has_more` is false or a cap of 50 pages / 5,000 messages; result carries a `complete` flag and the resumable `next_cursor` when capped; size-gated |
| `slack_post` | `as: user\|bot`, required | plain message (`text` and/or `blocks`), optional `thread_ts` to reply; announce mode iff `thread_body` is present AND `thread_ts` is absent (see [Announce protocol](#announce-protocol)); with `thread_ts` set no headline is ever emitted - `thread_body` (or `text`) posts as the reply body, upload fallback still applying |
| `slack_update` | `as` | `chat.update` on channel+ts; accepts `text` and/or `blocks`; only the posting identity can edit its own messages (Slack constraint, surfaced in errors) |
| `slack_delete` | `as` | `chat.delete`; same identity-bound ownership |
| `slack_pin` | `as` | `pins.add`; maps `already_pinned`/`not_pinnable`/`too_many_pins` |
| `slack_upload` | `as` | params: `channel`, `path` (absolute or cwd-relative file), optional `filename` (default: basename), `title`, `thread_ts`, `initial_comment`. Flow: `files.getUploadURLExternal` (`filename`, `length`) -> `uploadBytes` to the returned `upload_url` -> `files.completeUploadExternal` (`files: [{id: <file_id>, title}]`, single `channel_id`, optional `thread_ts` + `initial_comment`; Slack requires exactly one channel when threading; the complete call is one-shot) |
| `slack_cache_refresh` | user | full cache regeneration, atomic replace; reports counts |

`markdown_text` is rejected as a posting field: it cannot be combined with
`blocks` (which `slack_post`/`slack_update` must accept), so it would fork the
API surface for no capability gain.

### Size gating

`slack_search` and `slack_thread` reuse the fetch gate values: inline up to
32,000 bytes / 1,000 lines; larger output is written in full to a temp file
under `tmpdir()/pi-slack` (timestamped + hashed slug, never deleted by the
tool) with a bounded preview (60 lines / 4,000 bytes) + path inline. The
constants are defined in `slack-core` with the same values as fetch's - shared
principle, no cross-module coupling.

### Announce protocol

`slack_post` with `thread_body` (and no `thread_ts`) posts a headline and its
detail as a threaded reply in one call. This document is the authoritative
statement of the protocol; prior consumer implementations are historical
context only - divergences resolve in favor of this spec. Invariants:

- Pre-flight before any write: headline non-empty, single line, rendered mrkdwn
  length <= 4000 (hard error - announce headlines are short by design).
- Headline posts exactly once. The headline `chat.postMessage` is issued with
  `retry: false` - no auto-retry anywhere in the stack, because Slack may have
  accepted the post and a duplicate would notify twice. A transport-level
  failure after send (no response, hence no `ts`) returns a distinct
  `outcome_unknown` error: the composed detail is persisted to a temp file as
  in recovery, and the caller is told to check the channel before re-invoking.
- Detail posts as the first threaded reply. On failure: retry once honoring
  `Retry-After` (default 2s when absent) - this IS the single per-call
  `Retry-After` retry, exactly one retry total on the detail leg, no
  composition with the generic policy; if still failing, edit the headline
  (`chat.update`) to append the frozen marker ` _(detail pending)_`, persist
  the exact composed
  detail body to a temp file under `tmpdir()/pi-slack`, and return a structured
  error carrying the headline `ts`, channel, permalink, temp-file path, and the
  specific failure. If even the marker edit fails, say so in the result - the
  caller still has everything needed to recover manually.
- Recovery: a follow-up `slack_post` given `thread_ts` posts only into the
  existing thread - a second headline is never emitted (asserted in tests: no
  second headline call ever reaches the transport).
- `thread_body` rendered-mrkdwn length > `uploadThresholdChars` (default 4000)
  -> the detail is delivered as a threaded file upload instead: the frozen
  intro line `Detail attached.` posts as a threaded reply to the headline `ts`,
  and the upload (frozen filename `slack-detail.md`) attaches to the same
  thread, both under the call's `as` identity. 4000 is the binding number because `chat.update` hard-errors
  above it (`msg_too_long`) and the recovery path edits the headline;
  `chat.postMessage`'s 40,000 silent-truncate ceiling and the 12,000
  `markdown_text` limit are not the governing constraints.
- Length counting, in code terms: hard pre-flight checks (headline <= 4000)
  use raw UTF-16 `text.length` of the submitted string - the unit Slack's
  `msg_too_long` validates. The `uploadThresholdChars` gate uses a
  link-collapsed counter (each `<url|label>` counted as `label`, each bare
  `<url>` as one placeholder word) so permalink-heavy details are not
  needlessly bounced to files; a `msg_too_long` that slips through that gate
  falls back to the upload path at API-error time.
- The threshold logic applies only to `thread_body` (extension-composed plain
  mrkdwn). Caller-supplied `blocks` bypass upload-fallback logic entirely;
  Block Kit's own per-object limits (~3,000 chars per section text) surface as
  Slack API errors, not pre-flight checks.

## Error handling

- Every `ok:false` becomes a structured tool error with Slack's `error` code
  plus a mapped hint for common codes: `channel_not_found` ("check the name or
  run slack_cache_refresh"), `not_in_channel` ("invite the bot"),
  `missing_scope` (names the scope and the identity used), `msg_too_long`,
  `is_archived`, `edit_window_closed`, `already_pinned`, `not_pinnable`. No raw
  response dumps.
- **429**: for retryable operations (`retry: true`), honor `Retry-After` once
  per call, capped at 30s; a second 429 returns an error stating the wait so
  the caller decides. No unbounded retry loops. Exceptions: the announce
  headline is never retried; `slack_thread` does not retry on 429 (its
  `Retry-After` is ~60s, beyond the cap) - it returns the messages collected so
  far plus the throttle caveat and resumable cursor.
- **Thread throttle caveat**: since 2025-05-29, `conversations.replies` is rate
  limited to ~1 request/minute with `limit` capped at 15 for apps that are
  neither Marketplace-listed nor classified internal. `slack_thread` paginates
  correctly regardless; when pagination hits the throttle it surfaces the
  constraint in the result instead of spinning. The app-registration class is a
  workspace fact outside this extension's control; documented, not configured.
- **Length**: pre-flight on the rendered mrkdwn string, before any API call
  (headline > 4000 -> hard error; `thread_body` > threshold -> upload path).
  Plain `slack_post` text and `slack_update` are likewise hard-capped at 4,000
  client-side: `chat.update` errors above it anyway, and for plain posts the
  guard prevents Slack's silent 40,000-char truncation (accepted at ship,
  ex-G11); the error hints at `thread_body`/`slack_upload` for longer content.
- **Disabled vs tokenless**: disabled means the tools do not exist (no erroring
  stubs). Enabled-but-tokenless fails per call, per identity, naming the env
  var.

## Testing

All `node --test`, under `npm run test:all`; no live Slack calls in CI, ever.

- `test/slack-core.test.ts` - fake injected `apiCall`/`uploadBytes` recording
  calls and returning scripted responses. Ports the proven consumer test cases:
  identity selection and missing-token errors (no cross-identity fallback);
  announce happy path (headline then threaded detail); announce recovery
  (detail failure -> headline edited with marker, detail persisted to temp
  file, structured error carries ts+path, **no second headline call ever
  leaves the transport**, including on repeated invocation with `thread_ts` and
  on a recovery call passing both `thread_ts` and `thread_body`; frozen marker
  ` _(detail pending)_`, intro `Detail attached.`, and filename
  `slack-detail.md` asserted verbatim; headline transport failure without a
  response yields `outcome_unknown` with the detail persisted);
  `Retry-After` honored once then surfaced; length pre-flight (headline >4000
  rejected before any call; `thread_body` > threshold routes to the upload
  sequence: getUploadURLExternal -> bytes -> completeUploadExternal with
  thread_ts); `blocks` accepted on post and update; thread pagination across
  multiple cursor pages, incl. the 50-page/5,000-message cap returning
  `complete: false` + `next_cursor`; search result shaping and size gating
  (inline vs spill); `ok:false` mapping for the named codes; permalink failure
  degrading to a warning on a successful mutation; update/delete/pin
  round-trips.
- `test/slack-cache.test.ts` - configured repo `cachePath` is the single
  winning file (the user-dir file is never read when it is set); miss -> live
  lookup (client-side scan, `name_not_found` on exhaustion) -> atomic
  re-read+merge+rename write (concurrently added entries preserved, valid JSON
  after); `#name`/`@name`/raw-ID forms incl. the username/display/real-name
  precedence and the ambiguity error; two workspaces don't collide in the user
  cache dir; full refresh replaces atomically; relative `cachePath` resolves
  against repo root.
- `test/slack-config.test.ts` - table-driven ladder: env > repo > pi-home >
  default per key; partial layers merge per-field; boolean shorthand; flat
  top-level `slack` ignored; malformed env value skips the rung with one
  deduped warning; token env-var naming (values never read from settings);
  `.env` parsing (whitespace, `export ` prefix, quotes, last-match-wins) and
  the linked-worktree `.env` fallback; root discovery from a nested dir, a
  linked worktree, and a non-git dir. Uses the existing `PI_CODING_AGENT_DIR`
  + temp-project fixture pattern.
- **Registration gate** - a mock `ExtensionAPI` with a spy `registerTool`,
  invoking the extension factory and firing a synthetic `session_start`:
  `enabled` absent/false/object-without-enabled -> zero `registerTool` calls;
  `enabled: true` (and shorthand `true`) -> all eight registered. First
  conditional-registration test in the repo; the harness is part of this
  feature.
- **Manual smoke** (not CI): against a real test workspace/channel - post as
  user and bot, announce with oversized detail (upload fallback), update,
  delete, pin, search, thread, cache refresh. Checklist lives in `doc/slack.md`.

## Migration path (general terms)

Consumer repos with existing Slack scripts/skills migrate by: enabling
`quiver.slack` (repo settings), pointing `cachePath` at their preferred location
(or adopting the user-scope default and regenerating via `slack_cache_refresh`),
keeping their env var names or mapping them via `userTokenEnv`/`botTokenEnv`,
and rewriting their skills' script invocations as `slack_*` tool calls. House
policy (channels, templates, review gates, identity conventions) stays in those
repos' skills. No import of existing cache files is provided; refresh
regenerates.

## No skill ships

Tool descriptions are the discovery surface and must be self-sufficient (verbs,
`as` identity, name forms, announce contract, throttle caveat). `skills/` in
this repo is Claude Code plugin territory, invisible to pi. If real usage shows
models misusing the announce flow, a pi-visible skill can be added later.

## Documentation impact

- Feature / user-facing docs introduced: `doc/slack.md` (required by AC12) -
  tools, the nested `quiver.slack` opt-in knob and boolean shorthand,
  default-off + next-session toggling, two-token setup and why search needs a
  user token, the full config ladder incl. env overrides, cache layering and
  refresh, `search.messages` legacy status, the `conversations.replies`
  throttle caveat, the consumer proxy-skill pattern, manual smoke checklist -
  with no private consumer-repo internals.
- Materially amended existing docs: `README.md` (extension list + `quiver.slack`
  settings row, pointer to `doc/slack.md`), `CHANGELOG.md` (new entry).
- Derived / memory docs invalidated: `AGENTS.md` (extension list in the intro
  and `Layout` block gain `slack`; a `Workflow` bullet for the slack runtime
  boundary - conditional registration, token/cache resolution - mirroring the
  watchdog's bullet).

## Out of scope

- Consumer-repo migration work (re-pointing skills, enforcement tests, guard
  hooks) - happens in those repos.
- House-policy configuration (channel defaults, stricter length rules, identity
  conventions, mandatory review gates). `uploadThresholdChars` is Slack-API
  correctness, extension-owned - the one deliberate exception.
- Multi-page search aggregation: `slack_search` fetches one page per call and
  exposes pagination input; aggregating thousands of matches is a caller
  concern.
- Impersonation (`chat.write.customize`, `username`/`icon_url`) - `as` selects
  a token, nothing more.
- Marketplace/internal app registration detection - the replies-throttle class
  is documented, not sensed.
- Importing existing consumer cache-file formats.

## Open questions

- `search.messages` offset pagination (`page`/`count` semantics and their
  maxima) is a legacy-method surface; re-verify against current API docs at
  implementation time.
