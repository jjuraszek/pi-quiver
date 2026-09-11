# doc_to_md: Excel output v2 - sheet inventory, per-sheet CSV, rendered visuals

Ticket: [jjuraszek/pi-quiver#17](https://github.com/jjuraszek/pi-quiver/issues/17) (discovery ticket; this spec widens it to an implementation - see [Deviation from the ticket](#deviation-from-the-ticket))
Supersedes: `doc/specs/2026-09-09-gh-13-selective-image-linked-excel-conversion.md` - the "chart rendering" non-goal, the `maxCellsPerSheet` option row, and the Excel part of its Python/bundle contract (matrix budget, bundle layout, 1-based worksheet-only indices). The rest of #13 (PDF tiers, DOCX/PPTX, handle shape, lock/staging protocol) stays live.

**Goal:** make `doc_to_md`'s Excel output complete and LLM-safe: every sheet (worksheets and chartsheets) is listed in workbook order, every worksheet's full content is exported as CSV in the bundle, the Markdown carries only a fixed-size preview, and sheets that carry visuals (charts, images) get a rendered PNG when LibreOffice is available - without adding any mandatory software, and without a LibreOffice failure ever failing the conversion.

## Problem

Today (`scripts/doc_to_md.py:195-267`, `mode_xlsx`):

- Only `wb.worksheets` are iterated. Chartsheets are invisible in both conversion and `info` - the #17 fixture (`Data` + chartsheet `Trends`) reports one sheet.
- Charts embedded in worksheets (`ws._charts`) are never mentioned; only raster `ws._images` are extracted.
- The matrix is the only carrier of cell content and is bounded by a user knob (`maxCellsPerSheet`, default 50000). A large sheet is silently cut with no full-content escape hatch.

## Discovery findings (verified locally, 2026-09-10)

Environment: macOS 15, LibreOffice 26.2.4.2 (`0229ac93fcf0d7cbc6376066c6f35021cef002dc`), openpyxl 3.1.5, PyMuPDF 1.27.2, `uv`. Retained artifacts: scratch dir `/tmp/gh17.45V1X0` (local, not committed); the committed reproduction is the `charts.xlsx` fixture plus its generator (see [Testing](#testing)). This section is the go/no-go record #17 asks for; the issue gets a comment pointing here.

Reproduction protocol:

```bash
# 1. openpyxl chartsheet fixture (the #17 generator), then inspect the anchor
unzip -p chartsheet-repro.xlsx xl/drawings/drawing1.xml | grep -o '<xdr:ext[^/]*/>'   # -> <xdr:ext cx="0" cy="0"/>

# 2. one PDF page per sheet
soffice --headless --invisible --nocrashreport --nodefault --nofirststartwizard --nolockcheck --nologo --norestore \
  "-env:UserInstallation=file://$PROFILE" \
  --convert-to 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}' --outdir "$OUT" book.xlsx

# 3. page-count, geometry, and content check (PyMuPDF)
python -c 'import pymupdf,sys; d=pymupdf.open(sys.argv[1]); print(d.page_count)
for p in d: print(p.number, p.rect, len(p.get_drawings()), len(p.get_images()))' "$OUT/book.pdf"

# 4. fixture repair: patch the zero extent in every xl/drawings/drawing*.xml (zip-level, no soffice round-trip)
#    <xdr:ext cx="0" cy="0"/>  ->  <xdr:ext cx="9144000" cy="6858000"/>
```

| Finding | Evidence |
|---|---|
| The "blank chartsheet page" in #17 is a fixture defect, not a LibreOffice limitation | openpyxl writes the chartsheet drawing as `<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="0" cy="0"/>`; Calc honors the zero extent and emits a degenerate ~47 x 14 pt page (47 drawing ops, all inside a point). After step 4 above, page 2 renders the full chart: title `Synthetic trends`, axes `Step`/`Value`, `North=[2,4,6]`, `South=[5,3,1]` (visually confirmed at 100 dpi). Excel-authored files carry a real extent. |
| Embedded worksheet charts render without any patch | `ws.add_chart` writes a real `oneCellAnchor` extent |
| Charts are vector ops in the PDF | `page.get_images()` = 0; rasterize with `page.get_pixmap()` |
| Deterministic tab -> page mapping | `SinglePageSheets=true` yields exactly one PDF page per sheet in workbook order, including empty, hidden, and chart sheets (two 4-sheet workbooks tested; without the option a 200-row sheet spans 5 pages). Page `i` == `wb._sheets[i]` (0-based). |
| Page geometry is content-sized | With `SinglePageSheets` the page grows with the sheet: a 2000 x 30 sheet exported as 1926 x 30000 pt (~4013 x 62500 px at 150 dpi, ~750 MB raw). An empty sheet exports as a ~1 x 1 pt page. Rasterization needs a pixel budget and a degenerate-page guard. |
| Hidden sheets are exported anyway | `state="hidden"` does not suppress a sheet from the PDF; no per-sheet isolation trick exists, and none is needed |
| LO's own xlsx export drops chartsheet drawings | `soffice --convert-to xlsx` round-trip -> 0 drawing ops. The fixture generator must not round-trip chartsheet workbooks through soffice (today `generate.py` does so for formula caches) |
| openpyxl reads the chart model | `wb.chartsheets`, `cs._charts` / `ws._charts` -> chart objects with `.title`, `.series[].tx.strRef.f`, `.series[].val.numRef.f`; private API, same tier as the `_images` use shipped in #13. Chartsheets have no `max_row`/`max_column`. An empty worksheet reports `max_row == max_column == 1` (`A1:A1`), so raw dimensions cannot express "empty". |
| `.xls` has no visual path | xlrd exposes no charts/images; LO xls->xlsx re-export loses chartsheets |

Options considered and rejected: matplotlib re-plot (new Python package - violates the no-new-software constraint, and a chart-subset renderer is a maintenance sink); PyMuPDF Pro / Aspose / Spire (commercial); direct OOXML XML parsing instead of openpyxl (more code for the same model).

**Go decision:** render through the already-optional `soffice`, one page per sheet, rasterize with the already-installed PyMuPDF; openpyxl supplies identity and chart metadata so the output degrades gracefully without soffice. Portability gate: the evidence above is one macOS LibreOffice version. Ubuntu CI (`.github/workflows/test.yml` installs `libreoffice-calc` from apt, unpinned) is the second platform and the release bar - the soffice-gated tests in [Testing](#testing) must pass there. Windows CI has no soffice and only exercises the degraded path. Any LibreOffice that ignores the filter or paginates differently hits the `page-count mismatch` row in [Failure handling](#failure-handling) and degrades without failing.

## Deviation from the ticket

#17 authorizes discovery only and excludes embedded charts, chartsheet-only books, `.xls`, and universal chart support. The user widened scope during brainstorming: the discovery evidence is complete, and the same mechanism (one page per sheet) covers embedded charts for free. This spec therefore ships the implementation and restructures the whole Excel output. Two breaking changes ride along (major release): `maxCellsPerSheet` is removed, and sheet indices become 0-based workbook-order positions (renaming embedded-image files `<stem>-s1-1.png` -> `<stem>-s0-1.png` and redefining `SheetInfo.index`).

## Design

### Identity

`idx` is the 0-based position of a sheet in `wb._sheets` (workbook order; worksheets and chartsheets interleaved). It is the single identity used by the preamble, image filenames, CSV filenames, `SheetInfo.index`, render markers, and PDF page mapping (`doc[idx]`). `.xls` uses xlrd's sheet index, which is the same order.

`slug(name)` = `name` lowercased, every run of characters outside `[a-z0-9]` collapsed to `-`, leading/trailing `-` stripped, cut to 40 chars; empty result -> `sheet`. Uniqueness comes from `idx`, not the slug.

Worksheet extent = bounding box of cells whose value is not `None`, computed in the single data pass (below). No such cell -> the sheet is **empty** (`0 x 0`). This replaces `ws.max_row x ws.max_column`, which reports `1 x 1` for a pristine sheet and may include formatted-but-empty cells. Chartsheets are branched on `isinstance(sheet, Chartsheet)` before any dimension access.

### Bundle layout

For a workbook `<stem>.xlsx`:

```
<stem>.md
images/<stem>-s<idx>.<fmt>            rendered view of sheet idx (only sheets with visuals, only when rendering succeeded)
images/<stem>-s<idx>-<n>.<ext>        raster images embedded in worksheet idx (n is 1-based, as in #13)
sheets/<stem>-s<idx>-<slug>.csv       full content of worksheet idx (every non-empty worksheet)
```

`lib/doc-to-md-bundle.ts` changes:

- `Bundle` gains `sheetsDir: join(root, "sheets")`, `sheetsStagingDir: join(sheetsDir, ".stage-<lockId>")`, and `csvManifest: Set<string>`. `manifest` stays image-only, so `imageCount: b.manifest.size` is unchanged.
- `ownedPattern(stem)` becomes `^<stem>-(p|s)\d+(-\d+)?\.[a-z0-9]+$` (covers `p<N>-<n>`, `s<idx>-<n>`, and the new `s<idx>`); a sibling `ownedCsvPattern(stem)` = `^<stem>-s\d+-[a-z0-9-]+\.csv$`. Overwrite cleanup removes matches in both `images/` and `sheets/`; other stems' files are untouched.
- `publishSheetImages(b)` also matches `^s\d+\.[a-z0-9]+$` (rendered views) and publishes them the same way (rename to `images/<stem>-<file>`, `manifest.add`, `sourceMap.set`).
- New `publishSheetCsvs(b)`: moves `sheetsStagingDir/s<idx>-<slug>.csv` -> `sheets/<stem>-s<idx>-<slug>.csv`, `csvManifest.add`, `sourceMap.set("sheets/s<idx>-<slug>.csv", "sheets/<stem>-s<idx>-<slug>.csv")`. Creates `sheets/` lazily (no dir for workbooks with no non-empty worksheet).
- `rewriteImageLinks` is generalized to `rewriteLinks`: the existing image regex plus a plain-link regex `\[[^\]]*\]\(\s*(sheets/[^)\s]+)\s*\)`; both resolve through `sourceMap`.
- `validateImageLinks` additionally checks every `sheets/...` link target against `csvManifest`.
- `commitBundle` also removes `sheetsStagingDir`; `abortBundle` also unlinks `csvManifest` entries from `sheetsDir` and removes `sheetsStagingDir`.

### Output contract (Markdown)

Python emits the final Markdown; TS only resolves links and render markers. Every cell/name interpolated into a table or link passes through the existing `esc()` (escapes `|`, collapses newlines) - sheet names included.

```markdown
# <stem>

## Sheets
| # | name | kind | size | hidden | charts | images | rendered | data |
|---|---|---|---|---|---|---|---|---|
| 0 | Data | worksheet | 200 x 3 | no | 1 | 1 | <!--rvs:0--> | [sheets/s0-data.csv](sheets/s0-data.csv) |
| 1 | Empty | worksheet | 0 x 0 | no | 0 | 0 | - | - |
| 2 | Aux | worksheet | 10 x 2 | yes | 0 | 0 | - | [sheets/s2-aux.csv](sheets/s2-aux.csv) |
| 3 | Trends | chartsheet | - | no | 1 | 0 | <!--rvs:3--> | - |

## Data
Data: [sheets/s0-data.csv](sheets/s0-data.csv) - 200 rows x 3 cols, 12 formulas
Charts:
- LineChart "Synthetic trends" - 2 series ('Data'!$B$2:$B$4, 'Data'!$C$2:$C$4)
Images:
- ![Data image 1](s0-1.png)
<!--rv:0-->

Preview (rows 1-100 of 200, cols A-C of 3) - full data in the CSV above:
| | A | B | C |
|---|---|---|---|
| 1 | Step | North | South |
| 2 | 1 | 2 | 5 |
...

Columns:
| col | header | type | non-empty | min | max | distinct |
|---|---|---|---|---|---|---|
| A | Step | int | 200 | 1 | 200 | 200 |
| B | North | float | 200 | 0.5 | 9.7 | >50 |
| C | Region | str | 200 | - | - | 4 |

## Trends (chartsheet)
Charts:
- LineChart "Synthetic trends" - 2 series ('Data'!$B$2:$B$4, 'Data'!$C$2:$C$4)
<!--rv:3-->
```

Rules:

- `## Sheets` lists every sheet in `wb._sheets` order. Chartsheets: `size` and `data` are `-`. `rendered` is `<!--rvs:<idx>-->` for sheets in `renderPages`, else `-`; TS resolves the marker to `yes` or `no`.
- One `## <name>` section per sheet, `(chartsheet)` suffix for chartsheets. A chartsheet section contains only `Charts:` and the render marker.
- `Data:` line: `Data: [<csv>](<csv>) - R rows x C cols, F formulas` (`F` omitted with its comma when 0); `Data: none` for an empty worksheet.
- `Charts:` lists every object in `_charts` as `<type> "<title>" - <n> series (<refs>)`. `type` = `chart.__class__.__name__`; `title` = the concatenated `t` runs of `chart.title.tx.rich`, or `chart.title.tx.strRef.f` when the title is a reference, or `untitled`; `refs` = each `series.val.numRef.f` that exists, comma-separated, at most 5 then `...`; a series without `val.numRef` is counted but contributes no ref. Section omitted when there are no charts.
- `Images:` lists raster `_images` exactly as #13 does, staged as `s<idx>-<n>.<ext>` and resolved by `sourceMap` (only the index base changes). Section omitted when there are none.
- The render marker `<!--rv:<idx>-->` is emitted, alone on its line, for every sheet with `charts + images > 0`. TS replaces it (see [Reconciliation](#reconciliation)). Sheets without visuals get no marker.
- Preview = the top-left `min(R,100) x min(C,50)` window of the extent, with the existing leading row-number gutter and `A..` column header. Header line: `Preview (rows 1-r of R, cols A-X of C) - full data in the CSV above:` when truncated on either axis, else `Content (R rows x C cols):`. Cell rule is **unchanged from #13**: plain cells show the value; formula cells show `<cached> (<formula>)` or `(no cached result) (<formula>)`; merged-range continuation cells are blank. 50 columns, not the 100 first floated: 100 mostly-empty columns of `|` is noise for an LLM and the CSV carries the rest.
- `Columns:` profile appears **only when the preview is truncated on either axis** and covers every column of the extent. `header` = row-1 string of that column (`esc`), `-` when row 1 is empty/non-string. `type` = majority class over non-empty cells among `int|float|str|date|bool`, where a formula cell contributes its cached value's class and `formula` when uncached; `mixed` when the top class is below 60%. `min`/`max` for `int|float|date` only, else `-`; dates ISO 8601. `distinct` exact up to 50, then `>50` (accumulator capped at 51 entries). `non-empty` counts non-`None` cells.
- Hidden rows/columns and merged-range disclosure lines stay as shipped in #13.
- Empty worksheet: preamble `0 x 0`, section body `Data: none`, no CSV, no preview, no profile.

### CSV contract

- One file per non-empty worksheet, staged at `sheetsStagingDir/s<idx>-<slug>.csv`, `utf-8` without BOM, `csv.writer` defaults (RFC 4180 quoting), `\r\n` line endings (csv module default).
- Rows x cols = the extent. Cell rule: cached value when present, else the formula string (e.g. `=SUM(A2:A20)`); `None` -> empty field; `datetime`/`date` -> `isoformat()`; `bool` -> `TRUE`/`FALSE`; everything else `str()`. No header injection - sheet row 1 is CSV row 1. This is deliberately different from the preview's dual display: the CSV is a machine-readable carrier, the preview a human/LLM one.
- `.xls`: same rules over xlrd values (`XL_CELL_DATE` -> `xldate_as_datetime(...).isoformat()`, `XL_CELL_BOOLEAN` -> `TRUE`/`FALSE`, `XL_CELL_ERROR` -> xlrd's error text, e.g. `#DIV/0!`, matching the preview); xlrd has no formulas so the formula fallback never applies.

### Data pass and cost

`mode_xlsx` keeps the two full loads (`data_only=False` and `data_only=True`; `read_only=True` is not used because it drops `_images`, `_charts`, and merged ranges). Per worksheet, a **single pass** over `ws.iter_rows()` zipped with the values workbook does all of: extent bounding box, CSV rows (buffered as lists then written once the extent is known, so trailing empty rows/cols are dropped), preview rows 1-100 x cols 1-50, and per-column profile accumulators (count, class histogram, min/max, capped distinct set). Nothing is walked twice.

`excelTimeoutMs` (default 60 s, unchanged) is the only bound on the data child and it **remains fatal**: a workbook that cannot be walked in time fails with `Excel conversion failed: timeout after 60000ms. Remedy: raise excelTimeoutMs` (the `or lower maxCellsPerSheet` suffix is removed at `lib/doc-to-md-core.ts:488` and `:544`, and the pinned assertions in `test/doc_to_md.test.ts` and `test/doc_to_md.python.test.ts` follow). Excel worst-case wall time becomes `warmTimeoutMs + excelTimeoutMs + sofficeTimeoutMs + fallbackTimeoutMs + 2 * KILL_GRACE_MS` (README formula updated).

### Rendering pipeline (TS-orchestrated)

`convertDocument` for `xlsx`/`xls` (`lib/doc-to-md-core.ts`):

1. Run the data child (`xlsx` or `xls`) as today via `s.runTier`. Child options drop `maxCellsPerSheet` and gain `sheetsStagingDir`. The JSON result gains `renderPages: number[]` (sheet indices with visuals; always `[]` for `.xls`) and `sheetCount: number`; `sheets: SheetInfo[]` is extended (see [Handle](#handle)). `publishSheetImages(b)` and `publishSheetCsvs(b)` run immediately.
2. `renderPages` empty -> skip to step 6 (the Markdown then contains no markers).
3. Else call the new non-throwing `tryConvertOffice(sofficeTimeoutMs, inputPath, signal, run, filter)` where `filter = 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}'`. It returns `{ ok: true, pdfPath, cleanup } | { ok: false, kind: "missing" | "timeout" | "exit" | "no-pdf", detail }`; the existing `convertOffice` becomes a thin wrapper that throws the current messages so DOCX/PPTX behavior is byte-identical. `soffArgs` gains the `filter` parameter (default `"pdf"`). Missing soffice is detected as today by `code === null && !timedOut` - no PATH probe.
4. On `ok`, run the new Python mode `render-pages` via `s.runTier("render-pages", { path: pdfPath, sheetIndices: renderPages, expectedPages: sheetCount, imageDpi, imageFormat, stagingDir, maxOutputBytes, pymupdfVersion }, b, signal, fallbackTimeoutMs, backend)`. `Mode`, `MODES`, and the usage string in `scripts/doc_to_md.py` gain `render-pages`. The child: opens the PDF; if `doc.page_count != expectedPages` returns `{ ok: false, reason: "page-count mismatch (N vs M)" }` (all sheets unrendered - mapping unsafe); otherwise for each index takes `page = doc[idx]`, `w, h = page.rect.width, page.rect.height` (pt) and applies the budget below, writing `s<idx>.<fmt>` into `stagingDir` via `page.get_pixmap(dpi=eff_dpi)`. Per-page failures go to `failed: [{ idx, reason }]` without aborting the rest. `cleanup()` of the soffice dirs runs after this child returns (not before, as `convertOffice`'s throw path would).
5. `publishSheetImages(b)` again to publish the `s<idx>.<fmt>` files.
6. [Reconciliation](#reconciliation), then `rewriteLinks`, `validateImageLinks`, `commitBundle` as today. Handle notes are appended to `json.notes` before the head is built.

Pixel budget (constants in `scripts/doc_to_md.py`): `MAX_RENDER_PX = 16_000_000`, `MIN_RENDER_DPI = 36`, `MIN_PAGE_PT = 72`.
- `w < MIN_PAGE_PT or h < MIN_PAGE_PT` -> skip, reason `rendered view degenerate (page W x H pt)` - this is what a zero-extent chartsheet anchor produces.
- `eff_dpi = min(imageDpi, floor(sqrt(MAX_RENDER_PX / (w * h / 72^2))))`; if `eff_dpi < MIN_RENDER_DPI` -> skip, reason `rendered view too large (page W x H pt)`; else render at `eff_dpi` (a downscaled render is reported in the handle note as `rendered at N dpi`).

Each step is its own `runCapped` child: the data child, soffice, and the rasterizer never share a process, preserving the kill boundary AGENTS.md mandates.

### Reconciliation

Runs in TS on `json.markdown` before `rewriteLinks`. Purely index-based - no sheet names are reconstructed.

- For each `idx` in `renderPages`: if `sourceMap` has `s<idx>.<fmt>` -> replace `<!--rv:<idx>-->` with `Rendered view: ![Rendered view of sheet <idx>](s<idx>.<fmt>)` (resolved by `rewriteLinks` like any staged image) and `<!--rvs:<idx>-->` with `yes`; else replace them with `Rendered view: unavailable (<reason>)` and `no`, where `reason` is the per-sheet `failed[]` entry when present, else the workbook-level reason from the table below.
- Any `rv`/`rvs` marker left after the loop is a bug: fail the conversion with `internal: unresolved render marker` (this is the only new fatal path and it can only be hit by a Python/TS contract mismatch, which tests pin).

### Failure handling

The visual path never fails a conversion. Only the data child is fatal, as today.

| Condition | Per-sheet reason | Handle note |
|---|---|---|
| `tryConvertOffice` -> `missing` | `LibreOffice not found` | `Rendered views skipped: LibreOffice not found` |
| -> `timeout` / `exit` / `no-pdf` | `soffice failed: timeout after Nms` / `soffice failed: exit N` / `soffice produced no PDF` | `Rendered views skipped: <same>` |
| `render-pages` -> page-count mismatch | `page-count mismatch (N vs M)` | `Rendered views skipped: page-count mismatch (N vs M)` |
| `render-pages` child fails (timeout, crash, cap) | `render failed: <reason>` | `Rendered views skipped: render failed: <reason>` |
| one page fails / skipped inside `render-pages` | that sheet only: the child's reason (`degenerate`, `too large`, or the exception text) | `Rendered views: k of n unavailable` |
| downscaled render | none (rendered) | `Rendered view s<idx>: rendered at N dpi` |
| `.xls` input | no markers; one line under `## Sheets`: `Rendered views: unavailable (visual detection not supported for .xls)` | same text |

### Options and settings

Removed (breaking): the `maxCellsPerSheet` descriptor in `lib/doc-to-md-options.ts`. The CLI flag, the TypeBox tool schema field (`extensions/doc_to_md.ts:29`), and the `QUIVER_CONFIG_KEYS.docToMd` entry (`lib/extension-config.ts:51`) are all derived from `DOC_TO_MD_OPTIONS` and disappear with it. Direct references that must be edited by hand: `lib/doc-to-md-core.ts:482` (child option), the two remedy strings (`:488`, `:544`), `README.md`, `doc/doc-to-md.md:98,127`, `skills/doc-to-md`, and the pinned tests (`test/doc_to_md.test.ts:688,712`, `test/doc_to_md.python.test.ts:159-167`, `test/doc-to-md-cli.test.ts:95`, `test/doc-to-md-options.test.ts`). A leftover key in `settings.json` is reported by the existing unknown-key lint - that is the migration signal. No deprecation shim.

Reused: `sofficeTimeoutMs` (now also bounds Excel rendering), `fallbackTimeoutMs` (bounds `render-pages`), `imageDpi`/`imageFormat` (rendered views, subject to the pixel budget). Help text of `sofficeTimeoutMs`, `fallbackTimeoutMs`, and `imageDpi` gains "and Excel rendered views".

No new option. Preview size (100 x 50), profile thresholds (60%, 50 distinct), slug length (40), and the pixel budget constants live in `scripts/doc_to_md.py`.

### Handle

`lib/doc-to-md-handle.ts`:

```ts
export interface SheetInfo {
  index: number;                       // 0-based workbook position
  name: string;
  kind: "worksheet" | "chartsheet";
  hidden: boolean;
  rows: number | null; cols: number | null;   // null for chartsheets
  hiddenRows: number; hiddenCols: number;
  charts: number; images: number;
  rendered: boolean;                   // conversion only; always false in info
  csv: string | null;                  // bundle-relative path, conversion only
}
```

`HandleData` and `DocToMdDetails` gain `sheetsDir: string | null` (set when `csvManifest.size > 0`). `formatHandle` prints `Sheets-Dir: <path>` on the line after `Images-Dir:` when non-null.

`formatInfoHandle` sheet line becomes:
```
  <name>  [hidden ]<kind> rows=<n|-> cols=<n|-> charts=<n> images=<n>[ hiddenRows=.. hiddenCols=..]
```
`mode_info_excel` iterates `wb._sheets`, emits `kind`, `charts`, `images`, `rendered: false`, `csv: null`; `rows`/`cols` for worksheets are still `max_row`/`max_column` (info does not walk cells; the mismatch with the conversion extent is accepted and documented in the README).

### `.xls`

`mode_xls` produces the same preamble (all `kind: worksheet`, `charts`/`images` 0, `rendered` `-`), CSVs, preview, and profile with the same rules over xlrd values; each sheet section keeps the #13 line `Formulas: unavailable (.xls via xlrd); Images: unavailable`; `renderPages` is `[]`; one workbook-level unavailable line under `## Sheets`.

## Testing

Fixtures (`test/fixtures/generate.py`, committed binaries):

- New `charts.xlsx`: `Data` (200 rows x 3 cols with a formula column, one embedded `LineChart`, one PNG), `Empty` (pristine), hidden `Aux` (10 x 2), chartsheet `Trends` (line, title `Synthetic trends`, series from `Data`), chartsheet `Bars` (bar), `Wide` (300 rows x 80 cols with int, float, string, and date columns; a header row). Post-processing rewrites every `xl/drawings/drawing*.xml` entry, replacing `<xdr:ext cx="0" cy="0"/>` with `<xdr:ext cx="9144000" cy="6858000"/>` at the zip level, documented in the generator as an openpyxl chartsheet workaround. This workbook is never round-tripped through soffice, so its formula cells have no cache (the preview shows `(no cached result) (=...)`, the CSV the formula text).
- New `charts-zero-extent.xlsx`: `Data` + one chartsheet, **not** patched - exercises the degenerate-page guard.
- Existing `workbook.xlsx` / `workbook.xls` keep their soffice round-trip for formula caches; assertions updated for the new layout and 0-based names (`workbook-s0-1.png`).

`test/doc_to_md.python.test.ts` (uv-gated; soffice-gated where noted):

- Preamble lists 6 sheets in order with correct `kind`, size (`Empty` is `0 x 0`, `Trends` is `-`), `hidden`, `charts`, `images`.
- `sheets/` holds exactly `charts-s0-data.csv`, `charts-s2-aux.csv`, `charts-s5-wide.csv`; row/column counts equal the extents; formula cells carry formula text; dates ISO; the `## Sheets` `data` column and `Data:` lines link to them.
- `Data` preview is 100 x 3 with the truncated header and the row gutter; `Wide` preview is 100 x 50 and has a `Columns:` table with 80 rows and correct `header`/`type`/`min`/`max`/`distinct` for known columns; `Aux` has no `Columns:` table and a `Content (10 rows x 2 cols):` header.
- Render markers: asserted from the Markdown - `Rendered view:` lines exist exactly for `Data`, `Trends`, `Bars`; preamble `rendered` is `yes`/`no` accordingly, `-` for the others. (No test hook; the Markdown is the contract.)
- With soffice (Ubuntu CI + local): `images/charts-s0.png`, `-s3.png`, `-s4.png` exist and no other `charts-s<idx>.png`; each has > 1 distinct color in a PyMuPDF pixmap and is at least 200 x 200 px; `Sheets-Dir` and `Images-Dir` in the handle. `charts-zero-extent.xlsx`: conversion succeeds, `Rendered view: unavailable (rendered view degenerate ...)`, handle note `Rendered views: 1 of 1 unavailable`.
- With `PATH` stripped of soffice: identical Markdown except `Rendered view: unavailable (LibreOffice not found)` on the three sheets, `rendered` `no`, exit success, handle note present.
- `.xls`: preamble, CSVs, workbook-level unavailable line, no markers.
- `info` on `charts.xlsx`: 6 sheets with kinds and chart/image counts in the new line format.
- Timeout test's remedy assertion updated to `Remedy: raise excelTimeoutMs`.

`test/doc_to_md.test.ts` (unit): `PipelineSeams` gains `office: typeof tryConvertOffice` so soffice can be faked; `test/fixtures/fake-tier.mjs` learns to stage `s<idx>.<fmt>` and `s<idx>-<slug>.csv` and to return `renderPages`/`sheetCount`/`failed`. Cases: happy path publishes rendered views and CSVs into both manifests and the handle; `office -> missing` and `-> timeout` produce the per-sheet and note text and exit success; page-count mismatch degrades all; partial `failed[]` leaves other PNGs linked; an unresolved marker fails with `internal: unresolved render marker`; overwrite cleanup removes only this stem's `images/` and `sheets/` files (a second stem's CSV survives); `abortBundle` removes staged CSVs; `validateImageLinks` rejects a `sheets/` link not in `csvManifest`; `ownedPattern` matches `x-s3.png` and `x-s3-1.png` and `x-p1-1.png` and not `y-s3.png`.

`test/doc-to-md-options.test.ts`, `test/extension-config.test.ts`, `test/doc-to-md-cli.test.ts`: `maxCellsPerSheet` absent from descriptors, CLI help, registry; unknown-key lint fires on a settings fixture that still has it.

`test/packed-install.test.ts` unchanged.

## Out of scope

- In-grid placement of images/charts (association is per sheet only).
- Patching or repairing zero-extent anchors in user files (they degrade with a named reason).
- Any new Python package or renderer (matplotlib, PyMuPDF Pro, commercial SDKs).
- `.xls` visual detection or rendering.
- `.xlsm`, sheet/range selection, formula recalculation, DrawingML shapes / SmartArt / OLE inventory (only `_charts` and `_images` count as visuals).
- Making soffice mandatory for Excel or changing DOCX/PPTX behavior (their thrown messages are unchanged).
- Pinning a LibreOffice version; the portability bar is "Ubuntu CI's apt LibreOffice passes the soffice-gated tests".

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` doc_to_md Excel section (bundle layout with `sheets/`, 0-based sheet identity, preview + profile rules, optional rendered views with the failure notes and pixel budget, `.xls` limitation, zero-extent quirk, `maxCellsPerSheet` removal, Excel wall-time formula) - operations/contract; `doc/doc-to-md.md` Excel contract lines; `CHANGELOG.md` - deferred: release (breaking entry)
- Derived / memory docs invalidated: `AGENTS.md` "`doc_to_md` engines" paragraph (Excel now has an optional soffice + PyMuPDF render step and a `sheets/` bundle dir); `doc/specs/2026-09-09-gh-13-selective-image-linked-excel-conversion.md` (supersession banner). `skills/doc-to-md` mentions of `maxCellsPerSheet` are implementation surface, handled in the plan.

## Open questions

None blocking.
