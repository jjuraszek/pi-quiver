# pi-quiver

Personal pack of Pi coding-agent extensions, published to npm as `pi-quiver` like sibling pi-* packages. Each extension is a standalone default-exported function listed in `package.json` `pi.extensions`. Ships `fetch` (context-safe URL retrieval), `doc_to_md` (local PDF/DOCX/PPTX -> Markdown via pymupdf4llm with a pure-JS unpdf fallback), `session-name` (manual + opt-in automatic session naming with Ghostty tab rename, OFF by default), and `sword-header` (themed ASCII startup header, OFF by default). Opt-in extensions resolve their `settings.json` config via the shared `extension-config.ts` (`getAgentDir()`-based global + project layering).

<!-- agents-core:begin v1 - shared across pi-quiver/pi-cohort/pi-gauntlet/pi-condense. Edit AGENTS.core.md, then: node scripts/check-agents-core.mjs --fix -->
## Communication Style

Same rules as the parent `~/.pi/agent*/AGENTS.md`. Applies to chat, commit messages, PR/issue comments, code review, and any artifact authored in this repo.

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
- **Docs are a contract.** Dense, current, no preamble. If a sentence doesn't help a future reader act, cut it - this applies to documentation as much as code.
- **No belt-and-suspenders.** Don't validate / null-check / guard the same thing at multiple layers - validate at the boundary once.
- **Delete dead code, don't comment it out.** Branch from the deletion commit if reversibility matters.
- **Comments only when the *why* is non-obvious.** No docstrings on self-evident params/returns. No banner/separator comments. Don't reference the current task or PR - that belongs in the commit message.
- **Markdown tables use compact `|---|` separators.** Never padded columns.
- **Surface, don't auto-fix.** A bug fix doesn't drag in surrounding cleanup; mention adjacent issues separately.

## Ticket convention

Every GitHub issue follows **Context -> Problem -> Idea (how to address) -> Acceptance Criteria**, then the idea is **roasted by 2 subagents and the consolidated roast is posted as a comment** before the issue is ready. A roast that kills or shrinks the idea is a success - file only what survives.

## Ground Truth Before Reasoning

Never guess Pi's API, message shapes, config, or values - read the source; the source wins; if it is missing, say so and ask, don't fabricate. The pi runtime is the **`@earendil-works`** namespace (matches the host pi install), not `@mariozechner` - treat its shipped `.d.ts` as API truth. Repo-specific source pointers, if any, follow.

<!-- agents-core:end v1 -->

- **Extension API:** `node_modules/@earendil-works/pi-coding-agent/dist/**/*.d.ts` - `ExtensionAPI`, `registerTool`, tool result/`details` shapes, exported helpers like `formatSize`, `keyHint`.
- **TUI:** `node_modules/@earendil-works/pi-tui` - `Text` and theme helpers used in `renderCall` / `renderResult`.

## Layout

```
fetch.ts                                  # fetch extension (entry in pi.extensions)
doc_to_md.ts                              # doc_to_md extension (entry in pi.extensions)
session-name.ts                           # session-name extension (entry in pi.extensions; OFF by default)
sword-header.ts                           # sword-header extension (entry in pi.extensions; OFF by default)
extension-config.ts                       # shared getAgentDir()-based settings.json resolution (resolveConfig)
AGENTS.core.md                            # shared-core block, byte-identical across pi-quiver/pi-cohort/pi-gauntlet/pi-condense
scripts/check-agents-core.mjs             # asserts AGENTS.md embeds AGENTS.core.md verbatim (--fix rewrites); runs in test:all
scripts/pdf_to_md.py                      # doc_to_md Python conversion entry point
package.json                              # pi.extensions = ["./fetch.ts", "./doc_to_md.ts", "./session-name.ts", "./sword-header.ts"]; files allowlist; bundled deps + @earendil-works peerDeps
.github/workflows/test.yml                # unit + typecheck on ubuntu + windows, every push/PR
.github/workflows/release.yml             # tag-triggered npm publish (OIDC + provenance)
.agents/skills/release/SKILL.md           # release flow (tag-triggered npm model)
.agents/skills/release/scripts/release.sh # authoritative release script (CONFIG header + shared skeleton)
prompts/release.md                        # /release prompt template
```

## Workflow

- **Adding an extension:** drop `<name>.ts` exporting `default function (pi: ExtensionAPI)`, add `"./<name>.ts"` to `pi.extensions`, document it in `README.md`, add a `CHANGELOG.md` entry.
- **Test + typecheck before committing.** `npm run test:all` runs the unit tests (`node --test *.test.ts`) then the typecheck (`tsc --noEmit`). The peer deps (`@earendil-works/*`, `@sinclair/typebox`) and type packages are in `devDependencies`, so a plain install wires everything up:

  ```bash
  npm install
  npm run test:all
  ```

  This is the same command the CI test + release workflows run.
- **Publishability:** `package.json` `files` is an allowlist. The bundled runtime deps (`jsdom`, `@mozilla/readability`, `turndown`, `turndown-plugin-gfm`, `unpdf`) stay in `dependencies` so they ship in the tarball; the `@earendil-works/*` + `@sinclair/typebox` peers are provided by the host pi runtime. `scripts/pdf_to_md.py` is in `files` because `doc_to_md.ts` loads it at runtime via `import.meta.url`. Check the tarball with `npm pack --dry-run`.
- **`doc_to_md` engines.** `scripts/pdf_to_md.py` is the Python conversion entry point, invoked via `uv run --with pymupdf4llm==<pin> --python 3.14` (not under `tsc`/`node --test`; verify by direct uv invocation). DOCX/PPTX route through `soffice` to PDF first. `uv` and `soffice` are optional runtime system binaries; absence degrades to the `unpdf` fallback (PDF) or hard-errors (office).
- **Releases use the `release` skill.** See [Release model](#release-model). Tag-triggered and CI-executed; the script bumps + tags + pushes, CI publishes to npm. Never `npm publish` by hand.
- **Smoke-test** with `pi -e ./fetch.ts -p "fetch https://example.com"` (or `pi -e npm:pi-quiver -p "..."` against the published package).

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
