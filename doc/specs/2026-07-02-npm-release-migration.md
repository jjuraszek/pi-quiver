# pi-quiver: migrate distribution from git-tag pins to npm

Date: 2026-07-02
Status: proposed
Role model: `../pi-cohort` (npm-published pi package with tag-triggered CI release)

## Goal

Move `pi-quiver` from **git-tag-pin distribution** (`pi install git:github.com/jjuraszek/pi-quiver@vX.Y.Z`) to **npm** (`pi install npm:pi-quiver`), mirroring `pi-cohort`'s release machinery: tag-triggered GitHub Actions publish via npm OIDC trusted publishing + provenance, a cross-platform test workflow, and a `release.sh` whose only per-repo divergence is a CONFIG header. Bring `README`, `AGENTS.md`, `CHANGELOG`, LICENSE, the `release` skill, and the `/release` prompt on par with pi-cohort. Remove the lone `gridstrong` reference and confirm no proprietary assets ship.

This is a breaking public-identity change (distribution mechanism), so it lands as a **major** bump: `2.0.2 -> 3.0.0`.

## Non-goals

- No change to extension runtime behavior (`fetch.ts`, `doc_to_md.ts`, `session-name.ts`, `sword-header.ts`, `extension-config.ts`, `scripts/pdf_to_md.py`) beyond what packaging requires.
- No CHANGELOG history rewrite (historical entries keep their current `## vX.Y.Z - date` style; the new entry matches the file's existing style).
- No new extension.

## Structural difference from pi-cohort (load-bearing)

pi-cohort bundles only `jiti`; everything else is a peer dep. **pi-quiver bundles real runtime deps** (`@mozilla/readability`, `jsdom`, `turndown`, `turndown-plugin-gfm`, `unpdf`) that MUST ship in the published tarball. Therefore:

- Those five stay in `dependencies` (shipped, installed by consumers).
- `@earendil-works/*` + `@sinclair/typebox` stay `peerDependencies` (`*`, optional) - provided by the host pi runtime.
- CI needs the peers + type packages present to run tests/typecheck, so they are added to `devDependencies`.

## Changes

### 1. `package.json`

- Add `"author": "Jacek Juraszek"`, `"engines": { "node": ">=20" }`.
- Expand `keywords`: `["pi-package", "pi", "pi-coding-agent", "fetch", "markdown", "pdf", "cli"]`.
- Add a `files` allowlist (published tarball). MUST include the runtime `.ts` at repo root, `scripts/pdf_to_md.py` (loaded at runtime via `import.meta.url` from `doc_to_md.ts`), `types/`, `README.md`, `CHANGELOG.md`. Excludes `*.test.ts`, `test/`, `.agents/`, `doc/`, `prompts/`. LICENSE is always included by npm.
  ```json
  "files": [
    "fetch.ts",
    "doc_to_md.ts",
    "session-name.ts",
    "sword-header.ts",
    "extension-config.ts",
    "scripts/pdf_to_md.py",
    "types/**/*.d.ts",
    "README.md",
    "CHANGELOG.md"
  ]
  ```
- Scripts:
  - `"test"`: unchanged (`node --test "*.test.ts"`).
  - `"typecheck"`: switch the `bun x tsc` invocation to `npx -y tsc ...` (identical flags) so CI needs no bun.
  - `"test:all"`: `npm run test && npm run typecheck`.
- `dependencies`: unchanged (the five bundled deps).
- `peerDependencies`: add `peerDependenciesMeta` marking each optional (matches pi-cohort).
- `devDependencies`: add `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@sinclair/typebox`, `typescript`, `@types/node`, `@types/jsdom`, `@types/turndown` (versions pinned `^` to current installed).

### 2. GitHub Actions (`.github/workflows/`)

Ported near-verbatim from pi-cohort:

- `test.yml`: on push (all branches) + PR to main; matrix `[ubuntu-latest, windows-latest]`, node 24, `npm install`, `npm run test:all`.
- `release.yml`: on `push` tags `v[0-9]+.[0-9]+.[0-9]+`; `permissions: contents:read, id-token:write`; node 24 with npm registry; upgrade npm; `npm install`; gate `tag == package.json version`; `npm run test:all`; `npm publish --provenance --access public`.

### 3. `.agents/skills/release/scripts/release.sh`

Replace the current git-pin-rewriting script with pi-cohort's tag-triggered npm skeleton. CONFIG header for this repo:

```bash
PACKAGE_NAME="pi-quiver"
REPO_SLUG="jjuraszek/pi-quiver"
FORMER_PACKAGE_NAME="pi-essentials"   # renamed pi-essentials -> pi-quiver at v3.0.0
TEST_CMD="npm run test:all"
```

One intentional skeleton divergence: the `sync-presets` node block guards the `FORMER_PACKAGE_NAME` regexes on non-empty. `pi-quiver` was renamed from `pi-essentials` at v3.0.0, so `FORMER_PACKAGE_NAME="pi-essentials"` and `sync-presets` flags stale `pi-essentials` pins (npm or git form) for manual migration. It still reports **git-tag pins** (`git:github.com/jjuraszek/pi-quiver@...`) for **manual** migration to `npm:pi-quiver@<version>` (git->npm is never auto-rewritten), and auto-bumps same-form `npm:pi-quiver@` pins under `--apply`. This covers existing consumers who pinned via git tag under either name.

### 4. Docs

- `README.md`: Install section -> `pi install npm:pi-quiver` (user + `-l` project scope); keep `pi -e git:...` and local-checkout as "try without installing / hacking". Rewrite Release section to the tag-triggered npm model. Add a short Development/Testing section (`npm install`, `npm run test:all`).
- `AGENTS.md`: replace the git-tag-pin release model with an npm release-model section mirroring pi-cohort's ("Published to npm... tag-triggered and CI-executed", tag scheme, running a release, one-off OIDC setup). Update the transient-install line, the smoke-test line, and the layout note referencing `pi.extensions`.
- `CHANGELOG.md`: new top entry `## v3.0.0 - 2026-07-02` documenting the distribution move to npm, tag-triggered CI publish, `files` allowlist, devDeps, and doc updates. Update the header note that currently says "consumed via git tag pins".
- `.agents/skills/release/SKILL.md`: rewrite to the pi-cohort npm release SKILL (propose/current/patch/minor/major/verify/sync-presets, npm-publish red flags, OIDC one-off setup), adjusted for `pi-quiver`.
- `prompts/release.md`: update to reference the npm release flow.

### 5. `gridstrong` removal

`doc/specs/2026-06-15-doc-to-md-converter.md:126` - reword "reuse the gridstrong `run_soffice` model" to a generic description ("isolated throwaway soffice profile per call, no lock contention"), dropping the proprietary project name.

### 6. `.npmignore`

Remove it - the `files` allowlist supersedes it (pi-cohort ships no `.npmignore`).

### 7. Assets

`test/fixtures/sample.{pdf,docx,pptx}` are unreferenced by any test and carry no proprietary markers (empty author/creator metadata). They do not ship (excluded by `files`). Kept in-repo as manual doc_to_md smoke inputs. No proprietary assets found.

## Testing / verification

- `npm run test:all` (unit + typecheck) green locally before tagging; it is also the CI gate on both workflows.
- Workflows are static-validated by inspection (parallels pi-cohort's, which is known-good).
- After machinery + docs land and are committed, **spawn 4 independent verification subagents** (fresh context) to audit and **apply fixes**:
  - **A - packaging:** `package.json` `files`/deps/scripts correctness, tarball contents (`npm pack --dry-run`), npm-publishability, `import.meta.url` runtime paths resolve inside the published set.
  - **B - CI + release:** `test.yml`/`release.yml` + `release.sh` fidelity to pi-cohort (tag gate, OIDC/provenance, CONFIG header, `sync-presets` git->npm reporting), skeleton divergences intentional and documented.
  - **C - assets + hygiene:** residual `gridstrong`/proprietary references anywhere, LICENSE correctness, no stray assets shipping, `.npmignore` removal consistent with `files`.
  - **D - documentation (dedicated):** README / AGENTS.md / CHANGELOG / release SKILL / `/release` prompt - parity with pi-cohort, **consistency against the actual shipped artifact** (install command matches `package.json`/`files`; smoke-test line real; SKILL subcommands match `release.sh`), install-from-scratch narrative reads correctly for a new user, cross-references resolve, and prose obeys AGENTS.md style (ASCII discipline, no wall-of-text, register).
  Apply fixes they surface.

## Release execution (per user directive)

- Changes land **on `main`** (worktree-first waived by explicit user instruction).
- Sequence: commit all migration changes -> run 3 verifiers -> apply fixes -> promote CHANGELOG to `v3.0.0` -> bump `package.json` to `3.0.0` -> commit `Release 3.0.0` -> create annotated tag `v3.0.0`. **Do not push** (`main` or tag) - deferred for the user's final verification.
- One-off (out of band, user action): register `pi-quiver` as an npm OIDC trusted publisher for repo `jjuraszek/pi-quiver`, workflow `release.yml`, before the first tag is pushed - otherwise the publish step 403s.

## Documentation impact

- `README.md` - install + release + development sections (changed).
- `AGENTS.md` - release model, install/smoke lines (changed).
- `CHANGELOG.md` - new v3.0.0 entry + header note (changed).
- `.agents/skills/release/SKILL.md`, `prompts/release.md` - rewritten (changed).
- `doc/specs/2026-06-15-doc-to-md-converter.md` - gridstrong reword (changed).
- LICENSE - none (already correct MIT).
