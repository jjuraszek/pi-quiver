# slack: user-level `.env` token rung with fall-through ladder

**Ticket:** #22 (split from #20)
**Goal:** Let a developer keep a personal `SLACK_USER_TOKEN` (or `SLACK_BOT_TOKEN`) in one fixed per-user file outside any repo, resolved after the process env and repo `.env` files, with every rung falling through when the key is absent.

Supersedes [doc/specs/2026-08-29-gh-7-slack-extension.md](./2026-08-29-gh-7-slack-extension.md), `### Tokens` section only (the two-rung ladder and its stop rule).

## Problem

Token lookup today (`lib/slack-core.ts` `resolveToken`) is: process env -> `<repoRoot>/.env` -> primary-checkout `.env` (only when the worktree has no `.env` at all) -> `missing_token`. Two consequences:

1. A personal user token must be copied into every repo's `.env`, or exported in every shell.
2. A repo `.env` holding only the team `SLACK_BOT_TOKEN` blocks the search: `SLACK_USER_TOKEN` is never looked for anywhere else, even though the file simply does not mention it.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Add a fourth rung: a fixed per-user `.env` file (paths in "User config path"). | Issue #22 acceptance criterion. |
| D2 | **Fall-through semantics** at every rung: a file that exists but lacks the key (or has it empty) is skipped, and the next rung is checked. Error only when the key is absent from every rung. | User decision; replaces today's "repo `.env` exists -> stop" rule. Deviates from the issue's literal "repo `.env` without the key falls through to the user file but skips primary checkout" wording; the user chose the simpler uniform rule. Motivating case: team bot token in repo `.env`, personal user token in the user file. |
| D3 | Home/config directory derived **only** from the `env` record passed to `resolveToken` (`XDG_CONFIG_HOME`, `HOME`, `APPDATA`). `os.homedir()` is never called. | Test isolation: existing tests pass `env: {}` and must never read the developer's real `~/.config/pi-quiver/.env`. |
| D4 | Platform is an optional trailing parameter defaulting to `process.platform`; tests pass it explicitly instead of stubbing the global. | Same coverage as the issue's "stubbed `process.platform`", no global mutation. |
| D5 | Non-ENOENT read errors (EACCES, EISDIR, ...) at any rung **propagate out of `resolveToken`** as the raw `NodeJS.ErrnoException`. Only ENOENT falls through. **This is a caller-visible change**: today `readEnvFile` rethrows but `resolveToken` (`lib/slack-core.ts:217-243`) catches at both file rungs - an unreadable repo `.env` becomes `missing_token`, an unreadable primary `.env` is silently ignored. Both catches are removed. `formatToolError` passes non-`SlackError` errors through unwrapped, so tool output becomes Node's `EACCES: permission denied, open '<path>'`; `pickCacheRefreshIdentity` rethrows it out of `slack_cache_refresh`. | User decision: a file you placed but cannot read is a misconfiguration to surface, not to skip. Raw error keeps the path visible without a new error code. |
| D6 | The same configured key name (`cfg.userTokenEnv` / `cfg.botTokenEnv`, default `SLACK_USER_TOKEN` / `SLACK_BOT_TOKEN`, remappable via `quiver.slack.*TokenEnv` or `PI_QUIVER_SLACK_*_TOKEN_ENV`) is looked up at every rung, including the user file. | Issue requirement ("or the remapped names"); one name per concept. |
| D7 | No new setting, no `PI_QUIVER_*` override for the user file path. | Issue explicitly defers `quiver.slack.envFile`; `XDG_CONFIG_HOME` already relocates the file. |
| D8 | Token values never live in `settings.json`; the `userTokenCommand` bypass in `resolveCredential` is unchanged. `resolveCredential` gains the same optional trailing `platform` parameter and forwards it to `resolveToken`. | Existing contract (gh-7 spec, `doc/slack.md`); tests call `resolveCredential` directly and need the same seam. |
| D9 | `repoRoot` is expected to be `discoverRepoRoot` output (already realpath'd). Git-based test fixtures pass `realpathSync(dir)` as `repoRoot`. | On macOS `mkdtempSync` yields `/var/folders/...` while `git rev-parse --git-common-dir` returns `/private/var/...`; string dedupe of candidates would otherwise list the same file twice in the error message. |

## Design

All changes live in `lib/slack-core.ts`; `extensions/slack.ts` callers are untouched.

### `userConfigEnvPath(env, platform = process.platform): string | undefined`

Exported, pure.

| platform | base | result |
|---|---|---|
| `win32` | `env.APPDATA` | `<APPDATA>/pi-quiver/.env` |
| `win32` | `APPDATA` unset | `undefined` (rung skipped; `XDG_CONFIG_HOME` ignored on Windows) |
| other | `env.XDG_CONFIG_HOME` set | `<XDG_CONFIG_HOME>/pi-quiver/.env` |
| other | else `env.HOME` set | `<HOME>/.config/pi-quiver/.env` |
| other | neither set | `undefined` (rung skipped) |

Empty-string values count as unset. Paths are joined with the host `node:path` `join` (not selected by `platform`); tests build expected paths with the same `join`, never literal separators.

### `resolveToken(identity, cfg, env, repoRoot, platform = process.platform)`

1. `envVar = identity === "user" ? cfg.userTokenEnv : cfg.botTokenEnv`; if `env[envVar]` is non-empty, return it.
2. Build the ordered candidate list:
   - `join(repoRoot, ".env")`
   - `const primaryRoot = primaryCheckoutRoot(repoRoot)`; push `join(primaryRoot, ".env")` only when `primaryRoot !== undefined && primaryRoot !== repoRoot` (`primaryCheckoutRoot` returns `undefined` outside a git repo, and `join(undefined, ...)` throws - the guard must precede the join, exactly as today's code does)
   - `userConfigEnvPath(env, platform)` when defined
3. For each candidate: `const parsed = readEnvFile(path)` (ENOENT -> `undefined` -> skip; any other error propagates per D5); `const value = parsed?.get(envVar)`; return `value` when non-empty; otherwise continue. No try/catch around the loop.
4. Throw `SlackError("missing_token", "No Slack <identity> token: env var <VAR> is empty and no entry found in <p1>, <p2>[, <p3>].")` where the list is exactly the candidate paths from step 2 (paths are listed whether or not the file existed). Never include token values.

`readEnvFile(path)` takes a file path rather than a directory so the loop can pass each candidate directly; it still parses once and returns `Map<string, string> | undefined`, with ENOENT -> `undefined` and every other error rethrown. Its two comments about "present-but-empty" blocking the primary fallback are deleted with the old branching. `parseEnvFile` (optional `export `, exact `KEY=`, one surrounding quote pair stripped, inline `#` kept, last match wins) is reused as-is for the user file - the file is never shell-sourced.

### Precedence examples

Resolving the **user** token, `SLACK_USER_TOKEN` not exported:

| repo `.env` | primary `.env` | user file | result |
|---|---|---|---|
| has key | has key | has key | repo value |
| only `SLACK_BOT_TOKEN` | absent | has key | user-file value |
| absent | has key | has key | primary value |
| only `SLACK_BOT_TOKEN` | has key | has key | primary value |
| `SLACK_USER_TOKEN=` (empty) | absent | has key | user-file value |
| absent | absent (non-worktree) | absent, `HOME` unset | `missing_token` listing the repo path only |
| absent | absent (linked worktree) | absent | `missing_token` listing repo, primary, and user paths |
| unreadable (EACCES) | any | any | raw `EACCES` error propagates |
| absent | unreadable (EACCES) | has key | raw `EACCES` error propagates - an unreadable primary `.env` in a linked worktree blocks the user rung (accepted consequence of D5) |
| absent | absent | unreadable (EACCES) | raw `EACCES` error propagates |

## Edge cases

- `primaryCheckoutRoot(repoRoot) === repoRoot` (not a linked worktree): one repo candidate, no duplicate read.
- Linux/macOS: rung skipped only when both `XDG_CONFIG_HOME` and `HOME` are unset or empty; Windows: rung skipped when `APPDATA` is unset or empty; error message lists only the paths actually tried.
- `XDG_CONFIG_HOME` on macOS: honored (same rule as Linux - the issue's "Linux and macOS" clause).
- User file present but contains only the other identity's key: falls through, `missing_token` names it among the checked paths.
- Slack extension disabled: no token resolution runs (registration gate unchanged), so the user file is never read.
- `pickCacheRefreshIdentity` in `extensions/slack.ts` probes the ladder and therefore also sees the user rung - intended.

## Testing

`test/slack-config.test.ts`, temp dirs via `mkdtempSync`, cleanup in `finally`, matching existing fixtures.

- `userConfigEnvPath`: `linux` + `XDG_CONFIG_HOME`; `linux` + `HOME` only; `darwin` + `HOME` only; `win32` + `APPDATA`; `win32` without `APPDATA` -> `undefined`; `linux` with neither -> `undefined`; empty-string base treated as unset.
- Every `resolveToken`/`resolveCredential` case that depends on the user rung passes `platform` explicitly together with its matching base variable (`"linux"` + `HOME` or `XDG_CONFIG_HOME`; `"win32"` + `APPDATA`). CI runs on `ubuntu-latest` and `windows-latest`; a fake `HOME` with the default platform is skipped on Windows.
- Fall-through: repo `.env` with only `SLACK_BOT_TOKEN`, fake `HOME/.config/pi-quiver/.env` with `SLACK_USER_TOKEN` -> user token from user file, bot token from repo.
- Precedence: same key in repo `.env` and user file -> repo wins; `env[envVar]` set -> beats all files.
- Non-git `repoRoot` (plain `mkdtempSync` dir): resolves from the user file; missing everywhere lists the repo and user paths only (no `join(undefined)` crash).
- Worktree fixture (existing git-based fixture pattern, `repoRoot = realpathSync(dir)` per D9): worktree without `.env` -> primary value; worktree `.env` lacking the key -> primary value when primary has it, user value when it does not.
- Remapped key name (`cfg.userTokenEnv = "MY_TOKEN"`) honored in the user file.
- Empty value in user file -> `missing_token`.
- Missing everywhere: `missing_token`, message names every candidate path and contains no token-like value; existing assertion at `test/slack-config.test.ts:222-238` updated for the new message.
- Unreadable files (chmod 000; skipped on Windows and as root, following the existing permission-test pattern): repo `.env`, primary `.env` (linked worktree), and user file each propagate the raw `EACCES` error - `assert.rejects`/`throws` on `err.code === "EACCES"`, not on `SlackError`.
- Existing tests that encode the superseded contract are rewritten, not kept green by re-adding the catch:
  - `test/slack-config.test.ts:372-405` "local `.env` exists but is unreadable ... (missing_token)" -> expects raw `EACCES`.
  - `:408-440` "primary checkout `.env` unreadable: falls through to missing_token" -> expects raw `EACCES`.
  - `:443-465` "worktree's own `.env` fully shadows the primary checkout's `.env`" -> deleted; replaced by the D2 worktree case above.
- Existing resolver unit tests keep `env: {}` and stay isolated: no `HOME` means no user rung.
- Extension execution tests (`test/slack-config.test.ts` from `:590` onward, e.g. `:998`, `:1044`) pass `process.env` into `extensions/slack.ts`, which inherits the developer's real `HOME`/`XDG_CONFIG_HOME`/`APPDATA`. Each such test sets those three variables to a controlled temp dir (or deletes them) in its fixture and restores them in `finally`, alongside the existing `PI_CODING_AGENT_DIR` save/restore pattern, so a real `~/.config/pi-quiver/.env` can never leak a token into an assertion diff.

Verification command: `env -u PI_CODING_AGENT_DIR npm run test:all`.

## Documentation impact

Materiality bar: `reference/documentation-impact.md` (brainstorming skill).

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/slack.md` (token section: four-rung ladder, fall-through rule, per-OS user-file paths, unreadable-file behavior, error message shape - operations/tunable parameters; the sentence at `doc/slack.md:66-67` "if a worktree *does* have a `.env`, it fully shadows the primary one even if it lacks the needed key" is deleted); `README.md` Slack token sentence (one line naming the user-level file, linking `doc/slack.md`); `CHANGELOG.md` (create `## Unreleased`, one bullet ending `(#22)` per the repo's GitHub ref convention)
- Derived / memory docs invalidated: `doc/specs/2026-08-29-gh-7-slack-extension.md` gains a supersession banner scoped to `### Tokens`; `AGENTS.md` unchanged (its slack row already routes to `doc/slack.md`)

## Out of scope

- Configurable env-file path (`quiver.slack.envFile`) - deferred by the issue.
- Arbitrary/team secret locations.
- DM support (#20) and Block Kit rendering (#21).
- Changing `parseEnvFile` semantics or adding a dotenv dependency.

## Open questions

- Issue #22's acceptance criterion says the CHANGELOG bullet references `#20`; this spec references `#22` (the implementing issue) per the repo convention. Confirm at the gate if `#20` was intended.
