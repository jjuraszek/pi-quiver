# pi-quiver

Pack of Pi coding-agent extensions, published to npm as `pi-quiver` (`pi install npm:pi-quiver`). Each extension is a standalone default-exported function in `extensions/`, discovered through the single manifest entry `./extensions` in `package.json` `pi.extensions`. Ships `fetch`, `doc_to_md`, `session-name`, `sword-header`, `fast-mode`, `provider-stall-watchdog`, `slack`, plus the `/rebase-worktree` prompt template (`prompts/`, listed in `pi.prompts`); everything except `fetch` and `doc_to_md` is OFF by default and reads its config from `settings.json` under `quiver.<key>` via `lib/extension-config.ts`.

<!-- agents-core:begin v9 - shared across pi-quiver/pi-cohort/pi-gauntlet/pi-condense. Edit AGENTS.core.md, then: node scripts/check-agents-core.mjs --fix -->
## Ground Truth Before Reasoning

User instructions outrank skill and AGENTS.md guidance; on conflict, follow the user. Configured gates (design approval, ship verification) still run; a user instruction that already names the gated action satisfies its confirmation.

Never guess Pi's API, message shapes, config, or values - read the source. The pi runtime is the **`@earendil-works`** namespace (matches the host pi install), not `@mariozechner`; its shipped `.d.ts` is API truth. Third-party APIs: never state a signature, config key, flag, or version-specific behavior from memory - verify in current docs (Context7 `resolve-library-id` then `query-docs`). If the source contradicts your assumption, the source wins; if it is missing, say so and ask - do not fabricate. Check the request's premise before acting: if the source contradicts it, say so once with evidence, then follow the user's decision.

The same rule applies to state you set up yourself. Before asserting that a job, publish, CI run, or process is in some state, run the command that shows it in this turn (`gh run view`, `npm view`, `git status`). A summary of what you started is a plan, not an observation.

Tickets, specs, and eval samples carry no private or proprietary data and no secrets. Material that originates in a private repo is anonymized or replaced by simpler synthetic text before it lands; a sample, ticket body, or spec that still names a customer, an internal system, a credential, or a `/Users/<name>` path is not ready to commit.

## Authorization

An instruction that names an action and its parameters is the approval for that action ("release patch", "close #12 with a comment") - do it, then report. Ask only when a parameter is ambiguous or a safety check fails; say what failed, don't fix it silently. Once the design is settled, finish the authorized work before asking - the user approves a concrete result. Reversible, read-only, and already-authorized actions need no permission. Agent-initiated writes to a tracker or to files outside the repo keep their gate.

## Communication Style

Human-read text is elevator talk: three beats, each a whole sentence - what happened, what it means for the reader, what you need from them. Show, don't reference: one concrete example (a value, a before/after line, a quoted sentence) instead of any path, SHA, or id; identifiers go behind a link labelled in plain words ("the merge commit", not `abc1234`) that sits on the claim it supports. Paths inline only in PR bodies, because the reviewer opens them. Short means fewer sentences, never fewer verbs: "the validation rejects nil names" is as long as "some name handling was tightened" and says something checkable.

| Regime | Surfaces | Format |
|---|---|---|
| Human-read | chat, commit messages, PR/issue bodies and comments, review feedback, tracker and Slack comments | three beats; whole sentences; one example; links as provenance trailing the claim; end on the ask |
| LLM-read | AGENTS.md, README, CHANGELOG, specs, plans, skill/agent/prompt files, non-obvious-why code comments | tables, headings, exact references (file, SHA, value), code blocks; density still binds; optimize for unambiguous retrieval |

The regimes differ in where exactness is carried, not how much: human-read text puts it in the example and links the reference; LLM-read text puts it in the reference itself.

Wording (binds both regimes; the lists are illustrative, the rule is the pattern):

- American English ("behavior", "labeled", "analyze").
- Everyday word over formal synonym: "supports" not "corroborates", "use" not "utilize", "start" not "commence", "help" not "facilitate", "about" not "regarding".
- No connective filler or stock openers: "It's worth noting", "Note that", "Importantly", "Additionally", "In other words".
- No hedging on things you checked, no intensifiers ("robust", "comprehensive", "seamless"), no triplets for rhythm ("clear, concise, and correct").
- No restating the question before answering it, no summary sentence after the answer.
- Test: if a sentence could open any status update on any project, delete it.

Human-read rules:

- **Length is the first rule.** Default to one paragraph. A second paragraph needs a reason; anything that needs headings goes into a PR body, thread, or doc.
- **Start with the substance.** No intent classification, phase/routing announcements, tool/subagent preamble, status narration, pleasantries. Output outcomes, decisions needing input, verification results, blockers.
- **Whole sentences, no scaffolding.** No Options/Recommendation/TL;DR templates, no headings on a short body, no checkbox lists that restate prose. Bullets are for genuinely parallel items, never a substitute for a sentence.
- **Active voice, named actor, no hedging.** "The validation rejects nil names", not "nil names should now be rejected". One term per concept.
- **Restate, never point.** Never point at tool outputs, finding numbers, plan rows, or earlier turns the reader didn't see - restate in one sentence. Delete every link and the reply must still stand; a link is provenance, never the content.
- **State what you did or will do.** No padding with what you won't do, what stays unchanged, or alternatives nobody asked about. No closing summaries. Evidence is a sentence with an example ("unit tests pass: 212 tests, 0 failures"), not a pasted transcript.
- **Cut on sight:** restated-goal paragraph, any sentence that restates the diff, filler (see Wording), headings on a short comment.
- **PR bodies describe the change, not its validation:** no test counts, lint status, or command outcomes - CI holds that evidence.
- **A problem report is concrete:** what happened (the failing input, line, or before/after) and the decision you need. Bad: "blocked, see finding 3". Good: "The packed-install test fails because `dist/` is missing from the tarball - add it to `files`, or build at `prepack`?"
- **ASCII punctuation everywhere** (chat, comments, commits, docs, code): `-` not em-dash, `...` not the ellipsis glyph, straight quotes; non-ASCII only for a justified visual mark.

PR body, before (compressed):

> Gate slack registration on `enabled`.
>
> - `extensions/slack.ts`: early return in `session_start`
> - `lib/slack-core.ts`: drop eager token read
> - tests: disabled path

After:

> The `slack` extension now does nothing when `quiver.slack.enabled` is false. Before, a disabled config still read the token file and registered seven tools at startup, so a user who had never set up Slack saw `slack_post` in the tool list; registration now stays behind the `enabled` check and the tool list is empty.
>
> The gate lives in `extensions/slack.ts`; `lib/slack-core.ts` no longer reads the token eagerly.

The after wins because the first paragraph names the observable behavior a reviewer can falsify (a disabled config, an empty tool list), the paths trail for the reviewer, and nothing restates the diff. Models match an example harder than they follow prose.

## Code & Documentation Discipline

- **Code is a liability.** Add only what the task requires. No premature abstractions, no helpers for hypothetical reuse, no fallbacks for branches that can't happen, no commented-out alternatives.
- **No new machinery if not essential.** Reuse an existing field, channel, or code path (plus a small discriminant if needed) over a new sibling construct; new machinery must earn its place by being impossible or misleading to express with what exists.
- **No belt-and-suspenders.** Validate a thing once, at the boundary that owns it - not at every layer.
- **Delete dead code, don't comment it out.** When a change supersedes code, remove the old path in the same commit. Branch from the deletion commit if reversibility matters.
- **Comments are stock, not flow.** Record the durable why, never task context, tickets, or callers. Good: `// output is never empty for a real dispatch`. Bad: `// #12: gate on this so the classifier doesn't no-op`. No docstrings on self-evident params/returns, no banner comments.
- **Surface, don't auto-fix.** A bug fix doesn't drag in surrounding cleanup; mention adjacent issues separately.
- **Docs are a current contract, present tense.** No "upcoming"/"pending" in a current-state guide - planned work lives in `doc/specs/`, `doc/plans/`, or the ticket; history lives in `CHANGELOG.md` and commit bodies, never in AGENTS.md or a guide. Doc updates ride with the commit that makes them stale. Editing a doc puts the smallest unit you touch - bullet, row, heading block - in scope: its paths resolve, its commands match the source, its framing is present tense; stale content outside that unit: flag, don't fix.
- **AGENTS.md is always-on essentials plus routing, not the manual.** Route detail to `doc/` or `README.md` and link it; add an inline pointer only when critical or high-frequency. README and AGENTS.md stay in sync where they overlap.
- **Markdown tables use compact `|---|` separators.** Never padded columns.
- **Skill, persona, and prompt edits follow `/skill:forge-skill`** - any size, including one-line rewordings; its authoring rules (imperative voice, low conditionality, minimal diff, oversized-skill extraction) bind the edit.

## Ticket convention

Creating a ticket or repairing its title/body/metadata happens only via `/skill:shape-ticket` - it enforces the Context -> Problem -> Idea -> Acceptance Criteria template, an AC integrity gate, and a cheap council roast applied to the body before the single human-gated write (no roast comments); a user instruction naming the ticket's body counts as that gate. Status transitions and comments are exempt - plain tracker CLI.

<!-- agents-core:end v9 -->

## Part of one platform

One of four sibling pi extensions - **pi-quiver** (capabilities), **pi-cohort** (coordination), **pi-condense** (context economy), **pi-gauntlet** (process). They ship and version independently; a concept is explained in its owning repo and linked from the others, never duplicated. pi-quiver has no code coupling with any sibling. A change that alters a cross-repo contract (settings keys, tool names other skills dispatch) updates the sibling's docs in the same logical change and lands in both CHANGELOGs.

## Ground truth pointers

- Extension API: `node_modules/@earendil-works/pi-coding-agent/dist/**/*.d.ts` - `ExtensionAPI`, `registerTool`, tool result/`details` shapes, `formatSize`, `keyHint`.
- TUI: `node_modules/@earendil-works/pi-tui` - `Text` and theme helpers used in `renderCall` / `renderResult`.

## Layout

```
extensions/                 # one top-level file = one extension entry point; nothing else at top level
prompts/                    # shipped pi prompt templates (/rebase-worktree), listed one by one in package.json pi.prompts; .pi/prompts/ holds repo-local ones (/release)
lib/extension-config.ts     # getAgentDir()-based settings.json resolution + QUIVER_CONFIG_KEYS registry + lint
lib/fetch-core.ts           # fetch data plane; extensions/fetch.ts and bin/pi-quiver.ts are thin adapters
lib/doc-to-md-*.ts          # doc_to_md core, options, bundle protocol, handle shapes; lib/unpdf-worker.ts
lib/slack-core.ts           # slack config/token resolution, transport, mutations, announce protocol
lib/slack-cache.ts          # workspace-keyed channel/user name->ID cache
bin/pi-quiver.ts            # CLI (fetch + doc-to-md); published as esbuild-built dist/, not committed
scripts/doc_to_md.py, docx_numbering.py # doc_to_md Python child and its spawned raster worker, and DOCX numbering labels
scripts/gen-skill.mjs       # renders skills/doc-to-md/SKILL.md from the option schema
skills/, .claude-plugin/    # Claude Code plugin surface; skills/doc-to-md/SKILL.head.md is hand-written; invisible to pi, excluded from the npm tarball
test/                       # node --test suites, one per extension, + layout.test.ts; fixtures/ generated
```

## Rules

- **Only extension entry points at the top level of `extensions/`.** Pi imports every top-level `.ts`/`.js` there and silently drops a non-function default after the import's side effects have run. `test/layout.test.ts` enforces it.
- **Every settings key is registered in `QUIVER_CONFIG_KEYS`** (`lib/extension-config.ts`) or the lint reports it unknown; `test/extension-config.test.ts` pins the registry against each extension's exported default config.
- **Opt-in extensions check `enabled` per hook and do nothing when off**; `slack` additionally gates registration at `session_start` (zero tools, hooks, or I/O when disabled). Toggling takes effect next session.
- **`skills/doc-to-md/SKILL.md` is generated** - edit `skills/doc-to-md/SKILL.head.md` or the descriptors, then run `node scripts/gen-skill.mjs`; `test/skill-generation.test.ts` fails on drift.
- **A new extension or prompt template** is documented in `README.md` and gets a `CHANGELOG.md` `## Unreleased` bullet in the same commit.
- **Packaging:** `package.json` `files` ships `extensions`, `prompts`, `lib`, `dist`, `scripts/doc_to_md.py`, `scripts/docx_numbering.py`; `dist/` is built at `prepack` (esbuild, `--packages=external`). `test/packed-install.test.ts` installs the packed tarball and runs the bin. Check with `npm pack --dry-run`.

## Testing

`npm run test:all` = `node scripts/check-agents-core.mjs` + `node --test test/*.test.ts` + `npx -y tsc --noEmit` (flags in `tsconfig.json`); the same command CI runs on ubuntu + windows (`.github/workflows/test.yml`). Run with `env -u PI_CODING_AGENT_DIR` in a pi harness shell. Smoke-test with `pi -e ./extensions/fetch.ts -p "fetch https://example.com"`.

## Release

`/skill:release` owns the flow: `release.sh <level>` promotes `## Unreleased` in `CHANGELOG.md`, bumps `package.json`, regenerates the doc-to-md skill and writes the matching marketplace version, commits `Release X.Y.Z`, tests, tags `vX.Y.Z`, pushes; CI publishes via OIDC. A user instruction naming the level is the approval. Mechanics and safety checks: [`.agents/skills/release/SKILL.md`](.agents/skills/release/SKILL.md).

## Routing

| Want to ... | Read |
|---|---|
| Install, extension list, settings, migration from flat keys | [`README.md`](README.md) |
| What changed across versions | [`CHANGELOG.md`](CHANGELOG.md) |
| `fetch` routing and size gate | [`doc/fetch.md`](doc/fetch.md) |
| `doc_to_md` backend ladder, bundle protocol, child contract, CLI | [`doc/doc-to-md.md`](doc/doc-to-md.md) |
| `provider-stall-watchdog` recovery flow, retry budget, TUI/RPC wait, manual repro | [`doc/provider-stall-watchdog.md`](doc/provider-stall-watchdog.md) |
| `slack` config, tokens, cache, announce protocol, smoke checklist | [`doc/slack.md`](doc/slack.md) |
| pi-gauntlet skill overrides for this repo | [`.pi/gauntlet-overrides.md`](.pi/gauntlet-overrides.md) |
| Run a release | [`.agents/skills/release/SKILL.md`](.agents/skills/release/SKILL.md) |
| Change the shared AGENTS core | edit [`AGENTS.core.md`](AGENTS.core.md), `node scripts/check-agents-core.mjs --fix`, copy both files to the siblings, `--fix` there |
