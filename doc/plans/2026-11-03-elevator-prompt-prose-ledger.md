# Ledger - loop engine
**Spec:** `doc/specs/2026-11-03-elevator-prompt-prose.md`
base: 1d204b476bbd57385a693a86f086c03a979bc59d
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | node --test test/prompts.test.ts; 3 passed, 1 failed; Shared body contains numbered question lines |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | |
| 7 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1: rewrite both shared bodies to pass test/prompts.test.ts.
