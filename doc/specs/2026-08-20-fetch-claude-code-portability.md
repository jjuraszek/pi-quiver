# fetch: Claude Code portability (shared core + CLI + skill)

## Problem

`extensions/fetch.ts` is a mature, tested URL-retrieval capability (GitHub `gh` routing with HTTP fallback, streaming size caps, HTML->Markdown, spill-to-temp-file policy), but it is only reachable through pi's `ExtensionAPI`. Claude Code users in sibling repos fall back to weaker substitutes - gridstrong's `skill:defuddle` wraps an external `defuddle` CLI with no size caps, no binary handling, no gh routing, and no abort/timeout policy (`gridstrong/.agents/skills/defuddle/SKILL.md:1-33`). The goal: one codebase serving both harnesses, without changing pi's native tool contract (typed TypeBox inputs, structured `details`, TUI renderers) and without adding any pi-visible context surface.

## Decision summary

- **Approach A**: extract the fetch data plane into a shared core; pi keeps its native tool via a thin adapter; Claude Code gets a thin CLI adapter plus a SKILL.md that instructs Claude to run it via Bash. No MCP server, no hooks.
- **Distribution**: Claude Code plugin marketplace served from this git repo, matching the pattern established in jjuraszek/pi-gauntlet#11 verbatim. The skill invokes the published npm bin via `npx -y pi-quiver fetch <url>`, so Claude users always run the tested, published code with dependencies resolved.
- **CLI surface**: full parity with the pi tool parameters (`url`, `method`, `headers`, `body`, `raw`, `timeoutMs`) and the same output contract (inline / spill-to-temp-file-with-preview / binary-to-temp-path).
- **Isolation**: pi never sees the skill (explicit `pi` manifest = allowlist discovery); the npm tarball never ships Claude artifacts (`files` allowlist excludes `skills/` and `.claude-plugin/`).

## Architecture

```
lib/fetch-core.ts               extracted data plane (moved from extensions/fetch.ts)
extensions/fetch.ts             pi adapter: registerTool + TypeBox schema + TUI renderers (behavior unchanged)
bin/pi-quiver.ts                CLI adapter source: argv -> core -> stdout (new)
dist/                           prepack-built JS for the CLI path only (bin + core), not committed
skills/fetch/SKILL.md           Claude Code skill: npx invocation + flag/output reference (new)
.claude-plugin/marketplace.json single plugin, source "./", skills allowlist ["./skills/fetch"] (new)
```

The core exports `fetchUrl(opts: FetchOptions): Promise<FetchResult>`:

```ts
interface FetchOptions {
  url: string;
  method?: "GET" | "HEAD" | "POST";   // default GET
  headers?: Record<string, string>;    // user-supplied ONLY; defaults applied inside fetchUrl (see gh-routing ordering)
  body?: string;
  raw?: boolean;
  timeoutMs?: number;                  // default 20000
  signal?: AbortSignal;                // pi's tool-call signal; threads into gh execFile and the HTTP AbortController exactly as execute does today
}
interface FetchResult { output: string; details: FetchToolDetails }  // FetchToolDetails moves to the core unchanged
```

`{ output, details }` is a new projection, not today's envelope: the pi adapter maps it to pi's tool result as `{ content: [{ type: "text", text: output }], details }`. `executeGhRouting`, which today returns the pi envelope directly, changes to return the `output` shape; the two tests in `test/fetch.test.ts` that read `.content[0].text` update accordingly (shape-only change, output text identical). The CLI prints `output`.

The extraction is a move with two named deviations, not verbatim: (1) the envelope projection above; (2) `formatSize` - today imported from the optional peer `@earendil-works/pi-coding-agent` and used in the gh-spill, binary, and text-spill output strings - is copied (~10 lines, from pi's `core/tools/truncate.js`) into `lib/fetch-core.ts`, with a test pinning byte-identical formatting. After extraction the core imports zero `@earendil-works/*` packages, enforced by a layout test.

### Isolation guarantees

- pi-quiver declares an explicit manifest (`pi.extensions = ["./extensions"]` in `package.json`); pi's convention-directory auto-discovery (`skills/`, `prompts/`, ...) applies only when no `pi` manifest exists (pi docs/packages.md, "Convention Directories"). `skills/` and `.claude-plugin/` are therefore invisible to pi - zero context cost, zero behavior change for pi users.
- npm `files` excludes `skills/` and `.claude-plugin/`, so `pi install npm:pi-quiver` ships nothing Claude-specific. Claude users add the marketplace from the git repo.
- The one intentional context surface is on the Claude side: the skill's name + description steer Claude to this fetch instead of WebFetch.

### Runtime constraint: the CLI ships as built JS

Raw `.ts` bins cannot run from an npm install: Node refuses type stripping for any file under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), at every Node version - this is not a version-floor problem. So the CLI path gets a minimal build step, scoped to packaging only:

- `devDependencies` gains `esbuild`; a `prepack` script transpiles `bin/pi-quiver.ts` + `lib/fetch-core.ts` to `dist/` (`--format=esm --platform=node --packages=external` - deps like jsdom stay external, resolved from the package's own `dependencies`).
- `package.json` `"bin": { "pi-quiver": "dist/bin/pi-quiver.js" }`; the built file's line 1 is `#!/usr/bin/env node` (present in the source, preserved by esbuild).
- `dist/` is gitignored, ships in `files`, and exists only in the tarball.
- The pi path is untouched: pi loads `extensions/fetch.ts` (which imports `../lib/fetch-core.ts`) through its own TS handling, exactly as all extensions load today. The repo stays build-free for development, tests, and pi use; `npm run test:all` still runs straight from source.
- `tsconfig.json` `include` gains `bin/**/*.ts` so the CLI source is typechecked.
- CLI Node floor: whatever `engines` already declares (`>=20`); no type-stripping dependency remains.

## Components

### `lib/fetch-core.ts` (moved, no behavior change)

Owns everything behavior-bearing, extracted verbatim from `extensions/fetch.ts:57-454`:

- `classifyGitHubTarget` (issue/PR/repo/Actions-run targets), `buildGhArgs`, `runGh`, `planGhRouting`/`executeGhRouting` - gh CLI routing with fixed argv (no shell), 10 MB max buffer, timeout, abort signal, silent HTTP fallback.
- Streaming body collection with caps: 1 MB parsable / 50 MB binary, 64 KB sniff window, over-cap reader cancellation, failed-write cleanup.
- Content classification (`categorize`: MIME allowlists + NUL sniffing), HTML->Markdown (JSDOM -> Readability -> Turndown/GFM), `prettyJson`.
- Spill policy: inline under 32 KB / 1,000 lines, else temp file under `${tmpdir()}/pi-fetch` with a 60-line/4,000-byte preview; binary always streamed to a temp path, never decoded.
- New top-level `fetchUrl(opts): Promise<FetchResult>` orchestrating validate -> gh route -> HTTP fetch -> classify -> transform -> spill, i.e. the request logic currently inside `execute` (`extensions/fetch.ts:456-615`) minus the pi envelope.
- **gh-routing header ordering (behavior-bearing, must be preserved):** `planGhRouting` skips `gh` whenever `opts.headers` has any keys. `fetchUrl` therefore routes against user-supplied headers only, and applies the default UA/Accept/Accept-Language headers to its local `Headers` object for the plain-HTTP path *after* gh routing has run - never writing defaults back into `opts.headers`. Folding defaults in earlier would silently disable `gh` for every GitHub URL.

The core imports no `@earendil-works/*` packages (see the `formatSize` copy above) and does not use `lib/extension-config.ts` (fetch has no settings dependency today; this is preserved). Exact limits, output text, and fallback semantics are preserved.

### `extensions/fetch.ts` (shrinks to adapter)

Keeps: TypeBox input schema (`url`, `method` GET/HEAD/POST, `headers`, `body`, `raw`, `timeoutMs`), `registerTool` wiring mapping `FetchResult` to pi's `{ content, details }` envelope, and the TUI `renderCall`/`renderResult` (`extensions/fetch.ts:617-691`). External contract byte-identical to today.

### `bin/pi-quiver.ts` (new CLI, published as `dist/bin/pi-quiver.js`)

- Line 1: `#!/usr/bin/env node`. `package.json` gains `"bin": { "pi-quiver": "dist/bin/pi-quiver.js" }` (see Runtime constraint).
- Subcommand form: `pi-quiver fetch <url> [--method GET|HEAD|POST] [--header "K: V"]... [--body <str>] [--raw] [--timeout-ms <n>]`. The subcommand keeps the door open for future CC-only surfaces without new bins; this spec ships only `fetch`.
- **Exit codes mirror what the pi tool actually does today.** The tool has no `res.ok` check and caps are not errors: HTTP 4xx/5xx return a normal result whose text starts `HTTP <status>`, and over-cap bodies return truncated content with a note. So: exit 0 with `result.output` on stdout for *every received response*, including non-2xx and truncated/capped bodies. Exit 1 only where the tool throws today: unsupported protocol / invalid URL, DNS failure, timeout/abort, binary write failure - error text on stderr. Exit 2 for invalid argv (unknown flag, missing url, bad method, malformed `--header`, non-positive/non-numeric `--timeout-ms`), usage on stderr.
- `--header` parsing: repeatable flag; each value splits on the first `": "` (colon-space; a colon in the value is preserved); duplicate keys - last one wins; a value with no colon is malformed (exit 2). Parsed headers populate `FetchOptions.headers` as-is; defaults are the core's business (see gh-routing ordering above).
- Temp files: written to the same `${tmpdir()}/pi-fetch` locations as the extension; absolute paths printed in stdout; no eager cleanup (matches pi behavior, OS-managed).

### `skills/fetch/SKILL.md` (new, Claude-only)

Frontmatter (the always-in-context surface that steers Claude off WebFetch):

```yaml
---
name: fetch
description: Fetch any URL via the quiver fetch CLI - use instead of WebFetch for GitHub issue/PR/repo URLs (routed through authenticated gh), binary downloads (PDFs, images, archives - saved to a temp path, never dumped to output), large pages (size-capped, spilled to a file with a preview), and clean readability-extracted Markdown. Invoke via Bash.
---
```

Body: the exact invocation `npx -y pi-quiver@latest fetch <url> [flags]` (`@latest` deliberately - npx caches per version and would otherwise pin stale behavior silently; the per-run registry hit is accepted); flag reference; output contract (inline content vs "Output saved to: <path>" reference - Claude hands saved paths to its Read tool or other commands, never re-cats whole spilled files); exit-code meanings (0 = response received including non-2xx, 1 = fetch failed, 2 = usage). No pi references anywhere in the body (per the pi-gauntlet#11 roast: no dual-runtime prose).

### `.claude-plugin/marketplace.json` (new)

Inlined contract (final identifiers, not placeholders):

```json
{
  "name": "pi-quiver",
  "owner": { "name": "jjuraszek" },
  "plugins": [
    {
      "name": "quiver",
      "source": "./",
      "description": "Claude Code skills backed by the pi-quiver toolbox",
      "strict": false,
      "skills": ["./skills/fetch"]
    }
  ]
}
```

The plugin name `quiver` is the Claude Code namespace prefix: the skill surfaces as `quiver:fetch` (slash form `/quiver:fetch`), and every future skill added to this plugin inherits the same plain `quiver` prefix - the marketplace name `pi-quiver` never appears in invocations, only in the `enabledPlugins` key. `strict: false` because `source: "./"` has no `plugin.json`. The `skills` allowlist is the complete set - anything else under `skills/` (future drafts) does not load until listed; future CC-only skills are one-line appends. Consumer install, documented in README verbatim:

```json
{
  "extraKnownMarketplaces": {
    "pi-quiver": { "source": { "source": "github", "repo": "jjuraszek/pi-quiver" } }
  },
  "enabledPlugins": { "quiver@pi-quiver": true }
}
```

in `.claude/settings.json`, activated on folder trust.

**Portability check (concrete steps, gates listing a skill):** (1) SKILL.md body contains no pi tool/extension names and no pi-only paths; (2) the invocation works from a clean machine profile: packed tarball installed into a temp project, `npx`-style bin invocation succeeds; (3) one live Claude Code session with the marketplace added confirms the skill triggers on a matching request and the output contract reads correctly. A skill failing any step is fixed or left unlisted, never listed broken.

**Release sequencing:** the marketplace/README consumer instructions and the skill land on the default branch only in (or after) the same tagged release that publishes the `bin` to npm. Until that tag is on npm, `npx -y pi-quiver fetch` resolves a bin-less package and fails opaquely - so the git-served skill must not go live first.

## Request flow

**pi (unchanged):** model calls `fetch` tool -> adapter validates via TypeBox -> `fetchUrl(opts)` -> `{ output, details }` -> pi renders via existing TUI renderers.

**Claude Code:** Claude reads the skill (name + description always in context; body on use) -> runs `npx -y pi-quiver@latest fetch <url> [flags]` via Bash -> npx resolves the published package (cached per version after first use) -> bin maps argv to the same `FetchOptions` -> `fetchUrl(opts)` -> `output` on stdout -> Claude reads it as Bash output. The spill policy that protects pi's context protects Claude's identically, composing with Claude's own Bash truncation instead of fighting it. gh routing behaves identically: `gh` present and authenticated -> API-backed retrieval; otherwise plain HTTP (private repos then 404) - inherited behavior, not a new case.

## Error handling and edge cases

- **Exit codes:** 0 = response received (including HTTP 4xx/5xx and truncated bodies - matching pi tool behavior, which has no status check and treats caps as truncation, not error), 1 = fetch failed (thrown: bad protocol/URL, DNS, timeout/abort, binary write failure), 2 = usage error. Claude distinguishes by exit code like any CLI.
- **Cancellation:** `FetchOptions.signal` preserves pi's abort wiring (gh `execFile` + HTTP `AbortController`) unchanged; the CLI passes no signal (Ctrl-C/SIGTERM kills the process, which is sufficient).
- **No/unauthenticated `gh`:** HTTP fallback, identical to pi today.
- **Version skew:** the skill invokes `npx -y pi-quiver@latest`, accepting a per-run registry check to avoid npx's per-version cache silently pinning stale behavior.
- **Marketplace hygiene:** the portability check (see marketplace component) gates listing; a failing skill is fixed or left unlisted, never shipped listed.

## Out of scope

- `doc_to_md` CLI/skill exposure (pi-only for now).
- Deleting or replacing gridstrong's `skill:defuddle` - follow-up in that repo once this ships.
- MCP server or hook-based integration.
- Any change to pi-side fetch behavior or rendering.
- Windows CLI testing beyond existing CI coverage (test workflow runs ubuntu + windows; core, CLI, and packed-install tests run on both).

## Testing

- **Existing tests pass with shape-only updates** - the extraction moves code; imports in `test/fetch.test.ts` update to `lib/fetch-core.ts` (pure helpers like `classifyGitHubTarget` - covering issue/PR/repo/Actions-run targets - and `buildGhArgs` are already exported and tested), and the two gh-routing assertions reading `.content[0].text` switch to `.output` (identical text).
- **New extraction-regression tests:** the current suite never exercises the registered tool's full `execute` contract, so "tests pass" alone would not catch envelope/signal/exit regressions. Add cases around `fetchUrl` for: HEAD, HTTP 404/500 (exit-0-equivalent result text `HTTP <status>...`), spill path, truncated 1MB body, abort via `signal` on both the gh and HTTP paths, and byte-identical `formatSize` output vs pi's.
- **New `test/fetch-cli.test.ts`:** argv-parsing units (flag -> `FetchOptions` mapping incl. `--header` split/duplicate/malformed rules, exit-2 cases, timeout validation; a no-`--header` github.com issue URL still plans gh routing) plus a subprocess smoke test against an in-process `http` server fixture (no live network), asserting stdout + exit codes for success, 404, and truncation.
- **Packed-install test (CI, not manual):** `npm pack`, install the tarball into a temp project, invoke the installed bin via `node_modules/.bin/pi-quiver` - this is the only test shape that would have caught the `node_modules` type-stripping failure, and it validates the shebang + `dist/` packaging on ubuntu and windows.
- **`test/layout.test.ts` additions:** `package.json` `files` includes `dist/` and excludes `skills/`, `.claude-plugin/`, and `bin/` sources; `pi.extensions` still lists only `./extensions`; `lib/fetch-core.ts` imports no `@earendil-works/*`; `.claude-plugin/marketplace.json` parses and every allowlisted skill path exists and contains a SKILL.md.
- **Manual pre-release smoke:** one live Claude Code session with the marketplace added, confirming the skill triggers and output is read correctly (portability check step 3).

## Documentation impact
- Feature / user-facing docs introduced: `skills/fetch/SKILL.md` (Claude-facing usage doc); README "Claude Code support" section (consumer snippet, exposed skills, what is NOT exposed)
- Materially amended existing docs: `README.md` (fetch section gains CLI invocation), `doc/fetch.md` (adapter/CLI split, dist-built bin note), `CHANGELOG.md`
- Derived / memory docs invalidated: `AGENTS.md` Layout + Publishability + Workflow sections (new `bin/`, `dist/` prepack build, `lib/fetch-core.ts`, `skills/`, `.claude-plugin/`; `files` allowlist change; release flow gains the prepack step implicitly via `npm pack`)

## Open questions

- None blocking. The gridstrong follow-up (retire `skill:defuddle`, update its `doc/skills-and-prompts.md` which currently describes defuddle inconsistently as both vendored and npm-installed) is recorded here as a cross-repo note, not part of this change.
