# slack - Slack message lifecycle tools

Opt-in, default-off. Enable `quiver.slack` in `settings.json` and the next
session registers eight `slack_*` tools (search, thread reads, post/announce,
update, delete, pin, upload, cache refresh). Disabled - the default - means
zero tools in the system prompt, no `.env` read, no network call, no cache
I/O.

```json
{ "quiver": { "slack": true } }
```

`true` is shorthand for `{ "enabled": true }`; use the object form to set
other keys. A flat top-level `"slack"` key (outside `quiver`) is ignored.
Toggling `enabled` takes effect at the **next session** - registration
happens once, on `session_start`.

## Configuration

All keys live under `quiver.slack`:

| key | type | default | purpose |
|---|---|---|---|
| `enabled` | boolean | `false` | master switch; anything other than resolved `true` registers zero tools |
| `cachePath` | string | per-OS user cache dir, keyed by workspace | name->ID cache file location; absolute or repo-root-relative |
| `userTokenEnv` | string | `SLACK_USER_TOKEN` | env var name holding the user token |
| `botTokenEnv` | string | `SLACK_BOT_TOKEN` | env var name holding the bot token |
| `uploadThresholdChars` | number | `4000` | link-collapsed length above which an announce `thread_body` becomes a threaded file upload |

### Resolution ladder

Per key, highest rung wins:

1. **Process env overrides**: `PI_QUIVER_SLACK_ENABLED`, `PI_QUIVER_SLACK_CACHE_PATH`, `PI_QUIVER_SLACK_USER_TOKEN_ENV`, `PI_QUIVER_SLACK_BOT_TOKEN_ENV`, `PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS`.
2. Repo `.pi/settings.json`, `quiver.slack.{...}`.
3. Pi-home `settings.json`, same shape.
4. Defaults (table above).

Booleans parse `true`/`1`/`false`/`0`; the threshold must parse as a positive
integer. A malformed env value emits one deduped warning and that rung is
skipped for that key - the layer below still applies. "Repo root" (for
relative `cachePath` and for `.env` lookup) is `git rev-parse
--show-toplevel` from the session's cwd, falling back to the cwd itself
outside a git repo.

## Tokens

Two independent identities: **user** (a real person's token; needed for
`slack_search` and `slack_thread` because `search.messages` - a legacy Slack
API - accepts only user tokens, never bot tokens) and **bot** (an app
identity, selected on every mutating tool via `as: "user" | "bot"`).

Token *values* never live in `settings.json`. They resolve, per identity,
from:

1. `process.env[<configured env var name>]`.
2. Repo-root `.env` file: one entry per line, optional leading whitespace,
   optional `export ` prefix, exact `KEY=value`; last matching line wins; one
   surrounding quote pair (`'...'` or `"..."`) is stripped; the file is never
   shell-sourced. In a linked git worktree whose own root has no `.env` at
   all, the primary checkout's repo-root `.env` is consulted instead
   (discovered via `git rev-parse --path-format=absolute --git-common-dir`);
   if a worktree *does* have a `.env`, it fully shadows the primary one even
   if it lacks the needed key.

There is no fallback between identities - a missing user token is never
covered by a present bot token. A missing token is a hard per-call error
naming the empty env var. Token values are never logged or echoed back in
tool output or errors.

## Cache

Channel/user name->ID resolution is cached in a single JSON file per Slack
workspace (keyed by team ID from `auth.test`):

- **Location**: the configured `cachePath` (absolute, or resolved against
  the repo root; may be committed to the repo) if set, else the per-OS user
  cache dir (`%LOCALAPPDATA%\pi-quiver` on Windows, `~/Library/Caches/pi-quiver`
  on macOS, `$XDG_CACHE_HOME/pi-quiver` else), file named `slack-<team_id>.json`.
  Only this one location is ever read or written; the other is never touched.
- **Format**: `{ team_id, channels: {name -> id}, users: {username ->
  {id, display_name, real_name}}, refreshed_at }`.
- **Cross-token check**: best-effort - on each call, it runs only when the
  other identity's token resolves and authenticates; if so, its team ID is
  compared against the acting identity's team ID, and a mismatch errors
  `team_mismatch` instead of silently mixing two workspaces' caches. Any
  failure resolving or authenticating the unused identity's token (missing,
  expired, rate-limited, transport error, ...) never fails the acting
  identity's call - the check is simply skipped.
- **Miss path**: a cache miss triggers a live, paginated `conversations.list`
  / `users.list` scan (the list APIs have no name filter) up to 100 pages;
  exhaustion without a match errors `name_not_found`. A hit is written back
  with an atomic re-read + merge + tmp-write + rename, so concurrent misses
  don't clobber each other's entries (a true simultaneous race is
  last-writer-wins - accepted for an append-mostly map).
- **`slack_cache_refresh`**: regenerates the whole file from a full
  `conversations.list` + `users.list` scan and atomically replaces it. Uses
  the user token when one is configured, else falls back to the bot token.
- **Staleness**: a renamed channel/user resolves to its old ID silently until
  the next `slack_cache_refresh` - this is a known limitation, not a bug.

## Tools

All channel/user parameters accept `#name`, `@name`, or a raw Slack ID.
`@name` is accepted **only in user positions** - currently no tool exposes a
user-position parameter, so every `channel` parameter rejects `@name` inputs
outright (opening a DM is out of scope). `slack_post`, `slack_update`, and
`slack_pin` echo `channel` (resolved ID), `ts`, and an API-derived
`permalink` (via `chat.getPermalink`); a permalink lookup failure never
fails the call - it degrades to a `warning` field on an otherwise-successful
result. `slack_delete`'s result is just `{ channel, ts }` - there is nothing
left to permalink once the message is gone, which is deliberate: a deleted
message cannot be linked to, so this shape is the honest one, not a gap.
`slack_upload`'s result is `{ channel, fileId, permalink }` - `permalink`
comes from the completed file object when Slack returns one, degrading to a
`warning` (like the mutation tools above) rather than failing the call when
it's absent.

| tool | identity | params (sketch) | behavior |
|---|---|---|---|
| `slack_search` | always user | `query`, `count` (<=100), `page` | `search.messages` with Slack's operator grammar (`in:#chan`, `from:@name`); one page per call, size-gated output |
| `slack_thread` | always user | `channel`+`ts`, or `permalink`, optional `cursor` to resume | `conversations.replies`, cursor-paginated to completion or a 50-page/5000-message cap (returns `next_cursor` when capped); size-gated |
| `slack_post` | `as` | `channel`, `text`/`blocks`, optional `thread_ts`, optional `thread_body` | plain post, threaded reply, or announce (headline + threaded detail) - see below |
| `slack_update` | `as` | `channel`, `ts`, `text`/`blocks` | `chat.update`; only the original poster's identity can edit |
| `slack_delete` | `as` | `channel`, `ts` | `chat.delete`; same ownership constraint |
| `slack_pin` | `as` | `channel`, `ts` | `pins.add`; maps `already_pinned`/`not_pinnable`/`too_many_pins` |
| `slack_upload` | `as` | `channel`, `path`, optional `filename`/`title`/`thread_ts`/`initial_comment` | `files.getUploadURLExternal` -> upload -> `files.completeUploadExternal` |
| `slack_cache_refresh` | user if configured, else bot | none | full cache regeneration, reports channel/user counts |

## Announce protocol

`slack_post` with `thread_body` set and `thread_ts` **absent** triggers
announce mode: post a short headline, then post the detail as the first
threaded reply, in one call.

- **Pre-flight**: the headline (`text`) must be non-empty, a single line,
  and <= 4000 UTF-16 code units - checked before any network call.
- **Headline never retries**: the headline `chat.postMessage` is sent with
  no auto-retry, because a transport failure after send may mean Slack
  already accepted it - a retry could double-post a visible notification.
- **`outcome_unknown`**: a transport failure on the headline (or an
  `ok:true` response with an unparseable `ts`) returns `outcome_unknown`.
  The caller must check the channel manually and must **not** re-invoke -
  the composed detail is persisted to a temp file under
  `tmpdir()/pi-slack` so it is not lost.
- **Recovery**: re-invoke with `thread_ts` set to post only into the
  existing thread; a second headline is never sent on that path.
- **Detail-pending marker**: if the detail leg fails after its own single
  `Retry-After` retry, the headline is edited (`chat.update`) to append the
  frozen marker ` _(detail pending)_`, the detail body is persisted to a
  temp file, and a structured error names the headline `ts`/channel/permalink
  and the file path.
- **Oversized detail -> upload**: when the detail's *link-collapsed* length
  exceeds `uploadThresholdChars` (default 4000), it is delivered instead as
  a threaded reply with the frozen intro line `Detail attached.` followed by
  a file upload named `slack-detail.md` in the same thread.
- **Same gate on plain threaded replies**: this oversize->upload gate is not
  announce-only - a plain `slack_post` call with `thread_ts` set (a threaded
  reply, no headline involved) is checked against the same
  `uploadThresholdChars` link-collapsed length and falls back to the same
  upload delivery when it's exceeded.
- **Two length counters**: hard pre-flight checks (headline <= 4000, and the
  underlying `chat.postMessage`/`chat.update` MAX_TEXT_LENGTH assert) use
  raw UTF-16 `.length` - Slack's own `msg_too_long` unit. The
  `uploadThresholdChars` gate uses a link-collapsed counter (`<url|label>`
  counts as `label`, bare `<url>` counts as one placeholder word) so a
  permalink-heavy detail isn't needlessly bounced to a file; a `msg_too_long`
  that slips through that gate still falls back to upload at API-error time.
- **Upload rendering trade-off**: Slack renders an uploaded `.md` file as
  raw source with an "expand" affordance, not as rendered Markdown - a
  deliberate trade for the length/formatting headroom a file gives over an
  inline message.

## Read-path limits

- `slack_search` fetches exactly one page per call (`search.messages`'s
  offset pagination: `count` up to 100, optional `page`); aggregating
  multiple pages is a caller concern.
- `slack_thread` paginates by cursor up to 50 pages / 5,000 messages, then
  returns `complete: false` plus a resumable `next_cursor`.
- **Thread throttle caveat**: since 2025-05-29, `conversations.replies` is
  rate-limited to ~1 request/minute (limit capped at 15) for Slack apps that
  are neither Marketplace-listed nor classified internal. `slack_thread`
  never spins on this - it surfaces the caveat in the result along with the
  messages collected so far and a resumable cursor, with no retry.
- **Size gate**: `slack_search`/`slack_thread` output inlines up to 32 KB /
  1000 lines; larger output is written in full to `tmpdir()/pi-slack` with a
  60-line/4 KB preview and the file path returned inline (files are never
  deleted by the tool).

## Migrating from hand-rolled Slack scripts

1. Enable `quiver.slack` in the repo's `settings.json`.
2. Keep existing token env var names, or remap them via `userTokenEnv`/
   `botTokenEnv`.
3. Either point `cachePath` at wherever your old cache lived, or drop it and
   let the extension use its user-scope default, then run
   `slack_cache_refresh` once - there is no importer for old cache file
   formats.
4. Rewrite script/skill invocations as `slack_*` tool calls.
5. Keep house policy - channel conventions, message templates, identity
   rules, review gates - in the consuming repo's own skills. This extension
   ships plumbing only; it does not ship a pi skill. The intended shape is a
   **thin proxy skill**: the skill body encodes the policy (which channel,
   which template, which `as` identity) and simply invokes the `slack_*`
   tools to carry it out - policy lives in the skill, mechanism lives in the
   extension. Sketch:

   ```
   ## announce-release skill
   channel: #releases, as: bot
   text: "Released {version}"; thread_body: full changelog
   -> call slack_post with the above
   ```

## Manual smoke checklist (not CI)

No live Slack call runs in automated tests. Before shipping a change that
touches the transport, cache, or announce protocol, verify against a real
test workspace/channel:

- Post a plain message as `user` and as `bot`.
- Announce with a detail body large enough to trip the upload fallback.
- Update a message.
- Delete a message.
- Pin a message.
- Search for a message.
- Read a thread.
- Run `slack_cache_refresh` and confirm the channel/user counts.
