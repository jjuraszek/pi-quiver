# Ledger - loop engine
**Spec:** `doc/specs/2026-11-19-gh-44-message-timestamps-footer-transcript.md`
base: 73bd90c390ef0fddb170645795ab4391710b3599
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 3
allowance: 10
returned: 8 | home | 21e4dc5899353946a223c9fc66da65f67c19ae38

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
| 9 | open | 0 | |
| 10 | open | 0 | |
| 11 | open | 0 | |
| 12 | open | 0 | |
| 13 | open | 0 | |
| 14 | open | 0 | |
| 15 | open | 0 | |
| 16 | open | 0 | |
| 17 | open | 0 | |
| 18 | open | 0 | |
| 19 | open | 0 | |
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
