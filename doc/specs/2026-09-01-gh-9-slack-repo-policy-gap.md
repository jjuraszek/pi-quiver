# Close the repo-policy gap: policy injection, `@name` mentions, email in the users cache, unfurl control

Ticket: [jjuraszek/pi-quiver#9](https://github.com/jjuraszek/pi-quiver/issues/9) (features 1-3;
feature 4 is an addition made during brainstorming and is not in the issue text)

## Goal

Absorb three per-repo Slack workarounds into the extension: a repo-owned policy file
injected into the system prompt, `@name` -> `<@U...>` linkification in
`slack_post`/`slack_update`, and `profile.email` persisted in the users cache. Plus a
fourth, tightly coupled gap: per-call unfurl control on `slack_post`, which today is not
expressible at all.

Feature 4 rides in this spec rather than its own because it mutates the same two tool
schemas and the same core post path as features 1-3; splitting it would produce two specs
editing the same functions in the same release.

This deliberately reverses one gh-7 principle. `doc/specs/2026-08-29-gh-7-slack-extension.md`
states "House policy ... stays out; consumer repos layer thin proxy skills over these
tools." Every consumer then rebuilt the same three things by hand. `policyPath` does not
move policy *into* the extension - it gives the extension a pointer to policy the
consuming repo still owns and versions. The reversal is intentional and should not be
re-litigated as scope creep against gh-7's Goal.

Named downstream consumer:
`../gridstrong-pi-gauntlet-linear-slack/doc/specs/2026-09-01-pi-gauntlet-linear-slack-migration.md`,
which configures `policyPath: "doc/SLACK.md"` and `cachePath: "doc/cache/slack.json"`,
and whose stale-cache recovery policy is "literal `@name` in the result ->
`slack_cache_refresh` -> retry once". That recovery loop is why unresolved mentions must
be *reported*, not silent.

## Non-goals

- Email-keyed user resolution (`@alice@corp.com` -> ID). `email` is stored, never read.
- Mention scanning inside `blocks`. Block Kit payloads stay pass-through and unvalidated.
- Mention scanning in non-message fields (search queries, upload initial comments).
- An environment-variable override for `policyPath`. Config key only; the other Slack
  keys have env overlays, this one does not.
- Any change to the dual-token identity model, the announce transaction, upload
  fallback, or size gating.
- A cache-format version bump. `email` and `snapshot_at` are additive and optional.
- Repairing a mention baked into an already-uploaded detail file (see the edge table).
- A config-level unfurl default. Unfurl is per-call only (see feature 4).
- `unfurl_app_links`, `chat.unfurl`, and app-owned unfurl domains.
- Unfurl control on `slack_update` - the API has no such argument.

## Architecture

Three additive surfaces, no new module:

| Surface | Where | Depends on |
|---|---|---|
| Policy injection | `extensions/slack.ts` (`before_agent_start` handler, registered inside the existing `session_start` gate) + a pure formatter in `lib/slack-core.ts` | `repoRoot`, `fs` |
| Mention resolution | `lib/slack-cache.ts` (new `resolveMentions`), called once per mutating tool call from the adapter | `CacheCtx` |
| Email persistence | `lib/slack-cache.ts` (`UserEntry`, `resolveUser`, `refreshCache`, `resolveMentions`) | `users.list` |
| Unfurl control | `extensions/slack.ts` (`slack_post` schema) -> `lib/slack-core.ts` (`postPlain`, `announce`) | - |

`lib/slack-core.ts` gains one config field (`policyPath`) and one pure string formatter,
and is otherwise untouched: core stays cache-free, and mention substitution happens in
the adapter *before* `postMessage`/`updateMessage`, so core's `MAX_TEXT_LENGTH`,
`assertHeadline`, and `uploadThresholdChars` gates see the final wire text with no double
accounting.

## 1. Policy injection

### Config

`SlackConfig` gains `policyPath?: string` (`lib/slack-core.ts:19-33`), coerced as a
string in `coerce()` alongside `cachePath` (`lib/slack-core.ts:45-58`). No branch is
added to the env overlay (`lib/slack-core.ts:80-119`).

Path resolution mirrors `cachePath` (`lib/slack-cache.ts:46-47`): an absolute path is
used verbatim; a relative path resolves against `repoRoot`, the `discoverRepoRoot(ctx.cwd)`
value already computed at registration (`extensions/slack.ts:192`). Absolute paths are
accepted despite the ticket's "repo-relative" wording, for consistency with `cachePath`.

### Registration

Inside the existing `session_start` handler, after the `cfg.enabled !== true` gate and
the `registered` latch (`extensions/slack.ts:186-192`), register a `before_agent_start`
handler **only when `cfg.policyPath` is set**. An unset key registers nothing: no
handler, no file I/O, no behavior change. Disabled Slack registers nothing either, so
the documented "zero side effects when disabled" property holds.

This is the repo's first `before_agent_start` handler. Confirmed against the shipped
runtime: `BeforeAgentStartEvent` is `{ type, prompt, images?, systemPrompt,
systemPromptOptions }` and the result `{ systemPrompt?: string }` replaces the prompt for
the turn (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:538-549,845-848`,
`on` overload at `:919-924`); `emitBeforeAgentStart` - which fires once per agent start
and chains handlers - lives in `dist/core/extensions/runner.js:881-929`, called from
`dist/core/agent-session.js:914`. That runner also catches handler exceptions and routes
them to `emitError`, which reinforces (but is not relied on for) the never-fatal property
below. The append pattern (`return { systemPrompt: event.systemPrompt + "\n\n" + block }`)
is the ecosystem norm (`examples/extensions/claude-rules.ts:64-82`).

### Behavior

The handler reads the file synchronously on **every turn**. A ~2 KB read per turn is
negligible, an edit to the policy file takes effect on the next message, and an unchanged
file yields a byte-identical system prompt, so prompt caching is unaffected.

The injected block is delimited so the model can tell repo policy from harness
instruction, and names its source:

```
<slack-policy source="doc/SLACK.md">
...file contents verbatim...
</slack-policy>
```

`source` carries the configured value as written (not the absolute resolved path), so the
prompt does not leak machine-local directory structure. The attribute value is escaped
for `&`, `<`, `>`, and `"` (in that order) so a path containing them cannot break the
delimiter framing.

### Failure is advisory, never fatal

A missing, unreadable, or empty policy file is a degraded session, not an error. Tools
always register, no exception is thrown, no turn is blocked; the session simply falls
back to vanilla Slack handling. The handler injects a status block instead:

```
<slack-policy source="doc/SLACK.md" status="unreadable">
Configured Slack policy file could not be read (ENOENT). Slack tools are available but
the repository's posting policy is unknown - ask the operator before posting.
</slack-policy>
```

`status` is `unreadable` for a missing file, a permission error, or a directory (the
parenthetical carries the errno), and `empty` for a zero-byte or whitespace-only file
(with wording adjusted to "is empty"). In addition, the **first** failure in a session
emits one operator warning, deduped by a `let policyWarned = false` latch in the
registration closure, so a per-turn read cannot spam. The warning uses the repo's
established channel: `ctx.ui.notify(msg, "warning")` when `ctx.hasUI`, else
`console.warn` - the same split as `extensions/provider-stall-watchdog.ts:169,279`, and
consistent with the config warning already emitted at `extensions/slack.ts:187`. The
latch does not reset when the file starts working again; a recovered file simply injects
the real policy from that turn on.

### Read/render seam

Two pieces, so the interesting logic is unit-testable without a filesystem:

```ts
// lib/slack-core.ts - pure, no I/O
export function buildPolicyBlock(input: {
  source: string;                              // configured path, as written
  status: "ok" | "unreadable" | "empty";
  body?: string;                               // file contents when status is "ok"
  code?: string;                               // errno, when status is "unreadable"
}): string
```

The handler in `extensions/slack.ts` owns `readFileSync`, maps the outcome to that input
shape, and appends the returned block.

## 2. `@name` mention resolution

### Token grammar

Matching is a single left-to-right scan with two productions, in this order:

1. **Escape.** `\@` + `[A-Za-z0-9._-]+`, where the `\` sits at an allowed boundary
   (below). The backslash is consumed, the `@name` is emitted literally, and the token is
   **not** a candidate - it never reaches lookup and is never reported as unresolved.
2. **Candidate.** `@` + `[A-Za-z0-9._-]+` at an allowed boundary.

Allowed boundary = start-of-string or one of whitespace, `(`, `[`, `*`, `_`, `"`, `'`.
Defining escape as its own production, ordered first, is what makes `\@alice` reachable -
a boundary rule alone cannot express it, because `\` must be simultaneously excluded as a
boundary (so `x\@y` is inert) and recognized as an escape prefix.

This grammar is the extension's own: Slack deprecated server-side `@username` parsing in
2017 (`https://docs.slack.dev/changelog/2017-09-the-one-about-usernames`), so its mrkdwn
spec defines nothing here, and `link_names`/`verbatim` are not used.

Consequences, all deliberate:

- `user@host.com` and `a@b` never match (`@` preceded by a word character).
- An already-formatted `<@U012AB3CD>` never matches (`<` is not a boundary).
- A backtick is **not** a boundary, so `` `@alice` `` inside a code span stays literal.
  Code spans are exactly where linkification is unwanted, and this doubles as a second,
  Slack-rendered escape.
- `*@alice*`, `_@alice_`, `"@alice"`, `'@alice'` do match - common mrkdwn wrapping.

Trailing `.` `,` `;` `:` `!` `?` `)` `_` are trimmed from a candidate before lookup; if
the trimmed form misses, the untrimmed form is tried, because Slack usernames may contain
a dot - and `_` is in the trim set only because it is also a boundary, so `_@alice_` is
otherwise unreachable. Substitution replaces only the form that resolved, so a genuine
trailing `.` survives in the output.

Never looked up, always literal, never reported: `@here`, `@channel`, `@everyone`.

### Resolution

One call per tool invocation, over every field that will actually be sent:

```ts
export async function resolveMentions(
  fields: { field: "text" | "thread_body"; value: string }[],
  ctx: CacheCtx,
): Promise<{
  values: string[];                                        // substituted, positionally aligned with fields
  unresolved: { field: "text" | "thread_body"; name: string }[];
  lookupError?: string;                                    // set when the live pass failed
}>
```

Candidates are collected from **all** fields into one set, then:

1. **Cache-only pass.** Exact `users` key (username) hits resolve immediately - the cache
   is keyed by username, which Slack guarantees unique, so a hit cannot be ambiguous.
   `display_name` / `real_name` matches are aliases and are only trusted when the cache
   carries a `snapshot_at` marker (below); otherwise they join the live batch.
2. **One batched live pass.** If anything is outstanding, a single `users.list`
   pagination - same cursor-repeat detection and `MAX_LIST_PAGES` bound as
   `resolveChannel` (`lib/slack-cache.ts:102-148`) - resolves the whole outstanding set at
   once and merges newly matched users into the cache via the existing atomic
   `mergeAndWrite`. Ten unknown tokens across both fields cost **one** pagination, because
   the candidate set is shared across fields.

Substitution then applies the shared resolution map to each field independently. Hits
become `<@Uxxxxxxx>`; everything else stays byte-identical, including the `@`.

The live pass uses the calling identity's token, per gh-7's "cache misses use the calling
identity's token" rule; `resolveCall` already supplies it in `CacheCtx`
(`extensions/slack.ts:68-95`). A `slack_post as: bot` therefore paginates with the bot
token - working as designed, not a gap.

### Alias uniqueness needs a full snapshot

Uniqueness of a `display_name` / `real_name` match cannot be judged from a lazily
populated cache: `resolveUser` writes only the users it matched, so a second workspace
user sharing the alias may simply be absent, and substituting would notify the wrong
person. The existing `refreshed_at` field cannot distinguish the two cases - `mergeAndWrite`
bumps it on every lazy write (`lib/slack-cache.ts:91-96`).

`SlackCacheFile` therefore gains `snapshot_at?: string`, written **only** by
`refreshCache`'s full replacement and preserved untouched by `mergeAndWrite`'s patch. Its
presence means "this file once held a complete workspace listing", which is the only state
in which an alias match may be trusted from cache alone. Without it, aliases go to the
live pass, which sees the whole workspace and can judge uniqueness directly. Staleness is
the ordinary cache contract: a snapshot predating a new same-alias colleague can still
mis-resolve, and `slack_cache_refresh` is the remedy - the same contract channel names
already have.

### Unresolved is not an error

Both failure modes become "unresolved, stays literal" rather than a thrown `SlackError`:

- **Not found** after the live pass.
- **Ambiguous** - two or more users share the alias. A mention is a side remark inside
  prose, not an addressed parameter; guessing is wrong and failing the post is
  disproportionate.

A **transport failure** of the live pass (rate limit, network) is handled the same way,
for the same reason: every outstanding candidate stays literal, `lookupError` carries the
one-line reason, and the post proceeds. Hard-failing a post because a background name
lookup hit a 429 would contradict the principle above; the report channel already exists
to carry the degradation, and the operator's remedy (`slack_cache_refresh`, then
`slack_update`) is identical.

`resolveUser` is unchanged: it keeps throwing `name_not_found` / `ambiguous_user` for its
own callers (today, only its tests). `resolveMentions` does not call it per token - it
implements the same precedence over one shared batched pass.

### Call sites and reporting

In the `slack_post` and `slack_update` executors, immediately after `resolveChannel` and
before delegating to core (`extensions/slack.ts:264,296`), call `resolveMentions` **once**
with exactly the fields core will send:

| Tool call shape | Fields passed |
|---|---|
| `slack_post` announce (`thread_body` set, `thread_ts` unset) | `text` (headline) + `thread_body` (detail) |
| `slack_post` threaded reply (`thread_ts` set) | the single field core sends: `thread_body ?? text` |
| `slack_post` plain | `text` |
| `slack_update` | `text` |

Passing only the sent fields keeps the threaded-reply path from reporting unresolved names
in a `text` that core discards. Announce still scans both of its fields, but through the
one shared pass, before any network leg - substitution never happens inside a core
announce leg, so the transaction's single-headline invariant is untouched.

Reporting rides the existing `channelLine` output (`extensions/slack.ts:132-138`), whose
real shape is `channel C0123ABC | ts 1756...789 | <permalink>`. The executor appends one
suffix segment to that string; `channelLine` itself is unchanged, since unresolved data is
adapter-local and not a `MutationResult` field:

```
channel C0123ABC | ts 1756000000.000100 | https://... | unresolved mentions: @alice, @bob
```

Names are listed in first-seen order across the scanned fields, deduplicated by canonical
form; the suffix is omitted entirely when the list is empty. When the live pass failed the
segment reads `unresolved mentions: @alice, @bob (lookup failed: <reason>)`. The tool's
`details` object additionally carries `unresolvedMentions: { field, name }[]` in the same
order, so a caller can tell *which* field needs repair without parsing text.

The post still lands. This is what the downstream consumer's recovery policy consumes:
see a literal mention, call `slack_cache_refresh`, then `slack_update` the message.

**One repair is impossible and must be reported as such.** When an announce detail exceeds
`uploadThresholdChars`, core uploads the body as a file; `slack_update` can edit the
headline or the `Detail attached.` stub, never the uploaded file's contents. No existing
field distinguishes an upload (`detailTs` is set on the inline path too), so `AnnounceResult`
gains one discriminant, `detailUploaded?: true`, set at the two `deliverDetailUpload` call
sites; when any unresolved mention was in `thread_body`, the executor appends ` (detail
uploaded as a file - slack_update cannot repair it; repost to fix)`.

`linkCollapsedLength` (`lib/slack-core.ts:739-741`) already collapses any `<...>` sequence
to one character, so a substituted mention slightly under-counts against the announce
headline gate. Left as-is: the discrepancy is a few characters and only matters for a
headline within ~10 characters of the limit.

## 3. `email` in the users cache

The user-record type is currently an inline anonymous record in `SlackCacheFile`
(`lib/slack-cache.ts:16`), duplicated inline again in `refreshCache`
(`lib/slack-cache.ts:278`). Extract it once:

```ts
export interface UserEntry {
  id: string;
  display_name: string;
  real_name: string;
  email?: string;
}
```

and use it in both places. `SlackUser` gains `profile.email?: string`
(`lib/slack-cache.ts:150-155`).

Every user-literal passed to `mergeAndWrite` carries `email` when `users.list` returned
it. In `resolveUser` that is **three** call sites, not two - the username hit inside the
live loop (`lib/slack-cache.ts:210`), the unique `display_name` match (`:233`), and the
unique `real_name` match (`:251`) - plus `refreshCache`'s snapshot (`:319-323`) and the
new `resolveMentions` merge. Missing `:233` would leave display-name-resolved users
silently email-less, so the rule is stated as a rule, not an enumeration to be copied:
*every* `UserEntry` construction carries `email` when present.

The key is **omitted** when Slack does not return an email - never written as `""`. Purely
additive: no cache-format version bump, cache files written before this change stay valid,
and the next refresh or lazy write backfills. `refreshCache` keeps its full-replacement
semantics, so an email that disappears from Slack disappears from a refreshed cache.

Email is stored for correlation only - mapping a Slack person to a Linear or GitHub
identity - and is never an input to resolution.

Scope behavior differs by token type and is documented, not enforced: `users:read.email`
is required for user and workspace tokens; classic bot tokens get `email` without it
(`https://api.slack.com/scopes/users:read.email`). Nothing errors when the scope is
absent - the field is simply missing.

`refreshCache`'s return widens to `{ channels: number; users: number; emails: number }`,
where `emails` counts snapshot entries with a present `email` key. The
`slack_cache_refresh` adapter keeps its current prefix (`extensions/slack.ts:421`) and
appends one segment:

```
channels: 87, users: 143 | emails: 141/143
```

When `users === 0` both the ratio segment and the scope note are omitted. When
`emails === 0 && users > 0` the segment reads
`emails: 0/143 (users:read.email scope may be missing)` - the operator's signal that the
one-time admin grant has not landed. `details` continues to be the raw return object, now
with `emails`. `doc/slack.md:128` documents the old count line and is updated with it.

## 4. Per-call unfurl control

Slack unfurls by default: "we unfurl all links in any messages posted by users and Slack
apps" (`https://docs.slack.dev/reference/methods/chat.postMessage`). Today none of the
extension's `chat.postMessage` call sites sends an unfurl argument
(`lib/slack-core.ts:648,884,932`), so every announce headline carrying a permalink or a
ticket link renders a preview card and nothing can suppress it.

`slack_post` gains two optional boolean parameters, `unfurl_links` and `unfurl_media`,
threaded verbatim into `postPlain` and both announce legs. They are **omitted from the API
payload when unset** - the same `if (x !== undefined)` discipline the existing params use
(`lib/slack-core.ts:644-646`) - so the unset behavior is byte-identical to today and Slack's
own default stands. The extension never invents a default, which also sidesteps the two
params' documented asymmetry (`unfurl_links`: "pass true to enable"; `unfurl_media`: "pass
false to disable") and their token-type-dependent effective defaults.

No config key. Unfurl is a property of the individual message, and the callers are skills
and prompts that already compose the message body - the decision belongs beside the text
they write, not in repo-wide settings. A repo that wants a standing convention states it
in its `policyPath` file, which is exactly what feature 1 injects.

Scope within the announce transaction: the headline post (`lib/slack-core.ts:884`) and the
inline detail post (`:932`) both accept the params, so a caller can suppress a preview on
either leg. The `Detail attached.` intro stub in the upload path (`:775`) does not - it is
a fixed string containing no links. `uploadFile`'s `initial_comment` is likewise untouched.

`slack_update` gains nothing: `chat.update`'s argument list has no `unfurl_links` or
`unfurl_media` (verified against `https://docs.slack.dev/reference/methods/chat.update`).
Unfurl is a post-time-only decision, and an already-unfurled message cannot be repaired by
editing it.

## Error handling and edge cases

| Case | Behavior |
|---|---|
| `policyPath` unset | No handler registered. Byte-identical to today. |
| Policy file missing / unreadable / a directory | `status="unreadable"` block injected, one operator warning per session, tools work. |
| Policy file empty or whitespace-only | `status="empty"` block injected, same warn latch. |
| Policy file edited mid-session | Next turn picks it up (per-turn read). |
| Policy path contains `&`, `<`, `>`, `"` | Escaped in the `source` attribute; framing intact. |
| Slack disabled | Nothing registered, including the policy handler. |
| `@here` / `@channel` / `@everyone` | Literal, never looked up, never reported. |
| `\@alice` | Posts `@alice` literally, backslash consumed, not reported. |
| `` `@alice` `` in a code span | Literal (backtick is not a boundary). |
| `*@alice*`, `"@alice"` | Resolved (emphasis and quotes are boundaries). |
| `user@host.com` | Not a candidate (leading-boundary rule). |
| Already-formatted `<@U012AB3CD>` | Not a candidate, passed through. |
| `@alice` unknown after live pass | Literal, listed in `unresolved mentions:`. |
| `@alice` ambiguous | Literal, listed in `unresolved mentions:`. |
| Alias-only match, cache has no `snapshot_at` | Not trusted from cache; goes to the live pass. |
| Ten unknown tokens across `text` + `thread_body` | One `users.list` pagination total. |
| `users.list` fails during the mention pass | All outstanding candidates stay literal, `lookup failed: <reason>` in the report, post proceeds. |
| Unresolved mention inside an uploaded detail file | Reported with the not-repairable-by-`slack_update` note; repost required. |
| Substitution pushes `text` past `MAX_TEXT_LENGTH` | Core rejects with `text_too_long` after substitution - a previously-fitting message can now fail; the error names the limit and the operator shortens the text. |
| Mentions in `blocks` | Not scanned. Documented. |
| `users:read.email` absent | No `email` keys; `emails: 0/N (users:read.email scope may be missing)` on refresh. |
| `slack_cache_refresh` returns zero users | No ratio segment, no scope note. |
| Pre-existing cache file without `email` / `snapshot_at` | Valid; `email` backfilled on next write, `snapshot_at` on next full refresh. |
| `unfurl_links` / `unfurl_media` unset | Params omitted from the payload; identical to today's behavior. |
| Unfurl params on an announce | Applied to the headline and the inline detail post, not to the `Detail attached.` stub. |
| Caller wants to un-unfurl an existing message | Not possible - `chat.update` has no unfurl argument. Delete and repost. |

## Testing approach

`node --test`, extending the three existing suites; no live network, using the scripted
API harness already in place.

- `test/slack-cache.test.ts` - `resolveMentions`: cache hit substitution; deny list;
  `user@host.com` non-match; `<@U...>` non-match; each allowed boundary (start-of-string,
  whitespace, `(`, `[`, `*`, `_`, `"`, `'`) and the backtick exclusion;
  trailing-punctuation trim with the dotted-username retry; `\@alice` escape (backslash
  consumed, absent from `unresolved`) and inert `x\@y`; not-found -> literal +
  `unresolved`; ambiguous -> literal + `unresolved`; alias match without `snapshot_at`
  forced to the live pass, and trusted with it; **batching** (unknown tokens split across
  `text` and `thread_body` produce exactly one `users.list` call, asserted via the harness
  call counter); writeback of newly resolved users; `MAX_LIST_PAGES` and repeated-cursor
  termination; transport error -> all literal + `lookupError`, no throw. Plus: `email`
  written on all three `resolveUser` branches and in `refreshCache`, key omitted when
  absent, backfill onto a pre-existing email-less cache file, `snapshot_at` written by
  `refreshCache` and preserved by `mergeAndWrite`, and the `emails` count in the return.
- `test/slack-config.test.ts` - `policyPath` coercion; absolute passthrough;
  repo-relative resolution against `repoRoot` from a subdirectory; unset -> undefined; no
  env override recognized. Registration-level behavior reuses the existing mock
  `ExtensionAPI` harness in this file: handler registered only when `enabled && policyPath`,
  chained append onto the incoming `systemPrompt`, per-turn reread reflecting an edited
  file, unreadable/empty statuses, and warn-once across three turns.
- `test/slack-core.test.ts` - `buildPolicyBlock` over fixture inputs (ok / unreadable with
  errno / empty, plus attribute escaping), and the unresolved-suffix helper: omitted when
  empty, first-seen dedup order, `lookup failed` variant, uploaded-detail variant. Plus
  unfurl: params absent from the captured `chat.postMessage` payload when unset, present
  with `false` when explicitly `false` (the value must survive, not be dropped as falsy),
  and applied to both announce legs but not to the `Detail attached.` stub.
- Manual smoke (added to `doc/slack.md`'s checklist): a session with `policyPath` set
  shows the policy in the system prompt; a bad path warns once and still posts; a post
  containing a known and an unknown mention renders one link and one literal, with the
  literal named in the result line.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/slack.md` (the `policyPath` key and its
  injection/degradation contract; mention token grammar, escaping, boundary set,
  unresolved reporting and its uploaded-detail limitation, the `blocks` exclusion; the
  optional cache `email` and `snapshot_at` fields with the per-token-type scope note; the
  changed `slack_cache_refresh` count line at `doc/slack.md:128`; the `slack_post`
  `unfurl_links` / `unfurl_media` params with the omitted-when-unset contract and the
  `slack_update` limitation; two smoke-checklist entries), `README.md` (slack feature
  bullet), `CHANGELOG.md`
- Derived / memory docs invalidated: `AGENTS.md` slack runtime-boundary paragraph - its
  "zero tools and zero side effects when disabled" claim must now enumerate the
  `before_agent_start` surface as also gated

## Open questions

None blocking. Two decisions recorded as deliberate, revisitable defaults:

- `linkCollapsedLength` under-counts a substituted mention by a few characters against the
  announce headline gate. Left unfixed (YAGNI).
- The policy block is appended after whatever the previous `before_agent_start` handler
  produced, so ordering across extensions follows extension-load order. No ordering
  control is introduced.
