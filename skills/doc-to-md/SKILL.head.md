---
name: doc-to-md
description: Convert a local supported document or email to a Markdown bundle on disk; a handle is returned. Invoke via Bash.
---

# Convert a document to Markdown

Supported formats: {{FORMATS}}.

```bash
npx -y pi-quiver@{{VERSION}} doc-to-md --info <path>                       # page count, TOC or sheet inventory first
npx -y pi-quiver@{{VERSION}} doc-to-md <path>                              # whole document
npx -y pi-quiver@{{VERSION}} doc-to-md --pages 12-15 --output-dir ./out <path>
npx -y pi-quiver@{{VERSION}} doc-to-md <workbook.xlsx>                     # sheet inventory, per-sheet CSV, preview, rendered charts (soffice optional)
npx -y pi-quiver@{{VERSION}} doc-to-md --primary-timeout 180000 <path>     # stubborn PDF
npx -y pi-quiver@{{VERSION}} doc-to-md --page-images --json <path>          # rendered pages and a JSON handle
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

Convert without OCR first and read `Page-Stats` to pick the pages that need OCR. Keep each OCR call within `quiver.docToMd.ocrMaxPages` (default 10, settings-only; no tool parameter or CLI flag). For forced OCR, use `ocrMode: "all"` (`--ocr-mode all`) with an explicit distinct-page selection within the ceiling; a larger selection is rejected before any work. In textless mode, expect OCR on only the first `ocrMaxPages` textless pages, and read the `OCR:` line for the remaining pages and the selection to rerun.

Exit codes: `0` success (including degraded fallback), `1` runtime error, `2` usage error.

`npx -y pi-quiver@{{VERSION}} doc-to-md --help` lists every flag.
