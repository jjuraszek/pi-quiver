# slack_thread: Block Kit flattening + raw JSON mode

**Issue:** jjuraszek/pi-quiver#21
**Date:** 2026-09-15
**Status:** approved at design review, pending spec gate

## Goal

`slack_thread` currently renders only a message's `text` fallback, so any message
whose body lives in Block Kit shows as an empty or misleading line, and agents
cannot obtain the `blocks` JSON needed to compose `slack_update` edits. This spec
adds two things to `slack_thread` only: (1) default-mode flattening of Block Kit
blocks into the existing one-line-per-message rendering, and (2) an opt-in
`raw?: boolean` mode that returns the thread's messages as parseable JSON.

## Out of scope

- `slack_search` Block Kit rendering - Slack's `search.messages` returns `text`
  only, no `blocks` (probed 2026-09-15). Path for search hits: `slack_thread` on
  the hit's channel + ts.
- Rich rendering of image / divider / actions / input blocks beyond `[<type>]`.
- New tool, config key, or default behavior change - `raw` is a param, opt-in.
- Issue #20 (DM channel routing) and #22 (user-level token files).

## Current behavior (verified 2026-09-15)

- `renderThreadLine` (`lib/slack-core.ts:574-579`) renders
  `${author} | ${ts} | ${text}` from string `message.text` only, newlines
  collapsed to spaces; a blocks-only message renders an empty body.
- `readThread` (`lib/slack-core.ts:581-651`) paginates `conversations.replies`
  (caps: `THREAD_PAGE_CAP = 50`, `THREAD_MESSAGE_CAP = 5000`), maps every message
  through `renderThreadLine`, joins with `\n`, then `gateOutput(rendered, "thread")`.
- `gateOutput` (`lib/slack-core.ts:459-494`): inline when UTF-8 byte length
  <= 32,000 AND line count <= 1,000; otherwise writes the full string under
  `tmpdir()/pi-slack` (SHA-256 slug) and returns a <= 60-line / <= 4,000-byte
  preview plus the file path.
- `ThreadResult` (`lib/slack-core.ts:522-530`):
  `{ output, spilled, path?, complete, nextCursor?, caveat?, messageCount }`.
- `threadResultText` (`extensions/slack.ts:164-169`) renders `result.output`, a
  blank line, `complete: ...`, optional `next_cursor: ...`, then `caveat`.
- Block Kit posting already accepts `Type.Array(Type.Unknown())` and forwards
  `blocks` unchanged; no flattening helper or raw mode exists anywhere.

## Design

### 1. `renderBlocks(blocks: unknown[]): string` - new pure function in `lib/slack-core.ts`

Per-block flattening:

| Block type | Renders |
|---|---|
| `header` | `block.text.text` |
| `section` | `block.text.text` (if present) plus each of `block.fields[].text`, space-separated |
| `context` | each element rendered by the context mapping below, space-separated |
| `rich_text` | recursive walk (see below) |
| any other `type` | `[<type>]` |
| non-object block or non-string `type` | `[unknown]` |

Context mapping: context `elements` are Slack text objects - `plain_text` or
`mrkdwn` render their `text` verbatim; any other element type (e.g. `image`)
renders `[<type>]`.

Rich-text inline element mapping (applies only inside `rich_text` containers):
`text` -> its `text` verbatim; `user` -> `<@{user_id}>`; `channel` ->
`<#{channel_id}>`; `link` -> its `text` if a non-empty string else its `url`;
`emoji` -> `:{name}:`; any other element type -> `[<type>]`. When the required
field (`user_id`, `channel_id`, `text`/`url`, `name`) is missing or not a
string, the element renders `[<type>]` - never `<@undefined>`.

`rich_text` containers recurse: `rich_text_section` renders its `elements`;
`rich_text_list` renders each item (items are sections); `rich_text_quote` and
`rich_text_preformatted` render their `elements`. Composition: inline elements
within one container concatenate with no added separator (whitespace lives in
the `text` runs, so adjacent styled fragments like `"Hel"` + `"lo"` stay
`Hello`); sibling containers and list items join with a single space. The
block-level ` / ` joiner is never used inside a block. Only the five named
inline elements render text; all others use the `[<type>]` convention
(ratified questionary Q2).

Known blocks missing their payload (e.g. `section` with no `text` and no
`fields`, `header` with no `text`) contribute nothing; empty contributions are
dropped before the join, so no `a /  / b` separators appear.

Rendered blocks are joined by ` / `. mrkdwn passes through verbatim - no
unescaping or entity decoding; the flattener rearranges, it does not interpret.
Multi-line text inside blocks collapses newlines to spaces, matching the
existing `text` handling and preserving the one-line-per-message envelope.

### 2. `renderThreadLine` body selection

Unchanged signature and envelope (`author | ts | body`). Body selection becomes:

1. `blocks` is a non-empty array (`Array.isArray(message.blocks) &&
   message.blocks.length > 0`) and flattening yields a non-empty string ->
   flattened blocks.
2. Otherwise -> `message.text` exactly as today (ratified questionary Q3: the
   empty-flatten and malformed-`blocks` cases fall back to Slack's own
   notification text).

Messages without `blocks` are byte-identical to today's rendering.

### 3. `readThread({ ..., raw? })` - raw mode

`readThread` gains `raw?: boolean` (default false). Pagination, caps, cursor,
and caveat logic are untouched; the modes differ only in what string gets gated:

- Compact (default): as today, `renderThreadLine` per message, `\n` join.
- Raw: the accumulated `messages` array serialized with
  `JSON.stringify(messages, null, 2)` - a pure, pretty-printed JSON array of
  the raw message objects, no envelope, no transformation.

Either way the resulting string goes through `gateOutput(rendered, "thread")`
unchanged. Raw output therefore parses as JSON when inline, and - when spilled -
the file under `tmpdir()/pi-slack` is the complete valid JSON array (the
round-trip path for large threads); the inline preview is the first <= 60 lines
of pretty JSON plus the path line, same mechanism as compact mode. Note that
pretty JSON emits roughly 20-80 lines per message, so the 1,000-line inline cap
typically trips before the byte cap - expect the spill file for anything beyond
a short thread.

"Byte-identical" (issue AC3) is defined as value-identical: raw mode
re-serializes parsed JSON, so key order and whitespace are ours; each message -
including its `blocks` - deep-equals what `conversations.replies` returned.

### 4. Extension adapter (`extensions/slack.ts`)

- `slack_thread` schema gains `raw: Type.Optional(Type.Boolean(...))` with a
  description covering both modes; the flag passes through to `readThread`.
- `threadResultText` gains a second parameter (ratified questionary Q1):
  `threadResultText(result: ThreadResult, raw = false)`, called from the
  `slack_thread` execute as `threadResultText(result, params.raw === true)`.
  `ThreadResult` is unchanged - no mode field is added. In raw mode the
  function returns `result.output` alone - the status trailer (`complete:`,
  `next_cursor:`, caveat) is omitted so the content stays parseable JSON.
  `complete`, `nextCursor`, `caveat`, and `messageCount` remain in `details`.
- Consequence, accepted: in raw mode an incomplete thread (pagination cap,
  429 throttle, or error) produces a partial JSON array with no in-content
  signal - pi does not send `details` to the model, so `complete: false`,
  `nextCursor`, and the caveat are invisible inline; the spill preview also
  starts with `[` exactly like a complete array, so a caller cannot tell by
  inspection. Caller guidance (stated in the `slack_thread` description and
  `doc/slack.md`): attempt `JSON.parse` on the content; on failure read the
  path named in the truncation line; run compact mode first when completeness
  matters - raw mode is for block extraction and round-trips.

### Data flow

`conversations.replies` pages accumulate `messages[]` as today -> compact:
`renderThreadLine` + `\n` join / raw: `JSON.stringify(messages, null, 2)` ->
`complete`, `nextCursor`, `caveat`, and `messageCount` remain in the tool
result `details` in both modes; raw mode changes only the content text.

## Error handling and edge cases

- **Malformed blocks**: non-object block or non-string `type` -> `[unknown]`;
  known block missing its payload contributes nothing; whole-thread empty
  flatten falls back to `text` (Q3).
- **mrkdwn verbatim**: no unescaping, no entity decoding.
- **Spilled raw output**: the spill file is complete valid JSON; the inline
  preview is not parseable (bounded excerpt) but names the file.
- **Unchanged surface**: pagination caps, cursor errors, permalink resolution,
  `not_in_channel`/auth caveats, bot `username` fallback, and subtype messages
  behave exactly as today in both modes.

## Testing

TDD under `node --test`; full gate is `npm run test:all` (agents-core check +
all suites + `tsc --noEmit`) run under `env -u PI_CODING_AGENT_DIR`.

- `test/slack-core.test.ts` (injected-`ApiCall` style, as the existing thread
  tests): header; section with `fields`; context with both `mrkdwn` and
  `plain_text` element fixtures; rich_text covering `text`, `user`, `link`,
  `emoji` plus an unlisted inline element rendering `[<type>]`; exact-output
  pins for adjacent text fragments (no added separator) and nested
  list/quote/preformatted containers (single-space joins); unknown block type;
  malformed block (`[unknown]`); inline element with a missing required field
  (`[<type>]`); empty-flatten text fallback; messages without `blocks`
  byte-equal to today's rendering.
- Raw mode, same suite: output parses as JSON; each message deep-equals the
  mock `conversations.replies` response (`blocks` untouched); spilled raw
  output writes a parseable JSON file, with the spill triggered by the
  1,000-line cap (pretty JSON spills early), not only the byte cap.
- Extension fake-fetch suite (`test/slack-config.test.ts`, `withFakeFetch`
  harness): schema accepts `raw`; raw-mode result omits the
  trailer; AC4 round-trip - raw output for a fixture blocks message, one text
  field edited, fed to `slack_update`, asserting `chat.update` received the
  edited blocks.

## Acceptance criteria (issue #21, with ratified deviations)

1. `slack_thread` on a message with `blocks` renders flattened blocks in place
   of the fallback `text`, per the mapping in Design section 1; blocks joined
   by ` / `; other block types as `[<type>]`.
2. Messages without `blocks` render exactly as today; existing `slack_thread`
   tests pass unchanged.
3. `slack_thread { ..., raw: true }` returns the thread messages as JSON, each
   message's `blocks` value-identical (deep equality) to the
   `conversations.replies` response; over the size cap the JSON spills to a
   file like the compact rendering.
4. Round trip against mocked Slack responses: `raw: true` output for a fixture
   blocks message, one text field edited, fed to `slack_update` as `blocks` -
   the `chat.update` request carries the edited blocks.
5. **Deviation (ratified)**: the issue names `test/slack.test.ts`, which does
   not exist; coverage lands in `test/slack-core.test.ts` (flattened rendering
   for header, section incl. `fields`, context, rich_text elements, unknown
   block type, raw mode) plus the extension fake-fetch suite.
6. Documentation per Documentation impact below. **Deviation (ratified)**: the
   CHANGELOG bullet references **#21**, not #20 - #20 is the separate DM
   routing issue; the issue text's "#20" is a typo.

## Documentation impact

(Materiality bar: `reference/documentation-impact.md` in the brainstorming skill.)

- Feature / user-facing docs introduced: none
- Materially amended existing docs: doc/slack.md (both modes; raw caller guidance: partial arrays have no in-content signal, parse-or-read-the-spill-path, compact mode for completeness), README.md (`extensions/slack.ts` row at :73 and prose at :257), CHANGELOG.md (create `## Unreleased` above `## v6.0.1`; bullet references #21 per the ratified deviation)
- Derived / memory docs invalidated: none

## Deviations from issue #21 (ratified at design review)

1. AC5's `test/slack.test.ts` -> `test/slack-core.test.ts` + extension suite
   (no such test file exists; thread tests live in the core suite).
2. AC6's CHANGELOG reference `#20` -> `#21` (issue typo; #20 is the DM feature).
3. AC3's "byte-identical" -> value-identical / deep structural equality (HTTP
   bytes cannot survive parse/serialize).

## Predecessor

None for this design. `doc/specs/2026-08-29-gh-7-slack-extension.md` owns the
existing read-path contract this spec extends; its only superseded scope is the
house-policy stance (per its banner, superseded by
`doc/specs/2026-09-01-gh-9-slack-repo-policy-gap.md`), which this spec does not
touch. No supersession banner is written.

## Open questions

None - all recon open questions were resolved in the questionary (Q1 raw-mode
shape: pure JSON array, trailer omitted; Q2 rich-text depth: containers
recurse, five named inline elements only; Q3 empty-flatten fallback: `text`).
