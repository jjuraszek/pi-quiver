# doc_to_md: opt-in OCR, image inputs, and local HTML

**Goal:** `doc_to_md` converts scanned PDFs, standalone images, and local `.html`/`.htm` files into bundles an agent can read: on the Python tiers every scanned page keeps its picture, OCR text is added on request when Tesseract is installed, and local HTML converts with full fidelity through the already-pinned markdownify with a Turndown fallback.

Predecessors (both keep every clause not named here):

- supersedes `doc/specs/2026-09-09-gh-13-selective-image-linked-excel-conversion.md` (the live PDF contract; `doc/specs/2026-09-10-gh-17-excel-output-v2.md` superseded only its Excel parts), scope: the "OCR for scanned documents (`use_ocr=False`)" non-goal, the `pdf-primary` call's `use_ocr=False`, and the `path` row's supported-input list.
- supersedes `doc/specs/2026-09-28-gh-24-direct-docx-conversion-toc-offsets.md`, scope: step 1c converter options (the shared markdownify converter gains cell-pipe escaping and code-fence language), which changes DOCX table output.

## Problem

Three gaps, measured on 6.5.0 (`cd82551`):

1. **Scanned PDFs lose everything on the primary tier.** `scripts/doc_to_md.py` `mode_pdf_primary` passes `use_ocr=False` to `pymupdf4llm.to_markdown`. An image-only one-page PDF converts to `Empty-Pages: 1`, `Images: 0`, and no `images/` directory: neither text nor the page picture reaches the agent. (The fallback tier already links embedded images per page, so a scan survives there as raw embedded images.)
2. **Standalone images are rejected.** `classifyInput` (`lib/doc-to-md-options.ts:139-145`) throws `Unsupported file type` for `.png`, `.jpg`, and every other image.
3. **Local HTML has no converter.** `doc_to_md` rejects `.html`/`.htm`, and `fetch` rejects `file:` URLs (`lib/fetch-core.ts:491-492`). `htmlToMarkdown` in `lib/fetch-core.ts` runs Readability first, which drops non-article content (a footer, in the measured page) and returns null when it finds no article.

Facts the design relies on (source-verified against pymupdf4llm 1.27.2.3 and PyMuPDF):

- pymupdf4llm already contains OCR. With `use_ocr=True` (SELECT mode) it runs `helpers.utils.analyze_page` per page and OCRs only pages with `needs_ocr` (reasons `chars_bad`, `ocr_spans`, `vec_text`, `img_text`); `force_ocr=True` OCRs unconditionally. Engine selection (`helpers/document_layout.py:907-956`) uses Tesseract when `pymupdf.get_tessdata()` finds language data (`TESSDATA_PREFIX`, else a `tesseract --list-langs` subprocess, else `where tesseract` on Windows) and RapidOCR when `rapidocr_onnxruntime` imports; with neither it disables OCR with a printed warning. PyMuPDF links Tesseract; only the language data files come from the OS. `get_tessdata()` runs several times per `to_markdown` call (engine selection, the Tesseract adapter, the render) and returns `TESSDATA_PREFIX` without a subprocess when that is set.
- OCR costs 3.1-3.2 s per scanned page (M2 Pro, 55-line pages); a text page costs 0.17 s with OCR off and 0.20 s with OCR on. The default `primaryTimeoutMs` of 60000 fits about 18 scanned pages. Primary Markdown arrives only in the child's final JSON, so a primary timeout discards every OCR'd page and the fallback tier replaces it (`lib/doc-to-md-core.ts:572-582`).
- `img_text` has no size floor: a 40x40 pt logo marks every page `needs_ocr`, taking a 10-page text PDF from 1.37 s to 3.96 s with identical text output. A 3x40 px rule is already ignored.
- The shipped markdownify converter (`scripts/doc_to_md.py`, `MarkdownConverter` subclass used by `mode_docx`) does not escape `|` in table cells: a DOCX cell `Rose | red` renders as `| Rose | red | Sun |` under a two-column header. It also drops the code-fence language, and it maps `<hr class="pagebreak">` to the DOCX-only `\x00PAGEBREAK\x00` sentinel.
- A 2026-09-29 stress-test HTML page compares pip-only candidates (no OS packages): `html-to-markdown` 3.15.1 (MIT, Rust abi3 wheels ~7.5 MiB, no musl wheel), `markdownify` 1.2.3 (MIT, pure Python), `pypandoc-binary` (40 MiB wheel, ~10 s cold start), `html2text` 2025.4.15 (GPL-3.0), `trafilatura` 2.2.0 (main-content extraction), `markitdown` (wraps markdownify), `docling` (heavy), `inscriptis` (plain text), and `readabilipy` (Readability); versions are from PyPI. `html-to-markdown` escapes `|` in cells and keeps task checkboxes and code languages by default, but flattens definition lists and needs `PreprocessingOptions(enabled=False), extract_metadata=False` to keep `<nav>` and skip YAML front matter. `markdownify` keeps definition lists and nested list paragraphs but does not escape cell `|` or keep code languages; neither handles nested tables well. `pypandoc-binary` keeps complex tables as HTML but loses outer list bullets; `html2text` breaks tables; `trafilatura` drops headings, lists, and tables. `html-to-markdown` is chosen first, then replaced by markdownify once 6.5.0 ships it as a pinned dependency with a converter subclass: markdownify adds no pin, while a new all-or-nothing pin without a musl wheel would fail the whole Python backend there. The shared converter fixes its measured cell-pipe and code-language weaknesses (Design section 6).
- Precedents in gridstrong: `librarian` never OCRs and renders textless pages to PNG for a vision model; `excavation` keeps pymupdf4llm OCR on, labels standalone-image OCR as possibly erroneous, and still OCRs thin strips (shorter side under 60 px) because they carry phone numbers and revision stamps.

## Acceptance criteria

none - no ticket

## Design

### 1. Inputs and tunables

**`lib/doc-to-md-options.ts`:**

- `InputType` gains `html` (`.html`, `.htm`) and `image` (`.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.bmp`, `.gif`). `.webp` stays unsupported: PyMuPDF fails to open it. The `Unsupported file type` message lists the new extensions.
- Two new descriptors in `DOC_TO_MD_OPTIONS`, both `settable: true` (`QUIVER_CONFIG_KEYS.docToMd` derives from the descriptors, so it picks them up):

  | key | flag | type | default | meaning |
  |---|---|---|---|---|
  | `ocr` | `--ocr` / `--no-ocr` | bool | `false` | Run OCR on pages without a usable text layer and on image inputs, when Tesseract language data is installed |
  | `ocrLanguage` | `--ocr-language` | string | `eng` | Tesseract language code(s), `+`-joined |

- Resolution order is the existing one: tool call, then `quiver.docToMd` in `settings.json`, then default. OCR is opt-in: an agent that sees scanned pages re-converts with `ocr: true` (plus `overwrite: true` when reusing the same `outputDir`; the completed-bundle guard in `openBundle` requires it). A tool call or `--no-ocr` turns off a settings-level `ocr: true`.
- `ocrLanguage` must match `^[a-z][a-z0-9_]*(\+[a-z][a-z0-9_]*)*$`; anything else is a usage error at option resolution, because the parts become file names under tessdata. Only plain language models are accepted; Tesseract `script/...` models are not.

**`bin/pi-quiver.ts`:** a settable bool descriptor also accepts `--no-<flag name>`, which sets `false`.

**`lib/doc-to-md-core.ts` `convertDocument` / `inspectDocument`:** `pages` with `html` or `image` input throws next to the existing spreadsheet check (`lib/doc-to-md-core.ts:495`), same error form: `--pages does not apply to <HTML files|images>`. `info` on `html` or `image` throws in `inspectDocument` before backend resolution: `info does not apply to <HTML files|images>; convert directly`.

### 2. OCR status and tessdata (`scripts/doc_to_md.py`)

A new `ocr_status(ocr, lang)` returns:

| status | when | extra |
|---|---|---|
| `off` | `ocr` is false | `tesseract: bool` - whether data for `lang` is present, used only for the rerun hint |
| `unavailable` | `pymupdf.get_tessdata()` raises, or a `<tessdata>/<part>.traineddata` file is missing | reason `Tesseract language data not found` or `language data for <part> not installed` |
| `ready` | data for every `+`-part exists | - |

- It runs at most once per conversion: at mode entry when `ocr` is true, else only when the input is an image or at the first textless page (for the rerun hint), so a text-only PDF with OCR off never calls it.
- On `ready` (and on `off` after the `tesseract` probe) the child sets `os.environ["TESSDATA_PREFIX"]` to the resolved directory, so the library's repeated `get_tessdata()` calls return without spawning `tesseract --list-langs`.
- RapidOCR is neither pinned nor detected by us; when a user installs it next to Tesseract, pymupdf4llm uses it on its own.

### 3. PDF primary tier (`mode_pdf_primary`)

Per selected page, before the existing per-page `to_markdown` call:

1. **Textless test.** `page.get_text("text").strip() == ""` marks the page textless. This is the only per-page check added when `ocr` is false.
2. **Page picture.** A textless page is rendered, whatever the OCR status, to `stagingDir/p<n>/page.<imageFormat>` at `imageDpi`, clamped by the existing `MAX_RENDER_PX` / `MIN_RENDER_DPI` rule of `mode_render_pages`. When it runs OCR, its `to_markdown` call passes `write_images=False`, so the render is the page's only picture. Its Markdown starts with `![page <n>](p<n>/page.<imageFormat>)`; `publishStaged` + `rewriteLinks` publish it as `images/<stem>-p<n>-<i>.<imageFormat>`.
3. **OCR decision** (status `ready` only; otherwise every page with a text layer runs `use_ocr=False` as today, and a textless page skips `to_markdown`, since its Markdown is only the picture link):
   - **Textless page:** `force_ocr=True, ocr_language=<lang>`, subject to the budget.
   - **Page with text and no images** (`page.get_images()` empty): `use_ocr=True` (SELECT); the library decides, and our gate is not run.
   - **Page with text and images - small-image gate:** call `pymupdf4llm.helpers.utils.analyze_page(page)`. An image is small when its bbox area is under 5% of the page area or its shorter side is under 5% of the page's shorter side (`SMALL_IMAGE_FRACTION = 0.05`). When `needs_ocr` is true, its only reason is `img_text`, and every image on the page is small, pass `use_ocr=False`; otherwise pass `use_ocr=True`. The library analyzes the page again inside SELECT mode; this second analysis is accepted on pages with images only. `analyze_page` is internal API: if the import or call raises (for example under a `pymupdfVersion` override), pass `use_ocr=True` and let the library decide.
   - **Budget:** the child receives `ocrBudgetMs` (= `primaryTimeoutMs`) and starts its clock at mode entry. Before an OCR call on page `i` it requires `elapsed + est_ocr + remaining * est_page + 5000 <= ocrBudgetMs`, where `est_ocr` is the slowest OCR page so far (initially 4000 ms), `est_page` the mean non-OCR page time so far (initially 250 ms), and `remaining` the selected pages after `i`. A page that fails the check runs with `use_ocr=False` and joins `budgetStopped`. With `ocrBudgetMs` under 9000 no page passes, which the handle reports as budget-stopped. One OCR call cannot be interrupted: if a call overruns and the tier times out, the existing fallback tier runs (section 4).
4. **OCR label.** On a textless page whose OCR output is non-empty, the page Markdown after the picture link is a blockquote:

   ```markdown
   ![page 3](images/scan-p3-1.png)

   > Text recognized in images/scan-p3-1.png (OCR, may contain recognition errors):
   >
   > <recognized Markdown, each line prefixed with "> ">
   ```

   The child cannot know the published name, so it emits the label line as the sentinel `\x00OCR p<n>/<file>\x00` (the DOCX `\x00PAGEBREAK\x00` precedent). After `publishStaged`, the parent replaces each sentinel with the label text using `b.sourceMap`; a sentinel whose file has no `sourceMap` entry becomes `Text recognized by OCR (source image missing):`, so no sentinel reaches the bundle. The `> ` prefix keeps OCR headings out of the Outline: `scanOutline` (`lib/doc-to-md-handle.ts`) matches only column-0 `#` headings and is unchanged.

   On a page with a text layer that SELECT mode OCR'd, pymupdf4llm merges the OCR text into the page output; no label is added.
5. **Per-page OCR error.** If `to_markdown` raises with OCR on, a textless page keeps its picture with no text and joins `ocrFailed`; a page with a text layer is retried with `use_ocr=False` and is not reported. Only a failure without OCR enters the existing `failedPages` path.
6. **Empty pages.** `emptyPages` lists pages with no text layer and no OCR text, in both PDF tiers; a page picture alone does not make a page non-empty.

The child returns `ocr: OcrInfo`:

```ts
interface OcrInfo {
  status: "off" | "unavailable" | "skipped" | "ran";
  lang: string;
  textless: number[];      // pages without a text layer
  pages: number[];         // textless pages (or the image) OCR'd with non-empty output
  noText: number[];        // textless pages OCR'd with empty output
  ocrFailed: number[];
  budgetStopped: number[];
  reason: string | null;
  tesseract: boolean | null; // set when status is "off"
}
```

`status` is `ran` whenever it was `ready`, even if no page passed the budget. Pages with a text layer are not reported, whether gated or passed to SELECT mode: the library decides internally whether it OCR'd them.

### 4. PDF fallback tier (`mode_pdf_fallback`)

No OCR. A textless page is rendered and linked as in section 3 step 2, and its embedded-image extraction is skipped so the render is its only picture; pages with text keep today's embedded-image extraction. `ocr.status` is `unavailable` with reason `fallback tier` when `ocr` was requested, else `off` with `textless` filled.

**No Python backend (`unpdf`):** textless pages get no picture - the worker has no renderer. With `ocr: true` the handle reports `unavailable` with reason `no Python backend`; with OCR off it prints no `OCR:` line, and the existing `No images: unpdf backend` note stands.

### 5. Image input (new child mode `image`)

1. Copy the original file bytes to `stagingDir/p1/original.<ext>` (lower-cased extension) with a `.done` marker; the Markdown starts with `![<stem>](p1/original.<ext>)`, published as `images/<stem>-p1-1.<ext>`.
2. With status `ready` and a shorter side of at least 16 px (`MIN_OCR_SIDE_PX = 16`): open the image, `convert_to_pdf()`, reopen as PDF, and call `to_markdown(..., force_ocr=True, ocr_language=<lang>, ocr_dpi=<native>, write_images=False)`, where `<native>` = `72 * pixel_width / page_width_pt`, lowered so the render stays within `MAX_RENDER_PX`. The OCR pixmap is thus at most the image's own pixel size. Non-empty output follows under the section 3 label sentinel naming `p1/original.<ext>`.
3. A shorter side under 16 px sets status `skipped` with reason `image too small`.
4. An OCR exception inside the child keeps the image-only Markdown with `ocrFailed: [1]`.
5. Tier `image`, engine `pymupdf4llm`, timeout `primaryTimeoutMs`. When the child fails, times out, or overruns `maxOutputBytes`, and when there is no Python backend, the TypeScript side writes the image-only bundle itself (tier `image`, engine `copy`) with status `unavailable` and reason `no Python backend` or `OCR child failed: <reason>`. Cancellation still aborts the bundle.

### 6. HTML input

**Preprocessing in TypeScript (`lib/doc-to-md-core.ts`, one implementation for both engines):**

1. **Decode.** If the bytes decode as strict UTF-8 (`TextDecoder("utf-8", { fatal: true })`), parse the string; otherwise pass the `Buffer` to JSDOM, which sniffs the BOM and `<meta charset>` (verified: a `windows-1250` page decodes correctly this way, while a UTF-8 page without `<meta charset>` is mis-sniffed as `windows-1252`, hence the strict-UTF-8 first step).
2. **Title and strip.** When the body has no `<h1>` and `<title>` is non-empty, insert `<h1><title text></h1>` at the top of the body. Remove `head`, `script`, `style`, `noscript`, and `template`. No Readability.
3. **Images.** For each `<img>`:
   - relative `src`, resolved against the HTML file's directory, existing, with a supported image extension -> copied to `stagingDir/p1/<k>.<ext>` (`k` = 1, 2, ... in document order) and `src` rewritten to `p1/<k>.<ext>`;
   - `data:image/<png|jpeg|gif|bmp|tiff>;base64,...` whose decoded bytes start with that type's signature (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `GIF8`, BMP `BM`, TIFF `II*\0`/`MM\0*`) -> staged and rewritten the same way; any other `data:` payload counts as broken;
   - `http(s)://` or protocol-relative `//host/...` (linked as `https://host/...`) -> replaced with `<a href="<url>"><alt or url></a>`, never downloaded;
   - anything else (missing file, broken `data:`, unsupported scheme) -> replaced with its `alt` text, counted in one note (`<k> image(s) not found; replaced with alt text`).

   After the last image the preprocessor writes `stagingDir/p1/.done`, so `publishStaged` + `rewriteLinks` publish the images as `images/<stem>-p1-<i>.<ext>` for either engine.
4. Serialize the document for the engine.

**Engines:**

- **Primary:** new child mode `html` receives the serialized HTML in stdin JSON, parses it with BeautifulSoup (`html.parser`, as `mode_docx` does), and converts with the shared converter. Tier `html`, engine `markdownify`, timeout `primaryTimeoutMs`. It runs when the probe's existing `DOCX` bit is set, since that bit already covers `markdownify` and bs4.
- **Fallback:** when the backend is `none`, the `DOCX` bit is unset, or the `html` child fails or times out (not on cancellation), a new export `htmlToMarkdownRaw(html: string): string` in `lib/fetch-core.ts` runs the existing Turndown + GFM setup without Readability and without the title prepend. Tier `html`, engine `turndown`, `degraded` = new constant `DEGRADED_HTML_TURNDOWN = "Turndown HTML conversion - definition lists and headerless tables not preserved"` beside the existing `DEGRADED_*` constants, and `fallbackReason` set as for PDF.

**Shared converter (`scripts/doc_to_md.py`).** The DOCX `MarkdownConverter` subclass becomes the shared class for `docx` and `html`:

- `|` inside a table cell is emitted as `\|`; no other escaping changes;
- a `language-<x>` or `lang-<x>` class on `<code>` or its `<pre>` becomes the fence language;
- definition lists keep markdownify's `term` / `:   definition` output (unchanged; pinned by a test);
- the `pagebreak` `<hr>` sentinel is enabled only for `docx`; `html` converts every `<hr>` to `---`.

### 7. Handle and details (`lib/doc-to-md-handle.ts`)

`HandleData` gains `ocr: OcrInfo | null`: `null` when `textless`, `pages`, and `ocrFailed` are all empty and the input is not an image, and on the `unpdf` tier unless `ocr` was requested. A non-null value prints one `OCR:` line, chosen by the first matching row:

| status | line |
|---|---|
| `off`, `tesseract: true` | `OCR: off - <t> page(s) without a text layer; rerun with ocr=true` |
| `off`, `tesseract: false` | `OCR: off - <t> page(s) without a text layer; install Tesseract (see doc/doc-to-md.md), then rerun with ocr=true` |
| `unavailable` | `OCR: unavailable - <reason> (install Tesseract; see doc/doc-to-md.md)`; the parenthesis is omitted for reasons `fallback tier`, `no Python backend`, and `OCR child failed: ...` |
| `skipped` | `OCR: skipped - image too small` |
| `ran` | `OCR: <k> page(s) (<lang>)`, then `; ` + each non-empty clause in this order: `<m> returned no text`, `<f> failed and were converted without OCR`, `time budget reached for pages=<range>; rerun with pages=<range> or raise primaryTimeoutMs` |

`<t>` counts `textless`, `<k>` counts `pages`, and `<range>` compresses `budgetStopped` (`18-40`, `3,7-9`). For an image input the noun is `image` instead of `page(s)`, and the `off` rows read `OCR: off; rerun with ocr=true` (+ the install clause). `details.ocr` carries the object unchanged. `Engine`/`Tier` unions gain `markdownify`, `turndown`, `copy` and `html`, `image`.

## Errors and edge cases

- OCR never fails a conversion: off, unavailable, too-small, budget-stopped, empty, and failed OCR all still write the Markdown and the page picture.
- A tier timeout caused by one overrunning OCR call runs the fallback tier, which keeps the page pictures but no OCR text; the handle shows `OCR: unavailable - fallback tier`, and the agent can rerun with `pages` or a larger `primaryTimeoutMs`.
- Stdout noise: pymupdf4llm's OCR and parser messages go through `pymupdf.message`, bound to the redirected stdout, so they reach stderr and never the JSON channel (`scripts/doc_to_md.py` imports pymupdf inside `redirect_stdout(sys.stderr)`).
- Windows: tessdata discovery is PyMuPDF's (`where tesseract` + `tessdata`). The spec assumes it matches macOS/Linux behavior; the real-OCR test runs only where data is found, so Windows is covered only on a machine with Tesseract.
- An HTML file with no convertible content produces an empty Markdown body through the existing empty-output handling; it is not an error.
- A relative image `src` that leaves the HTML file's directory (`../x.png`) is allowed when the file exists.
- DOCX output changes: tables with `|` in a cell gain `\|`; code blocks with a language class gain a fence language. `CHANGELOG.md` records it.

## Tests

All in the existing `node --test` suites; new fixtures come from `test/fixtures/generate.py` (a scanned-page PDF, a text PDF with a small logo per page, a PNG with text, a 10x200 px strip, HTML pages with each image case, a `<title>`-only page, an `<hr class="pagebreak">` page, and a non-UTF-8 page).

| Suite | Covers |
|---|---|
| `test/doc-to-md-options.test.ts` | new extensions, `ocr`/`ocrLanguage` defaults and precedence (a call `ocr: false` beats settings `true`), `ocrLanguage` validation |
| `test/doc-to-md-cli.test.ts` | `--no-ocr` overrides a settings-level `ocr: true` |
| `test/doc_to_md.child.test.ts` (uv-gated) | `ocr_status` off/unavailable (`TESSDATA_PREFIX` at an empty dir)/missing language, and `TESSDATA_PREFIX` exported after `ready`; with OCR off a text-only PDF never calls `analyze_page` or `ocr_status` (monkeypatched counters); textless page picture written, render clamped, no duplicate embedded image, in both PDF tiers; `emptyPages` agrees across tiers; small-image gate on the logo fixture, and the `analyze_page`-raises path; budget admission with an injected clock (all admitted, partial, `ocrBudgetMs` 8000 admits none); per-page OCR exception retried without OCR; image mode copy, `ocr_dpi` at native size, too-small skip, OCR exception; html mode; shared converter pipe escaping, code language, definition list, `<hr class="pagebreak">` stays `---` for HTML; DOCX `Rose \| red` cell regression |
| `test/doc_to_md.test.ts` (fake tier) | `pages` and `info` rejection for html/image; OCR sentinel replacement and the missing-source case; every `OCR:` row and clause in section 7, including `ran` with zero pages; `details.ocr`; range compression; HTML preprocessing for all four image cases, `.done` written, links published through both engines, title insertion, and the encoding rule; Turndown fallback keeps a footer Readability drops and carries `DEGRADED_HTML_TURNDOWN`; `html` child timeout falls back to Turndown; image child failure and no-Python backend both write the image-only bundle; cancellation aborts; `unpdf` tier with `ocr: true` reports `no Python backend` |
| `test/doc-to-md-handle.test.ts` | `OCR:` line rendering and omission for text-only PDFs; OCR blockquote headings absent from the Outline |
| real OCR | one child test runs `ocr=true` on the scanned fixture and asserts the label and recognized text; skipped when `pymupdf.get_tessdata()` finds no data (CI runners have none; no install step is added) |

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/doc-to-md.md` (Backend ladder: image and HTML paths, textless-page pictures on both Python tiers, none on `unpdf`; Bundle and handle: page pictures, OCR label, `OCR:` line; Child contract: `image` and `html` modes, `ocr` result, `ocrBudgetMs`; Configuration: `ocr`, `ocrLanguage`, `--no-ocr`; new section "Optional: Tesseract for OCR" - OCR is off by default and runs only with `ocr=true` when Tesseract language data is installed, install commands for brew/apt/Windows, extra languages via `brew install tesseract-lang` / `apt install tesseract-ocr-<lang>`, `TESSDATA_PREFIX`, plain language codes only); `README.md` (doc_to_md row and intro: HTML and image inputs, opt-in OCR, Tesseract as an optional OS-level dependency)
- Derived / memory docs invalidated: none

Categories per `reference/documentation-impact.md`. `CHANGELOG.md` `## Unreleased` gets the entry, including the DOCX table fix.

## Out of scope

- Guarding pages with 10,000+ vector drawings that hang pymupdf4llm (gridstrong renders them as images); a separate issue.
- Page pictures on the `unpdf` tier (no renderer without Python).
- Salvaging primary-tier OCR text after a tier timeout (per-page Markdown persistence).
- Parallel OCR across processes, pinning or detecting RapidOCR, OCR quality filtering, `force_ocr` on PDF pages that have a text layer, `ocr_dpi` control for PDFs, and Tesseract `script/...` models.
- Downloading remote HTML images, `.webp` input, and `file:` URLs in `fetch`.
- Filtering the SWIG `__module__` notes; a separate fix.

## Open questions

none
