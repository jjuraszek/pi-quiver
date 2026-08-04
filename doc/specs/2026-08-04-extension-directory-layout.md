# Extension directory layout

Moves the 13 root `.ts` files into `extensions/`, `lib/`, and `test/`, replaces the
per-extension `pi.extensions` literals with a single directory entry, and replaces the
inline `tsc` file list with a `tsconfig.json`. Makes the next release a **4.0.0 major**: the
move silently breaks `pi config`-persisted package filters.

Issue: [jjuraszek/pi-quiver#4](https://github.com/jjuraszek/pi-quiver/issues/4).

## Goal

Adding an extension should touch exactly one file of **plumbing** - none. Today it touches
three (`pi.extensions`, `files`, `typecheck`), and the repo root mixes 6 extensions, 1
helper, and 6 tests into one flat 13-file list.

The "one file" claim is scoped to registration, packaging, and typecheck config. The two
user-facing doc surfaces - the README Architecture table and a CHANGELOG entry - stay
mandatory per extension by design: they describe what the extension *does*, which no
directory convention can derive. D5 removes the *third* duplicate (the AGENTS.md tree), not
the first two.

## Non-goals

- No behaviour change in any extension. The only source edit is one path literal in
  `doc_to_md.ts` and 10 import specifiers.
- `scripts/`, `types/`, `.github/`, `.agents/` do not move.
- `test/fixtures/{sample.pdf,sample.docx,sample.pptx}` stay where they are, still
  unreferenced by any test, still unshipped. They are manual-verification assets; deleting
  or wiring them up is out of scope.
- No `exports` field, no back-compat shims for deep imports like `pi-quiver/fetch.ts`.

## Ground truth

Verified against the installed runtime
(`node_modules/@earendil-works/pi-coding-agent/dist/core/`, pi 0.80.x), not against
`packages.md` prose. The issue's link to that doc 404s; it ships locally at
`node_modules/@earendil-works/pi-coding-agent/docs/packages.md`.

**A directory entry expands to every top-level `.ts`/`.js` file.**
`collectFilesFromManifestEntries` (`package-manager.js:1868`) resolves a non-glob entry to
an absolute path; `collectFilesFromPaths` (`:1979`) sees a directory and calls
`collectResourceFiles(dir, "extensions")` -> `collectAutoExtensionEntries` (`:399`):

1. `<dir>/package.json` with a `pi.extensions` array, or `<dir>/index.{ts,js}`, wins and
   stops the scan.
2. Otherwise `readdirSync` skips dotfiles, `node_modules`, and gitignored paths, and takes
   **every** top-level `.ts`/`.js`. A subdirectory contributes only through its own
   `index.{ts,js}` or `package.json`. No recursion beyond one level.

`isExtensionFile` (`loader.js:427-429`) is `name.endsWith(".ts") || name.endsWith(".js")` -
no `.test.ts` or `.d.ts` filtering.

**A non-extension file in that directory is imported anyway.** `loadExtensionModule`
(`loader.js:321`) imports the module, finds `typeof factory !== "function"`, and returns
`undefined` - but the import already ran, and the file is listed as a resource in
`pi config`. This is why `extension-config.ts` cannot live at the top level of
`extensions/`, and why a colocated `extensions/<name>.test.ts` would register `node:test`
suites inside a normal pi session.

**The published-path break is `pi config`, not deep imports.** `config-selector.js:487-500`
and `:593` persist a filter as `` `${state === "load" ? "+" : "-"}${pattern}` `` with
`pattern = relative(packageRoot, resourcePath)` - today `"-fast-mode.ts"`. After the move
that path does not exist. `applyPatterns` (`package-manager.js:540`) force-excludes
nothing, so the entry no-ops and an extension the user disabled through the config UI comes
back on upgrade, silently.

The matchers are asymmetric (`package-manager.js:465-511`): `matchesAnyPattern`, used for
plain and `!` patterns, falls back to basename matching (`minimatch(name, pattern)`,
`:477`); `matchesAnyExactPattern`, used for `+`/`-`, compares only the package-root-relative
path and the absolute path (`:502-510`). A hand-written `!fast-mode.ts` in `settings.json`
therefore survives the move; the `-fast-mode.ts` that `pi config` writes does not.

Baseline: `npm run test:all` on `main` @113f860 is **151 tests, 0 fail**. The issue's 138 is
stale (itself a correction of a stale 119). Current `npm pack --dry-run`: 13 files, no
tests.

## Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | `pi.extensions: ["./extensions"]`; helper at `lib/extension-config.ts` | Helper at `extensions/lib/` - safe only until someone adds `index.ts` there. Six explicit entries - keeps the coupling this change exists to remove. |
| D2 | 4.0.0 + CHANGELOG migration note; `README.md:123` corrected in place | 3.x minor - the `pi config` break is silent, which is what majors are for. A README migration section - dead weight in three months. |
| D3 | `tsconfig.json` with an explicit `include` list | `"include": ["**/*.ts"]` - matches `.worktrees/*/*/**/*.ts`, so it needs an `exclude` patch to be correct. |
| D4 | `test/layout.test.ts` guards the directory invariant | Prose in AGENTS.md only; an `npm pack --dry-run` shell-out (seconds of runtime, and `files` is asserted statically). |
| D5 | AGENTS.md Layout collapses to directory level | Exhaustive per-file tree re-rooted - reintroduces per-extension doc maintenance. |

## Target layout

```
extensions/          # one top-level file = one pi extension entry point
  fetch.ts  doc_to_md.ts  session-name.ts
  sword-header.ts  fast-mode.ts  provider-stall-watchdog.ts
lib/
  extension-config.ts          # shared resolveConfig; not an extension
test/
  fetch.test.ts  doc_to_md.test.ts  session-name.test.ts
  sword-header.test.ts  fast-mode.test.ts  provider-stall-watchdog.test.ts
  layout.test.ts               # new
  fixtures/                    # unchanged
scripts/pdf_to_md.py           # unchanged
types/turndown-plugin-gfm.d.ts # unchanged
tsconfig.json                  # new
```

`lib/` exists because a manifest-referenced directory's top level is a load surface. It is
not a general-purpose bucket: it holds code shared between extensions and nothing else.

## Changes

All moves use `git mv` so rename detection keeps history.

### Moves

| From | To |
|---|---|
| `{fetch,doc_to_md,session-name,sword-header,fast-mode,provider-stall-watchdog}.ts` | `extensions/` |
| `extension-config.ts` | `lib/` |
| `{...}.test.ts` (6) | `test/` |

### Path rewrites - 13 lines

| Where | From | To |
|---|---|---|
| `extensions/fast-mode.ts:26`, `session-name.ts:21`, `sword-header.ts:17`, `provider-stall-watchdog.ts:2` | `"./extension-config.ts"` | `"../lib/extension-config.ts"` |
| `test/<name>.test.ts` (6) | `"./<name>.ts"` | `"../extensions/<name>.ts"` |
| `extensions/doc_to_md.ts:253` | `new URL("./scripts/pdf_to_md.py", import.meta.url)` | `new URL("../scripts/pdf_to_md.py", import.meta.url)` |
| `package.json` `test` | `node --test "*.test.ts"` | `node --test "test/*.test.ts"` |
| `package.json` `typecheck` | 10 flags + 14 inline paths | `npx -y tsc --noEmit` |

`extensions/` is one level below the package root, so `doc_to_md.ts` goes up exactly one
level - `../scripts/`, not `../../scripts/`. The relationship holds identically in the
installed tarball, where the package root is `metadata.baseDir`.

`fetch.ts` and `doc_to_md.ts` do not import the helper; only the four opt-in extensions do.

### package.json

```json
"files": ["extensions", "lib", "scripts/pdf_to_md.py", "types/**/*.d.ts", "README.md", "CHANGELOG.md"],
"pi": { "extensions": ["./extensions"], "image": "<unchanged>" }
```

`test/` is unlisted, so no test or fixture ships - the same outcome as today's per-file
allowlist, without the per-extension entry. `tsconfig.json` is also unlisted: it is
dev-only, and pi transpiles `.ts` itself rather than reading it.

### tsconfig.json

Carries the ten flags the inline command used - `strict`, `module: nodenext`,
`moduleResolution: nodenext`, `target: es2022`, `lib: [es2022]`,
`allowImportingTsExtensions`, `skipLibCheck`, `esModuleInterop`, `resolveJsonModule`,
`types: ["node"]` - plus `noEmit`, and:

```json
"include": ["extensions/**/*.ts", "lib/**/*.ts", "test/**/*.ts", "types/**/*.d.ts"]
```

Flag parity against the replaced command string is verified by reading both, not inferred.

### Unchanged, despite the issue listing them as coupled

- `scripts/check-agents-core.mjs:12-14` derives the repo root as
  `dirname(fileURLToPath(import.meta.url)) + ".."` and touches only `AGENTS.core.md` and
  `AGENTS.md`. `scripts/` does not move.
- `.github/workflows/{test,release}.yml` and `.agents/skills/release/scripts/release.sh`
  invoke `npm run test:all` / `npm ci` generically.
- `CHANGELOG.md:121` names `extension-config.ts` as historical record. History is not
  rewritten.

## Testing

### Automated

`test/layout.test.ts` (new) reads `package.json` and `readdir`s `extensions/`:

1. Every top-level `extensions/*.ts` has `typeof (await import(...)).default === "function"`.
2. No `*.test.ts` exists under `extensions/`.
3. `files` contains both `extensions` and `lib`.

Assertion 1 is the point of the file: D1 makes "everything at the top of `extensions/` is an
extension" a runtime contract, and pi's own loader does not enforce it - it discards a
non-function default silently, after importing. Importing all six modules in one test is
proven safe: the six existing test files already import them individually.

The six moved tests change only their import specifier. Expected result:
**151 + 3 pass, 0 fail**, with all seven test files discovered - assert the file count, not
just the total, since an equal total can mask one lost file plus one added case.

### Manual, in acceptance

Neither is reachable from `node --test`:

- **Isolated tarball install.** `npm pack`, install the tarball into a throwaway agent dir,
  run pi against it, confirm all six extensions load and that neither `extension-config.ts`
  nor any test appears as a resource in `pi config`. This is the only check that exercises
  `collectPackageResources` against a real installed tree. `pi -e npm:pi-quiver` resolves
  the registry, not the local build - do not substitute it.
- **`doc_to_md` runtime path.** Convert `test/fixtures/sample.pdf`. The tool's
  `parameters` schema is `Type.Object({ path })` (`doc_to_md.ts:369-370`) - `engine` is not
  a caller-supplied argument; `runPipeline` (`:325-347`) picks it from `uv` availability
  plus a warm probe. So the check is: run on a machine where `uv` resolves, then assert the
  result header line reads `Engine: pymupdf4llm` with no `(degraded fallback)` suffix
  (`:391`). An `Engine: unpdf` result proves nothing - that path never touches
  `import.meta.url`, so a depth regression stays invisible to the entire automated suite.
- **Stale `pi config` filter.** In the same throwaway agent dir, seed a pre-move filter
  (`"extensions": ["-fast-mode.ts"]`) before installing the new tarball, then confirm
  fast-mode loads anyway. This turns the semver-major rationale from a source-read
  inference into an observed behaviour; it is the only evidence that the documented break is
  real.

CI needs no edits. Windows keeps working because `node --test "test/*.test.ts"` uses the
same node-expanded quoted glob as today's `"*.test.ts"`.

## Acceptance criteria

- [ ] No `*.ts` at the repo root.
- [ ] `npm run test:all` green at **154 tests** (151 baseline + 3 layout assertions), with
      all seven `test/*.test.ts` files discovered.
- [ ] `npm pack --dry-run` lists the six extensions at `extensions/<name>.ts`,
      `lib/extension-config.ts`, and `scripts/pdf_to_md.py`; lists no `*.test.ts`, no
      fixture, and no `tsconfig.json`.
- [ ] Tarball installed into an isolated agent dir loads all six extensions; `pi config`
      shows six resources, not seven or thirteen.
- [ ] `doc_to_md` converts `test/fixtures/sample.pdf` and reports `Engine: pymupdf4llm`,
      not `unpdf` and not degraded.
- [ ] A seeded pre-move `-fast-mode.ts` filter no-ops against the installed tarball, with
      fast-mode loading - the documented break, observed.
- [ ] `npm run typecheck` is `npx -y tsc --noEmit` with no inline file list; flag parity
      confirmed against the replaced string.
- [ ] `npm run check:agents-core` passes.
- [ ] `CHANGELOG.md` carries the migration note below. The `package.json` version is **not**
      touched here: `release.sh` assigns it and commits `Release <version>` separately
      (`.agents/skills/release/scripts/release.sh:162-196`). This change only makes the next
      release a `major`.
- [ ] The move lands as its own commit, separate from any behaviour work.

## Migration note (CHANGELOG, 4.0.0)

> Extension sources moved from the package root into `extensions/`; the shared config
> helper moved to `lib/`. If you disabled an extension through `pi config`, the stored
> filter (e.g. `-fast-mode.ts`) no longer matches and the extension will load again -
> re-disable it, or update the entry to `extensions/fast-mode.ts`. Local-checkout users:
> `pi -e <path>/fetch.ts` is now `pi -e <path>/extensions/fetch.ts`.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (Architecture table's filename column ->
  `extensions/<name>.ts`; `:123` local-checkout command; `:206` test-command comment),
  `CHANGELOG.md` (4.0.0 entry + migration note above)
- Derived / memory docs invalidated: `AGENTS.md` - `## Layout` tree (collapses to directory
  level per D5), the preamble sentence naming `pi.extensions` entries and
  `extension-config.ts`, and the `## Workflow` bullets "Adding an extension" (loses the
  manifest-edit step), "Test + typecheck", "Publishability", "`doc_to_md` engines", and
  "Smoke-test" (`pi -e ./fetch.ts` -> `pi -e ./extensions/fetch.ts`)

Materiality bar per `reference/documentation-impact.md`. No new standalone `.md`: every
affected topic already has an owner. All edits fall outside the `agents-core:begin/end`
block, so `AGENTS.core.md` byte-identity across the four sibling repos is preserved.

## Error and edge cases

| Case | Handling |
|---|---|
| Someone drops a helper into `extensions/` | `test/layout.test.ts` assertion 1 fails. |
| Someone colocates a test into `extensions/` | Assertion 2 fails. |
| Someone adds `extensions/lib/index.ts` later | Pi would load it as an extension. Not guarded - `lib/` sits at the root precisely so this arrangement never arises. |
| `doc_to_md.ts` depth regression | Invisible to `tsc` and `node --test`; caught only by the manual `engine=pymupdf4llm` conversion. |
| Stale `pi config` filter | Accepted break, documented in the migration note. No programmatic migration exists. |
| Deep import `pi-quiver/fetch.ts` by a third party | Accepted break. No `exports` fence exists today, so it was never a supported surface. |

## Open questions

None.
