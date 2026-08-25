# fetch: GitHub Actions job URL routing + failed-step logs

## Problem

Fetching a GitHub Actions **job** URL (`https://github.com/<owner>/<repo>/actions/runs/<runId>/job/<jobId>`) returns HTTP 404 on private repos: `classifyGitHubTarget` matches only the exact 5-segment run path (`lib/fetch-core.ts:80`), so the 7-segment job URL falls through to anonymous HTTP, which hits GitHub's auth-masking 404. Verified live: `gh run view --job 97707339063 --repo gridstrong/gridstrong` succeeds while the fetch tool 404s on the same URL. The gap is documented current behavior (`CHANGELOG.md:68`, non-match fixture at `test/fetch.test.ts:183`), not a regression.

Additionally, fetching a run or job is nearly always failure debugging, and today's summary-only output forces a second manual step (`gh run view --log-failed ...`) to see why it failed. One fetch must be enough to explore a failed action.

## Decisions (user-ratified)

1. Job URLs route through gh: summary **plus failed-step logs** in one fetch.
2. Run URLs (`/actions/runs/<id>`) **also** gain failed-step logs — same rationale.
3. Logs come from an unconditional best-effort second gh invocation (`--log-failed`); empty or failed → summary-only, exactly today's output.

## Scope

In scope: `lib/fetch-core.ts` (classifier, argv, labels, rendering, routing), tests, docs. Both consumers (`extensions/fetch.ts` tool, `bin/pi-quiver.ts` CLI) inherit the behavior through the shared core; no adapter behavior/logic changes — the tool-description string in `extensions/fetch.ts` is in scope for a doc-only edit.

Out of scope (stay HTTP fallback / unchanged):

- `/attempts/<n>/...` URLs, plural `/jobs/<id>` paths, artifact URLs, workflow pages. Attempt selection via `?attempt=` query params likewise: the classifier reads pathname only, so the query is stripped and gh shows the default attempt; `--attempt` support is out of scope.
- `--log` (full logs) — `--log-failed` only; passing steps are noise for debugging.
- Any change to `planGhRouting` bypass semantics (`raw`, non-GET, body, custom headers still skip gh).
- Issue/PR/repo targets — single gh call as today.

## Design

All changes in `lib/fetch-core.ts`.

### Classifier

`GhTarget` gains:

```ts
{ kind: "job"; slug: string; jobId: string; url: string }
```

`url` is the canonical job URL `https://github.com/<slug>/actions/runs/<runId>/job/<jobId>` (runId appears only in this echo; gh addresses jobs by jobId alone, so the target does not carry a `runId` field).

New `classifyGitHubTarget` case:

```ts
segs.length === 7 && segs[2] === "actions" && segs[3] === "runs" &&
/^\d+$/.test(segs[4]) && segs[5] === "job" && /^\d+$/.test(segs[6])
```

→ `{ kind: "job", slug, jobId: segs[6], url }`. Note **singular** `job` — GitHub's real UI path. The existing plural `/jobs/456` non-match fixture stays a non-match; do not copy its plural form into positive fixtures.

### gh commands

- `buildGhArgs` for `job`: `["run", "view", "--job", jobId, "--repo", slug]` (no runId positional; `gh run view --job` is documented and verified sufficient on gh 2.97.0).
- New **exported** `buildGhLogArgs(target): string[] | null` (tests import it the same way as `buildGhArgs`) — the only new function:
  - `run` → `["run", "view", runId, "--log-failed", "--repo", slug]`
  - `job` → `["run", "view", "--job", jobId, "--log-failed", "--repo", slug]`
  - `issue`/`pr`/`repo` → `null`

### Execution (`executeGhRouting`)

1. Summary call as today. Fail/empty → return `null` → HTTP fallback (unchanged primary contract; private-repo-without-gh still 404s via HTTP, as now).
2. Summary ok and `buildGhLogArgs` non-null → second call through the same injected `GhRunner`, same `timeoutMs` and `AbortSignal`.
3. Log call is best-effort for gh failures: `ok: false` or empty stdout (all steps passed, run in progress, logs expired, gh error, per-call timeout, >10MB `GH_MAX_BUFFER` overflow) → render summary alone. A gh failure can never turn a successful fetch into a failure. `runGh` already maps empty stdout to `ok: false`; no new logic for the empty case.
4. **Caller cancellation is terminal, not best-effort.** The module's existing invariant is that a mid-flight abort rejects (`test/fetch-core.test.ts:86`). Check `signal.aborted` before and after each runner call and reject with the abort reason — an abort during the log call must not silently downgrade to a successful summary-only render.
5. Latency budget: each call gets the full `timeoutMs` (default 20s), no time-share — worst-case success-path wall clock is 2x `timeoutMs`. Accepted tradeoff.

### Rendering

`renderGhResult` gains an optional `failedLogs?: string`. When present, the body becomes:

```
<summary>

## Failed step logs

<logs>
```

appended **before** the shared spill gate, so summary + logs are gated as one body (>32KB / 1000 lines spills to a temp file with the normal 60-line preview and `Saved-To:` path).

Labels and provenance:

- `ghCommandLabel` for `job`: `"run view --job"`. `details.ghCommand` carries the summary label (unchanged shape).
- `ghSourceLine` for `job`: `gh run view --job <jobId> --repo <slug>`.
- When logs were appended, a second source line follows the first, built mechanically as `Source: gh ${buildGhLogArgs(target).join(" ")}` (not hand-composed prose), so provenance names both commands exactly. Summary-only output keeps a single source line.
- `details.url` remains the canonical target URL for non-repo targets, including `job`.

## Error handling and edge cases

| Case | Behavior |
|---|---|
| Summary call fails/empty | `null` → HTTP fallback (today's contract) |
| Log call fails/empty/times out (gh-side) | Summary-only output, single source line |
| Caller abort (either call) | Fetch rejects with the abort reason — never a partial success |
| Worst-case latency | 2x `timeoutMs` (two sequential full-budget gh calls); accepted |
| Run/job still in progress | `--log-failed` empty → summary-only (correct: nothing failed yet) |
| Logs expired (retention) | gh errors → summary-only |
| Combined body >32KB / 1000 lines | Existing spill gate: temp file + preview |
| Cancellation mechanics | Shared `AbortSignal` aborts whichever gh call is in flight; `signal.aborted` checked around each call |
| `/attempts/`, `/jobs/` plural, artifacts | Classifier `null` → HTTP fallback |

## Testing

Existing suites, fake `GhRunner`, no real gh in CI:

- **Classifier** (`test/fetch.test.ts`): positive job fixture (singular `/job/<id>`, with and without query/fragment); negatives: non-numeric jobId, plural `/jobs/456` (kept), `/attempts/2/job/<id>`, 6-segment paths; existing issue/pr/repo/run fixtures untouched.
- **Args**: exact-array assertions for `buildGhArgs("job")` and `buildGhLogArgs` on all five kinds (`null` for issue/pr/repo).
- **Routing**: summary ok + logs ok → both `Source:` lines and `## Failed step logs` present; summary ok + logs empty/failed → summary-only, no logs heading, one source line; summary failed → `null`; fake runner receives two invocations for run/job, one for issue/pr/repo; large combined body: read the spilled file back and assert it contains the summary, exactly one `## Failed step logs` heading, and the log payload, with both source lines in the returned preview (asserting `Saved-To:` alone is too weak); `planGhRouting` bypass semantics preserved for job URLs; aborting during the second invocation rejects rather than rendering summary-only.
- Manual smoke: `pi -e ./extensions/fetch.ts -p "fetch <real failed job URL>"`.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (fetch section: job URLs + failed-step logs; category: user-facing behavior change), `doc/fetch.md` (gh routing prose section, ~L34-40 — the file has no routing table; category: user-facing behavior change), `CHANGELOG.md` (new `[Unreleased]` entry only — leave the released v3.1.2 entry untouched; the new entry states that GitHub's UI job URLs are singular `/job/<id>` and now route, and that plural `/jobs/<id>` still falls back to HTTP), fetch tool description string in `extensions/fetch.ts` (extend "actions-run" mention to jobs; category: user-facing surface), `skills/fetch/SKILL.md` (frontmatter and behavior lines name issue/PR/repo/Actions-run only; Claude Code selects the skill from that text — extend to jobs + failed-step logs)
- Derived / memory docs invalidated: `AGENTS.md` fetch summary line — note it is already stale pre-change (omits the v3.1.2 actions-run routing); the amend fixes both omissions (runs and jobs)

Materiality bar per `reference/documentation-impact.md` (external, non-normative workflow reference — not a repo file, same annotation as sibling specs): all entries amend existing owners; no new standalone docs; no code-mirrors.

## Open questions

None. All decisions above are ratified.
