# pi-quiver

A small pack of [Pi coding-agent](https://github.com/badlogic/pi-mono) extensions I keep across every pi profile. First-party-quality tools, published to npm like sibling packages ([`pi-cohort`](https://github.com/jjuraszek/pi-cohort), [`pi-superpowers`](https://github.com/jjuraszek/pi-superpowers)).

## Extensions

| Extension | Tool | What it does |
|---|---|---|
| `fetch.ts` | `fetch` | Retrieve URLs over HTTP(S). HTML → Markdown (main-content extraction, stripped boilerplate). Binary content saved untouched to a temp file. **Context-safe:** output over 32 KB or 1000 lines is written to a temp file with a preview + file path. Prevents a single fetch from flooding the context window. |
| `doc_to_md.ts` | `doc_to_md` | Convert a local PDF/DOCX/PPTX to Markdown. High-fidelity via `pymupdf4llm` (run through `uv`, fetched on first use); degraded pure-JS fallback (`unpdf`) when `uv`/Python is unavailable or conversion times out. DOCX/PPTX convert via LibreOffice (`soffice`) to PDF first. Same 32 KB / 1000-line size gate as `fetch`. |
| `session-name.ts` | `/session-name` | Name work sessions. Manual `/session-name [name]` always works. **OFF by default:** when opted in via `settings.json`, after the first agent turn it asks the current model for a concise session name + short tab label and applies them, and renames the **Ghostty** tab via OSC 2 (only when the active terminal is really Ghostty), re-asserting it each turn so the tab tracks the session name. |
| `sword-header.ts` | `/builtin-header` | Replace the TUI startup logo with a theme-colored ASCII greatsword (hilt = accent, blade = text). **OFF by default:** only installs the header when opted in via `settings.json`. `/builtin-header` restores the built-in header at runtime. |

### fetch — content routing & context hygiene

`fetch` is the main way an agent pulls external bytes into context. This extension routes responses by type to keep context tight:

**HTML → Markdown:**
- Mozilla Readability extracts main content, strips navigation/chrome/boilerplate
- Turndown converts to Markdown with GFM support (pipe tables, fenced code blocks, ATX headings)
- Page title becomes a top-level `#` heading
- Download cap: **1 MB**

**Binary (images, PDFs, archives, fonts, audio/video) → temp file:**
- Streamed untouched to `${TMPDIR}/pi-fetch/<stamp>-<host>-<hash>.<ext>` without decoding
- Detection: content-type check + NUL-byte sniff in first ≤64 KB (catches mislabeled payloads)
- Returns: status, content-type, size, file path — **no preview**
- Download cap: **50 MB**

**Text / Markdown / JSON size gate:**
- Inline when **≤ 32 KB AND ≤ 1000 lines** (converted output size)
- Otherwise **spills to file** with:
  - HTTP status, content-type, charset, byte/line counts
  - File path (`Saved-To:`)
  - 60-line preview
  - Instruction to `grep` (Markdown is grep-able by heading: `^#`) or `read` slices

**JSON:** Pretty-printed with 2-space indent before the gate.

**Parameters:**
- `raw=true`: Skip HTML→Markdown and JSON pretty-printing; return decoded body as-is (still subject to the size gate).

**Truncation:** Parsable content over 1 MB is truncated with a `(truncated to 1MB)` note; binary over 50 MB notes `(truncated to 50MB)`.

**Runtime dependencies:** `jsdom`, `@mozilla/readability`, `turndown`, `turndown-plugin-gfm`. Shipped in the npm package and installed automatically on `pi install` - no manual setup needed.

### doc_to_md — local document → Markdown

`doc_to_md` takes a **local file path** (`.pdf`, `.docx`, `.pptx`) and returns Markdown. For remote documents, `fetch` the URL first (it saves binaries to a temp path), then pass that path here.

**Two engines, auto-selected:**

- **Primary — `pymupdf4llm`** (high fidelity: headings, tables, reading order). Runs as an arms-length subprocess via `uv run --with pymupdf4llm==<pin> --python 3.14`. `uv` fetches the wheel into its own cache on first use (one-time download); Python 3.14 is fixed. Warmed once per process: the first call probes/installs (generous budget), later calls reuse the warm cache with a shorter per-document budget.
- **Fallback — `unpdf`** (pure JS, bundled PDF.js). Used when `uv` is not on `PATH`, the warm probe fails, or a conversion times out. Output is plain text with page breaks — **no faithful tables/headings**. Degraded results are marked in the output (`[Note: degraded extraction via unpdf ...]`) and carry a `Fallback-Reason:` line.

**Office documents (`.docx`, `.pptx`):** converted to PDF by headless LibreOffice (`soffice`, isolated per-call profile), then fed through the same PDF pipeline. `soffice` must be on `PATH` for office inputs — otherwise the tool errors (there is no JS fallback for office→PDF). Spreadsheets and other formats are out of scope (spreadsheets paginate badly via PDF).

**Size gate:** identical to `fetch` — Markdown ≤ 32 KB and ≤ 1000 lines is inlined; larger output spills to `${TMPDIR}/pi-doc-to-md/<stamp>-<basename>-<hash>.md` with a 60-line preview + a grep/read-slice hint.

**Configuration (environment variables):**

| Variable | Default | Meaning |
|---|---|---|
| `PI_DOC_TO_MD_PYMUPDF_VERSION` | `1.27.2.3` | `pymupdf4llm` version pin passed to `uv --with` (digits/dots only) |
| `PI_DOC_TO_MD_WARM_TIMEOUT_MS` | `120000` | Warm/install call budget — covers the cold wheel (+ managed Python) download |
| `PI_DOC_TO_MD_CONVERT_TIMEOUT_MS` | `60000` | Per-document conversion budget (also bounds the `unpdf` fallback) |
| `PI_DOC_TO_MD_SOFFICE_TIMEOUT_MS` | `120000` | LibreOffice `.docx`/`.pptx` → PDF budget |

Python is pinned to **3.14** and is not configurable.

**Runtime dependencies:** `unpdf` (shipped in the npm package, installed automatically on `pi install`). `uv` and LibreOffice (`soffice`) are optional system binaries detected at runtime: without `uv`, PDFs still convert via the `unpdf` fallback; without `soffice`, office inputs error while PDFs are unaffected.

**Licensing note:** `pymupdf4llm`/PyMuPDF are **AGPL-3.0**. This package ships none of their code — `uv` downloads the wheel from PyPI onto your machine at runtime, and it runs as a **separate subprocess** (never imported or linked into this TypeScript). The arms-length process boundary keeps pi-quiver' MIT license intact; the AGPL governs PyMuPDF itself, whose source is public. This holds only while the boundary stays subprocess-only (no vendoring/importing the wheel).

### session-name — manual + opt-in automatic session naming

Names work sessions so the session selector (and optionally the Ghostty tab) shows what each one is about.

**Behaviors:**

- **Manual `/session-name [name]`** - set the session name, or, with no argument, print the current one. Always available, regardless of config. A manual name wins: it suppresses later auto-naming for the session.
- **Automatic naming (opt-in).** After the first agent turn completes, if no name is set yet, the extension asks the **current model** for a 3-6 word session title plus a 1-4 word tab label and applies both. It only runs once per session and never overwrites an existing name.
- **Resume reflection (opt-in).** When a session that already carries a name is loaded/resumed/reloaded, its tab label is re-applied so the Ghostty tab matches.
- **Per-turn re-assert (opt-in).** The tab is re-pinned to the session name at the start of every turn. Pi owns the OS terminal title (OSC 0, `pi - <name> - <cwd>`) and overwrites it on every name change and session switch; the re-assert is the only hook that fires *after* pi's writer on a session swap, so the Ghostty tab and the session name stay in sync instead of drifting. It self-heals: if the name was changed outside this extension, the tab label is re-derived from the new name.
- **Ghostty tab rename.** The short label is written via OSC 2 (`ESC ] 2 ; <label> BEL`) **only when the active terminal is really Ghostty** (`TERM_PROGRAM=ghostty`, `TERM=xterm-ghostty`, or a `GHOSTTY_*` dir env) **and** stdout is a TTY. Other terminals are never touched. Auto-naming keeps its curated short label; re-derived labels (resume/external rename) are the first words of the session name.

**OFF by default.** All automatic behavior (auto-naming + resume reflection) is inert until explicitly enabled. The manual command is unaffected.

**Configuration** (`settings.json`, **project `.pi/settings.json` overrides the global agent-dir `settings.json`**). The global path is resolved via pi's own `getAgentDir()` (honours `PI_CODING_AGENT_DIR`, else `~/.pi/agent`), so it stays correct however this package is installed.

```jsonc
{
  // full form, defaults shown
  "sessionAutoName": { "enabled": false, "ghosttyTab": true }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch for automatic naming + resume reflection. |
| `ghosttyTab` | `true` | Whether to rename the Ghostty tab (only ever fires when the terminal is actually Ghostty). |

Boolean shorthand: `"sessionAutoName": true` enables everything (equivalent to `{ "enabled": true, "ghosttyTab": true }`); `false` disables everything.

**Cost note:** when enabled, automatic naming makes **one extra short LLM call** per session (low reasoning effort, current model, a few-thousand-char conversation digest), once, after the first turn. When OFF (the default) it makes **no** model calls and writes **nothing** to the terminal.

**Runtime dependency:** `@earendil-works/pi-ai` (the unified LLM API provided by the pi runtime; a peer dependency, no separate install).

### sword-header — themed ASCII startup header

Replaces pi's built-in startup logo with a hero's greatsword (Michael J. Penick longsword, asciiart.eu). The ASCII art is verbatim; only the coloring is ours - hilt/grip/pommel use the `accent` token, the blade uses `text`, so it tracks whatever theme is active.

**Behaviors:**

- **TUI only.** Installs a custom header on `session_start` when `ctx.mode === "tui"`. In print/non-interactive mode (`-p`) it does nothing.
- **`/builtin-header`** restores the built-in pi header at runtime (always available).

**OFF by default.** The header is only installed when explicitly enabled via `settings.json`.

**Configuration** (`settings.json`, project `.pi/settings.json` overrides the global agent-dir layer; same resolution as `session-name`):

```jsonc
{
  "swordHeader": false           // default; true installs the header
  // object form also accepted: "swordHeader": { "enabled": true }
}
```

## Install

Published to npm as the unscoped `pi-quiver` package.

**User scope** (all repos under your pi profile):

```bash
pi install npm:pi-quiver
```

**Project scope** (current repo only, committable via `.pi/settings.json`):

```bash
pi install -l npm:pi-quiver
```

**Try without installing**:

```bash
pi -e npm:pi-quiver
```

**From a local checkout** (for hacking on the extensions):

```bash
git clone git@github.com:jjuraszek/pi-quiver.git ~/repos/pi-quiver
pi -e ~/repos/pi-quiver/fetch.ts
```

## Development

Deps are peers (`@earendil-works/*`, `@sinclair/typebox`) plus the bundled
runtime deps; install them transiently and run the full check:

```bash
npm install
npm run test:all      # node --test *.test.ts  +  tsc --noEmit typecheck
```

`npm test` runs the unit tests alone; `npm run typecheck` runs the type pass.
Both run in CI on ubuntu + windows (`.github/workflows/test.yml`).

## Release

Published to npm by CI. Pushing a `vX.Y.Z` tag triggers
`.github/workflows/release.yml`, which gates on `tag == package.json`, runs
`npm run test:all`, and publishes with `npm publish --provenance --access
public` via OIDC trusted publishing. **Never run `npm publish` by hand.**

Cut a release with the helper script (also exposed as the `/release` prompt +
the `release` skill at `.agents/skills/release/`):

```bash
bash .agents/skills/release/scripts/release.sh propose      # suggest a level
bash .agents/skills/release/scripts/release.sh patch        # or minor / major
bash .agents/skills/release/scripts/release.sh --dry-run patch
```

It bumps `package.json`, commits `Release <version>`, runs the tests, creates
and pushes the `vX.Y.Z` tag, then monitors the publish. See
`.agents/skills/release/SKILL.md` for the full flow (`sync-presets` migrates
old git-tag pins to `npm:pi-quiver@<version>`).
