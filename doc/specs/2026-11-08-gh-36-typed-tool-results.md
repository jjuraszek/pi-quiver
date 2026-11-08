# Typed tool results for codemode scripts and a script-only cache refresh

**Goal:** `doc_to_md`, `fetch`, `slack_thread`, and `slack_search` declare an `outputSchema` and return a `structuredContent` object that codemode scripts receive typed; `slack_cache_refresh` is reachable from scripts only; the three largest tool descriptions shrink so the codemode listing stays within its budget; the `pi-quiver` CLI keeps its text, `--json`, exit codes, and clean-install runtime unchanged.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Ticket:** #36 (jjuraszek/pi-quiver)
**Branch:** `jacek/gh-36-typed-results` (base `main` @ 19f7d9b)

## Problem

A codemode script that calls `await tools.doc_to_md({ path })`, `tools.fetch({ url })`, `tools.slack_thread(...)`, or `tools.slack_search(...)` today receives the rendered text and has to parse it: the host's `toScriptValue` hands a script `structuredContent` only when the tool declares `outputSchema` (host `dist/extensions/codemode/execute.js:411-425`), and none of the four does. Each extension already computes the data the text is rendered from, then returns only `content` text plus UI `details` (`extensions/fetch.ts:48-54`, `extensions/doc_to_md.ts:44-51`, `extensions/slack.ts:267-274,296-303`). The two Slack cores go further and discard their message arrays after rendering (`lib/slack-core.ts:566-567`, `:736-738`), so a script can only get at messages through the `raw` text mode and a `JSON.parse` the `slack_thread` description tells the model to try.

`slack_cache_refresh` is a recovery tool - run after `channel_not_found` or a rename - but it is declared to the model like any other Slack tool, and the shared `channel_not_found` hint ("check the name or run slack_cache_refresh", `lib/slack-core.ts:311-312`) is shown unchanged to `pi-quiver` CLI callers (`bin/pi-quiver.ts:331`) who have no such tool.

Framing: kept. The ticket's premise that the dev pin must move first is stale - commit 19f7d9b already pins `@earendil-works/pi-coding-agent` at `^1.5.0` (`package.json:97`), so the pin half of AC 9 is already true on `main` and this spec makes no pin change; the README minimum-version sentence remains. The host APIs this spec uses - `ToolDefinition.outputSchema`, `exposure`, `AgentToolResult.structuredContent` - landed in host 0.99.0 (host `CHANGELOG.md:557`) and are in the installed 1.5.0 types (`dist/core/extensions/types.d.ts:489-497`, `pi-agent-core/dist/types.d.ts:369-379`). The host never validates `structuredContent` against the schema, so tests here do.

Two constraints from the user bind every design choice:

- `pi-quiver doc-to-md` is in constant use from Claude Code as a CLI (`skills/doc-to-md/SKILL.head.md:11-16` invokes `npx -y pi-quiver@<version> doc-to-md [--json] ...`). `@sinclair/typebox` is a devDependency (`package.json:99`) and the CLI is bundled with `--packages=external` (`package.json:51`), so any `lib/*` module reachable from `bin/pi-quiver.ts` that imports TypeBox breaks the packed CLI at runtime. Schemas therefore live only in `extensions/*.ts`; `lib/*` carries pi-free, TypeBox-free data projections.
- Tool descriptions must not eat the codemode context budget. Measured on host 1.5.0 with `renderToolSample` from `@earendil-works/pi-codemode/declarations` over the registered definitions alone (budget `codemode.inlineBudget` = 3000 tokens, host `core/settings-defaults.js:58`): `doc_to_md` 1506 tokens (description 635 + input type 872), `slack_post` 1258, `slack_update` 924, `slack_thread` 477, `fetch` 304, `slack_cache_refresh` 149, the rest under 300. Those numbers undercount the production catalog: the host builds each section with `toCodemodeDeclaration(tool, guidelines)` (host `dist/extensions/codemode/tool.js`), which appends the tool's `promptGuidelines` after the description (`slack_post` with its guidelines is 1877 today) and renders the full output type when an `outputSchema` is declared; `createCodemodeDescription` then drops whole sections that do not fit `inlineBudget`. In the default `codemode.mode: "on"` only non-`direct` tools are listed in the codemode description; `direct` tools get one appended `Codemode: tools.x(args) resolves to <top-level field names>` line (host `tool.js:216-246`). Moving `slack_cache_refresh` to `codemode` exposure puts its section into that listing, and `mode: "only"` lists every tool, where `doc_to_md` plus `slack_post` alone consume most of the budget.

Scope (user, 2026-11-08): all four typed-result tools plus the exposure change (no cut), plus a description diet for `doc_to_md`, `slack_post`, and `slack_update`.

## Acceptance criteria

Ticket #36, checkbox list, rows verbatim:

- [ ] In a codemode script, `await tools.doc_to_md({ path })` resolves to an object whose `savedTo`, `pageCount`, and `outline` equal the values printed in the text handle; with `info: true` it resolves to the info shape (page count, metadata, TOC or sheet inventory); both objects validate against the declared `outputSchema` (pi forwards them to scripts unvalidated).
  in-scope
- [ ] `await tools.fetch({ url })` resolves to an object with `spilled: false`, `content` (the inlined body or converted Markdown), and `contentType` when the response was inlined, or `spilled: true`, `file` (the temp path), and `contentType` when it was written to disk; a script branches on `spilled`, never on the text; the object validates against the declared `outputSchema`.
  in-scope
- [ ] `await tools.slack_thread({ channel, ts })` resolves to an object carrying the messages, `complete`, `next_cursor`, `message_count`, and the throttle caveat when present; `raw` changes only the text content, the structured object is identical in both modes; when the thread exceeds the inline size gate the object carries the spill file path in place of the messages and still carries `complete` and `next_cursor`; the object validates against the declared `outputSchema`.
  in-scope
- [ ] `await tools.slack_search({ query })` resolves to an object carrying the matches plus `total`, `page`, and `page_count`, with the same spill behavior and schema validation.
  in-scope
- [ ] A direct (non-script) call of each of the four tools returns the same text content as before this change (the shapes pinned in `test/doc_to_md.test.ts`, `test/fetch.test.ts`, and `test/slack-config.test.ts`).
  in-scope
- [ ] The `slack_thread` description no longer instructs the model to "try JSON.parse, on failure read the file"; it names the structured fields instead.
  in-scope
- [ ] `slack_cache_refresh` is registered with `exposure: "codemode"`: in a session with Slack enabled and codemode active, the model's declared tool list contains the other `slack_*` tools and not `slack_cache_refresh`, and `await tools.slack_cache_refresh({})` from a script runs the refresh.
  in-scope
- [ ] The `channel_not_found` hint rendered in pi tool results names the codemode call (`tools.slack_cache_refresh({})`); the same hint rendered by the `pi-quiver` CLI names a recovery the CLI caller can perform and does not mention a pi tool; the tool's description and `doc/slack.md` state that the refresh is reachable from codemode scripts only.
  in-scope
- [ ] `package.json` pins the `@earendil-works/pi-coding-agent` dev dependency at `^1.5.0` or later, and `README.md` names the minimum pi version for typed results and the script-only refresh tool.
  in-scope
- [ ] `CHANGELOG.md` `## Unreleased` has a bullet for the typed results and one for the exposure change; `doc/doc-to-md.md`, `doc/fetch.md`, and `doc/slack.md` document each tool's structured result shape.
  in-scope

## Legs

### Leg: jjuraszek/pi-quiver
branch: jacek/gh-36-typed-results
contract:
- create: git worktree add <home> -b <branch>
- destroy: git worktree remove <home> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: env -u PI_CODING_AGENT_DIR npm run test:all (run in the worktree); npm pack --dry-run for the files list
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/fetch.md
Rules: doc/doc-to-md.md
Rules: doc/slack.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: none
design: owns every path in Design; observable outcomes are the ten acceptance rows above plus the description-diet ceilings in Tests.

## Design

The contract stays where the repo already splits it: `lib/*-core.ts` modules return data, `extensions/*.ts` own the TypeBox schemas and build the pi result. No `lib/*` module gains a `@sinclair/typebox` import. Every `outputSchema` is a `Type.Object` or a `Type.Union` of `Type.Object`s with no property-level `description`s. In `codemode.mode: "on"` a `direct` tool's appended `Codemode:` line is one line of top-level field names; in the codemode listing itself (every tool in mode `"only"`, `codemode`-exposure tools in mode `"on"`) the host renders the full output type, so nested result types count against the budget - that cost is accepted, because untyped nested members (`Type.Unknown()`) would not codify the response (user's original ask).

### doc_to_md

- Add `publicHandle(d: DocToMdDetails): PublicHandleData` and the `PublicHandleData` type to `lib/doc-to-md-handle.ts` - the projection `bin/pi-quiver.ts:386-388` does inline today: `HandleData` minus `path`, `backend`, `pymupdfVersion`, `inputType`, `file`, `outputDir`.
- Remove the inline `--json` destructure at `bin/pi-quiver.ts:386-388`; the CLI prints `JSON.stringify(publicHandle(r.details))` for conversions and `r.details` for `--info`, byte-identical to today.
- Add `outputSchema: Type.Union([HandleSchema, InfoSchema])` in `extensions/doc_to_md.ts`. `HandleSchema` declares every `PublicHandleData` field, which is every `HandleData` field (`lib/doc-to-md-handle.ts:46-54`), with the TS nullability (`T | null` -> `Type.Union([T, Type.Null()])`):
  - `savedTo: String`; `imagesDir`, `sheetsDir`, `pagesDir`: `String | null`; `type: Union(Literal InputType)`; `engine: Union(Literal Engine)`; `tier: Union(Literal Tier)`
  - `pageCount: Number | null`; `pages: Array(Number) | null`; `explicitBreaks: Number | null`; `imageCount`, `pageImageCount`, `bytes`, `lines`, `outlineTotal`: `Number`; `pageImagesReason`, `degraded`, `fallbackReason`, `pageStatsPath`, `ocrDir`, `wordsPath`, `wordsReason`: `String | null`
  - `failedPages`, `emptyPages`: `Array(Number)`; `notes: Array(String)`
  - `outline: Array(OutlineEntry)` with `OutlineEntry = { line: Number, level: Number, title: String, page: Number | null }`
  - `ocr: OcrInfo | null` with `OcrInfo = { status: Union(Literal "off" | "unavailable" | "skipped" | "ran"), lang: String, textless, pages, noText, ocrFailed, budgetStopped, ceilingStopped, notAttempted: Array(Number), ocrMaxPages: Number, reason: String | null, tesseract: Boolean | null, mode: Union(Literal "textless" | "all"), sidecars, wordSidecars, ocrErrors: Record(String, String), killed: Number | null, childError: String | null }`
  - `pageStats: Array(PageStat) | null` with `PageStat = Union([{ page: Number, chars: Number, images: Number, imageCoverage: Number }, { page: Number, error: String }])`
  - `nativeImages: Array(NativeImage)` with `NativeImage = { page: Number, file: String, width: Number, height: Number }`
  - `wordsErrors: Record(String, String)` - the TS type is `Record<number, string>`, but JSON object keys are strings, so every `Record<number, string>` in the handle (`wordsErrors`, `ocr.sidecars`, `ocr.wordSidecars`, `ocr.ocrErrors`) is declared `Type.Record(Type.String(), Type.String())`.
  `InfoSchema` declares every `InfoData` field (`:56-59`): `type: Union(Literal InputType)`, `backend: Union(Literal "uv" | "python" | "venv" | "none")`, `pageCount: Number | null`, `metadata: Record(String, String)`, `toc: Array(TocEntry)` with `TocEntry = { level: Number, title: String, page: Number | null }`, `tocTotal: Number`, `sheets: Array(SheetInfo) | null` with `SheetInfo = { index: Number, name: String, kind: Union(Literal "worksheet" | "chartsheet"), hidden: Boolean, rows: Number | null, cols: Number | null, hiddenRows: Number, hiddenCols: Number, charts: Number, images: Number, rendered: Boolean, csv: String | null }`, `sheetsTotal: Number`. The literal unions reuse the `InputType`, `Engine`, `Tier`, `BackendKind`, and `OcrMode` string sets from `lib/doc-to-md-handle.ts` and `lib/doc-to-md-options.ts`; the schemas live in `extensions/doc_to_md.ts`, and their full declaration cost is part of the budget measurement in Tests.
- The extension returns `structuredContent: o.info ? r.details : publicHandle(r.details)` on success; the declared shape equals the `--json` projection field for field. Text content is unchanged.
- AC 1 reading: `savedTo`, `pageCount`, and `outline` are the same values the text handle's `Saved-To:`, `Page-Count:`, and `Outline` lines are rendered from, because both come from the same `HandleData`.

### fetch

- Add `body: string` to `FetchResult` in `lib/fetch-core.ts`: the inlined body or converted Markdown for inline text results; the gh-rendered body (without the `Source:` header lines) for inline gh results; `""` for HEAD, bodyless, binary, and spilled results.
- Add `outputSchema` in `extensions/fetch.ts`: `Type.Union([Inline, Spilled])` with `Inline = { spilled: Literal(false), url: String, status?: Number, contentType?: String, content: String, truncated?: Literal(true) }` and `Spilled = { spilled: Literal(true), url: String, status?: Number, contentType?: String, file: String, truncated?: Literal(true) }`. The extension builds `structuredContent` from `result.details` and `result.body`; `truncated: true` is set on either arm exactly when `details.truncated` is set (the core caps parsable bodies at 1 MB and binary bodies at 50 MB, `lib/fetch-core.ts:417-439,549-554`), and the key is omitted otherwise.
- AC 2 reading: `contentType` is present whenever the HTTP response carried one; gh-routed results have no HTTP content type (`renderGhResult`, `lib/fetch-core.ts:161-181`) and omit it. `status` is absent for gh results. A capped body that then spills carries `spilled: true`, `file`, and `truncated: true`, and the file holds only the capped bytes; the text keeps today's `[Note: source truncated at 1MB ...]` line.
- Received HTTP responses of any status, including 4xx/5xx, resolve today (`fetchUrl` has no `res.ok` check; the only throw is `Unsupported protocol` at `lib/fetch-core.ts:497`) and keep doing so: a 404 or 503 follows the ordinary inline/spilled envelope with its `status` and body, and the CLI keeps exiting 0 for it. Only the existing thrown failures - `Unsupported protocol`, network errors, abort - reject a script's `await`; no structured object exists for them.

### slack_thread and slack_search

- Change `readThread` to return `messages: Record<string, unknown>[]` on `ThreadResult` and `searchMessages` to return `matches: Record<string, unknown>[]` on `SearchResult` (`lib/slack-core.ts:509-527`) instead of discarding the arrays after rendering (`:566-567`, `:736-738`). Text rendering, `raw`, and `gateOutput` are untouched.
- Add a shared `SlackMessage` schema in `extensions/slack.ts`: `Type.Object({ ts: String, text: String, user?: String, thread_ts?: String, channel?: Union([String, Object({ id?: String, name?: String }, { additionalProperties: true })]), permalink?: String }, { additionalProperties: true })`. Both `channel.id` and `channel.name` are optional because `search.messages` matches carry `channel: { name }` without an `id` (the fixtures at `test/slack-core.test.ts:517-527` and `:551`), and the object arm's TypeBox options are the explicit `{ additionalProperties: true }` object. A message missing `ts` or `text` is the only schema failure. Messages are the raw Slack API objects; the schema types the subset scripts reach for and passes everything else through, because the Slack message shape evolves and pi-quiver owns no projection of it (user decision).
- Add `outputSchema` for `slack_thread`: `Type.Union([{ messages: Array(SlackMessage), complete: Boolean, next_cursor?: String, message_count: Number, caveat?: String }, { file: String, complete: Boolean, next_cursor?: String, message_count: Number, caveat?: String }])`; for `slack_search`: `Type.Union([{ matches: Array(SlackMessage), total: Number, page: Number, page_count: Number }, { file: String, total: Number, page: Number, page_count: Number }])`.
- Projection: the extension builds the object from the core result and renames `nextCursor -> next_cursor`, `messageCount -> message_count`, `pageCount -> page_count`; optional keys (`next_cursor`, `caveat`) are omitted when the core value is `undefined`, never set to `undefined`, because `structuredContent` is `JsonValue` (`pi-agent-core/dist/types.d.ts:375`).
- Structured spill rule: the extension measures `JSON.stringify(messages)` (or `matches`) against the same `INLINE_MAX_BYTES` / `INLINE_MAX_LINES` constants `gateOutput` uses (`lib/slack-core.ts:463-464`), independent of `raw`. Under the gate the object carries the array. Over it the extension writes the JSON array (and nothing else) to its own file under `tmpdir/pi-slack/` with a distinct name, `${Date.now()}-${hash}-${slug}.json`, and the object carries that path as `file` in place of the array; `file` is set only from this write. `gateOutput(renderedText, slug)` is untouched and keeps writing the text spill to its `.md` path; the structured write never replaces the tool's text content or its preview. The two gates decide independently (compact or raw text vs the JSON array), so all four combinations exist: text inline + structured inline (one result, no file), text inline + structured spilled (one `.json` file), text spilled + structured inline (one `.md` file, the object carries the array), both spilled (two files, the `.md` text spill and the `.json` structured spill). The object is therefore identical in both `raw` modes; the text result keeps today's mode-dependent gate and spill content.
- Remove the "try JSON.parse, on failure read the file" sentence from the `slack_thread` description; name the structured fields instead (`messages` or `file`, `complete`, `next_cursor`, `message_count`, `caveat`) and keep the sentence that a capped read resumes by passing `next_cursor` as `cursor`.

### slack_cache_refresh and the channel_not_found hint

- Add `exposure: "codemode"` to the `slack_cache_refresh` registration (`extensions/slack.ts:527-533`). Registration still happens only at `session_start` with `enabled: true`.
- Shrink its description to one line naming the trigger and the script call: refresh the channel/user name cache after `channel_not_found` or a rename; reachable from codemode scripts as `tools.slack_cache_refresh({})`.
- Remove `channel_not_found` from the shared `ERROR_HINTS` map (`lib/slack-core.ts:311-312`). `mapSlackApiError` (`:322-335`) bakes `ERROR_HINTS[code]` into `SlackError.message` before any surface sees the error, and both surfaces print that message (`formatToolError`, `extensions/slack.ts:65-72`; `runSlack`, `bin/pi-quiver.ts:329-333`, which only appends the hint when the message lacks it), so a surface-specific hint cannot be substituted downstream - the shared message must stay surface-neutral. With the entry gone the mapped message is the bare code `channel_not_found`. Each boundary formatter then adds its own sentence for that code: `formatToolError` appends "check the name, or run `tools.slack_cache_refresh({})` from a codemode script to refresh the name cache" (pi tool results); the `runSlack` catch appends "check the channel ID and that the token's user is a member of it" (the CLI accepts IDs only, `doc/slack.md:55`). Every other code keeps today's shared hint and path. The existing assertions that pin the old embedded hint move to the new strings: `test/slack-core.test.ts:110-122` (mapped message is the bare code), `test/slack-config.test.ts:1093-1101`, `test/slack-cli.test.ts:307` and `:472`.

### Description diet

- `slack_post` and `slack_update`: remove the `SLACK_FORMATTING_GUIDANCE.rules` + `.example` concatenation from `description` (`extensions/slack.ts:318`, `:401`). Keep `promptGuidelines: SLACK_FORMATTING_GUIDANCE.rules` and append the example as its last entry, so the system prompt and the codemode declaration (host `tool.js:70-80`) still carry the rules once.
- `doc_to_md`: rewrite the description to the sentences that change the model's call - what the tool converts, that the input must be a local file path (use `fetch` first for URLs), that the Markdown is never inlined and the Saved-To file is read with offset/limit, `info: true` first to pick `pages`, where images/, pages/, ocr/ land, the OCR default-off and two-pass rule, the `ocrMaxPages` cap and its settings-only nature. Drop engine ladders and backend trivia (pymupdf4llm vs PyMuPDF vs unpdf, mammoth vs python-docx, markdownify vs Turndown); the handle's `Engine:`/`Tier:` lines report what ran.
- `OptionDescriptor.help` (`lib/doc-to-md-options.ts:62`) feeds three surfaces: the tool parameter schema (`extensions/doc_to_md.ts:18`), `renderHelp()` for `pi-quiver doc-to-md --help` (`:265-277`), and the generated `skills/doc-to-md/SKILL.md` (`scripts/gen-skill.mjs:13`). The CLI and the skill keep their text unchanged, so the diet does not touch `help`: add an optional `toolHelp?: string` to `OptionDescriptor`, read by `schemaFor` as `d.toolHelp ?? d.help`, and set it only on the descriptors whose `help` is 180 chars or longer (measured: `words` 409, `hideAnnotations` 321, `ocrMode` 275, `outputDir` 199, `ocrMaxPages` 193 - settings-only, not in the schema, so untouched - and `pages` 187). Each `toolHelp` keeps the call-shaping sentence (what the value selects, the input types it applies to, the guard that rejects it) and drops the long-form explanation, which stays in `--help`, `SKILL.md`, and `doc/doc-to-md.md`. `node scripts/gen-skill.mjs` output is unchanged.
- Ceilings from the scope decision (Q4): `doc_to_md` < 600 tokens, `slack_post` and `slack_update` < 450, every other pi-quiver tool < 500. The meter is the complete production declaration - `toCodemodeDeclaration(tool, promptGuidelines)` rendered by `renderToolSample`, so description, guidelines, input type, and output type all count. Measured against that meter the cuts above do not reach the numbers: `slack_post` is 568 without guidelines and about 1262 with them (the rules alone are 689), `slack_update` about 928, `doc_to_md` about 792 with every help string removed and the full `HandleSchema | InfoSchema` type, `slack_thread` about 542-563 with its `outputSchema`. The fully typed results and the call-shaping guidance stay as approved; which of the ceiling numbers, the meter, or the catalog presentation moves is the user's decision at the gate (Open questions). Independent of that decision, the catalog proof is the inclusion test in Tests: every pi-quiver tool section fits the production listing at `inlineBudget` 3000.

### Moving parts

Remove:
- inline `--json` destructure at `bin/pi-quiver.ts:386-388`
- `SLACK_FORMATTING_GUIDANCE` concatenation in two descriptions
- the single shared `channel_not_found` hint string
- the message-array discard in `readThread` and `searchMessages`
- the JSON.parse sentence in the `slack_thread` description

Add:
- `publicHandle` + `PublicHandleData` (`lib/doc-to-md-handle.ts`)
- `FetchResult.body`; `ThreadResult.messages`; `SearchResult.matches`
- four `outputSchema`s and `structuredContent` returns; the `SlackMessage` schema
- `exposure: "codemode"` on `slack_cache_refresh`
- `@earendil-works/pi-codemode` as an explicit devDependency (resolves transitively today, lock at 1.5.0)
- `test/tool-descriptions.test.ts`; a TypeBox-free-lib assertion in `test/layout.test.ts`
- `OptionDescriptor.toolHelp` and the five shortened tool-facing helps (`words`, `hideAnnotations`, `ocrMode`, `outputDir`, `pages`); shortened `doc_to_md`, `slack_post`, `slack_update`, `slack_thread`, `slack_cache_refresh` descriptions; `--help` and `skills/doc-to-md/SKILL.md` unchanged
- the two boundary `channel_not_found` sentences (`formatToolError`, `runSlack`); the structured `.json` spill write in `extensions/slack.ts`
- an `AGENTS.md` Rules bullet: `lib/*` stays TypeBox-free because the CLI bundle is `--packages=external`

### Paid or external actions

None. Every test is local (fake transport, fixtures in `test/fixtures/`, no model calls, no network). The implementation loop treats any action not named here as unreachable; adding one needs separate explicit authorization.

Supersedes: none - no predecessor spec covers these tools' result contracts. The predecessors `doc/specs/2026-09-15-gh-21-slack-thread-block-kit.md` (raw vs compact rendering, mode-dependent gate) and `doc/specs/2026-08-29-gh-7-slack-extension.md` (tool surface, size gating, cache refresh) stay in force: this spec adds a structured result beside their text contracts and changes neither.

## Errors and edge cases

- `doc_to_md` failures: `execute` has no catch (`extensions/doc_to_md.ts:45-51`) and core failures keep throwing; the host turns the throw into an error result with no `structuredContent`. The extension sets `structuredContent` only on the success return, so the schema describes success only. `info: true` returns `InfoData` unchanged.
- `fetch` HEAD and bodyless responses: `spilled: false`, `content: ""`, `status` and `contentType` set from the response. Non-2xx responses: the same envelope with `status: 404` (or whatever was received) and the error body as `content`, so a script branches on `status`; the CLI exit code stays 0. Binary responses: `spilled: true`, `file`. A gh-routed result whose output exceeds the gate: `spilled: true`, `file`, no `contentType`. A body capped at 1 MB (text) or 50 MB (binary): `truncated: true` on whichever arm applies.
- Slack `channel_not_found` and every other Slack error: `isError` text with the per-surface hint, no `structuredContent`.
- Slack spill: when the object carries `file`, `messages`/`matches` is absent, not empty; the `.json` file holds the JSON array and nothing else. A text spill and a structured spill are different files, and either can occur without the other. An empty thread or zero hits: `messages: []` / `matches: []` with `message_count: 0` / `total: 0`.
- Message schema drift: a Slack object lacking `ts` or `text` fails `Value.Check` in the test, which is the intended drift signal; unknown fields, including a `channel` object without `id`, pass through `additionalProperties: true`.
- `slack_cache_refresh` at `exposure: "codemode"`: registered and callable via `tools.slack_cache_refresh({})` in both codemode modes; absent from the model's declared tool list (`AgentSession.getActiveToolNames()`, host `dist/core/agent-session.d.ts:418-423`) and present in `getCallableToolNames()` (`:425`); the registered definition carries `exposure: "codemode"`.
- Description diet: `slack_post`/`slack_update` system-prompt guidance is unchanged apart from the example joining the rules list; no sentence that changes what the model passes is removed from any description or tool-facing help; `--help` and `SKILL.md` text is unchanged.
- Packed CLI: `npx -y pi-quiver doc-to-md --json` on a clean install resolves without `@sinclair/typebox` present at runtime.

## Tests

`node --test`, no model calls, no network.

- doc_to_md conversion `structuredContent` passes `Value.Check` against `outputSchema`; `savedTo`, `pageCount`, `outline` equal the text handle's values - `test/doc_to_md.test.ts`
- doc_to_md `info: true` `structuredContent` passes `Value.Check` - `test/doc_to_md.test.ts`
- `publicHandle(details)` deep-equals the parsed `--json` CLI output for the same input; `--json` and `--info` output unchanged - `test/doc-to-md-cli.test.ts`
- fetch inline, spilled, HEAD, binary, gh, 404, and 503 shapes pass `Value.Check`; inline `content` equals the inlined body; `spilled` discriminates; 404/503 carry `status` and resolve, with the CLI text and exit 0 unchanged - `test/fetch.test.ts`, `test/fetch-core.test.ts:44-56`
- a body capped at 1 MB that spills yields `spilled: true`, `file`, `truncated: true`, and the file holds the capped bytes - `test/fetch.test.ts`, alongside existing `test/fetch-core.test.ts:73-84`
- fetch thrown paths (`Unsupported protocol`, abort) reject with no `structuredContent` - `test/fetch.test.ts`, existing `test/fetch-core.test.ts:86-115`
- fetch direct text unchanged: HTTP HEAD, 404/500, spill preview, and truncation note - existing `test/fetch-core.test.ts:31-84`; gh text - existing `test/fetch.test.ts:276-303`
- slack_thread and slack_search structured shapes pass `Value.Check` inline and spilled, including the name-only `channel: { name }` search fixture; `raw: true` and `raw: false` yield deep-equal objects; spilled object carries `file`, `complete`, `next_cursor`, the `.json` file parses to the array, and the `.md` text spill (when present) is a different path; all four text/structured inline/spilled combinations are exercised through the real mapped-result path; empty thread yields `messages: []` - `test/slack-config.test.ts`
- slack direct text unchanged: compact and raw formatters - existing `test/slack-config.test.ts:1219-1249`; compact rendering through `searchMessages`/`readThread` - existing `test/slack-core.test.ts:510-580,791`; raw round trip - existing `test/slack-config.test.ts:1719`
- `slack_thread` description names the structured fields and `cursor` resumption and does not contain "JSON.parse" - `test/slack-config.test.ts`
- `slack_cache_refresh`: the registered definition carries `exposure: "codemode"` and its `execute` runs the refresh through the fake transport (unit, existing mock `test/slack-config.test.ts:881-891`) - `test/slack-config.test.ts`; host-backed acceptance check with fake transport, no model and no network: a session built from the SDK (`createAgentSession`, host `dist/core/sdk.d.ts:116`) with the slack extension and `createCodemodeExtension({ mode })` (host `dist/extensions/codemode/index.d.ts`) reports the other `slack_*` tools in `getActiveToolNames()` and `slack_cache_refresh` only in `getCallableToolNames()` in mode `on`, and `executeCodemode` (host `dist/extensions/codemode/execute.d.ts:15`) running `await tools.slack_cache_refresh({})` reaches the fake transport in modes `on` and `only` - new `test/slack-codemode.test.ts`; the model-free session setup is an Open question below
- `channel_not_found` through the real mapped-error path (`apiCall` returning `{ ok: false, error: "channel_not_found" }`): tool result names `tools.slack_cache_refresh({})`; CLI stderr names the ID/membership check and no pi tool; the mapped `SlackError.message` is the bare code - `test/slack-config.test.ts:1093-1101`, `test/slack-core.test.ts:110-122`, `test/slack-cli.test.ts:307,472`
- per-tool section cost: `toCodemodeDeclaration(tool, promptGuidelines)` rendered by `renderToolSample` (host `dist/extensions/codemode/tool.js`, `@earendil-works/pi-codemode/declarations`), for every registered pi-quiver tool with its `outputSchema` attached, under the ceilings (doc_to_md < 600, slack_post/slack_update < 450, others < 500) - new `test/tool-descriptions.test.ts`; the numbers or the meter move per the Open question
- catalog inclusion: `createCodemodeDescription(tools, { guidelines, inlineBudget: 3000 })` over every registered pi-quiver tool, in the mode-`only` selection, contains a section for `doc_to_md`, `fetch`, and every `slack_*` tool including `slack_cache_refresh` - `test/tool-descriptions.test.ts`
- description floor: `doc_to_md` names the local-file/use-`fetch` rule, Saved-To/never inlined, `info` first, and the OCR cap; `slack_thread` names `cursor` resumption, `complete`, `next_cursor`, and the structured fields; `slack_post` names the `thread_ts` re-invoke recovery; `slack_post`/`slack_update` `promptGuidelines` end with the example - `test/tool-descriptions.test.ts`
- doc_to_md direct text unchanged: handle text - existing `test/doc-to-md-handle.test.ts:13-230` and `test/doc_to_md.test.ts:836-842`; CLI handle, `--info`, and `--help` output - existing `test/doc-to-md-cli.test.ts:92-116,190,226`
- `skills/doc-to-md/SKILL.md` has no drift (`help` strings unchanged) - existing `test/skill-generation.test.ts`
- packed tarball installs and `doc-to-md --json` runs with no TypeBox at runtime - existing `test/packed-install.test.ts:65-80`
- no `lib/*.ts` imports `@sinclair/typebox` - `test/layout.test.ts`
- `QUIVER_CONFIG_KEYS` unchanged (no new settings) - existing `test/extension-config.test.ts`
- the host-rendered `Codemode:` appended line is one line of field names - none: host behavior, covered by the cost ceiling
- README names the minimum host version - none: doc content, checked at the conformance gate

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (communication contract: structured results per tool, `slack_cache_refresh` reachable from codemode scripts only, minimum host 0.99.0); `doc/doc-to-md.md` (communication contract: structured shape equals the `--json` projection; the long-form option notes the tool-facing helps drop stay here and in `--help`); `doc/fetch.md` (communication contract: structured shape, the `spilled` discriminant, `status` on non-2xx, `truncated` and the capped file); `doc/slack.md` (communication contract: thread/search structured shape, independent text/structured spill decisions and the possible two-file output, per-surface `channel_not_found` hint, refresh exposure); `CHANGELOG.md` `## Unreleased` (one bullet for typed results, one for the exposure change, one for the description diet)
- Derived / memory docs invalidated: `AGENTS.md` Rules (new bullet: `lib/*` stays TypeBox-free)

Materiality per `reference/documentation-impact.md`: the per-tool doc pages are the contract a script author reads before writing against the shape, not a mirror of the schema; the `AGENTS.md` bullet records a non-obvious constraint (the external-packages CLI bundle) that the code cannot tell a contributor.

## Out of scope

- Render-context `keyHint` migration (ticket).
- `slack thread` / `slack search` JSON support in the `pi-quiver` CLI (ticket follow-up); the CLI's `channel_not_found` hint names an ID/membership check for that reason.
- Updating the sibling consumer's thread-read guidance after release (ticket).
- Any change to the `@earendil-works/pi-coding-agent` dev pin (already `^1.5.0`).
- Structured error shapes; errors stay `isError` text or thrown.
- Description trims for tools under the 500-token ceiling.

## Open questions

- Description-diet ceilings vs the production meter. Probe: council members rendered the complete production declarations on host 1.5.0 (`toCodemodeDeclaration` + `renderToolSample`, guidelines and output types included). Outcome: contradicted - the Q4 ceilings are not reachable with the approved content: `slack_post` about 1262 with guidelines (568 without), `slack_update` about 928, `doc_to_md` about 792 with every help removed and the full typed output, `slack_thread` about 542-563 with its `outputSchema`; the 1506/1258/924 baselines in Problem were measured without guidelines. Edits this settles: the ceiling bullet in Design and the cost row in Tests. Settlement: the user picks at the gate - (a) keep the numbers and measure description + input type only (guidelines and output type excluded, stated in Tests), (b) revise the numbers against the full meter, or (c) change catalog presentation (for example `promptGuidelines` dropped from the codemode section) - and the first plan task that lands `test/tool-descriptions.test.ts` applies the choice through the amendment path. The fully typed results and the call-shaping sentences do not move either way.
- Model-free host-backed session for the `slack_cache_refresh` exposure check. Probe: read host `dist/core/sdk.d.ts:116` (`createAgentSession`), `dist/core/agent-session.d.ts:418-425` (`getActiveToolNames`, `getCallableToolNames`), `dist/extensions/codemode/index.d.ts` (`createCodemodeExtension({ mode, inlineBudget })`), `dist/extensions/codemode/execute.d.ts:15` (`executeCodemode(..., ctx)`). Outcome: inconclusive - the entry points exist and are typed, but whether `createAgentSession` builds a session without model auth or network was not run. Obtain-hint: `CreateAgentSessionOptions` in `dist/core/sdk.d.ts:10-66` (`modelRuntime`, `model` are optional and default to the agent dir's `auth.json`/`models.json`). Edits this settles: the host-backed row in Tests. Settlement: the user confirms at the gate, or the plan task that writes `test/slack-codemode.test.ts` settles it via the amendment path; if the SDK session needs a model, the row falls back to `createCodemodeDescription` plus `executeCodemode` with a hand-built `ExtensionToolContext` whose `executeTool` dispatches to the registered definitions, and the declared-list half becomes a manual smoke step named in Tests.
