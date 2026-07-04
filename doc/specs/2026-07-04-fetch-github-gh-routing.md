# Spec: fetch auto-routes GitHub issue/PR/repo URLs through `gh`

- **Date:** 2026-07-04
- **Package:** pi-quiver (`fetch.ts`)
- **Branch / worktree:** `fetch-gh-routing` @ `.worktrees/fetch-gh-routing`
- **Issue:** #1
- **Status:** awaiting user review

## 1. Problem

When the user pastes a GitHub URL and asks to read it, the agent frequently
calls `fetch` instead of `gh`. Grounded in this machine's pi session history
(`~/.pi/agent*/sessions/*.jsonl`): **7 distinct sessions** across multiple repos
(`pi-gauntlet`, `pi-context-prune`, `pi-subagents`, `gridstrong`) issued a
`fetch` tool call whose `url` was a `github.com/{owner}/{repo}/(issues|pull)/{n}`
link. Concrete case (pi-gauntlet #1): `fetch {"url":".../issues/1"}` pulled
**~252 KB of HTML** to be readability-parsed for content that
`gh issue view` returns in a few structured lines.

Consequences of the `fetch` path on these URLs:

- **Bloat.** Hundreds of KB of rendered HTML (nav, comment chrome, reaction
  widgets) for what `gh` returns as a compact issue body + threaded comments.
- **Private-repo failure.** A public issue happens to parse; a private one
  returns a GitHub login wall, so `fetch` yields useless HTML while an
  authenticated `gh` would succeed.
- **Weaker structure.** `gh` emits clean title / state / labels / author /
  comment attribution; readability-of-HTML loses most of that.

The ticket (#1) originally weighed a prose nudge vs. a hard block. A ticket-comment
roast argued for the nudge and against the block. Neither mechanism is what this
spec adopts: the roast's kills targeted a *block that nags and forces a retry*
and a *classifier covering GitHub's whole URL taxonomy*. This spec instead does
**transparent auto-routing** inside the `fetch` tool - a third mechanism the
roast did not weigh - which sidesteps those kills (see §10).

## 2. Goals / Non-Goals

### Goals

- Inside the `fetch` tool, detect a **narrow allowlist** of GitHub URL shapes
  and serve them by running `gh` and returning its output as the tool result,
  transparently (the model asked for the URL's content; it gets that content,
  sourced from `gh`).
- Cover exactly three shapes:
  - **Issue:** `github.com/{owner}/{repo}/issues/{n}` -> `gh issue view <url> --comments`
  - **PR:** `github.com/{owner}/{repo}/pull/{n}` -> `gh pr view <url> --comments`
  - **Repo root:** `github.com/{owner}/{repo}` (optional trailing slash only) -> `gh repo view <owner>/<repo>`
- **Degrade gracefully:** if `gh` is absent, unauthenticated, or exits non-zero,
  fall through to the existing HTTP `fetch` path. The feature is a best-effort
  upgrade, never a hard failure.
- **Escape hatch:** `raw=true` bypasses routing entirely and performs the normal
  HTTP fetch, so a caller who wants the rendered HTML can still get it.
- Route `gh` output through the **existing size gate / spill machinery** so a
  large `--comments` thread spills to a file with a preview, exactly like any
  other large fetch result.

### Non-Goals (explicit)

- **No other GitHub URL shapes.** `tree`, `blob`, `raw`, `releases`, `commit`,
  `compare`, `actions`, `wiki`, `discussions`, `gist.github.com`,
  `raw.githubusercontent.com`, `codeload` - all fall through to HTTP `fetch`
  untouched. Non-matches are the default path; we do not enumerate them.
- **No GitHub Enterprise.** Host must be `github.com` (or `www.github.com`).
  Self-hosted `github.example.com` falls through to HTTP.
- **No config surface.** No settings key, no OFF switch. This is `fetch` doing
  its one job (retrieve a URL's content) via the best available method - an
  internal implementation detail, not a policy surface.
- **No nudge, no block, no prompt-guideline enforcement mechanism.** No agent
  retry, no wasted turn, no nagging.
- **`gh` is not a hard runtime dependency.** It is documented as an assumed
  tool for this pack (see §7), but its absence degrades to HTTP, never errors.
- **No PR diff / review-thread expansion.** `gh pr view --comments` returns the
  conversation; the file diff and inline review comments are out of scope.

## 3. Dependencies

**None added.** `gh` is invoked as an external binary via `node:child_process`
`execFile` (already available in the Node runtime). No npm dependency, no change
to `package.json` `dependencies` or the `files` allowlist.

`gh` itself is an optional system binary, treated exactly like `uv` / `soffice`
in `doc_to_md`: present -> used; absent -> graceful degradation.

## 4. Architecture

Two pure, unit-testable helpers plus one impure runner, wired into the existing
`execute` before the HTTP path.

### 4.1 Pure classifier: `classifyGitHubTarget(url: URL): GhTarget | null`

```ts
type GhTarget =
  | { kind: "issue"; url: string }   // canonical https URL, query+fragment stripped
  | { kind: "pr"; url: string }
  | { kind: "repo"; slug: string };  // "owner/repo"
```

Rules (return `null` on any miss -> caller uses HTTP):

1. Host must be exactly `github.com` or `www.github.com`. Else `null`.
2. Split the pathname into non-empty segments.
3. `owner` and `repo` must each match `^[A-Za-z0-9._-]+$` (GitHub's own charset;
   also hardens the args passed to `execFile`).
4. Reject reserved owners uniformly: if `owner` (lowercased) is in
   `RESERVED_OWNERS`, return `null` for ALL shapes (not just repo-root). A
   reserved segment like `orgs` can never own a real repo/issue/PR, so
   `github.com/orgs/foo/issues/5` is not routed. This is applied before the
   shape dispatch.
5. Match by segment shape:
   - `[owner, repo, "issues", n]` where `n` matches `^\d+$` -> `{ kind: "issue", url: canonical }`.
   - `[owner, repo, "pull", n]` where `n` matches `^\d+$` -> `{ kind: "pr", url: canonical }`.
   - `[owner, repo]` **exactly** (no third segment; a lone trailing slash is
     allowed and ignored) -> `{ kind: "repo", slug: "owner/repo" }`.
   - Anything else -> `null`.
6. `canonical` for issue/pr is rebuilt as
   `https://github.com/{owner}/{repo}/{issues|pull}/{n}` - query string and
   `#fragment` (e.g. `#issuecomment-123`) are **dropped** so `gh` gets a clean URL.

`RESERVED_OWNERS` (the single source for reserved-owner rejection, applied to all shapes):
common GitHub reserved first-path segments that also take a two-segment shape -
`orgs`, `users`, `sponsors`, `topics`, `marketplace`, `apps`, `collections`,
`stars`, `settings`, `notifications`, `codespaces`, `features`, `trending`,
`security`, `customer-stories`. A repo-root URL whose first segment is one of
these (e.g. `github.com/orgs/foo`, `github.com/trending/rust`) is **not**
routed. The denylist is **non-exhaustive by design**: a missed reserved segment
costs exactly one failed `gh repo view` call before the safe HTTP fallback
(§4.3) takes over, so the list is a wasted-call/mis-route optimization, not a
correctness guard. Single-segment reserved pages (`/features` alone,
`/pricing`, a bare `/{user}` profile) already fail the "exactly two segments"
test and never reach the denylist.

### 4.2 Pure command builder: `buildGhArgs(target: GhTarget): string[]`

```
issue -> ["issue", "view", target.url, "--comments"]
pr    -> ["pr",    "view", target.url, "--comments"]
repo  -> ["repo",  "view", target.slug]
```

Args are passed as an array to `execFile` (no shell), so no injection surface;
the `[A-Za-z0-9._-]+` / `\d+` charset restriction in §4.1 is defense in depth.

### 4.3 Impure runner: `runGh(args, timeoutMs, signal)`

- `execFile("gh", args, { timeout: timeoutMs, signal, maxBuffer: GH_MAX_BUFFER })`,
  capture stdout. New constant `GH_MAX_BUFFER = 10_000_000` (10 MB) - an order of
  magnitude above `PARSABLE_MAX_BYTES` (1 MB, confirmed in `fetch.ts`), so a
  realistic `--comments` thread never overflows. `timeoutMs` is the **resolved**
  value the caller computes as `params.timeoutMs ?? DEFAULT_TIMEOUT_MS` (20 s),
  matching the HTTP path (`fetch.ts` already resolves the same default).
- **Success** (exit 0, non-empty stdout) -> return `{ ok: true, stdout }`.
- **Failure** - binary missing (`ENOENT`), non-zero exit (unauth, no access,
  not found), timeout, `maxBuffer` overflow, or empty stdout -> return
  `{ ok: false }`. The caller then runs the normal HTTP path. No error is
  surfaced to the model for a routing miss; the fall-through is silent.
- **Empty stdout note.** `gh issue view` / `gh pr view` / `gh repo view` always
  emit a structural header (title / state / labels, or repo about + README) for
  any resource that exists, so exit-0-with-empty-stdout does not occur for valid
  content; treating empty stdout as failure is therefore safe (an empty result
  can only mean a degenerate/error case, which the HTTP path handles).
- **Injectable seam.** `runGh` is passed into the routing executor as a
  parameter (default: the real `execFile` implementation) so tests can supply a
  fake runner and exercise the success / fallback branches without a `gh`
  binary (see §9).

### 4.4 Wiring in `execute`

The routing decision is factored into an **exported pure** predicate so it is
unit-testable (§9):

```ts
// pure: no I/O; folds the bypass gate and the URL classifier.
export function planGhRouting(params, url: URL): GhTarget | null {
  const noHeaders = !params.headers || Object.keys(params.headers).length === 0;
  if (params.raw) return null;                      // escape hatch -> HTTP
  if ((params.method ?? "GET") !== "GET") return null;
  if (params.body) return null;
  if (!noHeaders) return null;                      // custom headers -> HTTP
  return classifyGitHubTarget(url);
}
```

After `new URL(params.url)` + protocol validation, before header/HTTP setup:

```
const target = planGhRouting(params, url);
if (target) {
  const resolvedTimeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const r = await runGh(buildGhArgs(target), resolvedTimeout, signal);
  if (r.ok) return renderGhResult(target, r.stdout);   // gate + spill, see §6
  // else: fall through to HTTP
}
// ... existing HTTP path unchanged ...
```

Routing is skipped when `raw=true` (escape hatch), when `method` is not `GET`,
when a `body` is present, or when **custom `headers` are supplied** - each
signals an HTTP-specific intent (rendered page, custom `Authorization` /
`Accept` / UA) that the `gh` read cannot honor. `params.headers` is an active
fetch parameter (it feeds UA/Accept on the HTTP path), so silently dropping
caller headers on the `gh` path would change semantics; skipping routing
instead preserves them.

**Timeout budget.** `gh` gets the full resolved `timeoutMs`; on `gh` timeout
the HTTP fallback then starts with its own fresh resolved budget, so a
pathological hung `gh` can push worst-case wall time toward ~2x (40 s at the
20 s default). Accepted: `gh <resource> view` is normally sub-second, the
timeout is a hard ceiling for a rare hang (network to the GitHub API), not the
typical path. A shorter fixed `gh` sub-budget was considered and rejected as
premature complexity.

## 5. Data / request flow

```
1. Parse + validate URL (http/https), as today.
2. planGhRouting(params, url): raw=false AND method=GET AND no body AND no
   custom headers AND classifyGitHubTarget(url) matches?
   a. target && gh runnable:
        run `gh <args>` (resolved timeout, abort-wired).
        exit 0 + non-empty stdout -> gate gh stdout (§6) and RETURN.
        else (miss / overflow / timeout / non-zero) -> fall through.
3. Existing HTTP fetch path (headers, stream, classify, gate) - unchanged.
```

## 6. Output shape

`gh` stdout is treated as **markdown-category text** and run through the
existing `applyGate` / spill-to-file machinery, so behavior matches a normal
fetch result:

- **Inline** (<= 32 KB and <= 1000 lines): header + body.
- **Spilled** (over gate): `.md` file + `Saved-To:` + grep/read-slice hint + 60-line preview.

The header identifies the source so the routing is not invisible:

```
Source: gh issue view <url> --comments
```

(`gh pr view ... --comments` / `gh repo view <slug>` respectively.)

`renderGhResult(target, stdout)` builds the tool result: run `applyGate(stdout)`;
prepend a `Source:` header line naming the exact command; inline the body when
under the gate, else spill to a `.md` file with the standard `Saved-To:` +
grep/read-slice hint + 60-line preview (identical to the HTTP spill path).

`FetchToolDetails` gains two optional fields (added to the existing interface in
`fetch.ts`, all current fields kept):

```ts
interface FetchToolDetails {
  url?: string;
  status?: number;         // HTTP path only; UNSET on gh path
  contentType?: string;    // HTTP path only; UNSET on gh path
  charset?: string;        // HTTP path only; UNSET on gh path
  bytes?: number;
  truncated?: boolean;
  category?: "binary" | "markdown" | "json" | "text";
  spilled?: boolean;
  file?: string;
  lines?: number;
  via?: "gh";              // NEW: set only on the gh path
  ghCommand?: string;      // NEW: e.g. "issue view --comments" (renderResult chip)
}
```

Exact `details` on a gh result: `{ via: "gh", ghCommand, url: <canonical URL or
slug>, bytes: <stdout byte length>, lines: <count>, category: "markdown",
spilled: <bool>, file?: <path when spilled> }`. `status`, `contentType`, and
`charset` are left **unset** (there is no HTTP response).

`renderCall` is unchanged (still shows the URL the user passed). `renderResult`
needs a new branch: today `status === undefined` renders `"HTTP ?"`, so the gh
path must be handled explicitly - when `details.via === "gh"`, render a `gh`
status token plus a `ghCommand` chip (e.g. `gh · issue view --comments`) in place
of the `HTTP <n>` / content-type portion, keeping the existing size / `→ file`
chips.

## 7. Tool surface & docs

- **Parameters unchanged.** `raw`, `method`, `body`, `timeoutMs` keep their
  meaning; `raw=true` is now also the documented bypass for gh routing.
- **`description`** gains one clause: GitHub issue/PR/repo URLs are served via
  `gh` when available (falls back to HTTP otherwise).
- **`promptGuidelines`** gains one line: GitHub issue/PR/repo links are fetched
  through `gh` automatically; pass `raw=true` to force the rendered HTML page.
- **README** documents `gh` as an assumed-present tool for this pack (installed
  and authenticated) while stating the feature degrades to HTTP if it is not -
  reconciling "require gh" (documented expectation) with "never hard-fail"
  (defensive fallback).
- **README gains a consolidated `## Prerequisites` section.** Today the pack's
  end-user system-binary requirements are scattered (buried in the `doc_to_md`
  prose: `uv` + Python 3.14, `soffice`) or absent (`gh` is new). This spec adds
  a single section near the top (before or just after `## Extensions`) that
  lists every optional end-user prerequisite and its degradation-on-absence, so
  a reader sees the full picture in one place:

  | Prerequisite | Needed by | If absent |
  |---|---|---|
  | `gh` (GitHub CLI, installed + `gh auth login`) | `fetch` GitHub issue/PR/repo routing | Falls back to HTTP fetch of the rendered page (private repos hit a login wall). |
  | `uv` (+ managed Python 3.14, fetched on first use) | `doc_to_md` high-fidelity PDF | Degrades to the pure-JS `unpdf` fallback (no faithful tables/headings). |
  | LibreOffice (`soffice` on `PATH`) | `doc_to_md` DOCX/PPTX | Office inputs error (no JS fallback for office->PDF); PDFs unaffected. |

  The section states none is a hard install-time dependency of the npm package
  (bundled npm deps install automatically); these are runtime **system**
  binaries the user provides. The scattered per-extension mentions stay but
  point at this section as the single source.

## 8. Error handling & edge cases

| Case | Behavior |
|---|---|
| `gh` not installed (`ENOENT`) | Silent fall-through to HTTP fetch. |
| `gh` present but unauthenticated / no repo access | Non-zero exit -> fall-through to HTTP. |
| Issue/PR number nonexistent | `gh` exit non-zero -> fall-through to HTTP. |
| Repo-root slug is a reserved namespace (`orgs/x`) | Not routed (denylist) -> HTTP. |
| Repo-root slug looks valid but is not a repo | `gh repo view` non-zero -> fall-through to HTTP. |
| URL has `#issuecomment-...` / `?query` | Fragment + query stripped; canonical URL passed to `gh`. |
| `raw=true` | Routing skipped; HTTP path (rendered HTML), as documented. |
| `method` != GET, or `body` present | Routing skipped; HTTP path. |
| Host `www.github.com` | Treated as `github.com`. |
| GitHub Enterprise host | Not matched -> HTTP. |
| `gh` stdout empty on exit 0 | Cannot occur for a valid resource (gh always emits a header); if seen, treated as failure -> HTTP (§4.3). |
| `gh` times out | Aborted at resolved `timeoutMs`; failure -> HTTP fallback with its own fresh budget (worst-case ~2x wall time, §4.4). |
| `gh` stdout > `GH_MAX_BUFFER` (10 MB) | `execFile` overflow -> failure -> HTTP fallback (then gated/spilled). Far above realistic thread size. |
| Custom `headers` supplied | Routing skipped; HTTP path (headers honored, §4.4). |
| Large `--comments` thread (<= 10 MB) | Routed through existing size gate -> spills to `.md` with preview. |

## 9. Testing approach

- **Unit (no network, no `gh`):** `node --test`, importing the new pure helpers.
  - `classifyGitHubTarget`: issue, pr, repo-root, trailing slash, fragment +
    query stripping, `www.` host, non-github host, Enterprise host, each
    reserved owner, three-segment paths (`tree`/`blob`/`releases`) -> `null`,
    bad owner/repo charset -> `null`, non-numeric issue number -> `null`.
  - `buildGhArgs`: the three shapes map to the exact arg arrays in §4.2.
  - `planGhRouting` (the exported gate predicate, §4.4): routes a matching issue
    URL; returns `null` for `raw=true`, non-GET method, a present `body`, and
    non-empty `headers` (each bypass path covered) - this is the core routing
    decision and must be unit-tested since CI has no `gh`.
- **Runner seam:** `runGh` is passed into the routing executor as an injectable
  parameter (§4.3). Unit tests supply a **fake runner** to cover the two
  branches the real `gh` would otherwise gate behind a binary: (a) success ->
  `renderGhResult` output with `via: "gh"` details and gate/spill behavior;
  (b) failure (`{ ok: false }`) -> HTTP fallback is taken. The real `execFile`
  spawn itself is exercised only by the manual smoke test (no `gh` in CI), but
  the routing decision and success/fallback wiring are fully unit-covered.
- **Manual smoke:**
  - `pi -e ./fetch.ts -p "fetch https://github.com/jjuraszek/pi-quiver/issues/1"`
    -> `Source: gh issue view ...`, structured issue + comments.
  - A bare repo URL `.../pi-quiver` -> `gh repo view` (README).
  - `raw=true` on an issue URL -> rendered HTML path.
  - With `gh` uninstalled / logged out -> silent HTTP fallback.
- **Typecheck:** `npm run test:all` (existing `node --test *.test.ts` + `tsc --noEmit`).

## 10. Why auto-routing (roast reconciliation)

The #1 roast's kills applied to a *nagging block* and a *full-taxonomy
classifier*. Auto-routing defuses them:

- **UX / recovery kill** -> gone: no retry, no wasted turn; the result is the
  content the model asked for.
- **"gh not guaranteed" kill** -> gone: graceful HTTP fallback makes `gh` a
  best-effort upgrade, not a dependency.
- **Classifier scope-explosion shrink** -> collapses to a 3-shape allowlist;
  everything else is the default HTTP path, so the taxonomy is never enumerated.
- **Wrong-layer kill** -> reframed: this is `fetch`'s own retrieval logic, not a
  config/policy surface bolted onto the agent.

What genuinely survives: it is a **silent behavior change** for a caller who
wanted an issue URL's rendered HTML. Mitigated by (a) the `Source: gh ...`
header making the source explicit and (b) `raw=true` as the documented bypass.

### Supersedes issue #1's acceptance criteria

Issue #1 was filed as a *prompt-guideline nudge* and its acceptance criteria
explicitly ruled out this spec's mechanism: "One guideline line added to
`promptGuidelines`... No block, no config key, **no URL parsing code**... No
CHANGELOG/README change required." This spec **deliberately supersedes** those
AC. Rationale: the user rejected the ticket-comment roast that produced the
nudge-only conclusion, grounded the actual behavior in session history (§1: 7
sessions, real `fetch`-on-GitHub-URL calls), and chose transparent auto-routing
- a mechanism the ticket's roast never weighed. Consequently this spec **does**
add a narrow URL classifier (§4.1, not the "fractal" the ticket feared - a
3-shape allowlist with safe fallback), **is** a behavior change, and therefore
**does** touch README/CHANGELOG (§11). §2 Goals are the governing scope; the
ticket's AC are historical context, not constraints.

## 11. Documentation impact

Materiality bar per the pi-gauntlet brainstorming reference
`reference/documentation-impact.md` (author-side reference; **non-normative** for
the implementer - not shipped with this repo).

- Feature / user-facing docs introduced: none (no new standalone doc; the fetch
  behavior is owned by the existing README fetch section, and the prerequisites
  live in a new README section, not a separate file).
- Materially amended existing docs:
  - `README.md` - (a) fetch section: gh auto-routing, `raw=true` bypass,
    graceful fallback; (b) **new `## Prerequisites` section** (§7) consolidating
    `gh`, `uv`+Python 3.14, and `soffice` with per-tool need + degradation, with
    the scattered per-extension mentions pointing at it as the single source.
  - `CHANGELOG.md` - new minor entry (behavior change, no new npm deps).
  - `AGENTS.md` - fetch one-liner extended to mention gh routing.
- Derived / memory docs invalidated: none.

## 12. Open questions

None. Scope (3 shapes), fallback behavior, `raw` bypass, reserved-owner
denylist, and output gating are all decided above.
