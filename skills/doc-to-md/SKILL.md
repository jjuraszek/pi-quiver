---
name: doc-to-md
description: Convert a local PDF, DOCX, or PPTX file to Markdown via the quiver doc-to-md CLI - use for reading document files instead of raw text extraction. High fidelity via pymupdf4llm when uv or Python 3.12+ is available; explicit degraded fallback otherwise. Invoke via Bash.
---

# Convert a document to Markdown

Run:

```bash
npx -y pi-quiver@latest doc-to-md <path>
```

One positional argument: a local `.pdf`, `.docx`, or `.pptx` path (for URLs, fetch first, then pass the saved temp path). No flags.

Behavior:

- High-fidelity conversion (headings, tables, reading order) runs through pymupdf4llm, resolved automatically: `uv` if installed, else a system Python >= 3.12 that already has `pymupdf4llm`, else a one-time managed venv bootstrapped into the user cache dir (first such call downloads ~40MB).
- No uv and no Python 3.12+ -> conversion still succeeds but **degraded** (pure-JS text extraction): the output is explicitly marked `[Note: degraded extraction via unpdf ...]` with a `Fallback-Reason:` line. Tables/headings are not preserved - treat structure with suspicion. On Windows, Python exposed only through the `py` launcher is not detected (known limitation) - install `uv` or expose `python`/`python3`.
- `.docx`/`.pptx` require LibreOffice (`soffice` on PATH); without it the command fails with an actionable install message. PDFs are unaffected.
- Output over 32KB or 1000 lines is written to a temp file; stdout then carries `Saved-To: <path>` plus a 60-line preview. Read slices of that file (offset/limit) or grep it.

Exit codes: `0` = converted (including degraded output - check for the degraded marker), `1` = conversion failed (missing file, unsupported extension, LibreOffice missing for office formats), `2` = usage error.

Requires Node.js (the `npx` runner); `uv`, Python, and LibreOffice are optional runtime enhancers.
