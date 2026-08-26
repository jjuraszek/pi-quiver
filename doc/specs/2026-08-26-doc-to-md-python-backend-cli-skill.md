# doc_to_md: Python/venv backends, core extraction, CLI subcommand, Claude Code skill

## Problem

`doc_to_md` today has exactly two rungs: `uv run --with pymupdf4llm==<pin>` for
high fidelity, else the degraded pure-JS `unpdf` fallback. Machines with a usable
Python but no uv get degraded output for no good reason. Separately, the
conversion capability is pi-only: unlike `fetch` (which ships `lib/fetch-core.ts`,
a `pi-quiver fetch` CLI subcommand, and `skills/fetch/SKILL.md`), `doc_to_md` has
no pi-free core, no CLI surface, and no Claude Code skill. This spec covers both,
as one change: the core extraction physically moves the code the backend rework
rewrites.

## Goals

1. Backend ladder for PDF conversion: uv -> system python with pymupdf4llm
   importable -> managed venv (one-time bootstrap) -> unpdf (degraded).
2. Extract a pi-free data plane `lib/doc-to-md-core.ts`; the extension becomes a
   thin adapter mirroring `extensions/fetch.ts` over `lib/fetch-core.ts`.
3. Add a `doc-to-md <path>` subcommand to `bin/pi-quiver.ts` whose stdout is
   the extension's tool output verbatim plus exactly one trailing newline (the
   fetch CLI convention).
4. Ship `skills/doc-to-md/SKILL.md` and list it in
   `.claude-plugin/marketplace.json` `plugins[0].skills`.

Out of scope: any change to `scripts/pdf_to_md.py` behavior; any `fetch` work
(its core/CLI/skill already exist and are the template); venv invalidation or
upgrade logic ("uv is the way if you care about updates"); new settings keys or
env vars (an earlier `PI_DOC_TO_MD_PYTHON` idea was explicitly dropped); pip
installs into the user's environment.

## Architecture

```
extensions/doc_to_md.ts   thin adapter: TypeBox schema, execute -> {content, details}, TUI renderers
lib/doc-to-md-core.ts     pi-free data plane (node builtins + unpdf only):
                          classifyInput, office->PDF via soffice, backend ladder,
                          runCapped, degraded marker, size gate + spill, output formatter
bin/pi-quiver.ts          + `doc-to-md <path>` subcommand next to `fetch`
skills/doc-to-md/SKILL.md Claude Code surface via `npx -y pi-quiver@latest doc-to-md <path>`
```

Core extraction follows fetch exactly (single-entry core; the rejected
alternatives were a composable multi-export core and having the CLI import from
the extension file, which is not pi-free): the core exports
`convertDocument(path, config, signal?)` returning `{ output, details }` plus
the pure helpers the tests assert. The `AbortSignal` threads through to every
subprocess and the unpdf engine, exactly as the current pipeline does -
tool-call cancellation is preserved, not dropped, by the extraction.

`parseConfig` moves into the core and both adapters call it on `process.env`:
the four existing `PI_DOC_TO_MD_*` env vars (pymupdf pin, warm/convert/soffice
timeouts) keep working identically on both surfaces. The pin drives both the uv
`--with` argument and the venv `pip install`; the bare `python` rung stays
unpinned. `formatSize` is ported as a local copy into the core - it cannot
import `@earendil-works/pi-coding-agent`, and cross-importing `lib/fetch-core.ts`
would violate the core's stated node-builtins+unpdf dependency set.

The extension keeps only pi concerns (TypeBox, result envelope, TUI render);
the CLI keeps only argv parsing and printing. One core formatter produces the
output for both surfaces, preserving today's two shapes exactly:

- inline: `Source:` / `Type:` / `Engine:` / `Length:` header, optional degraded
  marker, then the markdown body;
- spilled (over the cap): `Source:` / `Type:` / `Engine:` header, then
  `Body: <size> across <lines> lines`, `Saved-To: <path>`, and the preview.

The formatter's output carries **no** trailing newline (unchanged tool
behavior); the CLI appends exactly one when printing.

Executable detection for `uv` and `soffice` drops the Unix-only `which` helper
(`onPath` in `extensions/doc_to_md.ts:256-258`, which silently fails on
Windows): presence is determined by spawning the binary itself and treating a
spawn error (ENOENT) as absent - the same technique the python probes use. The
actionable LibreOffice-missing error moves into the core so the CLI emits it
too, not just the extension.

## Backend ladder

The current `uvAvailable`/`pymupdfState`/`warmPromise` state in
`extensions/doc_to_md.ts:248-318` is replaced by one lazily resolved, cached
backend value in the core:

```ts
type Backend =
  | { kind: "uv" }                                    // pinned, isolated (unchanged behavior)
  | { kind: "python"; exe: string; version: string }  // pymupdf4llm already importable
  | { kind: "venv"; exe: string; version: string }    // bootstrapped into the cache dir
  | { kind: "none" };                                 // -> unpdf, degraded
```

Resolution runs once per process, on the first PDF conversion, behind a shared
promise (concurrent conversions in one session never race or double-bootstrap):

1. **uv.** `uv` on PATH -> warm probe (existing argv:
   `uv run --with pymupdf4llm==<pin> --python 3.14 python -c "import pymupdf4llm"`,
   existing warm timeout). Success -> `{ kind: "uv" }`. uv absent or warm
   failure -> step 2.
2. **System python probe.** Candidates `python3`, then `python` - same order on
   every platform (on Windows, CreateProcess resolves `python3` to
   `python3.exe` where one exists; the python.org installer's bare `python.exe`
   is caught by the second candidate). Known limitation, deliberate: the
   Windows `py.exe` launcher is **not** a candidate - a machine exposing Python
   only through `py` degrades to unpdf; the candidate list stays plain
   `python3`/`python` per the zero-configuration decision, and the SKILL.md /
   doc note the limitation. Each candidate runs one short probe subprocess
   (5s timeout - no download involved) with this exact program (passed as one
   `-c` argument; `python -c` accepts newlines):

   ```python
   import sys
   print("PY", sys.version_info[0], sys.version_info[1])
   try:
       import pymupdf4llm
       print("PKG", pymupdf4llm.__version__)
   except Exception:
       print("PKG", "none")
   ```

   Probe stdout grammar (parsed by the resolver, asserted by unit tests):
   - importable: `PY 3 12\nPKG 0.0.17` (versions vary) -> package present;
   - missing package: `PY 3 12\nPKG none` -> venv-eligible;
   - anything else - non-zero exit, spawn error, unparseable stdout (Windows
     Store alias stub, crash) -> candidate discarded silently (the Store-stub
     immunity is deliberate).

   The floor check is `major > 3 || (major == 3 && minor >= 12)` computed by
   the resolver from the `PY` line. Outcomes per candidate:
   - interpreter `< 3.12` -> candidate discarded entirely, including for venv
     bootstrap (the floor comes from this spec's >= 3.12 requirement,
     consistent with the modern interpreter the uv path already uses);
   - interpreter `>= 3.12` + pymupdf4llm importable ->
     `{ kind: "python", exe, version }` - used as-is, unpinned, never modified;
   - interpreter `>= 3.12`, no pymupdf4llm -> candidate is venv-eligible;
     remember the first such `exe` and continue (a later candidate may already
     have the package).
3. **Managed venv.** Full candidate order, explicit: `python3`, `python` (PATH
   probes, step 2), then the cached venv interpreter at
   `<cachedir>/pymupdf-venv` (same step-2 probe, no marker files - so an
   importable system python always wins over the venv), then bootstrap, then
   `none`. Bootstrap runs only when no probed candidate had the package but at
   least one was venv-eligible, and is **atomic-publish**: build in a unique
   sibling directory - `<exe> -m venv <cachedir>/pymupdf-venv.tmp-<pid>`, then
   `<tmp-python> -m pip install pymupdf4llm==<pin>` (same pin as uv) - and
   rename it to `pymupdf-venv` on success. A concurrent process can therefore
   never probe a half-built venv; if the rename fails because a competing
   process published first, probe the winner and clean up the loser. Both
   bootstrap commands share **one** deadline: the existing warm-timeout
   envelope (~120s default) spans venv creation + pip install with
   remaining-time propagation, so the accepted one-time ~40MB download bounds
   the first call once, not per subprocess. Success ->
   `{ kind: "venv", exe: <venv-python>, version: <pin> }`. A broken venv
   (deleted/moved python, failed probe) is treated as bootstrap-eligible and
   re-created once per process, else `none`. Bootstrap failure (offline, pip
   error, missing `python3-venv`) -> `{ kind: "none" }` for the session.
4. **none.** -> unpdf, degraded, with an actionable `Fallback-Reason:`. The
   degraded reasons form a closed list (skill text, CLI stderr, and tests all
   depend on these exact shapes; `<stderr tail>` is the capped stderr already
   collected by `runCapped`):

   | Path | `Fallback-Reason:` |
   |---|---|
   | no uv, no python >= 3.12 | `uv not found; no python >= 3.12 on PATH - install uv, or Python 3.12+` |
   | uv warm failed, no usable python | `uv warm-up failed: <stderr tail>; no python >= 3.12 on PATH` |
   | venv bootstrap failed | `python <ver> found but venv bootstrap failed: <stderr tail> - install python3-venv, or uv` |
   | conversion-time pymupdf failure | `pymupdf4llm (<backend>) conversion failed: <message> - fell back to unpdf` |

Venv interpreter path is `Scripts\python.exe` on Windows, `bin/python`
elsewhere. Cache dir helper (~10 lines, no `env-paths` dependency; parameters
injected for testability):

| Platform | Location |
|---|---|
| win32 | `%LOCALAPPDATA%\pi-quiver` (fallback `~\AppData\Local\pi-quiver`) |
| darwin | `~/Library/Caches/pi-quiver` |
| other | `$XDG_CACHE_HOME/pi-quiver` (fallback `~/.cache/pi-quiver`) |

Conversion argv per pymupdf backend: uv keeps the existing prefix +
`python <script> <pdf>`; `python`/`venv` run `[exe, <script>, <pdf>]`. All
three are the same engine: results are **non-degraded**, `engine:
"pymupdf4llm"`. `DocToMdDetails` gains `backend: "uv" | "python" | "venv" |
"unpdf"` and optional `pymupdfVersion: string` (the probed/pinned version, set
for `python`/`venv`; `uv` implies the pin). A conversion-time failure on any
pymupdf backend (timeout, crash) falls straight to unpdf for that document -
no ladder re-walk, no python retry after a uv failure (a warmed backend that
fails is almost always document-specific).

## Script path resolution

`scriptPath()` currently resolves `../scripts/pdf_to_md.py` relative to
`import.meta.url` - correct from `extensions/` or `lib/`, wrong from `dist/bin/`
after esbuild bundles the CLI. The core instead walks up from its own module
directory to the nearest directory containing `package.json` and resolves
`scripts/pdf_to_md.py` from that package root. This works in all execution
contexts: source checkout (`lib/` -> root), installed tarball extension, and
bundled CLI (`dist/bin/` -> root, two levels). `scripts/pdf_to_md.py` is already
in the npm `files` allowlist; no packaging change.

## CLI

`pi-quiver doc-to-md <path>` - one positional, no flags, resolved relative to
the caller's cwd (the core absolutizes, as the extension does today).

- Exit 0: conversion succeeded, including degraded unpdf output. stdout is the
  core-formatted output (the exact bytes the pi tool returns - the formatter
  emits no trailing newline) plus exactly one trailing newline appended by the
  CLI, nothing else on stdout. A test asserts exact byte equality between
  `convertDocument().output + "\n"` and the CLI's stdout.
- Exit 1: conversion failed - missing/unreadable file, unsupported extension,
  soffice missing or produced no PDF, or conversion engine failure (e.g. unpdf
  crash on a corrupt PDF, or a pymupdf failure followed by an unpdf failure).
  stderr gets
  `doc-to-md failed: <message>`; the soffice message names LibreOffice with an
  install hint. Never a stack trace.
- Exit 2: usage error (missing path, extra args, unknown flag) - usage string
  to stderr, matching the existing `fetch` parser conventions in
  `bin/pi-quiver.ts:23-70`.

Parser stays in the existing single-usage-string structure; `ParsedArgs`
becomes a discriminated union over the two subcommands.

## Skill and marketplace

`skills/doc-to-md/SKILL.md` mirrors `skills/fetch/SKILL.md`: YAML frontmatter
(`name`, `description`), invocation `npx -y pi-quiver@latest doc-to-md <path>`,
supported formats (PDF, DOCX, PPTX), the stdout contract (inline vs `Saved-To`
+ preview), exit codes, and both degradation notes: no uv/python -> degraded
PDF output explicitly marked as such; no LibreOffice -> DOCX/PPTX fail with an
actionable install message. `.claude-plugin/marketplace.json` `plugins[0].skills`
gains `"./skills/doc-to-md"`. No `package.json` `files` change - skills stay
excluded from the tarball; `test/layout.test.ts` already asserts every
marketplace-listed skill has a `SKILL.md`.

## Error handling and edge cases

- Missing file / unsupported extension: rejected before any backend work
  (unchanged extension behavior; CLI exit 1).
- soffice missing or emits no PDF: hard error naming LibreOffice - never falls
  to unpdf (unpdf cannot read office formats).
- Windows Store alias stubs (`python.exe`/`python3.exe` fakes in WindowsApps):
  fail the probe, discarded silently by design.
- Broken cached venv: re-probed, re-created once per process, else `none`.
- Cross-process race on first venv bootstrap: handled by the atomic-publish
  build-in-sibling-then-rename strategy (ladder step 3); the worst case is a
  redundant bootstrap whose rename loses and is cleaned up. No lock files.
- Skill/doc note the `py.exe`-launcher-only Windows limitation (ladder step 2).
- uv warm failure: falls to the python probe (an improvement over today, where
  warm failure goes straight to unpdf).

## Testing

Hard rule: CI never reaches a network, never runs uv/pip, and never writes the
real per-OS cache dir. Determinism comes from two seams: (1) subprocess-level
PATH isolation - tests spawn the CLI with a minimal `PATH` containing only the
node directory, so uv/python are absent and the ladder deterministically
resolves `none`/unpdf even on GitHub images that ship uv and Python 3.12+;
(2) injectable resolver seams - the core's backend resolver takes its runner,
cache-dir, and env as injectable parameters so orchestration is unit-testable
without real subprocesses.

- **Unit** (`test/doc_to_md.test.ts`, extended; assertions move to importing
  from `lib/doc-to-md-core.ts`):
  - pure builders - probe argv per candidate, convert argv per backend, venv
    interpreter path per platform, cache-dir helper per platform via injected
    env + platform;
  - probe-output parsing against the exact grammar (importable / `PKG none` /
    unparseable-or-nonzero -> discard, old interpreter -> discard);
  - resolver orchestration via injected seams, covering every ladder
    transition: uv absent/warm-fail -> python continuation; all PATH
    candidates checked before the bootstrap exe is chosen; cached-venv probe
    order (after PATH candidates, before bootstrap); valid vs broken cached
    venv; shared-promise single bootstrap under concurrent first calls;
    sticky `none`; conversion-time failure falls to unpdf without a ladder
    re-walk;
  - the package-root walk-up helper for `scripts/pdf_to_md.py`, asserted
    against the three execution-context layouts (`lib/` in a source checkout,
    installed-tarball `lib/`, bundled `dist/bin/`) - this pure test, not the
    packed e2e, is what pins the esbuild script-path regression.
- **Layout** (`test/layout.test.ts`): twin of the existing fetch-core purity
  assertion - `lib/doc-to-md-core.ts` imports no `@earendil-works` packages.
- **CLI** (`test/doc-to-md-cli.test.ts`, sibling of `test/fetch-cli.test.ts`):
  parser shapes, exit 2 on usage errors, exit 1 on missing file; a source-TS
  bin run under minimal-PATH isolation converting `test/fixtures/sample.pdf` -
  asserts exit 0, `Engine:` reporting unpdf, and the degraded marker; and the
  exact byte-equality check between `convertDocument().output + "\n"` and CLI
  stdout.
- **Packed-install** (`test/packed-install.test.ts`, extended): run the
  installed bin's `doc-to-md` on the absolute source-tree fixture path under
  the same minimal-PATH isolation; asserts exit 0 with degraded unpdf output
  from the bundled CLI. (Script-path resolution is covered by the walk-up unit
  test above; a scrubbed-PATH run intentionally never touches `pdf_to_md.py`.)
- **Manual smoke** (documented in `doc/doc-to-md.md`, not CI): uv path, python
  path, venv bootstrap on a uv-less machine, and
  `pi -e ./extensions/doc_to_md.ts` smoke per AGENTS.md.


## Documentation impact

- Feature / user-facing docs introduced: `skills/doc-to-md/SKILL.md`
- Materially amended existing docs: `README.md` (doc_to_md engine ladder, CLI
  section, Claude Code section, graceful-degradation row - fixes the stale
  claims at README.md:66,133,214 that only uv is high-fidelity and that only
  fetch is exposed), `doc/doc-to-md.md` (backend ladder, venv cache location,
  prerequisites, `py.exe` limitation, manual smoke list). The registered tool
  `description` string in `extensions/doc_to_md.ts` (currently "run through
  uv, fetched on first use") is rewritten to describe the ladder - in-code
  user-visible text, listed here so it is not missed.
- Derived / memory docs invalidated: `AGENTS.md` (doc_to_md engine bullet,
  layout tree entries for `lib/doc-to-md-core.ts` and `skills/doc-to-md/`),
  `CHANGELOG.md` entry

## Open questions

None.
