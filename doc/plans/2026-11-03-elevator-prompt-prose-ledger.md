# Ledger - loop engine
**Spec:** `doc/specs/2026-11-03-elevator-prompt-prose.md`
base: 1d204b476bbd57385a693a86f086c03a979bc59d
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 3
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | node --test test/prompts.test.ts; 4 passed, 0 failed; Shared prose bodies are byte-identical with no numbered lines or in-order instruction |
| 2 | done | 0 | node --test test/prompts.test.ts; 4 passed, 0 failed; Host headers and empty-subject contracts remain unchanged |
| 3 | done | 0 | node --test test/prompts.test.ts; Reintroduced numbered questions in both bodies fail the numbered-line assertion (3 passed, 1 failed); Restored shipped bodies pass (4 passed, 0 failed) |
| 4 | done | 1 | node ../../../pi-gauntlet/eval/run.mjs --root . elevator; 8 improved cells and all 54 candidate facts hold; Candidates contain 46-186 words; First baseline retains 4 no-numbered-list failures |
| 5 | done | 0 | python3 -c 'assert __import__("pathlib").Path("eval/elevator/report.md").read_text().count("no-numbered-list: fails -> holds") == 4 and __import__("pathlib").Path("eval/elevator/report.md").read_text().count("no-numbered-list: holds -> holds") == 4'; 4 baseline list failures and 8 candidate passes; First baseline hashes remain unchanged |
| 6 | done | 0 | python3 -c 'assert __import__("pathlib").Path("eval/elevator/report.md").read_text().count("two-or-three-sentences: fails -> holds") == 2'; Both short-question replies hold the judged sentence-count fact |
| 7 | done | 0 | python3 -c 'assert not any(f["path"].startswith("eval/") for f in __import__("json").loads(__import__("subprocess").check_output(["npm", "pack", "--dry-run", "--json"]))[0]["files"])'; npm pack builds successfully and lists no eval/ files |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1: rewrite both shared bodies to pass test/prompts.test.ts.
row 1 done | Replaced both five-question bodies with the shared PM elevator-talk prose and short-answer release valve. | Reuse prompts/elevator.md as the eval candidate and keep skills/elevator/SKILL.md byte-identical below the host paragraph.
row 2 done | Verified that both host headers retain their original PM elevator-talk input contracts. | nothing new to build on
row 3 done | Confirmed the guard rejects numbered questions reintroduced in both bodies and passes after restoring the shipped prose. | nothing new to build on
row 4 done | Added the four-case replay and refined both prompt bodies until all eight cells passed every fact under 220 words. | Reuse eval/elevator/ with the pinned pi-gauntlet runner; retain its first baselines and rebind intent.md after wording edits.
row 5 done | Verified four retained baseline list failures and eight candidate list passes in the report. | nothing new to build on
row 6 done | Verified that both short-question replies hold the two-or-three-sentences fact. | nothing new to build on
row 7 done | Verified npm pack excludes every eval/ file from the published package. | nothing new to build on
