# doc_to_md - local document -> Markdown

`doc_to_md` takes a **local file path** (`.pdf`, `.docx`, `.pptx`) and returns Markdown. For remote documents, `fetch` the URL first (it saves binaries to a temp path), then pass that path here.

## Two engines, auto-selected

- **Primary - `pymupdf4llm`** (high fidelity: headings, tables, reading order). Runs as an arms-length subprocess via `uv run --with pymupdf4llm==<pin> --python 3.14`. `uv` fetches the wheel into its own cache on first use (one-time download); Python 3.14 is fixed. Warmed once per process: the first call probes/installs (generous budget), later calls reuse the warm cache with a shorter per-document budget.
- **Fallback - `unpdf`** (pure JS, bundled PDF.js). Used when `uv` is not on `PATH`, the warm probe fails, or a conversion times out. Output is plain text with page breaks - **no faithful tables/headings**. Degraded results are marked in the output (`[Note: degraded extraction via unpdf ...]`) and carry a `Fallback-Reason:` line.

## Office documents (`.docx`, `.pptx`)

Converted to PDF by headless LibreOffice (`soffice`, isolated per-call profile), then fed through the same PDF pipeline. `soffice` must be on `PATH` for office inputs - otherwise the tool errors (there is no JS fallback for office->PDF). Spreadsheets and other formats are out of scope (spreadsheets paginate badly via PDF).

## Size gate

Identical to `fetch` - Markdown <= 32 KB and <= 1000 lines is inlined; larger output spills to `${TMPDIR}/pi-doc-to-md/<stamp>-<basename>-<hash>.md` with a 60-line preview + a grep/read-slice hint.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PI_DOC_TO_MD_PYMUPDF_VERSION` | `1.27.2.3` | `pymupdf4llm` version pin passed to `uv --with` (digits/dots only) |
| `PI_DOC_TO_MD_WARM_TIMEOUT_MS` | `120000` | Warm/install call budget - covers the cold wheel (+ managed Python) download |
| `PI_DOC_TO_MD_CONVERT_TIMEOUT_MS` | `60000` | Per-document conversion budget (also bounds the `unpdf` fallback) |
| `PI_DOC_TO_MD_SOFFICE_TIMEOUT_MS` | `120000` | LibreOffice `.docx`/`.pptx` -> PDF budget |

Python is pinned to **3.14** and is not configurable.

## Runtime dependencies

`unpdf` (shipped in the npm package, installed automatically on `pi install`). `uv` and LibreOffice (`soffice`) are optional system binaries detected at runtime: without `uv`, PDFs still convert via the `unpdf` fallback; without `soffice`, office inputs error while PDFs are unaffected. See the README's [Prerequisites](../README.md#prerequisites) for the consolidated list.

## Licensing note

`pymupdf4llm`/PyMuPDF are **AGPL-3.0**. This package ships none of their code - `uv` downloads the wheel from PyPI onto your machine at runtime, and it runs as a **separate subprocess** (never imported or linked into this TypeScript). The arms-length process boundary keeps pi-quiver's MIT license intact; the AGPL governs PyMuPDF itself, whose source is public. This holds only while the boundary stays subprocess-only (no vendoring/importing the wheel).
