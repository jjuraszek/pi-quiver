# doc_to_md caller-driven OCR: per-page stats, forced OCR on selected pages, sidecars

**Goal:** Let a caller run `doc_to_md` once, read per-page facts (text size, image count, image coverage) from the bundle, and then force OCR on the pages it names - with the recognized text written to `ocr/` sidecars that never touch the trusted Markdown - while making a whole-document forced OCR impossible by accident and a wedged OCR process impossible to hang the caller.

Ticket: [jjuraszek/pi-quiver#26](https://github.com/jjuraszek/pi-quiver/issues/26).

supersedes `doc/specs/2026-09-30-gh-25-doc-to-md-bundle-gaps.md`, Design 1 (PDF OCR per-page decision) - extended: the textless rule stays the default, `ocrMode: all` adds the caller-forced path.

## Problem

`doc_to_md` decides per PDF page whether to OCR from one test: `page.get_text("text").strip() == ""` (`scripts/doc_to_md.py`, `mode_pdf_primary`). A scanned page whose text layer is a single stamp such as `3` counts as text-bearing, so `--ocr --pages 2` returns `3` and the scanned content is never recognized. Nothing in the result tells the caller the page was thin: the handle lists only pages with an empty text layer (`OCR: off - N page(s) without a text layer`), and the only per-page view is splitting the Markdown on `--- end of page.page_number=N ---` and counting characters - fiddly for an LLM over a 100-page document.

Two constraints shape the fix. First, forced OCR is expensive (seconds per page) and pymupdf4llm's `force_ocr=True` replaces the page's text with the OCR of the full render, so a forced pass must stay separate from the trusted text. Second, the converter runs on the caller's machine: a forced OCR that falls back to "all pages" (today both an omitted `pages` and `--pages ""` resolve to `null`, meaning all) would OCR a 100-page PDF by accident, and a MuPDF bitmap bomb inside one page can abort or spin the process (observed in ../gridstrong/librarian: a catchable `RuntimeError("compression bomb detected")`, a non-catchable C++ abort in `get_pixmap`, and an uninterruptible C-level spin that only SIGKILL ends).

The ticket proposed two options (`ocrMode`, `ocrOutput`), both settable in `quiver.docToMd`, and `all` applying to "the `--pages` selection (or the whole document)". The questionary changed all three: one option, per-call only, explicit pages required. Reasons are recorded under Design.

## Acceptance criteria

Ticket jjuraszek/pi-quiver#26, "Acceptance criteria", rows verbatim:

- [ ] Committed fixture `test/fixtures/short-text-ocr.pdf`: page 1 has a normal text layer (>= 200 characters); page 2's text layer is only `3` plus an embedded image containing a few known words. `--ocr` with defaults, English Tesseract data installed: no OCR runs on either page (today's behavior; regression test).
  in-scope
- [ ] `--ocr --ocr-mode all --pages 2` (inline output): page 2's Markdown contains the known words and the original `3`; `--json` `ocr.pages` lists 2 only; `ocr.textless` is empty.
  deviates: no inline forced output - `ocrMode: all` always writes sidecars (Design 1); the row's `ocr.pages` lists 2 only and `ocr.textless` is empty hold for the sidecar run and are Design clauses.
- [ ] `--ocr --ocr-mode all --ocr-output sidecar --pages 2`: `<stem>.md` is byte-identical to `--pages 2` without OCR; `ocr/short-text-ocr-p002.md` exists and contains the known words; the `ocr.pages` entry for page 2 carries that path.
  deviates: no `--ocr-output` flag - the same outcome is produced by `--ocr --ocr-mode all --pages 2` (Design 1, 4); byte-identity, the sidecar path and the `ocr.pages` entry are Design clauses.
- [ ] `--ocr --ocr-output sidecar` on an existing fully textless fixture page: the textless-page picture still lands in `images/`, the OCR text in `ocr/`, and the main Markdown carries only the picture link.
  deviates: no `textless` sidecar mode - `textless` keeps today's inline behavior; a textless page moves OCR text with no trusted counterpart to a separate file for no gain (Design 1).
- [ ] Either option without `--ocr` is ignored and documented as such; an invalid value is a usage error.
  deviates: `--ocr-mode all` without `--ocr` is a usage error, not ignored - silently ignoring it would reproduce the "page looked empty" trap the ticket describes (Errors 1); an invalid value is a usage error as written.
- [ ] A forced page whose OCR fails or is budget-stopped keeps its own text in the main Markdown, gets no sidecar, and appears in `ocrFailed` / `budgetStopped` as an ordinary page.
  in-scope
- [ ] Both options are settable in the tool, the CLI, `quiver.docToMd` settings and the generated Claude skill `skills/doc-to-md/SKILL.md`; `doc/doc-to-md.md` documents them and the two-pass workflow.
  deviates: `ocrMode` is a tool parameter and CLI flag only, never a `quiver.docToMd` key - a persisted `all` would defeat the explicit-pages guard on every later `--ocr` run, in pi and in Claude Code alike, since the CLI reads the same settings files (Design 2); skill and `doc/doc-to-md.md` coverage is in-scope as written.

## Design

Layers stay as they are: `scripts/doc_to_md.py` gains the behavior; `lib/doc-to-md-options.ts`, `lib/doc-to-md-core.ts`, `lib/doc-to-md-bundle.ts`, `lib/doc-to-md-handle.ts` carry the option, the guard, the second spawn, bundle ownership and handle lines; `bin/pi-quiver.ts` exposes `--ocr-mode`; `extensions/doc_to_md.ts` keeps deriving its tool schema from `DOC_TO_MD_OPTIONS`.

### 1. One option: `ocrMode`

`DOC_TO_MD_OPTIONS` gains `{ key: "ocrMode", flag: "--ocr-mode", type: "enum", enumValues: ["textless", "all"], default: "textless", settable: false }`.

- `textless` - today's behavior, unchanged: only pages with an empty text layer are OCR'd, inline, when `ocr: true`.
- `all` - every selected page is OCR'd regardless of its text layer; recognized text goes to one sidecar per page under `ocr/`; the main Markdown is byte-identical to the same call without `--ocr`.

There is no `ocrOutput` option. Of the ticket's four combinations, `textless+inline` is the status quo and `all+sidecar` is the feature; `all+inline` would mix text-layer content and OCR of the same page in one file with no way to tell them apart (the ticket's own motivation forbids that), and `textless+sidecar` moves text that has no trusted counterpart into a separate file for no gain.

### 2. Per-call only

`settable: false` means `ocrMode` is a tool parameter and a CLI flag but never a `quiver.docToMd` key; `coerceDocToMdSettings` skips it and `lintSettings` (`lib/extension-config.ts`) reports a `quiver.docToMd.ocrMode` entry with the existing unknown-key line, `"quiver.docToMd.ocrMode" - unknown; accepted: <tunable keys>`, so the value never takes effect.

Descriptor `help` (becomes the tool parameter description and the `--help` line): `OCR policy: textless (default) OCRs only pages with an empty text layer, inline; all OCRs every selected page and writes the recognized text to ocr/<stem>-pNNN.md sidecars, leaving the Markdown untouched. all requires --ocr and an explicit --pages selection (PDF, PPTX, DOC).` The CLI reads `quiver.docToMd` from the same settings files as the pi tool (`bin/pi-quiver.ts`), so a persisted `all` would turn every later `--ocr` run without `--pages` into an error - or, with a weaker guard, into a whole-document OCR - in pi and in Claude Code alike.

### 3. The explicit-pages guard

In `convertDocument` (`lib/doc-to-md-core.ts`), after `resolveOptions` and before any backend work, `ocrMode === "all"` requires:

1. `ocr === true`;
2. `pages !== null` - the resolved array, so both an omitted `pages` and `--pages ""` (which `parsePages` turns into `null`, meaning all pages) are refused. An explicitly enumerated full range (`--pages 1-100`) is accepted: the caller named it, and the ticket excludes any converter-side page cap;
3. an input type whose first pass already goes through the PDF ladder with PDF page numbers: `pdf`, `pptx`, `doc`. DOCX is rejected: its `pages` are explicit-page-break segments on the direct route and the LibreOffice route has no page selection at all (`DOCX_PAGES_OFFICE`), so a DOCX first pass cannot produce the PDF page numbers a second pass would need. HTML, image, email and spreadsheets have no pages.

Each failure is a `UsageError` with the message in Errors 1. The CLI today maps `UsageError` to exit 2 only around `resolveOptions` and turns everything thrown by `convertDocument` into `doc-to-md failed: ...` exit 1 (`bin/pi-quiver.ts`); the conversion `catch` gains the same `UsageError -> exit 2` branch so the guard delivers exit 2, and the pi tool reports it as a tool error. `--info` with `ocrMode: all` joins the existing `--info cannot be combined with ...` list.

### 4. First pass: per-page stats in `<stem>.pages.json`

Both Python PDF tiers (`mode_pdf_primary`, `mode_pdf_fallback`) collect, for every selected page, in a try/except of their own - separate from the existing per-page handler, which discards the page's Markdown and marks it failed, so a stats-only exception must never cost a readable page its content:

```json
{ "page": 7, "chars": 3, "images": 1, "imageCoverage": 0.94 }
```

- `chars` = `len(page.get_text("text").strip())`;
- `images` = `len(page.get_image_info())`;
- `imageCoverage` = sum of image bbox areas / page rect area, clamped to `1.0`, rounded to two decimals;
- a page whose stats raised gets `{ "page": 7, "error": "<message>" }` instead of counts.

The child returns the array as `pageStats`; `lib/doc-to-md-bundle.ts` writes it as `<stem>.pages.json` beside `<stem>.md` (pretty-printed JSON array) using the allocated stem, so two conversions sharing one `--output-dir` (`report.md` and `report-2.md`, or two documents) never clobber each other's stats; the file joins the stem-owned set that overwrite cleanup and `abortBundle` remove. `lib/doc-to-md-handle.ts` adds `Page-Stats: <absolute path>` beside `Saved-To`/`Images-Dir`; the CLI `--json` carries the array as `pageStats` and the path as `pageStatsPath`. The unpdf tier has no stats: no file, no handle line, `pageStats: null`. When the whole child is killed or crashes, there are no stats either - the existing tier failure path applies, nothing partial is written.

No threshold lives in the converter. The consumer reads the facts and decides; a thin page is whatever the consumer's policy says it is.

### 5. Second pass: the `ocr-pages` child

When `ocrMode === "all"`, `convertDocument` runs in this order, holding the bundle lock throughout:

1. **Main tier with `ocr: false`.** The first pass is spawned with OCR off even though the caller passed `--ocr`: with OCR on, `mode_pdf_primary` inline-OCRs every fully textless page in the selection, which would break byte-identity and OCR those pages twice. The main Markdown, `pageStats` and `textless` (the empty-text-layer page list, still collected by the child) come from this untouched path; whichever tier produced it (`pdf-primary` or `pdf-fallback`) is irrelevant to the second pass. For PPTX/`.doc` the PDF is the LibreOffice output the main tier already has. No Python backend (unpdf tier) -> Errors 2.
2. **`ocr-pages` child.** The Python child is spawned once more in the new mode `ocr-pages` with `{ path, pages, ocrLanguage, ocrBudgetMs, stagingDir, dpi: imageDpi }`, under the same `runCapped` wrapper (hard timeout `primaryTimeoutMs`, SIGKILL of the process group, abort signal, output cap). The child first runs `ocr_status(True, lang)`; `unavailable` returns `{ status: "unavailable", reason }` and nothing else (Errors 2). Otherwise, for each selected page in ascending order it:
   1. writes the page number to `<stagingDir>/active` (the checkpoint), then runs the `ocr_admit` budget check (same estimates and 5000 ms reserve as today); if the next page would overrun `ocrBudgetMs`, it stops and lists this and the remaining pages as `budgetStopped`;
   2. renders and recognizes with `tp = page.get_textpage_ocr(full=True, language=lang, dpi=clamped_dpi(w, h, imageDpi))` and pulls plain text with `page.get_text("text", textpage=tp)`; `clamped_dpi` bounds the render by `MAX_RENDER_PX`, so a 20000x20000 embedded bitmap never produces a 20000x20000 render, and a `None` clamp (page too small or too large to render) is a per-page failure with that reason;
   3. writes `<stagingDir>/pNNN/<stem>-pNNN.md`: first line `<!-- OCR of page N (tesseract <lang>); recognized text, not the text layer -->`, blank line, the plain recognized text (no reconstructed headings or tables), then the existing page separator `--- end of page.page_number=N ---`; text that is empty after `strip()` still writes the header-only sidecar and lands in `noText`;
   4. on success writes `<stagingDir>/pNNN/.done`; on any caught exception writes `<stagingDir>/pNNN/.failed` holding the message and removes the sidecar file; either way deletes `active` and moves on. Terminal outcomes are therefore on disk before the next page starts, and the checkpoint names the page in flight.

   It returns `{ status: "ran", written: [n...], noText: [n...], ocrFailed: [n...], ocrErrors: { "n": "<message>" }, budgetStopped: [n...] }`. A sidecar is never written for a page in `ocrFailed` or `budgetStopped`; the main Markdown keeps that page's own text regardless.
3. **Recovery when the child exits non-zero, is killed, or returns malformed output.** The parent never throws here. It reads the staging dir: pages with `.done` are `written`/`noText` (header-only file), pages with `.failed` are `ocrFailed` with their messages, the page named in `active` (if present) is `killed`, every selected page with no marker and not the active one is `notAttempted`. No `active` file and no page dirs means the child died before processing - `killed: null`, `notAttempted` = all selected pages, and the handle reports `OCR child failed before processing pages: <exit reason and stderr tail>` instead of blaming a page.
4. **`publishSidecars(b)`** (new, in `lib/doc-to-md-bundle.ts`, modeled on the page-image publisher): moves each `.done`-gated `pNNN/<stem>-pNNN.md` into `<outputDir>/ocr/`, records it in an `ocr` manifest on the `Bundle` (`ocrDir`, `ocrStagingDir`), and removes the staging dir. `ocr/<stem>-*` joins the stem-owned set that overwrite cleanup and `abortBundle` remove. The existing `publishStaged` is for images and is not reused.
5. **`commitBundle`** writes the Markdown and releases the lock, as today, after the sidecars are in place; then `formatHandle`.

Cleanup rules: a sidecar-child failure is a reported outcome, never an abort - the Markdown and completed sidecars are committed. The only path to `abortBundle` is the existing one: a thrown error, which for this phase means caller cancellation (`AbortSignal`) or a publish I/O error; abort then removes staged and published assets as today and the Markdown is never written, so no committed file refers to a missing asset. Holding the lock through the second pass keeps a concurrent `--overwrite` on the same stem refused while sidecars are still being produced. No automatic retry of the sidecar child.

The child itself is a Python mode function `mode_ocr_pages(o)` beside `mode_pdf_primary`, driven by `main()` like the other modes.

### 6. Result surface

`OcrInfo` (`lib/doc-to-md-core.ts`, `lib/doc-to-md-handle.ts`) keeps every existing field with its existing type - `status`, `lang`, `textless: number[]`, `pages: number[]`, `noText: number[]`, `ocrFailed: number[]`, `budgetStopped: number[]` - and gains:

| field | type | `textless` and image runs | `all` runs |
|---|---|---|---|
| `mode` | `"textless" \| "all"` | `"textless"` | `"all"` |
| `sidecars` | `Record<number, string>` (page -> absolute sidecar path) | `{}` | one entry per written or header-only sidecar; this is how the `ocr.pages` entry "carries that path" |
| `ocrErrors` | `Record<number, string>` (page -> message) | `{}` | one entry per `ocrFailed` page |
| `killed` | `number \| null` | `null` | the checkpointed page, or `null` |
| `notAttempted` | `number[]` | `[]` | pages after a kill, or all pages after a pre-processing death |
| `childError` | `string \| null` | `null` | the child's exit reason plus the tail of its stderr (as `runTierReal` already reports failures) when the child died outside page processing |

For `all` runs `status` is `"ran"` (or `"unavailable"` only transiently before Errors 2 turns it into the hard error), `pages` = `written`, `textless` is the first pass's empty-text-layer list (empty for text-bearing pages), and `noText`/`ocrFailed`/`budgetStopped` are the child's lists. `handleOcr` today returns `null` for a PDF when `textless`, `pages` and `ocrFailed` are all empty; with `mode === "all"` it always returns the object, so a forced run whose every page was budget-stopped or header-only still has an `OCR:` line. Both modes' JSON shapes are pinned in tests.

Handle (`lib/doc-to-md-handle.ts`):

- `OCR-Dir: <absolute ocr/ path>` beside `Page-Stats:` when at least one sidecar exists;
- `OCR:` line for `all`: `OCR: forced (eng) - sidecars for pages 2, 7; no text on page 9; failed on page 4 (<message>); budget-stopped pages 13, 20 - re-run with --pages 13,20`, listing only non-empty buckets; a kill reads `... page 13 killed the OCR child (timeout or crash - likely a compression bomb); pages 20, 25 not attempted - re-run with --pages 20,25`; a pre-processing death reads `... OCR child failed before processing pages: <exit reason and stderr tail>; pages 2, 7 not attempted - re-run with --pages 2,7`. The `killed` page gets no re-run hint.
- `textless` runs: unchanged wording plus the new `Page-Stats:` line.

CLI `--json`: `pageStats` (array or null), `pageStatsPath` and `ocrDir` (string or null), and the extended `ocr` object.

The pi tool's `description` in `extensions/doc_to_md.ts` gains one sentence: `Two-pass OCR: read Page-Stats first, then re-run with ocr: true, ocrMode: "all" and an explicit pages selection to get ocr/ sidecars for the pages you name.`

### 7. Usage documentation

A `USAGE_PATTERNS` string lives in `lib/doc-to-md-options.ts` next to the descriptors, parameterized by the command prefix, and is rendered verbatim at the end of `renderHelp` output (`--help`/`-h`, prefix `pi-quiver doc-to-md`) and by `scripts/gen-skill.mjs` as a `## Usage patterns` section after the generated `## Flags` table in `skills/doc-to-md/SKILL.md` (prefix the skill's pinned `npx -y pi-quiver@<version> doc-to-md`). It documents the two-pass pattern as a copy-paste recipe:

```
Two-pass OCR (PDF, PPTX, DOC):
  1. <cmd> report.pdf --output-dir out --json
       -> "pageStatsPath" points at out/report.pages.json; pages with few
          chars and high imageCoverage are scans. "savedTo" is the Markdown.
  2. <cmd> report.pdf --output-dir out --ocr --ocr-mode all --pages 2,7 --json
       -> "ocr"."sidecars" maps 2 and 7 to out/ocr/report-2-p002.md and
          ...-p007.md (a second run in the same dir gets stem report-2);
          the Markdown of this run holds pages 2 and 7 only and equals what
          --pages 2,7 without --ocr would produce. Read sidecars and Markdown
          by the returned paths, never by guessing names.
  3. --ocr-mode all refuses to run without --ocr and an explicit --pages.
     The "ocr" object (OCR: line) names failed, budget-stopped, killed and
     not-attempted pages and the exact --pages to re-run.
```

`doc/doc-to-md.md` carries the longer narrative (bundle contract for `<stem>.pages.json` and `ocr/`, every failure bucket, why `all` is per-call and page-gated, the bitmap-bomb rationale); the usage block cites it.

## Errors and edge cases

1. Usage errors, raised before any spawn, one message each:
   - `--ocr-mode all requires --ocr`
   - `--ocr-mode all requires an explicit --pages selection (e.g. --pages 2,7); omitted pages and --pages "" mean all pages and are refused to keep OCR cost bounded`
   - `--ocr-mode all applies to PDF, PPTX and DOC inputs only (DOCX pages are page-break segments, not PDF pages; convert the DOCX to PDF first)`
   - `--info cannot be combined with ...` (existing message, `--ocr-mode all` added to the list)
   - an invalid `--ocr-mode` value: the existing enum usage error.
2. Tesseract or language data missing under `all`: the `ocr-pages` child's own `ocr_status(True, lang)` check (independent of which tier produced the Markdown - the fallback tier reports `unavailable: fallback tier` for inline OCR, which is irrelevant here) returns `unavailable` with the existing reason (`Tesseract language data not found` / `language data for <part> not installed`); the parent turns it into a hard error, aborts the bundle and writes no Markdown. The caller asked for OCR explicitly, so skipping silently is the trap the ticket describes. No Python backend (unpdf tier) fails before the main tier with reason `no Python backend`.
3. Pages out of range are rejected by the existing `check_pages` bounds error in the first pass; the sidecar child never sees them.
4. Sidecar child outcomes (all reported, none fatal): `written`, `noText` (header-only sidecar), `ocrFailed` (no sidecar, message kept), `budgetStopped` (no sidecar), `killed` + `notAttempted` (completed sidecars published, culprit named, no automatic retry). A budget stop with `primaryTimeoutMs` at its 60 s default caps an accidental 100-page explicit selection at roughly a dozen pages and tells the caller exactly what to re-run.
5. Stats on a bombed page: the stats-only try/except yields `{ page, error }` and the page's Markdown is unaffected; the table is still written. A native abort or C-level spin is not catchable in Python - that kills the main child, and the existing tier failure/timeout path applies (no partial stats).
6. `imageCoverage` is clamped to `1.0` because overlapping image bboxes can sum past the page area.
7. Bundle collisions: sidecars use the allocated stem (`<stem>-2` after a rename), so `ocr/<stem>-2-p002.md` sits beside `<stem>-2.md`; the handle's absolute paths are the source of truth, never the input basename.
8. `textless` mode behavior, Markdown, and `OCR:` wording are unchanged; `<stem>.pages.json` and `Page-Stats:` are the only additions to a default run.
9. Caller cancellation (`AbortSignal`) during the sidecar pass throws as today and aborts the bundle; a timed-out or crashed sidecar child is a reported outcome (Design 5 step 3), not a cancellation.

## Tests

- `test/doc-to-md-options.test.ts` / `test/extension-config.test.ts`: `ocrMode` descriptor pinned as `settable: false`, enum values, default `textless`; a `quiver.docToMd.ocrMode` settings entry produces the unknown-key lint line and is not applied.
- `test/doc_to_md.test.ts` / `test/doc-to-md-cli.test.ts`: the four usage errors (no `--ocr`; omitted pages; `--pages ""`; DOCX, HTML and image inputs) each with CLI exit code 2 asserted, `--info` incompatibility, `--help` output contains the usage block; `convertDocument` is spawned with `ocr: false` on the main tier for an `all` run (seam assertion).
- `test/fixtures/generate.py` gains `short_text_ocr_pdf()` producing the committed `test/fixtures/short-text-ocr.pdf` (page 1: >= 200 chars of text; page 2: text layer `3` plus a full-page image of known words).
- `test/doc_to_md.python.test.ts` (skips without `uv`; OCR-text assertions skip without English Tesseract data, as today):
  - first pass `--ocr` default: no OCR on either page (regression); `short-text-ocr.pages.json` has page 1 with `chars >= 200, images: 0` and page 2 with `chars: 1, images: 1, imageCoverage >= 0.9`; `Page-Stats:` line present.
  - `--ocr --ocr-mode all --pages 2`: `ocr/short-text-ocr-p002.md` exists with the header line and the known words; `ocr.pages == [2]`, `ocr.textless == []`, `ocr.sidecars[2]` is that path; `<stem>.md` bytes equal the `--pages 2` no-OCR run; `OCR-Dir:` present.
  - `scan.pdf --ocr --ocr-mode all --pages 1` (the fully textless page): `<stem>.md` bytes equal the `--pages 1` no-OCR run (the picture link, no inline OCR block), one sidecar, `ocr.textless == [1]`.
  - `all` after a forced `pdf-fallback` tier (`runTier` seam): sidecars are still produced.
  - `--ocr --ocr-mode all --pages 1,2` with the test-only env var `DOC_TO_MD_OCR_STALL_PAGE=1` (the `ocr-pages` child sleeps after writing `active` for that page; same convention as the existing `DOC_TO_MD_FORCE_DOCX_FALLBACK` hook) and a 3000 ms deadline on the sidecar spawn (seam): main Markdown intact, `killed: 1`, `notAttempted: [2]`, no `ocr/` files.
- `test/doc_to_md.child.test.ts` (Python functions driven directly, as `m.mode_image(...)` is today): `mode_ocr_pages` with `get_textpage_ocr` monkeypatched to raise on page 1 -> `.failed` marker, `ocrFailed == [1]`, `ocrErrors[1]` set, page 2 still written; a fake clock exhausting the budget -> `budgetStopped`; empty OCR text -> header-only sidecar and `noText`; a stats-only exception on a readable page in `mode_pdf_primary` -> `{ page, error }` row and the page's Markdown intact.
- Recovery (TypeScript, over a hand-built staging dir): failure -> success -> crash (`p1/.failed`, `p2/.done`, `active` = 3, selection `[1,2,3,4]`) yields `ocrFailed [1]`, `written [2]`, `killed 3`, `notAttempted [4]`; success -> crash; empty staging dir with stderr -> `killed null`, `childError` set, all pages `notAttempted`.
- `test/doc-to-md-bundle.test.ts`: `<stem>.pages.json` and `ocr/<stem>-*` are published, removed on abort, replaced on overwrite; two stems in one root keep separate stats files; `--overwrite` on a stem whose lock is held is refused.
- `test/doc-to-md-handle.test.ts`: `OCR:` wording per bucket incl. the kill sentence, the pre-processing death sentence and the re-run hint; `Page-Stats:`/`OCR-Dir:` lines; `textless` wording unchanged; both modes' `ocr` JSON shapes pinned.
- `test/skill-generation.test.ts`: already fails on drift once `USAGE_PATTERNS` is rendered into the skill.

## Documentation impact

Materiality bar: `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/doc-to-md.md` (communication contract: `<stem>.pages.json` and `ocr/` bundle entries, `Page-Stats:`/`OCR-Dir:`/`OCR:` handle lines; operations: the two-pass pattern, failure buckets and re-run hint; rationale: why `all` is per-call, page-gated and sidecar-only, and the bitmap-bomb failure shape); `README.md` (option table: `ocrMode` as per-call only); `CHANGELOG.md` - deferred: release
- Derived / memory docs invalidated: `skills/doc-to-md/SKILL.md` (generated from the descriptors and `USAGE_PATTERNS`; regenerate with `node scripts/gen-skill.mjs`); `AGENTS.md` Layout line for `scripts/doc_to_md.py` only if the `ocr-pages` mode is named there - otherwise none

## Out of scope

- Converter-side thin-page thresholds, page caps, or any automatic page selection (the ticket's consumer policy of `< 40 chars`, max 60 pages stays in the consumer).
- Inline forced OCR (`all` + inline) and sidecars for `textless` mode.
- Per-image OCR on text-rich pages; stitching sidecars back into the main Markdown.
- `ocrMode` on DOCX, HTML, image, email, Excel inputs.
- Automatic retry after a killed sidecar child; bisecting the toxic page beyond naming the checkpointed one.
- Positional word sidecars (`<stem>.words.json`, deferred in #25).

## Open questions

- None blocking. Whether `get_image_info()` double-counts an image placed twice on a page is unverified; the clamp in Errors 6 makes it harmless.
