# Ledger - loop engine
**Spec:** `doc/specs/2026-11-26-gh-47-slack-attachment-download.md`
base: 8b2bebba75b64c8ba482ed8d479eb2223db65fe9
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 2
allowance: 10
returned: 1 | home | 4ed1e28100bd03205c7b39b580a22d5bfea4672e

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --test test/slack-core.test.ts; 105 passed, 0 failed; compact parent and reply lines list each file name and ID in Slack order |
| 2 | done | 0 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --test test/slack-core.test.ts; 105 passed, 0 failed; exact line assertions for messages without files pass unchanged |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | done | 0 | timeout -k 30 10 grep -Fq files:read doc/slack.md; the compact thread section names the files:read user-token scope for reading file contents |

## Decisions
row 0 done | seeded 2 rows, closed 0 on baseline | take row 1
row 1 done | Compact thread lines list each attachment's name and Slack file ID in message order. | Use the IDs in readThread's compact output as inputs to the download tool.
row 2 done | Messages without attachments still end at the message body, with no files marker. | nothing new to build on
row 5 done | The Slack guide names files:read as the user-token scope for reading attachment contents. | Use the attachment example in doc/slack.md when documenting the download call.
