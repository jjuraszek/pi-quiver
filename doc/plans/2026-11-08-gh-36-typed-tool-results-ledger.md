# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-36-typed-tool-results.md`
base: 620091bd35d15945dc0ac5dc0207b43a9d4d1832
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 8
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 180 env -u PI_CODING_AGENT_DIR node --test test/doc_to_md.test.ts; 126 passed, 1 skipped, 0 failed; conversion and info match CLI JSON and bundle excludes host/TypeBox; no paid or external actions launched |
| 2 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --test test/fetch.test.ts; 60 passed, 0 failed; HTTP/gh schemas, inline/spill bodies, caps and thrown errors verified locally; no paid or external actions launched |
| 3 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --test test/slack-config.test.ts; 112 passed, 0 failed; raw objects, four spill combinations, cap, throttle and schema drift verified locally; no paid or external actions launched |
| 4 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --test test/slack-config.test.ts; 113 passed, 0 failed; search paging, empty matches, schema drift and four independent spill combinations verified; no paid or external actions launched |
| 5 | done | 1 | timeout -k 30 180 env -u PI_CODING_AGENT_DIR node --test test/doc_to_md.test.ts test/fetch.test.ts test/slack-config.test.ts; 299 passed, 1 skipped, 0 failed; direct text for all four tools and doc-to-md CLI JSON unchanged; no paid or external actions launched |
| 6 | done | 0 | timeout -k 30 30 node -e 'require("node:assert/strict").deepEqual(((d) => [!d.includes("JSON.parse"), ...["messages", "file", "complete", "next_cursor", "message_count", "caveat", "cursor"].map(f => d.includes(f))])(require("node:fs").readFileSync("extensions/slack.ts", "utf8").match(/name: "slack_thread",[\s\S]*?description:([\s\S]*?)parameters:/)[1]), Array(8).fill(true), "slack_thread must name structured fields without JSON.parse")'; passed: description names all structured fields and cursor resumption without JSON.parse; no paid or external actions launched |
| 7 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --test test/slack-codemode.test.ts; 2 passed, 0 failed; model-free SDK sessions prove default exposure and real sandbox refresh in both modes; no paid or external actions launched |
| 8 | done | 1 | timeout -k 30 180 env -u PI_CODING_AGENT_DIR node --test test/slack-core.test.ts test/slack-config.test.ts test/slack-cli.test.ts; 237 passed, 0 failed; mapped errors prove per-surface recovery and refresh description names scripts only; no paid or external actions launched |
| 9 | open | 0 | |
| 10 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 6
row 1 done | Added typed conversion/info results with unchanged text and CLI JSON; no paid or external actions launched. | Reuse publicHandle in lib/doc-to-md-handle.ts for CLI-compatible projections and test/doc_to_md.test.ts for schema/adapter checks.
row 2 done | Added schema-validated fetch inline/spill results and core body data; no paid or external actions launched. | Reuse FetchResult.body in lib/fetch-core.ts for header-free bodies and test/fetch.test.ts for mocked HTTP/gh adapter checks.
row 3 done | Added typed thread results with independent JSON spills and preserved raw Slack fields; no paid or external actions launched. | Reuse SlackMessage and structuredMessages in extensions/slack.ts for search results, and test/slack-config.test.ts for mocked pagination and spill checks.
row 6 done | Replaced JSON.parse guidance with structured fields and cursor resumption; no paid or external actions launched. | Reuse the slack_thread description in extensions/slack.ts when documenting raw-mode independence and JSON spills.
row 4 done | Added typed search matches and paging with independent JSON spills; no paid or external actions launched. | Reuse SearchResult.matches in lib/slack-core.ts and the search scenarios in test/slack-config.test.ts for raw-field and spill regression checks.
row 5 done | Verified unchanged direct text for all four tools and doc-to-md CLI JSON with 299 passing tests; no paid or external actions launched. | nothing new to build on
row 7 done | Made cache refresh script-only and proved SDK exposure plus sandbox execution in both modes; no paid or external actions launched. | Reuse test/slack-codemode.test.ts for model-free host sessions with a synthetic assistant call and fake Slack transport.
row 8 done | Split channel_not_found recovery by surface and documented script-only refresh with 237 passing tests; no paid or external actions launched. | Reuse formatToolError and runSlack for surface-specific hints, and doc/slack.md for the script-only refresh contract.
