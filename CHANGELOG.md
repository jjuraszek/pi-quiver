# Changelog

Format follows sibling pi packages (e.g. [`pi-context-prune`](https://github.com/jjuraszek/pi-context-prune/blob/main/CHANGELOG.md)):
one entry per `vX.Y.Z` tag, newest first, terse bullets, dated.

This package is consumed via git tag pins (`git:github.com/jjuraszek/pi-essentials@vX.Y.Z`).
The release helper at `.agents/skills/release/scripts/release.sh` cuts the tag and
automatically rewrites every `~/.pi/agent*/settings.json` that pins this repo.

## v2.0.1 — 2026-06-18

- **`session-name`: keep the Ghostty tab in sync with the session name.** Pi owns the OS terminal title (OSC 0, `pi - <name> - <cwd>`) and rewrites it on every name change and session switch, clobbering our short OSC-2 tab label. The extension now re-asserts the tab label at the start of every turn (`turn_start`) — the only hook that fires after pi's writer on a session swap — so the tab and the session name move together. Self-heals when the name is changed outside the extension (re-derives the label from the new name) and reflects names on reload as well as resume. No behavior when OFF (default).

## v2.0.0 — 2026-06-16

- **New `session-name` extension.** Names work sessions; **OFF by default**.
  - **Manual `/session-name [name]`** sets or prints the session name; always available regardless of config. A manual name suppresses later auto-naming.
  - **Automatic naming (opt-in):** after the first agent turn, asks the current model for a 3-6 word session title + 1-4 word tab label and applies both, once per session, never overwriting an existing name. Also re-applies the tab label when a named session is resumed.
  - **Ghostty tab rename** via OSC 2, fired only when the active terminal is really Ghostty (`TERM_PROGRAM=ghostty` / `TERM=xterm-ghostty` / `GHOSTTY_*` dir env) and stdout is a TTY.
  - **Config `sessionAutoName`** in `settings.json` (`{ "enabled": bool, "ghosttyTab": bool }` or boolean shorthand); project `.pi/settings.json` overrides the global layer. The global `settings.json` is located via pi's `getAgentDir()` (honours `PI_CODING_AGENT_DIR`), so it resolves correctly when installed as a git-tag-pinned package — replacing the previous `import.meta.url` heuristic that only worked for in-tree `extensions/` files.
  - **Cost:** when enabled, one extra short LLM call per session (low reasoning effort), once. When OFF (default): no model calls, no terminal writes.
- **New `sword-header` extension.** Replaces the TUI startup logo with a theme-colored ASCII greatsword; **OFF by default**, installed only when enabled via `settings.json` (`swordHeader: true` or `{ "enabled": true }`). `/builtin-header` restores the built-in header at runtime. TUI-only (no-op under `-p`).
- **New runtime dependency:** `@earendil-works/pi-ai` (peer; matches the host pi runtime).
- **New shared module `extension-config.ts`:** `getAgentDir()`-based global + project `.pi/settings.json` layering (`resolveConfig`), used by both `session-name` and `sword-header`.

## v1.0.0 — 2026-06-15

- **New `doc_to_md` extension.** Converts a local PDF/DOCX/PPTX to Markdown.
  - **Primary engine `pymupdf4llm`** (high fidelity) run as an arms-length subprocess via `uv run --with pymupdf4llm==<pin> --python 3.14` — no project venv, wheel fetched into uv's cache on first use, Python pinned to 3.14. Warmed once per process (generous install budget, then a short per-document budget).
  - **Fallback engine `unpdf`** (pure JS) when `uv` is absent, the warm probe fails, or a conversion times out. Degraded output is marked and carries a `Fallback-Reason:`.
  - **DOCX/PPTX** convert to PDF via headless LibreOffice (`soffice`, isolated per-call profile) then through the same PDF pipeline; missing `soffice` errors office inputs only. Spreadsheets/other formats out of scope.
  - **Size-gated** like `fetch` (≤ 32 KB and ≤ 1000 lines inline, else spill to `${TMPDIR}/pi-doc-to-md/` with a preview).
  - **Config via env vars:** `PI_DOC_TO_MD_PYMUPDF_VERSION` (default `1.27.2.3`), `PI_DOC_TO_MD_WARM_TIMEOUT_MS` (120000), `PI_DOC_TO_MD_CONVERT_TIMEOUT_MS` (60000), `PI_DOC_TO_MD_SOFFICE_TIMEOUT_MS` (120000).
  - **AGPL note:** PyMuPDF/pymupdf4llm are AGPL-3.0; no code is shipped (uv fetches the wheel at runtime) and it runs as a separate subprocess, keeping pi-essentials MIT.
- **`fetch`:** map OOXML content types (`...wordprocessingml.document`, `...presentationml.presentation`) to `.docx`/`.pptx` so fetched office docs are saved with the correct extension for the `fetch` → `doc_to_md` chain.
- **New runtime dependency:** `unpdf`. Optional system binaries `uv` and `soffice` are detected at runtime.

## v0.2.0 — 2026-06-03

- **Content routing rewrite.** `fetch` now classifies responses by type and routes them:
  - **HTML → Markdown:** Mozilla Readability extracts main content (strips nav/boilerplate), Turndown converts to Markdown with GFM plugin (pipe tables, fenced code, ATX headings). Page title becomes `#` heading.
  - **Binary (images, PDFs, archives, fonts, audio/video):** Streamed untouched to `${TMPDIR}/pi-fetch/` without decoding. NUL-byte sniff in first ≤64 KB detects mislabeled payloads. Download cap raised to **50 MB**. Returns file path only, no preview.
  - **Text / JSON:** Pretty-printed (JSON: 2-space indent). Inline gate tightened to **≤ 32 KB and ≤ 1000 lines**; larger content spills to file with preview + grep-able Markdown headings. Parsable download cap remains **1 MB**.
- **Truncation notes:** Parsable content over 1 MB notes truncation; binary over 50 MB notes truncation.
- **Parameters:** `raw=true` skips HTML→Markdown and JSON pretty-printing (still subject to size gate).
- **New runtime dependencies:** `jsdom`, `@mozilla/readability`, `turndown`, `turndown-plugin-gfm`. Pi installs them automatically via git tag pin.

## v0.1.0 — 2026-06-02

- Initial release. Extracts the personal `fetch` extension out of the per-profile
  `~/.pi/agent*/extensions/` dirs into a versioned, tag-pinned package.
- **`fetch` context hygiene:** bodies over 50 KB or 2000 lines are written to
  `${TMPDIR}/pi-fetch/` and returned as a preview + file path instead of being
  inlined whole. Small bodies are returned inline unchanged. Download stays
  capped at 1 MB. Prevents a single fetch from flooding the context window.
