# doc_to_md textless pages: native image extraction, isolated rendering, clamp reporting, hidden annotations

**Goal:** Give a textless PDF page back as the document's own pixels when it is one full-page image, rasterize everything else in a killable worker so a MuPDF-toxic page costs one page and a note instead of the whole conversion, raise the render pixel ceiling so the clamp stops biting ordinary documents and report it whenever it still does, and let a caller hide annotations on renders.

Ticket: [jjuraszek/pi-quiver#27](https://github.com/jjuraszek/pi-quiver/issues/27).

supersedes `doc/specs/2026-09-30-gh-25-doc-to-md-bundle-gaps.md`, Design 4 (page images) - the textless-page picture and the one-render-per-page dedupe; the `pages/` directory, naming and protocol stay as written and are restated in Design 6 below.

## Problem

A textless PDF page is always rasterized (`render_textless_page`, `scripts/doc_to_md.py`), even when the page is nothing but one embedded image scaled to fill it - the common screenshot or scan PDF. The consumer gets a 150 dpi re-encoding of a picture whose source pixels are in the file: a 2480 x 3507 scan comes back as 1240 x 1754. The per-image `doc.extract_image(xref)` route exists only in the fallback tier and only for text-bearing pages; the default primary tier never extracts, and pymupdf4llm's own image writer re-renders every clip through `get_pixmap(clip=rect, dpi=150)`.

Rendering is governed by one constant, `MAX_RENDER_PX = 16_000_000`, introduced for Excel rendered views where `SinglePageSheets` makes a page metres tall. It is a memory guard (a pixmap is `w * h * 3` bytes before encoding), but at 16 Mpx it clamps real documents - A3 at 300 dpi is 17.4 Mpx - and nothing tells the caller: `pageImages` entries carry `{page, file}` only, so two runs at 150 and 120 dpi can return identical pixels with no indication why.

Renders paint annotations (`get_pixmap` defaults to `annots=True`): a sticky note over text turns "Disable" into "Disab" in the picture the consumer reads. There is no way to ask for content only.

Rendering is also unisolated. MuPDF's spin on a toxic page (decompression bomb, pathological vector content) is C-level: `signal.alarm` and thread joins never fire, and `get_pixmap` on a bombed page can abort the interpreter outright (observed in ../gridstrong/librarian, `python-shared/gs-doc/src/gs_doc/pdf_isolate.py`). Today `lib/doc-to-md-core.ts` SIGKILLs the whole Python child at `primaryTimeoutMs` (60 s), retries `pdf-fallback` under `fallbackTimeoutMs` (30 s), which hits the same page and dies, and a 200-page document with one bad page fails with `Conversion failed: primary timeout; fallback timeout`. #26 isolated only its forced-OCR sidecar child; its Errors 5 states that a spin or abort in the main child "kills the main child, and the existing tier failure/timeout path applies".

## Acceptance criteria

Ticket jjuraszek/pi-quiver#27, "Acceptance criteria", rows verbatim:

- [ ] Committed fixture `test/fixtures/single-image-page.pdf`: one textless page holding one 2000 x 2800 px image scaled to fill it. Default run: `images/` holds a 2000 x 2800 px file, the handle marks it `native: true`, no render DPI is reported for that page.
  deviates: location only - the handle lists the image under `nativeImages: [{page, file, width, height}]` (Design 3) rather than flagging a `native: true` field on a per-image entry; the 2000 x 2800 file and the absence of render DPI hold as written.
- [ ] Committed fixtures `test/fixtures/annotated.pdf` and `annotated-clean.pdf` (same content, the first with a sticky-note annotation over text; pages contain vector text so the render path is used). `--page-images --hide-annotations` on the first produces a `pages/` file pixel-identical to the plain run on the second; without the flag the files differ.
  in-scope
- [ ] Committed fixture `test/fixtures/tall-page.pdf` (1398 x 6874 pt, textless, two images so the render path is used). Default `--page-images`: the page render reports `requestedDpi: 150`, `dpi: 92`, and `Notes:` carries one clamp line for it. With `--max-render-px 50000000` the same page renders at 150 dpi and no clamp line is written.
  deviates: the ceiling is fixed at 50,000,000 px and there is no `--max-render-px` (Design 4) - this fixture at 150 dpi is 41.7 Mpx and renders unclamped by default; the clamp report is exercised on the same fixture at `--image-dpi 300` (Tests 4). The report fields `requestedDpi`/`dpi` and the clamp `Notes:` line are Design clauses.
- [ ] `hideAnnotations` and `maxRenderPx` are settable in the tool, the CLI, `quiver.docToMd` settings and the generated Claude skill `skills/doc-to-md/SKILL.md`; `doc/doc-to-md.md` documents the native-image rule, both options and the clamp report.
  deviates: `maxRenderPx` does not exist (Design 4); `hideAnnotations` ships on all four surfaces and the doc covers the native rule, the option, the clamp report and the raster worker.

## Design

Layers stay where they are: `scripts/doc_to_md.py` gains the native path, the raster worker and the report fields; `lib/doc-to-md-options.ts` the option; `lib/doc-to-md-core.ts` forwards the new child fields; `lib/doc-to-md-handle.ts` prints them; `bin/pi-quiver.ts` exposes `--hide-annotations`; `extensions/doc_to_md.ts` keeps deriving its schema from `DOC_TO_MD_OPTIONS`.

### 1. The raster worker

Every decode-bearing PyMuPDF call the main child owns on a PDF page runs in one `multiprocessing` child created with the `spawn` context (never `fork`: PyMuPDF holds C state), started lazily on the first job and reused for the conversion. The worker entry is a function in `scripts/doc_to_md.py` (the only Python file the tarball ships besides `docx_numbering.py`; `spawn` re-imports the module by path, and `main()` already sits behind `if __name__ == "__main__"`). On entry, before importing `pymupdf`, the worker runs `os.dup2(sys.stderr.fileno(), sys.stdout.fileno())` (falling back to `sys.stdout = sys.stderr` when the stream has no usable fd, as in a Windows spawn child): the main child's `contextlib.redirect_stdout(sys.stderr)` is a Python-object swap that a spawned process does not inherit, and pymupdf4llm prints warnings to stdout, which is the main child's JSON result channel. After opening the document the worker sends `{"ready": true}`; the parent waits for it under its own `RASTER_SPAWN_BUDGET_S = 30` (a constant, not overridden by the test hook) and only then sends the first job, so startup cost never eats a job budget. No ready within that budget, or the process dying first, is killed and reported as `renderer failed to start` for that job - handled like a crash, and no file can be partial since no job was sent. The worker opens the PDF once by path and keeps it; the parent never shares a `Document` across the boundary.

Jobs go over a `Pipe` as plain dicts; the worker writes output files itself and answers with a small dict:

| Kind | Input | Reply |
|---|---|---|
| `native` | `page`, `target` dir | `{ok, eligible, file, width, height}` - runs the eligibility test and extraction of Design 2; `eligible: false` carries no file |
| `render` | `page`, `dpi` (already clamped by the parent), `annots`, `clip` (optional rect, for the fallback tier's xref-less inline images), `target` path, `format` | `{ok, width, height}` |
| `images` | `page`, `dpi`, `annots`, `format`, `target` dir | `{ok, files: [name...]}` - the fallback tier's text-bearing page: `get_image_info(xrefs=True)`, `extract_image` for each xref, a clip render at the clamped dpi for each xref-less image (skipped when `clamped_dpi` is `None`), written as `img<i>.<ext>` |
| `ocr` | `page`, `lang`, `ocrDpi` (clamped by the parent, Design 4), `imageDir` staging dir, `format` | `{ok, markdown}` - the worker runs the `pymupdf4llm.to_markdown(..., use_ocr=True, force_ocr=True, ocr_dpi=...)` call that `primary_page_markdown` makes for a textless page today |
| `stop` | - | worker closes the document and exits |

With `words` (#28) on, the `ocr` job also carries `wordsSnapshot`: after OCR the worker saves that single page to `<staging>/.ocr-words-p<n>.pdf` (outside every `p<N>/` dir, so `publishStaged` can never publish it) and the parent extracts word boxes from the snapshot (same OCR run, no second pass) as soon as the job returns, deleting it in a `finally` - a killed OCR job also has its snapshot removed by the worker guard; a snapshot failure is reported as that page's `wordsErrors` entry and never affects the picture or the OCR text.

Budgets are constants, not options: `RASTER_BUDGET_S = 20` for `native` and `render` jobs; for `ocr` jobs `min(OCR_JOB_BUDGET_S = 30, remaining_ocr_budget - OCR_BUDGET_RESERVE_MS)`, where `remaining_ocr_budget` is `ocrBudgetMs` minus elapsed (which `ocr_admit` already tracks) - `ocrBudgetMs` equals `primaryTimeoutMs`, so waiting out the whole remainder would let the TS kill at 60 s fire before the parent could reap the worker and finish the page. On timeout, or when the pipe closes or the process exits without a reply, the parent `kill()`s and `join()`s the worker, unlinks the job's `target` (a kill mid-encode leaves a partial file, and `publishPageImages` moves every `pN.<ext>` under `pages/` staging without a `.done` gate), drops the reference, and the next job spawns a fresh one. A worker that catches its own exception (`RuntimeError: compression bomb detected`, a colorspace error) replies `{ok: false, error}` and stays alive. Both PDF tier functions wrap their page loop in `try/finally`; the `finally` sends `stop`, `join(timeout=2)`, then `kill()`s if still alive - a non-daemon child left waiting on its pipe would otherwise be joined at interpreter exit and hold the Node runner, which waits for subprocess close.

Covered: the native probe and extraction, textless-page renders (`textless_picture`), `--page-images` renders (`render_page_image`), the fallback tier's inline-image work on text-bearing pages (`images` job: image-info hashing, stream extraction and xref-less clip renders), and inline OCR of textless pages in `pdf-primary`. `page_stats` (metadata only, no `xrefs`) stays in the parent. Not covered, stated as residuals in `doc/doc-to-md.md`: pymupdf4llm's image clips on text-bearing pages (in-process, 150 dpi, no cap - small renders, not the full-page rasters where bombs bite); `mode_image` (`pymupdf.Pixmap(path)` plus OCR of a one-page PDF built from the input, in-process); the `ocr-pages` child (#26 owns its isolation at the TS level); Excel `render-pages` (LibreOffice-produced PDFs, no toxic-page history).

Worker test hooks, honored only inside the worker: `DOC_TO_MD_RASTER_STALL_PAGE=<n>` sleeps 3600 s on every job for page `n`, `DOC_TO_MD_RASTER_STALL_PAGE=<kind>:<n>` (e.g. `ocr:2`) only on that job kind; `DOC_TO_MD_RASTER_CRASH_PAGE=<n>` writes half of the target file then calls `os._exit(1)` on page `n`; `DOC_TO_MD_RASTER_BUDGET_S` overrides `RASTER_BUDGET_S` and `OCR_JOB_BUDGET_S` so tests do not wait 20 s. Naming follows #26's `DOC_TO_MD_OCR_STALL_PAGE`.

### 2. Native extraction for a single full-page image

In both PDF tiers, a textless page (`page.get_text("text").strip() == ""`) first gets a `native` job. Inside the worker, the page is eligible when:

1. `page.get_image_info(xrefs=True)` has exactly one entry, with `xref > 0` (this call hashes pixels, which is why it runs in the worker and not in `page_stats`);
2. `page.get_drawings()` is empty (no vector overlay - a scan with vector corrections keeps them only in a render); with `hideAnnotations` set, drawings whose bounding box lies inside an annotation or widget rectangle (grown by 1 pt) are the annotation's own appearance and do not count - page content drawn inside such a rectangle is therefore missed, a documented blind spot;
3. the entry's `transform` has `b == c == 0`, `a > 0` and `d > 0` (no rotation, skew or mirroring; a 180-degree placement has negative `a`/`d`), and `page.rotation == 0`;
4. `area(bbox & page.rect) / area(page.rect) >= 0.9` and `area(bbox) / area(page.rect) <= 1.1` (fills the page, is not a bleed the page crops away);
5. `doc.extract_image(xref)` returns `smask == 0`, `ext` in `{"png", "jpeg", "jpg"}`, non-empty `image` bytes, and `cs-name` in `{"DeviceRGB", "DeviceGray"}`, or `"DeviceCMYK"` only when `ext` is JPEG (a CMYK JPEG is a valid standalone file; a CMYK PNG stream is not). `colorspace` is the component count, not the name.
6. unless `hideAnnotations` is set, the page has no annotations and no form widgets (`page.first_annot is None and page.first_widget is None`) - a scan with a filled field or a stamp keeps the painted render, since annotations hold user data the default run promises to paint.

Eligible: the worker writes the bytes untouched to `p<n>/page.<ext>` in the page's staging dir and replies `{eligible: true, file, width, height}` with the dimensions `extract_image` reports. The parent writes `![page N](p<n>/page.<ext>)` where the render link goes today, and records `nativeImages += {page, file, width, height}`. No DPI, no clamp, no `requestedDpi`.

Ineligible, or the native job failing for any reason (several images, vector content, a logo on an otherwise blank page, a rotated, mirrored or masked image, an exotic colorspace, `extract_image` raising, the job timing out): the page takes the render path. Eligibility is a hint and the render is the contract. A timed-out or crashed native job still costs its page nothing more than a respawn before the render job.

### 3. Report fields

Child result (`TierJson`, both PDF tiers): `nativeImages: [{page, file, width, height}]`; `pageImages` entries become `{page, file, dpi}` plus `requestedDpi` when `dpi < requestedDpi`. Each clamped render - textless-page picture or `pages/` render - adds one line to the tier's existing `notes`: `Page 3 rendered at 164 dpi (requested 300; 50 Mpx ceiling)`, which `lib/doc-to-md-core.ts` already turns into Markdown `Notes:` lines and handle notes. There is no separate clamp summary line in the handle: the Notes block already appears there.

`mark_done(d, meta)` writes the page's entry JSON (`{"native": {...}}`, `{"dpi": 150, "requestedDpi": 300}` or `{}`) into `p<n>/.done` instead of an empty marker, so when the primary tier dies after finishing some pages and the fallback tier runs with `keepPages`, `publishStaged` (`lib/doc-to-md-bundle.ts`) can return the retained pages' metadata along with their filenames and the handle still classifies them. `lib/doc-to-md-core.ts` merges child `nativeImages` with retained-page metadata into `HandleData.nativeImages: {page, file, width, height}[]` with `file` the published path; `formatHandle` prints `Native-Images: pages 1-4 (embedded image streams, no render DPI)` after `Pages-Dir:`/`Page-Stats:`, omitted when empty. The `--json` CLI output and the tool `details` carry `nativeImages` as part of `HandleData`.

### 4. One ceiling

`MAX_RENDER_PX` becomes `50_000_000` (a 150 MB RGB pixmap at the limit; A3 at 300 dpi is 17.4 Mpx, A0 at 150 dpi is 24 Mpx, the ticket's tall page at 150 dpi is 41.7 Mpx). It stays a fixed constant: the guard protects the host's memory, and a caller who wants a bigger picture asks for the native stream, not a bigger raster. There is no `maxRenderPx` option.

The parent computes `eff = clamped_dpi(w, h, imageDpi)` for render jobs and `ocrDpi = clamped_dpi(w, h, OCR_DPI = 300)` for OCR jobs (today's inline OCR leaves pymupdf4llm's `ocr_dpi` at its 300 default, which on the tall fixture would be a 167 Mpx raster; the OCR clamp is not reported - it affects recognized text, not a delivered image). `render-pages` (Excel) keeps its `MIN_PAGE_PT` check (its "degenerate" reason) and then calls `clamped_dpi` instead of duplicating the math; `image_ocr_dpi` and `mode_ocr_pages` keep using the constant, so the raise applies to every raster path. `clamped_dpi` returning `None` keeps today's behavior (no render, counted in `Page images: N of M unavailable`). A `.done` whose content is not a JSON object (truncated write, hand edit) reads as `{}`: the page still publishes, only its metadata is lost.

### 5. `hideAnnotations`

`DOC_TO_MD_OPTIONS` gains `{ key: "hideAnnotations", flag: "--hide-annotations", type: "bool", default: false, settable: true }`, registered in `QUIVER_CONFIG_KEYS`; help: `Render PDF pages without annotations (sticky notes, highlights, stamps - and form-field widgets, so filled form values disappear); default paints them, as PyMuPDF does. Applies to pages/ renders and textless-page renders, not to OCR text or embedded images; also lets an annotated scan be delivered as its embedded image.` The parent passes `annots = not hideAnnotations` on every `render` job. Annotations stay painted by default because form values live in widget annotations and the ticket's own test requires the default to differ from the clean fixture. Native streams never carry annotations; the OCR job cannot take the flag (pymupdf4llm exposes no switch), so recognized text may include annotation text - stated in the help and the doc.

### 6. `--page-images`, native pages, and the retained bundle contract

Design 4 of the #25 spec suppressed the textless-page picture when `pageImages` was on, because both were renders of the same thing. They are now different artifacts: a textless page with an eligible native image yields the native stream in `images/` **and** the `pages/` render (annotations per `hideAnnotations`), with the Markdown carrying both links in that order; when inline OCR text exists, its `ocr_block` cites the native file (the page's own pixels). The dedupe survives only for the raster case: an ineligible textless page under `--page-images` gets the `pages/` render alone, as today.

Retained from #25, restated so the examples below are checkable: page assets stage as `p<n>/<name>` behind a `.done` marker and publish as `images/<stem>-p<n>-<i>.<ext>` (`i` = 1-based position in the sorted staging dir, so the native file is `images/single-image-page-p1-1.jpeg`); page renders stage as `pages/p<n>.<fmt>` and publish as `pages/<stem>-p<NNN>.<fmt>` with `NNN` zero-padded to the document's page-count width (a one-page document gets `pages/single-image-page-p1.png`).

## Errors and edge cases

Errors 1-3 describe jobs whose output is the page's content: the textless picture and the fallback tier's inline-image work. A failed `pages/` render job leaves the page's text and content images intact, so it is not a failed page: the render is counted in `Page images: N of M unavailable` and the cause is kept as a note, `Page 3 render unavailable: render timed out after 20s`.

1. Worker timeout: `failedPages += {page, error: "render timed out after 20s"}` (or `"OCR timed out after <n>s"` - see 5); the page keeps its `--- end of page ---` marker, gets no file and no image link; its `pageStats` row (computed in the parent, metadata only) is unaffected. The Markdown header shows `Failed pages: 1 (render timed out after 20s)` and the handle `Failed-Pages: 2`, as for any failed page today.
2. Worker crash (pipe closed, exit without reply - the `get_pixmap` C++ abort): `failedPages += {page, error: "renderer crashed"}`; the partial target is unlinked; same handling. A worker that never reports ready (startup timeout or death before ready) yields `renderer failed to start` for the job that spawned it, same handling, no partial file.
3. Worker exception caught in Python: `failedPages += {page, error}` with the worker's message; no respawn.
4. Worker cannot be spawned (`multiprocessing` unavailable under the interpreter): the tier fails with `raster worker unavailable: <exc>`; the fallback tier tries the same and fails the same way; the TS failure path is unchanged.
5. OCR job timeout or failure marks the page `ocrFailed` and the page continues as render-only, matching today's inline OCR exception path; the time spent counts against the OCR budget. The `failedPages` entry is not written for an OCR failure - the page still delivers its picture.
6. Tier semantics are unchanged: a tier with some failed pages returns success with `failedPages`, so the fallback tier is not invoked and does not retry a dropped page; a tier whose every selected page failed raises (`every selected page failed: ...`), the fallback runs, hits the same pages, and the conversion fails - bounded by `2 x pages x RASTER_BUDGET_S` and the two tier timeouts. A `--page-images` page costs at most three budgets (native, textless render, page render); a document with many toxic pages still trips `primaryTimeoutMs` at 60 s and is reported by the existing tier timeout.
7. A page whose single image is a logo (< 90% coverage), a scan placed with any rotation or mirroring, a bleed larger than 110% of the page, or an image under a vector overlay, or an annotated or widget-bearing scan (default run) renders.
8. `--page-images` without a native image under `hideAnnotations`: unchanged behavior except `annots=False`.
9. Excel `render-pages`: same ceiling via `clamped_dpi`; no clamp line is added to sheet sections (the ticket is PDF; `rendered[].dpi` already reports the effective value).
10. `--info` is unaffected; `hideAnnotations` with `--info` is accepted and ignored like `imageDpi`.
11. The native file's extension follows the stream (`.jpeg` for DCT), not `imageFormat`; `imageFormat` keeps governing renders only, as its help already says for embedded images.
12. Primary tier dies after finishing pages: the fallback tier receives `keepPages`; retained pages keep their native/clamp metadata through `.done` (Design 3) and are not regenerated, as today.

## Tests

Fixtures from `test/fixtures/generate.py`, committed: `single-image-page.pdf` (one 2000 x 2800 JPEG filling the page), `annotated.pdf`, `annotated-clean.pdf`, `tall-page.pdf` (names and contents from the ticket rows), `logo-page.pdf` (one 200 x 200 px image on a blank page), `overlay-page.pdf` (full-page image plus one vector line), `rotated-page.pdf` (full-page image placed with a 180-degree transform), `textless-3.pdf` (three full-page-image pages).

1. `single-image-page.pdf`, both tiers, defaults: `images/single-image-page-p1-1.jpeg` is 2000 x 2800 and byte-equal to the embedded stream; child `nativeImages` lists page 1; handle prints `Native-Images: page 1 ...`; `--json` and tool `details` carry `nativeImages[0] = {page: 1, file, width: 2000, height: 2800}`; no clamp note.
2. Same fixture with `--page-images`: `images/single-image-page-p1-1.jpeg` and `pages/single-image-page-p1.png` both exist; Markdown links both, native first; with `--ocr` and Tesseract present the OCR block cites the native file.
3. `logo-page.pdf`, `overlay-page.pdf`, `rotated-page.pdf`: render path, no `nativeImages`, `pageImages` entry `dpi: 150` without `requestedDpi` under `--page-images`.
4. `tall-page.pdf --page-images --image-dpi 300`: entry `requestedDpi: 300`, `dpi: 164`, one `Notes:` line `Page 1 rendered at 164 dpi (requested 300; 50 Mpx ceiling)`; with default dpi the entry is `dpi: 150` and no clamp line.
5. `annotated.pdf --page-images --hide-annotations` produces a `pages/` file byte-identical to `annotated-clean.pdf --page-images`; without the flag the two differ.
6. `textless-3.pdf` with `DOC_TO_MD_RASTER_STALL_PAGE=2 DOC_TO_MD_RASTER_BUDGET_S=2`: conversion succeeds on the primary tier, `failedPages: [{page: 2, error: "render timed out after 2s"}]`, pages 1 and 3 have images, wall time under 15 s, the Python child exits on its own (no TS kill).
7. `DOC_TO_MD_RASTER_CRASH_PAGE=2` on the same fixture: `renderer crashed` for page 2, no partial file under `images/` or `pages/`, pages 1 and 3 delivered by a respawned worker.
8. OCR stall: `textless-3.pdf --ocr` with `DOC_TO_MD_RASTER_STALL_PAGE=ocr:2 DOC_TO_MD_RASTER_BUDGET_S=2` (Tesseract present): page 2 in `ocrFailed`, its picture delivered, pages 1 and 3 OCR'd, primary tier returns.
9. Worker stdout: a worker job that prints to stdout (test hook on the stall page env var's sibling, or a fixture that triggers pymupdf4llm's legacy-mode warning) does not corrupt the main child's result JSON.
10. Primary failure after native pages: `single-image-page.pdf` concatenated with a page that fails primary text extraction (existing `pdf-fallback` trigger fixture pattern): the fallback tier runs with `keepPages`, and the handle still lists page 1 under `nativeImages`.
11. `test/doc-to-md-options.test.ts`, `test/extension-config.test.ts`, `test/skill-generation.test.ts`, `test/doc-to-md-cli.test.ts`: `hideAnnotations` on every surface, `--help` row, regenerated skill without drift.
12. `test/doc-to-md-handle.test.ts`: `Native-Images:` line, omission when empty.
13. Existing Excel `render-pages` test on the A4 `multipage.pdf` at 600 dpi (34.8 Mpx) now expects `dpi == 600`; the clamp itself is covered by Tests 4. The `render-pages` "degenerate" reason test is unchanged.

Python-backed tests stay `uv`-gated as today.

## Documentation impact

Per `reference/documentation-impact.md`:

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/doc-to-md.md` - option row for `hideAnnotations`; 16 Mpx -> 50 Mpx in the Excel paragraph and the `imageDpi` row; the Backend ladder's textless-page sentence gains the native rule; a new section "Raster isolation" (why a spawned worker, the fixed budgets, what `Failed pages` says, the four residuals) under operations/non-obvious rationale; the child-protocol paragraph gains `nativeImages`, the `dpi`/`requestedDpi` entry fields, the `.done` metadata and the three env hooks. `README.md` - `hideAnnotations` row, 16 Mpx -> 50 Mpx at both mentions, one clause in the `doc_to_md` row for native page images. `CHANGELOG.md` - deferred: release.
- Derived / memory docs invalidated: `skills/doc-to-md/SKILL.md` (generated - rerun `node scripts/gen-skill.mjs`); `AGENTS.md` layout line for `scripts/doc_to_md.py` gains "and its spawned raster worker".

## Out of scope

- A `maxRenderPx` option or any user-tunable render ceiling or per-page budget.
- Isolating pymupdf4llm's text pass or its inline image clips; isolating `mode_image`, `ocr-pages` (#26) or Excel `render-pages`.
- Choosing a content image among several on a page; word positions (#28); OCR quality.
- A clamp line in Excel sheet sections; reporting the OCR raster clamp.
- Reconstructing a rotated, mirrored, cropped, overlaid or masked page image natively.
- Flattening annotations into a native stream.

## Open questions

None.
