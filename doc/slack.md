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
| `policyPath` | string | none (no injection) | repo policy file injected into the system prompt every turn; absolute or repo-root-relative; no env-var override - see [Repo policy injection](#repo-policy-injection) |
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

## Repo policy injection

When `policyPath` is set, a `before_agent_start` hook (registered once, at
`session_start`, alongside the tools) rereads the file fresh from disk on
every agent turn and appends a `<slack-policy source="...">` block to that
turn's system prompt. `policyPath` itself is relative to the repo root or
absolute; there is no `PI_QUIVER_SLACK_*` override for it.

- **Ok** (file reads, non-empty): `<slack-policy source="<policyPath>">`
  followed by the raw file contents and the closing tag. The `source`
  attribute is HTML-escaped. The file contents themselves are injected
  verbatim, unescaped - a policy body must not contain the literal
  `</slack-policy>` closing tag, or the injected block truncates there.
- **Empty** (file reads, blank after trim): the block instead carries
  `status="empty"` and a fixed body - `Configured Slack policy file is
  empty. Slack tools are available but the repository's posting policy is
  unknown - ask the operator before posting.`
- **Unreadable** (missing file, permission error, ...): `status="unreadable"`
  with `Configured Slack policy file could not be read (<error code>).`
  plus the same "ask the operator" sentence.

Either degraded case also emits one deduped warning for the session
(`ctx.ui.notify(..., "warning")` in a UI session, `console.warn` otherwise)
- naming the configured `policyPath` and the failure. The Slack tools
  themselves are unaffected either way; only the injected guidance
  degrades.

## Cache

Channel/user name->ID resolution is cached in a single JSON file per Slack
workspace (keyed by team ID from `auth.test`):

- **Location**: the configured `cachePath` (absolute, or resolved against
  the repo root; may be committed to the repo) if set, else the per-OS user
  cache dir (`%LOCALAPPDATA%\pi-quiver` on Windows, `~/Library/Caches/pi-quiver`
  on macOS, `$XDG_CACHE_HOME/pi-quiver` else), file named `slack-<team_id>.json`.
  Only this one location is ever read or written; the other is never touched.
- **Format**: `{ team_id, channels: {name -> id}, users: {username ->
  {id, display_name, real_name, email?}}, refreshed_at, snapshot_at? }`.
- **`email`** (optional, per user): the user's `profile.email` from
  `users.list`, omitted from the entry when Slack returns none. User and
  workspace tokens need the `users:read.email` scope to receive it; classic
  bot tokens get it without that scope.
- **`snapshot_at`** (optional, file-level): set only by `slack_cache_refresh`'s
  full replace (to the same timestamp as `refreshed_at`), never by an
  incremental miss-fill merge. Its presence is what makes a display-name/
  real-name alias match trustable straight from the cache file - without it
  (i.e. the cache has only ever been built up by incremental misses), an
  alias candidate is left for the live `users.list` lookup instead of being
  trusted from a possibly-partial population; only an exact username hit
  resolves from cache in that case.
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
  `conversations.list` + `users.list` scan and atomically replaces it,
  setting `snapshot_at` to the same timestamp as `refreshed_at`. Uses
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
| `slack_post` | `as` | `channel`, `text`/`blocks`, optional `thread_ts`, optional `thread_body`, optional `unfurl_links`/`unfurl_media` | plain post, threaded reply, or announce (headline + threaded detail) - see below |
| `slack_update` | `as` | `channel`, `ts`, `text`/`blocks` | `chat.update`; only the original poster's identity can edit |
| `slack_delete` | `as` | `channel`, `ts` | `chat.delete`; same ownership constraint |
| `slack_pin` | `as` | `channel`, `ts` | `pins.add`; maps `already_pinned`/`not_pinnable`/`too_many_pins` |
| `slack_upload` | `as` | `channel`, `path`, optional `filename`/`title`/`thread_ts`/`initial_comment` | `files.getUploadURLExternal` -> upload -> `files.completeUploadExternal` |
| `slack_cache_refresh` | user if configured, else bot | none | full cache regeneration; reports `channels: N, users: N` plus `\| emails: N/N` (omitted when there are zero users; a `0/N` count adds a `(users:read.email scope may be missing)` hint) |

### Mentions (`slack_post`, `slack_update`)

`text` and `thread_body` - never `blocks` - are scanned for `@name` tokens
and substituted with `<@U...>` before the call reaches Slack:

- **Grammar**: `@` followed by one or more of `[A-Za-z0-9._-]`. A candidate
  must be preceded by start-of-string or one of ` \t\n\r([*_"'`; backtick is
  deliberately not a boundary character, so an inline-code `` `@name` ``
  never becomes a candidate (stays literal, never reported). The same rule
  is why `user@host.com` and Slack's own `<@U...>` never qualify - the
  character immediately before `@` fails the boundary check.
- **Deny list**: `@here`, `@channel`, `@everyone` are never substituted
  (checked against both the raw and the trailing-trimmed form).
- **Trailing trim**: `[.,;:!?)_]+` is stripped from the end of a candidate
  before lookup, so `@alice.` and `_@alice_` both resolve on `alice`; `_` is
  trimmed even though it's also a boundary character, specifically so an
  italic-wrapped mention like `_@alice_` is reachable at all.
- **Escape**: `\@name` (itself preceded by a boundary) loses the leading
  backslash and is left literal - never looked up, never reported.
- **Resolution**: a cache hit resolves first; every name still unresolved
  across all scanned fields is then looked up with one batched `users.list`
  call (not one call per name).
- **Unresolved**: a name that is not found, ambiguous, or hit a live-lookup
  error is left literal in the text and reported two ways - in the result
  line's `unresolved mentions: @alice, @bob` suffix (appended with
  `(lookup failed: <reason>)` when the live pass itself failed), and as an
  ordered, deduplicated `details.unresolvedMentions: { field, name }[]`.
- **Uploaded-detail limitation**: if an announce's `thread_body` overflowed
  to a file upload (`detailUploaded`) and it also carried an unresolved
  mention, the suffix instead reads `... (detail uploaded as a file -
  slack_update cannot repair it; repost to fix)` - `slack_update` can edit
  the headline or the `Detail attached.` stub, never an uploaded file's
  contents.

### Unfurl control (`slack_post`)

`unfurl_links`/`unfurl_media` are forwarded to `chat.postMessage` only when
the caller explicitly sets them; left unset, Slack's own default stands (no
parameter is sent). In announce mode both flags apply to the headline leg
and to the inline threaded-reply detail leg, but never to the
`Detail attached.` upload-fallback stub. `slack_update` has no equivalent -
`chat.update` accepts no unfurl parameter, so a message's unfurl behavior
can't be changed after it's posted.

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
5. For a short standing policy (e.g. "always post as bot to
   #eng-releases", "get sign-off before deleting"), point `policyPath` at a
   repo file and let it auto-inject every turn - see [Repo policy
   injection](#repo-policy-injection). For anything with actual branching
   (choosing among channels, templates, or identities), keep that logic -
   channel conventions, message templates, identity rules, review gates -
   in the consuming repo's own skills. This extension ships plumbing only;
   it does not ship a pi skill. The intended shape is a **thin proxy
   skill**: the skill body encodes the policy (which channel, which
   template, which `as` identity) and simply invokes the `slack_*` tools to
   carry it out - policy lives in the skill, mechanism lives in the
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
- Set `policyPath` to a real file and confirm the `<slack-policy>` block
  shows up in the system prompt; point it at a bad path and confirm exactly
  one warning fires and `slack_post` still succeeds.
- Post a message whose text has one known and one unknown `@name` mention;
  confirm the known one renders as a Slack link and the unknown one stays a
  literal `@name`, named in the result line's `unresolved mentions:`
  segment.
