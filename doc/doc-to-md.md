# doc_to_md - local document -> Markdown bundle

`doc_to_md` takes a local `.pdf`, `.docx`, `.pptx`, `.xlsx`, or `.xls` path, writes a Markdown bundle on disk, and returns a concise handle - never inline Markdown. For remote documents, `fetch` the URL first, then pass its saved path here.

## Backend ladder

The backend is resolved once per process. Every conversion tier is a fresh child process, so a stuck MuPDF or PDF.js call can be killed.

1. **`uv`** - `uv run --with pymupdf4llm==1.27.2.3 --with openpyxl==3.1.5 --with xlrd==2.0.2 --with pillow==12.3.0 --with mammoth==1.13.0 --with markdownify==1.2.3 --with python-docx==1.2.0 --python 3.14 python scripts/doc_to_md.py <mode>`. This preferred rung supplies PDF, Excel, and DOCX capabilities.
2. **System Python** - `python3`, then `python`, from `PATH`, if Python is >= 3.12. The capability probe requires `pymupdf4llm >= 1.27.0` for PDF and independently checks `openpyxl`, `xlrd`, and `PIL` for Excel, and checks `mammoth`, `markdownify`, and `docx` for DOCX. A PDF-capable system Python without the DOCX packages is still used; its `.docx` inputs take the LibreOffice route.
3. **Managed venv** - a bare eligible system Python can bootstrap the pinned package set at `<per-OS cache dir>/pi-quiver/doc-to-md-venv-v3`. It builds in a sibling temporary directory and publishes with rename. After a successful publish the legacy `pymupdf-venv` and `doc-to-md-venv-v2` directories are removed. A cached venv is reused.
4. **PyMuPDF text** - if a Python backend exists but `pymupdf4llm` primary conversion fails, `scripts/doc_to_md.py pdf-fallback` uses `pymupdf` text extraction. The resulting bundle is degraded: layout and tables are not preserved.
5. **`unpdf` worker** - if no Python PDF backend resolves, a separate `unpdf-worker` child extracts text. It is also degraded and does not extract images.
6. **DOCX child** - `.docx` inputs run `scripts/doc_to_md.py docx` when the backend probes `DOCX yes`: mammoth -> HTML -> markdownify, with a python-docx text walker as the in-child fallback (degraded: footnotes, hyperlinks, images not preserved). When the child exits 1 and `soffice` is on `PATH`, the file takes the LibreOffice -> PDF route (degraded, `LibreOffice pagination`); a user error (exit 3), timeout, output cap, or invalid JSON is terminal.

The probe prints exactly:

```text
PY <major> <minor>
PDF <yes|no>
XLSX <yes|no>
DOCX <yes|no>
```

Its current implementation emits major and minor version as separate fields, for example `PY 3 14`, followed by the `PDF`, `XLSX`, and `DOCX` capability lines. Python available only through Windows `py.exe` is not detected; install `uv` or expose `python`/`python3` on `PATH`.

| Platform | Cache dir |
|---|---|
| `win32` | `%LOCALAPPDATA%\pi-quiver` |
| `darwin` | `~/Library/Caches/pi-quiver` |
| other | `$XDG_CACHE_HOME/pi-quiver`, else `~/.cache/pi-quiver` |

## Office documents

`.docx` converts directly in the Python child. Heading styles become `#..######` (Heading 7-9 clamp to `######`), hyperlinks keep their targets, footnotes are appended as a numbered list, and pictures are staged per segment and published under `images/`. Only author-inserted page breaks (`w:br w:type="page"`) become `--- end of page.page_number=N ---` markers: segments are numbered in break order, a break inside a heading or paragraph splits it, a break inside a table cell moves after the table, a break inside a list item closes the list, and one trailing empty segment is dropped. Soft breaks, section breaks, `pageBreakBefore`, and header/footer page fields produce no marker. `pages` on a DOCX selects these segments and is rejected when the file has no explicit break (`--pages does not apply to this DOCX: it has no explicit page breaks; read the .md by Outline line offsets instead`). Without the Python DOCX packages, or when the child exits 1, `.docx` falls back to headless LibreOffice (`soffice`) -> PDF -> the PDF ladder; that route is marked degraded, reports `Page-Count: N (LibreOffice pagination)`, and rejects `pages` before `soffice` runs (after child exit 1 the error also includes the child reason). A child exit 1 followed by a `soffice` failure reports `Conversion failed: docx exit 1 (<child reason>); <office failure message>`. With neither a DOCX-capable Python nor `soffice`, the call fails with one error naming both remedies. `info` on a DOCX never runs LibreOffice.

`.pptx` inputs are converted to PDF by headless LibreOffice with an isolated per-call profile, then use the PDF pipeline. `soffice` must be on `PATH`; otherwise the call fails with `PPTX conversion needs LibreOffice (soffice); direct conversion is not available`. Requested page bounds apply after `soffice` produces the PDF.

Excel does not go through LibreOffice for its data. `.xlsx` uses `openpyxl`; `.xls` uses `xlrd`. Both require a Python backend. Workbooks become a `## Sheets` inventory (every worksheet and chartsheet in workbook order, 0-based index) followed by one section per sheet: a `Data:` link to the sheet's full CSV under `sheets/` for non-empty worksheets, chart metadata (`<type> "<title>" - <n> series (<refs>)`), embedded images, an optional rendered view, a preview of at most 100 rows x 50 columns of the non-empty extent, and a `Columns:` profile when the preview is truncated. `.xlsx` shows formulas with cached values; `.xls` reports formulas and images unavailable. Sheets carrying charts or images get a rendered view (`images/<stem>-s<idx>.<fmt>`) when `soffice` is on `PATH`: the workbook is exported with `pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}` (one page per sheet) and the matching pages are rasterized by the `render-pages` child under a 16 Mpx budget. Every failure on that path (`LibreOffice not found`, `soffice failed: ...`, `soffice produced no PDF`, `page-count mismatch (N vs M)`, `render failed: ...`, `rendered view degenerate (...)`, `rendered view too large (...)`) is written into the sheet section as `Rendered view: unavailable (<reason>)` plus a handle note; conversion still succeeds. `.xlsm`, sheet/range selection, and in-grid placement of visuals are out of scope; `.xls` has no visual detection.

## Bundle and handle

A bundle root contains `<stem>.md`, `images/`, and - when a spreadsheet has data - `sheets/`. `--output-dir` selects the root; otherwise a per-call temporary root is created. The caller owns a temporary bundle: the tool never deletes a bundle it produced.

A call owns `<stem>.md.lock` for its duration. Child page images stage in `images/.stage-<lockId>/p<N>/`; a child writes `.done` only after that page is complete. Node publishes completed page files as `images/<stem>-p<N>-<n>.<ext>`, discards incomplete page staging directories, and atomically publishes `<stem>.md` by writing a temporary Markdown file then renaming it. Excel images stage as `s<idx>-<n>.<ext>` and publish as `<stem>-s<idx>-<n>.<ext>`. On overwrite, only this stem's owned-pattern files are removed (`images/<stem>-p<N>-<n>.*`, `images/<stem>-s<idx>[-<n>].*`, `sheets/<stem>-s<idx>-<slug>.csv`); nothing else in the bundle is touched. Excel CSVs stage under `sheets/.stage-<lockId>/s<idx>-<slug>.csv` and publish as `sheets/<stem>-s<idx>-<slug>.csv`; rendered views stage as `s<idx>.<fmt>` and publish as `images/<stem>-s<idx>.<fmt>`. The handle prints `Sheets-Dir` when any CSV was written.

Every selected PDF or PPTX page, and every DOCX segment when the file has more than one segment (`pageCount > 1`), ends with `--- end of page.page_number=N ---`.

A conversion handle has this portable shape:

```text
Saved-To: /abs/out/manual.md
Images-Dir: /abs/out/images
Type: pdf   Engine: pymupdf4llm   Tier: primary
Page-Count: 42   Pages: 3-5   Images: 4   Size: 18.2KB / 412 lines
Degraded: ... (conditional)
Fallback-Reason: ... (conditional)
Failed-Pages: ...    Empty-Pages: ... (conditional)
Notes: ... (conditional)
Outline:
  L12  p1  # Installation
  L87  p4  ## Wiring
  (+N more)
```

`Outline` rows carry `L<line>` and, when the Markdown has page markers, `p<N>` (the page whose marker closes the heading's segment; headings after the last marker have no page column). A file with no headings prints `Outline: none`. For DOCX, `Page-Count` is suffixed `(explicit page breaks, not printed pages)`, `(no explicit page breaks)`, or `(LibreOffice pagination)`.

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

## Child contract

The Python child is `scripts/doc_to_md.py <mode>` (`info`, `pdf-primary`, `pdf-fallback`, `xlsx`, `render-pages`, or `docx`). The JS child is `unpdf-worker <mode>` (`info` or `pdf-text`). Both receive options JSON on stdin and return one result JSON object on stdout. Exit `0` is success, `1` is a conversion failure, and `3` is a user error, with `error` and optional `pageCount` in its result JSON.

`docx` returns `markdown`, `pageCount` (numbered segments after dropping one trailing empty segment; empty segments between breaks are kept), `explicitBreaks` (raw break count), `engine` (`mammoth` or `python-docx`), `degraded`, and `fallbackReason`; it stages images as `p<segment>/img<n>.<ext>` with `.done` per selected segment. `info` on `.docx` returns `pageCount`, `explicitBreaks`, core-property `metadata` (dates as ISO-8601), and a heading `toc` whose page is the segment number or `null`. The env var `DOC_TO_MD_FORCE_DOCX_FALLBACK=1` forces the python-docx walker (tests only).

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

Worst-case wall time: PDF `warmTimeoutMs (first call) + primaryTimeoutMs + fallbackTimeoutMs`; PPTX adds `sofficeTimeoutMs`; DOCX on the Python path `warmTimeoutMs + primaryTimeoutMs` (success or a terminal child failure), DOCX child exit 1 then LibreOffice `warmTimeoutMs + primaryTimeoutMs + sofficeTimeoutMs + primaryTimeoutMs + fallbackTimeoutMs`, DOCX without a DOCX-capable backend `warmTimeoutMs + sofficeTimeoutMs + primaryTimeoutMs + fallbackTimeoutMs`; Excel `warmTimeoutMs + excelTimeoutMs + sofficeTimeoutMs + fallbackTimeoutMs`. Add `KILL_GRACE_MS` (2000 ms) per kill. There is no cap on image count, image bytes, cell count or workbook memory - deliberately; the per-tier timeouts, the rendered-view pixel budget and `maxOutputBytes` are the bounds.

Deprecated environment mappings are `PI_DOC_TO_MD_CONVERT_TIMEOUT_MS` -> `primaryTimeoutMs`, `PI_DOC_TO_MD_SOFFICE_TIMEOUT_MS` -> `sofficeTimeoutMs`, `PI_DOC_TO_MD_WARM_TIMEOUT_MS` -> `warmTimeoutMs`, and `PI_DOC_TO_MD_PYMUPDF_VERSION` -> `pymupdfVersion`.

`warmTimeoutMs` is an absolute discovery deadline, including all attempted backend probes and bootstrap work. Every child runs through a capped runner. Timeout or output-cap termination tree-kills the process group on POSIX and uses `taskkill /T` on Windows; its grace period is `KILL_GRACE_MS` (2000 ms). This boundary exists because MuPDF and PDF.js can spin uninterruptibly.

## CLI (`pi-quiver doc-to-md`)

`npx -y pi-quiver@latest doc-to-md [flags] <path>` runs the same core and prints the same handle. `pi-quiver doc-to-md --help` lists every flag.

| Flag | Meaning |
|---|---|
| `<path>` | Local `.pdf`, `.docx`, `.pptx`, `.xlsx`, or `.xls` file. |
| `--info` | Inspect page count, metadata, TOC, or sheet inventory; no bundle. |
| `--pages <spec>` | Inclusive 1-based PDF/Office pages, such as `12-15` or `3,7,10-12`; default all. |
| `--output-dir <dir>` | Bundle root for `<stem>.md` and `images/`; default a per-call temp directory. |
| `--overwrite` | Replace an existing completed bundle. |
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

| Code | Meaning |
|---|---|
| `0` | Converted or inspected, including degraded fallback. |
| `1` | Runtime error. |
| `2` | Usage error. |

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
