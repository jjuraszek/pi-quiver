# Elevator prompt as prose, with a replayed eval

**Goal:** Rewrite the shared `/elevator` body so it reads as a talk, not a five-slot form, and add a hand-run eval under `eval/elevator/` that replays the body through pi-gauntlet's harness and reports the before/after list rate and judged facts.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop

supersedes doc/specs/2026-10-30-gh-32-elevator-prompt-template.md, Design shared body and drift guard; Out of scope committed eval harness

## Problem

The shipped `/elevator` body (`prompts/elevator.md:11-18`, byte-identical in `skills/elevator/SKILL.md`) says "Answer, in order, only what applies:" and lists five numbered questions. Models read that as five slots to fill: across the local session corpus (11,509 session files scanned), 19 `/elevator` invocations in 13 sessions got a reply, and 11 of them came back as an explicit numbered 1-5 list; one more sampled reply was unnumbered but five topical blocks mirroring the questions, and one was three natural paragraphs. So the form wins most of the time (58% numbered), not always - the premise "always a 5-point list" is corrected to "most of the time", and the eval below measures a rate rather than a binary. The register the user wants is already written down once, in `AGENTS.md` Communication Style ("elevator talk: three beats, each a whole sentence"); the prompt body contradicts it with a fixed-slot structure, and `test/prompts.test.ts:5-16` freezes those five questions as a literal, so the body cannot change without the test.

Framing: kept - checked the shared body, the drift test, the pi prompt loader's `${@:-...}` expansion (executed for empty and multi-word args), the npm `files` allowlist, the gauntlet `eval/` runner, and the session corpus. The root-cause change is the body and its drift guard; no new machinery is needed for the wording.

"Astra" is the model `github-copilot/gpt-6-astra`, not a persona; it already sits on the spec council, so the wording reaches it in the critique pass.

Eval scope changes a predecessor decision: the previous spec's Out of scope declined a committed harness ("one 30-line prompt does not justify porting pi-gauntlet's `eval/`"). The user's answer here reverses that: reuse pi-gauntlet's harness in place rather than port it. The harness (`~/repos/pi-gauntlet/eval/run.mjs`, checkout-only, not published) already does the work: `runTarget({ root, ... })` (`run.mjs:159`) takes any repo root; only the CLI entry (`run.mjs:399`) hardcodes the gauntlet checkout, and `judge.md` is read from `<root>/eval/judge.md` (`run.mjs:185`). A `kind: text` target assembles `skillFiles` as the system prompt, prepends `replay.md` to each sample's `case.md` as the user turn, replays on two frozen models (`anthropic/claude-opus-5-5`, `github-copilot/gpt-6.1-sol`, thinking medium), scores `mechanical:` facts in code and `judged:` facts through a frozen judge, enforces `wordCap`, and compares the merge-base body against the working tree, so one run is the before/after measurement. Membership: `.pi/gauntlet-overrides.md` declares no sibling, so pi-gauntlet is not a leg of this spec; its `--root` flag is a dependency landed as a separate commit in that repo.

Premises verified: `eval/` is absent from `package.json` `files` (`package.json:35-44`) and from `extensions/`, so neither the packed-install nor the layout test sees it; `test/prompts.test.ts` passes 4/4 on `main`; gauntlet's hygiene scan refuses `/Users/<name>` paths, the owner handle, and token shapes over the target tree. Not checked: a live call to `github-copilot/gpt-6-astra` (council membership only), and the Claude Code plugin load of the edited skill (marketplace allowlist read, not loaded) - both are verification steps, not design inputs.

## Acceptance criteria

Drafted from the design, no ticket rows:

- [ ] `prompts/elevator.md` and `skills/elevator/SKILL.md` share a byte-identical body below their first line, and that body contains no line starting with a digit followed by `.` or `)` and no "in order" instruction.
  in-scope
- [ ] The pi first line is still `Explain ${@:-the thing we were just discussing} like for a PM during an elevator talk.` and the Claude first line is still `Explain $ARGUMENTS like for a PM during an elevator talk.`
  in-scope
- [ ] `node --test test/prompts.test.ts` fails when the numbered question list is reintroduced into the body and passes on the shipped body.
  in-scope
- [ ] `node "${PI_GAUNTLET:-../pi-gauntlet}/eval/run.mjs" --root . elevator` run from the leg home exits 0 (no `error`, `inconclusive`, or `regressed` cell), and the committed `eval/elevator/report.md` shows, on every one of the eight sample/model cells, the candidate arm holding `no-numbered-list` (fewer than three numbered item-start lines anywhere in the reply), staying under `wordCap`, and holding every other mandatory candidate fact; a candidate fact that fails on both arms is not accepted as variance.
  venue: local checkout with a sibling pi-gauntlet checkout (`PI_GAUNTLET`, default `../pi-gauntlet`) at the pinned commit carrying the `--root` flag - the harness exits 0 and writes `eval/elevator/report.md`
- [ ] The committed `eval/elevator/report.md` shows the baseline body (merge-base) failing the `no-numbered-list` mechanical fact on at least one sample and the candidate body holding it on all.
  in-scope
- [ ] The `short-question` sample's candidate reply holds the `two-or-three-sentences` judged fact on both replay models in `eval/elevator/report.md`.
  in-scope
- [ ] `npm pack --dry-run` lists no file under `eval/`.
  in-scope

## Legs

### Leg: jjuraszek/pi-quiver
branch: jacek/elevator-prose
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: env -u PI_CODING_AGENT_DIR npm run test:all; npm pack --dry-run; PI_GAUNTLET=../../../pi-gauntlet node "${PI_GAUNTLET:-../pi-gauntlet}/eval/run.mjs" --root . elevator
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: .pi/gauntlet-overrides.md
scope: none
design: owns `prompts/elevator.md`, `skills/elevator/SKILL.md`, `test/prompts.test.ts`, `eval/elevator/**`, `README.md`, `AGENTS.md`, `CHANGELOG.md`; observable outcomes are the acceptance rows above.

## Design

### Prompt body

Remove: the "Answer, in order, only what applies:" line and the five numbered questions from both files; the `max ~8 lines` cap phrase.
Add: one shared body (identical below the first line in both files) with two paragraphs, written as positive recipes so `/skill:forge-skill`'s authoring rules apply without a precedence exception. Paragraph one sets the register as a recipe: speak in one paragraph of whole sentences, lead with the outcome, use plain words a PM follows without the code open, back each claim with one concrete example, and spend words only on what the reader needs to act (a path, SHA, or commit ref earns its place only when the reader has to open it; the mandatory baseline such as passing tests stays unsaid). Paragraph two folds the five concerns into prose the reply carries: say what it is about and why it surfaced now (root cause, not symptom); say whether it is the right change for this repo and whether the gain is worth the blast radius; when an assumption in the ticket, spec, or code is wrong or stale, state it with facts, plainly; when a decision is left for the reader, name it with a pick and one reason. It ends with the release valve, the one sentence the drift guard pins: "Leave out whatever does not apply; a question with a short answer gets a short answer." The body stays under 20 lines. The starting text is the draft proposed at the start of this brainstorm, shown below as the shared body (the pi first line; Claude substitutes its own first line and empty-subject sentence); the eval decides whether it holds, and a wording revision stays inside this Design:

```
Explain ${@:-the thing we were just discussing} like for a PM during an elevator talk.

Talk in one paragraph of whole sentences: lead with the outcome, use plain words a PM
follows without the code open, and back each claim with one concrete example. Spend
words only on what the reader needs to act - a path, SHA, or commit ref earns its place
only when the reader has to open it, and the mandatory baseline like passing tests stays
unsaid.

Judge as you go. Say what it is about and why it surfaced now (root cause, not symptom),
whether it is the right change for this repo, and whether the gain is worth the blast
radius. When an assumption in the ticket, spec, or code is wrong or stale, say so with
facts, plainly. When a decision is left for me, name it and give your pick with one
reason. Leave out whatever does not apply; a question with a short answer gets a short
answer.
```

First lines are unchanged: pi `Explain ${@:-the thing we were just discussing} like for a PM during an elevator talk.`, Claude `Explain $ARGUMENTS like for a PM during an elevator talk.` followed by its existing empty-subject sentence. Frontmatter is unchanged on both surfaces (`description`, `argument-hint`, Claude `disable-model-invocation: true`).

The edit to `skills/elevator/SKILL.md` and `prompts/elevator.md` follows `/skill:forge-skill` (AGENTS.md routes prompt-template edits there).

### Drift guard

`test/prompts.test.ts`: the first test (`test/prompts.test.ts:5-31`) freezes the old body as the `SHARED_BODY` literal and `assert.strictEqual`s each surface's body against it; that is a literal pin per surface, not a cross-surface identity check. Delete `SHARED_BODY` and replace the test with one that extracts the body below the first paragraph from both surfaces (same frontmatter/`\n\n` slicing as today), asserts `body(pi) === body(claude)`, then `assert.doesNotMatch(body, /^\s*\d[.)]\s/m)` (no numbered line at all in the prompt), `assert.doesNotMatch(body, /in order/i)` (the AC1 "in order" ban), and `assert.match(body, /short answer gets a short answer/)` (or the final release-valve phrase if the council changes it). Keep the surface-header prefix test (`test/prompts.test.ts:47-56`) and the two registration tests unchanged. The two bars differ on purpose: the prompt body may carry no numbered line, because any one is the seed of the form; the eval counts three numbered item-start lines in a reply, because a single "1." in prose is not a list.

### Eval target

Add `eval/elevator/`, laid out as pi-gauntlet's `eval/_template`:

| File | Content |
|---|---|
| `target.json` | verbatim `{"kind":"text","assembly":"concat","skillFiles":[{"path":"prompts/elevator.md","body":true}],"wordCap":220}`; `body: true` strips the frontmatter so the system prompt is the first line plus the shared body; no `denylist` - the built-in hygiene scan already refuses the owner handle, `/Users/<name>` paths, and token shapes |
| `README.md` | required by the harness lint: what the target tests (the reply reads as a PM elevator talk, no numbered list) and which file it loads (`prompts/elevator.md`); names the run line and the pinned pi-gauntlet commit or tag that carries `--root` |
| `intent.md` | parsed, not prose: first non-blank line `for: <sha256 of the candidate assembly>` (the driver prints the sha; rebind it after every wording change), `## Change` (one paragraph: the 11/19 numbered-list rate, what "talk like for a PM" means, what a regression looks like), `## Expected to move` with one bullet per intended list improvement in the form `- <sample>/no-numbered-list: fails -> holds - <why>` for every sample whose baseline lists, so the pass renders as `intended change` rather than an unplanned improvement |
| `replay.md` | fixed preamble playing the "earlier in this session" role: states that the subject is the thing discussed below, then the case follows. Documents the one approximation: the body sits in the system prompt with `${@:-...}` left raw because the harness cannot drive pi's slash-prompt expansion |
| `samples/bug-fix/` | `case.md`: synthetic summary of a small bug fix in a name cache that skipped deactivated users; `expected.md`: facts below |
| `samples/design-proposal/` | `case.md`: synthetic summary of a proposed second settings path beside an existing resolver; the case states the stale assumption explicitly: the proposal assumes settings are read once at startup, while the case's existing resolver re-reads `settings.json` on every call, so the second path would double every read; `expected.md`: facts below plus `- names-stale-assumption: judged: The reply says the proposal's once-at-startup assumption is wrong because the resolver re-reads settings on every call.` |
| `samples/short-question/` | `case.md`: a one-line yes/no question about a prior change ("Did the name-cache fix also cover users renamed while deactivated?") with the case facts giving the answer (no: a renamed-while-deactivated user keeps the old name until the next refresh); `expected.md`: facts below plus `- two-or-three-sentences: judged: The reply answers in two or three sentences.` - the shared facts stay in force and are jointly satisfiable here because the reply makes one claim (the answer) backed by one example (the renamed-while-deactivated user), which fits in two sentences |
| `samples/ticket-ask/` | `case.md`: synthetic ticket-style ask whose acceptance criterion is flawed: it requires zero cache misses after the change, which no cache can promise; the decision left to the reader is whether to ship with the criterion rewritten to a miss-rate bound or to push the ticket back; `expected.md`: facts below plus `- ends-with-pick: judged: The reply ends by naming the ship-or-push-back decision with one pick and one reason.` |
| `results/<sample>/{baseline,candidate}.json`, `report.md` | written by the harness, committed |

Shared facts in every `expected.md`, verbatim (the harness grammar is `- <id>: judged: <sentence>` or `- <id>: mechanical: contains "x" | lacks "x" | matches /re/flags`; `lacks` is a literal substring test, so absence of a pattern is expressed through `matches` with a negative lookahead):

```
- no-numbered-list: mechanical: matches /^(?![\s\S]*?(?:^|\n)[ \t]*\d{1,2}[.)][ \t][\s\S]*?(?:^|\n)[ \t]*\d{1,2}[.)][ \t][\s\S]*?(?:^|\n)[ \t]*\d{1,2}[.)][ \t])/
- outcome-first: judged: The first sentence states the outcome.
- example-per-claim: judged: Each claim carries one concrete example taken from the case.
- no-slot-structure: judged: The reply is prose with no fixed-slot structure mirroring a question list.
- plain-words: judged: A PM without the code open can follow every sentence; no identifier, path, or jargon term appears without a plain-words gloss.
- grounded: judged: Every example and number in the reply comes from the case text; nothing is invented.
```

`no-numbered-list` fails when three numbered item-start lines (`<digits>.` or `<digits>)` followed by a space, at line start) appear anywhere in the reply - compact, blank-separated, or wrapped items all count; it holds for ordinary prose and for one or two numbered lines. Before trusting the reported list rate, check the predicate against those four shapes with a `node -e` one-liner (compact, blank-separated, wrapped: `fails`; prose: `holds`). `plain-words` and `grounded` make the Design's plain-words and factual-claim requirements observable; each `case.md` carries enough context (the names, numbers, and behavior the reply may cite) for the judge to tell a supported example from an invented one. All case text is synthetic: no customer, internal system, credential, `/Users/<name>` path, or private-repo content (AGENTS.md hygiene rule; gauntlet's scan enforces it).

Run: `node "${PI_GAUNTLET:-../pi-gauntlet}/eval/run.mjs" --root . elevator`. `PI_GAUNTLET` names the sibling pi-gauntlet checkout; the default resolves beside the primary pi-quiver checkout, and a `.worktrees/<name>` home sets `PI_GAUNTLET=../../../pi-gauntlet`. The same invocation appears in the leg verification line, `eval/elevator/README.md`, and the `AGENTS.md` Testing line. First `--baseline-only` seeds `results/<sample>/baseline.json` from `prompts/elevator.md` at `git merge-base HEAD origin/main` (today's five-question body); those first baseline records are committed and never rerolled, so the full run is the before/after measurement against a fixed baseline. Hand-run before shipping a wording change; not in CI.

### pi-gauntlet dependency (not owned here)

`eval/run.mjs` gains a CLI option `--root <path>` (default: its own checkout) that the entry point passes through to `runTarget` as the consumer root for `eval/<target>/` and `skillFiles`. The `judge.md` read sits inside `runTarget` (`run.mjs:185`, `join(root, "eval", "judge.md")`), so `runTarget` changes too: it resolves the judge prompt relative to the runner's own directory (or takes an explicit judge-path parameter defaulting to that), never `<root>/eval/judge.md`. Lands as a separate commit in pi-gauntlet with its own test and CHANGELOG line before the eval first runs here. Because `eval/` is checkout-only and absent from pi-gauntlet's npm `files`, a package version does not identify the harness: `eval/elevator/README.md` and pi-quiver's CHANGELOG entry pin the pi-gauntlet commit SHA or tag that carries `--root`.

## Errors and edge cases

- Hygiene refusal (exit 2) scans target configuration, docs, committed records, skill assemblies, and model outputs - not samples alone. The built-in rules (owner handle, `/Users/<name>` paths, token shapes) are the whole denylist; writing the owner handle into `target.json` as a custom entry would itself trip the scan. The merge-base body is sound text, so the baseline arm passes the scan.
- Baseline over-cap: `run.mjs:130` marks any text cell over `wordCap` as `status: error` with no arm check, so a verbose baseline reply (today's five-question body answering all five slots can exceed 220 words) makes the cell verdict `error`, exits 1, and gets no paired judgment; no candidate wording can repair it. The first baseline outputs are retained as committed, never rerolled for shorter replies (that would bias the comparison), and the candidate cap stays 220. How an over-cap baseline cell is assessed is a dependency decision taken before implementation - see Open questions.
- Exit 0 is a no-regression and no-error gate, not proof that the list stopped. A `no-numbered-list` fact failing on both arms is labeled `pre-existing` (or `intended but unchanged` when listed under `## Expected to move`), the cell verdict is `unchanged`, and the process exits 0; only `error`, `inconclusive`, or `regressed` cells exit 1. The acceptance gate is therefore the committed `eval/elevator/report.md`: every candidate cell must hold `no-numbered-list`, both `short-question` cells must hold `two-or-three-sentences`, and every other mandatory candidate fact must hold. An unchanged failure is not accepted variance and does not become a regression merely because the candidate was expected to improve; the wording is revised and the run repeated (rebinding `for:`) before the gate, and no fact is loosened to make the run pass.
- Judged facts are cached by input sha in the harness, so re-runs without body or sample changes make no model calls; mechanical facts are deterministic on a given reply.
- The raw `${@:-...}` placeholder in the system prompt is the documented approximation; `replay.md` states the subject explicitly so the replay model does not treat the placeholder as the subject. The real slash-expansion path stays covered by the first-line assertions in `test/prompts.test.ts`.
- If the sibling checkout lacks the `--root` flag, `run.mjs`'s strict `parseArgs` rejects the unknown option, prints the usage line, and exits 2 before any target lookup; "unknown target `elevator`" appears only when a `--root` build is pointed at a tree without `eval/elevator/`. `eval/elevator/README.md` pins the pi-gauntlet commit or tag that carries the flag.
- `wordCap` is enforced on both arms as a cell error, not as a fact: a candidate reply over 220 words exits 1 the same way an over-cap baseline does.
- `eval/` is outside the npm `files` allowlist and outside `extensions/`, so `test/packed-install.test.ts` and `test/layout.test.ts` are unaffected.

## Tests

- shared body byte-identical across the two surfaces - `test/prompts.test.ts` (existing assertion kept)
- surface first lines unchanged - `test/prompts.test.ts` (existing assertions kept)
- body carries no numbered line, no "in order" instruction, and carries the release-valve phrase - `test/prompts.test.ts` (new `assert.doesNotMatch` x2 and `assert.match`, replacing the `SHARED_BODY` literal pin)
- candidate reply has fewer than three numbered item-start lines anywhere, on every sample and both models - `eval/elevator/samples/*/expected.md`, mechanical `no-numbered-list` via `matches` negative lookahead; predicate checked against compact, blank-separated, wrapped, and prose shapes before the list rate is read
- candidate reply under the word cap - `eval/elevator/target.json` `wordCap`, cell error on either arm
- outcome first, one example per claim from the case, no fixed-slot structure, plain words, nothing invented - judged facts in each `expected.md`
- every candidate cell holds the mandatory facts - `eval/elevator/report.md` read across all eight sample/model cells; exit 0 alone is not the gate
- short-question sample answered in two or three sentences - `eval/elevator/samples/short-question/expected.md`, judged
- stale assumption named - `eval/elevator/samples/design-proposal/expected.md`, judged
- ends with a pick and one reason - `eval/elevator/samples/ticket-ask/expected.md`, judged
- before/after list rate visible in one run - `eval/elevator/report.md`, written by the harness and committed
- `eval/` never ships - `npm pack --dry-run` (in the leg's verification line); no new test, the `files` allowlist already excludes it
- pi-gauntlet `--root` flag - a test in pi-gauntlet's `eval/` suite, in that repo's commit, not here

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `AGENTS.md` Testing section - one line naming the eval run command (`PI_GAUNTLET`, default `../pi-gauntlet`), that it is hand-run against a sibling pi-gauntlet checkout at the pinned commit, and that `results/` and `report.md` are committed (clears Major procedures / conventions); `CHANGELOG.md` `## Unreleased` - one bullet naming the body rewrite, the `eval/elevator/` target, and the pinned pi-gauntlet commit or tag that carries `--root` (clears Communication contracts / integrations: the Design commits the changelog to identify the harness dependency)
- Derived / memory docs invalidated: `AGENTS.md` Layout block - gains `eval/` with a one-line description, since the tree gains a top-level directory the block enumerates; `README.md` `/elevator` row - re-read after the body lands and amend only if its "frank judgment" description no longer matches the wording

## Out of scope

- Separate bodies per host (pi vs Claude Code): no evidence the hosts want different output; the predecessor's single-body decision stands.
- Replaying real sessions as fixtures: private content would need anonymizing; synthetic cases cover the same shapes.
- Vendoring pi-gauntlet's `eval/` into pi-quiver: duplicates a sibling-owned concept.
- Running the eval in CI.
- A standalone mechanical-only script (the first eval answer, superseded by reusing the harness).

## Open questions

- Baseline over-cap assessment (dependency decision, settled by the user at the gate or by the first plan task that runs `--baseline-only`, via brainstorming's amendment path). Probe run: `rg -n wordCap ~/repos/pi-gauntlet/eval/run.mjs` - outcome: `run.mjs:130` sets `status: error` on any text cell over `wordCap` with no arm check, so an over-cap baseline reply blocks the paired judgment and exits 1. Affected edits: the Errors "Baseline over-cap" entry, the committed `results/<sample>/baseline.json` retention rule, and the AC exit-0 row. Options, none chosen here: (a) accept that an over-cap baseline cell reports `error` and read its `no-numbered-list` result from the retained `baseline.json` text by hand, (b) ask pi-gauntlet to exempt the baseline arm from `wordCap` as part of the separately owned `--root` commit, (c) raise `wordCap` once after measuring the baseline arm. (b) widens the sibling change and (c) weakens the 220-word candidate commitment, so neither is taken silently.
- If the first eval run shows a replay model keeping the list at a high rate, the judged facts tell what is wrong with the wording; the fix is a wording revision inside this spec's Design, not a new component.
