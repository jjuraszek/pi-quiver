# Spec: doc_to_md — PDF/DOCX/PPTX to Markdown via pymupdf4llm (uv) with pure-JS fallback

- **Date:** 2026-06-15
- **Package:** pi-essentials (new extension `doc_to_md.ts`, second extension alongside `fetch.ts`)
- **Branch / worktree:** `doc-to-md` @ `.worktrees/doc-to-md`
- **Status:** awaiting user review

## 1. Problem

The pack converts remote HTML to Markdown (`fetch`) and routes binary downloads (including PDFs and office docs) to a temp file untouched. There is no path from those bytes to readable Markdown. The agent gets a file path it cannot open.

We want a converter that turns a local `.pdf`, `.docx`, or `.pptx` into Markdown the model can consume, with **high structural fidelity** (headings, tables, reading order) when the environment allows, and a **degraded-but-readable** fallback when it does not.

High fidelity in pure JS is not achievable (tables/multi-column/reading-order all degrade). The fidelity engine is `pymupdf4llm` (PyMuPDF, C-based, Python). To avoid making Python a hard install requirement and to keep the pack itself pure-TS with zero vendored native code, the Python engine runs as an **arms-length subprocess** materialized on demand by `uv`, with a pure-JS extractor as the fallback.

## 2. Goals / Non-Goals

### Goals

- Single tool `doc_to_md` taking a **local file path** to `.pdf`, `.docx`, or `.pptx`; output is **Markdown**, one output type.
- **Primary engine:** `pymupdf4llm` via `uv run --with`, no project `.venv`, no repo pollution — uses uv's global cache.
- **Fallback engine:** `unpdf` (pure JS) when the primary is unavailable or times out, with the result **explicitly marked degraded**.
- **Office pipeline:** `.docx`/`.pptx` → PDF via headless `soffice` → same PDF→Markdown pipeline.
- **Size-gated delivery** mirroring `fetch`: inline under threshold, otherwise spill to a temp `.md` with a head preview.
- **Configurable** (env vars, documented in README): pinned `pymupdf4llm` version + the three timeouts. Sensible defaults.

### Non-Goals (explicit)

- **No spreadsheets** (`.xlsx`/`.ods`) and no other office formats in this iteration. Spreadsheets convert badly via PDF (pagination slices tables); `.odt`/`.odp`/legacy `.doc`/`.ppt` would convert acceptably on the same soffice path but are **out of scope** here as a YAGNI choice, not a technical limitation. Widening the office allowlist is a future change.
- **No URL input.** `fetch` already owns "URL → bytes on disk"; the model chains `fetch <url>` → `doc_to_md <path>`. `doc_to_md` is a pure converter.
- **No vendoring of PyMuPDF/`pymupdf4llm`.** The wheel is fetched by uv onto the user's machine at runtime; the pack ships zero AGPL bytes (see §3.1).
- **No persistent managed venv.** Ephemeral `uv run --with` only.
- **No OCR / image extraction / scanned-PDF handling** beyond whatever the engines do natively.
- **No office fallback.** If `soffice` is absent for an office input, the tool **errors** — there is no pure-JS docx/pptx→PDF path we will own.
- **No Python version configurability.** Python is pinned to **3.14**, fixed.

## 3. Dependencies & licensing

### 3.1 Runtime engines (not npm deps)

| Engine | Materialized how | Required? |
|---|---|---|
| `pymupdf4llm` (Python, **AGPL-3.0**) | `uv run --with pymupdf4llm==<pin> --python 3.14` — uv fetches the wheel into its global cache at runtime | Optional; absence → JS fallback |
| `uv` | Must be on `PATH` for the primary engine | Optional; absence → JS fallback |
| `soffice` (LibreOffice) | System binary on `PATH` | Required **only** for office inputs; absence → hard error for office, irrelevant for PDF |

Python 3.14 pin is safe: PyMuPDF ships a `cp310-abi3` stable-ABI wheel valid for any CPython >= 3.10 (confirmed on PyPI), so uv installs a single binary wheel regardless of the precise interpreter version — no source build. uv also bootstraps a managed 3.14 interpreter if the host lacks one.

**Cold-start budget.** On a fresh machine the warm call may download a managed CPython 3.14 (~100 MB+) *plus* the wheel; `WARM_TIMEOUT_MS` (default 120 s) must cover that. On constrained networks raise it via env. A warm-call timeout marks the engine `unavailable` for the process lifetime (§4.2) — restart the agent to retry.

**AGPL note (README + spec).** `pymupdf4llm`/PyMuPDF are AGPL-3.0. This design does not trigger copyleft on pi-essentials because:
- The pack distributes **no** PyMuPDF bytes — uv downloads the wheel from PyPI onto the end user's machine at runtime.
- PyMuPDF runs as a **separate subprocess** (`uv run … python script.py`), never imported/linked into our TypeScript, so our code is not a derivative work.
- AGPL §13 (network clause) bites only on a **modified** PyMuPDF exposed over a network; we neither modify it nor serve it — it runs locally as a developer tool.

This holds **only** while the boundary stays subprocess-only and we never vendor or import the wheel. A one-line note in README records the constraint.

### 3.2 npm dependencies

Added to `package.json` `dependencies`:

| Dependency | Role | Why |
|---|---|---|
| `unpdf` | Pure-JS PDF text extraction (fallback) | Modern, maintained (unjs), ESM, wraps a serverless pdf.js build. Reliable per-page text. Minimal dep, low maintenance risk. |

`unpdf` output is **plain text with page breaks — near-zero Markdown structure** (no faithful headings/tables). That is acceptable for a fallback whose job is "model isn't blind," not "good Markdown." No heuristic markdown lib (`@opendocsg/pdf2md`) — its structure guesses are fragile.

No type package needed beyond `unpdf`'s own types; if `tsc` requires it, the transient typecheck install line in `AGENTS.md` is extended (not runtime deps).

## 4. Architecture

Single tool, single `execute`. Pure, side-effect-light helpers do classification, gating, and command construction so they are unit-testable; subprocess calls and fs are the only impure edges.

### 4.1 Input classification (pure: `classifyInput(path)`)

By extension (lowercased):
- `.pdf` → PDF pipeline directly.
- `.docx`, `.pptx` → office pipeline (soffice → PDF) → PDF pipeline.
- anything else → error: unsupported type, list supported extensions.

Path must exist and be a readable file; otherwise error before any subprocess.

### 4.2 Engine selection (PDF pipeline)

Implements the **warm-once, then prefer pymupdf4llm** model (per-process):

```
pymupdf state (module-scope): "unknown" | "warm" | "unavailable"
warmPromise   (module-scope): Promise<"warm" | "unavailable"> | null
```

1. If `uv` is not on `PATH` → state = `unavailable`.
2. If state == `unknown`: run the **warm call** (call 1) under `WARM_TIMEOUT_MS`.
   - success → state = `warm`
   - failure/timeout → state = `unavailable` (sticky for the process; distinguishes a transient/cold or broken uv env from a per-doc problem — we do not re-probe every call)
3. If state == `warm`: run the **convert call** (call 2) under `CONVERT_TIMEOUT_MS`.
   - success → use pymupdf4llm Markdown (high-fidelity path).
   - error or timeout → fall back to `unpdf` **for this document only**; state stays `warm` (a single pathological doc does not disable the engine).
4. If state == `unavailable`: skip straight to `unpdf` (degraded path), no warm/convert attempt.

This separates **engine warmth** (one-time, generous budget, sticky on failure) from a **per-document budget** (catches only genuinely slow docs), avoiding the trap where cold-start latency silently demotes every first conversion to the worse engine.

**Concurrency.** The warm call is guarded by `warmPromise`: the first caller that sees it `null` creates and assigns it, then awaits; concurrent callers await the same promise. This guarantees a single warm uv invocation (one download, one cache populate) and monotonic state — a late timeout can never overwrite an earlier success. Only the warm probe is serialized; per-document convert calls (call 2) run independently.

### 4.3 The two uv calls

Both pass `--with pymupdf4llm==<pin> --python 3.14`. uv's global cache makes call 2 fast once call 1 populated it.

- **Call 1 — warm/install** (memoized per process via the state flag): verifies the wheel resolves and imports.
  ```
  uv run --with pymupdf4llm==<pin> --python 3.14 python -c "import pymupdf4llm"
  ```
  On a cold cache this performs the wheel (+ managed Python) download — the reason its budget is generous. Once cached it returns sub-second; subsequent conversions in the session skip call 1 entirely (state == `warm`).
- **Call 2 — convert** (per document):
  ```
  uv run --with pymupdf4llm==<pin> --python 3.14 python <pkg>/scripts/pdf_to_md.py <pdf-path>
  ```
  **4.3.1 — `scripts/pdf_to_md.py` contract.** Shipped in the package. Takes one argv (the PDF path), calls `pymupdf4llm.to_markdown(path)`. Success: raw UTF-8 Markdown to stdout, exit 0. Failure: human-readable message to stderr, non-zero exit. No JSON wrapping, no metadata header — stdout is the Markdown verbatim.

**4.3.2 — Subprocess invocation.** All subprocess calls (uv, soffice) use **argv arrays** via `spawn`/`execFile`, never a shell string — paths with spaces or shell metacharacters are never interpolated into a command line. The Python script path resolves at runtime via `new URL('./scripts/pdf_to_md.py', import.meta.url)`. Subprocess stdout is decoded as UTF-8.

**4.3.3 — Output cap.** Convert-call stdout is accumulated from `spawn` chunks; if it exceeds `OUTPUT_MAX_BYTES` (20 MB constant) the child is killed and the call errors (`output exceeded cap`) rather than buffering unbounded / OOM. The size gate (§4.5) then applies to the full captured string. The same cap guards the Markdown produced on the unpdf path.

### 4.4 Office pipeline (pure command build: `soffArgs(src, profileDir, outDir)`)

`.docx`/`.pptx` → PDF via headless soffice into a temp dir, then the resulting PDF feeds §4.2. Flags use an isolated throwaway soffice profile per call (no lock contention):

```
soffice --headless --invisible --nocrashreport --nodefault --nofirststartwizard \
        --nolockcheck --nologo --norestore --quickstart=no \
        -env:UserInstallation=file://<tmp-profile> \
        --convert-to pdf --outdir <tmp-out> <src>
```

Env for the soffice process: `SAL_USE_VCLPLUGIN=svp`, `OOO_DISABLE_RECOVERY=1`, `SAL_NO_MOUSEGRABS=1`. Budget: `SOFFICE_TIMEOUT_MS`. On success the validated intermediate PDF enters the PDF pipeline (so office output fidelity == PDF-pipeline fidelity, including its pymupdf/unpdf fallback).

**Temp-dir lifecycle.** The profile dir and out dir are created with `fs.mkdtempSync(path.join(os.tmpdir(), 'pi-doc-soffice-'))` before the soffice call and removed with `fs.rmSync(dir, { recursive: true, force: true })` in a `finally` wrapping the **entire** office pipeline — so they survive until any unpdf fallback on the intermediate PDF has run (§5). Cleanup errors are logged via `pi.log` and swallowed.

**Output validation.** soffice exits 0 even when it produces nothing usable. After it returns, require `<outDir>/<inputBasename>.pdf` to exist, be a regular file, and be > 0 bytes; otherwise **hard error** surfacing captured soffice stderr. Only a validated PDF enters the PDF pipeline.

If `soffice` is not on `PATH` → **hard error** (no fallback for office→PDF).

### 4.5 Size gate (pure: `applyGate(markdown)`)

Mirrors `fetch`:

```
INLINE_MAX_BYTES = 32_000
INLINE_MAX_LINES = 1_000
```

Applied to the produced Markdown. `> 32 KB` **or** `> 1000 lines` → spill to a temp `.md` file with a 60-line / 4 KB head preview + a grep/read-slice instruction. Otherwise inline.

Temp file convention mirrors `fetch`: `${TMPDIR}/pi-doc-to-md/<stamp>-<basename>-<hash>.md`, where `basename = path.basename(inputPath).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-')` (extension stripped, unsafe chars normalized) and `hash = sha1(resolvedInputPath).slice(0, 8)`.

## 5. Data flow

```
1. Resolve + validate path (exists, readable, supported extension). Else error.
2. classifyInput():
   - office (.docx/.pptx): require soffice (else hard error) → soffice → intermediate PDF.
   - pdf: use as-is.
3. PDF pipeline (engine selection §4.2):
   a. uv absent → unpdf (degraded).
   b. state unknown → warm call (call 1, WARM_TIMEOUT_MS); success→warm, fail→unavailable.
   c. warm → convert call (call 2, CONVERT_TIMEOUT_MS); success→pymupdf md; fail/timeout→unpdf (this doc).
   d. unavailable → unpdf (degraded).
4. unpdf path: extract per-page text, join with page-break separators, wrap as Markdown,
   set degraded=true (engine="unpdf").
5. applyGate(markdown):
   ≤ gate → inline.
   > gate → spill to ${TMPDIR}/pi-doc-to-md/<...>.md + metadata + 60-line/4 KB preview + read-slice hint.
6. Clean up all temp artifacts (soffice profile dir + out dir / intermediate PDF) in a `finally` wrapping the whole pipeline — **after** any unpdf fallback has consumed the intermediate PDF, never before. Cleanup failures are logged and swallowed; they never fail the conversion.
```

## 6. Configuration (env vars, README-documented)

The pi `ExtensionAPI` exposes **no settings.json/config accessor**; an extension's config surfaces are `registerFlag`/`getFlag`, tool parameters, and `process.env`. A version pin and timeouts are global, not per-call, so they are **env vars** read at call time with hardcoded defaults:

| Env var | Default | Meaning |
|---|---|---|
| `PI_DOC_TO_MD_PYMUPDF_VERSION` | `1.27.2.3` | `pymupdf4llm` version pin passed to `uv --with` |
| `PI_DOC_TO_MD_WARM_TIMEOUT_MS` | `120000` | Call 1 (warm/install) budget — generous for cold wheel + interpreter download |
| `PI_DOC_TO_MD_CONVERT_TIMEOUT_MS` | `60000` | Call 2 (per-document conversion) budget |
| `PI_DOC_TO_MD_SOFFICE_TIMEOUT_MS` | `120000` | soffice docx/pptx → PDF budget |

No tool parameters beyond the input `path`. Python 3.14 is not configurable.

**Validation (fail fast at tool entry, before any subprocess).** Timeouts: `parseInt(v, 10)`, reject `NaN` / zero / negative. Version pin: must match `/^\d+(\.\d+)*$/` (digits and dots only) — it is interpolated into `uv --with pymupdf4llm==<pin>`, so a strict regex closes a command-injection vector. Invalid values are a hard error naming the offending var; defaults apply only when the var is unset.

**unpdf timeout.** The fallback reuses `PI_DOC_TO_MD_CONVERT_TIMEOUT_MS` as its wall-clock budget (no separate env var). Caveat: pdf.js does not honor mid-parse cancellation, so the timeout surfaces a tool error promptly but the background parse may run to completion — acceptable for a short-lived per-call process. unpdf reads the whole PDF into memory; pathological inputs are bounded by the timeout, not an input-byte cap.

## 7. Output shape

`details` (drives `renderResult`):

```ts
interface DocToMdDetails {
  path: string;            // input file
  inputType: "pdf" | "docx" | "pptx";
  engine: "pymupdf4llm" | "unpdf";
  degraded: boolean;       // true when unpdf fallback was used
  bytes: number;           // markdown byte length
  lines: number;           // markdown line count
  spilled: boolean;        // written to file vs inline
  file?: string;           // path when spilled
}
```

- **Inline:** Markdown body, prefixed verbatim with the degraded marker when `degraded`: the exact string `[Note: degraded extraction via unpdf — structure (tables/headings) not preserved]\n\n` (identical in the spilled preview, so output is deterministic for tests).
- **Spilled:** `Body: <size> across <n> lines — written to file` + `Saved-To:` + grep/read-slice instruction + 60-line/4 KB preview (degraded marker included when applicable).
- `renderResult` shows an engine/degraded chip (e.g. `pymupdf4llm`, or `unpdf (degraded)`) alongside type/size, and `→ file` on spill — consistent with `fetch`'s rendering.

## 8. Tool surface

- **Name:** `doc_to_md`.
- **`description`:** "Convert a local PDF/DOCX/PPTX to Markdown. High-fidelity via pymupdf4llm (uv, fetched on first use); degraded pure-JS text fallback (unpdf) when uv/Python is unavailable. DOCX/PPTX require LibreOffice (soffice). Output over 32 KB / 1000 lines spills to a temp .md with a preview."
- **Parameters:** `path` (string, required) — local file path. No other params.
- **`promptGuidelines`:** input is a local path (use `fetch` first for URLs); office inputs need `soffice`; degraded results are marked and lack faithful tables/headings; spilled Markdown is grep-able by heading (`^#`).

## 9. Error handling & edge cases

| Case | Behavior |
|---|---|
| Path missing / not a file / unreadable | Error before any subprocess. |
| Unsupported extension | Error listing supported types (`.pdf`, `.docx`, `.pptx`). |
| `uv` absent | PDF: silently use unpdf (degraded). Logged in `details.engine`. |
| Warm call (call 1) fails/timeouts | state = `unavailable` (sticky); use unpdf for this and subsequent docs in the process. |
| Convert call (call 2) errors/timeouts | Fall back to unpdf for **this doc**; engine stays `warm`. |
| `soffice` absent, office input | Hard error (no office fallback). |
| soffice conversion fails/timeouts | Hard error with captured stderr; clean up temp profile/out dir. |
| Encrypted/password PDF | Whatever the active engine reports; surfaced as a tool error if it throws, else best-effort text. |
| Convert/unpdf output > 20 MB | Kill child / abort, tool error (`output exceeded cap`); no partial spill. |
| unpdf exceeds `CONVERT_TIMEOUT_MS` | Tool error (both engines exhausted); see §6 cancellation caveat. |
| soffice exits 0 but PDF missing/empty | Hard error with captured soffice stderr (§4.4 output validation). |
| Invalid env var (bad timeout / version pin) | Hard error at tool entry before any subprocess (§6). |
| Concurrent first calls | Single warm uv invocation via shared `warmPromise`; no duplicate download/race (§4.2). |
| unpdf throws (corrupt/scanned PDF) | Tool error with the message (both engines exhausted). |
| Markdown > 32 KB / 1000 lines | Spill to temp `.md` + preview. |
| Temp artifact cleanup | soffice profile + intermediate PDF removed on every exit path (success or error). |

## 10. Testing approach

- **Unit tests (`node --test`, no network):** pure helpers — `classifyInput()` (extension routing, unsupported, missing file), `applyGate()` (32 KB / 1000-line boundaries), `soffArgs()` (flag/profile/outdir construction), uv command builders (version-pin + python-3.14 wiring), degraded-marker prefixing. Refactor `execute` to delegate to these helpers so they're importable.
- **Integration smoke (manual, env-dependent):**
  - small text PDF → inline Markdown via pymupdf4llm (`engine: pymupdf4llm`).
  - large PDF → spilled `.md`, grep-able headings.
  - a `.docx` and a `.pptx` → soffice → PDF → Markdown.
  - uv removed from `PATH` (or `PATH` shimmed) → degraded unpdf path, marker present.
  - soffice removed → office input errors cleanly; PDF input unaffected.
  - `pi -e ./doc_to_md.ts -p "convert <path>.pdf to markdown"`.
- **Typecheck:** AGENTS.md transient-install + `tsc --noEmit`, extended with `unpdf` (and `pdf_to_md.py` excluded — it is Python, not typechecked).

## 11. Docs & packaging (same worktree commit)

- `fetch.ts` (**required — the stated `fetch` → `doc_to_md` chain depends on it**) — `BINARY_EXT` has no OOXML mappings today, so a fetched `.docx`/`.pptx` is saved with a mangled extension (`.vndopenx`…) that §4.1 rejects. Add `application/vnd.openxmlformats-officedocument.wordprocessingml.document → docx` and `…presentationml.presentation → pptx` (and confirm `application/pdf → pdf` is present). Add a chain test: fetch's output filename must classify cleanly in `doc_to_md`.
- `package.json` — add `"./doc_to_md.ts"` to `pi.extensions`; add `unpdf` to `dependencies`; update `scripts.test` to glob `*.test.ts` (currently only `fetch.test.ts`) so `doc_to_md.test.ts` runs. Delivery is via git-tag pin = whole tree checked out, so `scripts/pdf_to_md.py` ships regardless; add a `files` whitelist only if npm publish is ever introduced.
- `README.md` — new `doc_to_md` section: engines, uv/soffice prerequisites, env-var config table, degraded-fallback behavior, the AGPL note.
- `CHANGELOG.md` — new minor `vX.Y.Z` entry (new extension + new dep).
- `AGENTS.md` — extend the typecheck install + `tsc` line with `unpdf` and `doc_to_md.ts doc_to_md.test.ts`; note `scripts/pdf_to_md.py` is the Python conversion entry point (excluded from `tsc`).

## 12. Open questions

None. Engine selection, the two-call warm model, Python/lib pinning, office allowlist, fallback library, config surface, gate values, and temp conventions are all decided above.
