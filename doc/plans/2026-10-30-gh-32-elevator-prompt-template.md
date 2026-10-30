# Elevator prompt template implementation plan

> **REQUIRED SUB-SKILL:** Use the subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Ship one free-text elevator explanation command for pi and a user-invoked Claude Code skill with the same judgment body.

**Architecture:** Keep two hand-authored Markdown surfaces with distinct argument paragraphs and one literal shared body. Register them in the existing pi and marketplace allowlists and pin the body in a Node test instead of adding a generator or runtime extension.

**Tech Stack:** Markdown with YAML frontmatter, JSON manifests, TypeScript, Node's built-in test runner.

**Spec:** `doc/specs/2026-10-30-gh-32-elevator-prompt-template.md`

**Verification:** `env -u PI_CODING_AGENT_DIR npm run test:all; npm pack --dry-run`

**Ticket:** `jjuraszek/pi-quiver#32`

Baseline jjuraszek/pi-quiver: b5c4aec

Baseline provenance (jjuraszek/pi-quiver): initial HEAD b5c4aec; initial inventory contained only `?? doc/plans/2026-10-30-gh-32-elevator-prompt-template.md`, admitted as the dispatched plan. No other in-flight paths were admitted. The new-test command has only a created anchor and is skipped. The existing layout command executed with exit 0, 11 tests passed, zero failures. Post-run HEAD remained b5c4aec and the inventory was unchanged; no artifacts or contamination.

---

## Files

**Create - prompt surfaces and drift guard:**
- `prompts/elevator.md`
- `skills/elevator/SKILL.md`
- `test/prompts.test.ts`

**Modify - registration:**
- `package.json` - append the pi prompt entry.
- `.claude-plugin/marketplace.json` - append the Claude skill entry.

**Modify - documentation:**
- `README.md` - command row and both Claude support inventory paragraphs.
- `AGENTS.md` - opening inventory and prompt-directory layout, outside the shared core.
- `CHANGELOG.md` - Unreleased feature bullet.

**Delete:** None.

## Recon and execution constraints

- Home and only leg: `jjuraszek/pi-quiver`, branch `jacek/elevator-prompt`, recorded home `.worktrees/jacek-elevator-prompt`. Run every scoped command at that checkout's root. The spec and plan stay home-owned.
- Read the spec's Rules list plus task Rules below. The directory walk found no nested AGENTS.md or CLAUDE.md under the owned paths; the root's one-hop documentation links add the four topic guides listed under each task. No missing local rule link was found.
- `package.json:35-65` already ships `prompts` and explicitly lists `./prompts/rebase-worktree.md`. `.claude-plugin/marketplace.json:7-17` owns the `quiver` plugin's skill list. Neither package versions nor the package lock change.
- `prompts/rebase-worktree.md:1-5` supplies the existing optional argument-hint convention. `skills/fetch/SKILL.md:1-4` supplies the plugin skill frontmatter shape.
- `test/layout.test.ts:29-40` guards npm/Claude isolation; `test/layout.test.ts:66-73` checks every marketplace entry has a skill file. New tests follow its Node imports and import.meta.url-relative reads. No test currently pins elevator content.
- Installed pi `node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js:11-85` implements quoted-token parsing and all-arguments defaults; lines 87-131 read description and argument-hint. Do not copy that parser into this repo or create parser tests.
- `package.json:46-54`, `tsconfig.json:1-16`, and `.github/workflows/test.yml:10-28` define verification: shared-core check, Node tests, and TypeScript on Ubuntu and Windows. There is no configured scoped or repo-wide lint/format command, and no Markdown formatter. The full entrypoint bundles the shared-core consistency check and typecheck, not a formatter. Manually preserve neighboring indentation and literal prompt bytes; do not introduce a formatting tool.
- The overrides have no Happy path table. Manual session checks below remain mandatory before ship and are not claimed by the automated verification command.
- Keep task-local commits for execution, but deliver the prompt, README row, and Unreleased bullet together in the final feature commit. The trailing doc wave is not a separately shippable change; combine the two task patches when landing to satisfy the spec's same-commit requirement.

## Wave 1 - Prompt surfaces and registration

### Task 1: Add elevator surfaces and a literal drift guard
Leg: jjuraszek/pi-quiver

Rules: doc/fetch.md
Rules: doc/doc-to-md.md
Rules: doc/provider-stall-watchdog.md
Rules: doc/slack.md

**TDD scenario:** New feature - full TDD cycle.

**Spec:** doc/specs/2026-10-30-gh-32-elevator-prompt-template.md § "Acceptance criteria" L32-L33, § "Design" L57, § "Shared body (both files, after the first paragraph, byte-identical)" L62-L64, § "Shared body (both files, after the first paragraph, byte-identical)" L66-L73, § "Shared body (both files, after the first paragraph, byte-identical)" L76-L78, § "Pi surface: `prompts/elevator.md`" L83-L87, § "Pi surface: `prompts/elevator.md`" L92, § "Claude surface: `skills/elevator/SKILL.md`" L97-L103, § "Claude surface: `skills/elevator/SKILL.md`" L108, § "Drift guard: `test/prompts.test.ts`" L112, § "Docs" L118-L119, § "Docs" L121, § "Hygiene" L125, § "Errors and edge cases" L129, § "Errors and edge cases" L130, § "Errors and edge cases" L131, § "Errors and edge cases" L132, § "Tests" L136-L139, § "Tests" L140, § "Tests" L141-L142, § "Tests" L144, § "Tests" L145, § "Tests" L146, § "Out of scope" L157, § "Out of scope" L158, § "Out of scope" L159, § "Out of scope" L160, § "Out of scope" L161

**Files:**
- Create: `prompts/elevator.md`
- Create: `skills/elevator/SKILL.md`
- Create: `test/prompts.test.ts`
- Modify: `package.json:59-63`
- Modify: `.claude-plugin/marketplace.json:13-16`
- Test: `test/prompts.test.ts`
- Test: `test/layout.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --test test/prompts.test.ts`
- baseline: b5c4aec skipped - test/prompts.test.ts created by this task
- via: `prompts/elevator.md`, `skills/elevator/SKILL.md`, `package.json` pi.prompts, `.claude-plugin/marketplace.json` plugins[].skills
- `env -u PI_CODING_AGENT_DIR node --test test/layout.test.ts`
- baseline: b5c4aec pass
- via: packaging isolates Claude artifacts from pi and npm; marketplace allowlist entries exist and contain SKILL.md

Decision: Use direct file assertions, not a YAML dependency or runtime extension - `test/layout.test.ts:66-73` already reads skill text and marketplace JSON directly, and the spec defines literal frontmatter.

- [ ] **Step 1: Run the existing layout test.**

  Run: `env -u PI_CODING_AGENT_DIR node --test test/layout.test.ts`

  Expected: existing packaging and marketplace checks pass before changing either manifest.

- [ ] **Step 2: Write the failing drift and registration tests.**

  Create `test/prompts.test.ts` using `test` from `node:test`, strict assert from `node:assert/strict`, and `readFileSync` from `node:fs`. Read files through `new URL("../prompts/elevator.md", import.meta.url)` and the corresponding relative URLs for the skill and manifests. Keep reads inside test callbacks so a missing surface produces a named failing test.

  Hold this literal as `SHARED_BODY`, including its final newline; copy it into the constant, never read it from either production file or from the spec at runtime:

  ```text
  Format: outcome first, plain words, one concrete example per claim, max ~8 lines.
  No code, SHAs, file paths, or commit refs unless the reader needs them to act.
  Skip "tests pass" and other mandatory baseline.

  Answer, in order, only what applies:
  1. What it is about and why it surfaced now (the root cause, not the symptom).
  2. Is it the right change - idiomatic for this repo, follows existing conventions
     and machinery, no new abstraction without a second caller?
  3. Is it worth it - gain vs blast radius, is it material?
  4. Which assumption is wrong or stale, in the ticket, the spec, or the code?
     Roast it: facts only, no diplomacy, no performed agreement.
  5. What is left for me to decide, with your pick and one reason.
  ```

  Add these named cases:
  - `elevator surfaces preserve the literal shared body`: locate and remove the opening YAML block, then remove the first paragraph through its first blank line. Assert each remaining string strictly equals `SHARED_BODY`. Do not trim whitespace or derive one expected body from the other; coordinated wording changes must fail. Keep the two retained bodies byte-identical.
  - `elevator is registered as a pi prompt`: assert parsed package `pi.prompts` includes `./prompts/elevator.md`.
  - `elevator is registered as a user-invoked Claude skill`: find the plugin with `name === "quiver"`; assert its `skills` includes `./skills/elevator` and the skill's frontmatter contains the whole line `disable-model-invocation: true`.
  - `elevator surface headers preserve their input contracts`: assert exact description, hint, Claude name, and first paragraphs from Step 4. This checks our source strings, not the external parsers.

- [ ] **Step 3: Confirm the new checks fail for the missing feature.**

  Run: `env -u PI_CODING_AGENT_DIR node --test test/prompts.test.ts`

  Expected: nonzero exit from absent elevator files and missing registration entries, not a syntax/import failure.

- [ ] **Step 4: Add both literal prompt surfaces.**

  Apply `/skill:forge-skill`; the spec's literal shared body and `description` override generic trigger-description and imperative rewrites. Read back the entire new files; keep them below 500 lines and add no headings, rationale, or examples to the specified body.

  For the pi prefix, copy spec lines 83-87 exactly: the YAML delimiters, literal description, `argument-hint: "[ticket|PR|path|topic|free text]"`, and `Explain ${@:-the thing we were just discussing} like for a PM during an elevator talk.`. Follow it with one blank line and the exact `SHARED_BODY` text above.

  For the Claude prefix, copy spec lines 97-103 exactly: the YAML delimiters, `name: elevator`, literal description, the same hint, `disable-model-invocation: true`, and `Explain $ARGUMENTS like for a PM during an elevator talk. An empty subject means the thing we were just discussing.`. Follow it with one blank line and that same body. Copy both descriptions from the approved blocks rather than rewriting them.

  Preserve the distinct no-argument contracts: pi supplies the default subject without a double space; Claude passes an empty `$ARGUMENTS`, leaving `Explain  like`, and its next sentence selects the prior discussion. Pi preserves `?` and `,` while rejoining tokens with single spaces and removes shell-style subject quotes. Claude passes the string as typed. The model, not an added parser, separates subject from question. The optional hint follows `/rebase-worktree`'s `[base]`; `${@:-default}` belongs to the host's `substituteArgs`, verified in `prompt-templates.js:61-85`.

- [ ] **Step 5: Register each surface in its owning manifest.**

  Append `./prompts/elevator.md` beside `./prompts/rebase-worktree.md` in `package.json` `pi.prompts`. Append `./skills/elevator` beside `./skills/fetch` and `./skills/doc-to-md` in the `quiver` plugin's `skills` array. Preserve both existing entries, versions, and the npm `files` allowlist: `skills/` and `.claude-plugin/` remain excluded. Add no personal `~/.claude/skills/elevator`, no committed `eval/`, no generator change in `scripts/gen-skill.mjs`, and no changes to `/rebase-worktree` or other prompts. This replaces the ticket's two-argument `foo is this right?` form; the original rows 1-3 are `deviates`. Remove no existing files.

- [ ] **Step 6: Confirm green and inspect style.**

  Run each Tests command above. Expected: all four new cases pass and all existing layout cases pass. Review TypeScript indentation against `test/layout.test.ts`, two-space package JSON versus tab-indented marketplace JSON, and both prompt literals. No scoped lint or formatter exists; preserve the exact body rather than reflowing it. Do not add a runtime error path to a pair of templates.

- [ ] **Step 7: Commit the task patch.**

  ```bash
  git add prompts/elevator.md skills/elevator/SKILL.md test/prompts.test.ts package.json .claude-plugin/marketplace.json
  git commit -m "Add elevator prompts for pi and Claude Code" -m "Refs #32"
  ```

  This execution patch is not independently shippable: combine it at landing with Task 2's `README.md`, `AGENTS.md`, and `CHANGELOG.md` changes so the delivered prompt commit contains the README row and `## Unreleased` bullet.

#### Pre-ship manual validation owned by Task 1

Run this checklist after both waves, before ship. It is not a substitute for header verification, and planning does not claim these sessions ran. Keep packed artifacts, synthetic inputs, and transcripts in a scratch directory created with `mktemp -d`, outside the repo. Use public or synthetic context only; omit reporter usage counts, secrets, private repo details, and user-home paths from committed material.

1. Pack the candidate with `npm pack`, directing its output to the scratch directory. Install that resulting tarball with `pi install` into a fresh pi profile/session. Type `/el`; require `/elevator`, the exact description from spec line 84, and hint `[ticket|PR|path|topic|free text]`. Inspect the tarball inventory for the new prompt and continued exclusion of Claude artifacts.
2. In that session, bare `/elevator` must send `Explain the thing we were just discussing like for a PM during an elevator talk.`. `/elevator the slack cache, is this right?` must send `Explain the slack cache, is this right? like for a PM during an elevator talk.`. Also inspect `/elevator "the slack cache"`: the subject reaches the message without quotes, summarized by the spec as `Explain the slack cache like...`. Do not introduce repository tests for pi's `substituteArgs`; punctuation is already host-owned in `prompt-templates.js:61-85`.
3. In a Claude Code session, use `/plugin marketplace add` with this worktree's local directory, enable `quiver@pi-quiver`, and start a fresh session. Require `/quiver:elevator` with the exact description from spec line 99 and user-only invocation. Do not use `--plugin-dir`: this checkout registers through `marketplace.json`. Missing commands or load errors require registration/setup repair, not prompt-wording repair.
4. Judge each session case below against all seven facts. Fix a failed reply through the approved spec amendment path before changing literal wording, update both surfaces and the pinned body together, and repeat affected sessions before ship. Store only pass/fail for each fact per case in verification output, never the transcripts.

| Case | Fixed context and invocation | Expected subject and effect |
|---|---|---|
| a | Pi in this worktree: `/elevator #32` | The elevator prompt; one slash command replaces retyped instructions. |
| b | Pi in this worktree: discuss the drift test briefly, then bare `/elevator` | The drift test; the pi template and Claude skill cannot silently diverge. |
| c | Pi in a fresh scratch directory with no AGENTS.md or other communication instructions: supply a synthetic roughly 20-line config-key rename diff retaining the old-key fallback, then `/elevator "this diff" is it worth it?` | The rename; old configs keep working. |
| d1 | Claude session from the plugin-load step: `/quiver:elevator #32` | The elevator prompt; one slash command replaces retyped instructions. |
| d2 | Same Claude session: briefly discuss the drift test, then bare `/quiver:elevator` | The drift test; the pi template and Claude skill cannot silently diverge. This exercises the empty-subject sentence. |

Facts: f1 first sentence states the outcome; f2 at most approximately eight lines; f3 no path, SHA, or commit reference the reader cannot act on; f4 one concrete example per claim; f5 a reader without context learns the expected subject and effect, why it exists, and needs no PM-unfamiliar term explained; f6 verdict follows from supplied context without unsupported claims; f7 an outstanding decision ends with a pick and one reason, while a case with no outstanding decision passes without a closing choice, honoring `only what applies`.

## Wave 2 - Documentation

Depends on Wave 1: document the registered commands and plugin inventory. This trailing doc-only wave owns no implementation files.

### Task 2: Document the command and three-skill inventory
Leg: jjuraszek/pi-quiver

Rules: doc/fetch.md
Rules: doc/doc-to-md.md
Rules: doc/provider-stall-watchdog.md
Rules: doc/slack.md

**TDD scenario:** Trivial change - manual documentation checks.

**Spec:** doc/specs/2026-10-30-gh-32-elevator-prompt-template.md § "Acceptance criteria" L32-L33, § "Docs" L116, § "Docs" L118-L119, § "Hygiene" L125, § "Tests" L143, § "Documentation impact" L150, § "Documentation impact" L151

**Files:**
- Modify: `README.md:74`
- Modify: `README.md:352-354`
- Modify: `AGENTS.md:3`
- Modify: `AGENTS.md:101`
- Modify: `CHANGELOG.md:11`

**Tests:**
- none: documentation - manual inventory and literal checks; no Markdown formatter configured

- [ ] **Step 1: Add the command row beside rebase-worktree.**

  In README's Architecture table, add a row directly below `/rebase-worktree [base]` with file `prompts/elevator.md`. The displayed command is `/elevator [ticket|PR|path|topic|free text]`; write `/elevator [ticket\|PR\|path\|topic\|free text]` in the Markdown table, following `fast-mode`'s escaped `\|` convention. Describe outcome-first PM explanations and frank judgment, free-text subject/question input, and prior-discussion fallback when omitted. Explain the Claude counterpart is `/quiver:elevator`, user-invoked only.

- [ ] **Step 2: Update both Claude Code support paragraphs.**

  Change **Exposed** from two skills to three; retain fetch and doc-to-md and add `elevator`, invoked as `/quiver:elevator`, user-invoked only. Change the **Not exposed** allowlist sentence to `allowlists only` followed by `./skills/fetch`, `./skills/doc-to-md`, and `./skills/elevator`. Keep the existing explanation that npm excludes `skills/` and `.claude-plugin/`.

- [ ] **Step 3: Repair the two AGENTS inventory mentions.**

  Change the opening inventory to `plus the` `/rebase-worktree` `and` `/elevator` `prompt templates`. Change the `prompts/` layout annotation from `(/rebase-worktree)` to `(/rebase-worktree, /elevator)`. Both edits are outside the shared-core markers; leave `AGENTS.core.md` and the mirrored core untouched.

- [ ] **Step 4: Add the Unreleased entry.**

  Insert `## Unreleased` before `## v6.14.3 - 2026-10-29`, with one bullet describing the pi `/elevator` prompt and user-invoked Claude `/quiver:elevator` skill, optional free-text input, and default to prior discussion; end it with `(#32)`. Do not bump versions or cut a release.

- [ ] **Step 5: Read back every changed documentation unit.**

  Require the command row directly under rebase-worktree, both Claude paragraphs listing all three skill paths, both AGENTS inventory mentions, and one Unreleased bullet for both surfaces. Compare docs to Task 1's `skills/elevator/SKILL.md`, `package.json` `pi.prompts` entry `./prompts/elevator.md`, `.claude-plugin/marketplace.json` registration, and `test/prompts.test.ts`. These remain Task 1-owned files, not additional doc-wave edits. Remove no files.

  Confirm present tense, compact table conventions, ASCII punctuation, and no user-home paths, usage counts, private context, or transcripts in new material. Verify only the public ticket ref and repository URL introduce owner handles. Preserve unchanged neighboring documentation.

- [ ] **Step 6: Commit the documentation patch.**

  ```bash
  git add README.md AGENTS.md CHANGELOG.md
  git commit -m "Document elevator commands and plugin inventory" -m "Refs #32"
  ```

  Ensure the final delivered feature commit combines these documentation changes with Task 1's prompt; perform the Task 1 manual checklist on the complete candidate before ship.

## Spec coverage

| anchor | requirement (short) | owner |
|---|---|---|
| § "Acceptance criteria" L32-L33 | README row and Unreleased bullet accompany the prompt in the delivered commit | Task 1, Task 2 |
| § "Design" L57 | Surface-specific first paragraphs with identical remainder | Task 1 |
| § "Shared body (both files, after the first paragraph, byte-identical)" L62-L64 | Outcome first, plain words, example per claim, roughly eight lines, actionable identifiers only, no baseline recital | Task 1 |
| § "Shared body (both files, after the first paragraph, byte-identical)" L66-L73 | Preserve all five ordered applicable judgment questions and frank verdict | Task 1 |
| § "Shared body (both files, after the first paragraph, byte-identical)" L76-L78 | Copy literal shared body and descriptions; literal requirements override forge-skill rewrites | Task 1 |
| § "Pi surface: `prompts/elevator.md`" L83-L87 | Pi description, optional hint, and all-arguments default paragraph | Task 1 |
| § "Pi surface: `prompts/elevator.md`" L92 | Preserve free text/default expansion and register `./prompts/elevator.md` without changing files allowlist | Task 1 |
| § "Claude surface: `skills/elevator/SKILL.md`" L97-L103 | Claude frontmatter and `$ARGUMENTS` paragraph with empty-subject sentence | Task 1 |
| § "Claude surface: `skills/elevator/SKILL.md`" L108 | User-only `/quiver:elevator`, marketplace entry, and npm exclusion | Task 1 |
| § "Drift guard: `test/prompts.test.ts`" L112 | Strip frontmatter and first paragraph; pin each body to an independent literal constant and assert registrations and user-only flag | Task 1 |
| § "Docs" L116 | README command row, Exposed count/list, Not exposed allowlist, AGENTS inventory/layout, and Unreleased bullet | Task 2 |
| § "Docs" L118-L119 | Add only the named surfaces, registrations, test, and documentation; remove nothing | Task 1, Task 2 |
| § "Docs" L121 | Author prompt and skill under `/skill:forge-skill` | Task 1 |
| § "Hygiene" L125 | No private material, user-home paths, reporter counts, or transcripts committed; public references only | Task 1, Task 2 |
| § "Errors and edge cases" L129 | Punctuation survives pi rejoining and Claude raw input | Task 1 |
| § "Errors and edge cases" L130 | Quoted pi subject loses quotes without losing words | Task 1 |
| § "Errors and edge cases" L131 | Bare invocation defaults to prior discussion on both hosts; Claude empty substitution is intentional | Task 1 |
| § "Errors and edge cases" L132 | Templates have no runtime/error path of their own | Task 1 |
| § "Tests" L136-L139 | Scoped test covers literal bodies, both registrations, and user-only flag | Task 1 |
| § "Tests" L140 | Existing layout test continues to guard excluded Claude artifacts | Task 1 |
| § "Tests" L141-L142 | Packed pi install discovers the command and sends default/free-text first lines | Task 1 |
| § "Tests" L143 | Manually verify documentation in the delivered commit | Task 2 |
| § "Tests" L144 | Keep parser punctuation behavior host-owned, not a new repo parser test | Task 1 |
| § "Tests" L145 | Local marketplace setup, user command discovery, setup failure distinguished from wording failure | Task 1 |
| § "Tests" L146 | Run all fixed-context quality cases before ship; seven facts per reply; failed facts require wording review; only fact outcomes retained | Task 1 |
| § "Documentation impact" L150 | Material README and CHANGELOG updates | Task 2 |
| § "Documentation impact" L151 | Repair invalidated AGENTS inventory mentions | Task 2 |
| § "Out of scope" L157 | Replace two-argument `foo is this right?` expansion with free-text behavior | Task 1 |
| § "Out of scope" L158 | No committed `eval/` harness; use manual quality checks | Task 1 |
| § "Out of scope" L159 | Do not generate elevator through `scripts/gen-skill.mjs` | Task 1 |
| § "Out of scope" L160 | Do not create personal `~/.claude/skills/elevator` | Task 1 |
| § "Out of scope" L161 | Leave `/rebase-worktree` and other prompts unchanged | Task 1 |
