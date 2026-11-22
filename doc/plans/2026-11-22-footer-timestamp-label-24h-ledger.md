# Ledger - loop engine
**Spec:** `doc/specs/2026-11-22-footer-timestamp-label-24h.md`
base: e78f808e4b1b08a81ef05e034aa57e5c9a8b9cd4
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 2
allowance: 10
returned: 1 | home | fb2ffbb42c2bba30eebc37b69420f1e1c7a833c4

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR node --test test/message-timestamps.test.ts; 36 passed, 0 failed; final reply footer was exactly '2026-11-19 14:59' |
| 2 | done | 0 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR TZ=Asia/Kathmandu node --test test/message-timestamps.test.ts; 36 passed, 0 failed; the live and replayed prompt line matched 'dim:2026-11-19 14:59' |
| 3 | done | 0 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR TZ=Asia/Kathmandu node --test test/message-timestamps.test.ts; 36 passed, 0 failed; local January 2 at five minutes past midnight rendered as '2026-01-02 00:05' |

## Decisions

row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 done | The footer shows only the newest saved message's local time, such as 2026-11-19 14:59. | Use formatTime(date) for the same fixed local timestamp in the transcript.
row 2 done | The transcript test checks the exact local prompt time on display and after replay. | Reuse the deferred shell test in test/message-timestamps.test.ts to check both render paths.
row 3 done | The formatter test confirms that local midnight uses hour 00 and pads single-digit fields. | Extend the local date cases in test/message-timestamps.test.ts for other clock boundaries.
