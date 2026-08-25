---
name: fetch
description: Fetch any URL via the quiver fetch CLI - use instead of WebFetch for GitHub issue/PR/repo/Actions-run/Actions-job URLs (routed through authenticated gh, with failed-step logs appended for failed runs/jobs), binary downloads (PDFs, images, archives - saved to a temp path, never dumped to output), large pages (size-capped, spilled to a file with a preview), and clean readability-extracted Markdown. Invoke via Bash.
---

# Fetch a URL

Run:

```bash
npx -y pi-quiver@latest fetch <url>
```

Flags (all optional):

| flag | meaning |
|---|---|
| `--method GET\|HEAD\|POST` | HTTP method (default GET) |
| `--header "Key: Value"` | extra request header; repeatable; overrides defaults like User-Agent |
| `--body <string>` | request body for POST |
| `--raw` | skip HTML->Markdown and JSON pretty-printing; also forces plain HTTP for GitHub URLs |
| `--timeout-ms <n>` | request timeout (default 20000) |

Behavior:

- GitHub issue/PR/repo/Actions-run/Actions-job URLs are served via the `gh` CLI when installed and authenticated (comments included); otherwise plain HTTP. Failed runs/jobs append a `## Failed step logs` section (best-effort; summary-only when nothing failed, the run is still in progress, or logs have expired).
- HTML pages come back as readability-extracted Markdown. JSON is pretty-printed.
- Output over 32KB or 1000 lines is written to a temp file; stdout then carries `Saved-To: <path>` plus a 60-line preview. Read slices of that file (offset/limit) or grep it - do not re-read the whole file.
- Binary content (PDF, images, archives) is never printed: stdout carries the HTTP status/headers plus a `Saved-To: <path>` line and a note that the content is not decoded, but never the binary bytes. Hand that path to the Read tool or another command.
- Text downloads are capped at 1MB, binary at 50MB; truncation is noted in the output.

Exit codes: `0` = response received (including HTTP 4xx/5xx and truncated bodies - check the `HTTP <status>` line), `1` = fetch failed (DNS, timeout, bad URL), `2` = usage error.

Requires Node.js (the `npx` runner); no other setup.
