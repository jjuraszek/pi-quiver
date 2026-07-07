# fetch - content routing & context hygiene

`fetch` is the main way an agent pulls external bytes into context. This extension routes responses by type to keep context tight.

## HTML -> Markdown

- Mozilla Readability extracts main content, strips navigation/chrome/boilerplate
- Turndown converts to Markdown with GFM support (pipe tables, fenced code blocks, ATX headings)
- Page title becomes a top-level `#` heading
- Download cap: **1 MB**

## Binary (images, PDFs, archives, fonts, audio/video) -> temp file

- Streamed untouched to `${TMPDIR}/pi-fetch/<stamp>-<host>-<hash>.<ext>` without decoding
- Detection: content-type check + NUL-byte sniff in first <=64 KB (catches mislabeled payloads)
- Returns: status, content-type, size, file path - **no preview**
- Download cap: **50 MB**

## Text / Markdown / JSON size gate

- Inline when **<= 32 KB AND <= 1000 lines** (converted output size)
- Otherwise **spills to file** with:
  - HTTP status, content-type, charset, byte/line counts
  - File path (`Saved-To:`)
  - 60-line preview
  - Instruction to `grep` (Markdown is grep-able by heading: `^#`) or `read` slices

JSON: pretty-printed with 2-space indent before the gate.

## GitHub URLs -> `gh`

`github.com` issue (`/issues/{n}`), PR (`/pull/{n}`), and repo-root (`/{owner}/{repo}`) URLs are served by running the `gh` CLI (`gh issue|pr view --comments`, `gh repo view`) and returning its output, tagged with a `Source: gh ...` header and run through the same size gate.

Requires `gh` (see the README's [Prerequisites](../README.md#prerequisites)); if `gh` is missing or the call fails, `fetch` silently falls back to the normal HTTP path. Pass `raw=true` to force the rendered HTML page. All other GitHub paths (`tree`, `blob`, `raw`, `releases`, gists, ...) use the HTTP path unchanged. Routing is also skipped (plain HTTP used) when the request is non-GET, carries a body, or sets custom headers.

`gh` output is bounded by a 10 MB buffer and run through the same size gate (spilled to a file when large), not the 1 MB HTTP download cap.

## Parameters

- `raw=true`: skip HTML->Markdown and JSON pretty-printing; return decoded body as-is (still subject to the size gate). Also bypasses GitHub `gh` routing (forces the HTTP/rendered path).

## Truncation

Parsable content over 1 MB is truncated with a `(truncated to 1MB)` note; binary over 50 MB notes `(truncated to 50MB)`.

## Runtime dependencies

`jsdom`, `@mozilla/readability`, `turndown`, `turndown-plugin-gfm`. Shipped in the npm package and installed automatically on `pi install` - no manual setup needed.
