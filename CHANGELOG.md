# Changelog

Format follows sibling pi packages (e.g. [`pi-condense`](https://github.com/jjuraszek/pi-condense/blob/main/CHANGELOG.md)):
one entry per `vX.Y.Z` tag, newest first, terse bullets, dated.

Published to npm as `pi-quiver` (`pi install npm:pi-quiver`). Pushing a
`vX.Y.Z` tag triggers `.github/workflows/release.yml`, which publishes to npm
via OIDC trusted publishing. The release helper at
`.agents/skills/release/scripts/release.sh` cuts the tag; CI publishes.

## Unreleased

- **`provider-stall-watchdog`: opt-in semantic-silence recovery.** Policy D warns after configured silence, aborts the first semantic stall, and offers it once to Pi's existing retry loop; a second stall stops without another watchdog retry. OFF by default.
- **Human-TUI boundary.** Arms only for confirmed human interactive TUI runs; JSON, RPC, print, and subagent runs are excluded by activation rather than environment or session lineage.
- **Compatibility and fallback.** Verified against Pi 0.80.10. Automatic continuation requires enabled Pi retry with remaining capacity; disabled, exhausted, or incompatible retry leaves the request stopped for manual resubmission. Pending steering and follow-ups return to the editor and are excluded from automatic continuation; invalid merged watchdog configuration fails closed.

## v3.2.0 - 2026-07-12

- Add `fast-mode` extension: opt-in Anthropic fast mode for Claude Opus 4.8 (`speed: "fast"` payload + `fast-mode-2026-02-01` beta header), controlled via `fastMode` settings key, `--fast` flag, and `/fast [on|off|status]`. OFF by default. Preserves OAuth identity betas. Requires pi bundling `@earendil-works/pi-coding-agent` >= 0.80.5 (the `before_provider_headers` hook).

## v3.1.2 - 2026-07-07

- **`fetch` routes GitHub Actions run URLs through `gh`.** `github.com/{owner}/{repo}/actions/runs/{id}` URLs are served by `gh run view {id} --repo {owner}/{repo}` and returned through the existing size gate with a `Source: gh run view ...` header, alongside the existing issue/PR/repo routing. Only the bare run URL routes; deeper paths (`.../runs/{id}/jobs/{jobId}`, `.../actions/workflows/{file}`) fall back to HTTP. Falls back silently when `gh` is absent/unauthenticated/errors; `raw=true` forces the rendered page.

## v3.1.1 - 2026-07-05

Branding, funding, and gallery preview. No behavior change.

- **Logo + pi.dev gallery preview.** Repo-root `pi-quiver.png` (640x640), shown in the README and wired as `pi.image`.
- **Buy Me a Coffee funding.** `funding` in `package.json`, `.github/FUNDING.yml`, and a README badge.
- Rewrote `description`; added `docx`, `pptx` keywords.
- Fixed stale sibling references: README `pi-superpowers` -> `pi-gauntlet`; this CHANGELOG's format note `pi-context-prune` -> `pi-condense`.

## v3.1.0 - 2026-07-04

- **`fetch` auto-routes GitHub URLs through the `gh` CLI.** `github.com` issue,
  PR, and repo-root URLs are served by `gh issue|pr view --comments` /
  `gh repo view` and returned through the existing size gate, tagged with a
  `Source: gh ...` header. Falls back silently to the HTTP path when `gh` is
  absent, unauthenticated, or errors; `raw=true` forces the rendered page. No
  new npm dependencies. `gh` is documented as an optional runtime binary in the
  new README Prerequisites section.

## v3.0.1 - 2026-07-04

- **`release.yml` posts GitHub Release notes.** A new `release-notes` job (`needs: publish`, `contents: write`) extracts the CHANGELOG section matching the pushed tag with `awk` and publishes it as the GitHub Release body via `gh release create` (falling back to `gh release edit`). No LLM or API key; only `github.token`.

## v3.0.0 - 2026-07-02

- **Distribution moved from git-tag pins to npm, and the package renamed
  `pi-essentials` -> `pi-quiver`.** Installed with `pi install npm:pi-quiver`
  instead of `git:github.com/jjuraszek/pi-essentials@<tag>`. This is a breaking
  change to the install mechanism and package name only; extension behavior is
  unchanged. Existing git-tag-pin consumers migrate their `settings.json` entry
  to `npm:pi-quiver@<version>` (stale `pi-essentials` pins are flagged by
  `release.sh sync-presets`).
- **Tag-triggered CI publish.** New `.github/workflows/release.yml` publishes
  `npm publish --provenance --access public` via OIDC trusted publishing when a
  `v[0-9]+.[0-9]+.[0-9]+` tag is pushed, gated on `tag == package.json` and
  `npm run test:all`. New `.github/workflows/test.yml` runs unit tests +
  typecheck on ubuntu + windows for every push and PR.
- **`release.sh` rewritten** to the shared pi-* skeleton (propose / current /
  patch / minor / major / verify / sync-presets); only its CONFIG header is
  repo-specific. It bumps + tags + pushes and lets CI publish; it never runs
  `npm publish`. `sync-presets` reports old git-tag pins for manual migration
  and bumps same-form `npm:` pins under `--apply`.
- **`package.json`:** added `author`, `engines.node >=20`, a `files` allowlist
  (ships the runtime `.ts`, `scripts/pdf_to_md.py`, `types/`, docs), expanded
  `keywords`, `peerDependenciesMeta` (peers optional), a `test:all` script, and
  `devDependencies` for the peers + type packages so CI runs offline of a pi
  host. `typecheck` now runs via `npx tsc` (was `bun x tsc`). Bundled runtime
  deps (`jsdom`, `@mozilla/readability`, `turndown`, `turndown-plugin-gfm`,
  `unpdf`) stay in `dependencies` and ship in the tarball.
- **Docs:** `README`, `AGENTS.md`, the release skill, and `/release` prompt
  updated to the npm model; added README Development section. Removed the stale
  `.npmignore` (superseded by the `files` allowlist).

## v2.0.2 - 2026-06-28

- **`session-name`: fix auto-naming silently never running.** Two bugs compounded into zero auto-named sessions:
  - **Env-key auth was rejected.** `generateName` bailed on `!auth.apiKey`, but `ModelRegistry.getApiKeyAndHeaders` resolves keys with `includeFallback: false` — so a key that lives only in the environment (e.g. `ANTHROPIC_API_KEY`, the common case with no stored provider credential) returns `ok: true` with `apiKey: undefined`. The bail discarded that path even though `complete()` resolves the env key itself via `withEnvApiKey`/`getEnvApiKey`. Now only bails on `!auth.ok`, and forwards `auth.env`.
  - **Fragile `complete` import.** `complete` is re-exported from the pi-ai package index in older builds but only from the `/compat` subpath in newer ones; the static `import { complete }` aborted extension load entirely (taking the manual command with it) whenever the installed pi-ai used the other layout. Now resolved lazily at call time, trying the index then `/compat`.

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
  - **AGPL note:** PyMuPDF/pymupdf4llm are AGPL-3.0; no code is shipped (uv fetches the wheel at runtime) and it runs as a separate subprocess, keeping pi-quiver MIT.
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
