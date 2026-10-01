---
name: doc-to-md
description: Convert a local supported document or email to a Markdown bundle on disk; a handle is returned. Invoke via Bash.
---

# Convert a document to Markdown

Supported formats: .pdf .docx .pptx .xlsx .xls .xlsm .doc .msg .eml .html .htm .png .jpg .jpeg .tif .tiff .bmp .gif.

```bash
npx -y pi-quiver@6.8.0 doc-to-md --info <path>                       # page count, TOC or sheet inventory first
npx -y pi-quiver@6.8.0 doc-to-md <path>                              # whole document
npx -y pi-quiver@6.8.0 doc-to-md --pages 12-15 --output-dir ./out <path>
npx -y pi-quiver@6.8.0 doc-to-md <workbook.xlsx>                     # sheet inventory, per-sheet CSV, preview, rendered charts (soffice optional)
npx -y pi-quiver@6.8.0 doc-to-md --primary-timeout 180000 <path>     # stubborn PDF
npx -y pi-quiver@6.8.0 doc-to-md --page-images --json <path>          # rendered pages and a JSON handle
```

A handle looks like:

```text
Saved-To: /abs/out/manual.md
Images-Dir: /abs/out/images
Type: pdf   Engine: pymupdf4llm   Tier: primary
Page-Count: 42   Pages: 3-5   Images: 4   Size: 18.2KB / 412 lines
Outline:
  L12  # Installation
```

Then `read` the `Saved-To` file (offset/limit); images live under `Images-Dir` when the handle reports it.

Exit codes: `0` success (including degraded fallback), `1` runtime error, `2` usage error.

`npx -y pi-quiver@6.8.0 doc-to-md --help` lists every flag.

## Flags

| Flag | Meaning |
|---|---|
| `--json` | Print the handle as one JSON object (CLI only) |
| `--info` | Inspect only (page count, metadata, TOC or sheet inventory); no bundle |
| `--pages` | Inclusive 1-based pages, e.g. "12-15" or "3,7,10-12" (PDF/DOCX/DOC/PPTX only); default all; "" means all pages. DOCX: selects explicit-page-break segments; rejected when the file has none |
| `--output-dir` | Bundle root for <stem>.md + images/; default a per-call temp dir. <stem> = basename without extension with [^A-Za-z0-9._-]+ -> _ (empty -> document); a second call on the same stem writes <stem>-2.md |
| `--overwrite` | Replace an existing completed <stem>.md bundle |
| `--page-images` | Also render every selected page to pages/<stem>-pNNN.<imageFormat> at imageDpi (PDF, PPTX, .doc, DOCX via LibreOffice); off by default |
| `--ocr-mode` | OCR policy: textless (default) OCRs only pages with an empty text layer, inline; all OCRs every selected page and writes the recognized text to ocr/<stem>-pNNN.md sidecars, leaving the Markdown untouched. all requires --ocr and an explicit --pages selection (PDF, PPTX, DOC). (default `textless`) |
| `--primary-timeout` | pymupdf4llm tier and DOCX child (docx mode); also the unpdf tier (default `60000`) |
| `--fallback-timeout` | PyMuPDF get_text tier (including DOCX LibreOffice fallback); also PDF and DOCX info and Excel rendered views (default `30000`) |
| `--soffice-timeout` | DOCX/PPTX -> PDF via LibreOffice; also Excel rendered views (default `120000`) |
| `--excel-timeout` | Excel child (both openpyxl loads); also info on Excel (default `60000`) |
| `--warm-timeout` | Absolute backend discovery/bootstrap deadline (first call per process) (default `120000`) |
| `--pymupdf-version` | pymupdf4llm pin (>= 1.27.0) (default `1.27.2.3`) |
| `--image-dpi` | Render DPI for page images and Excel rendered views (default `150`) |
| `--image-format` | Rendered image format (embedded images keep their native extension) (default `png`) |
| `--max-output-bytes` | Child stdout cap in bytes (default `20000000`) |
| `--outline-max-entries` | Heading outline / TOC / sheet inventory cap in the handle (default `40`) |
| `--ocr` | Run OCR on pages without a text layer and on image inputs when Tesseract language data is installed; off by default (--no-ocr turns a settings-level true off) |
| `--ocr-language` | Tesseract language code(s), +-joined, e.g. deu+eng (default `eng`) |

## Usage patterns

```text
Two-pass OCR (PDF, PPTX, DOC):
  1. npx -y pi-quiver@6.8.0 doc-to-md report.pdf --output-dir out --json
       -> "pageStatsPath" points at out/report.pages.json; pages with few
          chars and high imageCoverage are scans. "savedTo" is the Markdown.
  2. npx -y pi-quiver@6.8.0 doc-to-md report.pdf --output-dir out --ocr --ocr-mode all --pages 2,7 --json
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
