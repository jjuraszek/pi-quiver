---
name: doc-to-md
description: Convert a local PDF, DOCX, PPTX, XLSX, or XLS file to a Markdown bundle on disk; a handle is returned. Invoke via Bash.
---

# Convert a document to Markdown

PDF/DOCX/PPTX/XLSX/XLS -> Markdown bundle on disk; handle returned.

```bash
npx -y pi-quiver@latest doc-to-md --info <path>                       # page count, TOC or sheet inventory first
npx -y pi-quiver@latest doc-to-md <path>                              # whole document
npx -y pi-quiver@latest doc-to-md --pages 12-15 --output-dir ./out <path>
npx -y pi-quiver@latest doc-to-md <workbook.xlsx>                     # sheet inventory, per-sheet CSV, preview, rendered charts (soffice optional)
npx -y pi-quiver@latest doc-to-md --primary-timeout 180000 <path>     # stubborn PDF
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

`npx -y pi-quiver@latest doc-to-md --help` lists every flag.
