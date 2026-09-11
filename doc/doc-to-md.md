# doc_to_md - local document -> Markdown bundle

`doc_to_md` takes a local `.pdf`, `.docx`, `.pptx`, `.xlsx`, or `.xls` path, writes a Markdown bundle on disk, and returns a concise handle - never inline Markdown. For remote documents, `fetch` the URL first, then pass its saved path here.

## Backend ladder

The backend is resolved once per process. Every conversion tier is a fresh child process, so a stuck MuPDF or PDF.js call can be killed.

1. **`uv`** - `uv run --with pymupdf4llm==1.27.2.3 --with openpyxl==3.1.5 --with xlrd==2.0.2 --with pillow==12.3.0 --python 3.14 python scripts/doc_to_md.py <mode>`. This preferred rung supplies PDF and Excel capabilities.
2. **System Python** - `python3`, then `python`, from `PATH`, if Python is >= 3.12. The capability probe requires `pymupdf4llm >= 1.27.0` for PDF and independently checks `openpyxl`, `xlrd`, and `PIL` for Excel. A capable system install is used as-is.
3. **Managed venv** - a bare eligible system Python can bootstrap the pinned package set at `<per-OS cache dir>/pi-quiver/doc-to-md-venv-v2`. It builds in a sibling temporary directory and publishes with rename. A successfully published legacy `pymupdf-venv` is removed. A cached venv is reused.
4. **PyMuPDF text** - if a Python backend exists but `pymupdf4llm` primary conversion fails, `scripts/doc_to_md.py pdf-fallback` uses `pymupdf` text extraction. The resulting bundle is degraded: layout and tables are not preserved.
5. **`unpdf` worker** - if no Python PDF backend resolves, a separate `unpdf-worker` child extracts text. It is also degraded and does not extract images.

The probe prints exactly:

```text
PY <version> PDF <yes|no> XLSX <yes|no>
```

Its current implementation emits major and minor version as separate fields, for example `PY 3 14`, followed by the `PDF` and `XLSX` capability lines. Python available only through Windows `py.exe` is not detected; install `uv` or expose `python`/`python3` on `PATH`.

| Platform | Cache dir |
|---|---|
| `win32` | `%LOCALAPPDATA%\pi-quiver` |
| `darwin` | `~/Library/Caches/pi-quiver` |
| other | `$XDG_CACHE_HOME/pi-quiver`, else `~/.cache/pi-quiver` |

## Office documents

`.docx` and `.pptx` inputs are converted to PDF by headless LibreOffice (`soffice`) with an isolated per-call profile, then use the PDF pipeline. `soffice` must be on `PATH`; Office conversion otherwise fails. Requested page bounds apply after `soffice` produces the PDF.

Excel does not go through LibreOffice for its data. `.xlsx` uses `openpyxl`; `.xls` uses `xlrd`. Both require a Python backend. Workbooks become a `## Sheets` inventory (every worksheet and chartsheet in workbook order, 0-based index) followed by one section per sheet: a `Data:` link to the sheet's full CSV under `sheets/` for non-empty worksheets, chart metadata (`<type> "<title>" - <n> series (<refs>)`), embedded images, an optional rendered view, a preview of at most 100 rows x 50 columns of the non-empty extent, and a `Columns:` profile when the preview is truncated. `.xlsx` shows formulas with cached values; `.xls` reports formulas and images unavailable. Sheets carrying charts or images get a rendered view (`images/<stem>-s<idx>.<fmt>`) when `soffice` is on `PATH`: the workbook is exported with `pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}` (one page per sheet) and the matching pages are rasterized by the `render-pages` child under a 16 Mpx budget. Every failure on that path (`LibreOffice not found`, `soffice failed: ...`, `soffice produced no PDF`, `page-count mismatch (N vs M)`, `render failed: ...`, `rendered view degenerate (...)`, `rendered view too large (...)`) is written into the sheet section as `Rendered view: unavailable (<reason>)` plus a handle note; conversion still succeeds. `.xlsm`, sheet/range selection, and in-grid placement of visuals are out of scope; `.xls` has no visual detection.

## Bundle and handle

A bundle root contains `<stem>.md`, `images/`, and - when a spreadsheet has data - `sheets/`. `--output-dir` selects the root; otherwise a per-call temporary root is created. The caller owns a temporary bundle: the tool never deletes a bundle it produced.

A call owns `<stem>.md.lock` for its duration. Child page images stage in `images/.stage-<lockId>/p<N>/`; a child writes `.done` only after that page is complete. Node publishes completed page files as `images/<stem>-p<N>-<n>.<ext>`, discards incomplete page staging directories, and atomically publishes `<stem>.md` by writing a temporary Markdown file then renaming it. Excel images stage as `s<idx>-<n>.<ext>` and publish as `<stem>-s<idx>-<n>.<ext>`. On overwrite, only this stem's owned-pattern files are removed (`images/<stem>-p<N>-<n>.*`, `images/<stem>-s<idx>[-<n>].*`, `sheets/<stem>-s<idx>-<slug>.csv`); nothing else in the bundle is touched. Excel CSVs stage under `sheets/.stage-<lockId>/s<idx>-<slug>.csv` and publish as `sheets/<stem>-s<idx>-<slug>.csv`; rendered views stage as `s<idx>.<fmt>` and publish as `images/<stem>-s<idx>.<fmt>`. The handle prints `Sheets-Dir` when any CSV was written.

Every selected PDF/Office page ends with `--- end of page.page_number=N ---`.

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
Outline: (conditional)
  L12  # Installation
  L87  ## Wiring
  (+N more)
```

`Saved-To` is always present. `Images-Dir` appears when images were written. `Degraded:`, `Fallback-Reason:`, `Failed-Pages:`/`Empty-Pages:`, `Notes:`, `Outline:`, its `L<n>` entries, and `(+N more)` are conditional. `--info` writes no bundle and returns an info handle:

```text
Type: pdf   Page-Count: 42   Backend: uv
Title: Installation Manual   Author: ...
TOC:
  L1 Installation (p3)
  L2 Wiring (p12)
  (+N more)
```

For Excel, the info handle is:

```text
Type: xlsx   Sheets: 3
  Data  worksheet rows=120 cols=9 charts=1 images=2 hiddenRows=1 hiddenCols=1
  Trends  chartsheet rows=- cols=- charts=1 images=0
```

## Child contract

The Python child is `scripts/doc_to_md.py <mode>` (`info`, `pdf-primary`, `pdf-fallback`, `xlsx`, or `render-pages`). The JS child is `unpdf-worker <mode>` (`info` or `pdf-text`). Both receive options JSON on stdin and return one result JSON object on stdout. Exit `0` is success, `1` is a conversion failure, and `3` is a user error, with `error` and optional `pageCount` in its result JSON.

`pdf-fallback` receives `keepPages`: an object mapping page numbers to primary-tier image filenames already published. It preserves those images while extracting fallback text rather than duplicating them.

## Configuration

Set tunables under `quiver.docToMd` in global agent settings or project `.pi/settings.json`. Precedence is per-call > `quiver.docToMd` > `PI_DOC_TO_MD_*` env (deprecated) > default.

| Key | Default | CLI flag | Meaning |
|---|---|---|---|
| `primaryTimeoutMs` | `60000` | `--primary-timeout` | pymupdf4llm tier; also unpdf tier. |
| `fallbackTimeoutMs` | `30000` | `--fallback-timeout` | PyMuPDF text tier, PDF info, and Excel rendered-view rasterization. |
| `sofficeTimeoutMs` | `120000` | `--soffice-timeout` | DOCX/PPTX -> PDF and Excel rendered-view export via LibreOffice. |
| `excelTimeoutMs` | `60000` | `--excel-timeout` | Excel child, both `openpyxl` loads, and Excel info. |
| `warmTimeoutMs` | `120000` | `--warm-timeout` | Absolute first-call backend discovery/bootstrap deadline. |
| `pymupdfVersion` | `1.27.2.3` | `--pymupdf-version` | pymupdf4llm pin; must be >= `1.27.0`. |
| `imageDpi` | `150` | `--image-dpi` | Render DPI for page images and Excel rendered views, subject to the 16 Mpx budget. |
| `imageFormat` | `png` | `--image-format` | Rendered image format: `png` or `jpg`. |
| `maxOutputBytes` | `20000000` | `--max-output-bytes` | Child stdout cap in bytes. |
| `outlineMaxEntries` | `40` | `--outline-max-entries` | Outline, TOC, or sheet inventory cap in the handle. |

Worst-case wall time is `warmTimeoutMs (first call) + sofficeTimeoutMs (Office only) + primaryTimeoutMs + fallbackTimeoutMs + KILL_GRACE_MS x kills` (Excel: `warmTimeoutMs + excelTimeoutMs + sofficeTimeoutMs + fallbackTimeoutMs + 2 * KILL_GRACE_MS`); `KILL_GRACE_MS` is 2000 ms. There is no cap on image count, image bytes, cell count or workbook memory - deliberately; the per-tier timeouts, the rendered-view pixel budget and `maxOutputBytes` are the bounds.

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
| XLSX | `node bin/pi-quiver.ts doc-to-md test/fixtures/workbook.xlsx` returns `Engine: openpyxl   Tier: excel`; inspect the Sheets table, CSV links, preview, and (with soffice) rendered views. |
| XLSX charts | `node bin/pi-quiver.ts doc-to-md test/fixtures/charts.xlsx` returns three `Rendered view:` images with soffice, or three `Rendered view: unavailable (LibreOffice not found)` lines without it; conversion succeeds either way. |
| XLS | `node bin/pi-quiver.ts doc-to-md test/fixtures/legacy.xls` reports `Engine: xlrd   Tier: excel` and unavailable formulas/images. |

## Licensing note

`pymupdf4llm`/PyMuPDF are AGPL-3.0. pi-quiver ships none of their code: the packages are installed at runtime and run only as separate subprocesses. `openpyxl` is MIT, `xlrd` is BSD, and `pillow` is MIT-CMU. The subprocess boundary must remain intact: vendoring or importing the AGPL packages into TypeScript would change the licensing analysis.
