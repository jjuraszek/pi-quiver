# doc_to_md - local document -> Markdown

`doc_to_md` takes a **local file path** (`.pdf`, `.docx`, `.pptx`) and returns Markdown. For remote documents, `fetch` the URL first (it saves binaries to a temp path), then pass that path here.

## Backend ladder

High-fidelity conversion via `pymupdf4llm` is resolved once per process, trying four rungs in order:

1. **`uv`** - arms-length subprocess via `uv run --with pymupdf4llm==<pin> --python 3.14`. Pinned and isolated: `uv` fetches the wheel (and, if needed, Python 3.14) into its own cache on first use.
2. **System Python** - `python3`, then `python`, probed on `PATH`. Any interpreter >= 3.12 with `pymupdf4llm` already importable is used as-is, unpinned (whatever version is installed).
3. **Managed venv** - built once at `<per-OS cache dir>/pi-quiver/pymupdf-venv` from the first eligible system Python (>= 3.12, package or not), pinned to the same `pymupdf4llm==<pin>` as the `uv` rung. Bootstrapped atomically (built in a tmp dir, published via rename) so a crash mid-build never leaves a broken venv; once published it is reused indefinitely - there is no invalidation, so bumping the pin does not retroactively upgrade an existing venv.
4. **`unpdf` (degraded)** - pure-JS fallback (bundled PDF.js) when no rung above resolves. Output is plain text with page breaks - **no faithful tables/headings**. Degraded results are marked in the output (`[Note: degraded extraction via unpdf ...]`) and carry a closed-list `Fallback-Reason:` line (uv absent/failed, no capable Python, or venv bootstrap failure).

Per-OS cache dir for the managed venv:

| Platform | Cache dir |
|---|---|
| `win32` | `%LOCALAPPDATA%\pi-quiver` |
| `darwin` | `~/Library/Caches/pi-quiver` |
| other | `$XDG_CACHE_HOME/pi-quiver` (falls back to `~/.cache/pi-quiver`) |

**Known limitation:** on Windows, a Python exposed only through the `py` launcher (`py.exe`, no `python`/`python3` on `PATH`) is not detected - the candidates probed are `python3` and `python` only. Install `uv`, or expose `python`/`python3` directly.

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

`uv` still pins **Python 3.14** (not configurable); the system-Python and managed-venv rungs accept any Python >= 3.12 already on `PATH`. `PI_DOC_TO_MD_PYMUPDF_VERSION` also drives the managed venv's `pip install pymupdf4llm==<pin>`, so both the `uv` and venv rungs stay on the same pin.

## Runtime dependencies

`unpdf` (shipped in the npm package, installed automatically on `pi install`). `uv` and LibreOffice (`soffice`) are optional system binaries detected at runtime: without `uv`, PDFs fall through to the system-Python or managed-venv rungs, landing on the `unpdf` fallback only when no Python >= 3.12 is available; without `soffice`, office inputs error while PDFs are unaffected. See the README's [Prerequisites](../README.md#prerequisites) for the consolidated list.

## CLI (`pi-quiver doc-to-md`)

`npx -y pi-quiver@latest doc-to-md <path>` runs the same `convertDocument` core as the pi tool and prints `output` to stdout (tool output plus one trailing newline). See [README - Claude Code support](../README.md#claude-code-support) for what's exposed.

Exit codes:

| code | meaning |
|---|---|
| `0` | converted - includes degraded output via the `unpdf` fallback; check for the degraded marker / `Fallback-Reason:` |
| `1` | conversion failed: missing/unreadable file, unsupported extension, LibreOffice missing for `.docx`/`.pptx` |
| `2` | usage error: missing `<path>`, unknown flag, extra argument |

## Manual smoke (not CI)

CI pins the `unpdf` rung via a scrubbed `PATH`/cache environment; the other three rungs are not exercised in CI and need manual verification when touched:

- `uv` path: with `uv` on `PATH`, convert a PDF and confirm `Engine: pymupdf4llm` with no `Fallback-Reason:`.
- System-Python path: with `uv` off `PATH` but a `python3`/`python` >= 3.12 that already has `pymupdf4llm` importable, confirm the same clean conversion without a venv bootstrap.
- Managed-venv bootstrap: on a machine with neither `uv` nor `pymupdf4llm` pre-installed but a bare Python >= 3.12, run a conversion and confirm the one-time venv build at the per-OS cache dir, then a second run reusing it without rebuilding.
- `pi -e ./extensions/doc_to_md.ts -p "convert test/fixtures/sample.pdf"` against a local checkout, to sanity-check the pi tool path end to end.

## Licensing note

`pymupdf4llm`/PyMuPDF are **AGPL-3.0**. This package ships none of their code - `uv` downloads the wheel from PyPI onto your machine at runtime, and it runs as a **separate subprocess** (never imported or linked into this TypeScript). The arms-length process boundary keeps pi-quiver's MIT license intact; the AGPL governs PyMuPDF itself, whose source is public. This holds only while the boundary stays subprocess-only (no vendoring/importing the wheel).
