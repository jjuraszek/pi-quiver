# doc_to_md: selective, image-linked, time-bounded document and Excel conversion

> **Superseded by:** [doc/specs/2026-09-10-gh-17-excel-output-v2.md](./2026-09-10-gh-17-excel-output-v2.md) - "chart rendering" non-goal, `maxCellsPerSheet` option row, and the Excel part of the Python/bundle contract (matrix budget, bundle layout, 1-based worksheet-only indices)

Ticket: [jjuraszek/pi-quiver#13](https://github.com/jjuraszek/pi-quiver/issues/13)
Supersedes: `doc/specs/2026-06-15-doc-to-md-converter.md` ("Non-Goals: No spreadsheets", the single unpdf fallback, and the inline-result contract), `doc/specs/2026-08-26-doc-to-md-python-backend-cli-skill.md` ("Out of scope: any change to `scripts/pdf_to_md.py` behavior", the flagless CLI, and the inline/spill size gate).

## Problem

`doc_to_md` is all-or-nothing today: whole document, Markdown only, no images, temp-only output, one 60s pymupdf4llm attempt followed by an in-process pure-JS `unpdf` text dump, an inline-or-spill result that puts up to 32KB of Markdown into context, and no spreadsheet path at all (`classifyInput` rejects `.xlsx`). Agents that need pages 12-15 of a manual, a figure that only exists as a raster, a durable output bundle, the page count before choosing pages, a predictable failure mode on a toxic PDF, or `Settings!D17` as a cell rather than a print-to-PDF blur cannot get them.

Owner note on #13 (verbatim): "Use `pymupdf4llm` for primary PDF conversion. On failure or timeout, fall back to PyMuPDF's per-page `get_text("text")`. Run both in terminable subprocesses within the overall conversion budget, reserving time for fallback."

## Goals

- **Disk-only, single interface.** Every conversion writes a bundle (`<stem>.md` + `images/`) and returns a short, bounded **handle** (paths, page count, stats, heading outline, diagnostics). Markdown is never returned inline; the agent reads the file with `read` (offset/limit). One result shape for tool, CLI, and skill; no size gate, no spill mode.
- **Info mode.** `info: true` / `--info` reports page count, metadata, table of contents (PDF/DOCX/PPTX) or sheet inventory (Excel) without converting, so the agent can pick pages first.
- **Page selection optional, default full.** Inclusive, 1-based `pages` for PDF (and DOCX/PPTX via the intermediate PDF), original numbering preserved. Omitted -> whole document.
- **Inline page breaks always.** Every PDF/DOCX/PPTX conversion, on every tier, emits the canonical separator `--- end of page.page_number=N ---` (pymupdf4llm's native format, N = original 1-based number) after each selected page. The separator is written by our own code on every tier, never trusted from a library.
- **Images always extracted** (PDF: rendered/embedded per selected page; Excel: embedded workbook images) and linked with relative `images/<file>` paths from `<stem>.md`; images already produced before a tier died stay referenced.
- **Every extraction tier is a terminable child.** pymupdf4llm -> PyMuPDF per-page `get_text("text")` -> `unpdf` (only when no capable Python backend exists), each a fresh subprocess tree under its own fixed timeout, killed as a tree. This includes `unpdf`, which today runs in-process.
- **Direct `.xlsx`/`.xls`** conversion to a per-worksheet Markdown matrix with formulas, cached values, merged ranges, and hidden sheets/rows/columns disclosed.
- **One option descriptor table** shared by the pi tool, `quiver.docToMd` settings, and the `pi-quiver doc-to-md` CLI; every knob reachable from the Claude Code skill via CLI flags and `--help`.

## Non-goals

- OCR for scanned documents (`use_ocr=False`).
- Librarian-style page-window quarantine / PDFium recovery of toxic pages (per-page isolation inside a tier plus the fallback tier is the salvage story).
- Image extraction on the `unpdf` rung (text only; disclosed in the handle).
- `.xlsm`, Excel sheet/range selection, other spreadsheet formats, chart rendering, formula recalculation.
- Inline Markdown in the tool result (deliberately removed; `read` is the retrieval path).
- Caching the intermediate PDF of a DOCX/PPTX between calls (each call re-runs soffice).
- Cleaning temp bundles: the tool never deletes a bundle it produced; the caller owns them (README states this).
- Removing the `unpdf` dependency or the `PI_DOC_TO_MD_*` env vars (kept as a deprecated compatibility layer).

## Architecture

```
extensions/doc_to_md.ts      pi adapter: TypeBox schema built from the core's option descriptors; settings via
                             lib/extension-config.ts resolveConfig("docToMd", coerce = core validator); paths resolved
                             against ctx.cwd; execute -> convertDocument / inspectDocument; renderResult prints the handle
bin/pi-quiver.ts             CLI adapter: doc-to-md [flags] <path>; flag parser + --help from the same descriptors;
                             pi-free settings reader mirroring getAgentDir(); paths against process.cwd(); prints the handle
lib/doc-to-md-core.ts        pi-free data plane: option descriptors + resolveOptions(), classifyInput, bundle lock/publish,
                             tier orchestration, staging publish, JSON-contract parsing, link validation, outline scan, handle
lib/unpdf-worker.ts          Node child for the unpdf rung (modes info | pdf-text); same JSON-in/JSON-out contract as Python;
                             bundled into dist/ by esbuild alongside bin/pi-quiver.ts and resolved from the package root
scripts/doc_to_md.py         one Python entry point (replaces scripts/pdf_to_md.py): modes info | pdf-primary | pdf-fallback | xlsx;
                             imports `pymupdf` and `pymupdf4llm` only (never the deprecated `fitz` alias)
```

`convertDocument(path, options, signal?)` and `inspectDocument(path, options, signal?)` take a resolved `DocToMdOptions` and keep the existing `AbortSignal` (tool cancel kills the running tier tree). Input types: `pdf | docx | pptx | xlsx | xls`. Dispatch:

| Input | Convert | Info |
|---|---|---|
| `pdf` | tier `primary` (`pdf-primary`, pymupdf4llm) under `primaryTimeoutMs`; on exit 1 / timeout / bad JSON / stdout cap -> tier `fallback` (`pdf-fallback`, PyMuPDF `get_text("text")` per page + displayed-image extraction) under `fallbackTimeoutMs`; `Backend = none` -> tier `unpdf` (`lib/unpdf-worker.ts pdf-text`) under `primaryTimeoutMs` | Python `info` under `fallbackTimeoutMs`; `Backend = none` -> `unpdf-worker info` |
| `docx`, `pptx` | `soffice --headless --convert-to pdf` under `sofficeTimeoutMs` (existing `convertOffice`: isolated `-env:UserInstallation` profile and its `SAL_USE_VCLPLUGIN=svp`, `OOO_DISABLE_RECOVERY=1`, `SAL_NO_MOUSEGRABS=1` env - unchanged) -> intermediate PDF in the call's temp dir -> the `pdf` column; `pages` syntax validated before soffice, bounds after; intermediate deleted in a `finally` | soffice, then the `pdf` info path |
| `xlsx`, `xls` | `xlsx` mode under `excelTimeoutMs`; no `unpdf` floor; `Backend = none` or a system Python without the Excel packages -> hard error with install remedy | Python `info` under `excelTimeoutMs`: sheet inventory only |

**Isolation rule** (from the librarian reference implementation): some pages send MuPDF into an uninterruptible C-level spin that no signal or thread timeout can break; PDF.js can likewise block the Node event loop. Every tier - Python or Node - is therefore a fresh spawn through `runCapped` (`lib/doc-to-md-core.ts:169`); nothing extracts in the pi process.

**Process-tree termination.** On the `uv` rung the direct child is `uv` and Python is a grandchild; `soffice` forks helpers. `runCapped` changes for all callers: POSIX spawns with `detached: true` and kills with `process.kill(-pid, "SIGKILL")`; Windows kills with `taskkill /T /F /PID <pid>`. A module-level `process.on("exit")` handler best-effort kills every live group so a parent crash does not orphan detached trees. `runCapped` settles within `KILL_GRACE_MS = 2000` after the kill (own timer if `close` never fires); the "no subprocess left running" test probes pids, not settlement. `CappedResult.timedOut` and `CappedResult.capped` both feed the tier's failure reason.

**Child invocation.** Every child (Python or Node) receives its options as one JSON document on **stdin** (argv only carries the mode; Windows caps the command line at ~32K chars) and writes one JSON result to stdout. Children wrap all library calls in stdout redirection (`contextlib.redirect_stdout(sys.stderr)` in Python, as `pdf_to_md.py` already does; xlrd gets `logfile=sys.stderr`) so stdout is the result and nothing else.

**Backend ladder** unchanged in shape (`uv` -> system Python >= 3.12 -> managed venv -> none), with one **absolute discovery deadline**: `warmTimeoutMs` bounds the whole of uv warm-up, probes, venv creation and `pip install` together (a deadline passed down, not a per-stage timeout), so the wall-time formula holds. Package set `pymupdf4llm==1.27.2.3 openpyxl==3.1.5 xlrd==2.0.2 pillow==<pin>` (constants next to `DEFAULT_PYMUPDF_VERSION`; only the pymupdf4llm pin keeps its env/settings override; the pillow pin is the current release at implementation time, recorded in `doc/doc-to-md.md`). `warmArgs` and the venv `pip install` use the full set; the managed venv directory becomes `doc-to-md-venv-v2`, and the legacy `pymupdf-venv` dir is removed after the v2 venv is published. The system-Python probe prints `PY <version> PDF <yes|no> XLSX <yes|no>` where `PDF yes` requires `import pymupdf` and `pymupdf4llm.__version__ >= 1.27.0` (the layout engine + `use_ocr`; older releases are unusable, not degraded) and `XLSX yes` requires `openpyxl`, `xlrd`, and `PIL` importable.

## Options

`DOC_TO_MD_OPTIONS` in `lib/doc-to-md-core.ts` is a plain-TS descriptor table (`{ key, flag, type, default, settable: boolean, help }`) - the single source of truth. The pi adapter maps descriptors to TypeBox properties; the CLI maps them to its flag parser and renders `--help` from `help`; `resolveOptions(perCall, settingsPatch, env)` applies precedence per-call > settings > `PI_DOC_TO_MD_*` env (deprecated) > default. **One validation boundary:** the core exports `coerceDocToMdSettings(raw)`, which drops unknown or ill-typed keys with a `console.warn` naming the key (the same warn-and-ignore policy sibling extensions use); the pi adapter passes it as `resolveConfig`'s `coerce`, the CLI calls it directly; a bad settings key never fails a call. The core stays pi-free (`test/layout.test.ts` guard): the pi adapter reads `quiver.docToMd` via `resolveConfig()`; the CLI reads the same two files - agent dir per `getAgentDir()` semantics (`PI_CODING_AGENT_DIR` with a leading `~` expanded, empty string treated as unset, else `~/.pi/agent`) then `<cwd>/.pi/settings.json`, project over global - with a small pi-free reader in `bin/pi-quiver.ts`, so no `@earendil-works` or `@sinclair/typebox` import reaches the bundle. Relative `path`/`outputDir` resolve against `ctx.cwd` in the tool and `process.cwd()` in the CLI.

Per-call intent (`settable: false`):

| Knob | CLI flag | Default | Semantics |
|---|---|---|---|
| `path` | positional | required | `.pdf .docx .pptx .xlsx .xls` |
| `info` | `--info` | `false` | inspect only; no bundle; `pages`/`outputDir`/`overwrite` rejected alongside it |
| `pages` | `--pages` | all | `"12-15"`, `"3,7,10-12"`; inclusive, 1-based, original numbering; sorted + deduped; on `xlsx`/`xls` rejected in Node: "worksheets have no stable page numbering" |
| `outputDir` | `--output-dir` | unset -> per-call temp dir `<tmp>/pi-quiver-doc-to-md-<random>/` | bundle root: `<stem>.md` + `images/` |
| `overwrite` | `--overwrite` | `false` | replace an existing completed `<stem>.md` bundle |

Tunables (`settable: true`):

| Knob | CLI flag | Default | Env (deprecated) | Scope |
|---|---|---|---|---|
| `primaryTimeoutMs` | `--primary-timeout` | 60000 | `PI_DOC_TO_MD_CONVERT_TIMEOUT_MS` | pymupdf4llm tier; also the unpdf tier |
| `fallbackTimeoutMs` | `--fallback-timeout` | 30000 | - | PyMuPDF `get_text` tier; also `info` on PDF |
| `sofficeTimeoutMs` | `--soffice-timeout` | 120000 | `PI_DOC_TO_MD_SOFFICE_TIMEOUT_MS` | DOCX/PPTX -> PDF |
| `excelTimeoutMs` | `--excel-timeout` | 60000 | - | one Python child doing both openpyxl loads; also `info` on Excel |
| `warmTimeoutMs` | `--warm-timeout` | 120000 | `PI_DOC_TO_MD_WARM_TIMEOUT_MS` | absolute backend discovery/bootstrap deadline (first call per process only) |
| `pymupdfVersion` | `--pymupdf-version` | `1.27.2.3` | `PI_DOC_TO_MD_PYMUPDF_VERSION` | existing pin override (must stay >= 1.27.0) |
| `imageDpi` | `--image-dpi` | 150 | - | pymupdf4llm `dpi`; inline-image render DPI on fallback |
| `imageFormat` | `--image-format` | `png` | - | `png` or `jpg` for rendered images; embedded images keep their native extension |
| `maxCellsPerSheet` | `--max-cells-per-sheet` | 50000 | - | rectangular budget `rows x cols` per sheet |
| `maxOutputBytes` | `--max-output-bytes` | 20000000 | - | child stdout cap (existing `OUTPUT_MAX_BYTES`) |
| `outlineMaxEntries` | `--outline-max-entries` | 40 | - | heading outline cap in the handle |

Worst-case wall time: `warmTimeoutMs (first call) + sofficeTimeoutMs (Office only) + primaryTimeoutMs + fallbackTimeoutMs + KILL_GRACE_MS x kills`; a resolver-level elapsed-time test covers "uv fails, bootstrap follows" staying under `warmTimeoutMs + KILL_GRACE_MS`. No cap on image count, image bytes, or workbook load memory - deliberately: the per-tier timeouts and `maxOutputBytes` are the bounds; README and `doc/doc-to-md.md` state this and the formula.

`pi-quiver doc-to-md --help` renders both tables. CLI exit codes: `0` success; `2` usage (unknown flag, bad `--pages` syntax, bad flag value, `--info` with a bundle option); `1` every runtime error. `skills/doc-to-md/SKILL.md` shrinks to five examples (`--info`; whole doc; `--pages 12-15 --output-dir ./out`; an `.xlsx`; a stubborn PDF with `--primary-timeout 180000`), the handle shape, "then `read` the `Saved-To` file", and a pointer to `--help`.

## Bundle and handle

**Filenames.** `stem` = input basename without extension, sanitized to `[A-Za-z0-9._-]` (other characters -> `_`, runs collapsed; empty -> `document`). PDF images: `images/<stem>-p<page>-<n>.<ext>`; Excel images: `images/<stem>-s<sheetIndex>-<n>.<ext>` (1-based sheet index, so distinct sheet names can never collide; the sheet's name is in the `## <sheet>` heading the image sits under). Owned-file pattern for a stem: `^<stem>-(p|s)\d+-\d+\.[a-z0-9]+$` - exact, so `manual` never matches `manual-v2-p1-1.png`.

**Lock and publish.** A call owns a stem for its whole duration:

1. `mkdir -p` the bundle root (not writable -> error). `open(<stem>.md.lock, "wx")`; `EEXIST` -> error `Another conversion owns <stem>.md (lock: <path>); if no conversion is running, delete the lock`. `overwrite` never removes a lock.
2. Holding the lock: if `<stem>.md` exists and `!overwrite` -> error `Output exists: <path> (pass overwrite)`. With `overwrite`, delete `<stem>.md` and exactly the files it links under `images/` plus any file matching the owned pattern.
3. Every file this call writes under `images/` is recorded in an in-memory manifest. Staging lives in `images/.stage-<lockId>/` (see Image pipeline).
4. On success: write `<stem>.md.tmp`, `rename` to `<stem>.md` (atomic publish), remove the staging dir, release the lock. On any failure or abort: delete the manifest's files and the staging dir, release the lock. The lock release is in a `finally`; a crashed process leaves a lock whose error message tells the user what to do.

Two concurrent same-stem calls, with or without `overwrite`, therefore serialize on the lock: the second fails fast. Nothing outside `<stem>.md`, `<stem>.md.lock`, `<stem>.md.tmp`, `images/.stage-*` and owned-pattern files is ever touched.

**Handle** (the entire tool/CLI result; identical text in both; bounded):

```
Saved-To: /abs/out/manual.md
Images-Dir: /abs/out/images                 (only when at least one image was written)
Type: pdf   Engine: pymupdf4llm   Tier: primary
Page-Count: 42   Pages: 3-5   Images: 4   Size: 18.2 KB / 412 lines
Degraded: PyMuPDF text extraction - layout/tables not preserved       (fallback + unpdf tiers)
Fallback-Reason: primary timeout after 60000ms                          (fallback tier)
Failed-Pages: 4, 9-12 (+3 more)    Empty-Pages: 4                       (only when non-empty; compact ranges, <= 20 entries)
Notes: No images: unpdf backend                                         (<= 5 lines, each <= 200 chars)
Outline:
  L1   # Installation
  L88  ## Wiring
  (+N more)                                                             (when capped by outlineMaxEntries)
```

Enumerations: `Type` = original input type (`pdf|docx|pptx|xlsx|xls`, DOCX stays `docx` after the PDF hop); `Tier` = `primary|fallback|unpdf|excel`; `Engine` = `pymupdf4llm|pymupdf-text|unpdf|openpyxl|xlrd`. Outline titles are truncated to 80 chars with `...`; `Outline` comes from a Node scan of the written `<stem>.md` for ATX headings (`^#{1,6} `) outside fenced code blocks, so it is tier-agnostic (Excel bundles list `## Sheets` and each `## <sheet>`). Full, uncapped diagnostics (every failed/empty page, every note) live at the top of `<stem>.md`. `Pages` renders compactly (`3-5`, `3,7,10-12`, `all`). `DocToMdDetails` carries the same fields typed (`path, inputType, engine, backend, pymupdfVersion, tier, degraded, fallbackReason, pageCount, pages, imageCount, bytes, lines, failedPages, emptyPages, notes, outline, file, outputDir`); `renderResult` prints the handle text.

**Info handle:**

```
Type: pdf   Page-Count: 42   Backend: uv
Title: Installation Manual   Author: ...        (present metadata keys only, values <= 120 chars)
TOC:
  L1 Installation (p3)
  L2 Wiring (p12)
  (+N more)                                     (capped by outlineMaxEntries)
```

Excel info: `Type: xlsx   Sheets: 3` then one line per sheet `Data  rows=120 cols=9`, `Hidden  hidden rows=? cols=?` - dimensions come from a full (non-read-only) openpyxl load or xlrd with `formatting_info=True`, `?` when a dimension is unknown. DOCX/PPTX info reports `Page-Count` from the intermediate PDF.

## Image pipeline (PDF)

Node owns the staging directory `images/.stage-<lockId>/` and passes it to every PDF tier as `stagingDir`. A tier writes page `N`'s images into `stagingDir/p<N>/` and, after finishing that page's text and images, touches `stagingDir/p<N>/.done`. Nothing in a child's output depends on the child surviving:

- **Publish (Node, after the tier ends - success, failure, or kill).** For every `p<N>/` with `.done`, move its files to `images/<stem>-p<N>-<n>.<ext>` (n = 1.. in filename order, ext = the staged file's extension) and record them in the manifest; directories without `.done` are discarded (partial page). On success the child's markdown references `p<N>/<file>` and Node rewrites each reference to its published `images/<file>` name via an exact source->destination map (never a prefix substitution).
- **Handover to the fallback.** Pages published from a dead primary are passed to `pdf-fallback` as `keepPages: [N, ...]` with their published filenames; the fallback skips image extraction for those pages and appends `![](images/<file>)` for each kept file under the page - even when that page's text extraction fails (kept links never depend on text success).
- **Validation.** Node checks every image reference in the final Markdown: it must be `images/<file>` where `<file>` is in the manifest; anything else fails the call.

`pdf-primary` runs `pymupdf4llm.to_markdown(doc, pages=[i], write_images=True, image_path=<space-free temp dir>, image_format=imageFormat, dpi=imageDpi, use_ocr=False, page_separators=False)` **once per selected page** on a single opened `pymupdf.Document`, inside a per-page `try/except`; the page's images are then moved from the temp dir into `stagingDir/p<N>/` and every emitted reference rewritten to `p<N>/<file>` (pymupdf4llm's `md_path()` mangles an `image_path` containing spaces or parentheses - verified against the pin: `/tmp/sp ace (x)/p3` fails with `cannot open file 'sp_ace_-x-/p3/...'` - so a user-chosen bundle root can never be passed directly). Per-page calls give three things at once: page attribution by directory (no dependence on pymupdf4llm's filename scheme, which ignores `filename=` when a document is passed), a `.done` marker per page, and per-page failure reporting on the primary tier too (a failing page -> empty body + `failedPages` entry; all pages failing -> exit 1). The child appends the canonical separator itself after each page.

`pdf-fallback` uses `page.get_text("text")` for text and `page.get_image_info(xrefs=True)` for **displayed** images (not `get_images()`, which enumerates resource-dictionary entries that may belong to other pages): `xref > 0` -> `doc.extract_image(xref)` written with its native extension; `xref == 0` (inline image) -> `page.get_pixmap(clip=bbox, dpi=imageDpi)` written as `imageFormat`. Same per-page `try/except`, `.done` marker, separator.

## Python contract (`scripts/doc_to_md.py`)

Invocation: `doc_to_md.py <mode>`, options JSON on stdin; `mode in {info, pdf-primary, pdf-fallback, xlsx}`. Options: `path`, `pages` (1-based list or null; never non-null for `xlsx`), `stagingDir`, `keepPages` (`{ "3": ["manual-p3-1.png"] }`), `imageDpi`, `imageFormat`, `maxCellsPerSheet`.

Result JSON (exit 0), PDF convert modes:

```json
{ "markdown": "...", "pages": [3, 4, 5], "pageCount": 42, "emptyPages": [4],
  "failedPages": [{ "page": 4, "error": "RuntimeError: ..." }], "notes": ["..."] }
```

(images are discovered by Node from staging, not reported). `xlsx` mode returns `{ "markdown", "images": [{ "sheetIndex": 1, "file": "book-s1-1.png" }], "notes" }` after writing images straight to `stagingDir/` (Node publishes them the same way, all-or-nothing since Excel has no fallback). `info`: `{ "pageCount", "metadata": {...}, "toc": [[level, title, page], ...] }` for PDF; `{ "sheets": [{ "name", "index", "hidden", "rows", "cols", "hiddenRows", "hiddenCols" }] }` for Excel (`null` for unknown).

Exit codes: `0` success; `3` user error, JSON `{ "error": "...", "pageCount": N }` on stdout, Node surfaces it verbatim and **does not fall back** - bad page bounds, and `pymupdf.open(path).needs_pass` (`Password-protected PDF`) checked before any extraction in `info` and `pdf-primary`; `1` conversion failure (traceback on stderr) -> next tier; tree-kill on timeout -> next tier; invalid or truncated JSON -> treated as exit 1. Python `warnings` (openpyxl image drops, MuPDF errors) are captured and appended to `notes`.

`xlsx` mode: `.xlsx` via openpyxl, two loads in one process: `load_workbook(data_only=False)` for formulas, `merged_cells.ranges`, `row_dimensions[].hidden`, `column_dimensions` (expanding each dimension's `min..max` range), `sheet_state`, `ws._images` (requires Pillow - in the package set and probed; the attribute is private, acceptable because the version is pinned; images are written with their native format via `img.format`); `load_workbook(data_only=True)` for cached values. `.xls` via `xlrd.open_workbook(path, formatting_info=True, logfile=sys.stderr)`; values only, header line `Formulas: unavailable (.xls via xlrd); Images: unavailable`. Output:

- `## Sheets` inventory: one line per sheet - index, name, `hidden` when applicable, `rows x cols`, `truncated` when applicable.
- one `## <sheet>` per worksheet, then the disclosure lines that apply (`Hidden sheet`, `Merged: A1:C1, ...`, `Hidden rows: 3,4`, `Hidden cols: F`, `Truncated: showing rows 1-R of M, cols A-C of N`), then a pipe table: header row of column letters, first column of row numbers.
- cell rendering: cached value as text; `value (=FORMULA)` when a formula exists; `(no cached result) (=FORMULA)` when the cached value is `None`; merged-range continuation cells empty; dates ISO-8601, booleans `TRUE`/`FALSE`, floats `repr`, error values as stored (`#DIV/0!`); `|` -> `\|`, `\` -> `\\`, newlines -> `<br>`.
- budget: `rows x cols` of the used range against `maxCellsPerSheet`; truncate rows first (R = floor(budget / cols)), then columns if a single row exceeds the budget.

## unpdf worker (`lib/unpdf-worker.ts`)

Same contract as the Python script (mode on argv, JSON on stdin/stdout, exit 0/1/3), spawned through `runCapped` under `primaryTimeoutMs`. `pdf-text`: `getDocumentProxy` -> `numPages` (bounds -> exit 3; `getMetadata()` for info) -> for **each selected page only** `pdf.getPage(n)` + `getTextContent()` (unselected pages are never requested, so a toxic unselected page cannot burn the budget) inside a per-page `try/catch` (-> `failedPages`), canonical separator after each. No images; `notes: ["No images: unpdf backend"]`; the handle shows `Degraded: unpdf text extraction - structure not preserved`.

## Data flow

1. **Resolve** options; classify by extension; validate `pages` syntax; reject `pages` on Excel and any bundle option with `info`.
2. **Info** -> resolve backend, run the info column, print the info handle. No bundle.
3. **Lock** the stem per Lock and publish; create the staging dir.
4. **Convert** per the dispatch table; after each PDF tier ends, run Publish; on a primary failure hand `keepPages` to the fallback. Failure reasons: `timeout after Nms`, `exit N`, `invalid-json`, `output exceeded maxOutputBytes` - a capped primary **does** fall back (a simpler text result may fit); a capped fallback, Excel, or info result is a hard error.
5. **Emit**: Node assembles `<stem>.md` (`Degraded`/`Fallback-Reason` lines, full `Failed pages:`/`Empty pages:`/`Notes:` lines, blank line, body), rewrites and validates image links, publishes atomically, scans the outline, prints the handle.

## Error handling

| Condition | Outcome |
|---|---|
| bad `pages` syntax / `info` with bundle options | error before conversion (CLI exit 2) |
| out-of-range pages / `pages` on Excel / password-protected PDF | actionable error (page count / remedy), no fallback (CLI exit 1) |
| bundle root not writable / lock held / `<stem>.md` exists without `overwrite` | error before conversion |
| primary exit 1 / timeout / bad JSON / stdout cap | fallback tier with `keepPages`; `Degraded` + `Fallback-Reason` |
| fallback exit 1 / timeout / stdout cap | hard error `Conversion failed: primary <reason>; fallback <reason>`; `unpdf` not tried when a Python backend exists; manifest + staging cleaned, lock released |
| individual page failure (any tier) | empty body + separator, `Failed-Pages`, kept images still linked, remaining pages emitted |
| no Python backend, PDF | `unpdf` worker: separators, `Notes: No images`, `Degraded` |
| unpdf worker timeout | hard error (no further tier), tree killed |
| no Python backend or `XLSX no`, Excel (convert or info) | hard error `Remedy: install uv, or pip install openpyxl xlrd pillow` |
| Excel timeout / stdout cap | hard error `Remedy: raise excelTimeoutMs or lower maxCellsPerSheet` |
| corrupt / password-protected workbook | exit 1 -> hard error |
| soffice missing / timeout | existing error / hard error, intermediate cleaned up |
| tool cancel (`AbortSignal`) | running tree killed, cleanup, lock released, error surfaced |

## Testing

Fixtures are real synthetic documents, generated once by `test/fixtures/generate.py` (`pymupdf`, openpyxl, xlwt, python-docx, python-pptx; run via `uv run --with`) and committed:

- `multipage.pdf` - 6 pages: H1/H2 headings, a paragraph per page containing `PAGE-<n>`, a 3x3 table on page 2, embedded raster images on pages 3 and 5, an inline image on page 5, page 4 blank, a TOC with two entries, title metadata.
- `shared-resources.pdf` - 2 pages sharing one image XObject in their resource dictionaries; only page 1 draws it.
- `multipage.docx` - 5 pages separated by explicit page breaks, `PAGE-<n>` tokens, one image on page 2; `multislide.pptx` - 4 slides with `SLIDE-<n>` tokens and one picture.
- `workbook.xlsx` - sheets `Data` (numbers, `=SUM(...)`, `=D17*2`, a `|`-containing string, a date, a boolean, merged `A1:C1`, hidden row 4, hidden column F, one embedded PNG), `Settings` (key/value incl. `D17`), `A B` and `A_B` (each with one image; proves index-based image names), `Hidden` (hidden sheet). openpyxl cannot write or preserve cached formula results, so the generator writes all formulas, round-trips through `soffice --headless --convert-to xlsx`, then removes the `<v>` element of one formula cell by patching `xl/worksheets/sheetN.xml` inside the zip.
- `legacy.xls` - one sheet via xlwt with a merged range, a hidden row and column.
- `test/fixtures/fake-tier.mjs` - a scripted child for orchestration tests (sleep, write staged images + `.done`, exit N, emit bad JSON, spawn a grandchild).

One result shape means every test asserts the same two things: the handle (parsed by a `parseHandle()` helper) and the bundle on disk (`readFile(Saved-To)`, `stat` each image link). Suites and their gates:

`test/doc_to_md.test.ts` (CI, no external tools): `resolveOptions` precedence, `coerceDocToMdSettings` warn-and-drop; CLI agent-dir resolution (tilde, empty env); `--help` lists every descriptor and every flag round-trips; `pages` parsing; stem sanitization; lock: held lock fails fast (with and without `overwrite`), `overwrite` deletes exactly linked + owned-pattern files (a `manual-v2-p1-1.png` and a foreign file survive), failure cleanup removes only manifest files, lock released in `finally`, atomic publish (no partial `<stem>.md` on failure); temp-dir `Saved-To`; outline scan (fences ignored, 80-char truncation, cap + `+N more`), handle caps (Failed-Pages ranges + `+N more`, Notes <= 5); orchestration through `PipelineSeams` (`backend`, `runTier(mode, opts, timeoutMs, signal)`) with `fake-tier.mjs`: timeout -> fallback with `keepPages` from `.done` pages only (partial page discarded), exit 3 -> no fallback, capped primary -> fallback with reason, capped fallback -> hard error, fallback timeout -> hard error + cleanup, abort -> cleanup; `runCapped` tree-kill: child + grandchild both gone (`process.kill(pid, 0)` -> `ESRCH`; Windows `tasklist`), settle within `timeout + KILL_GRACE_MS`; stdin options > 40K chars accepted; resolver elapsed-time bound with a failing fake `uv` and a fake bootstrap; unpdf worker on `multipage.pdf` `pages: "2,5"` (separators 2 and 5 only, `PAGE-3` absent, `Notes: No images`), `info` -> `Page-Count: 6`, out-of-range -> exit 3 text, a stalled fake page-2 never requested when `pages: "1"`, bundle moved to another dir -> every link still resolves.

`test/doc-to-md-cli.test.ts` (existing, rewritten): handle on stdout for a flagless call, `--info`, each flag, exit 2 on bad `--pages` / unknown flag / `--info --pages`, exit 1 on collision.

`test/doc_to_md.python.test.ts` (skipped unless `uv` on PATH; DOCX/PPTX cases additionally skipped unless `soffice` is found by the existing spawn probe; `.github/workflows/test.yml` adds `astral-sh/setup-uv` on both runners and `apt-get install libreoffice-writer libreoffice-impress libreoffice-calc` on ubuntu): `--info` on `multipage.pdf` -> `Page-Count: 6`, title, TOC; primary `--pages 3-5` -> separators 3, 4, 5 in order, `images/multipage-p3-*` and `-p5-*` (embedded + inline) exist, no `-p2-`, `Empty-Pages: 4`, every link resolves; whole document -> six separators, `Pages: all`; forced fallback (`primaryTimeoutMs: 1`) -> `Degraded`, `Fallback-Reason: primary timeout after 1ms`, images extracted, separators intact; `shared-resources.pdf --pages 2` on the fallback tier -> no image; encrypted PDF (generated with a password) -> exit-3 text; `multipage.docx --info` -> `Page-Count: 5`, `--pages 2` -> `PAGE-2` only + its image, `--pages 9` -> bounds error; `multislide.pptx --pages 3` -> `SLIDE-3` only; `workbook.xlsx` -> `## Sheets`, `## Data` matrix, `Settings!D17`, `value (=...)`, `(no cached result)`, `\|`, `Merged: A1:C1`, `Hidden rows: 4`, `Hidden cols: F`, hidden sheet marked, `book-s1-1.png` and distinct `-s3-`/`-s4-` images for `A B`/`A_B`; `workbook.xlsx --info` -> `Sheets: 5` with dims and hidden counts; `legacy.xls` -> unavailable note plus merged and hidden disclosures; `maxCellsPerSheet` truncation line; Excel stall (`excelTimeoutMs: 1`) -> remedy error, no live pid; `--pages` on `.xlsx` -> error text.

`test/packed-install.test.ts` adds `pi-quiver doc-to-md --pages 1 --output-dir <tmp> multipage.pdf` asserting `Saved-To` (exercises the bundled unpdf worker resolution), and asserts `dist/bin/pi-quiver.js` contains neither `@earendil-works` nor `@sinclair/typebox`.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs:
  - `README.md` - doc_to_md tool-table blurb and the "explicitly excludes spreadsheets" line replaced; handle contract ("result is a handle, `read` the file"), info mode, `quiver.docToMd` settings table, `pages`/`outputDir`/`overwrite`, bundle layout + lock file, page separators, tier ladder, wall-time formula, caller-owned temp bundles, deliberate absence of image/memory caps, Excel support + install remedy (operations / tunables, communication contract)
  - `doc/doc-to-md.md` - backend ladder gains the `pymupdf-text` tier, the unpdf worker, the openpyxl/xlrd/pillow pins + `>= 1.27.0` gate, venv dir rename + legacy removal, probe line, stdin/stdout JSON contract + modes + exit code 3, staging/publish protocol, CLI exit-code table, env vars marked deprecated, size-gate section replaced by the handle/bundle contract, "spreadsheets out of scope" removed, licensing note extended, manual-smoke checklist gains info/pages/images/Excel rows (communication contract, architecture)
  - `skills/doc-to-md/SKILL.md` - five examples, handle shape, "then `read`", `--help` pointer (communication contract; Claude Code has no settings.json so flags are the only surface)
  - `.github/workflows/test.yml` - `setup-uv` on both runners, LibreOffice on ubuntu
  - `CHANGELOG.md` - deferred: release
- Derived / memory docs invalidated:
  - `AGENTS.md` - intro sentence ("context-safe" now means handle-only), Layout (`scripts/pdf_to_md.py` -> `scripts/doc_to_md.py`, `lib/unpdf-worker.ts`, `test/fixtures/generate.py` + `fake-tier.mjs`, `test/doc_to_md.python.test.ts`), "`doc_to_md` engines" paragraph (every tier a child, tree-kill rationale, staging/`.done` protocol, package set, capability probe, pi-free option resolution split, `pymupdf` not `fitz`)
  - `doc/specs/2026-06-15-doc-to-md-converter.md` and `doc/specs/2026-08-26-doc-to-md-python-backend-cli-skill.md` - supersession banners (scopes in the header above)
  - `package.json` `files` / `build` - `scripts/pdf_to_md.py` -> `scripts/doc_to_md.py`; esbuild adds the `lib/unpdf-worker.ts` entry

## Open questions

None blocking.
