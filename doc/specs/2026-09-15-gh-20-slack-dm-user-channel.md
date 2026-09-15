# Slack DM targets: accept `U...` / `@name` as `channel` (#20)

**Ticket:** [jjuraszek/pi-quiver#20](https://github.com/jjuraszek/pi-quiver/issues/20)
**Goal:** Every `channel`-taking slack tool accepts a user ID or `@name` and operates on that user's DM, resolving it to a `D...` conversation ID in one place.

Supersedes `doc/specs/2026-08-29-gh-7-slack-extension.md`, channel-resolution / "opening a DM is out of scope" stance only.

## Problem

`resolveChannel` (`lib/slack-cache.ts:122-171`) accepts `#name` and raw `C|D|G` IDs and rejects `@name` with `invalid_channel` ("opening a DM is out of scope"). A raw `U...` misses `RAW_CHANNEL_ID`, runs a full paginated `conversations.list` scan and fails with `name_not_found`. An agent therefore cannot DM a person without already knowing the `D...` ID, which only exists after someone has opened the DM. All six tool descriptions in `extensions/slack.ts` and `doc/slack.md:179-182` advertise "user @names not accepted".

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | All six channel-taking tools (`slack_post`, `slack_thread`, `slack_update`, `slack_delete`, `slack_pin`, `slack_upload`) accept `U...`/`W...` IDs and `@name`. | User: "a DM is like a private channel, same operations". Wider than ticket AC 1-5, which name only post/thread. |
| D2 | Resolution lives in `resolveChannel`; its output is always a conversation ID Slack accepts as `channel`. Tool handlers do not change, with one exception: `slack_thread` skips `resolveChannel` when `permalink` is supplied (see Design). | All six handlers already call `resolveChannel` (`extensions/slack.ts:282,318,393,420,446,484`). One change point, uniform contract. |
| D3 | `U/W`/`@name` inputs are turned into a `D...` via `conversations.open { users: <U> }` for every tool and both identities, including `slack_post { as: "bot" }`. | `conversations.replies`, `chat.update`, `pins.add`, `files.completeUploadExternal` require a conversation ID; a post-only shortcut would create two resolver modes for one concept. Deviation from the ticket Idea ("no `conversations.open` needed") and from AC 3's "passes `U...` unchanged" wording - recorded in Ticket deviations. |
| D4 | No caching of the `U -> D` mapping. | Slack returns the same DM ID for the same user and identity; the call is cheap and idempotent. A cache entry would be a second source of truth. |
| D5 | `im:write` (open/post) and `im:history` (user-token DM thread reads) are documented required scopes. A missing scope is surfaced as Slack's own error, never a local preflight. | Ticket AC 3: Slack is the authorization authority. |
| D6 | `resolveUser` trusts cached display-name / real-name aliases only when the cache carries `snapshot_at` (a complete snapshot), matching `resolveMentions`' `aliasTrusted` gate (`lib/slack-cache.ts:343`). Username matches stay trusted; without a full snapshot, alias inputs fall through to the live `users.list` path. | Today `resolveUser` (190-207) returns the single alias match from a partial cache; for a DM target that sends the message to the wrong person. Gating in `resolveUser` itself fixes every user position at once instead of adding a DM-only mode. No cache format change and no migration: `snapshot_at` is already written by `slack_cache_refresh` (`lib/slack-cache.ts:531`) and `doc/slack.md:147-154` already documents alias trust this way; a cache without it keeps working, with alias inputs taking the live path. |

## Design

### `resolveChannel` (`lib/slack-cache.ts`)

New contract: input is `#name`, `C|D|G` ID, `@name`, or `U|W` ID; output is a conversation ID.

Resolution order:

1. `RAW_CHANNEL_ID` match -> return as-is (unchanged; a `D...` input makes zero API calls).
2. `RAW_USER_ID` match, or input starts with `@` -> `userId = await resolveUser(input, ctx)` (existing: U/W passthrough, cache -> live `users.list`, `name_not_found` / `ambiguous_user` errors reused verbatim; alias trust per D6) -> `return openDm(userId, ctx)`.
3. Otherwise the existing `#name` channel lookup (unchanged).

The `@`-rejection branch and its "out of scope" message are deleted.

`openDm(userId, ctx)` - private helper in `slack-cache.ts`:

```ts
const data = await ctx.apiCall("conversations.open", ctx.token, { users: userId }, { retry: true, signal: ctx.signal });
const channel = data.channel as { id?: unknown } | undefined;
if (typeof channel?.id !== "string") {
	throw new SlackError("unexpected_response", 'conversations.open returned an unexpected response: missing "channel.id".');
}
return channel.id;
```

- `retry: true` is explicit: `makeApiCall` has no implicit retry (an omitted `retry` throws `rate_limited` on the first 429), and `conversations.open` is idempotent - Slack returns the existing DM - so retrying is safe.
- `ok:false` -> `makeApiCall` already throws the mapped `SlackError` (`missing_scope`, `user_not_found`, `cannot_dm_bot`, `user_disabled`, ...); `openDm` does not catch or rewrap. Code, message and `data` reach the caller unchanged (AC 3 "verbatim").
- `ok:true` without a string `channel.id` -> `unexpected_response`, the same classification `requireResponseString` uses for `chat.postMessage` / `files.getUploadURLExternal` (`lib/slack-core.ts:686-689`). Not `outcome_unknown`: that code means "Slack accepted a mutation, do not re-invoke", and nothing was posted here.

### `slack_thread` permalink precedence (`extensions/slack.ts:282`)

Today the handler resolves `params.channel` whenever it is supplied and `readThread` then lets `permalink` override it (`lib/slack-core.ts:587-592`). With DM resolution an ignored `channel: "@bob"` would open an unrelated DM (or fail on `missing_scope`) before reading a valid permalink. The handler changes to resolve `channel` only when `permalink` is absent:

```ts
const channel = params.permalink === undefined && params.channel !== undefined
	? await resolveChannel(params.channel, cacheCtx)
	: undefined;
```

### Data flow (`slack_post` example)

```
channel: "@bob" -> resolveUser -> U000BOB -> conversations.open -> D000XYZ -> chat.postMessage { channel: D000XYZ }
result: { channel: "D000XYZ", ts, permalink }
```

`postPlain` (`lib/slack-core.ts:704-729`) and `announce` (999-1084) already report Slack's response `channel`, so the result surfaces the `D...` with no core change (ticket AC 1). `slack_update`, `slack_delete`, `slack_pin`, `slack_upload` receive the `D...` and behave exactly as with a private channel.

### Identity

The hop runs with whichever token the tool's `as` identity selected. A user-token open yields the user's own DM with that person; a bot-token open yields the app's DM with that person - two different `D...` conversations. Consequences, documented in `doc/slack.md`:

- Follow-up `slack_update` / `slack_delete` / `slack_pin` on a DM post use the returned `D...` under the same `as` identity that posted. Re-resolving `@name` under the other identity opens a different conversation and does not address the posted message.
- `slack_thread` always runs on the user token, so `slack_thread { channel: "@bob" }` reads the user's own DM with bob; a `D...` returned by `slack_post { as: "bot" }` is not readable there (`channel_not_found`).

### Surface text

- `extensions/slack.ts` tool descriptions at lines 272/274, 299/302, 381/384, 411/414, 437/440, 463/466: drop "user @names not accepted", replace with `#name, channel ID, @name, or user ID (DM)`.
- `doc/slack.md` "Tools" section: rewrite the grammar paragraph at 179-182 (remove "opening a DM is out of scope"; state the four accepted forms) and add, directly below it, a "DM targets" paragraph: `conversations.open` hop, `im:write` on the identity's token for every DM target, `im:history` on the user token for `slack_thread` DM reads, the identity boundary above, and that a missing scope surfaces as Slack's `missing_scope`. `doc/slack.md` has no scope list today; this paragraph is the insertion point.
- `README.md`: no "@names not accepted" or grammar claim exists (verified: only mention-resolution blurbs at 21 and 73); append "DM targets by `@name` / user ID" to the slack row at line 73. No removal needed.
- `CHANGELOG.md` `## Unreleased`: one bullet referencing #20.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| `@name` unknown | `resolveUser` exhausts `users.list` -> `name_not_found`; zero `conversations.open` calls |
| `@name` ambiguous | `ambiguous_user`, unchanged |
| `@name` matches a display/real-name alias in a cache without `snapshot_at` | alias not trusted (D6); live `users.list` decides |
| `conversations.open` `ok:false` (`missing_scope`, `user_not_found`, `cannot_dm_bot`, `user_disabled`) | mapped `SlackError` propagates unchanged through the existing `guarded` surface; no local preflight, no rewrap |
| `conversations.open` `ok:true`, no `channel.id` | `SlackError("unexpected_response")`; safe to re-invoke |
| `conversations.open` 429 | `retry: true` - transport backoff, idempotent |
| `W...` (Enterprise Grid) | accepted by `RAW_USER_ID`, passed to `conversations.open` verbatim |
| Existing `D...` input | short-circuits at step 1, no hop - backwards compatible |
| `slack_thread { permalink, channel }` | `channel` is ignored and never resolved; no `conversations.open` |
| DM `D...` from one identity used under the other | Slack returns `channel_not_found`; documented, not special-cased |

## Out of scope

- Multi-person DMs (`users: "U1,U2"` -> mpim). `channel` stays a single value.
- Caching the `U -> D` mapping (D4).
- Adding `im:write` / `im:history` to any app manifest; docs only.
- Block Kit rendering / raw mode in `slack_thread` (#21) and the user token-file ladder (#22).
- A local preflight for scopes or identity mismatches.

## Testing

Resolver units - `test/slack-cache.test.ts`, scripted `apiCall` harness (`scriptedApiCall` returns `entry.result` verbatim and throws `entry.error`; Slack `ok:false` mapping happens in `makeApiCall`, so resolver-level error tests inject a `SlackError` via `entry.error`). Fixtures satisfy `RAW_*_ID` (`/^[CDG][A-Z0-9]{5,}$/`, `/^[UW][A-Z0-9]{5,}$/`): `U000ABC`, `D000XYZ`. Cache is seeded with `{ team_id, channels: {}, users: {} }` like the exhaustion test at 217 so `mergeAndWrite` does not add an `auth.test` call.

- Replace the "rejects `@bob`" test (235-246) with: `@bob` -> `users.list` -> `conversations.open { users: "U000BOB" }` -> returns `D000XYZ`; assert the exact call sequence.
- `U000ABC` -> exactly one `conversations.open`, no `users.list`, returns `D000XYZ`.
- `D000XYZ` -> zero API calls.
- `@nope` -> `users.list` exhausted -> `SlackError("name_not_found")`, zero `conversations.open`.
- `conversations.open` entry with `error: new SlackError("cannot_dm_bot", ...)` -> the same `SlackError` instance/code propagates, message unchanged.
- `conversations.open` result `{ ok: true }` without `channel.id` -> `unexpected_response`.
- `conversations.open` options assert `{ retry: true, signal }`.
- D6: cache without `snapshot_at` holding user `alice` with `display_name: "bob"` -> `@bob` does not return alice's ID from cache; `users.list` is called. Same cache with `snapshot_at` -> alias trusted, no `users.list`.

Adapter tests - `test/slack-config.test.ts`, existing `makeMockApi` (615) + `withFakeFetch` (974) harness that executes registered tools end to end through the real transport mapping:

- `slack_post { as: "user", channel: "U000ABC", text }` -> fetch sequence `conversations.open`, `chat.postMessage { channel: "D000XYZ" }`; tool output contains `D000XYZ` and `ts` (AC 1).
- `slack_post { as: "bot", channel: "@bob" }` with `conversations.open` answering `{ ok: false, error: "missing_scope" }` -> tool error shows `missing_scope` unchanged (AC 3).
- `slack_thread { channel: "@bob", ts }` -> `users.list`, `conversations.open`, `conversations.replies { channel: "D000XYZ" }` (AC 5).
- `slack_thread { permalink, channel: "@bob" }` -> no `users.list`, no `conversations.open`.

`test/slack-core.test.ts`: unchanged - core receives a conversation ID as before.

Verification: `env -u PI_CODING_AGENT_DIR npm run test:all`.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/slack.md` (Tools grammar paragraph + new "DM targets" paragraph: scopes, identity boundary); `README.md` slack row at line 73 (DM-target mention); `CHANGELOG.md` `## Unreleased`
- Derived / memory docs invalidated: none (AGENTS.md slack line names no grammar)

Materiality bar: `reference/documentation-impact.md` (brainstorming skill). Tool descriptions in `extensions/slack.ts` are implementation surface, not doc-impact entries.

## Ticket deviations (to note on #20)

- AC scope widened to all six tools (D1).
- `conversations.open` is used for every DM target, including `slack_post { as: "bot" }` (D3) - the ticket's Idea said it is unnecessary and AC 3 says the bot path "passes `U...` unchanged". Slack's authorization error still surfaces verbatim, which is AC 3's intent.
- AC 6 names `test/slack.test.ts`, which does not exist; resolver coverage lands in `test/slack-cache.test.ts`, tool-level coverage (post output with `D...`/`ts`, `slack_thread` DM forms, error propagation) in `test/slack-config.test.ts`.
- `im:history` added to the documented scopes alongside the ticket's `im:write` (D5).
- `resolveUser` alias trust gated on `snapshot_at` (D6) - not in the ticket, required so an `@name` DM cannot land on the wrong person.
