# Ledger - loop engine
**Spec:** `doc/specs/2026-11-09-gh-38-doc-to-md-enum-single-source.md`
base: 977bcecd056fd73cbb71eb16cc9e9c28f4ce34c5
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | |
| 2 | done | 0 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --test test/layout.test.ts; 12 passed, 0 failed; lib TypeBox ban passes; no paid or external action launched |

## Decisions
row 0 done | seeded 1 rows, closed 1 on baseline | row 1
