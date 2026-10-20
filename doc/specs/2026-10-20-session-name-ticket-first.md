# Session names carry the ticket id when a PR references one

**Goal:** When the sampled conversation holds both a PR ref and the ticket it references, `session-name` names the session by both with the ticket as the subject (`PR#123 for A-123`) instead of the PR number alone.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Framing:** kept - the built-in typed-ID rule is what offers `PR 1234` as a stand-alone identity, so the default changes; the user-level `quiver.sessionAutoName.rules` path stays as the override.

## Problem

`buildNamingPrompt` (`extensions/session-name.ts:333-366`) carries two built-in ID rules: "Preserve ticket/issue IDs (e.g. ABC-123, PROJ-42, #99) verbatim" and "If the whole TAB would be just an ID, say what it is: PR 1234, issue 123, ticket ABC-123. Never reply with digits only." In a `gatekeep-pr` session the PR ref is in the user message and the second rule offers `PR 1234` as a complete answer, so the model names the session by the PR number even though the ticket id sits in the PR title or first body line, inside the 4000-char head that `buildConversationText` (`session-name.ts:136-160`) samples. The ticket is the stable identity; the PR is one artifact of it.

The rule is prompt-only: no code resolves ticket versus PR, `gatekeep-pr` has no naming instruction, and the extension cannot see which skill runs. User `rules` append after the built-ins and later rules win (README line 204), so a house rule can override the default; the default itself still steers every user to the PR number.

Premises verified: the typed-ID line and its position before user rules (`session-name.ts:343-346`); the 4-word TAB cap in `toTabLabel` (`session-name.ts:175`); the prompt-order tests (`test/session-name.test.ts:208-235`); the prior change to this line recorded in `CHANGELOG.md` v6.3.0. The ticket ref's presence in the sampled head is a user-stated fact about gatekeep transcripts, not checked against a real transcript; a ticket id absent from the sample yields `PR 123`, which stays a valid name.

## Acceptance criteria

none - no ticket

## Design

One sentence is inserted into the typed-ID rule in `buildNamingPrompt`; no other line of the prompt changes. The rule becomes:

```
- If the whole TAB would be just an ID, say what it is: PR 1234, issue 123, ticket ABC-123. Include the PR's referenced ticket in SESSION and TAB: PR#123 for A-123. Never reply with digits only.
```

The sentence follows the forge-skill authoring rules: an imperative ("Include") with one example, scoped to the observable case of a PR that references a ticket; it names SESSION and TAB explicitly because the surrounding rule addresses TAB only. `PR#123 for A-123` is 3 words and passes `toTabLabel` unchanged; SESSION keeps the verb under the existing long-form guidance and names the task, not the initiating skill (`Review PR#123 for A-123`). The preserve-IDs line, the example line, parsers, `buildConversationText`, the deny list, and the config schema (`lib/settings-core.ts:40`) are untouched. User `rules` still append after the built-ins and win on conflict, so a PR-first house rule overrides the new sentence.

The rule is tracker- and skill-agnostic: it fires on any co-occurring PR ref and ticket id (`ABC-123`, `#99`, or any form the preserve-IDs line already admits) and does not name `gatekeep-pr`.

## Errors and edge cases

The change is prompt text; no parsing, config, or I/O path gains a failure mode.

- Model answers `PR 123` with a ticket in view: a valid name, accepted as today.
- Model answers `PR#123 for A-123`: 3 words, passes the TAB cap and the deny list.
- Long paired identifiers: `parseGeneratedName` (`session-name.ts:294-295`) slices TAB to 30 characters before `toTabLabel`, so `PR#12345 for PLATFORM-12345` (27 chars) fits and a longer pair truncates mid-ticket. The existing truncation is accepted; parsers stay unchanged.
- No ticket id in the sampled text: the rule has nothing to pair, `PR 123` results.
- User `rules` entry says PR-first: it wins, as before.

## Tests

`test/session-name.test.ts:208-235` pins the built-in rule order by string match. The assertion for the typed-ID line is updated to the new text (`- If the whole TAB would be just an ID, say what it is: PR 1234, issue 123, ticket ABC-123. Include the PR's referenced ticket in SESSION and TAB: PR#123 for A-123. Never reply with digits only.`); the order check (preserve-IDs line, then typed-ID line, then user rules) stays. One assertion is added beside the existing `toTabLabel` examples (`test/session-name.test.ts:73`): `assert.equal(toTabLabel("PR#123 for A-123"), "PR#123 for A-123")`. No new test file, no fixture.

Verification: `env -u PI_CODING_AGENT_DIR npm run test:all`. Manual smoke (qualitative prompt check, not deterministic pass/fail): start an unnamed session with `quiver.sessionAutoName.enabled` true and empty `rules`/`deny`, load `pi -e ./extensions/session-name.ts`, and open with a sampled PR title that explicitly references its ticket (for example `Review PR 18: Fix login timeout (#30)`). Inspect both SESSION and TAB: each should carry the PR and the referenced ticket; an action-prefixed TAB that fits the cap is fine, and no single exact model string is required.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - one `## Unreleased` bullet (operations: a changed default every user observes)
- Derived / memory docs invalidated: none - README line 204 documents the `rules`/`deny` keys and override order, not the built-in wording

Template per `reference/documentation-impact.md`.

## Out of scope

- A config key or precedence system for ID types.
- A naming instruction in `gatekeep-pr` or any pi-gauntlet skill.
- Widening `buildConversationText` sampling to surface ticket ids absent from the head.
- Replacing the `PR 1234` example with `PR#1234` spelling.

## Open questions

none
