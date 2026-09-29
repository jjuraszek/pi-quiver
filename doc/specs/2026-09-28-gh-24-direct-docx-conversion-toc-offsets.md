# Direct DOCX conversion with explicit-break page hints and a paged Outline

**Goal:** `doc_to_md` converts `.docx` files directly through a Python child (mammoth -> markdownify, python-docx text fallback) instead of LibreOffice -> PDF, keeps heading structure so the handle `Outline` carries `L<line>` offsets, marks author-inserted page breaks with the existing `--- end of page.page_number=N ---` marker, and adds a page column to the conversion `Outline` for every format so a reader can cite line and page from one table.

Ticket: [jjuraszek/pi-quiver#24](https://github.com/jjuraszek/pi-quiver/issues/24). Supersedes `doc/specs/2026-09-09-gh-13-selective-image-linked-excel-conversion.md`, `Info mode` and `Inline page breaks always` for DOCX only (PDF and PPTX contracts there stay live).

## Problem

DOCX conversion runs `soffice --convert-to pdf` and then the PDF ladder. Measured cost: 5.0 s warm for the 5-page fixture, 73 s for a 200-page document (over the 60 s primary timeout). The PDF detour flattens heading styles into font sizes, so the Markdown for a DOCX carries no `#` headings and the handle omits `Outline`; hyperlink targets, footnotes, and picture placement degrade. Provenance suffers twice: no heading lines to `read` by offset, and page markers that reflect LibreOffice's pagination, not the author's.

The ticket resolved "DOCX pages" by dropping page markers and rejecting `pages` for DOCX, on the claim that pandoc/mammoth/MarkItDown emit no page breaks. Verified against python-mammoth source (`mammoth/docx/body_xml.py`): `w:br w:type="page"` is parsed into a `page_break` node and the style-map grammar accepts `br[type='page'] => <element>`; the default style map emits nothing for it, which is what the reporter observed. Explicit breaks are therefore recoverable without a layout engine. Soft breaks are not: `w:lastRenderedPageBreak` is written only by Word (a LibreOffice DOCX->DOCX roundtrip of `test/fixtures/multipage.docx` writes zero), `w:sectPr` and `w:pageBreakBefore` are on mammoth's ignored list, and header/footer page numbers are a single `PAGE` field, not per-page literals. The user accepted this corrected fact and reopened the decision as best-effort page hints from explicit breaks only.

## Acceptance criteria

Ticket jjuraszek/pi-quiver#24, checkbox list, rows verbatim:

- [ ] With `soffice` hidden from `PATH` (a test that runs the conversion with an empty or stubbed `PATH` entry) and a working Python backend, `doc_to_md` on `test/fixtures/multipage.docx` and `test/fixtures/multislide.pptx` returns a bundle (`Saved-To`, non-empty Markdown) instead of the `LibreOffice (soffice) is required` error.
  deviates: the DOCX half ships here; the PPTX half is deferred with the PPTX rows below. Design clause: `multipage.docx` returns a bundle with `soffice` hidden.
- [ ] Converting `test/fixtures/multipage.docx` with a warm Python backend via `bin/pi-quiver.ts doc-to-md` completes in at most 2 s wall time (proposed target; baseline 5.0 s for the same fixture, same command, single warm run, macOS arm64, 2026-09-28). Local check by the implementer on one machine, recorded in the PR; not a CI gate.
  deviates: this repo ships via /skill:release with no PR gate, so the measurement is recorded in the landing commit body instead of a PR - warm `multipage.docx` via `bin/pi-quiver.ts doc-to-md`: 0.84 s (Darwin, Apple M2 Pro), baseline 5.0 s (accept-into-spec at the finish gate, G1)
- [ ] A generated DOCX with Heading 1, Heading 2 and Heading 3 styles produces `#`, `##` and `###` lines respectively, and the handle `Outline` lists them at those levels with `L<line>` numbers.
  in-scope
- [ ] A generated DOCX with a hyperlink produces `[text](url)` with the original target URL.
  in-scope
- [ ] A generated DOCX with a footnote keeps the footnote text in the Markdown (at the reference or in a footnotes section), not a bare `[1]`.
  in-scope
- [ ] A generated DOCX or PPTX with an embedded picture writes the picture under the bundle's `images/` directory and references it by relative path from the Markdown; no `data:` URIs appear in the output.
  in-scope (DOCX; the PPTX reading of "or" rides with the PPTX follow-up)
- [ ] A generated PPTX with speaker notes emits the notes text under the slide that owns them; a PPTX with a native bar chart emits the series names and values as a Markdown table; a PPTX with a second-level bullet renders it as a nested list item, not a code block.
  deferred: PPTX follow-up spec (PPTX stays on the LibreOffice path in this change)
- [ ] `pages` on a PPTX selects slides by 1-based slide number, each slide ends with the existing `--- end of page.page_number=N ---` marker, and `Page-Count` equals the slide count.
  deferred: PPTX follow-up spec
- [ ] `pages` on a DOCX is rejected with an error stating that Word files have no page layout and `pages` is unsupported for them, rather than silently converting the whole file.
  deviates: the "no page layout" premise is corrected above. Design clause: `pages` on a DOCX with zero explicit page breaks is rejected with an error stating the file has no explicit page breaks; `pages` on a DOCX with at least one explicit break selects explicit-break segments; `pages` on a DOCX that takes the LibreOffice route is rejected because that route has no explicit-break mapping.
- [ ] `info: true` on a DOCX returns Title and Author from the document's core properties and a `TOC` built from heading-styled paragraphs, without invoking LibreOffice; on `test/fixtures/sample.docx` (no heading styles) the output states that no headings were found.
  in-scope
- [ ] `info: true` on a PPTX returns `Page-Count` equal to the slide count and a `TOC` of slide titles with slide numbers.
  deferred: PPTX follow-up spec
- [ ] With the Python backend unavailable (no `uv`/`python` found, or the pinned packages fail to install) and `soffice` on `PATH`, DOCX/PPTX still convert through the existing LibreOffice -> PDF -> `unpdf` route and the handle marks the result degraded; with neither available, the tool returns one error naming both missing prerequisites (Python backend, LibreOffice) instead of a stack trace or a bare `soffice` error.
  in-scope (reading: "Python backend unavailable" includes a Python backend that lacks the DOCX packages; the combined error covers DOCX and PPTX, see Errors)
- [ ] After the pin change, a managed venv created from the previous pin set is recreated on first run (venv directory name bumped), so an existing install does not fail on the new imports.
  in-scope
- [ ] Converting a generated DOCX whose headings are bold paragraphs (no heading styles) yields a handle with an explicit `Outline: none` line where today the section is omitted; the existing `Size: <bytes> / <lines> lines` line stays.
  in-scope
- [ ] Excel rendered views behave exactly as today: produced when `soffice` is on `PATH`, `Rendered view: unavailable` when it is not (existing tests in `test/doc_to_md.python.test.ts` pass unchanged).
  in-scope
- [ ] `README.md`, `doc/doc-to-md.md` and the tool description in `extensions/doc_to_md.ts` no longer list LibreOffice as required for DOCX/PPTX and state it is optional, for Excel chart rendering only; `CHANGELOG.md` gets an `## Unreleased` entry naming the dropped DOCX `pages` support as a behavior change.
  deviates: LibreOffice becomes optional for DOCX (fallback when the Python DOCX packages are absent) and stays required for PPTX until the follow-up; DOCX `pages` is not dropped. Design clause: the three docs state LibreOffice is optional for DOCX and Excel rendering and required for PPTX; the CHANGELOG entry names the new DOCX page semantics (explicit breaks) as the behavior change.
- [ ] `npm run test:all` passes on ubuntu and windows CI with the new Python pins.
  venue: GitHub Actions on push of the landing revision - both matrix jobs of `.github/workflows/test.yml` green (follow-up at the finish gate, G2; local `npm run test:all` at d91215e: 740 pass, 0 fail, 1 skipped)

## Design

### Scope

In: DOCX conversion and `info` through a Python child; explicit-break page markers and `pages` for DOCX; a page column on the conversion `Outline` for all formats; `Outline: none`. Out: PPTX conversion (unchanged, LibreOffice path, follow-up spec); soft-break, section-break, `pageBreakBefore`, or `lastRenderedPageBreak` pagination; matching PDF bookmarks to Markdown lines; any change to the PDF, Excel, or `unpdf` tiers beyond the `Outline` page column and `Outline: none`; the info-TOC render format (`L<level> Title (p<page>)` stays).

### Backend probe (`lib/doc-to-md-core.ts`)

| Item | Change |
|---|---|
| `PACKAGE_PINS` | add `mammoth`, `markdownify`, `python-docx` at pinned versions chosen at implementation from PyPI latest stable |
| uv `--with` list, venv pip install, `warmArgs` import string | carry the three new packages (`import mammoth, markdownify, docx` joins the existing import list) |
| `VENV_DIR_NAME` | `doc-to-md-venv-v2` -> `doc-to-md-venv-v3`; the legacy removal list becomes `["pymupdf-venv", "doc-to-md-venv-v2"]`, both removed after v3 publishes successfully |
| `PROBE_PROGRAM`, `parseProbeOutput` | third anchored capability line `DOCX yes|no` (imports `mammoth`, `markdownify`, `docx`), parsed like `PDF`/`XLSX` |
| `ProbeResult`, `Backend` (`uv`, `python`, `venv`) | gain `docx: boolean`; `uv` and `venv` report `docx: true`; the three venv health checks (`cached.pdf && cached.xlsx`, `recheck`, `winner`) require `docx` too |
| `Backend.kind === "none"` | has no capability fields; every DOCX guard reads `kind === "none" || !backend.docx` |

The system-interpreter qualification rule is unchanged: a user-supplied `python` is accepted when its `PDF` probe succeeds; its `DOCX` result is recorded as probed. A PDF-qualified Python without the DOCX packages probes `docx: false` and DOCX takes the LibreOffice route.

### Child (`scripts/doc_to_md.py`)

New mode `docx`. Input: file path, staging dir, optional `pages` list. Ladder inside the child:

1. **mammoth.** `convert_to_html` with a style map extending mammoth's defaults by `br[type='page'] => hr.pagebreak:fresh` (`:fresh` stops mammoth merging adjacent breaks into one element) and by `p[style-name='Heading 7'] => h6:fresh` through `Heading 9` (style-id forms `Heading7..9` too; mammoth's default map ends at Heading 6 and would otherwise emit `<p>`). Images go through a `convert_image` handler that follows the PDF staging protocol: `<staging>/p<segment>/img<i>.<ext>` (extension from mammoth's `content_type`: `image/x-emf` -> `.emf`, `image/x-wmf` -> `.wmf`, otherwise `.<subtype>`; bytes written as-is, no rasterization), a `.done` file per selected segment, and `src` = `p<segment>/img<i>.<ext>` so the parent's `publishStaged` publishes `<stem>-p<N>-<n>.<ext>` and rewrites links through its source map. The segment of an image is known after step 1b, so the handler records images with their node and the child assigns segments after the break pass; a break-less file uses `p1`.

   1b. **Break hoisting (HTML level, before markdownify).** Parse mammoth's HTML with the stdlib `html.parser`; for each `<hr class="pagebreak">` nested inside `p`, `h1..h6`, `li`, or a table, move it to the nearest block-level position: a break inside a heading or paragraph splits that element at the break (text before stays, text after starts a new element of the same kind); a break inside a table cell moves to immediately after the table; a break inside `li` closes that item and its enclosing list(s), the `hr` is inserted after the list, and the following items open a new list of the same kind. Every hoisted `hr` becomes a top-level `<hr class="pagebreak">`. Any `h7..h9` still present is clamped to `h6` as a backstop.

   1c. **markdownify** via a `MarkdownConverter` subclass: `convert_hr` emits the sentinel line `\x00PAGEBREAK\x00` only when the element carries class `pagebreak` and `---` otherwise; options `heading_style=ATX`, `bullets="-"`, `keep_inline_images_in=["td", "th"]` so a picture in a table cell keeps its `![alt](src)` link.

   1d. **Post-pass.** Split the Markdown body at sentinel lines into segments numbered from 1. One trailing empty segment (a break as the last body element) is dropped; leading and interior empty segments are kept and numbered so N matches the author's count. `pageCount` = the number of numbered segments after that drop (1 for a break-less file). `explicitBreaks` = the count of body-descendant `w:br w:type="page"` elements (tables and list paragraphs included), counted before the trailing-empty drop; it is the only input to the `pages` rejection and to the `Page-Count` suffix. When `pageCount > 1`, each segment ends with `SEP.format(n=N)`, the last one included. Footnotes: mammoth appends a trailing `<ol>` of `footnote-N` items; the child separates that block from the body before segmenting (so trailing emptiness is judged on body text), then appends under the selected output only the items whose `#footnote-N` anchor is referenced by a selected segment, all of them when `pages` is unset.

2. **python-docx fallback** when step 1 raises: walk `document.element.body` in order; paragraphs with style `Heading N` -> `#`*min(N, 6) heading, other paragraphs -> text, tables -> GFM table, `w:br w:type="page"` -> a segment boundary with the same numbering, count, and marker rules as 1d. No footnotes, hyperlinks, or images.

3. Both raise -> exit 1 with both messages joined; the parent handles it (see Errors). The child deletes every `p<N>/` staging dir it created before exiting non-zero, so no half-written images survive for a later tier.

`pages`: the child slices numbered segments after 1d; emitted markers keep their original N. When `explicitBreaks == 0` and `pages` is set, the child raises `UserError` (exit 3) with `--pages does not apply to this DOCX: it has no explicit page breaks; read the .md by Outline line offsets instead`. Out of range: `pages out of range: 9 (document has 5 segments)`, the existing `check_pages` message with the noun changed for this mode.

Result JSON (extends `TierJson`; the existing `images` field keeps its Excel meaning and is unused here): `markdown`, `pageCount`, `explicitBreaks`, `engine: "mammoth" | "python-docx"`, `degraded: bool`, `fallbackReason`.

`info` on `.docx` is a `.docx` branch of the existing `info` mode (python-docx only, never `open_pdf`): `pageCount` = the same segment count 1d produces (1 for a break-less file), `explicitBreaks` counted over the same body-descendant set as 1d, `metadata` from `document.core_properties` with `title` and `author` as strings and `created`/`modified` as ISO-8601 strings or omitted when null (never raw `datetime`, which `json.dump` rejects), `toc` as `[level, title, page]` from `Heading N` paragraphs (level clamped to 6) where `page` is the 1-based segment number when `explicitBreaks > 0` and `null` otherwise. `TierJson.toc` and `TocEntry.page` widen to `number | null`.

### Parent pipeline (`lib/doc-to-md-core.ts`)

`convertDocument` branches on `type === "docx"`:

| Condition | Route |
|---|---|
| `backend.docx` | `docx` tier (`Tier` gains `"docx"`, `Engine` gains `"mammoth"` and `"python-docx"`); on exit 0 `publishStaged` runs as for PDF; `degraded = DEGRADED_DOCX_TEXT` (`"python-docx text extraction - footnotes, hyperlinks, images not preserved"`) with `fallbackReason = "mammoth <msg>"` when the child reports `degraded` |
| `docx` tier returns `userError` (exit 3: `pages` rejection or out of range) | the child message surfaces as the user error, whether or not `soffice` exists; no retry |
| `docx` tier fails with `exit 1` (both engines raised) and `soffice` exists | the parent removes `b.stagingDir` contents, then takes the LibreOffice route below with `fallbackReason = "docx <child reason>"` |
| `docx` tier fails with `exit 1`, no `soffice` | `Conversion failed: docx exit 1 (<child reason>); LibreOffice (soffice) not found on PATH` |
| `docx` tier fails with `timeout`, `output exceeded maxOutputBytes`, `invalid-json`, or `aborted` | surface the failure; no LibreOffice retry |
| `kind === "none" \|\| !backend.docx`, `soffice` exists | LibreOffice route below |
| `kind === "none" \|\| !backend.docx`, no `soffice` | combined prerequisite error (Errors) |

**LibreOffice route for DOCX** (`tryConvertOffice` through the `office` seam -> PDF ladder as today; after a child exit 1, a `soffice` failure or missing PDF surfaces as `Conversion failed: docx exit 1 (<child reason>); <office failure message>`) gains two rules: `pages` is rejected before `soffice` runs with `--pages on a DOCX needs the Python DOCX backend (explicit page-break segments); the LibreOffice route has none. Remedy: install uv, or pip install mammoth markdownify python-docx` - when the route was entered because the DOCX child exited 1, the message is that literal followed by ` (docx exit 1 (<child reason>))`, since the Python DOCX backend is present on that path and the remedy alone would be wrong; and the result is marked `degraded = DEGRADED_DOCX_OFFICE` (`"LibreOffice PDF route - heading styles and explicit page breaks not preserved; page numbers are LibreOffice pagination"`) regardless of which PDF tier succeeded, with `fallbackReason` = the backend `reason` or `"python backend lacks DOCX packages"` or the child reason.

`inspectDocument` on `type === "docx"`: `backend.docx` -> `info` mode on the Python child, never `tryConvertOffice` (the `office` seam); `kind === "none" || !backend.docx` -> the combined prerequisite error with the DOCX remedy (LibreOffice is not offered for `info`, since the AC forbids it). `inspectDocument` on PPTX is unchanged.

PPTX always takes `tryConvertOffice` (the `office` seam); when `soffice` is missing its error becomes the combined prerequisite error too (Errors). The `docx` tier uses `primaryTimeoutMs`.

Handle: the `Page-Count` field is suffixed by tier: `Page-Count: 5 (explicit page breaks, not printed pages)` when `tier === "docx"` and `explicitBreaks > 0` (also when a dropped trailing break leaves `pageCount == 1`), `Page-Count: 1 (no explicit page breaks)` when `explicitBreaks == 0`; `Page-Count: 5 (LibreOffice pagination)` when `type === "docx"` on the LibreOffice route. Other types unchanged.

### Outline (`lib/doc-to-md-handle.ts`)

`OutlineEntry` gains `page: number | null`. `scanOutline` collects headings with a pending page, and on each line matching `^--- end of page\.page_number=(\d+) ---$` assigns N to every pending heading (a heading sits in the segment its next marker closes; markers keep their original N under a `pages` selection, so this holds for `pages: "2,5"` on a PDF and `pages: "2-3"` on a DOCX). Headings with no following marker get `null`. Render: `L120  p4  ## Title`; with `null`, `L120  ## Title` as today; column widths align per handle as the current `L` column does. Applies to every tier that emits markers (PDF primary, PDF text, unpdf, DOCX); a marker-free Markdown yields `null` throughout.

`outlineLines` emits the single line `Outline: none` when `total === 0`, for every input type; the `Size:` field stays where it is.

`formatInfoHandle`: when `type === "docx"` and `toc` is empty, print `TOC: none (no heading styles found)`; a DOCX TOC entry with `page === null` renders `(p?)`. PDF and PPTX info output is unchanged.

### Options and docs surfaces

`lib/doc-to-md-options.ts` `pages` help text gains "DOCX: selects explicit-page-break segments; rejected when the file has none". `extensions/doc_to_md.ts` description states LibreOffice is optional for DOCX and Excel rendering and required for PPTX, and its `pages` sentence names DOCX segments.

## Errors and edge cases

| Situation | Behavior |
|---|---|
| `pages` on a DOCX with zero explicit breaks (`docx` tier) | `--pages does not apply to this DOCX: it has no explicit page breaks; read the .md by Outline line offsets instead` |
| `pages` on a DOCX on the LibreOffice route | rejected before `soffice` runs with the message in Design |
| `pages` beyond the segment count | `pages out of range: <n> (document has <k> segments)` |
| DOCX: `kind === "none" \|\| !backend.docx`, no `soffice` | `DOCX conversion needs the Python DOCX packages or LibreOffice. Python backend: <backend.reason, or "found without mammoth/markdownify/python-docx">. Remedy: install uv, or pip install mammoth markdownify python-docx into a Python that already has pymupdf4llm, or install LibreOffice (soffice)` |
| PPTX: no `soffice` | `PPTX conversion needs LibreOffice (soffice); direct conversion is not available. Python backend: <backend.reason or "available">. Remedy: install LibreOffice` |
| `docx` child exit 3 (`userError`), `soffice` present or not | the child message surfaces; never retried through LibreOffice (on ubuntu CI `soffice` sits beside `uv`, so this row is what keeps the `pages` tests honest) |
| `docx` child exit 1, `soffice` present | staging cleared, LibreOffice route, degraded, `Fallback-Reason: docx <child reason>` |
| `docx` child exit 1, no `soffice` | `Conversion failed: docx exit 1 (<child reason>); LibreOffice (soffice) not found on PATH` |
| `docx` child exit 1, `soffice` fails or yields no PDF | `Conversion failed: docx exit 1 (<child reason>); <office failure message>` |
| `docx` tier timeout / output cap / invalid JSON / aborted | surfaces directly with the existing wording, tier named `docx`; never retried through LibreOffice |
| DOCX wall-time ceilings (documented in `## Configuration`) | Python success: `warmTimeoutMs + primaryTimeoutMs`; terminal child failure: the same; exit 1 then LibreOffice: `warmTimeoutMs + primaryTimeoutMs + sofficeTimeoutMs + primaryTimeoutMs + fallbackTimeoutMs`; no-backend LibreOffice route: `warmTimeoutMs + sofficeTimeoutMs + primaryTimeoutMs + fallbackTimeoutMs`; each plus `KILL_GRACE_MS` per kill |
| explicit break inside a list item | 1b closes the item and list, the marker follows the list, remaining items start a new list |
| break as the last body element with no other break | `explicitBreaks == 1`, `pageCount == 1`, `pages: "1"` accepted, suffix `(explicit page breaks, not printed pages)` |
| explicit break inside a heading or paragraph | 1b splits the element at the break; the marker lands between the two halves |
| explicit break inside a table cell | 1b moves it after the table; the marker follows the table |
| adjacent explicit breaks | `:fresh` keeps them distinct; empty segments kept and numbered |
| break as the last body element | trailing empty segment dropped |
| a paragraph whose text is `---` | rendered `---`, never a marker (the sentinel is class-gated) |
| `w:sectPr`, `pageBreakBefore`, `lastRenderedPageBreak`, header/footer fields | ignored; no marker |
| EMF/WMF pictures | written as-is with original extension; link resolves, no rasterization |
| picture in a table cell | link kept via `keep_inline_images_in` |
| footnote referenced in a selected segment, definitions after the last segment | definition carried into the selected output |
| `Heading 7-9` | mapped to `h6:fresh` in the mammoth style map, `min(N, 6)` in python-docx and `info`; all three yield `######` |
| heading text that looks like a fence | `scanOutline` already skips fenced blocks; unchanged |
| PDF text tiers (`pdf-fallback`, `unpdf`) | they emit markers, so their `#` lines get pages by the same closing-marker rule |

## Tests

| Suite | Cases |
|---|---|
| `test/fixtures/generate.py` | `sample.docx` untouched (committed, `PreformattedText` only, the AC's no-heading case). New generated `headings.docx`: Heading 1/2/3, core Title and Author, a hyperlink (raw `w:hyperlink` with an external relationship added through python-docx's OPC part API), a footnote (hand-built `word/footnotes.xml` part, content-type override, `w:footnoteReference` run) referenced in segment 1, one PNG in body text, one PNG inside a table cell, two explicit breaks, one of them inside a Heading 1 paragraph; `multipage.docx` keeps 4 explicit breaks in their own paragraphs; new `bold-headings.docx` with bold paragraphs, no heading styles |
| `test/doc_to_md.python.test.ts` (skips without `uv`) | `headings.docx`: `#`/`##`/`###` present, `Outline` lists three levels with `L<line>` and `p<N>`; `[text](url)` with the fixture URL; footnote text present; two files under `images/` named `headings-p<N>-<n>.png`, the table-cell one linked, no `data:` URI; the heading split by a break yields two headings around a marker; a break inside a bullet yields a marker between two lists; `pages: "1"` carries the footnote definition; `pages: "3"` (last segment) omits it. `multipage.docx`: `Page-Count: 5 (explicit page breaks, not printed pages)`, five markers, `Outline` rows carry `p1..p5`; `pages: "2-3"` -> two markers numbered 2 and 3 and Outline rows `p2`, `p3`; `pages: "9"` -> `document has 5 segments`. `sample.docx` with `pages: "1"` -> the no-explicit-breaks error. `soffice` hidden via `PATH` -> `multipage.docx` still returns a bundle. `info` on `headings.docx` -> Title/Author, ISO `created`, TOC with `(p<N>)`, and the office seam (`soffice` hidden via `PATH`) unused; `info` on `sample.docx` -> `TOC: none (no heading styles found)`, `Page-Count: 1`; existing `docx info + pages + bounds` test rewritten to the segment wording. `bold-headings.docx` -> `Outline: none` and the `Size:` line. Forced mammoth failure (`DOC_TO_MD_FORCE_DOCX_FALLBACK=1` read by the child) -> `engine: python-docx`, `Degraded:` line, headings and markers still present. Existing Excel rendered-view tests unchanged |
| `test/doc_to_md.test.ts` (faked child, no Python) | `docx: false` + `soffice` absent -> combined DOCX error; PPTX + `soffice` absent -> combined PPTX error; `docx: false` + `soffice` present -> the office seam (`tryConvertOffice`) called, `Degraded:` line with `DEGRADED_DOCX_OFFICE`, `pages` rejected before the office seam (`tryConvertOffice`); `docx: true` -> `docx` tier called, the office seam (`tryConvertOffice`) not called, `publishStaged` published `p<N>` staging; child `exit 1` + `soffice` present -> staging dir emptied, then the office seam (`tryConvertOffice`) with `Fallback-Reason: docx ...`; child exit 3 + `soffice` present -> the child message as user error, the office seam (`tryConvertOffice`) not called; child `timeout` + `soffice` present -> error, the office seam (`tryConvertOffice`) not called; `inspectDocument` on DOCX with `docx: false` -> prerequisite error, the office seam (`tryConvertOffice`) not called; the existing `Outline:\n  L1  # H` assertion for `pages: "2,5"` updated to `L1  p2  # H` |
| `test/doc-to-md-handle.test.ts` | `scanOutline` page tagging: no markers -> `null`; heading before marker 2 -> 2; heading between markers 2 and 5 -> 5; heading after the last marker -> `null`; render `L12  p2  ## Title` and `L12  ## Title`; `Outline: none` when total is 0; info `TOC: none (no heading styles found)` for DOCX only; `(p?)` for a null page |
| `test/manual` (non-gating) | warm `bin/pi-quiver.ts doc-to-md test/fixtures/multipage.docx` under 2 s, recorded in the PR |

## Documentation impact

See `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/doc-to-md.md` `## Backend ladder` (DOCX tier, `DOCX` probe capability, venv v3, fallback set), `## Office documents` (explicit-break pages, `pages` on DOCX, LibreOffice route semantics, PPTX unchanged), `## Bundle and handle` (Outline page column, `Outline: none`, `Page-Count` suffixes, "every selected page ends with" sentence), `## Child contract` (`docx` mode and result JSON), `## Configuration` (the three DOCX wall-time ceilings with `KILL_GRACE_MS`); `README.md` optional-binary row for LibreOffice (DOCX optional, PPTX required, Excel rendering), the `doc_to_md` extension row, the `sofficeTimeoutMs` row and wall-time formula; `extensions/doc_to_md.ts` tool description (LibreOffice optionality, `pages` sentence); `CHANGELOG.md` `## Unreleased` (direct DOCX conversion, DOCX page semantics, Outline page column, `Outline: none`, DOCX `pages` rejected on the LibreOffice route)
- Derived / memory docs invalidated: none

## Out of scope

PPTX direct conversion and its five ticket rows; PDF bookmark-to-line matching; inferring soft page breaks from any XML cue; an opt-in LibreOffice route for DOCX when the Python packages are present; MarkItDown or pandoc backends; the info-TOC render format.

## Open questions

- Exact pin versions for `mammoth`, `markdownify`, `python-docx` are chosen at implementation from PyPI latest stable and recorded in `PACKAGE_PINS`.
