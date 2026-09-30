# doc_to_md bundle gaps: OCR images, formats, page renders, numbering, scripting surface

**Goal:** Close the eight gaps issue #25 found when converting a real 4,648-file document capture, without narrowing `doc_to_md` to that capture: fix the OCR image loss, add `.xlsm`/`.doc`/`.msg`/`.eml`, restore Word auto-numbering on the fast DOCX path, add opt-in page images, tighten the CLI scripting surface, and make the Claude Code skill regenerate from the tool schema.

Ticket: [jjuraszek/pi-quiver#25](https://github.com/jjuraszek/pi-quiver/issues/25).

supersedes `doc/specs/2026-09-29-doc-to-md-ocr-html-input.md`, Design sections 3-4 (PDF OCR per-page decision and image retention) and 7 (handle lines for OCR and page renders).
supersedes `doc/specs/2026-09-10-gh-17-excel-output-v2.md`, handle preview note and same-stem collision behavior.
supersedes `doc/specs/2026-09-28-gh-24-direct-docx-conversion-toc-offsets.md`, DOCX numbering output and the no-page-breaks handle text only.

## Problem

Fifteen representative conversions and an extension census of the capture surfaced these defects and gaps, all reproducible with synthetic fixtures:

1. **OCR drops images.** `page_ocr_kwargs` in `scripts/doc_to_md.py` returns `use_ocr=True` for text-bearing pages when `ocr: true` (unless `small_image_gate` vetoes); pymupdf4llm then rasterizes pages its analyzer judges to need OCR - including pages with a text layer plus pictures - and writes no images. `--ocr --pages 3` on such a page returns `Images: 0`, exit 0. The non-OCR run keeps the images.
2. **Unsupported common formats.** `.xlsm`, `.doc`, `.msg`, `.eml` are rejected by the `SUPPORTED` map in `lib/doc-to-md-options.ts` even though the containers are ones we already open (`.xlsm` is openpyxl, `.doc` is the LibreOffice route) or a plain email container.
3. **No page images.** Vision-model readers need a picture of the page; today only textless pages are rasterized (and only as OCR input).
4. **Auto-numbering lost.** Since 6.5.0 DOCX goes through mammoth -> markdownify. Verified with a generated DOCX (`List Number`, `List Number 2`, numbered `Heading 2`): mammoth 1.13 emits one flat `<ol>` with no literal labels and collapses nesting, so `3.2.1` clause labels and heading numbers disappear from the Markdown. Cross-references like "see 3.2.1" become unresolvable.
5. **Zero-byte input** is not rejected at the boundary; the backend ladder runs and fails with a backend-specific message.
6. **Stem rule undocumented; collisions are a hard error.** `sanitizeStem` (`[^A-Za-z0-9._-]+` -> `_`, empty -> `document`) is documented nowhere, so a script cannot predict `Site A & B report.pdf` -> `Site_A_B_report.md`. A second input with the same stem in one `outputDir` fails with `Output exists: <path> (pass overwrite)` (pinned by `test/doc-to-md-cli.test.ts` and `test/doc-to-md-bundle.test.ts`), so a batch over a capture with `report.pdf` and `report.docx` stops instead of producing both.
7. **Claude Code skill drifts.** `skills/doc-to-md/SKILL.md` is hand-maintained and listed fewer formats than the tool; the marketplace has no `version`, and third-party marketplaces do not auto-update by default (verified against current Claude Code docs), so a reader on a stale plugin copy has no signal.
8. **Handle is quiet about two limits.** A spreadsheet preview capped at 100 rows x 50 columns says so only inside the Markdown; a DOCX without author-inserted page breaks says `(no explicit page breaks)` but not how to cite.

Premises checked: mammoth does not emit labels (disproved the ticket's "if mammoth already does this" branch); `claude update` updates the app, not plugins; nothing in the sibling repos consumes a `doc_to_md` bundle today, and their `.msg`/`.doc`/`.xlsm` code is library-level use of the same dependencies, so adding the routes here duplicates no contract.

## Acceptance criteria

Ticket #25, "Acceptance criteria" grouped lists, rows verbatim:

- [ ] A committed synthetic fixture PDF has one page with a text layer and two embedded images; `--ocr` on it produces a bundle whose `images/` holds the same page images as the non-OCR run and whose Markdown links each of them; regression test added.
  in-scope
- [ ] When OCR runs on a page and recognizes no text, the handle's `OCR:` line reports that page (using the existing no-text clause if there is one).
  in-scope
- [ ] `.xlsm` converts through the same route as `.xlsx` (sheet inventory, CSVs, preview); macros are ignored and the handle says so.
  in-scope
- [ ] `.doc` converts via LibreOffice to PDF and then through the PDF ladder, with the same `Degraded:` marking as the DOCX LibreOffice fallback; without `soffice` it fails with the existing "needs LibreOffice" message.
  in-scope
- [ ] `.msg` converts to Markdown with From/To/Cc/Date/Subject, the text body, and a list of attachment names and sizes (`.eml` accepted the same way if cheap).
  in-scope
- [ ] The unsupported-type error lists the new extensions as supported.
  in-scope
- [ ] An opt-in flag writes `<stem>.words.json` beside the Markdown: `{"pages":[{"page":N,"width":W,"height":H,"words":[{"text":"...","bbox":[x0,y0,x1,y1]}]}]}` in PDF points, origin top-left, page rotation applied so bbox matches the rendered page image; documented in `doc/doc-to-md.md`.
  deferred: consumer code - the caller holds the PDF and `page.get_text("words")` is one PyMuPDF call; a new ticket if a consumer asks (questionary Q1)
- [ ] An opt-in flag renders every selected PDF/PPTX page to `images/<stem>-p<N>-page.<fmt>` at `imageDpi` regardless of text layer, and the Markdown links each page image after that page's text.
  deviates: page images live in their own `pages/` directory as `pages/<stem>-p<N>.<fmt>` so figure assets and page renders never mix (questionary Q3); the flag, `imageDpi`, "regardless of text layer", and the Markdown link after each page's text are Design clauses (section 4)
- [ ] A committed DOCX fixture with Word auto-numbered headings and a multi-level auto-numbered list converts with the literal numbers (`3.2.1`) present in the Markdown text; if mammoth already does this, the fixture and test are added and this AC closes as verified.
  in-scope
- [ ] A 0-byte input fails with a message containing `empty file`, exit 1, before any backend is launched.
  in-scope
- [ ] `--json` prints the handle as one JSON object (savedTo, imagesDir, sheetsDir, type, engine, tier, pageCount, pages, images, degraded, fallbackReason, ocr, notes) and nothing else on stdout.
  in-scope (reading: the list names the content; the keys are `HandleData`'s property names, so the image count is `imageCount` - section 6)
- [ ] `--pages ""` means all pages; documented.
  in-scope
- [ ] `--stem <name>` sets the bundle name instead of the sanitized basename; documented.
  deviates: the documented stem rule lets a caller compute the name before the call, and collisions get a `-N` suffix, so a naming parameter adds machinery without a problem left to solve (questionary Q5)
- [ ] `skills/doc-to-md/SKILL.md` pins the version it documents (`npx -y pi-quiver@6.x.y`), lists the current formats and flags, and the release workflow regenerates or checks it so a skill/CLI mismatch fails CI.
  in-scope
- [ ] `doc/doc-to-md.md` states that the Claude plugin and the npm package are two install channels and how to keep them on one version.
  in-scope
- [ ] The spreadsheet handle carries a `Notes:` line when a preview is truncated (`preview 100 of N rows; full data: sheets/<file>.csv`).
  in-scope
- [ ] The DOCX handle's `(no explicit page breaks)` suffix is followed by `- no page markers; cite by Outline line`.
  in-scope

## Design

The change stays inside the existing layers: `scripts/doc_to_md.py` (Python child) gains the behavior; `lib/doc-to-md-options.ts`, `lib/doc-to-md-core.ts`, `lib/doc-to-md-bundle.ts`, `lib/doc-to-md-handle.ts` carry options, routing, bundle ownership and handle lines; `bin/pi-quiver.ts` exposes CLI flags; `extensions/doc_to_md.ts` stays a thin adapter that derives its tool schema from `DOC_TO_MD_OPTIONS`.

### 1. PDF OCR: the per-page decision is ours

`mode_pdf_primary` decides per selected page from `page.get_text("text").strip()` (already computed as `textless`):

- text present -> `primary_page_markdown` with an explicit `{"use_ocr": False}`; pymupdf4llm's layout path defaults `use_ocr` to `True`, so omitting the key is not enough - the key is always passed and always `False` on a text-bearing page. pymupdf4llm's normal extractor then writes embedded images exactly as the non-OCR run does.
- no text (empty or whitespace-only layer) -> the existing textless path: `render_textless_page` at `imageDpi` (clamped by `MAX_RENDER_PX`), `{"use_ocr": True, "force_ocr": True}` when `ocr: true` and Tesseract data exists, otherwise the page image alone.

`page_ocr_kwargs` reduces to `textless -> force-OCR kwargs, else {"use_ocr": False}`; `small_image_gate`, `SMALL_IMAGE_FRACTION` and the `page.get_images()` branch become dead and are deleted in the same commit.

The handle's `OCR:` "ran" line replaces the count clause `N returned no text` with `no text on pages <ranges>` (`compactRanges` over `ocr.noText`), so the AC's "reports that page" holds; `doc/doc-to-md.md`'s OCR table row is updated. The rule is documented in `doc/doc-to-md.md` (OCR section) and in the `ocr` option description.

### 2. Formats

`InputType` gains `"doc"`, `"xlsm"`, `"email"`; `SUPPORTED` maps `.doc`, `.xlsm`, `.msg`, `.eml`; the unsupported-type error lists them through the existing `Object.keys(SUPPORTED)` join.

| Ext | Type | Convert route | `--info` | Handle |
|---|---|---|---|---|
| `.xlsm` | `xlsm` | the openpyxl branch of `mode_xlsx` (two loads as today; no `keep_vba`); `isExcel` covers `xlsm` | as `.xlsx` | `Type: xlsm   Engine: openpyxl`; note `macros ignored (VBA project not converted)` |
| `.doc` | `doc` | straight to `s.office` (soffice -> PDF) then the PDF ladder, never the mammoth tier; `pages` applies to the PDF | soffice -> PDF -> `mode_info`, as PPTX | `Degraded: <DEGRADED_DOCX_OFFICE>` (the same constant the DOCX fallback uses); without soffice: `DOC conversion needs LibreOffice (soffice); direct conversion is not available. Python backend: <state>. Remedy: install LibreOffice` (the PPTX message shape) |
| `.msg` | `email` | `mode_email`, parsed with `extract-msg` | usage error `info does not apply to email; convert directly` (as HTML/image) | `Type: email   Engine: extract-msg` |
| `.eml` | `email` | `mode_email`, parsed with stdlib `email.message_from_bytes(policy=email.policy.default)` | same | `Type: email   Engine: email` |

Backend contract for email: `PACKAGE_PINS` gains `extract-msg` (current PyPI release at implementation time); `pinSpecs`, `warmArgs` (`import extract_msg`) and `PROBE_PROGRAM` (a fourth line `EMAIL yes|no` on `import extract_msg, markdownify`) gain it; `ProbeResult`/`Backend` gain `email: boolean`; `parseProbeOutput` accepts the new line. `VENV_DIR_NAME` becomes `doc-to-md-venv-v4` and `doc-to-md-venv-v3` joins the legacy cleanup list; the venv `healthy` predicate requires `email`. A system Python selected for `pdf` that lacks `extract_msg` fails `.msg` before the child launches with `MSG conversion needs the extract-msg package. Python backend: <state>. Remedy: install uv, or pip install extract-msg markdownify into that Python`. `.eml` needs `markdownify` only (already probed under `DOCX`), so a backend with `docx: true` converts `.eml`; the error for a backend without it names `markdownify`.

Email bundle (`<stem>.md`):

```markdown
# <Subject, or "(no subject)">

| Header | Value |
|---|---|
| From | ... |
| To | ... |
| Cc | ... (row omitted when empty) |
| Date | ISO 8601 with offset |
| Subject | ... |

<body: HTML part through markdownify with the HTML-route settings; else text/plain verbatim; else the line `Body: none`>

## Attachments

- `<safe name>` (<size via formatSize>, <content-type>) -> attachments/<safe name>
```

Attachment names are never trusted: `safe name = sanitizeStem(basename of the supplied name without extension) + lowercased extension` (extension sanitized by the same class), empty or missing name -> `attachment-N`; duplicates within one message get `-2`, `-3`. Inline parts referenced by `cid:` from the HTML body are written as images (`images/<stem>-p1-<n>.<ext>` through the existing image staging and link rewrite); every other part is written unconverted to `attachments/<stem>-<safe name>` (one call converts one document; a nested PDF is the caller's next `doc_to_md` call). There is no size cap on attachments - the child writes them to the staging dir, not to stdout, so `OUTPUT_MAX_BYTES` does not apply. `## Attachments` is omitted when there are none.

Bundle ownership: `Bundle` gains `attachmentsDir`, `attachmentsStagingDir` and `attachmentManifest`; staging, publish, `commitBundle`, `abortBundle` and `overwrite` cleanup treat `attachments/` as `sheets/` is treated, except that ownership of attachment files is taken from the `attachments/<stem>-...` links in the existing `<stem>.md` rather than from a filename pattern, because safe names are arbitrary and a prefix pattern would match another stem's files (`manual` vs `manual-notes`) or a renamed sibling's (`m` vs `m-2`); `validateImageLinks` validates `attachments/<file>` links against the manifest the way it validates `sheets/`.

### 3. DOCX auto-numbering on the fast path

New module `scripts/docx_numbering.py`, imported by `scripts/doc_to_md.py` and shipped in `package.json` `files`.

**Label computation.**

1. Parse `word/numbering.xml`: per `w:abstractNum` the levels (`w:numFmt`, `w:lvlText`, `w:start` default 1, `w:lvlRestart`, `w:isLgl`, `w:pStyle`); per `w:num` the `w:abstractNumId` and `w:lvlOverride` entries (`w:startOverride`, or a full `w:lvl` replacement).
2. Parse `word/styles.xml` paragraph styles: `w:basedOn` chain and any `w:pPr/w:numPr`.
3. Walk every `w:p` descendant of `w:body` in document order - the same element set mammoth's `transforms.paragraph` visits (depth-first through tables, SDTs, hyperlinks, tracked insertions; footnotes and comments are separate parts and are not visited). A paragraph is numbered when it has a direct `w:pPr/w:numPr` (`numId` != 0), or its style chain has one, or a level's `w:pStyle` names its style (mammoth's own direction of lookup); the first match in that order decides `(numId, ilvl)`.
4. Counters: one array per `abstractNumId` shared by every `w:num` that references it, level `i` initialized to `start_i` - 1; a `w:num` whose `w:lvlOverride/w:startOverride` names level `i` resets that level to `startOverride_i` - 1 on its first paragraph, so the first hit renders the override start. On a hit at level `L`: increment level `L`; for each deeper level `d > L`, reset to `start_d - 1` unless that level's `w:lvlRestart` is `0` (never restart) or names a level `r` with `r > L`'s ancestor rule (restart only when a level at or above `r` changed - implemented as: reset `d` when `lvlRestart_d` is absent, or `L < lvlRestart_d`; `lvlRestart` is one-based, so `0` never satisfies it). Render `lvlText` by substituting `%n` with the level `n-1` counter formatted per that level's `numFmt`; when the level has `w:isLgl`, every substituted counter renders `decimal`.
5. Supported `numFmt`: `decimal`, `decimalZero`, `lowerLetter`, `upperLetter`, `lowerRoman`, `upperRoman` -> label; `bullet`, `none` -> bullet (`-`); any other format, a `lvlText` with no `%n` and no `bullet` format, a `numId` pointing at a missing `w:num`, or a level index beyond the definition -> the whole document is **unsupported** and takes the fallback below. Inventing a label is never allowed.
6. Return the ordered list of `label | "-" | None` for every visited paragraph.

**Application.** `docx_mammoth` calls `mammoth.convert_to_html(f, transform_document=transforms.paragraph(fn))` (verified on mammoth 1.13.0). `fn` consumes the label list through a shared iterator - position is the only correspondence, so the module's element set and mammoth's must agree, which step 3 pins - and the module's decision is the single truth: for every paragraph `fn` returns `p.copy(numbering=None, children=[documents.run([documents.text(label + " ")])] + list(p.children))` when the label is a string, or `p.copy(numbering=None)` when it is `None`. Clearing `numbering` on every paragraph is what stops mammoth from also emitting `<ol>`/`<ul>`; headings keep their style so `Heading 2` renders `## 2.1 Scope`; bullets render as literal `- ` items. The Markdown is final with no post-pass. Typed text that looks like a label (a literal "3.2.1" in a plain paragraph) is untouched because it never carried `numPr`.

**Non-blocking guard.** Label computation runs inside a `try`. When it raises, or returns "unsupported", the transform is not installed. When the iterator is exhausted before mammoth finishes, or labels remain after it finishes (element-set drift), the conversion is discarded and mammoth runs once more without the transform. In every fallback case today's output is produced and the child adds the note `Numbering: labels unavailable (<reason>)`, exit 0. The python-docx fallback route (`docx_fallback`) never labels and always adds `Numbering: labels unavailable (python-docx fallback)`. A document is always either fully labeled or plainly unlabeled, never mixed.

### 4. Page images (`pageImages`)

New boolean option `pageImages`, default `false`, in `DOC_TO_MD_OPTIONS` (per-call only; not a settings key). CLI flag `--page-images`. The name avoids the child protocol's existing `TierJson.renderPages: number[]` (Excel sheet indices) and the `render-pages` child mode.

| Route | Behavior |
|---|---|
| PDF primary tier (Python); PPTX and `.doc` through their LibreOffice PDF | the child writes `pages/<stem>-pNNN.<imageFormat>` (`NNN` = 1-based page zero-padded to the page-count width) for every page in the `pages` selection, or every page when `pages` is omitted or `""`, regardless of text layer, at `imageDpi` clamped by the existing `clamped_dpi`/`MAX_RENDER_PX` rule. A textless page's existing render is this file (one render per page, linked once). |
| PDF fallback tier (PyMuPDF `get_text`) | same as primary |
| DOCX on the LibreOffice fallback route | all pages of the LibreOffice PDF; the existing rule that `pages` is rejected on this route is unchanged |
| unpdf (no Python backend) | no renders; handle `Pages-Dir: none - page images need the Python backend` |
| DOCX fast path, Excel, HTML, image, email | no renders; handle `Pages-Dir: none - <type> has no page geometry` |

The Markdown gets `![page N](pages/<stem>-pNNN.<fmt>)` after that page's text and before the `--- end of page.page_number=N ---` marker. A page whose render fails or whose `clamped_dpi` is `None` is skipped and counted in the note `Page images: N of M unavailable`.

Protocol and bundle: `TierJson` gains `pageImages?: { page: number; file: string }[]`; the child stages under `pages/.stage-<lockId>/`; `Bundle` gains `pagesDir`, `pagesStagingDir`, `pageManifest` with publish/commit/abort/overwrite handling like `images/`; `validateImageLinks` accepts `pages/<file>` against `pageManifest`. `HandleData` gains `pagesDir: string | null` and `pageImageCount: number`; the handle prints `Pages-Dir: <path> (<N> pages)` when renders were written and the `none` variants above when `pageImages` was requested and nothing could be rendered.

### 5. Stem rule, collisions

The stem rule stays `basename without extension`, `[^A-Za-z0-9._-]+` -> `_`, empty -> `document`, and is documented in one sentence in `doc/doc-to-md.md`, the generated skill, and the `outputDir` option description.

Collision replaces today's `Output exists` error: `openBundle` probes `<stem>`, `<stem>-2`, `<stem>-3`, ... and takes the first candidate where neither `<candidate>.md` nor `<candidate>.md.lock` exists, then acquires that candidate's lock; the handle carries `Notes: renamed to <stem>-2 (<stem>.md exists)`. `overwrite: true` replaces `<stem>` in place, as today. Asset files stay in the flat `images/`, `sheets/`, `pages/`, `attachments/` directories and are `<stem>-` prefixed as today, so a renamed stem prefixes its own files and no bundle shares assets. The two tests that pin the old error (`test/doc-to-md-cli.test.ts` "collision -> exit 1 with Output exists", `test/doc-to-md-bundle.test.ts` "openBundle: existing <stem>.md without overwrite") are rewritten to the `-2` contract.

### 6. Scripting surface

- Zero-byte input: both `convertDocument` and `inspectDocument` check `st.size === 0` right after the exists/is-file check and throw `empty file: <path>` (exit 1 in the CLI) before backend resolution, soffice, or any child launch, for every supported type.
- `--json`: parsed in `parseDocToMd` beside `--help` (it is a CLI flag, not an option descriptor, and never appears in the tool schema). With a conversion it prints `HandleData` as one JSON object with its canonical property names (`savedTo, imagesDir, sheetsDir, pagesDir, type, engine, tier, pageCount, pages, explicitBreaks, imageCount, pageImageCount, bytes, lines, degraded, fallbackReason, failedPages, emptyPages, notes, outline, outlineTotal, ocr`) and nothing else on stdout; with `--info` it prints `InfoData` the same way. Diagnostics go to stderr.
- `--pages ""` (and `pages: ""` in the tool) is accepted and means all pages, the same as omitting it (`parsePages` returns `null` for the empty string); today it is a usage error. Documented in `doc/doc-to-md.md` and the `pages` option description.

### 7. Handle notes

- Excel/`.xlsm`: one workbook-level note, placed first in `notes`, `preview truncated: <sheet> (100 of <N> rows[, 50 of <M> columns])[; <sheet> (...)]; full data: sheets/<stem>-<sheet>.csv[, ...]` - one note per workbook so `NOTE_MAX_LINES` (5) can never drop a truncated sheet. The Markdown wording stays.
- DOCX without explicit breaks: `pageCountLabel` renders `Page-Count: 1 (no explicit page breaks) - no page markers; cite by Outline line`.

### 8. Claude Code skill generation and plugin version

- `scripts/gen-skill.mjs` renders `skills/doc-to-md/SKILL.md` from `DOC_TO_MD_OPTIONS` (flags, descriptions, defaults), `SUPPORTED` (format list) and a hand-written intro block `skills/doc-to-md/SKILL.head.md`; the `npx -y pi-quiver@<version>` line uses `package.json` `version`. `skills/fetch/SKILL.md` stays hand-maintained.
- `release.sh` runs `node scripts/gen-skill.mjs` after the version bump and writes `version` (same value) into the `quiver` entry of `.claude-plugin/marketplace.json`, so `claude plugin list` shows `6.x.y` and `claude plugin update quiver@pi-quiver` sees a new version at every release.
- `test/skill-generation.test.ts` regenerates into a temp dir and fails when the committed `skills/doc-to-md/SKILL.md` differs, so a skill/CLI mismatch fails CI.
- `doc/doc-to-md.md` gains an "Install channels" section: npm (`pi install npm:pi-quiver`, `npx -y pi-quiver`) and the Claude Code marketplace are two channels; third-party marketplaces do not auto-update by default; `claude plugin update quiver@pi-quiver` or the `/plugin` auto-update toggle brings the plugin to the release matching the npm version; `claude update` updates Claude Code itself, not plugins. `README.md` links it.

## Errors and edge cases

| Case | Behavior |
|---|---|
| Zero-byte input, any type, convert or `--info` | `empty file: <path>`, exit 1, no bundle dir created, no backend resolved |
| `.msg` that `extract-msg` cannot parse (not OLE, encrypted) | `email parse failed: <first line>`, exit 1 |
| `.eml` part whose body cannot be decoded (`LookupError` on charset, malformed address header) | same `email parse failed: <first line>` path, exit 1; missing headers render as empty cells, missing body renders `Body: none` |
| `.msg` on a system Python without `extract_msg` | `MSG conversion needs the extract-msg package ...`, exit 1, before the child launches |
| `.doc` without soffice | `DOC conversion needs LibreOffice (soffice) ...`, exit 1 |
| `--info` on `.msg`/`.eml` | `info does not apply to email; convert directly` |
| `pageImages` on a type without page geometry, or on unpdf | `Pages-Dir: none - ...`, exit 0 |
| `pageImages` with `pages` beyond page count | existing range validation rejects before any render |
| A page render fails or the page is below `MIN_PAGE_PT` | page skipped; `Page images: N of M unavailable` |
| Numbering: missing `numId`, unknown `numFmt`, template without `%n` | whole-document fallback, `Numbering: labels unavailable (<reason>)`, exit 0 |
| Numbering: element-set drift between module and mammoth | second mammoth run without the transform, same note |
| Same stem twice without `overwrite` | `-2`, `-3`... chosen over both `.md` and `.lock`; handle note |
| Same attachment name twice in one message | `-2`, `-3` inside `attachments/` |
| Attachment name with path separators, `..`, or empty | sanitized to the safe-name rule; never escapes `attachments/` |
| Text layer of whitespace only | textless page: render + OCR when `ocr` |
| `pages: ""` | all pages |

## Tests

Fixtures are generated by `test/fixtures/generate.py` and committed. New generator work: the numbered DOCX is built with python-docx and its low-level OXML API (`docx.oxml`, lxml) to write `word/numbering.xml` (`abstractNum` with three levels, `lvlText` `%1.`/`%1.%2`/`%1.%2.%3`, a second `num` with `startOverride`, one level with `lvlRestart=0`, a style-linked level) and `w:numPr` on the paragraphs; the `.eml` fixture is written with stdlib `email` (multipart: HTML body with a `cid:` image, a text alternative, one attachment, one attachment with a traversal name); the `.msg` fixture is `test/fixtures/sample.msg`, a verbatim copy of `example-msg-files/unicode.msg` from the `TeamMsgExtractor/msg-extractor` repository (GPL-3.0; a test artifact, not shipped in the npm tarball; source URL, upstream commit and license recorded in `test/fixtures/README.md`) - From `Brian Zhou`, HTML body, two `.tif` attachments of about 1 MB each, so the attachment list and sizes are asserted; `extract-msg` is read-only and no pinned library writes OLE, so `generate.py` never regenerates it; `.xlsm` is the existing workbook generator saved with the `.xlsm` extension; `.doc` is produced by soffice from the DOCX fixture when soffice is present (skipped otherwise, as today).

- `test/doc_to_md.test.ts`: mixed text+two-image PDF with `ocr: true` yields `Images: 2` and both links, identical to the non-OCR run, and a seam asserts the child was called with `use_ocr=False` for that page; textless page still runs OCR and `no text on pages 1` appears when Tesseract returns nothing; zero-byte file gives `empty file:` for convert and `--info` with the backend seam never called; `.xlsm` gives sheets/CSV/preview plus the macros note; `.doc` gives the `DEGRADED_DOCX_OFFICE` bundle and honors `pages` (skips without soffice); `.msg` and `.eml` fixtures give header table, body, `images/` inline part, `attachments/` entries with sanitized names and the list; DOCX numbering fixture yields `1.`, `2.1`, `3.2.1`, a restarted `1.` after the `startOverride` list, an unrestarted sublevel under `lvlRestart=0`, a label on the style-linked paragraph, and a typed "3.2.1" paragraph unchanged - each label asserted beside its paragraph text; DOCX with corrupted `numbering.xml` and DOCX with an unknown `numFmt` yield mammoth output plus the `Numbering:` note, exit 0; forced python-docx fallback carries the fallback note; `pageImages` with `pages: "1-2"` gives two files in `pages/`, without `pages` gives page-count files, each linked after its page text; `pageImages` on DOCX fast path and on a no-Python call give the two `Pages-Dir: none` lines; forced DOCX LibreOffice fallback with `pageImages` renders all pages; second call on the same stem gives `-2` and a handle note, and a held `.lock` skips to `-3`; Excel with two truncated sheets shows one aggregated note; break-less DOCX shows the section 7 suffix.
- `test/doc-to-md-cli.test.ts`: `--json` output parses as one object with the listed keys and nothing else on stdout; `--json --info` parses as `InfoData`; `--pages ""` succeeds; `--page-images` is accepted; collision test rewritten to `-2`.
- `test/doc-to-md-options.test.ts`: `.xlsm`/`.doc`/`.msg`/`.eml` map to their types; unsupported-type message lists them; `pages: ""` parses as all; `pageImages` is not settable.
- `test/doc-to-md-bundle.test.ts`: `openBundle` collision -> `-2`; `pages/` and `attachments/` staging, publish, abort and overwrite cleanup; `validateImageLinks` accepts `pages/` and `attachments/` links only against their manifests.
- `test/doc-to-md-handle.test.ts`: `Pages-Dir` variants, aggregated preview note, DOCX no-breaks suffix, `Numbering:` note, `no text on pages` clause, `--json` serialization of `HandleData` and `InfoData`.
- `test/doc_to_md.child.test.ts`: `PROBE_PROGRAM` fourth line parsing; `pinSpecs`/`warmArgs` include `extract-msg`.
- `test/skill-generation.test.ts`: generated skill equals the committed one.
- `test/packed-install.test.ts`: the tarball contains `scripts/docx_numbering.py`; the packed bin runs `--json` on a fixture and, when a Python backend is available, converts the numbered DOCX with labels present.

## Documentation impact

Per `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none (email, page images and install channels are sections in the existing guide)
- Materially amended existing docs: `doc/doc-to-md.md` (supported types; `## Office documents`: `.doc`, `.xlsm`, numbering and its fallback note; new `## Email`; `## Bundle and handle`: stem rule, `-N` collisions, `pages/`, `attachments/`, `Pages-Dir`, section 7 notes, OCR no-text clause, `--json`, `--pages ""`; OCR section: per-page rule; new "Install channels"); `README.md` (format list, `pageImages`, `.xlsm` no longer out of scope, link to install channels); `skills/doc-to-md/SKILL.md` (generated); `CHANGELOG.md` (venv v4, collision behavior change, OCR no-text clause wording)
- Derived / memory docs invalidated: `AGENTS.md` Layout (`scripts/docx_numbering.py`, `scripts/gen-skill.mjs`, `skills/doc-to-md/SKILL.head.md`) and Release section (skill generation step); `.agents/skills/release/SKILL.md` (generation and marketplace version step)

## Out of scope

- `<stem>.words.json` word-position sidecar (deferred to consumers; see Acceptance criteria).
- `--stem` parameter.
- A user-selectable LibreOffice route for DOCX; the fast path with computed labels is the fix, and the fallback route stays automatic.
- Generating `skills/fetch/SKILL.md`; moving asset directories under a per-stem directory.
- Converting email attachments; an attachment size cap; raising the spreadsheet preview cap; engineering formats (`.dwg`, `.rdb`, `.sav`, `.dyr`, `.pscx`), archives, screenshot OCR tuning; a Windows end-to-end run on the real capture.
- Changes to the sibling repos.

## Open questions

- `extract-msg` release to pin: resolved at implementation from PyPI (the latest release compatible with the venv's Python); recorded in `PACKAGE_PINS`.
- Numbering through `w:numStyleLink`/`w:styleLink` indirection is not resolved by section 3 step 3; a document using it lands on the "unsupported" fallback with a `Numbering:` note. Whether real captures need it is unverified; if a consumer reports it, it is an amend to step 3.
