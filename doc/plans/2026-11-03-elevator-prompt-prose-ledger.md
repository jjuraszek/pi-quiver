# Ledger - loop engine
**Spec:** `doc/specs/2026-11-03-elevator-prompt-prose.md`
base: 1d204b476bbd57385a693a86f086c03a979bc59d
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 2
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | node --test test/prompts.test.ts; 4 passed, 0 failed; Shared prose bodies are byte-identical with no numbered lines or in-order instruction |
| 2 | done | 0 | node --test test/prompts.test.ts; 4 passed, 0 failed; Host headers and empty-subject contracts remain unchanged |
| 3 | done | 0 | node --test test/prompts.test.ts; Reintroduced numbered questions in both bodies fail the numbered-line assertion (3 passed, 1 failed); Restored shipped bodies pass (4 passed, 0 failed) |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | |
| 7 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1: rewrite both shared bodies to pass test/prompts.test.ts.
row 1 done | Replaced both five-question bodies with the shared PM elevator-talk prose and short-answer release valve. | Reuse prompts/elevator.md as the eval candidate and keep skills/elevator/SKILL.md byte-identical below the host paragraph.
row 2 done | Verified that both host headers retain their original PM elevator-talk input contracts. | nothing new to build on
row 3 done | Confirmed the guard rejects numbered questions reintroduced in both bodies and passes after restoring the shipped prose. | nothing new to build on
