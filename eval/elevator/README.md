# Elevator replay

Test whether `prompts/elevator.md` produces a PM elevator talk in prose instead of numbered answers. The harness strips frontmatter and uses the remaining file as the system prompt. `replay.md` supplies the subject from each synthetic case; the raw `${@:-...}` placeholder is the slash-expansion approximation.

## Run

Use a pi-gauntlet checkout at commit `d0a2cadacf20cd4b530ae651fcd2b536cbea07ad`, which adds `--root` and keeps the judge prompt in the runner's checkout. The harness is checkout-only, not an npm dependency. Use its frozen replay models and judge with authenticated `pi` on PATH.

Run from the pi-quiver checkout. For a `.worktrees/<name>` home, set the path before invoking the runner:

```bash
export PI_GAUNTLET=../../../pi-gauntlet
node "${PI_GAUNTLET:-../pi-gauntlet}/eval/run.mjs" --root . --base 637f166684e3e14924f36fe1ba97ecb9a66595d3 elevator --baseline-only
node "${PI_GAUNTLET:-../pi-gauntlet}/eval/run.mjs" --root . --base 637f166684e3e14924f36fe1ba97ecb9a66595d3 elevator
```

The default `../pi-gauntlet` applies to sibling primary checkouts. Seed the baseline once from the pinned `--base` commit (`637f166`, the five-question body); without `--base` the harness falls back to `git merge-base HEAD origin/main`, which rerolls the baseline once this body is on main. Retain the first `results/*/baseline.json` records, including errors; never reroll them for shorter or more favorable replies. A baseline error blocks the comparison: resolve its assessment contract before invoking the runner again, because the harness retries error cells. Keep the candidate cap at 220 words.

Bind `intent.md`'s `for:` to the candidate assembly SHA printed by a stale-intent refusal. Declare a `no-numbered-list` fails-to-holds move for each sample whose retained baseline lists. Rebind after a wording edit; keep the cases and first baseline fixed.

Commit `results/` and `report.md` with the wording change. Run by hand, not in CI. Read all eight sample/model cells: exit 0 alone is insufficient. Every candidate fact must hold, every candidate must stay within 220 words, and at least one baseline must fail `no-numbered-list`. Both short-question replies must hold `two-or-three-sentences`. A fact failing on both arms is not accepted variance.

## Cases

| Sample | Behavior |
|---|---|
| `bug-fix` | Explain a stale name-cache entry with its root cause and a concrete example. |
| `design-proposal` | Reject the once-at-startup assumption using the existing per-call settings read. |
| `short-question` | Answer the rename question in two or three sentences. |
| `ticket-ask` | Name the impossible zero-miss criterion and end with a ship-or-push-back pick. |

`no-numbered-list` rejects three numbered item-start lines anywhere, including blank-separated and wrapped lists. One or two numbered lines do not count as a list. All examples and numbers are synthetic case facts; the shared hygiene scan remains the only denylist. The target stays outside the npm `files` allowlist.
