# Ledger - loop engine
**Spec:** `doc/specs/2026-11-19-gh-44-message-timestamps-footer-transcript.md`
base: 73bd90c390ef0fddb170645795ab4391710b3599
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 6
allowance: 10
returned: 10 | home | ae93f8e5e5cc8dcf2725a909aede9b361c616c63

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 1 passed; the footer matched the saved prompt at the first request and the saved final reply after the run |
| 2 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 8 passed; the built-in footer kept the same height and displayed both statuses on its last row |
| 3 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 11 passed; with no other status the enabled timestamp added one rendered footer row |
| 4 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 2 passed; the reopened session showed the saved custom message time rather than the later display record |
| 5 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 3 passed; navigating to a sibling reply changed the footer to its saved minute |
| 6 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 4 passed; an empty session explicitly cleared the timestamp status on startup |
| 7 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 5 passed; footer false in project settings suppressed the status throughout the turn |
| 8 | done | 1 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 12 passed; without settings the saved turn contained no timestamp record and no timestamp entry reached the live transcript |
| 9 | done | 1 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 13 passed; three tool calls produced two dim lines in live and saved order, after the prompt and the final reply |
| 10 | failed | 2 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 21 passed, 1 failed; live chat showed the 04:00 PM settle line before the shell output while replay showed it after; Pi waits for all extension settle handlers before it moves shell output into chat, so even a setImmediate append can arrive first |
| 11 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 17 passed; four tool-loop requests and the first request after reopening contained neither timestamp entries nor their displayed times |
| 12 | open | 0 | |
| 13 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 20 passed; with both switches configured, print, json and rpc wrote no records, sent no UI updates and read no settings |
| 14 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 14 passed; all four set forms changed only the selected switch in the same TUI session |
| 15 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 14 passed; bare and set commands reported both switches and bad arguments warned without changing either |
| 16 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 13 passed; toggling the footer after the third tool result immediately cleared and restored that result's saved minute |
| 17 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 15 passed; turns after off and on wrote zero and two records respectively, and mid-run changes affected only the settle line |
| 18 | done | 0 | timeout -k 30 60 node --test test/message-timestamps.test.ts; 16 passed; every command left settings.json byte-identical and a fresh session in the same project restored both configured switches |
| 19 | done | 0 | timeout -k 30 10 python3 -c 'assert all(s in open("README.md").read() for s in ("quiver.messageTimestamps", "`footer` (default `true`)", "`transcript` (default `false`)", "/timestamps footer off", "/timestamps transcript on", "footer without setup"))'; README lists both defaults, the session commands and the footer without setup |
| 20 | done | 0 | timeout -k 30 10 node -e 'process.exitCode = Number(!/^## Unreleased\r?\n(?:(?!^## )[\s\S])*?^- .*message-timestamps.*\(#44\)\r?$/m.test(require("node:fs").readFileSync("CHANGELOG.md", "utf8")))'; Unreleased lists message-timestamps with the #44 reference |

## Decisions

row 0 done | seeded 2 rows, closed 0 on baseline | row 1
row 1 done | The TUI footer shows the saved prompt time before the model request and the final reply time after the run. | Reuse formatTime and newestMessageTime in extensions/message-timestamps.ts to display the newest saved message on the selected branch.
row 4 done | Resuming a file session restores the newest saved message time before another prompt. | Pass a manager factory to timestampSession to test an existing session file at startup.
row 5 done | Tree navigation refreshes the footer from the newly selected branch before another prompt. | Reuse the sibling-branch fixture in test/message-timestamps.test.ts to exercise navigation with distinct saved minutes.
row 6 done | An empty session clears the timestamp status instead of displaying a time. | Inspect setStatus.mock.calls from timestampSession to distinguish an explicit clear from no UI call.
row 7 done | The TUI resolves both switches at startup and leaves the footer time hidden throughout a turn when footer is false. | Reuse DEFAULT_CONFIG, coerce and the resolved session config for the transcript switch and live toggles.
row 2 done | The built-in footer displays the timestamp beside another status without gaining a row. | Add a case to the FooterComponent layout table in test/message-timestamps.test.ts to compare renders with the footer switch off and on.
row 3 done | With no other extension status present, the timestamp adds exactly one row to the built-in footer. | nothing new to build on
row 20 done | The Unreleased changelog introduces the default-on timestamp footer and names its settings switch. | Extend the existing #44 bullet in CHANGELOG.md when transcript lines and the command are available.
row 8 done | With no settings, a completed TUI turn shows no transcript time line and saves no timestamp record. | Reuse the file-backed turn in test/message-timestamps.test.ts to compare live entry_appended events with records reopened from disk.
row 9 done | A three-tool run saves and displays exactly two dim time lines, immediately after the user prompt and the final reply. | Reuse renderRecord and the file-backed three-read run in test/message-timestamps.test.ts to compare live and replayed transcript lines.
row 16 done | The footer command immediately hides the status or restores the newest saved message's time, even during a tool loop. | nothing new to build on
row 14 done | Each of the four command forms changes one display and leaves the other alone in the current session. | Reuse parseArgs in extensions/message-timestamps.ts to distinguish a status request, a valid switch setting and invalid input.
row 15 done | The bare command and every valid set command report both switch states, while invalid arguments show usage. | Reuse the command table and notify spy in test/message-timestamps.test.ts to compare reports with what the two displays show.
row 17 done | The transcript toggle controls new lines from the next message, including the settle line when toggled mid-run. | Reuse the before/during table in test/message-timestamps.test.ts to inspect just the records written by each turn.
row 18 done | Changing either switch leaves project settings byte-identical, and a fresh session restores both configured values. | Pass the same cwd to timestampSession in a subtest to start a fresh extension factory against the original project's settings.
row 11 done | None of the four requests in the tool loop or the first request after resume included a record or its rendered time. | Reuse the faux provider request capture in the multi-tool test to inspect exactly what reaches the model.
row 13 done | Print, json and rpc sessions ignored the timestamp settings and command and saved no timestamp records. | Pass a mode to timestampSession to exercise real non-TUI turns and inspect their saved entries.
row 19 done | README documents both timestamp defaults, the session commands and when existing transcript lines change. | Link to README.md#message-timestamps for settings, toggle examples and redraw behavior.
row 10 failed | Resume and reload show both original times in place, but the live settle line still precedes deferred shell output. | Keep the replay fix; use the deferred-shell test to check a host hook after the TUI moves shell output into chat, or amend the live-order requirement.
row 10 failed | The deferred-shell test shows that even a setImmediate append can display the settle time before shell output while Pi awaits another extension. | Do not delay the append with a timer; move the shell flush before the extension settle hook in Pi, or amend the live-order requirement and keep shell-first replay.
