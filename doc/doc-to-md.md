# doc_to_md - local document -> Markdown bundle

`doc_to_md` takes a local `.pdf`, `.docx`, `.doc`, `.pptx`, `.xlsx`, `.xlsm`, `.xls`, `.msg`, `.eml`, `.html`, `.htm`, `.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.bmp`, or `.gif` path, writes a Markdown bundle on disk, and returns a concise handle - never inline Markdown. For remote documents, `fetch` the URL first, then pass its saved path here.

## Backend ladder

The backend is resolved once per process. Every conversion tier is a fresh child process, so a stuck MuPDF or PDF.js call can be killed.

1. **`uv`** - `uv run --with pymupdf4llm==1.27.2.3 --with openpyxl==3.1.5 --with xlrd==2.0.2 --with pillow==12.3.0 --with mammoth==1.13.0 --with markdownify==1.2.3 --with python-docx==1.2.0 --with extract-msg==0.56.1 --python 3.14 python scripts/doc_to_md.py <mode>`. This preferred rung supplies PDF, Excel, DOCX, and email capabilities.
2. **System Python** - `python3`, then `python`, from `PATH`, if Python is >= 3.12. The capability probe requires `pymupdf4llm >= 1.27.0` for PDF and independently checks `openpyxl`, `xlrd`, and `PIL` for Excel, and checks `mammoth`, `markdownify`, and `docx` for DOCX. A PDF-capable system Python without the DOCX packages is still used; its `.docx` inputs take the LibreOffice route.
3. **Managed venv** - a bare eligible system Python can bootstrap the pinned package set at `<per-OS cache dir>/pi-quiver/doc-to-md-venv-v4`. It builds in a sibling temporary directory and publishes with rename. After a successful publish the legacy `pymupdf-venv`, `doc-to-md-venv-v2`, and `doc-to-md-venv-v3` directories are removed. A cached venv is reused.
4. **PyMuPDF text** - if a Python backend exists but `pymupdf4llm` primary conversion fails, `scripts/doc_to_md.py pdf-fallback` uses `pymupdf` text extraction. The resulting bundle is degraded: layout and tables are not preserved.
5. **`unpdf` worker** - if no Python PDF backend resolves, a separate `unpdf-worker` child extracts text. It is also degraded and does not extract images.
6. **DOCX child** - `.docx` inputs run `scripts/doc_to_md.py docx` when the backend probes `DOCX yes`: mammoth -> HTML -> markdownify, with a python-docx text walker as the in-child fallback (degraded: footnotes, hyperlinks, images not preserved). When the child exits 1 and `soffice` is on `PATH`, the file takes the LibreOffice -> PDF route (degraded, `LibreOffice pagination`); a user error (exit 3), timeout, output cap, or invalid JSON is terminal.

Local HTML is preprocessed in TypeScript: local and `data:` images are copied into the bundle, while remote images stay as links (`//host/...` becomes `https://host/...`). A `data:` image is staged only if its bytes match the declared image type's signature; missing or invalid images become alt text. Image syntax in page text, such as a code sample, stays literal. When the probe says `DOCX yes`, the `html` child converts with markdownify; otherwise, or after an HTML child failure or timeout, Readability-free Turndown converts it with `Degraded: Turndown HTML conversion - definition lists and headerless tables not preserved` (`DEGRADED_HTML_TURNDOWN`). Image inputs use the `image` child; without a Python backend or on child failure, TypeScript copies the image into an image-only bundle. Both Python PDF tiers render a page picture for pages without a text layer; `unpdf` has no page pictures.

The probe prints exactly:

```text
PY <major> <minor>
PDF <yes|no>
XLSX <yes|no>
DOCX <yes|no>
EMAIL <yes|no>
```

Its current implementation emits major and minor version as separate fields, for example `PY 3 14`, followed by the `PDF`, `XLSX`, `DOCX`, and `EMAIL` capability lines. Python available only through Windows `py.exe` is not detected; install `uv` or expose `python`/`python3` on `PATH`.

| Platform | Cache dir |
|---|---|
| `win32` | `%LOCALAPPDATA%\pi-quiver` |
| `darwin` | `~/Library/Caches/pi-quiver` |
| other | `$XDG_CACHE_HOME/pi-quiver`, else `~/.cache/pi-quiver` |

## Office documents

`.docx` converts directly in the Python child. Auto-numbering labels are computed from `word/numbering.xml` by `scripts/docx_numbering.py` and injected before mammoth renders. If labels cannot be computed or aligned, conversion continues without computed labels and reports `Numbering: labels unavailable (<reason>)` for the whole document. `w:numStyleLink`/`w:styleLink` indirection is unsupported and takes this fallback. Heading styles become `#..######` (Heading 7-9 clamp to `######`), hyperlinks keep their targets, footnotes are appended as a numbered list, and pictures are staged per segment and published under `images/`. Only author-inserted page breaks (`w:br w:type="page"`) become `--- end of page.page_number=N ---` markers: segments are numbered in break order, a break inside a heading or paragraph splits it, a break inside a table cell moves after the table, a break inside a list item closes the list, and one trailing empty segment is dropped. Soft breaks, section breaks, `pageBreakBefore`, and header/footer page fields produce no marker. `pages` on a DOCX selects these segments and is rejected when the file has no explicit break (`--pages does not apply to this DOCX: it has no explicit page breaks; read the .md by Outline line offsets instead`). Without the Python DOCX packages, or when the child exits 1, `.docx` falls back to headless LibreOffice (`soffice`) -> PDF -> the PDF ladder; that route is marked degraded, reports `Page-Count: N (LibreOffice pagination)`, and rejects `pages` before `soffice` runs (after child exit 1 the error also includes the child reason). A child exit 1 followed by a `soffice` failure reports `Conversion failed: docx exit 1 (<child reason>); <office failure message>`. With neither a DOCX-capable Python nor `soffice`, the call fails with one error naming both remedies. `info` on a DOCX never runs LibreOffice.

`.doc` inputs use LibreOffice -> PDF -> the PDF ladder and report `Degraded:` as on the DOCX LibreOffice route. `.doc` requires `soffice` on `PATH`; its `pages` select PDF pages after conversion.

`.pptx` inputs are converted to PDF by headless LibreOffice with an isolated per-call profile, then use the PDF pipeline. `soffice` must be on `PATH`; otherwise the call fails with `PPTX conversion needs LibreOffice (soffice); direct conversion is not available`. Requested page bounds apply after `soffice` produces the PDF.

Excel does not go through LibreOffice for its data. `.xlsx` and `.xlsm` use `openpyxl`; `.xls` uses `xlrd`. `.xlsm` macros are ignored and the handle notes this. Both require a Python backend. Workbooks become a `## Sheets` inventory (every worksheet and chartsheet in workbook order, 0-based index) followed by one section per sheet: a `Data:` link to the sheet's full CSV under `sheets/` for non-empty worksheets, chart metadata (`<type> "<title>" - <n> series (<refs>)`), embedded images, an optional rendered view, a preview of at most 100 rows x 50 columns of the non-empty extent, and a `Columns:` profile when the preview is truncated. `.xlsx` shows formulas with cached values; `.xls` reports formulas and images unavailable. Sheets carrying charts or images get a rendered view (`images/<stem>-s<idx>.<fmt>`) when `soffice` is on `PATH`: the workbook is exported with `pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}` (one page per sheet) and the matching pages are rasterized by the `render-pages` child under a 16 Mpx budget. Every failure on that path (`LibreOffice not found`, `soffice failed: ...`, `soffice produced no PDF`, `page-count mismatch (N vs M)`, `render failed: ...`, `rendered view degenerate (...)`, `rendered view too large (...)`) is written into the sheet section as `Rendered view: unavailable (<reason>)` plus a handle note; conversion still succeeds. Sheet/range selection and in-grid placement of visuals are out of scope; `.xls` has no visual detection.

## Email

`.msg` uses `extract-msg`; `.eml` uses Python's email parser. The Markdown starts with the subject and a `| Header | Value |` table for From, To, Date, Subject, and Cc when present. HTML body takes precedence over plain text; absent body renders `Body: none`. Referenced `cid:` images are staged under `images/`. Attachments are not converted: `## Attachments` lists links into `attachments/<stem>-<safe name>` with size and MIME type; unavailable attachments appear as `(not extracted: <reason>)`. Safe names strip path components, replace `[^A-Za-z0-9._-]+` in the basename stem with `_`, strip unsafe characters from the extension, lowercase the extension, and use `attachment-N` for an empty stem. Duplicate names get `-2`, `-3`, ... before the extension. `--info` is rejected for email. Unparsable input fails with `email parse failed: <reason>`.

## Bundle and handle

A bundle root contains `<stem>.md`, `<stem>.pages.json` on Python PDF tiers, `<stem>.words.json` with `--words`, `images/`, and, when needed, `sheets/`, `pages/`, `attachments/`, and `ocr/`. The stem is the basename without extension with `[^A-Za-z0-9._-]+` replaced by `_`; an empty stem becomes `document`. Without `--overwrite`, a same-stem collision takes the first available `-2`, `-3`, ... suffix and reports `Notes: renamed to <stem>-2 (<stem>.md exists)` or, for a lock-only collision, `Notes: renamed to <stem>-2 (<stem>.md.lock held; delete it if no conversion is running)`. `--output-dir` selects the root; otherwise a per-call temporary root is created. The caller owns a temporary bundle: the tool never deletes a bundle it produced.

A call owns `<stem>.md.lock` for its duration. Child page images stage in `images/.stage-<lockId>/p<N>/`; a child writes `.done` only after that page is complete. Node publishes completed page files as `images/<stem>-p<N>-<n>.<ext>`, discards incomplete page staging directories, and atomically publishes `<stem>.md` by writing a temporary Markdown file then renaming it. Excel images stage as `s<idx>-<n>.<ext>` and publish as `<stem>-s<idx>-<n>.<ext>`. On overwrite, the old `<stem>.md` and this stem's owned files are removed: `images/<stem>-p<N>-<n>.*`, `images/<stem>-s<idx>[-<n>].*`, `sheets/<stem>-s<idx>-<slug>.csv`, `pages/<stem>-p<N>.<ext>`, and `attachments/<stem>-...` files linked from the old `<stem>.md`. Other bundle files are left alone. Excel CSVs stage under `sheets/.stage-<lockId>/s<idx>-<slug>.csv` and publish as `sheets/<stem>-s<idx>-<slug>.csv`; rendered views stage as `s<idx>.<fmt>` and publish as `images/<stem>-s<idx>.<fmt>`. The handle prints `Sheets-Dir` when any CSV was written.

A textless PDF page keeps `images/<stem>-p<N>-1.<fmt>`, linked as `![page N](images/<stem>-p<N>-1.<fmt>)`. OCR text appears below its image as a blockquote headed `> Text recognized in images/<file> (OCR, may contain recognition errors):`; blockquote headings do not enter the Outline. `pages` and `info` are rejected for HTML and image inputs.

Every conversion that goes through the Python PDF tiers (PDF, PPTX, `.doc`, DOCX via LibreOffice) writes `<stem>.pages.json` beside the Markdown: one `{ "page", "chars", "images", "imageCoverage" }` object per selected page (`chars` = stripped text-layer length, `images` = image count from `get_image_info()`, `imageCoverage` = summed image bbox area over page area, clamped to `1.0` and rounded to two decimals), or `{ "page", "error" }` when the stats raised. The handle prints `Page-Stats: <path>`; the unpdf tier writes no stats. No threshold lives in the converter - the consumer decides what "thin" means.

`--ocr-mode all` forces OCR on an explicit `--pages` selection and writes one sidecar per completed page to `ocr/<stem>-pNNN.md` (`NNN` zero-padded to at least three digits): a `<!-- OCR of page N (tesseract <lang>); recognized text, not the text layer -->` header, the plain recognized text (empty for a no-text page), and the page separator. The main Markdown is byte-identical to the same call without `--ocr`, with the same selected pages and stem. The handle prints `OCR-Dir: <path>` when a sidecar exists. On overwrite, `<stem>.pages.json`, `<stem>.words.json`, `ocr/<stem>-pNNN.md`, and `ocr/<stem>-pNNN.words.json` join the owned set that is removed, even when the new call omits `--words`.

Every artifact a bundle can contain, as printed by `--help` under `Bundle layout`:

| Artifact | Trigger | Content | Named by |
|---|---|---|---|
| `<stem>.md` | always | the Markdown | `Saved-To:` / `savedTo` |
| `images/` | embedded or extracted figures | image files linked from the Markdown | `Images-Dir:` / `imagesDir` |
| `pages/<stem>-pNNN.<fmt>` | `--page-images` | page renders at `--image-dpi` | `Pages-Dir:` / `pagesDir` |
| `sheets/` | Excel input | one CSV per non-empty worksheet | `Sheets-Dir:` / `sheetsDir` |
| `attachments/` | email input | saved attachments | Markdown attachment list |
| `<stem>.pages.json` | Python PDF tiers (PDF, PPTX, DOC, DOCX via LibreOffice; not unpdf) | per-page chars, image count, image coverage | `Page-Stats:` / `pageStatsPath` |
| `<stem>.words.json` | `--words` | per-page word boxes, source text/ocr | `Words:` / `wordsPath` |
| `ocr/<stem>-pNNN.md` | `--ocr --ocr-mode all` | recognized text of a forced page | `OCR-Dir:` / `ocr.sidecars` |
| `ocr/<stem>-pNNN.words.json` | `--ocr --ocr-mode all --words` | word boxes of that OCR | `ocr.wordSidecars` |

Every selected PDF or PPTX page, and every DOCX segment when the file has more than one segment (`pageCount > 1`), ends with `--- end of page.page_number=N ---`.

A conversion handle has this portable shape:

```text
Saved-To: /abs/out/manual.md
Images-Dir: /abs/out/images
Page-Stats: /abs/out/manual.pages.json (Python PDF tiers)
Words: /abs/out/manual.words.json (with --words)
OCR-Dir: /abs/out/ocr (when sidecars exist)
Type: pdf   Engine: pymupdf4llm   Tier: primary
Page-Count: 42   Pages: 3-5   Images: 4   Size: 18.2KB / 412 lines
Degraded: ... (conditional)
Fallback-Reason: ... (conditional)
Failed-Pages: ...    Empty-Pages: ... (conditional)
OCR: ... (conditional)
Notes: ... (conditional)
Outline:
  L12  p1  # Installation
  L87  p4  ## Wiring
  (+N more)
```

`Outline` rows carry `L<line>` and, when the Markdown has page markers, `p<N>` (the page whose marker closes the heading's segment; headings after the last marker have no page column). A file with no headings prints `Outline: none`. For DOCX, `Page-Count` is suffixed `(explicit page breaks, not printed pages)`, `(no explicit page breaks)`, or `(LibreOffice pagination)`.

The `OCR:` line reports these cases (the exact text varies where placeholders appear):

| Case | `OCR:` line |
|---|---|
| Off, PDF | `OCR: off - N page(s) without a text layer; rerun with ocr=true` when data is installed, otherwise `OCR: off - N page(s) without a text layer; install Tesseract (see doc/doc-to-md.md), then rerun with ocr=true` |
| Off, image | `OCR: off; rerun with ocr=true` when data is installed, otherwise `OCR: off; install Tesseract (see doc/doc-to-md.md), then rerun with ocr=true` |
| Unavailable | `OCR: unavailable - <reason>` for `fallback tier`, `no Python backend`, or `OCR child failed: ...`; other reasons append ` (install Tesseract; see doc/doc-to-md.md)` |
| Forced (`--ocr-mode all`) | `OCR: forced (eng) - sidecars for pages 2, 7; no text on page 9; failed on page 4 (<message>); budget-stopped pages 13, 20 - re-run with --pages 13,20` - only non-empty buckets; a killed child reads `page 13 killed the OCR child (timeout or crash - likely a compression bomb); pages 20, 25 not attempted - re-run with --pages 20,25`; a child that died before any page reads `OCR child failed before processing pages: <reason>; pages 2, 7 not attempted - re-run with --pages 2,7`. |
| Too small | `OCR: skipped - image too small` |
| Ran | `OCR: N page(s) (eng)` or `OCR: N image (eng)`; optional clauses: `no text on pages <ranges>`, `N failed and were converted without OCR`, `time budget reached for pages=<ranges>; rerun with pages=<ranges> or raise primaryTimeoutMs` |

With `--page-images`, PDF, PPTX, `.doc`, and LibreOffice-routed DOCX pages also render under `pages/<stem>-pNNN.<fmt>` and are linked after page text. The handle prints `Pages-Dir: <path> (<N> pages)` when renders exist; when none can be produced it prints `Pages-Dir: none - page images need the Python backend` for unpdf or `Pages-Dir: none - <type> has no page geometry` for other unsupported routes. Partial render failures add `Page images: N of M unavailable` to Notes. DOCX without explicit breaks prints `Page-Count: 1 (no explicit page breaks) - no page markers; cite by Outline line`. Spreadsheet preview truncation is aggregated into one handle note per workbook, starting `preview truncated:`.

`Saved-To` is always present. `Images-Dir` appears when images were written. `Degraded:`, `Fallback-Reason:`, `Failed-Pages:`/`Empty-Pages:`, `Notes:`, its `L<n>` entries, and `(+N more)` are conditional. `--info` writes no bundle and returns an info handle:

```text
Type: pdf   Page-Count: 42   Backend: uv
Title: Installation Manual   Author: ...
TOC:
  L1 Installation (p3)
  L2 Wiring (p12)
  (+N more)
```

A DOCX info handle prints `TOC: none (no heading styles found)` when no heading-styled paragraph exists and `(p?)` for headings when the file has no explicit breaks.

For Excel, the info handle is:

```text
Type: xlsx   Sheets: 3
  Data  worksheet rows=120 cols=9 charts=1 images=2 hiddenRows=1 hiddenCols=1
  Trends  chartsheet rows=- cols=- charts=1 images=0
```

## Word positions

Set `words: true` in a tool call or pass `--words` to write `<stem>.words.json` beside the Markdown. The option is per-call only, defaults to false, and has no settings key. It applies only to PDF and image inputs, never triggers OCR, and leaves Markdown, page stats, and OCR outcome unchanged. DOC, PPTX, and DOCX via LibreOffice remain unsupported even though they use the PDF pipeline.

The main file has this shape:

```json
{
  "unit": "pt",
  "pages": [
    { "page": 1, "width": 612.0, "height": 792.0, "rotation": 0,
      "words": [ { "text": "T2", "bbox": [412.3, 118.0, 428.9, 129.5], "source": "text" } ] }
  ]
}
```

`pages[]` uses selected 1-based document page numbers in document order. `width` and `height` are display-oriented; `rotation` records the PDF page's original `/Rotate` value. Each `bbox` is `[x0, y0, x1, y1]`, rounded to one decimal, in display space with a top-left origin and PDF points (`unit: "pt"`). pymupdf4llm removes page rotation during conversion; fallback and OCR paths map boxes through `page.rotation_matrix` to the same display orientation. Image inputs use `unit: "px"`, source pixel width and height, pixel boxes, and `rotation: 0`.

Words are PyMuPDF's whitespace-delimited tokens in returned order, without normalization or line/block grouping. In the main file, `source: "ocr"` means this run's inline OCR added the word; every other word is `source: "text"`, including a pre-existing OCR layer. Text-bearing pages under the default `textless` policy contain native words only, even with `--ocr`.

Requested inline OCR that did not run (unavailable, failed, budget-stopped, or an image skipped as too small) produces no `pages[]` entry for that page; consult the `OCR:` summary rather than treating it as empty. Textless pages without `--ocr`, and `noText` pages where OCR ran but recognized nothing, have `"words": []`. Conversion or word-extraction failures also omit the affected page; extraction failures appear in `wordsErrors`. The file still exists when every page is omitted (`"pages": []`).

Under `--ocr-mode all`, the main pass runs with OCR off and the main words file holds native words only. Each completed PDF OCR sidecar gets `ocr/<stem>-pNNN.words.json`, a single page object rather than a `pages[]` wrapper:

```json
{ "page": 2, "unit": "pt", "width": 612.0, "height": 792.0, "rotation": 0,
  "words": [ { "text": "3", "bbox": [72.0, 61.0, 78.5, 72.1], "source": "ocr" } ] }
```

Every sidecar word is `source: "ocr"`; full-page OCR may duplicate native words, and the converter does not dedupe. Consumers overlay the main and sidecar words by page number and prefer `text` where boxes overlap. A `noText` sidecar has `"words": []`. `ocr.wordSidecars` maps page numbers to absolute words-sidecar paths; `Words:` always names the main artifact, never the sidecars.

Word extraction and main-file write/publication failures do not fail conversion or change Markdown, stats, or OCR outcome. Main words are staged on disk, not sent over capped child stdout, and atomically renamed into place. A per-page extraction failure is recorded in `wordsErrors`; a main-file write or publication failure leaves `wordsPath` null. A forced-OCR words-only failure keeps the Markdown sidecar and its OCR outcome, removes the words file, and records the page in `wordsErrors` when the child result is available.

The handle prints `Words: <absolute path>` after `Page-Stats`, or `Words: <reason>` for these reasons:

- `none - word positions apply to PDF and image inputs only (<type>)`
- `none - unpdf tier has no page geometry`
- `none - image copied without conversion (<reason>)`
- `write failed - <reason>`

When the main file exists and `wordsErrors` is non-empty, its line ends with ` (extraction failed for pages <list>: <first message>)`, including forced-OCR word failures. Without `--words` there is no `Words:` line and `wordsPath` is null. `--info --words` is a usage error.

## Child contract

The Python child is `scripts/doc_to_md.py <mode>` (`info`, `pdf-primary`, `pdf-fallback`, `xlsx`, `render-pages`, `docx`, `html`, `image`, `email`, or `ocr-pages`). The JS child is `unpdf-worker <mode>` (`info` or `pdf-text`). Both receive options JSON on stdin and return one result JSON object on stdout. Exit `0` is success, `1` is a conversion failure, and `3` is a user error, with `error` and optional `pageCount` in its result JSON.

`docx` returns `markdown`, `pageCount` (numbered segments after dropping one trailing empty segment; empty segments between breaks are kept), `explicitBreaks` (raw break count), `engine` (`mammoth` or `python-docx`), `degraded`, and `fallbackReason`; it stages images as `p<segment>/img<n>.<ext>` with `.done` per selected segment. `info` on `.docx` returns `pageCount`, `explicitBreaks`, core-property `metadata` (dates as ISO-8601), and a heading `toc` whose page is the segment number or `null`. The env var `DOC_TO_MD_FORCE_DOCX_FALLBACK=1` forces the python-docx walker (tests only).

`html` receives preprocessed `html` and returns `markdown` and `engine`. `image` receives `stem`, `ocr`, and `ocrLanguage`, copies the input to `p1/original.<ext>`, and returns Markdown linking the image. PDF and image modes return `ocr` (`status`, `lang`, `textless`, `pages`, `noText`, `ocrFailed`, `budgetStopped`, `reason`, `tesseract`). The child receives `ocr`, `ocrLanguage`, and `ocrBudgetMs` (= `primaryTimeoutMs`); it admits OCR only when elapsed time + slowest OCR call + remaining pages x mean page time + 5000 ms fits the budget. The small-image gate avoids OCR for text-bearing pages with only small images; images shorter than 16 px on either side skip OCR. OCR block labels use `\x00OCR <staged file>\x00` sentinels, resolved to published image names by the parent.

Both Python PDF tiers return `pageStats` for the selected pages. For PDF and image inputs, the main `pdf-primary`, `pdf-fallback`, and `image` modes receive `words`; when true they stage the complete words document as `words.json` in `stagingDir` and return `words: true|false` plus `wordsErrors` (page-number keys for extraction failures, `file` for a document write failure). The payload stays off stdout. `DOC_TO_MD_WORDS_FAIL=<n>` injects a words extraction failure on page `n` (tests only).

`ocr-pages` receives `path`, `pages`, `stem`, `ocrLanguage`, `ocrBudgetMs`, `stagingDir`, `dpi`, `maxOutputBytes`, `pymupdfVersion`, and `words`. It checks Tesseract first (`{ "status": "unavailable", "reason" }`), then OCRs each page in order with `get_textpage_ocr(full=True)` at a `MAX_RENDER_PX`-clamped DPI, writing `active` (page in flight), `pNNN/.done` or `pNNN/.failed` before moving on, and returns `{ "status": "ran", "written", "noText", "ocrFailed", "ocrErrors", "budgetStopped" }`. The parent rebuilds the outcome from those markers when the child is killed or returns malformed output (the `active` page is `killed`, unmarked pages are `notAttempted`) and never retries. When `words` is true, `ocr-pages` writes `pNNN/<stem>-pNNN.words.json` beside the staged Markdown sidecar before `.done` and returns `wordsErrors`; a words-only failure still writes `.done` and preserves the sidecar. The parent enables this only for PDF input. `DOC_TO_MD_OCR_STALL_PAGE=<n>` makes the child sleep on page `n` (tests only).

`pdf-fallback` receives `keepPages`: an object mapping page numbers to primary-tier image filenames already published. It preserves those images while extracting fallback text rather than duplicating them.

## Configuration

Set tunables under `quiver.docToMd` in global agent settings or project `.pi/settings.json`. Precedence is per-call > `quiver.docToMd` > `PI_DOC_TO_MD_*` env (deprecated) > default.

| Key | Default | CLI flag | Meaning |
|---|---|---|---|
| `primaryTimeoutMs` | `60000` | `--primary-timeout` | pymupdf4llm tier and DOCX child (`docx` mode); also unpdf tier. |
| `fallbackTimeoutMs` | `30000` | `--fallback-timeout` | PyMuPDF text tier (including the DOCX LibreOffice fallback), PDF and DOCX info, and Excel rendered-view rasterization. |
| `sofficeTimeoutMs` | `120000` | `--soffice-timeout` | PPTX -> PDF, the DOCX LibreOffice fallback route, and Excel rendered-view export via LibreOffice. |
| `excelTimeoutMs` | `60000` | `--excel-timeout` | Excel child, both `openpyxl` loads, and Excel info. |
| `warmTimeoutMs` | `120000` | `--warm-timeout` | Absolute first-call backend discovery/bootstrap deadline. |
| `pymupdfVersion` | `1.27.2.3` | `--pymupdf-version` | pymupdf4llm pin; must be >= `1.27.0`. |
| `imageDpi` | `150` | `--image-dpi` | Render DPI for page images and Excel rendered views, subject to the 16 Mpx budget. |
| `imageFormat` | `png` | `--image-format` | Rendered image format: `png` or `jpg`. |
| `maxOutputBytes` | `20000000` | `--max-output-bytes` | Child stdout cap in bytes. |
| `outlineMaxEntries` | `40` | `--outline-max-entries` | Outline, TOC, or sheet inventory cap in the handle. |
| `ocr` | `false` | `--ocr` / `--no-ocr` | Run OCR on scanned pages and image inputs when Tesseract language data is installed. |
| `ocrLanguage` | `eng` | `--ocr-language` | Plain Tesseract language codes joined by `+`, such as `deu+eng`. |

`ocrMode` is per-call only, unlike the tunables above:

| Key | Default | CLI flag | Meaning |
|---|---|---|---|
| `ocrMode` | `textless` | `--ocr-mode` | `textless` OCRs only empty-text-layer pages inline; `all` OCRs every selected page into `ocr/` sidecars. Per-call only - never a `quiver.docToMd` key: persisting `all` would apply forced OCR to later `--ocr` runs in Pi and the CLI. Keeping it per-call preserves deliberate opt-in along with the explicit-pages guard. |

Worst-case wall time: PDF `warmTimeoutMs (first call) + primaryTimeoutMs + fallbackTimeoutMs`; PPTX adds `sofficeTimeoutMs`; DOCX on the Python path `warmTimeoutMs + primaryTimeoutMs` (success or a terminal child failure), DOCX child exit 1 then LibreOffice `warmTimeoutMs + primaryTimeoutMs + sofficeTimeoutMs + primaryTimeoutMs + fallbackTimeoutMs`, DOCX without a DOCX-capable backend `warmTimeoutMs + sofficeTimeoutMs + primaryTimeoutMs + fallbackTimeoutMs`; Excel `warmTimeoutMs + excelTimeoutMs + sofficeTimeoutMs + fallbackTimeoutMs`. Add `KILL_GRACE_MS` (2000 ms) per kill; `--ocr-mode all` adds `primaryTimeoutMs` for the `ocr-pages` child. There is no cap on image count, image bytes, cell count or workbook memory - deliberately; the per-tier timeouts, the rendered-view pixel budget and `maxOutputBytes` are the bounds.

Deprecated environment mappings are `PI_DOC_TO_MD_CONVERT_TIMEOUT_MS` -> `primaryTimeoutMs`, `PI_DOC_TO_MD_SOFFICE_TIMEOUT_MS` -> `sofficeTimeoutMs`, `PI_DOC_TO_MD_WARM_TIMEOUT_MS` -> `warmTimeoutMs`, and `PI_DOC_TO_MD_PYMUPDF_VERSION` -> `pymupdfVersion`.

`warmTimeoutMs` is an absolute discovery deadline, including all attempted backend probes and bootstrap work. Every child runs through a capped runner. Timeout or output-cap termination tree-kills the process group on POSIX and uses `taskkill /T` on Windows; its grace period is `KILL_GRACE_MS` (2000 ms). This boundary exists because MuPDF and PDF.js can spin uninterruptibly.

## Optional: Tesseract for OCR

OCR is off by default. With the default `ocrMode: "textless"`, the decision is per page: a page with a text layer never runs OCR (`use_ocr=False` is passed), even when it contains embedded images; only pages without a text layer run OCR. Set `ocr: true` or pass `--ocr` to recognize scanned pages and image inputs when Tesseract language data is installed. Without it, conversion succeeds, pictures remain, and the handle reports why OCR did not run. pymupdf4llm uses the Tesseract engine linked into PyMuPDF and needs only the language data. Install with `brew install tesseract` on macOS, `sudo apt install tesseract-ocr` on Debian/Ubuntu, or the UB Mannheim installer on Windows (keep `tesseract` on `PATH`). For extra languages use `brew install tesseract-lang` or `sudo apt install tesseract-ocr-<lang>` (for example `tesseract-ocr-deu`). Set `TESSDATA_PREFIX` to a custom tessdata directory when needed. `ocrLanguage` accepts only plain codes joined by `+`, not `script/...` models. Scanned pages cost about 3 s each; pages past the time budget keep their picture and the handle suggests rerunning those pages or raising `primaryTimeoutMs`.

Forced OCR is sidecar-only so recognized text never replaces the text layer, and page-gated so the caller bounds the work. It runs in its own child because MuPDF bitmap bombs can abort or spin the process: the second child is kill-capped at `primaryTimeoutMs` (the process tree is SIGKILLed at the deadline; Node waits up to `KILL_GRACE_MS` for exit), and finished sidecars survive. Under `all`, missing Tesseract data is a hard error (`OCR unavailable: <reason> (install Tesseract; see doc/doc-to-md.md)`), not a skipped pass. Omitted pages and `--pages ""` are refused; DOCX page-break segments are not PDF pages, so convert DOCX to PDF before forced OCR.

```text
Two-pass OCR (PDF, PPTX, DOC):
  1. pi-quiver doc-to-md report.pdf --output-dir out --json
       -> "pageStatsPath" points at out/report.pages.json; pages with few
          chars and high imageCoverage are scans. "savedTo" is the Markdown.
  2. pi-quiver doc-to-md report.pdf --output-dir out --ocr --ocr-mode all --pages 2,7 --json
       -> "ocr"."sidecars" maps 2 and 7 to out/ocr/report-2-p002.md and
          ...-p007.md (a second run in the same dir gets stem report-2);
          the Markdown of this run holds pages 2 and 7 only and equals what
          --pages 2,7 without --ocr would produce. Read sidecars and Markdown
          by the returned paths, never by guessing names.
  3. --ocr-mode all refuses to run without --ocr and an explicit --pages.
     The "ocr" object (OCR: line) names failed, budget-stopped, killed and
     not-attempted pages and the exact --pages to re-run.
  Details: doc/doc-to-md.md (bundle contract, failure buckets).
```

## CLI (`pi-quiver doc-to-md`)

`npx -y pi-quiver@latest doc-to-md [flags] <path>` runs the same core and prints the same handle. `pi-quiver doc-to-md --help` lists every flag.

| Flag | Meaning |
|---|---|
| `<path>` | Local `.pdf`, `.docx`, `.doc`, `.pptx`, `.xlsx`, `.xlsm`, `.xls`, `.msg`, `.eml`, `.html`, `.htm`, `.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.bmp`, or `.gif` file. |
| `--info` | Inspect page count, metadata, TOC, or sheet inventory; no bundle. |
| `--pages <spec>` | Inclusive 1-based PDF/Office pages, such as `12-15` or `3,7,10-12`; `--pages ""` means all pages, as does `pages: ""` in the tool (`parsePages` returns `null`). |
| `--output-dir <dir>` | Bundle root for `<stem>.md` and `images/`; default a per-call temp directory. |
| `--overwrite` | Replace an existing completed bundle. |
| `--page-images` | Render selected pages under `pages/` where page geometry and a Python backend are available. |
| `--words` | Write `<stem>.words.json` (and `ocr/<stem>-pNNN.words.json` under `--ocr-mode all`); PDF and image inputs only; never triggers OCR. |
| `--json` | CLI only: print one JSON object instead of the text handle. Conversion returns `HandleData` keys `savedTo`, `imagesDir`, `sheetsDir`, `pagesDir`, `type`, `engine`, `tier`, `pageCount`, `pages`, `explicitBreaks`, `imageCount`, `pageImageCount`, `pageImagesReason`, `bytes`, `lines`, `degraded`, `fallbackReason`, `failedPages`, `emptyPages`, `notes`, `outline`, `outlineTotal`, `ocr`, `pageStats`, `pageStatsPath`, `ocrDir`, `wordsPath`, `wordsReason`, `wordsErrors`. The `ocr` object also carries `mode`, `sidecars`, `wordSidecars`, `ocrErrors`, `killed`, `notAttempted`, and `childError`. `--info` returns `InfoData` keys `type`, `backend`, `pageCount`, `metadata`, `toc`, `tocTotal`, `sheets`, `sheetsTotal`. |
| `--primary-timeout <n>` | pymupdf4llm and unpdf deadline. |
| `--fallback-timeout <n>` | PyMuPDF text and PDF-info deadline. |
| `--soffice-timeout <n>` | LibreOffice deadline. |
| `--excel-timeout <n>` | Excel and Excel-info deadline. |
| `--warm-timeout <n>` | Backend discovery/bootstrap deadline. |
| `--pymupdf-version <version>` | pymupdf4llm pin, >= `1.27.0`. |
| `--image-dpi <n>` | Page image render DPI. |
| `--image-format <png\|jpg>` | Rendered image format. |
| `--max-output-bytes <n>` | Child stdout cap. |
| `--outline-max-entries <n>` | Handle outline/TOC/inventory cap. |
| `--ocr` / `--no-ocr` | Enable OCR or override a settings-level `ocr: true` for this call. `--no-<flag>` works for every settable boolean flag. |
| `--ocr-language <codes>` | Plain `+`-joined Tesseract language codes, default `eng`. |
| `--ocr-mode <textless\|all>` | OCR policy: `textless` (default) OCRs only pages with an empty text layer, inline; `all` OCRs every selected page into `ocr/<stem>-pNNN.md` sidecars, leaving the Markdown untouched. `all` requires `--ocr` and an explicit `--pages` selection (PDF, PPTX, DOC). |

| Code | Meaning |
|---|---|
| `0` | Converted or inspected, including degraded fallback. |
| `1` | Runtime error, including `empty file: <path>` for zero-byte inputs. |
| `2` | Usage error, including `--info --words` and `--ocr-mode all` guard failures raised by conversion: missing `--ocr`, omitted or empty `--pages`, or inputs other than PDF/PPTX/DOC. |

## Install channels

For Pi, install from npm with `pi install npm:pi-quiver`, or run the CLI without installing with `npx -y pi-quiver doc-to-md <path>`. Claude Code uses the `quiver` marketplace plugin and the generated `skills/doc-to-md/SKILL.md`; its marketplace `version` matches the npm version. Third-party marketplaces do not auto-update by default. Run `claude plugin update quiver@pi-quiver` or enable auto-update in `/plugin` to receive a new plugin release. `claude update` updates Claude Code itself, not plugins.

## Manual smoke

CI installs `uv` and LibreOffice on Ubuntu and runs the Python suite when they are available. Smoke the external routes when changing them:

| Check | Command / expected result |
|---|---|
| Info | `node bin/pi-quiver.ts doc-to-md --info test/fixtures/multipage.pdf` returns page count and TOC, with no `Saved-To`. |
| Selected pages and images | `node bin/pi-quiver.ts doc-to-md --pages 3-5 test/fixtures/multipage.pdf` returns only pages 3-5; inspect its bundle for separators and page images. |
| Forced fallback | `node bin/pi-quiver.ts doc-to-md --primary-timeout 1 test/fixtures/multipage.pdf` reports `Engine: pymupdf-text`, `Tier: fallback`, `Degraded:`, and `Fallback-Reason:`. |
| DOCX | `node bin/pi-quiver.ts doc-to-md test/fixtures/multipage.docx` returns `Engine: mammoth   Tier: docx`, `Page-Count: 5 (explicit page breaks, not printed pages)`, and an Outline with `p1..p5`; a warm run completes in under 2 s. |
| XLSX | `node bin/pi-quiver.ts doc-to-md test/fixtures/workbook.xlsx` returns `Engine: openpyxl   Tier: excel`; inspect the Sheets table, CSV links, preview, and (with soffice) rendered views. |
| XLSX charts | `node bin/pi-quiver.ts doc-to-md test/fixtures/charts.xlsx` returns three `Rendered view:` images with soffice, or three `Rendered view: unavailable (LibreOffice not found)` lines without it; conversion succeeds either way. |
| XLS | `node bin/pi-quiver.ts doc-to-md test/fixtures/legacy.xls` reports `Engine: xlrd   Tier: excel` and unavailable formulas/images. |

## Licensing note

`pymupdf4llm`/PyMuPDF are AGPL-3.0. pi-quiver ships none of their code: the packages are installed at runtime and run only as separate subprocesses. `openpyxl` is MIT, `xlrd` is BSD, and `pillow` is MIT-CMU. The subprocess boundary must remain intact: vendoring or importing the AGPL packages into TypeScript would change the licensing analysis.
