# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-36-typed-tool-results.md`
base: 620091bd35d15945dc0ac5dc0207b43a9d4d1832
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 3
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 180 env -u PI_CODING_AGENT_DIR node --test test/doc_to_md.test.ts; 126 passed, 1 skipped, 0 failed; conversion and info match CLI JSON and bundle excludes host/TypeBox; no paid or external actions launched |
| 2 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --test test/fetch.test.ts; 60 passed, 0 failed; HTTP/gh schemas, inline/spill bodies, caps and thrown errors verified locally; no paid or external actions launched |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | timeout -k 30 30 node -e 'require("node:assert/strict").deepEqual(((d) => [!d.includes("JSON.parse"), ...["messages", "file", "complete", "next_cursor", "message_count", "caveat", "cursor"].map(f => d.includes(f))])(require("node:fs").readFileSync("extensions/slack.ts", "utf8").match(/name: "slack_thread",[\s\S]*?description:([\s\S]*?)parameters:/)[1]), Array(8).fill(true), "slack_thread must name structured fields without JSON.parse")'; failed: description still contains JSON.parse and omits message_count; no paid or external actions launched |
| 7 | open | 0 | |
| 8 | open | 0 | |
| 9 | open | 0 | |
| 10 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 6
row 1 done | Added typed conversion/info results with unchanged text and CLI JSON; no paid or external actions launched. | Reuse publicHandle in lib/doc-to-md-handle.ts for CLI-compatible projections and test/doc_to_md.test.ts for schema/adapter checks.
row 2 done | Added schema-validated fetch inline/spill results and core body data; no paid or external actions launched. | Reuse FetchResult.body in lib/fetch-core.ts for header-free bodies and test/fetch.test.ts for mocked HTTP/gh adapter checks.
