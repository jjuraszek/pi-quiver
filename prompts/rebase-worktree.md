---
description: Rebase this worktree onto the remote base branch, resolve conflicts, and test only what the resolution touched
argument-hint: "[base]"
---
Rebase this worktree onto `origin/${1:-main}`. This instruction is the authorization to resolve conflicts yourself and to rewrite the branch; do not push.

1. Record `git rev-parse HEAD` as the pre-rebase head. A dirty tree (`git status --porcelain` non-empty) stops the run: print the porcelain output and ask whether to commit or stash.
2. `git fetch origin ${1:-main}` then `git rebase origin/${1:-main}`.
3. Resolve each conflicted file so both sides' intent survives. A generated file (lockfile, schema dump, changelog section) is regenerated or re-appended on top of the base version, never hand-merged hunk by hunk. Stage it and `git rebase --continue` until the rebase completes.
4. Run only the tests that cover the files you resolved: the test file that names each resolved source file, else the smallest suite that imports it. Never the full verification command. A failing scoped test is fixed in one new commit on the branch and the test re-run; stop after 3 fix rounds and report the failure verbatim.
5. Report in one paragraph: the pre-rebase and new head, the conflicted files with one sentence per resolution, the scoped tests that ran with their result, and the fix commits if any.
