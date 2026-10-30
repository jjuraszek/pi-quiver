# Elevator prompt template for pi and Claude Code

**Ticket:** jjuraszek/pi-quiver#32
**Goal:** Ship `/elevator` as a pi prompt template and a user-invoked Claude Code skill that take one free-text subject and answer like for a PM during an elevator talk - outcome first, under ~8 lines, with a frank verdict.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** waves

## Problem

Explaining a change for a non-expert and asking for a frank verdict is a recurring ask that is retyped every time. Ticket #32 asks for a shipped `/elevator` prompt template whose body fixes the format (outcome first, plain words, one example per claim, ~8 lines) and five ordered judgment questions, so one slash command replaces the retyped instructions.

The ticket's body uses two positional arguments: `Explain $1 like for a PM during an elevator talk. ${@:2}`, with hint `<ticket|PR|path|topic> [question]`. Pi's template parser (`<pi install>/node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js:11-85`, pi 1.4.0) splits arguments on whitespace with shell-style quoting; `$1` is the first token only and `${@:2}` is tokens 2.. joined by spaces. So `/elevator the slack cache is this right?` expands to `Explain the like for a PM during an elevator talk. slack cache is this right?` - a phrase topic survives only when quoted. The parser cannot see a topic/question boundary; the model reading the prompt can.

Framing: pivoted to one free-text input - the first line takes the whole argument string and the model separates subject from question. User decision 2026-10-30, after the cut question: ticket rows 1-3 `deviates`.

Scope added by the user: also ship the prompt as a Claude Code skill in the existing `quiver` marketplace plugin, invoked only by the user (`disable-model-invocation: true`). Claude Code's substitution (code.claude.com/docs/en/slash-commands.md, fetched 2026-10-30) uses `$ARGUMENTS` for the full string and 0-based `$N`, with no `${@:N}` slice, so the pi body is not byte-portable: each surface has its own first paragraph and shares the rest.

No-argument behavior (user decision): the subject defaults to the thing we were just discussing in the session.

Premises verified: `package.json` `pi.prompts` lists only `./prompts/rebase-worktree.md`; `.claude-plugin/marketplace.json` lists `./skills/fetch` and `./skills/doc-to-md` and no `commands/` or `plugin.json` exists; `skills/` and `.claude-plugin/` are excluded from the npm tarball (`test/layout.test.ts:33`); `CHANGELOG.md` has no `## Unreleased` heading (latest `## v6.14.3 - 2026-10-29`). Not checkable during recon: the `/elevator` entry after a packed `pi install`, the expanded message a session sends, and the `/quiver:elevator` entry in Claude Code - these are verification steps in Tests, not assumptions the design rests on.

## Acceptance criteria

Ticket jjuraszek/pi-quiver#32, Acceptance Criteria, rows verbatim:

- [ ] In the candidate checkout, `prompts/elevator.md` matches the body in Idea byte for byte, and `package.json` `pi.prompts` lists `./prompts/elevator.md`.
  deviates: the pivot replaces the two-argument body and expansion with a single free-text input
- [ ] After `npm pack` and `pi install` of the resulting tarball into a fresh pi session, `/elevator` appears in the slash-command list with description "Explain and judge something like for a PM during an elevator talk" and argument hint `<ticket|PR|path|topic> [question]`.
  deviates: the pivot replaces the two-argument body and expansion with a single free-text input
- [ ] Typing `/elevator foo is this right?` in that session sends a prompt whose first line is `Explain foo like for a PM during an elevator talk. is this right?`.
  deviates: the pivot replaces the two-argument body and expansion with a single free-text input
- [ ] In the commit that adds the prompt, `README.md` has a `/elevator` row beside the `/rebase-worktree` row and `CHANGELOG.md` has an `## Unreleased` bullet for it.
  in-scope

## Legs

### Leg: jjuraszek/pi-quiver
branch: jacek/elevator-prompt
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: env -u PI_CODING_AGENT_DIR npm run test:all; npm pack --dry-run
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: none
design: owns `prompts/elevator.md`, `skills/elevator/SKILL.md`, `package.json` `pi.prompts`, `.claude-plugin/marketplace.json`, `README.md`, `AGENTS.md`, `CHANGELOG.md`, `test/prompts.test.ts`

## Design

Two surfaces, one shared body. Each file has a surface-specific first paragraph; everything after it is identical.

### Shared body (both files, after the first paragraph, byte-identical)

```markdown
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

This is the ticket's proposed body with the first line removed; the format and question text are kept word for word.

The shared body above and both `description` lines below are literal requirements: copy them from these blocks into the files. They take precedence over `/skill:forge-skill`'s generic authoring guidance (imperative-voice rewrites, trigger-style descriptions) wherever the two conflict; forge-skill still governs everything else about the files.

### Pi surface: `prompts/elevator.md`

```markdown
---
description: Explain and judge something like for a PM during an elevator talk
argument-hint: "[ticket|PR|path|topic|free text]"
---
Explain ${@:-the thing we were just discussing} like for a PM during an elevator talk.

<shared body>
```

The hint uses square brackets because the argument is optional (bare `/elevator` defaults), matching `/rebase-worktree`'s `[base]`. `${@:-default}` is matched by pi's `substituteArgs` (`prompt-templates.js:61-85`, pi 1.4.0): all tokens joined by single spaces, or the default when no argument is given. `/elevator the slack cache, is this right?` sends `Explain the slack cache, is this right? like for a PM during an elevator talk.`; a bare `/elevator` sends `Explain the thing we were just discussing like for a PM during an elevator talk.`. Registration: `package.json` `pi.prompts` gains `./prompts/elevator.md` beside `./prompts/rebase-worktree.md`; the `files` array already ships `prompts`.

### Claude surface: `skills/elevator/SKILL.md`

```markdown
---
name: elevator
description: Explain and judge something like for a PM during an elevator talk
argument-hint: "[ticket|PR|path|topic|free text]"
disable-model-invocation: true
---
Explain $ARGUMENTS like for a PM during an elevator talk. An empty subject means the thing we were just discussing.

<shared body>
```

`disable-model-invocation: true` keeps the skill out of the model's auto-invocation; only the user triggers it as `/quiver:elevator`. Registration: `.claude-plugin/marketplace.json` lists `./skills/elevator` beside the two existing skills. The npm tarball keeps excluding `skills/` and `.claude-plugin/`.

### Drift guard: `test/prompts.test.ts`

One `node --test` file that reads both files, strips the YAML frontmatter and the first paragraph (up to the first blank line), and asserts each remainder is byte-identical to the shared-body text held in the test as a constant copied from the Design block above (so a coordinated rewrite of both files fails, not only a one-sided drift); asserts `package.json` `pi.prompts` contains `./prompts/elevator.md`; asserts `.claude-plugin/marketplace.json` lists `./skills/elevator`; asserts the Claude frontmatter contains `disable-model-invocation: true`.

### Docs

`README.md`: a `/elevator [ticket|PR|path|topic|free text]` row (pipes escaped as `\|` inside the table cell, as the `fast-mode` row does) directly under the `/rebase-worktree [base]` row in the extension table; in the Claude Code support section, the **Exposed** paragraph changes "with two skills" to three and adds `elevator` (invoked as `/quiver:elevator`, user-invoked only) to the skill list, and the **Not exposed** paragraph's allowlist sentence becomes "allowlists only `./skills/fetch`, `./skills/doc-to-md`, and `./skills/elevator`" - both units become false otherwise. `AGENTS.md`: the opening inventory ("plus the `/rebase-worktree` prompt template") becomes "plus the `/rebase-worktree` and `/elevator` prompt templates", and the layout line for `prompts/` becomes `(/rebase-worktree, /elevator)`; both currently enumerate the single template by name and go stale otherwise. `CHANGELOG.md`: a new `## Unreleased` section with one bullet for the prompt and skill `(#32)`.

Remove: nothing.
Add: `prompts/elevator.md`; `skills/elevator/SKILL.md`; the `./prompts/elevator.md` entry in `package.json` `pi.prompts`; the `./skills/elevator` entry in `.claude-plugin/marketplace.json`; the README row, skill-list entry, and allowlist-sentence update; the two `AGENTS.md` inventory mentions; the `## Unreleased` section and bullet in `CHANGELOG.md`; `test/prompts.test.ts`.

Prompt and skill files are authored under `/skill:forge-skill` (`AGENTS.md` Code & Documentation Discipline).

### Hygiene

No private repo details in the spec or any committed material: the spec cites pi runtime files install-relative, never under a user home; session-test transcripts stay outside the repo; the ticket's reporter usage counts are not carried into any committed file. The public ticket ref and repository URL are the only owner-handle occurrences.

## Errors and edge cases

- Subject with `?` or `,`: pi re-joins all tokens with single spaces, so punctuation rides through; Claude passes the string as typed.
- Quoted subject (`/elevator "the slack cache"`): pi strips the quotes, sending `Explain the slack cache like...`. Accepted.
- Bare `/elevator`: pi substitutes the default subject; in Claude `$ARGUMENTS` is empty and the next sentence tells the model what an empty subject means. A double space (`Explain  like`) cannot occur in pi; in Claude it occurs and the empty-subject sentence covers it.
- Templates have no runtime code path and no error path of their own.

## Tests

- Both stripped bodies equal the shared-body constant (and so each other) - `test/prompts.test.ts`
- `pi.prompts` lists `./prompts/elevator.md` - `test/prompts.test.ts`
- `marketplace.json` lists `./skills/elevator` - `test/prompts.test.ts`
- Claude frontmatter has `disable-model-invocation: true` - `test/prompts.test.ts`
- `skills/` and `.claude-plugin/` still absent from the tarball - existing `test/layout.test.ts`
- `/elevator` appears in the slash-command list after `npm pack` and `pi install` of the tarball into a fresh session, with the description and hint above - manual: install, open a session, type `/el`
- Bare `/elevator` sends the default-subject first line; `/elevator the slack cache, is this right?` sends the free-text first line - manual, same session
- README row, both README Claude-section units, both AGENTS.md mentions, and the CHANGELOG bullet present in the commit - manual read
- Punctuation in the subject rides through - none: pi's join behavior is verified from `prompt-templates.js:61-85`, no repo test owns the pi parser
- Claude plugin load (manual, after publish): in a Claude Code session, add the released `jjuraszek/pi-quiver` repo as a marketplace (`/plugin marketplace add`; a worktree-rooted local entry was declined pre-publish because it would point the user's Claude config at a throwaway checkout), enable `quiver@pi-quiver`, and confirm `/quiver:elevator` appears with the description above. Before ship, `claude plugin validate .` on the checkout is the only Claude-side check. A missing entry or load error is a setup failure: fix registration or the marketplace step, never the prompt wording. Only a reply that fails a quality fact below sends the body back.
- Session quality bar (manual; pi cases (a)-(c) before ship, Claude case (d) after publish from the marketplace load above; transcripts never committed). Every case fixes its context and states the expected subject and effect up front so the judge knows what a correct reply must convey; context is public or synthetic, never private repo material. Cases: (a) pi, this worktree, `/elevator #32` - expected subject: the `/elevator` prompt; expected effect: one slash command replaces retyped instructions. (b) pi, this worktree, a bare `/elevator` after a short discussion of the drift test - expected subject: the drift test; expected effect: the pi template and the Claude skill cannot silently diverge. (c) pi, a scratch directory under `mktemp -d` with no `AGENTS.md` or other communication instructions (this repo's own AGENTS.md already mandates elevator talk and would mask a weak prompt), seeded with a synthetic ~20-line diff that renames a config key and keeps a fallback, then `/elevator "this diff" is it worth it?` - expected subject: the rename; expected effect: old configs keep working. (d) the Claude Code session from the plugin-load step: `/quiver:elevator #32` with the same expectation as (a), then a bare `/quiver:elevator` after a short discussion, same expectation as (b), which is the only case that exercises the Claude empty-subject sentence. Each reply is judged on seven facts: f1 the first sentence states the outcome; f2 at most ~8 lines; f3 no path, SHA, or commit ref the reader cannot act on; f4 one concrete example per claim; f5 a reader without context learns what the subject is and why it exists in plain words, matching the case's expected subject and effect, with no term a PM would have to look up; f6 the verdict follows from the supplied context and claims nothing the context does not support; f7 when the case leaves an outstanding decision, the reply ends with a pick and one reason - a reply with no outstanding decision passes f7 without a closing choice, per the shared body's "only what applies". Any fail on a pi session sends the body back for a wording change before ship; a fail on the post-publish Claude case (d) sends the Claude body wording back as a patch release. Only pass/fail per fact per session goes into the plan's verification output. This borrows the judged-fact shape of pi-gauntlet's `eval/` (fixed input, must-hold facts, hygiene refusal on user paths and secrets) without porting its harness.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: README.md (`/elevator` row in the extension table; Claude Code support section: the **Exposed** skill count and list gain `elevator`, the **Not exposed** allowlist sentence gains `./skills/elevator`) - communication contracts: the command, its argument shape, and the plugin's skill inventory are found there, not in the code. CHANGELOG.md (`## Unreleased` bullet for the prompt and skill, `(#32)`) - required by in-scope ticket row 4.
- Derived / memory docs invalidated: AGENTS.md opening inventory ("plus the `/rebase-worktree` prompt template") and the `prompts/` layout line (`(/rebase-worktree)`) - both enumerate the single template by name and become wrong once `/elevator` ships.

See `reference/documentation-impact.md` for the materiality bar.

## Out of scope

- The ticket's two-argument body, hint, and `foo is this right?` expansion (rows 1-3, `deviates`): replaced by the free-text form above.
- A committed eval harness for prompt quality: one 30-line prompt does not justify porting pi-gauntlet's `eval/`; the manual quality bar in Tests covers it.
- Generating the Claude skill from the pi template via `scripts/gen-skill.mjs`: the drift test covers two files; a generator earns its place when a third prompt gains a Claude twin.
- A personal `~/.claude/skills/elevator` outside the repo.
- Changing `/rebase-worktree` or any other prompt.

## Open questions

None.
