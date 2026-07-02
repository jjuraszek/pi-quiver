# Sketch: bash scan hygiene guard (grep/find output discipline)

- **Date:** 2026-07-02
- **Package:** pi-essentials (new extension, e.g. `scan-guard.ts`)
- **Status:** SKETCH — brainstorming input only. Not reviewed, not committed. Intended as the starting-point artifact for the gauntlet/superpowers brainstorming process, which will challenge and reshape it. Do NOT treat any decision below as settled.

> This is deliberately under-specified. It captures the problem, the evidence, the value thesis, and the constraints/corrections already surfaced — so brainstorming starts from ground truth instead of re-deriving it. Architecture, config surface, and exact thresholds are left open on purpose.

---

## 1. Origin

pi-navigator is being wound down. Its lifetime telemetry showed the core `repo_locate`/`repo_slice` bet is adoption-dependent and adoption failed: ~85% interactive bypass, ~77% missed-orientation, ~8% nudge conversion, despite 5+ tuning attempts and a system-prompt directive. Ranking quality when used was genuinely good (MRR ~0.84-1.0), but almost never realized because the model won't *choose* to call an orientation tool.

The one mechanism in navigator that delivered value **without requiring the model to adopt a new tool** was the command-intercept hook (`find-guard` / grep-guard): it fires on commands the model *already runs*. That is the piece worth extracting into pi-essentials, which already owns "context hygiene" as its charter (`fetch` and `doc_to_md` are both output-size gates).

This sketch is that extraction — reframed.

## 2. The reframe (what this is NOT)

The tempting framing is "port grep->rg and find->fd usage" — auto-swap the inefficient tool for the efficient one. **Reject that framing.** Two reasons, both hard constraints for brainstorming:

1. **grep->rg / find->fd is not a safe rewrite.** They are not drop-in equivalents:
   - `rg` respects `.gitignore`, skips hidden files, uses a different regex engine (no backreferences by default). `grep -r pat build/` finds hits; `rg pat build/` silently returns nothing when `build/` is gitignored. Meaning changes silently.
   - `find . -name '*.ts'` -> `fd -e ts` is a rewrite, not a flag mapping; `find -exec` has no clean fd analog.
   - An auto-rewriter would silently alter what the model's command *means* -> correctness footgun. **No command rewriting/transpiling.**

2. **The efficiency framing is the weak version.** grep-vs-rg CPU time is milliseconds — nobody notices. The real cost is **context pollution**: `grep -r` with no filter dumps thousands of lines, walks binaries and generated trees, and floods the window. The defensible value is **output hygiene + correctness guardrails**, not binary substitution. This is also exactly pi-essentials' existing thesis.

## 3. The value thesis (the "undeniable value" test)

A mechanism is worth building here only if it passes: **does it deliver value without the model having to adopt anything?**

- Tools the model must elect to call (`repo_locate`, `repo_slice`) fail the test — navigator proved it.
- A hook that fires on the model's *own* `grep`/`find`/`rg` command passes it — zero adoption tax.

Critical corollary from navigator telemetry: **a nudge-only guard inherits the 8% conversion failure.** If the guard merely appends "consider using rg", it moves the dead 8% problem into a new package. The value must come from **acting on the command/output** (capping, filtering, guarding) regardless of whether the model changes behavior. Nudging, if present at all, is secondary.

## 4. Problem statement (candidate)

The bash tool lets the model run unbounded `grep -r` / `find` scans that:
- flood context with large output (the actual cost),
- walk `node_modules`, `.git`, `dist/`, build trees, and binaries,
- occasionally use the slow tool when a faster one exists (minor).

pi-essentials should intercept these to protect context health, matching how `fetch`/`doc_to_md` already gate output — without changing command semantics.

## 5. Hook mechanism (grounded — do not re-derive)

Verified against the installed `@earendil-works/pi-coding-agent` API (navigator uses the same two points today):

- **`pi.on("tool_call", (event, ctx) => ...)`** with `isToolCallEventType("bash", event)`:
  - Read `event.input.command`, `event.toolCallId`.
  - Return `{ block: true, reason }` to block, or `undefined` to allow. This is the pre-execution intercept.
- **`pi.on("tool_result", (event) => ...)`** with `isBashToolResult(event)`:
  - Return `{ content: <modified> }` to rewrite/augment the produced output. This is the post-execution intercept (where capping/filtering happens).

Classifier prior art to steal from navigator (reference, not dependency): `src/find-guard.ts::classifyFindCommand`, `src/nudge.ts`, and the grep classifier in `index.ts`. They already parse a bash command line into "is this a source-scan / repo-scan" with an extension allowlist.

## 6. Candidate directions (for brainstorming to weigh — not a decision)

Ordered roughly weakest -> strongest on the "undeniable value" test:

- **A. Nudge-only** (append "use rg/fd"). Rejected as primary — inherits navigator's 8% failure. Possibly a minor add-on.
- **B. Output cap on the result** (post-hook): if a `grep`/`find` result exceeds N lines / K bytes, truncate + spill to a temp file with a head preview and a grep/read-slice instruction — mirroring `fetch`'s spill-to-file. Delivers value with zero adoption. Strong candidate.
- **C. Pre-scan guard/warn** (pre-hook): when a scan targets a known context-killer dir (`node_modules`, `.git`, `dist/`, `build/`, `vendor/`) or would clearly walk generated/binary trees, warn or block with a reason. Delivers value with zero adoption. Strong candidate.
- **D. Suggest-the-equivalent** (post-hook, informational): show the rg/fd form in the result *without running it*. Never rewrite. Optional garnish on B/C.

Likely the real answer is **B + C** as the core, with D as optional. But that is exactly what brainstorming should pressure-test.

## 7. Non-goals (current lean — challengeable)

- No command rewriting/transpiling (see §2.1).
- No index, no background worker, no sqlite, no tree-sitter — the whole point is to shed navigator's machinery. If a candidate reintroduces an index, it has failed the brief.
- No new tool the model must call. Hooks only.
- No adoption telemetry stack rebuild. (Open question whether *any* lightweight counter is worth it — see §8.)

## 8. Open questions (seed the brainstorm)

1. **Cap vs guard vs both** — is the primary value output-capping (B), pre-scan guarding (C), or both? What's the minimum that's still worth shipping?
2. **Block vs warn** — should a scan into `node_modules` ever be *blocked*, or only warned + output-capped? Blocking changes model behavior but risks false positives on legitimate scans.
3. **Thresholds** — what line/byte cap triggers spill? Reuse `fetch`'s 32KB / 1000-line gate for consistency, or scan-specific?
4. **Scope of interception** — only `grep`/`find`, or also `rg`/`fd`/`cat`/`ls -R` when they flood? (A giant `rg` dump pollutes context just as badly.)
5. **Classifier reuse** — port navigator's `classifyFindCommand` / grep classifier, or write a leaner one? What's the false-positive tolerance?
6. **Config surface** — opt-in (like `session-name`/`sword-header`) or on-by-default (like `fetch`)? Does it need `extension-config.ts` layering?
7. **Any telemetry at all?** — a tiny "N scans capped / N context-killer scans blocked" counter would prove value cheaply, but navigator's telemetry stack was heavy. Is a minimal counter worth it, or ship blind?
8. **Interaction with subagents** — should the guard behave differently for granted-subagent sessions vs interactive? (Navigator tracked `session_class`; do we care here?)

## 9. Evidence appendix (navigator lifetime telemetry, motivating this)

From `~/.pi/pi-navigator-cache/*.telemetry.db`, lifetime aggregate (data-rich repos):

| Repo | interactive bypass | missed-orientation | nudge conversion | MRR (when hit) | hit@1 |
|---|---|---|---|---|---|
| repo-a | 83.5% | 76.6% | ~8% | 0.84 | 29.8% |
| repos | 86.7% | 78.4% | ~9% | ~1.0 | 12.5% |

Reading: the model bypasses the orientation tool even mid-orientation; nudges barely convert; ranking is good but rarely reached. -> pull-tool + nudge is the failed pattern. Hook-that-acts-on-output is the surviving pattern. This sketch is built entirely on the surviving pattern.
