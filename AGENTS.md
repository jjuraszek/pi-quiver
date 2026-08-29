# pi-quiver

Personal pack of Pi coding-agent extensions, published to npm as `pi-quiver` like sibling pi-* packages. Each extension is a standalone default-exported function living in `extensions/`, discovered through the single manifest entry `./extensions` in `package.json` `pi.extensions`. Ships `fetch` (context-safe URL retrieval; GitHub issue/PR/repo/Actions-run/Actions-job URLs auto-routed through the `gh` CLI with HTTP fallback), `doc_to_md` (local PDF/DOCX/PPTX -> Markdown via pymupdf4llm with a pure-JS unpdf fallback), `session-name` (manual + opt-in automatic session naming with Ghostty tab rename, OFF by default), `sword-header` (themed ASCII startup header, OFF by default), `fast-mode` (opt-in Anthropic fast mode for Opus 4.8, OFF by default), `provider-stall-watchdog` (opt-in provider-stall recovery: a pre-first-event tier in every mode, a mid-stream tier in TUI only), and `slack` (opt-in context-safe Slack search/threads/posting: dual user/bot token identities, a workspace-keyed name cache, a transactional announce protocol). Opt-in extensions resolve their `settings.json` config via the shared `lib/extension-config.ts` (`getAgentDir()`-based global + project layering), nested under `quiver.<key>` (e.g. `quiver.slack`).

<!-- agents-core:begin v2 - shared across pi-quiver/pi-cohort/pi-gauntlet/pi-condense. Edit AGENTS.core.md, then: node scripts/check-agents-core.mjs --fix -->
## Communication Style

Applies to chat, commit messages, PR/issue comments, code review, and any artifact authored in this repo.

- **Human, terse, but sharp and precise.** Applies everywhere: interactive session, issue/PR comments, `.md` files. Terse is not vague - keep it exact.
- **Suppress process narration.** No intent classification, phase announcements, tool/subagent preamble, status updates, pleasantries. Start with substance.
- **Output instead:** outcomes, decisions needing input, verification results, blockers.
- **Bullets over prose. Short paragraphs.** No wall-of-text, no tutorial tone unless asked.
- **Show an example when it clarifies a complex point** - a small before/after or a concrete ref beats a paragraph. Examples disambiguate, they don't pad.
- **End on the ask, not a summary.** Diffs/outputs speak for themselves.
- **Match the recipient's register** in human-facing artifacts (issues, PRs, chat).
- **Prefer ASCII.** `-` not em/en-dashes, `...` not the ellipsis glyph, straight quotes. Non-ASCII only for a justified visual mark.

LLM-readable artifacts (`AGENTS.md`, `README.md`, `CHANGELOG.md`, skill bodies, agent personas, spec docs, code comments where the *why* is non-obvious) stay structured: tables, headings, explicit field references, code blocks. Optimize for retrieval over readability.

## Code & Documentation Discipline

- **Code is a liability.** Add only what the task requires. No premature abstractions, no helpers for hypothetical reuse, no fallbacks for branches that can't happen, no commented-out alternatives.
- **No new machinery if not essential.** Reuse an existing field, channel, or code path (plus a small discriminant if needed) over a new sibling construct; new machinery must earn its place by being impossible or misleading to express with what exists.
- **Docs are a contract.** Dense, current, no preamble. If a sentence doesn't help a future reader act, cut it - this applies to documentation as much as code.
- **No belt-and-suspenders.** Don't validate / null-check / guard the same thing at multiple layers - validate at the boundary once.
- **Delete dead code, don't comment it out.** Branch from the deletion commit if reversibility matters.
- **Comments only when the *why* is non-obvious.** No docstrings on self-evident params/returns. No banner/separator comments. Don't reference the current task or PR - that belongs in the commit message.
- **Markdown tables use compact `|---|` separators.** Never padded columns.
- **Surface, don't auto-fix.** A bug fix doesn't drag in surrounding cleanup; mention adjacent issues separately.

## Ticket convention

Creating a ticket or repairing its title/body/metadata happens only via `/skill:shape-ticket` (pi-gauntlet >= the release that ships it) - it enforces the Context -> Problem -> Idea -> Acceptance Criteria template, an AC integrity gate, and a cheap council roast applied to the body before the single human-gated write (no roast comments). Status transitions and comments are exempt - plain tracker CLI.

## Ground Truth Before Reasoning

Never guess Pi's API, message shapes, config, or values - read the source; the source wins; if it is missing, say so and ask, don't fabricate. The pi runtime is the **`@earendil-works`** namespace (matches the host pi install), not `@mariozechner` - treat its shipped `.d.ts` as API truth. Repo-specific source pointers, if any, follow.

<!-- agents-core:end v2 -->

## Part of one platform (cross-repo synergy)

This repo is one of four sibling pi extensions - **pi-quiver** (capabilities),
**pi-cohort** (coordination), **pi-condense** (context economy), **pi-gauntlet**
(process) - that compose into one governed agent workflow. They ship and version
independently, but documentation is deliberately cross-referential: a concept is
explained in its owning repo and *linked* from the others, never duplicated.

- Only hard code dependency: pi-gauntlet -> pi-cohort (`subagent()`).
- Real runtime coupling: pi-condense emits `cost:external`; pi-cohort aggregates
  it into `Σ$`.
- pi-quiver is an independent toolbox; no code coupling.

When editing docs here, if a claim belongs to a sibling's concern, link the
sibling's doc rather than restating it. When a change alters a cross-repo
contract (dispatch shape, cost channel, settings keys), update the sibling's
docs in the same logical change and note it in both CHANGELOGs.

- **Extension API:** `node_modules/@earendil-works/pi-coding-agent/dist/**/*.d.ts` - `ExtensionAPI`, `registerTool`, tool result/`details` shapes, exported helpers like `formatSize`, `keyHint`.
- **TUI:** `node_modules/@earendil-works/pi-tui` - `Text` and theme helpers used in `renderCall` / `renderResult`.

## Layout

```
extensions/                               # one top-level file = one pi extension entry point
                                          # (fetch, doc_to_md, session-name, sword-header,
                                          #  fast-mode, provider-stall-watchdog, slack)
lib/extension-config.ts                   # shared getAgentDir()-based settings.json resolution
lib/fetch-core.ts                         # fetch data plane (fetchUrl); extensions/fetch.ts and bin/pi-quiver.ts are thin adapters over it
lib/doc-to-md-core.ts                     # doc_to_md data plane (convertDocument); extensions/doc_to_md.ts and bin/pi-quiver.ts are thin adapters over it
lib/slack-core.ts                         # slack config/token resolution, transport, search/thread reads, mutations, announce protocol; extensions/slack.ts is a thin adapter over it
lib/slack-cache.ts                        # slack workspace-keyed channel/user name->ID cache; sits on top of lib/slack-core.ts
bin/pi-quiver.ts                          # pi-quiver CLI source (fetch + doc-to-md subcommands); published as esbuild-built dist/, not committed
skills/, .claude-plugin/                  # Claude Code plugin + fetch/doc-to-md skills; invisible to pi (explicit pi.extensions manifest), excluded from the npm tarball
test/                                     # node --test suites, one per extension, + layout.test.ts
test/fixtures/                            # sample.pdf/.docx/.pptx for manual doc_to_md checks
doc/slack.md                              # slack extension reference: tools, quiver.slack config, cache layering, announce protocol, manual smoke checklist
tsconfig.json                             # single source of typecheck flags + include list
AGENTS.core.md                            # shared-core block, byte-identical across the sibling repos
scripts/check-agents-core.mjs             # asserts AGENTS.md embeds AGENTS.core.md verbatim (--fix rewrites)
scripts/pdf_to_md.py                      # doc_to_md Python entry point, loaded via import.meta.url
package.json                              # pi.extensions = ["./extensions"]; files allowlist; bundled deps + @earendil-works peerDeps
.github/workflows/test.yml                # unit + typecheck on ubuntu + windows, every push/PR
.github/workflows/release.yml             # tag-triggered npm publish (OIDC + provenance)
.agents/skills/release/SKILL.md           # release flow (tag-triggered npm model)
.agents/skills/release/scripts/release.sh # authoritative release script (CONFIG header + shared skeleton)
prompts/release.md                        # /release prompt template
```

## Workflow

- **Adding an extension:** drop `extensions/<name>.ts` exporting `default function (pi: ExtensionAPI)` - no manifest edit needed, the `./extensions` directory entry discovers it. Document it in `README.md`, add a `CHANGELOG.md` entry. Only extension entry points belong at the top level of `extensions/`: pi imports every top-level `.ts`/`.js` there and silently drops a non-function default after the import's side effects have already run. `test/layout.test.ts` enforces this.
- **Test + typecheck before committing.** `npm run test:all` runs the unit tests (`node --test "test/*.test.ts"`) then the typecheck (`npx -y tsc --noEmit`, flags live in `tsconfig.json`). The peer deps (`@earendil-works/*`, `@sinclair/typebox`) and type packages are in `devDependencies`, so a plain install wires everything up:

  ```bash
  npm install
  npm run test:all
  ```

  This is the same command the CI test + release workflows run.
- **Publishability:** `package.json` `files` ships the `extensions` and `lib` directories plus `dist` (`test/` and `tsconfig.json` are intentionally excluded). `dist/` is built at `prepack` via the `esbuild` devDependency (`npm run build` bundles `bin/pi-quiver.ts` + its `lib/fetch-core.ts` import, `--packages=external` so runtime deps like `jsdom` stay external and resolve from the tarball's own `dependencies`); it is gitignored and exists only in the published tarball. `bin` points into it: `"bin": { "pi-quiver": "dist/bin/pi-quiver.js" }`. `skills/`, `.claude-plugin/`, and the `bin/` TypeScript sources are intentionally excluded from `files` - Claude Code artifacts never ship to pi users. The bundled runtime deps (`jsdom`, `@mozilla/readability`, `turndown`, `turndown-plugin-gfm`, `unpdf`) stay in `dependencies` so they ship in the tarball; the `@earendil-works/*` + `@sinclair/typebox` peers are provided by the host pi runtime. `scripts/pdf_to_md.py` is in `files` because `extensions/doc_to_md.ts` loads it at runtime via `import.meta.url`. Check the tarball with `npm pack --dry-run`.
- **`doc_to_md` engines.** `lib/doc-to-md-core.ts` resolves a backend ladder once per process: `uv` (pinned `--with pymupdf4llm==<pin> --python 3.14`) -> system `python3`/`python` >= 3.12 with `pymupdf4llm` importable (unpinned) -> a one-time managed venv bootstrapped at the pin into the per-OS cache dir (atomic publish, no invalidation) -> `unpdf` degraded fallback with a closed `Fallback-Reason:` list. `scripts/pdf_to_md.py` is the Python conversion entry point, resolved from the package root (walk-up from the core module) rather than a fixed relative path, so it still resolves when the CLI runs from the bundled `dist/`. DOCX/PPTX route through `soffice` to PDF first. `uv`/`soffice` detection is spawn-based (Windows-correct, no shell-specific `which`/`where`). CI tests pin the `unpdf` rung via a scrubbed `PATH`/cache environment; the `uv`, system-Python, and managed-venv rungs are manual smoke only (not under `tsc`/`node --test`). Known limitation: Windows setups exposing Python only via the `py` launcher are not detected (candidates are `python3`/`python`).
- **`provider-stall-watchdog` runtime boundary.** OFF by default; once enabled the boundary is two-phase. The `firstEventMs` tier (default 20s, cleared by the first assistant `message_start`) arms for **every** provider request - every mode (`tui`/`print`/`json`/`rpc`) and every origin, including extension-triggered turns - because activation is lazy inside `before_provider_request`; config is therefore resolved once per session. The mid-stream `warningMs`/`recoveryMs` tier arms only when `ctx.mode === "tui"`, so unattended runs never abort mid-generation. Policy D offers each stall to Pi's retry loop up to `maxStallRetries` times (default = layered `retry.maxRetries`, else 3), verified with Pi 0.80.10; unavailable retry falls back to manual resubmission. See `README.md` for settings and operational behavior.
- **`slack` runtime boundary.** OFF by default; conditional registration at `session_start` - zero tools and zero side effects (no `.env` read, no network, no cache I/O) when disabled; toggling `quiver.slack.enabled` takes effect next session, same registration-time gate as the other opt-in extensions. Token resolution is per call: process env first, then the repo's `.env` (or the primary checkout's `.env` for a worktree with none), never a fallback across the `user`/`bot` identities. The channel/user name->ID cache is workspace-keyed (by Slack team ID), with a `cachePath` config override. Announce-protocol invariants (single-headline guarantee, detail upload fallback, pending-marker recovery) live in `lib/slack-core.ts`. See `doc/slack.md`.
- **`npm pack`/publish triggers the prepack build.** `prepack` runs `npm run build` (esbuild), regenerating `dist/bin/pi-quiver.js` before every pack/publish; `test/packed-install.test.ts` packs the tarball, installs it into a scratch dir, and runs the installed bin to guard against packaging regressions (e.g. `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` from an unbuilt `.ts` bin).
- **Releases use the `release` skill.** See [Release model](#release-model). Tag-triggered and CI-executed; the script bumps + tags + pushes, CI publishes to npm. Never `npm publish` by hand.
- **Smoke-test** with `pi -e ./extensions/fetch.ts -p "fetch https://example.com"` (or `pi -e npm:pi-quiver -p "..."` against the published package).

## Release model

Published to **npm** as `pi-quiver`; installed with `pi install npm:pi-quiver`.
The `pi-package` keyword lists it on the pi.dev packages gallery automatically.
Plain semver.

Release is **tag-triggered and CI-executed**:

1. The `release` skill (driven by `release.sh`) proposes the semver level, bumps
   `package.json`, commits `Release <version>`, runs `npm run test:all` as a
   pre-flight, creates the annotated `v<version>` tag, pushes `main` + tag, then
   monitors CI and verifies npm + pi.dev. **No local `npm publish`.**
2. Pushing a `v[0-9]+.[0-9]+.[0-9]+` tag triggers
   `.github/workflows/release.yml`, which installs, verifies the tag matches
   `package.json`, runs `npm run test:all`, and runs
   `npm publish --provenance --access public` via npm OIDC trusted publishing.
   `.github/workflows/test.yml` runs the suite on every push + PR (ubuntu + windows).

The release machinery (`release.sh`, `test.yml`, `release.yml`) is kept
near-identical to the sibling pi-* repos; `release.sh` differs only in its
CONFIG header (package name, repo slug, former name, test command).
`pi-quiver` was renamed from `pi-essentials` at v3.0.0, so
`FORMER_PACKAGE_NAME="pi-essentials"`; `sync-presets` flags stale
`pi-essentials` pins (npm or git form) for manual migration.

### Tag scheme

`v<major>.<minor>.<patch>` - plain semver. `package.json` `version` mirrors the
tag without the leading `v`.

### One-off npm setup

OIDC trusted publishing must be registered once on npmjs.com for the
`pi-quiver` package (Settings -> Trusted Publishing -> GitHub Actions
publisher for repo `jjuraszek/pi-quiver`, workflow `release.yml`). Until it
exists, the publish step cannot authenticate (403).
