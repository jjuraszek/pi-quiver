# slack - Slack message lifecycle tools

Pi registration is opt-in, default-off. The [CLI](#cli) instead treats an
explicit invocation as opt-in, without enabling pi tools. Enable
`quiver.slack` in `settings.json` and the next session registers eight `slack_*` tools (search, thread reads, post/announce,
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

## CLI

Claude Code, CI, and scripts use the shared Slack core through these forms:

```text
pi-quiver slack --help
pi-quiver --version
pi-quiver slack post --channel <id> --text <text> [--detail <text> | --detail-file <path>] [--blocks-file <path>] [--no-unfurl] [--as user|bot] [--token-from-env] [--dry-run]
pi-quiver slack reply --channel <id> --thread-ts <ts> (--text <t> | --text-file <path>) [--no-unfurl] [--as user|bot] [--token-from-env] [--dry-run]
pi-quiver slack dm --user <id> (--text <t> | --text-file <path>) [--blocks-file <path>] [--no-unfurl] [--as user|bot] [--token-from-env] [--dry-run]
pi-quiver slack canvas --id <id> --markdown-file <path> [--as user|bot] [--token-from-env] [--dry-run]
```

Help and version exit 0 without reading settings or credentials or making a
network call. Version prints the package version.

| Flag | Commands | Contract |
|---|---|---|
| `--channel <id>` | post, reply | Required raw channel ID (`C...`, `D...`, `G...`) |
| `--text <text>` | post, reply, dm | Required single-line headline for user post; bot post accepts multi-line text; inline body for reply/dm |
| `--detail <text>` | post | Inline announcement detail; exclusive with `--detail-file` |
| `--detail-file <path>` | post | Read announcement detail from a file |
| `--blocks-file <path>` | post, dm | JSON array of Block Kit blocks, not an object wrapper |
| `--thread-ts <ts>` | reply | Required existing thread timestamp |
| `--text-file <path>` | reply, dm | Body from a file; exactly one of this or `--text` |
| `--user <id>` | dm | Required raw user ID (`U...`); opens or targets that identity's DM |
| `--id <id>` | canvas | Required existing canvas ID |
| `--markdown-file <path>` | canvas | Required file containing the full replacement document |
| `--as user\|bot` | all four | Acting identity; defaults to `user` |
| `--no-unfurl` | post, reply, dm | Disable both link and media unfurls; rejected on canvas |
| `--token-from-env` | all four | Use only the requested identity's configured process-env token key |
| `--dry-run` | all four | Validate local inputs and resolve credentials without network calls |

`--no-unfurl`, `--token-from-env`, and `--dry-run` take no value; extra
values after them are usage errors.

There is no channel/user alias lookup, cache refresh, or `@mention`
rewriting. Text is sent as given; use raw IDs instead of `#name` or `@name`.
Message text and markdown come only from named flags or `--*-file` paths.
Piped stdin is ignored: it never substitutes for a missing `--text`, and
when both are supplied the named `--text` wins.

`post --as user` (also the default) runs `assertHeadline` before credentials
or transport: non-empty, single-line, at most 4000 UTF-16 code units.
`post --as bot` accepts non-empty plain or multi-line text up to 40,000
UTF-16 code units, sent whole without truncation, splitting, or upload fallback.
With `--detail` or
`--detail-file`, single-line posts use the
[announce protocol](#announce-protocol): a plain-text headline followed by
detail in its thread. Multi-line bot posts instead send a plain parent and
then a threaded detail, without changing user announce recovery. Blocks
belong to the detail, with detail text as fallback; without detail, blocks
belong to the top-level message with `--text` as fallback. DM opens the
conversation, then sends the exact supplied blocks array and fallback text.
`--no-unfurl` sets both `unfurl_links` and `unfurl_media` to false on message
routes, including both parent and detail legs; upload transport is unchanged.
Reply sends the supplied body to `--thread-ts`;
oversized user-identity text-only replies use the core's upload fallback.
Bot-identity replies and DMs accept up to 40,000 UTF-16 code units as messages.
DM text above the identity's limit (4000 for user, 40,000 for bot) fails with
`text_too_long` after opening the DM but before posting. Canvas makes one `canvases.edit` call to replace the entire
document, never creates a canvas, and requires `canvases:write` on either
the user or bot token.

Use the default `--as user` for interactive sessions; select `--as bot` to
send as the app. Settings and token precedence match the pi tools:
`<agentDir>/settings.json`, then `<cwd>/.pi/settings.json`, then the
[environment overrides](#resolution-ladder). The agent directory defaults
to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it. The CLI does not consult
`quiver.slack.enabled`: the invocation is the opt-in. Token env names,
upload threshold, and credential-command settings still apply. A configured
`userTokenCommand` is the sole user-token source, with its configured timeout
(default 10 seconds), never falling back on failure. Otherwise the
[token ladder](#tokens) is process env, repo `.env`, primary checkout `.env`,
then user-level `.env`. Bot always uses that ladder, never the command;
identities never fall back to one another.

`--token-from-env` resolves settings and environment overrides as usual to
select `userTokenEnv` or `botTokenEnv`, then reads only that process-env key.
Missing or empty means exit 3, even if the opposite identity, a credential
command, or a `.env` file could supply a token. This path runs no credential
command, repo discovery for credentials, or `.env` lookup. Normal invocations
remain the source of truth for the full token ladder.

`--dry-run` performs the same parser, file-read, blocks-array, identity-text,
and local size checks and selected credential resolution, then exits 0 with
empty stdout. Without `--token-from-env`, it exercises the full normal ladder,
including a configured credential command. It stops before any Slack API,
DM open, authentication probe, permalink lookup, upload, or detail/pending
persistence. Usage errors exit 2 before credentials, missing credentials exit
3, and other local runtime failures exit 1. Oversize threaded text that can
use upload fallback remains valid for user replies; bot post, DM, and reply
text over 40,000 UTF-16 code units is exit 2 in dry-run versus exit 4 with
`error=text_too_long` on an actual send. User DM text retains its 4000-unit limit. Dry-run adds no canvas or
blocks content restrictions and cannot guarantee remote acceptance, valid
authentication, IDs, blocks, or scopes.

### Results and retry safety

Stdout is one line of space-separated `key=value` tokens. Parse fields by
presence: absent values are omitted, not printed as empty assignments.

| Result | Example stdout |
|---|---|
| Plain post, reply, or DM | `ts=100.1 permalink=https://example.test/p/1001` |
| Announcement | `ts=100.1 permalink=https://example.test/p/1001 detail_ts=100.2` |
| Oversized reply delivered as an upload | `ts=100.1 detail_ts=100.2` |
| Canvas replacement | `canvas=F123456` |

On upload fallback, `detail_ts` is the `Detail attached.` intro reply's
timestamp, not an uploaded file ID. For an uploaded reply, `ts` is the
existing thread timestamp.
A failed permalink lookup still means a successful send: exit 0, a warning
on stderr, and `ts=100.1` without `permalink`. Settings lint warnings also go
to stderr and are nonfatal.

| Exit | Meaning | Stdout |
|---|---|---|
| 0 | Sent, or dry-run validation and credential resolution succeeded; help/version also succeed | Result line for sends; empty for dry-run (or help/version output) |
| 1 | Runtime error before a mutating request, such as an unreadable `.env` | Empty |
| 2 | Usage error: missing/unknown flags, exclusive inputs, invalid identity/headline, unreadable files, invalid blocks JSON/shape, empty message text, or invalid dry-run plain-text size | Empty |
| 3 | No token for the requested identity, including credential-command failure | Empty |
| 4 | Definitive failure: Slack rejection, local `text_too_long`, exhausted rate-limit retry, HTTP error, or `detail_failed` | `error=<code>`, preceded by `ts=<parent ts>` when a parent landed |
| 5 | Outcome unknown: `outcome_unknown`, mutating `transport`/`unexpected_response`, non-Slack throws after mutation starts, or canvas `internal_error`/`fatal_error` | Empty |

Local text limits use UTF-16 code units: bot post/DM/reply has a 40,000-unit
ceiling; user post headlines and DMs retain 4000. Announce headlines remain
limited to 4000 regardless of identity.

A failed DM open (`conversations.open` transport failure, rejection, or
missing `channel.id`) is definitive, exit 4: no message was posted. A reply
upload's `detail_failed` carries only `thread_ts`, not a newly landed
headline `ts`, so stdout is `error=detail_failed`; stderr names the persisted
detail path. A landed announcement whose detail fails prints
`ts=100.1 error=detail_failed`, never a permalink or detail timestamp on that
failure path. A rejected multi-line bot detail retains the parent timestamp,
for example `ts=100.1 error=invalid_blocks`.

Every exit 4 includes `error=` from the structured Slack error code, not
parsed human text: `error=invalid_auth` lets callers distinguish auth-class
failures from other definitive failures. Exits 1, 2, 3, and 5 always have
empty stdout, even when an unknown bot detail outcome has a known parent.

Usage errors print `usage: <reason>` plus usage on stderr. Slack failures
print `SlackError.message`, its `code` if not already present, and the
core's `ERROR_HINTS` hint. Only allowlisted `ts` (stdout on exit 4) and
`channel` (stderr) are extracted from error data; raw `err.data` is never
dumped. The resolved credential is replaced with `<redacted>` throughout
stdout and stderr, including warnings.

Exit 5 always says `Check the channel before retrying.` A mutating
`transport` failure is exit 5, not proof that nothing landed. Inspect the
channel before retrying to avoid duplicate posts. Core hints retain pi
wording such as `run slack_cache_refresh` and `re-invoking slack_post`;
CLI callers instead pass raw channel IDs and inspect the channel before
re-running the command. Follow the announce recovery guidance for saved
detail rather than posting a second headline.

## Configuration

All keys live under `quiver.slack`:

| key | type | default | purpose |
|---|---|---|---|
| `enabled` | boolean | `false` | master switch; anything other than resolved `true` registers zero tools |
| `cachePath` | string | per-OS user cache dir, keyed by workspace | name->ID cache file location; absolute or repo-root-relative |
| `policyPath` | string | none (no injection) | repo policy file injected into the system prompt every turn; absolute or repo-root-relative; no env-var override - see [Repo policy injection](#repo-policy-injection) |
| `userTokenEnv` | string | `SLACK_USER_TOKEN` | env var name holding the user token when `userTokenCommand` is unset |
| `userTokenCommand` | non-empty string array | unset | executable argv that prints the current user token to stdout on each user-identity tool call |
| `userTokenCommandTimeoutSeconds` | positive finite number | `10` | timeout in seconds for the user credential command |
| `botTokenEnv` | string | `SLACK_BOT_TOKEN` | env var name holding the bot token |
| `uploadThresholdChars` | number | `4000` | link-collapsed length above which text-only announce detail or a text-only threaded reply becomes a file upload |

### Resolution ladder

Per key, highest rung wins:

1. **Process env overrides**: `PI_QUIVER_SLACK_ENABLED`, `PI_QUIVER_SLACK_CACHE_PATH`, `PI_QUIVER_SLACK_USER_TOKEN_ENV`, `PI_QUIVER_SLACK_BOT_TOKEN_ENV`, `PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS`.
2. Repo `.pi/settings.json`, `quiver.slack.{...}`; this project layer also honors `userTokenCommand` and `userTokenCommandTimeoutSeconds`.
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

Token *values* never live in `settings.json`. By default, each identity
resolves per call by walking these rungs in order and returning the first
non-empty value of the configured key (`userTokenEnv` / `botTokenEnv`):

1. `process.env[<configured env var name>]`.
2. Repo-root `.env`.
3. In a linked git worktree, the primary checkout's repo-root `.env`
   (discovered via `git rev-parse --path-format=absolute --git-common-dir`).
4. A per-user file outside any repo: `$XDG_CONFIG_HOME/pi-quiver/.env`, else
   `~/.config/pi-quiver/.env` (Linux and macOS); `%APPDATA%\pi-quiver\.env`
   on Windows. The rung is skipped when neither `XDG_CONFIG_HOME` nor `HOME`
   is set (Linux/macOS), or when `APPDATA` is unset (Windows). The location is
   fixed - there is no setting for it.

A file that exists but lacks the key (or has an empty value) falls through
to the next rung; only when every rung misses does the call fail with
`missing_token`, whose message names every checked path (never a token
value). A file that exists but cannot be read (permissions, a directory at
that path) is a misconfiguration: the raw filesystem error propagates and
the remaining rungs are not consulted.

`.env` file format, at every rung: one entry per line, optional leading
whitespace, optional `export ` prefix, exact `KEY=value`; last matching line
wins; one surrounding quote pair (`'...'` or `"..."`) is stripped; the file is
never shell-sourced.

Token values resolved from process env or `.env` are never logged or echoed
back in tool output or errors.

`userTokenCommand` replaces that ladder for the user identity. It is an argv
array, not a shell string - for example `["my-slack-token-manager", "get"]` - so
shell parsing and expansion never occur. Pi executes it on every user-identity
Slack tool invocation, trims stdout, and uses the result as the user token. The
command uses the `userTokenCommandTimeoutSeconds` timeout (10 seconds by
default) and a fixed 64 KiB output cap. Empty output,
nonzero exit, launch failure, and timeout are sanitized errors: stdout,
stderr, and token values are never included. An explicit command never falls
back to a stale process-env or `.env` token. Bot resolution remains on its
env/`.env` ladder.

For 1Password CLI, use `op read` to supply the token without storing its value
in settings:

```jsonc
{
  "userTokenCommand": ["op", "read", "op://<vault-id>/<item-id>/<field-id>"],
  "userTokenCommandTimeoutSeconds": 60
}
```

Set these keys under `quiver.slack`. Replace the placeholders with your vault,
item, and token field IDs; use the immutable item ID so renaming the item
won't break the reference. Authenticate `op` before using Slack tools. The
example increases the timeout to 60 seconds because `op` may show an
interactive 1Password authorization dialog; increase it further if needed.

There is no fallback between identities - a missing user token is never
covered by a present bot token. A missing token is a hard per-call error.
Slack configuration is captured at `session_start`, so adding or changing
`userTokenCommand` or `userTokenCommandTimeoutSeconds` requires restarting pi.

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
  identity's call - the check is simply skipped. Bot calls also skip this check
  when `userTokenCommand` is configured, avoiding a credential-helper prompt
  for an unused identity.
- **Miss path**: a cache miss triggers a live, paginated `conversations.list`
  / `users.list` scan (the list APIs have no name filter) up to 100 pages;
  the `users.list` scan skips members Slack flags `deleted` (deactivated), so
  exhaustion without an active match errors `name_not_found` and writes nothing.
  A hit is written back
  with an atomic re-read + merge + tmp-write + rename, so concurrent misses
  don't clobber each other's entries (a true simultaneous race is
  last-writer-wins - accepted for an append-mostly map).
- **`slack_cache_refresh`**: regenerates the whole file from a full
  `conversations.list` + `users.list` scan and atomically replaces it,
  omitting deactivated users and setting `snapshot_at` to the same timestamp
  as `refreshed_at`. Uses
  the user token when one is configured, else falls back to the bot token.
- **Staleness**: a renamed channel/user or a user deactivated after being cached
  resolves to its old ID silently until the next `slack_cache_refresh` - this
  is a known limitation, not a bug.

## Tools

Every `channel` parameter accepts four forms: `#name`, a raw channel ID
(`C...`/`D...`/`G...`), `@name`, or a raw user ID (`U...`/`W...`). The last
two target a DM - see "DM targets" below. `slack_post`, `slack_update`, and
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

**DM targets.** A `@name` or user-ID `channel` is resolved by
`resolveChannel` itself: `@name` is looked up in the users cache, then
`users.list` (cached display/real-name aliases are trusted only after a
`slack_cache_refresh` snapshot; an unknown name fails with `name_not_found`),
then one `conversations.open { users }` call returns the DM's `D...` id,
which every tool then uses as `channel`. Results echo that `D...`, so
follow-ups (`slack_update`, `slack_delete`, `slack_pin`, `slack_thread`) can
pass it directly and skip the hop. The hop runs on the acting identity's
token and needs `im:write`; `slack_thread` DM reads additionally need
`im:history` on the user token. A missing scope surfaces as Slack's own
`missing_scope` error - there is no local preflight. A user-token open is
the user's DM with that person; a bot-token open is the app's DM with them -
two different `D...` conversations. Follow-ups (`slack_update`,
`slack_delete`, `slack_pin`) must reuse the returned `D...` under the same
`as` that posted - re-resolving `@name` under the other identity opens a
different conversation and does not address the posted message.
`slack_thread` always runs as the user, so
`slack_thread { channel: "@bob" }` reads the user's own DM with bob; a `D...`
returned by `slack_post { as: "bot" }` is not readable there
(`channel_not_found`). Group DMs (`U1,U2`) are not supported.

| tool | identity | params (sketch) | behavior |
|---|---|---|---|
| `slack_search` | always user | `query`, `count` (<=100), `page` | `search.messages` with Slack's operator grammar (`in:#chan`, `from:@name`); one page per call, size-gated output |
| `slack_thread` | always user | `channel`+`ts`, or `permalink`, optional `cursor` to resume, optional `raw` | `conversations.replies`, cursor-paginated to completion or a 50-page/5000-message cap (returns `next_cursor` when capped); default Block Kit flattening or raw JSON; size-gated |
| `slack_post` | `as` | `channel`, `text`/`blocks`, optional `thread_ts`, optional `thread_body`, optional `unfurl_links`/`unfurl_media` | plain post, existing-thread reply (no headline), or announce (`text` headline + detail `blocks` with `thread_body` fallback) - see below |
| `slack_update` | `as` | `channel`, `ts`, `text`/`blocks` | `chat.update`; only the original poster's identity can edit |
| `slack_delete` | `as` | `channel`, `ts` | `chat.delete`; same ownership constraint |
| `slack_pin` | `as` | `channel`, `ts` | `pins.add`; maps `already_pinned`/`not_pinnable`/`too_many_pins` |
| `slack_upload` | `as` | `channel`, `path`, optional `filename`/`title`/`thread_ts`/`initial_comment` | `files.getUploadURLExternal` -> upload -> `files.completeUploadExternal` |
| `slack_cache_refresh` | user if configured, else bot | none | full cache regeneration; reports `channels: N, users: N` plus `\| emails: N/N` (omitted when there are zero users; a `0/N` count adds a `(users:read.email scope may be missing)` hint) |

By default, `slack_thread` renders one line per message. When a message has
Block Kit blocks, `header` and `section` text and fields pass through without
unescaping or entity decoding, `context` renders its text elements, and
`rich_text` renders its named inline elements. Embedded newlines collapse to
spaces to preserve the one-line-per-message format. Other types render as
`[<type>]`; blocks join with ` / `. If flattening produces no content, the
message falls back to `text`.

Set `raw: true` for block extraction and `slack_update` round-trips. The
result content is a pure JSON array of raw message objects with `blocks`
untouched and no status trailer. Consequently, `complete: false` and
`nextCursor` live only in result `details`: pagination caps and 429 throttles
produce a partial array with no in-content signal, while other errors surface
as tool errors with no content. A spill preview starts with `[` just like a
complete array. Attempt `JSON.parse` on the content; on failure, read the file
named in the truncation line. When completeness matters, run default (compact)
mode first so `complete:` and `next_cursor` appear inline, then use `raw: true`
for extraction or a round-trip.

### Conditional formatting (`slack_post`, `slack_update`)

The calling skill chooses whether formatting is required; the enabled tools
supply Slack representations in their descriptions and prompt guidelines,
independent of optional `quiver.slack.policyPath`. Customer policy owns
channel choice, tone, approvals, and templates. Keep otherwise plain content
plain; preserve the structure the skill requires.

Use native `rich_text_list` elements (`bullet` or `ordered`, with
`rich_text_section` items) for required lists and `rich_text_quote` for
required quotations. Preserve item boundaries, order, quoted wording, and
supplied attribution. Inside rich text, use text-element styles `bold`,
`italic`, `strike`, and `code`, `rich_text_preformatted` for multiline code,
and native link elements. On text-only surfaces, use Slack mrkdwn:
`*bold*`, `_italic_`, `~strike~`, backticks or triple-backtick code fences,
and `<url|label>` links. Code alone does not require blocks.

Supply complete readable fallback when authoring blocks, including the
substantive content, list-item boundaries, and quotation/commentary
distinction, for notifications and screen readers. Pair blocks with `text`
for ordinary posts and updates, `thread_body ?? text` for existing-thread
replies, and `thread_body` for announcement detail. Blocks without
`thread_body` do not create an announcement. Existing blocks-only callers
remain supported; blocks pass through without conversion for Slack validation.

Escape literal mention-like names in text-only code and fallback with
`\@name`; supply `echo \@alice` to retain literal `echo @alice`.
Backticks do not suppress mention scanning throughout a code span. Name
lookup scans only `text` and `thread_body`; `@name` in block text/code leaves
stays literal. See [Mentions](#mentions-slack_post-slack_update) for the scan
boundaries.

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
threaded reply, in one call. The headline is text-only `text`; original
`blocks` belong to the detail reply with `thread_body` as its fallback.

- **Pre-flight**: the headline (`text`) must be non-empty, a single line,
  and <= 4000 UTF-16 code units - checked before any network call.
- **Headline never retries**: the headline `chat.postMessage` is sent with
  no auto-retry, because a transport failure after send may mean Slack
  already accepted it - a retry could double-post a visible notification.
- **`outcome_unknown`**: a transport failure on the headline (or an
  `ok:true` response with an unparseable `ts`) returns `outcome_unknown`.
  Locate the actual headline in the channel and obtain its `ts` before
  recovery; do not repost the headline. The composed detail is persisted
  under `tmpdir()/pi-slack` so it is not lost.
- **Recovery**: read `detailPath`; text-only detail is a `.md` body, while
  structured detail is `.json` containing `{ "text": <fallback>, "blocks":
  <original blocks> }`. Both use timestamp/hash `-detail` filenames under
  `tmpdir()/pi-slack`. For structured recovery, call `slack_post` with saved
  `text` as `thread_body`, saved `blocks`, and `thread_ts` set to the known
  headline `ts` (returned as `ts` on announcement `detail_failed`). Reuse the
  saved blocks after a transient failure; correct payload rejections such
  as `invalid_blocks` before recovery and retain the original artifact.
  Text-only recovery uses the saved body as `thread_body`. Recovery posts
  only into the existing thread, never a second headline; there is no
  automatic replay.
- **Detail-pending marker**: if the detail leg fails after its own single
  `Retry-After` retry, the headline is edited (`chat.update`) to append the
  frozen marker ` _(detail pending)_`, the detail body is persisted to a
  temp file, and a structured error names the headline `ts`/channel/permalink
  and the file path. The error remains `detail_failed`, with the underlying
  Slack rejection identified. Marker edits are best-effort: an edit failure
  is reported without masking the detail failure. Persistence failure is
  also reported and omits `detailPath`; no saved artifact is available then.
- **Native detail limits**: blocks-bearing announcement details and
  existing-thread replies bypass `uploadThresholdChars`, the local
  `MAX_TEXT_LENGTH` fallback-text guard, and `msg_too_long` upload fallback.
  They remain messages, not files. Slack payload limits still apply:
  announcement rejection uses structured recovery; an existing-thread
  rejection surfaces the Slack error. Headline, non-threaded-post, update,
  and text-only limits remain intact.
- **Oversized text-only detail -> upload**: when the detail's *link-collapsed* length
  exceeds `uploadThresholdChars` (default 4000), it is delivered instead as
  a threaded reply with the frozen intro line `Detail attached.` followed by
  a file upload named `slack-detail.md` in the same thread.
- **Same gate on plain threaded replies**: this oversize->upload gate is not
  announce-only - a text-only `slack_post` call with `thread_ts` set (a threaded
  reply, no headline involved) is checked against the same
  `uploadThresholdChars` link-collapsed length and falls back to the same
  upload delivery when it's exceeded.
- **Two length counters**: hard pre-flight checks (headline <= 4000, and the
  local `MAX_TEXT_LENGTH` assert where applicable) use
  raw UTF-16 `.length` - Slack's own `msg_too_long` unit. The
  `uploadThresholdChars` gate uses a link-collapsed counter (`<url|label>`
  counts as `label`, bare `<url>` counts as one placeholder word) so a
  permalink-heavy text-only detail isn't needlessly bounced to a file; a
  text-only `msg_too_long` that slips through that gate still falls back to
  upload at API-error time.
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
  deleted by the tool). Raw pretty JSON typically reaches the 1000-line cap
  before the 32 KB cap, so anything beyond a short thread usually spills; the
  spill file contains the complete, parseable JSON array.

## Migrating from hand-rolled Slack scripts

### Pi sessions

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

### Claude Code, CI, and scripts

Replace the hand-rolled sender with the CLI, using raw IDs and files for
long detail:

```bash
npx -y pi-quiver@latest slack post --channel C123456 --text "Released 1.2.3" --detail-file changelog.md --as user
```

For multi-line scheduled reports, use bot identity; an env-only dry-run can
guard the same invocation before sending:

```bash
report=$(printf 'Audit complete\nNo changes required')
npx -y pi-quiver@latest slack post --channel C123456 --text "$report" --as bot --no-unfurl --token-from-env --dry-run
# After successful local validation, send explicitly without --dry-run.
npx -y pi-quiver@latest slack post --channel C123456 --text "$report" --as bot --no-unfurl --token-from-env
```

Pin `pi-quiver@<version>` instead of `@latest` for reproducible automation.
The minimum pin is the first release containing all six contracts: multi-line
bot posts, `--no-unfurl`, DM blocks, `--token-from-env`, `--dry-run`, and
exit-4 `error=` output. Use `--as bot` when app identity is intended. Keep
existing token env names or remap them through `userTokenEnv`/`botTokenEnv` as in the pi lane. CLI
callers do not need to enable pi registration. Inline the invocation in the
consumer's command files: no Slack plugin skill ships by design. Pi uses
native `slack_*` tools; Claude Code and CI use the [CLI contract](#cli),
including its exit codes and check-before-retry rule.

## Manual smoke checklist (not CI)

No live Slack call runs in automated tests. Before shipping a change that
touches the transport, cache, or announce protocol, verify against a real
test workspace/channel. Configure workspace credentials and obtain approval
to post in that channel before running this checklist. Mocked API checks
and model authoring samples do not verify live Slack client rendering.

- Post native bullet and ordered lists; confirm item boundaries and order.
- Post a native quote with attribution, required styles, inline/multiline
  code, and a labeled link; inspect their rendering in Slack.
- Inspect fallback text for complete content, separate list items, and
  quotation/commentary distinctions. Confirm literal `echo @alice` stays
  literal when supplied as `echo \@alice` in text/fallback.
- Announce with blocks and fallback; confirm a text-only headline and native
  detail in its thread. In an approved failure exercise, reject detail
  blocks, inspect the `.json` artifact, correct the rejected payload while
  retaining the original artifact, and recover with saved fallback/blocks
  into the known `thread_ts`; confirm no second headline or file upload.
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
