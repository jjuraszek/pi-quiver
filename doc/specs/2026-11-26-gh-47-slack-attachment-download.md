# slack: name attached files in the thread view and download one by ID

**Goal:** An agent that reads a Slack thread sees each attached file's name and Slack file ID on its message line, and saves one file's exact bytes with a new `slack_download` tool - to temp space by default, or to a `dir` it names - using the extension's own Slack user token and no browser or general fetch.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Ticket:** #47
**Branch:** `jacek/gh-47-slack-attachment-download` (base `main` @ eb9a8e5)

## Problem

Ticket #47 ("slack: an agent cannot read a file attached to a Slack message") reports a 13 KB `query.sql` attached to a Slack message that the agent could not retrieve from the message permalink; an unauthenticated general fetch got HTTP 403. The compact `slack_thread` line is `author | ts | body` and never reads `files`, so the agent does not learn that a file exists, and the extension has no way to fetch a Slack-hosted file's bytes: its only transports are the JSON Web API call and an unauthenticated upload POST.

The request that opened this design: "#47 make sure to verify if we start supporting download of attached in every situation. it would be nice if download could be done on default to temp space or to known location if asked for (dir parameter). does it make sense?"

Framing: kept

### Decisions from the questionary

| Question | Answer (user, verbatim) | Consequence |
|---|---|---|
| What "every situation" covers: A) every file on a message the thread read returns, named error where Slack holds no bytes; B) A plus a pasted Slack file link as download input; C) B plus search results naming attachments | "B, just make sure you don't use browser for download. it should be native tool in scope of its token usage space" | Files on any message `slack_thread` returns (parent, reply, lone message, DM; text or binary) are in scope, and a Slack file link is accepted as download input. `slack_search` output is unchanged. Hard constraint: the download is a native Slack tool that sends the extension's own resolved token; no browser, no general `fetch` tool, and the token is never handed to the agent. |
| Approach: A) separate `slack_download`, one file per call, always saves, returns the path; B) `download` and `dir` on `slack_thread`; C) separate tool, small text inline | "A" | One new tool; the thread read downloads nothing. |
| Design round 1 (architecture, data flow) | "approve" | Design sections 1-7. |
| Design round 2 (errors, edges, tests, documentation, 50 MB cap, 120 s timeout) | "approve" | Errors and edge cases, Tests, Documentation impact. |

Assumptions made in place of yes/no questions: the `pi-quiver` CLI gets no download command (it has no Slack read commands, `bin/pi-quiver.ts:25-98`, and the ticket names the extension); the download runs as the user identity, the one that reads the thread.

### Checked claims

| Claim | Lookup | Result |
|---|---|---|
| Compact thread view shows no attachment name or ID | read `lib/slack-core.ts:690-696` (`renderThreadLine`) | held - the line is `author \| ts \| body`; `files` is never read |
| `files` appears only in the raw JSON output mode (ticket Problem) | read `lib/slack-core.ts:763-770`, `extensions/slack.ts:62-98,340-377` | corrected - `structuredContent.messages` and `details` carry the raw Slack message objects, `files` included, in compact mode too; only the compact text drops them, so only the compact line changes |
| The extension can upload a file but not download one | read `lib/slack-core.ts:286-451,879-916`; `rg 'url_private\|files.info'` over `lib/ extensions/ bin/` | held - `ApiCall` (JSON) and `UploadBytes` (unauthenticated POST) are the only transports |
| A Slack JSON `missing_scope` error names the scope | read `lib/slack-core.ts:321-332` (`mapSlackApiError`), `extensions/slack.ts:109-119` (`formatToolError`) | held - the message quotes `needed`, and the tool error appends the identity |
| Thread and search reads use the user token only | read `extensions/slack.ts:305-377`, `doc/slack.md:397-404` | held |
| Slack file links have a fixed shape | fetched https://docs.slack.dev/messaging/working-with-files/ (upload step 3 example file object) | held - `permalink` is `https://aretia.enterprise.dev.slack.com/files/U012R6127MZ/F012AB3CDE4/hello.txt`, `url_private_download` is `https://files.slack.com/files-pri/T0123ABCD4E-F012AB3CDE4/download/hello.txt`, `url_private` is the same without `/download/`, and `permalink_public` is `https://slack-files.com/T0123ABCD4E-F012AB3CDE4-8627274cfa` |
| A permalink is parsed for channel and ts only | read `lib/slack-core.ts:550-556` | held - a reply permalink sends the reply's ts to `conversations.replies` |
| `conversations.replies` accepts a reply's ts | fetched https://docs.slack.dev/reference/methods/conversations.replies/ | held - "`ts`: Unique identifier of either a thread's parent message or a message in the thread"; which messages come back for a reply ts is not stated |
| `conversations.replies` carries a per-message `files` array | context-builder read of the Slack Connect guide and the 2018-05 file-threads changelog | held |
| Slack-hosted files download with `GET url_private` or `url_private_download` plus `Authorization: Bearer`; the token needs `files:read`, which also covers `files.info`, for user and bot tokens | fetched https://docs.slack.dev/messaging/working-with-files/ and https://docs.slack.dev/reference/methods/files.info/ | held |
| Remote files (`mode: external`, `is_external: true`) carry an app-chosen `url_private`; credentials go only to an exact expected Slack file host over https, redirects handled manually | same page, "Never send Slack credentials to a host outside Slack" | held - hard constraint for the byte transport |
| Temp by default with an optional caller directory is an existing repo convention | read `lib/doc-to-md-options.ts:80` (`outputDir`), `lib/fetch-core.ts:348-364` (`tmpdir()/pi-fetch`), `lib/slack-core.ts:467-488` (`tmpdir()/pi-slack`) | held - `doc_to_md` names it `outputDir`; the user asked for `dir`, and Slack tool parameters are lowercase or snake_case (`extensions/slack.ts:352-358,555-563`) |
| The general fetch path could carry the download | read `lib/fetch-core.ts:227-231,351-364,415-529`, `extensions/fetch.ts:38-51` | not a fit - `redirect: "follow"` is hard-coded (`:526`), the temp name comes from the URL, there is no destination directory, it truncates at 50 MB instead of failing (`:424-436`), it converts or inlines text (`:445-495`), and it holds no Slack credential |
| `lib/slack-core.ts` avoids depending on `lib/fetch-core.ts` | read `lib/slack-core.ts:455-461` | held - thresholds are "defined locally to avoid a cross-module dependency" |
| A byte transport beside the JSON one is an existing pattern | read `lib/slack-core.ts:307,441-451`, `extensions/slack.ts:549-595` | held - `UploadBytes` type plus `defaultUploadBytes` |
| Relative paths in Slack tools resolve against `ctx.cwd` | read `extensions/slack.ts:566` | held |
| The registered tool list and declaration size are pinned by a test | read `test/tool-descriptions.test.ts:19-25,53,62-75` | held - `expectedNames` must gain `slack_download`; a declaration is at most 2,500 characters unless listed in `CEILINGS` |
| No other test pins the Slack tool set | read `test/slack-config.test.ts:876-885,964-973,1022-1028,1047-1054`, `test/slack-codemode.test.ts:16-18,81` | corrected - `EXPECTED_TOOL_NAMES` and three `defs.length` assertions of 8 (enabled, shorthand, repeated start) pin the registration set, and `directSlackTools` (seven names) is deep-compared with the active `slack_*` tools; each must gain `slack_download` |
| The `slack_thread` declaration has room for one more sentence | council measurement: `renderToolSample(toCodemodeDeclaration(...))` on the registered tool, and the `env -u PI_CODING_AGENT_DIR node --test test/tool-descriptions.test.ts` diagnostic | corrected - 2,456 of 2,500 characters, 44 left, and `slack_thread` is not in `CEILINGS`; the attachment guidance has to replace existing wording |
| The mode-only codemode catalog test tolerates a new omitted tool | read `test/tool-descriptions.test.ts:84-101` | corrected - a tool missing from the catalog at `inlineBudget: 3000` must be in the allowed list (`doc_to_md`, `slack_post`, `slack_update`), and `fetch`, `slack_thread`, `slack_search`, `slack_cache_refresh` must stay listed. The host lists tools cheapest-first and stops at the first one that does not fit (`selectCatalog`, `node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js:98-116`); today the listed sections cost 2,960 of 3,000 tokens, `doc_to_md` and `slack_post` are omitted, and `slack_update` is the most expensive listed tool, so a cheaper `slack_download` can be listed and push `slack_update` out. The omission set is known only from the final declarations |
| gh-21 fixes the compact envelope as `author \| ts \| body` | read `doc/specs/2026-09-15-gh-21-slack-thread-block-kit.md:89-100` | held - this design extends the envelope for messages with files |
| gh-7's tool surface is replaced | read `doc/specs/2026-08-29-gh-7-slack-extension.md:169-200` | not superseded - a tool is added and every existing row stays current |
| API calls time out after a fixed total, body included | read `lib/slack-core.ts:380-397` (`fetchOrTransportError`, `REQUEST_TIMEOUT_MS = 20_000`) | held - a byte download needs its own, longer timeout |
| Typed codemode results need a declared `outputSchema` plus `structuredContent` | read `extensions/slack.ts:305-334`, `test/tool-descriptions.test.ts:66` | held |
| README lists the Slack tools and names the tools the mode-only catalog omits | read `README.md:74,107,289`, `doc/slack.md:5`, `extensions/slack.ts:4` | held - the tool list, the typed-result list (`README.md:107`), and three "eight `slack_*` tools" counts go stale; the omission sentence goes stale whenever the measured omission set differs from `doc_to_md` and `slack_post` |
| A manual live-Slack checklist owns live verification | read `doc/slack.md:691-725` | held - no live Slack call runs in automated tests |
| The read-path size gate is a transfer limit | read `doc/slack.md:611-629`, `lib/slack-core.ts:455-467` | corrected - 32 KB / 1,000 lines gates rendered text only; the download has its own byte cap |
| An HTML body proves a sign-in page | Slack file-object and download docs | not provable - an uploaded HTML file is also `text/html`; the design flags HTML only when `files.info` reports a non-HTML mimetype |
| Slack states a download size maximum | Slack help and file-object docs | not documented - uploads go to 1 GB; the 50 MB cap is a product choice |
| What the Slack file host answers a token without `files:read` | Slack download docs state no status or body; no live workspace call | not checked - the design gets scope errors from the JSON `files.info` call made before the byte request |
| Whether Slack's file host redirects an authorized request | Slack download docs; no live call | not checked - every redirect is an error |
| `search.messages` matches include `files` | Slack method reference | not checked - the reference does not promise it; the design does not rely on it |
| The user's Slack app grants `files:read` to the user token | app configuration lives in Slack | not checkable - surfaces as Slack's `missing_scope` at first use |
| A live Slack smoke workspace and posting approval | `doc/slack.md:691-725` | not checkable - none provided; tests stub the HTTP responses |

Implicit dependencies: the Slack pi extension loader (`package.json` `pi.extensions`, `extensions/slack.ts:260-273`) - found; node `tmpdir()` temp storage - found; `node --test` stub conventions (injected `ApiCall`, local ephemeral HTTP server, `test/slack-core.test.ts:1-107`) - found; ticket comments - zero, so no reporter notes.

## Acceptance criteria

Ticket #47, Acceptance Criteria, rows verbatim:

- [ ] Given a thread message with one or more attached files, reading the thread in default compact mode shows each attached file's name and Slack file ID on that message.
  in-scope
- [ ] Given a thread message with no attached files, reading the thread in default compact mode shows the message on its usual single line with no attachment marker, file name, or file ID added.
  in-scope
- [ ] Given a Slack message with an attached text file of known contents and a token allowed to read it, when the agent starts with the message permalink, it obtains the expected contents without a person saving the attachment or supplying a local path.
  in-scope
- [ ] Given a file request that Slack refuses or redirects to a sign-in page, the agent receives a file-read error rather than file contents. If Slack reports a missing scope, the error names it.
  in-scope
- [ ] `doc/slack.md` names the Slack token scope required to read attached files.
  in-scope

## Legs

### Leg: jjuraszek/pi-quiver
branch: jacek/gh-47-slack-attachment-download
contract:
- create: git worktree add <home> -b <branch>
- destroy: git worktree remove <home> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: env -u PI_CODING_AGENT_DIR npm run test:all (run in the worktree)
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: eval/elevator/README.md
Rules: .agents/skills/release/SKILL.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/fetch.md
Rules: doc/doc-to-md.md
Rules: doc/provider-stall-watchdog.md
Rules: doc/slack.md
Rules: .pi/gauntlet.md
scope: AC 1, AC 2, AC 3, AC 4, AC 5
design: owns `lib/slack-core.ts` (thread line suffix, file-reference parsing, download flow, byte transport), `extensions/slack.ts` (`slack_download` registration and result text, `slack_thread` description wording, header tool count), `test/slack-core.test.ts`, `test/slack-config.test.ts`, `test/slack-codemode.test.ts`, `test/tool-descriptions.test.ts`, `doc/slack.md`, `README.md`, `CHANGELOG.md`; observable outcomes are the compact `slack_thread` text and the `slack_download` tool's saved file, results, and errors.

## Design

supersedes `doc/specs/2026-09-15-gh-21-slack-thread-block-kit.md`, the `author | ts | body` envelope sentence in Design section 2 only. `doc/specs/2026-08-29-gh-7-slack-extension.md` is not superseded: a tool is added and every existing tool-surface row stays current.

Remove: none.

Add:

- `lib/slack-core.ts`: the files suffix in `renderThreadLine`; the `DownloadBytes` type and `defaultDownloadBytes` beside `UploadBytes`; `parseFileRef`; `downloadFile`; the constants `DOWNLOAD_MAX_BYTES` (50,000,000) and `DOWNLOAD_TIMEOUT_MS` (120,000).
- `extensions/slack.ts`: the `slack_download` registration with its `outputSchema` and its result text line; the attachment guidance folded into the `slack_thread` description (section 8); the header comment's tool count (`extensions/slack.ts:4`, eight becomes nine).
- `test/slack-core.test.ts`: thread-line, reference-parsing, download-flow, and byte-transport tests.
- `test/slack-config.test.ts`: the permalink-to-contents, invalid-reference, and public-permalink tests through the registered tools; `slack_download` in `EXPECTED_TOOL_NAMES`, and the enabled, shorthand, and repeated-start `defs.length` assertions move from 8 to 9. The disabled (0) and duplicate-registration checks stay as they are.
- `test/slack-codemode.test.ts`: `slack_download` in `directSlackTools`.
- `test/tool-descriptions.test.ts`: `slack_download` in `expectedNames`.
- `doc/slack.md`, `README.md`, `CHANGELOG.md`: the entries under Documentation impact.

### 1. Thread line

`renderThreadLine` appends ` | files: <name> (<id>), <name> (<id>)` to a message's line when `message.files` is an array holding at least one object with a non-empty string `id`. Entries keep Slack's order. An entry without such an `id` is skipped. `<name>` is the entry's `name` when it is a non-empty string, else its `title`, else `untitled`; every run of whitespace or control characters in it becomes one space, so the message stays on one line. Example:

```
alice | 1712345678.000100 | here is the query | files: query.sql (F0ABC123), shot.png (F0DEF456)
```

A message with no listable file renders byte-identical to today. A message whose body is empty keeps the same shape: `alice | 1712345678.000100 |  | files: shot.png (F0DEF456)`. The rule applies to every message the read returns: parent, reply, lone message, DM. Raw text mode, `structuredContent`, the raw Slack message objects in `details`, and the result shape are unchanged; they already carry the Slack file entries. Compact `details.output` is the rendered text (`lib/slack-core.ts:765-770`, `extensions/slack.ts:365-376`), so it carries the suffix, and its spill metadata changes when the suffix moves the output across the size gate. `slack_search` output is unchanged.

### 2. File reference

`parseFileRef(input: string): string` returns a Slack file ID or throws `SlackError("invalid_file_ref", ...)`. It is pure: no network call and no credential, and the registered tool runs it before anything else (section 3). A file ID matches `^F[A-Z0-9]+$` (Slack's documented example: `F0RDC39U1`); whether such an ID names a real file is Slack's answer in `files.info`, not a local check. Accepted inputs, after trimming:

| Form | Example | ID taken from |
|---|---|---|
| Bare ID | `F0ABC123456` | the input |
| File page link | `https://acme.slack.com/files/U012ABCDEF/F0ABC123456/query.sql` | the second path segment after `/files/`; the segment before it is any single non-empty segment and is not validated |
| File content link | `https://files.slack.com/files-pri/T012ABCDEF-F0ABC123456/query.sql` (also with `/download/` before the name) | the part after `-` in the `files-pri` segment |
| Public permalink | `https://slack-files.com/T0123ABCD4E-F012AB3CDE4-8627274cfa` (the `permalink_public` example in Slack's working-with-files guide) | the second `-`-separated part of the first path segment |

The three link shapes are the `permalink`, `url_private` / `url_private_download`, and `permalink_public` values of the example file object in Slack's working-with-files guide. A link must parse as an `https:` URL. For the file page and file content forms the host is `slack.com` or ends with `.slack.com`; for the public permalink form the host is exactly `slack-files.com`. The tool takes only the ID from a link and never requests the pasted address; the address it requests always comes from `files.info`. That holds for a public permalink too: its trailing secret is ignored, the file is read through `files.info` under the configured user token like any other, and the byte request still goes only to `files.slack.com` (section 4, step 4). A message permalink (`/archives/...`) is not a file reference and gets `invalid_file_ref` with a message pointing at `slack_thread`.

### 3. `slack_download` tool

Parameters: `file` (string, required: file ID or Slack file link) and `dir` (string, optional). The tool calls `parseFileRef(params.file)` first, before `resolveCall`, and passes the validated ID to the core: `resolveCall` resolves the credential and, on a cold team cache, sends `auth.test` (`extensions/slack.ts:133-155`, `lib/slack-cache.ts:65-73`), so a later parse would let a malformed reference reach Slack or come back as a credential error instead of `invalid_file_ref`. It has no `as` parameter and resolves the call as the user identity through the same `resolveCall("user", ...)` path `slack_thread` uses, so the token is the extension's own resolved user credential. The extension resolves a relative `dir` against `ctx.cwd`, as `slack_upload` resolves `path`, and passes an absolute path to the core, with `downloadBytes: defaultDownloadBytes` added to the deps the way `slack_upload` adds `uploadBytes: defaultUploadBytes` (`extensions/slack.ts:585`). One call downloads one file. The tool's description names `slack_thread` as the source of file IDs and says the result is a saved path to open with a file-read tool. Errors pass through `formatToolError` with identity `user`.

### 4. Download flow

`downloadFile(args: { fileId: string; dir?: string }, deps: CoreDeps & { downloadBytes: DownloadBytes })` in `lib/slack-core.ts`:

1. Take `args.fileId`, the ID the tool already validated with `parseFileRef` (section 3). The core does not parse a reference.
2. `deps.apiCall("files.info", deps.token, { file: args.fileId }, { retry: true, signal: deps.signal })`. A Slack `ok: false` answer surfaces as today's mapped `SlackError`: `missing_scope` names the scope from `needed`, and codes such as `file_not_found`, `file_deleted`, `access_denied`, and `not_visible` keep their names.
3. Refuse with `file_not_downloadable` when the returned `file` has `mode: "external"` or a true `is_external`, has a truthy `is_hidden_by_limit`, or has neither `url_private_download` nor `url_private` as a string. The message says which, and carries the file's `permalink` when Slack returned one.
4. Take `url_private_download` when present, else `url_private`. Refuse with `file_not_downloadable` unless it parses as an `https:` URL whose host is exactly `files.slack.com`; the message names the host. No request is made and the token is not sent.
5. Refuse with `file_too_large` when the returned `size` is a number above `DOWNLOAD_MAX_BYTES`.
6. Resolve the destination folder and file name (section 6).
7. `deps.downloadBytes(url, deps.token, { signal: deps.signal })`, which resolves only for a 200 answer (section 5).
8. Refuse with `file_auth_redirect` when the response's media type is `text/html` and the media type of `mimetype` from `files.info` is not. Both values are normalized before the comparison: parameters after `;` are dropped, the rest is trimmed and lowercased, so `Text/HTML; charset=utf-8` counts as HTML. This happens before the destination file is created.
9. Create the destination file exclusively and write the body chunks as received, with no decoding. Counting bytes as they arrive, stop with `file_too_large` once the count passes `DOWNLOAD_MAX_BYTES`. When the body ends and `files.info` reported `size` as a nonnegative integer, the bytes written must equal it; a mismatch is an incomplete transfer and throws `transport`. A zero-byte body for `size: 0` is a complete file.
10. Return `{ path, file_id, name, mimetype, size }`: `path` is the absolute saved path, `name` is Slack's `name` (else `title`, else the file ID - the order section 6 uses, without the file-system substitutions), `mimetype` is Slack's reported value and is absent when Slack reports none, and `size` is the number of bytes written.

Any failure after step 6 removes the partial file, and removes the per-call temp folder when this call created it. A `dir` the call created stays.

Every exit after step 7 that has not read the body to its end - the HTML refusal, a name collision, a create or write failure, the cap passed mid-stream - calls the response's `cancel()` (section 5), so the connection is released instead of held until the deadline; Node's HTTP client requires a response body to be consumed or cancelled (`node_modules/undici/README.md:615-627`).

### 5. Byte transport

`DownloadBytes = (url: string, token: string, opts?: { signal?: AbortSignal }) => Promise<{ contentType: string | undefined; body: AsyncIterable<Uint8Array>; cancel: () => Promise<void> }>`. `cancel` releases the response body and works both before iteration starts and after a partial read. `defaultDownloadBytes` is the only place the token is attached to a file-host request:

- It sends `GET` with `authorization: Bearer <token>` and automatic redirect following turned off.
- The request and the body read share one deadline of `DOWNLOAD_TIMEOUT_MS`, combined with the caller's signal.
- Any 3xx answer throws `SlackError("file_auth_redirect", ...)`; the message names the host of the `Location` header when one is present, never its path or query. No second request is made. Node's `fetch` with `redirect: "manual"` returns the 3xx response with its `Location` header readable (observed on Node v26.13.0: status 302, header present).
- Any other status that is not 200 throws `SlackError("http_<status>", ...)`, the code shape `defaultUploadBytes` uses. That includes other 2xx answers such as 204 and 206: the request carries no `Range` header, so only a 200 is the whole file.
- The transport cancels the body of every response it rejects (3xx or non-200) before it throws.
- Caller cancellation throws the existing `aborted` code; a network failure or the deadline throws the existing `transport` code. This is the split `fetchOrTransportError` makes (`lib/slack-core.ts:380-397`). `downloadFile` classifies a failure while reading the body the same way, by the original caller signal: `aborted` when `deps.signal` is aborted, else `transport`.

The host check lives in `downloadFile` (step 4), not in the transport, so a test can point `defaultDownloadBytes` at a local server. No error message, result, or log line carries the token or the content address's query string.

### 6. Destination and file name

Without `dir`, the file lands in a fresh per-call folder made with `mkdtemp` under `join(tmpdir(), "pi-slack")` (prefix `download-`), the directory the read tools already spill to. The tool never deletes a completed download, the same as those spill files. With `dir`, the folder is that absolute path, created recursively when missing; `invalid_dir` when it exists and is not a folder, or cannot be created.

The saved name is Slack's `name` (else `title`, else the file ID) reduced to one safe path segment: `/`, `\`, the characters `< > : " | ? *`, and control characters each become `_`; trailing dots and spaces are trimmed; an empty result, `.`, or `..` becomes the file ID. After that, a name whose base - any extension removed, compared case-insensitively - is one of the reserved device names in Microsoft's "Naming Files, Paths, and Namespaces" also becomes the file ID; that page treats `NUL.txt` as the device `NUL`. The rule keys on the name, not the platform, so it holds and is testable on every CI platform. An overlong name is not truncated: the create fails and surfaces as `write_failed`.

The file is opened with exclusive create, so nothing is ever overwritten. When the name is taken, the tool retries once as `<stem>-<file id><ext>` (`image.png` becomes `image-F0DEF456789.png`); when that is taken too it throws `file_exists`. Any other failure creating or writing the file throws `write_failed` with the system error's message.

### 7. Results

Text: `Saved query.sql (F0ABC123456, text/plain, 13.2KB) to <path>`. `extensions/slack.ts` builds this line from the core's result, beside `threadResultText`: `downloadFile` returns the numeric `size`, and `lib/slack-core.ts` imports nothing from pi (`test/layout.test.ts:62-67` fails on an `@earendil-works` import there). The size is rendered by pi's `formatSize`, which `extensions/fetch.ts:14` already imports and which prints `13.2KB` without a space; the name in the line is the result's `name` with every run of whitespace or control characters collapsed to one space, so the line stays one line; the mimetype and its comma are omitted when Slack reports none. Typed result for scripts, declared as the tool's `outputSchema` and returned as `structuredContent`: `{ path: string, file_id: string, name: string, mimetype?: string, size: number }`. The output is one short line, so the 32 KB spill gate does not apply.

### 8. Tool catalog and descriptions

`slack_download` joins `expectedNames` in `test/tool-descriptions.test.ts`, and its declaration stays within the default 2,500-character ceiling. It also joins `EXPECTED_TOOL_NAMES` in `test/slack-config.test.ts`, where the enabled, shorthand, and repeated-start count assertions move from 8 to 9 and the disabled and duplicate checks stay untouched, and `directSlackTools` in `test/slack-codemode.test.ts`.

The `slack_thread` description says that a `files:` suffix lists attached files by name and ID and that `slack_download` saves one. Its declaration measures 2,456 of 2,500 characters today, so the guidance is folded into the existing description by trimming redundant wording, not appended; `slack_thread` gets no `CEILINGS` entry. The final declaration stays at or below 2,500 characters and keeps every pattern the "keeps call-shaping description guidance" test pins.

Mode-only catalog at the unchanged `inlineBudget: 3000`: `fetch`, `slack_thread`, `slack_search`, and `slack_cache_refresh` stay listed, and the allowed omissions stay `doc_to_md`, `slack_post`, `slack_update`. The host lists cheapest-first, so `slack_download` can be listed while `slack_update`, listed today, drops out. That displacement is an expected effect of this change: `slack_update` stays callable and stays readable with `describeTool` and `searchTools`. The complete omission set is read from the catalog test's diagnostic line once the final declarations exist, and the README sentence that names the omitted tools is synced to that set. `slack_download` joins the test's allowed-omission list only if the final catalog omits it.

### 9. Live verification

The design names no paid or external action: automated tests stub the Slack API and the file host, so approving this spec authorizes no live Slack call. `doc/slack.md`'s manual smoke checklist gains one line - start from the permalink of a reply that carries a known text attachment, confirm the returned reply line lists the file, download it by the listed ID, compare the saved bytes with the known contents - and the maintainer runs it against a live workspace before the release that ships this change, as that checklist already requires for transport changes. Starting from a reply covers the one read path Slack's reference leaves unstated: the parser sends the reply's own ts (`lib/slack-core.ts:550-556`). No run contacts the file host with a token that lacks `files:read`: `files.info` refuses that token before the byte request, so the file host's answer to it stays unknown and the design does not need it.

## Errors and edge cases

| Case | Result |
|---|---|
| `file` is not a file ID or a recognized Slack file link | `invalid_file_ref`; no credential lookup and no network call |
| Pasted public permalink (`slack-files.com`) | the ID is taken from it and the download runs through `files.info`; the pasted address is never requested |
| Token lacks `files:read` | Slack's `missing_scope` from `files.info`, naming the scope and the identity; no byte request |
| File deleted, not found, or not visible to the user | Slack's own code from `files.info` (`file_deleted`, `file_not_found`, `access_denied`, `not_visible`) |
| File hosted outside Slack, hidden by a plan limit, without a content address, or with a content address that is not https on `files.slack.com` | `file_not_downloadable` naming the reason and the file's Slack permalink; token not sent |
| Declared size, or bytes received, above 50 MB | `file_too_large`; nothing is truncated and no file remains |
| File host answers with a redirect | `file_auth_redirect` naming the redirect host; the token does not follow it |
| File host answers 200 with HTML (parameters and case ignored, as in `Text/HTML; charset=utf-8`) for a file Slack says is not HTML | `file_auth_redirect`; no file is created; the unread body is cancelled |
| File host answers any other status that is not 200, other 2xx such as 206 included | `http_<status>` |
| Body ends with a byte count different from a valid `size` in `files.info` | `transport` (incomplete transfer); partial file removed |
| Zero-byte file answered with 200 | saves an empty file |
| Network failure or the 120 s deadline, before or during the body | `transport`; partial file removed |
| Caller cancels, before or during the body | `aborted`; partial file removed |
| `dir` exists and is not a folder, or cannot be created | `invalid_dir` |
| Name taken in `dir` | saved as `<stem>-<file id><ext>`; `file_exists` when that is taken too |
| Slack name is a Windows device name (`NUL`, `NUL.txt`) | saved under the file ID |
| Name longer than the file system allows | `write_failed`; the name is not truncated |
| Other failure creating or writing the file | `write_failed`; partial file removed |
| A real `.html` upload | downloads normally: `files.info` reports `text/html`, so the HTML check does not fire |
| Snippet with a content address | downloads normally; a preview is never substituted for the bytes |
| Thread message with files but an empty body | same line shape, empty body, then the files suffix |
| File entry without an `id` in a thread message | skipped in the suffix; a message left with no listable file gets no suffix |
| Link from another workspace | the link's workspace is not read; access under the configured user token decides: the file saves, or Slack's own `files.info` error comes back |
| Canvas or legacy post entry in a message's `files` | listed like any entry with an `id`; `slack_download` attempts no export and applies the ordinary metadata, host, and response rules, with no special case for a type marker |

## Tests

All tests stub the Slack API and the file host; none calls live Slack.

- AC 1: a parent and a reply that carry files each show every file's name and ID on their line - `test/slack-core.test.ts`, "readThread compact: lists attached file names and IDs on parent and reply lines"
- AC 2: a message without files renders byte-identical to the current line - `test/slack-core.test.ts`, "readThread compact: a message without files has no files suffix"
- AC 3: starting from a message permalink, `slack_thread` lists the file ID and `slack_download` with that ID writes a file whose bytes equal the known contents, with no `dir` given; `globalThis.fetch` is replaced the way the suite's `withFakeFetch` does (`test/slack-config.test.ts:1472`), answering `auth.test`, `conversations.replies`, `files.info`, and the `files.slack.com` content address - `test/slack-config.test.ts`, "slack_download: permalink to thread read to saved contents"
- AC 4, refusal: a 403 from the file host throws `http_403` and leaves no file - `test/slack-core.test.ts`, "downloadFile: file host refusal is an error and leaves no file"
- AC 4, sign-in redirect: a 302 throws `file_auth_redirect`, and a second local server named in `Location` receives no request - `test/slack-core.test.ts`, "defaultDownloadBytes: does not follow redirects"
- AC 4, sign-in page: a 200 answer with content type `Text/HTML; charset=utf-8` for a `text/plain` file throws `file_auth_redirect` and creates no file; the same answer for a file whose `mimetype` is `text/html` saves normally - `test/slack-core.test.ts`, "downloadFile: HTML answer for a non-HTML file is a sign-in error"
- AC 4, missing scope: `files.info` answering `missing_scope` with `needed: "files:read"` yields an error naming `files:read`, and the byte transport is never called - `test/slack-core.test.ts`, "downloadFile: missing_scope names the scope before any byte request"
- AC 5: `doc/slack.md` names `files:read` - none: a documentation row, checked at conformance review
- Thread line edges: empty body, entry without `id`, `title` and `untitled` fallbacks, whitespace in a name - `test/slack-core.test.ts`, "renderThreadLine files suffix edges"
- Raw and structured thread output are unchanged by the suffix - `test/slack-core.test.ts`, "readThread raw: output is unaffected by the files suffix"
- Reference forms: bare ID, file page link, file content link with and without `/download/`, public permalink on `slack-files.com`; a message permalink and a non-Slack host throw `invalid_file_ref` - `test/slack-core.test.ts`, "parseFileRef"
- Invalid reference through the registered tool, with cold credentials and a fetch stub that rejects every call, returns `invalid_file_ref` - `test/slack-config.test.ts`, "slack_download: invalid reference fails before credential lookup"
- A pasted public permalink saves the file through `files.info` and the content address; the fetch stub sees no request to `slack-files.com` - `test/slack-config.test.ts`, "slack_download: public permalink is used for its ID only"
- Full file only: a 206 throws `http_206`; a body shorter than `size` throws `transport` and leaves no file; a zero-byte 200 for `size: 0` saves an empty file - `test/slack-core.test.ts`, "defaultDownloadBytes: a 206 is an error" and "downloadFile: short body fails, zero-byte file saves"
- Unread body: the HTML refusal calls the response's `cancel` before any chunk is read - `test/slack-core.test.ts`, "downloadFile: an early rejection cancels the unread body"
- Not downloadable: external file, hidden by limit, no content address, content address on another host or on http; the byte transport is never called - `test/slack-core.test.ts`, "downloadFile: file_not_downloadable cases send no token"
- Size cap: declared size above the cap fails before the byte request; a body that passes the cap fails mid-stream and leaves no file - `test/slack-core.test.ts`, "downloadFile: file_too_large on declared and received size"
- Byte transport sends `authorization: Bearer <token>` and yields the exact body bytes - `test/slack-core.test.ts`, "defaultDownloadBytes: authenticated GET returns the body"
- Body failure mid-stream maps to `transport`, caller cancellation mid-stream maps to `aborted`, and both remove the partial file and the per-call temp folder - `test/slack-core.test.ts`, "downloadFile: body failure cleans up"
- Destination: default lands under `tmpdir()/pi-slack` in a fresh folder; `dir` is created when missing; a `dir` that is a file throws `invalid_dir` - `test/slack-core.test.ts`, "downloadFile: destination folder"
- File name: separators, reserved characters, control characters, `..`, and an empty name are made safe; `NUL.txt` saves under the file ID; a taken name saves as `<stem>-<file id><ext>`; a second collision throws `file_exists`; an existing file is never modified - `test/slack-core.test.ts`, "downloadFile: file name safety and collisions"
- Binary bytes are written exactly - `test/slack-core.test.ts`, "downloadFile: binary body round-trips byte for byte"
- Relative `dir` resolves against the working directory; the typed result carries `path`, `file_id`, `name`, `mimetype`, `size`; the text line matches section 7 - `test/slack-config.test.ts`, "slack_download: dir, text, and structured result"
- Tool list, declaration ceiling, and mode-only catalog pins - `test/tool-descriptions.test.ts` (existing tests with `slack_download` in `expectedNames`; the `slack_thread` declaration stays at or below 2,500 characters with its call-shaping patterns)
- Registration pins - `test/slack-config.test.ts` (existing tests with `slack_download` in `EXPECTED_TOOL_NAMES` and counts of 9) and `test/slack-codemode.test.ts` (existing test with `slack_download` in `directSlackTools`)
- `write_failed` on a system write error - none: no portable way to force a write failure on both CI platforms; the mapping is one catch branch covered by review

## Documentation impact

Bar and template: `documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/slack.md` (communication contracts, security and permissions: the tool count in the introduction (`doc/slack.md:5`, eight becomes nine), the `slack_download` row and identity in Tools, the compact thread line's files suffix, a download section with the reference forms, destination, error codes, the 50 MB cap and 120 s deadline, the typed result in Structured results, the `files:read` user-token scope, one smoke checklist line); `CHANGELOG.md` (communication contracts: one `## Unreleased` bullet for the new tool and the thread line suffix, ending `(#47)`)
- Derived / memory docs invalidated: `README.md` (the `extensions/slack.ts` row's tool list gains `slack_download`; the tool count and list at `README.md:289` go from eight to nine; the typed-result list at `README.md:107` gains `slack_download`; the sentence naming tools the mode-only catalog omits is synced to the omission set measured from the final declarations, section 8). The historical "eight `slack_*` tools" count in `CHANGELOG.md`'s released #7 bullet stays as written.

## Out of scope

- Attachment markers on `slack_search` results (the ticket excludes them).
- Downloading during a thread read, and downloading several files in one call.
- Returning file contents inline in the tool result.
- A `pi-quiver` CLI download command.
- Downloading as the bot identity.
- Files hosted outside Slack, and canvas or legacy post export.
- Requesting a pasted link's own address, a public permalink's included; a link supplies the file ID only.
- Slack file hosts other than `files.slack.com`.
- Deleting or expiring downloaded files.

## Open questions

- What Slack's file host answers a token that lacks `files:read` is undocumented. The design does not depend on it: `files.info` runs first and names the scope, so no byte request is made with such a token and no run observes the answer. It stays unknown.
- Whether Slack's file host ever redirects an authorized request is undocumented. If it does, `slack_download` fails with `file_auth_redirect` naming the host, and following a redirect to an approved Slack host becomes a follow-up change.
- Whether GovSlack or other Slack deployments serve files from a host other than `files.slack.com` was not checked; such a file fails with `file_not_downloadable` naming the host.
- Which messages `conversations.replies` returns for a reply's ts is not stated in Slack's reference and was not verified. AC 3 from a reply's permalink rests on the reply coming back with its `files`. The smoke checklist line (section 9) starts from a reply's permalink and observes it.
