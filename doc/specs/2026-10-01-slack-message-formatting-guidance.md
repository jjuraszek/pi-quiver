# Slack message formatting guidance

**Goal:** Render formatting required by the calling skill in Slack's native conventions without encouraging additional formatting or flattening the required structure.

## Problem

The shared communication rules favor one paragraph, while the Slack tools do not explain Slack-specific formatting. A skill-required list can become inline hyphens rather than a list; generic Markdown emphasis can be used in the wrong dialect; a required quotation can lose its quote structure. The request concerns faithful authoring, not a demonstrated transport bug in a particular customer message. No affected customer payload or customer `SLACK.md` was supplied.

Current `slack_post` and `slack_update` forward caller blocks without conversion. One delivery gap prevents native formatting throughout: `slack_post` ignores `blocks` in combined headline-plus-detail announcements, although ordinary posts, existing-thread replies, and updates already accept them. Announcement recovery currently preserves only the text detail.

## Acceptance criteria

none - no ticket

## Design

### Ownership and instruction boundary

D1. The calling skill decides whether a message requires formatting. The extension only instructs how to represent that requested formatting in Slack. Keep otherwise plain content plain. Do not introduce a general preference for lists, emphasis, code, or quotations, or prompts to add them "when useful." Preserve the structure a skill requires rather than flatten it to satisfy a default prose paragraph preference.

D2. Ship the guidance with the enabled `slack_post` and `slack_update` tool definitions in `extensions/slack.ts`. Use Pi's existing `promptGuidelines` and self-sufficient tool descriptions; a custom system prompt can omit default prompt guidelines. Define one module-level `SLACK_FORMATTING_GUIDANCE` owner in that file and reuse its rules in both tools' descriptions and `promptGuidelines`, rather than maintaining separate copies. Keep the single compact native-list example with that owner and include it in both descriptions. Register nothing while Slack is disabled. Add no Slack skill, config flag, or prompt-injection hook.

D3. Apply `/skill:forge-skill` to the changed model-facing instructions: imperative voice, observable conditions, minimal edits at the rule owner, a positive output recipe, no subjective nuance clauses, and ASCII punctuation. Read the complete instruction owner before editing and review the changed instructions against those rules. Its oversized-file extraction rule applies to instruction documents such as a SKILL or prompt document, not to the line count of a TypeScript source file containing short instruction strings. Do not restructure unrelated transport code to change a prompt string.

D4. Customer policy continues to own channel choice, tone, approvals, and message templates through the existing `quiver.slack.policyPath` contract. No customer `SLACK.md` is required to obtain correct Slack representations, and a filename alone does not load a policy. Shared `AGENTS.core.md` prose preferences and sibling repos are not changed by this feature.

### Slack representations

D5. Render requested bullet and numbered lists as Slack `rich_text` blocks containing `rich_text_list` elements with `style: "bullet"` or `style: "ordered"` and a `rich_text_section` for each item. Preserve order and item boundaries. Text markers with line breaks are readable fallback, not a substitute for the native visible list selected by the user. Literal syntax inside requested code stays literal.

D6. Represent other skill-required formatting using the representation of its surface:

| Requested format | Inside native rich text | Text-only mrkdwn |
|---|---|---|
| Bold, italic, strikethrough | Text-element style properties `bold`, `italic`, `strike` | `*bold*`, `_italic_`, `~strike~` |
| Inline code | Text-element `code` style | Backtick-delimited code |
| Multiline code | `rich_text_preformatted` | Triple-backtick fences |
| Block quotation | `rich_text_quote` | `>` at the start of each quoted line |
| Labeled link | A Slack link element | `<url\|label>` |

For a skill-required block quotation, use native rich text, just as for lists; the mrkdwn column documents Slack's text-only dialect rather than permission to replace the required native representation. Preserve the quoted wording and any supplied attribution. Use native styles/elements within a rich-text body, not mrkdwn delimiters in its text leaves. Required code uses native code elements in an existing rich-text body and Slack backtick syntax in a text-only message; code alone does not require introducing blocks. Text-only inline emphasis and links remain supported. In text-only code and fallback text, escape literal mention-like names with the existing `\@name` input convention; backticks do not disable the extension's mention scan. For example, supply `echo \@alice` to preserve the literal command `echo @alice`. Block text/code leaves remain untouched by that scan. Do not rewrite caller input or add a Markdown parser, automatic format detector, formatter, or second content schema.

D7. When the agent authors blocks, also provide a readable fallback containing the substantive message content, not "see above." Preserve list-item boundaries and the distinction between quoted words and commentary in that fallback. It serves notifications and screen readers, not the visible native list. This is authoring guidance, not a new runtime requirement that rejects existing blocks-only callers.

D8. Block payloads remain caller-authored pass-through. Slack validates their shape. Existing mention resolution remains limited to `text` and `thread_body`; it does not traverse blocks. Include that boundary in the shared instructions: treat `@name` text in blocks as literal and rely on name lookup only in `text` or `thread_body`. Do not promise automatic native mentions from block text. Preserve existing unfurl defaults and other transport options.

### Message routing

D9. Reuse the existing input fields. Add no `thread_blocks` input or new posting tool:

| Mode | Visible content | Readable fallback |
|---|---|---|
| Plain `slack_post` with blocks | `blocks` | `text` |
| `slack_update` with blocks | `blocks` | `text` |
| `slack_post` with `thread_ts` and blocks | `blocks` in the existing thread | `thread_body ?? text` |
| `slack_post` with `thread_body`, no `thread_ts`, and blocks | Text-only `text` headline, then `blocks` in its detail reply | `thread_body` for the detail |

Without `thread_body`, blocks do not create an announcement. Existing text-only routing remains intact. In combined announcements, forward the original blocks only to the detail `chat.postMessage`, alongside its fallback text and returned headline `thread_ts`; do not attach them to the headline. Update tool descriptions and field descriptions to make this association explicit.

D10. Blocks-bearing announcement details and existing-thread replies bypass Markdown-file upload fallback. Exempt blocks-bearing threaded posts from the local `MAX_TEXT_LENGTH` fallback-text guard so initial detail delivery and thread-only recovery follow the same policy. Retain headline, text-only, non-threaded-post, and update length limits. Forward blocks and fallback text unchanged by formatting logic even when the text crosses the configured upload threshold. A blocks-bearing `msg_too_long` failure does not trigger an upload: an announcement uses structured-detail recovery, and an existing-thread reply surfaces the Slack error. Preserve the current text-only upload behavior. Do not turn native blocks into a file, silently flatten them, or split one requested message into extra posts.

### Announcement recovery

D11. Preserve the existing headline preflight, no-retry, `outcome_unknown`, and `_(detail pending)_` contracts. A failed or uncertain headline never triggers a detail post or an automatic headline retry. After a confirmed headline, a failed detail keeps the existing best-effort marker update and returns the thread identifier for recovery.

D12. Persist the complete failed detail in the existing temporary-artifact location. For blocks-bearing details, save a `.json` file containing `{ "text": <detail fallback>, "blocks": <original blocks array> }`. Preserve the original blocks, including nested content. For text-only details, retain the existing `.md` recovery file. Extend the existing `persistDetail` and injected persistence hook with an optional `format: "md" | "json"` argument defaulting to `"md"`; pass it through the existing persistence-failure handling rather than add another writer. This applies both to `outcome_unknown` after headline dispatch and to `detail_failed` after a confirmed headline. Existing error codes and the returned `detailPath` mechanism stay intact; identify the artifact format in recovery guidance.

D13. Recovery uses `slack_post` with the saved text as `thread_body`, detail `blocks`, and the recovered `thread_ts`. After a transient delivery failure, reuse the saved blocks. After a Slack payload rejection such as `invalid_blocks`, correct the rejected payload before posting into that thread; preserve the original artifact. Keep the underlying Slack rejection identifier visible in the existing error message or data without replacing `detail_failed`. A returned thread identifier is used directly; after `outcome_unknown`, the caller first finds the actual thread as required by the existing protocol. Never issue a second headline to recover formatting. Preserve existing error handling for failure to persist an artifact or update the pending marker; do not add retries, persistence backends, or automatic replay.

### Predecessor scope

This spec supersedes `doc/specs/2026-08-29-gh-7-slack-extension.md` only for the `slack_post` combined-announcement blocks association in **Tool surface**, and blocks-bearing detail delivery/recovery in **Announce protocol**. Its unrelated contracts remain current. The policy injection design in `doc/specs/2026-09-01-gh-9-slack-repo-policy-gap.md` is not superseded: consumer policy stays consumer-owned.

## Errors and edge cases

- Invalid blocks surface Slack's existing error path. Do not introduce a local Block Kit schema validator; announce detail rejection still preserves the structured payload and marks the confirmed headline pending.
- Missing fallback on existing blocks-only plain/update callers is not a new error. Announce continues to be selected by the presence of `thread_body` without `thread_ts`.
- A custom Pi system prompt can omit `promptGuidelines`; the tool descriptions still carry the instruction. Unset customer policy does not suppress generic formatting guidance or add a policy-injection handler.
- Text-only messages do not acquire blocks or other formatting through transport code. The native-formatting rule is conditional on the calling skill's requirement, not an agent judgment about readability.
- Native payload limits remain Slack-owned. Large block payloads are not automatically chunked or uploaded; a failure follows the existing message or announcement error path.

## Tests

Use the existing Node test harness and fake Slack API; send no live Slack messages as part of automated verification.

1. In `test/slack-config.test.ts`, assert that enabled posting/editing tools expose the shared instructions without `policyPath`, that descriptions are self-sufficient, and that disabled Slack still registers nothing. Pin the conditional instruction boundary and native-list example without claiming a string assertion proves model compliance.
2. In `test/slack-core.test.ts`, exercise a combined announcement with native blocks and fallback text. Assert a text-only headline first, then exact deep equality of detail blocks/text and the headline's `thread_ts`. Include native list and quote/style/code content in the representative block payload.
3. Preserve pass-through regression coverage for plain posts, existing-thread replies, and updates. Assert the existing-thread route sends no headline.
4. Use the configured default upload threshold and a `MAX_TEXT_LENGTH + 1` fallback (4,001 characters at the current definitions): force a structured detail failure, inspect the JSON recovery artifact, and recover into the known thread with the same fallback and blocks. Assert both sends reach the mock API without upload, a local length rejection, or a second headline. Also assert that a blocks-bearing `msg_too_long` never triggers upload and that headline/non-threaded/update length limits and text-only oversized-detail upload behavior remain intact.
5. Exercise both an `invalid_blocks` detail rejection after a confirmed headline and a separate uncertain-headline outcome. Assert the existing error code, visible underlying rejection identifier where applicable, headline retry prohibition, pending-marker behavior, persistence format argument, recovery artifact suffix, and parsed JSON content. Correct the rejected blocks before recovery into the known thread and assert no second headline and no change to the original saved artifact. Preserve text-only `.md` recovery coverage and persistence-failure degradation.
6. After spec approval, run a controlled authoring check with fake output only: a scenario whose calling skill explicitly requires formatting, and a plain-prose control. Include literal code `echo @alice` to inspect the existing escape recipe in text/fallback fields without introducing mention parsing. Inspect that requested structure uses native Slack representations and that the control remains plain. Use fresh baseline/guided comparisons per `/skill:forge-skill` as an optional diagnosis; do not treat a successful model sample as a deterministic guarantee.
7. Extend the existing manual smoke checklist with native bullet/ordered-list and quote/style/code rendering, readable fallback inspection, and structured-detail recovery in an authorized test channel. A live rendering check requires a configured workspace and approval to post; report it as unrun when these are unavailable.

Scoped verification commands run from the implementation worktree:

```sh
env -u PI_CODING_AGENT_DIR node --test test/slack-core.test.ts test/slack-config.test.ts
```

Run the documented full verification before completion:

`env -u PI_CODING_AGENT_DIR npm run test:all`



## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/slack.md`
- Derived / memory docs invalidated: none

Apply `reference/documentation-impact.md`. `doc/slack.md` clears the communication-contract and recovery-procedure categories: explain the conditional authoring boundary, existing-field routing, complete fallback, blocks bypassing uploads, and JSON recovery. Extend its existing smoke checklist. Do not create a separate formatting guide or customer policy template. The gathered `AGENTS.md` candidate is dropped because the shared prose preference does not change; the existing README links remain accurate. Record the behavior change in `CHANGELOG.md` as release history, not a new product-facing guide.

## Out of scope

- Encouraging formatting, inferring that formatting would be useful, or decorating otherwise plain messages.
- Attributing a specific past customer message to a prompt without its payload and active policy.
- Editing customer `SLACK.md`, shared communication rules, or unrelated skills.
- Markdown conversion, parsing, automatic styling, local Block Kit validation, and block mention resolution.
- Slack read-path formatting, nested thread presentation, token/config changes, new tools or skills, and new durable state.

## Open questions

None blocking design. A live Slack rendering check remains environment-dependent; mocked API verification cannot establish the appearance in a particular Slack client.

## Sources

- `extensions/slack.ts:224-240,301-405`: policy injection, posting/editing definitions, text-only mention processing.
- `lib/slack-core.ts:792-834,1040-1238`: text/blocks pass-through, recovery, combined announcements, existing-thread block delivery.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:345-355`: `promptGuidelines` support; `dist/core/system-prompt.js:30-85`: guideline deduplication and custom-prompt path.
- [Slack message formatting](https://docs.slack.dev/messaging/formatting-message-text): mrkdwn conventions and text-list approximation.
- [Slack rich-text lists](https://docs.slack.dev/reference/block-kit/block-elements/rich-text-list-element) and [rich-text formatting](https://docs.slack.dev/block-kit/formatting-with-rich-text): native list, style, quote, and code representation.
- [Slack Block Kit accessibility](https://docs.slack.dev/block-kit) and [message fallback](https://docs.slack.dev/messaging/migrating-outmoded-message-compositions-to-blocks): screen-reader/notification role of top-level text.
