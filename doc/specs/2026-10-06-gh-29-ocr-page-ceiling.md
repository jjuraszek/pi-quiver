# OCR page ceiling for doc_to_md

**Ticket:** jjuraszek/pi-quiver#29
**Goal:** Bound the number of pages one `doc_to_md` / `pi-quiver doc-to-md` invocation OCRs with a settings-only ceiling `quiver.docToMd.ocrMaxPages` (default 10): forced mode (`ocrMode: all`) rejects an oversized explicit selection before any work; textless mode OCRs at most that many textless pages and reports the rest with a rerun selection.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Date:** 2026-10-06
**Worktree:** `.worktrees/ocr-page-ceiling`

## Problem

OCR cost is bounded only by time. Forced mode accepts any explicit selection (`--pages 1-500` with `--ocr-mode all` runs 500 Tesseract passes until `primaryTimeoutMs` expires); textless mode OCRs every empty-text-layer page the child finds, admitting each against the same time budget (`ocr_admit`, `scripts/doc_to_md.py:142`, used at `:610`), and reports what it skipped as `budgetStopped` with the advice "raise primaryTimeoutMs". An agent can therefore request hundreds of OCR pages in one call, and the only brake is a timeout whose remedy is to raise the timeout. The gh-26 spec deliberately left page caps to consumers (`doc/specs/2026-10-01-gh-26-caller-driven-ocr-sidecars.md`, Out of scope); #29 revises that for a converter-side ceiling.

Framing: pivoted from "both modes require an explicit selection of at most N pages" (the ticket's text) to "ceiling = pages OCR'd per invocation". Textless mode exists so the converter picks the pages; requiring a selection there makes settings-level `ocr: true` unusable on any unpaged conversion and forces a two-pass for every scanned document. The ceiling bounds the cost the ticket names in both modes with one number: forced mode is checked pre-work on the explicit selection, textless mode is capped inside the child's existing admission loop. DOCX with OCR needs no refusal because its LibreOffice route runs the same capped PDF tier. User confirmed this pivot and the settings-only requirement ("so the LLM won't try to hack" the ceiling).

Premise correction recorded during questionary: the ticket's "timeouts bound elapsed work but do not cap the requested page count" is true but understated - the per-page time admission already exists for textless mode; what is missing is a page-count bound and a report that names the right remedy.

## Acceptance criteria

Ticket jjuraszek/pi-quiver#29, "Acceptance criteria", rows verbatim:

- [ ] With default settings, PDF/PPTX/DOC OCR requests through both `doc_to_md` and `pi-quiver doc-to-md` require a nonempty explicit selection of at most 10 distinct pages in both OCR modes. Missing/empty or oversized selections produce a tool error / CLI usage error (exit 2) before conversion or OCR work starts. Settings-enabled OCR follows the same rule: an unpaged conversion must explicitly turn OCR off.
  deviates: framing pivot (user-confirmed) - only forced mode (`ocrMode: all`) requires a nonempty explicit selection of at most `ocrMaxPages` distinct pages, rejected pre-work with a usage error (exit 2); textless mode stays unpaged and the child OCRs at most `ocrMaxPages` textless pages (Design D2, D3). Settings-enabled OCR therefore remains usable on unpaged conversions.
- [ ] Selection counts distinct pages, not the highest page number: on an input containing those pages, `2,7,19` counts as three and `1-8,5-10` as ten; eleven distinct pages fail at the default. Malformed/out-of-bounds selections are not silently changed. Extremely large ranges are rejected without expanding them into proportional in-memory page lists.
  in-scope
- [ ] A documented positive-safe-integer setting under `quiver.docToMd` changes the ceiling in both interfaces. Tests demonstrate lower and higher limits, user-settings application, and project `.pi/settings.json` precedence while preserving unrelated user fields. The ceiling is settings-only: tool arguments and CLI flags cannot raise or disable it.
  in-scope
- [ ] Invalid setting values (`0`, negative, fractional, numeric string, boolean, `null`, or outside the safe-integer range) warn and retain the valid lower-precedence ceiling, or default 10. No invalid value disables the ceiling.
  in-scope
- [ ] Existing single-image OCR counts as one page and does not require an unsupported page-range flag; no multi-frame traversal is introduced. DOCX requests with OCR enabled are refused with an explanation that DOCX segments are not rendered PDF pages and guidance to supply a PDF with selected pages. Ordinary DOCX conversion with OCR off remains available; no unbounded OCR fallback is permitted.
  deviates: image behavior is in scope unchanged (one page, always under the ceiling); DOCX+OCR is not refused - the mammoth route never OCRs and the LibreOffice fallback runs the capped PDF tier, so the "no unbounded OCR fallback" outcome holds through Design D3 without a refusal. Forced mode on DOCX stays rejected by the existing type guard.
- [ ] Rejection messages name the effective ceiling and the supplied selection, when present. They warn that broad OCR is expensive and often unnecessary, direct the agent to normal conversion/page signals, and recommend only a handful of pages needing OCR. For genuinely larger needs, guidance permits explicit sequential batches within the configured ceiling, inspecting each result before continuing. The converter does not silently truncate, auto-split, auto-retry or schedule parallel OCR batches to bypass rejection.
  in-scope
- [ ] With OCR disabled, ordinary conversion and `--info` are not subject to the OCR ceiling. Tool `ocr: false` and CLI `--no-ocr` override settings-enabled OCR. Accepted bounded OCR retains existing timeouts, normal-text/separate-OCR-output behavior and incomplete-OCR reporting; raising the ceiling does not raise timeouts.
  in-scope
- [ ] Automated tests cover both interfaces and modes, inherited OCR enablement, settings validation/precedence, distinct-page counting, pre-work rejection, image/DOCX boundaries and unchanged non-OCR behavior. The tool description, CLI help, generated Claude Code skill, README and conversion guide document the same default, settings override, format boundaries and native-text-first recovery guidance.
  in-scope

## Design

### D1. Settings-only descriptor `ocrMaxPages`

`lib/doc-to-md-options.ts` gains one descriptor in `DOC_TO_MD_OPTIONS`:

| field | value |
|---|---|
| key | `ocrMaxPages` |
| type | `int` (min 1, as every `int` descriptor) |
| default | `10` |
| settable | `true` |
| settingsOnly | `true` (new optional boolean on the descriptor type; absent elsewhere) |
| flag | `null` |
| help | "Most pages one invocation OCRs; ocrMode all rejects a larger distinct-page selection before any work, textless mode OCRs the first ocrMaxPages textless pages and names the rest in the OCR: line" (the renderers append the `(settings-only)` and `(default 10)` suffixes, so the help text carries neither) |

`settingsOnly` is the only new construct. Its consumers:

- `buildSchema` in `extensions/doc_to_md.ts:27-31` skips `settingsOnly` descriptors, so the tool schema has no `ocrMaxPages` parameter and the tool description never advertises it.
- The CLI flag parser in `bin/pi-quiver.ts` derives flags from `d.flag`; `flag: null` already keeps it out, and `--ocr-max-pages` falls through to the existing unknown-flag error.
- `resolveOptions` skips the per-call layer for `settingsOnly` descriptors, so a raw tool argument `ocrMaxPages: 999` is ignored (pi's tool-argument validation accepts unlisted keys; the schema is not closed) and the resolved value is settings or default, never caller-supplied. The CLI rejects `--ocr-max-pages` through its unknown-flag path. A test asserts neither route changes the effective ceiling.
- `coerceDocToMdSettings`, `TUNABLE_DEFAULTS`, `QUIVER_CONFIG_KEYS.docToMd` (auto-derived from settable descriptors, `lib/extension-config.ts:40-50`), `renderHelp`, and `scripts/gen-skill.mjs` keep it. Both renderers today key rows on `d.flag` (`renderHelp` prints `<path>` for a null flag; `gen-skill.mjs` filters `d.flag` out entirely), so each gains one rule: a `settingsOnly` descriptor renders a row labeled `quiver.docToMd.ocrMaxPages` with `(settings-only)` appended to its help, in the Tunables section of `--help` and in the skill's Flags table. Both renderings are pinned in tests. The existing descriptor test that requires a `--flag` on every non-`path` option (`test/doc-to-md-options.test.ts:11`) exempts `settingsOnly` descriptors.

Validation stays where it is: `coerceValue` for `int` changes from `Number.isInteger(v) && v > 0` to `Number.isSafeInteger(v) && v > 0`. This tightens every int tunable to the safe-integer range, which is the only behavior any of them can honor. Invalid values (`0`, negative, fractional, string, boolean, `null`, above `Number.MAX_SAFE_INTEGER`) take the existing warn-and-drop path (`pi-quiver: quiver.docToMd.ocrMaxPages <reason>; ignored.`) so the lower-precedence layer or the default 10 applies; the existing layer merge (`resolveConfig`, user then project, `lib/extension-config.ts:106-125`; `readCliSettings` in `bin/pi-quiver.ts`) already preserves unrelated user fields. No new error class.

### D2. Forced-mode pre-work guard

`parsePages` (`lib/doc-to-md-options.ts:139-152`) today expands every range into a `Set` before anything can reject it, so `--pages 1-9999999999` allocates proportionally in every mode. The guard therefore runs before expansion, in `resolveOptions` where the raw spec string is still at hand:

- `parsePages` is split into `pageIntervals(spec): Array<[number, number]>` (the existing tokenizer and validation, plus one new rule: an endpoint above `Number.MAX_SAFE_INTEGER` is a `UsageError` like any other malformed token) and the expansion that returns the sorted deduplicated `number[]` the child and `DocToMdOptions.pages: number[] | null` already use. `countDistinctPages(intervals)` merges overlapping intervals and sums their lengths without expanding.
- In `resolveOptions`, when the resolved `ocrMode` is `"all"` and the per-call `pages` spec is non-empty, `countDistinctPages` runs on the intervals first; a count above `ocrMaxPages` throws `UsageError` with the message below and the range is never expanded. Otherwise expansion proceeds as today. Non-OCR and textless conversions keep today's expansion unchanged; no general page cap is added.

`2,7,19` counts 3 and `1-8,5-10` counts 10; exactly `ocrMaxPages` passes (`>`), `ocrMaxPages + 1` fails. The existing forced-mode checks in `convertDocument` (`lib/doc-to-md-core.ts:614-618`: requires `--ocr`, explicit nonempty pages, type pdf/pptx/doc) stay where they are, so an oversized forced selection on a DOCX gets the ceiling error (resolve phase) rather than the type error (convert phase); both are usage errors. The ceiling rejection happens before backend discovery, bundle creation, or any child spawn; the tool returns an error result and the CLI exits 2 through the resolve-phase `UsageError` mapping (`bin/pi-quiver.ts:145`). Out-of-bounds pages are still validated by the child against the real page count (`check_pages`, `scripts/doc_to_md.py:64-70`); the ceiling is a count check and never clips or reorders a selection.

Message (one string, used by tool and CLI; `<count>`, `<ceiling>`, and `<spec>` are the distinct count, the effective ceiling, and the raw `--pages` text truncated to 80 characters):

```
ocrMode "all" selects <count> distinct pages (pages=<spec>); the OCR page ceiling is <ceiling> (quiver.docToMd.ocrMaxPages). Broad OCR is slow and usually unnecessary: convert without OCR first, read Page-Stats to find the pages that need it, and select only those. For more than <ceiling> pages, run explicit sequential batches within the ceiling and inspect each result before the next. The ceiling is settings-only; no tool or CLI argument raises it.
```

The converter never truncates the selection, splits it into batches, retries, or runs batches in parallel; the message is the whole response.

### D3. Textless admission in the child

The TypeScript side adds `ocrMaxPages: o.ocrMaxPages` to the shared `base` tier options next to `ocrBudgetMs` (`lib/doc-to-md-core.ts:634`); the forced `ocr-pages` spawn (`:788`) does not receive it. In `scripts/doc_to_md.py` only `mode_pdf_primary` changes. It reads `o.get("ocrMaxPages", 10)` (direct child calls in tests omit the key, as they do for `ocrBudgetMs`) and keeps a counter of admitted OCR pages. Inside the existing `if kw["use_ocr"]:` block (`:606`), so an `ocr: false` conversion never touches the counter or the bucket:

1. Before the `ocr_admit` time check (`:610`): if the counter already equals `ocrMaxPages`, append the page to `info["ceilingStopped"]` and set `kw = {"use_ocr": False}` - the same shape as the `budgetStopped` refusal at `:611-612`. No `continue`: the page then flows through `textless_picture` (`:617`) and the normal page output exactly as a budget-stopped page does.
2. Otherwise the `ocr_admit` check and the second `remaining < MIN_OCR_JOB_S` check (`:621`) run unchanged; a time refusal goes to `budgetStopped` as today.
3. Increment the counter immediately before `worker.run` (`:628`), after both time checks, so a page that reaches Tesseract consumes one slot whether or not recognition succeeds (a broken page cannot keep the loop open) and a budget-stopped page consumes none.

The ceiling check precedes the time check, so every skipped page is in exactly one bucket. `mode_pdf_fallback` never OCRs (it reports `unavailable`, reason `fallback tier`, `:719`) and is untouched. The `ocr-pages` tier (forced mode, `:787-859`) is unchanged: its selection was already admitted or rejected by D2. The DOCX LibreOffice fallback passes `ocr: true` into the same `base` and `mode_pdf_primary`, so it is capped the same way; the mammoth route has no OCR. Image inputs are one page and never reach the ceiling.

### D4. Reporting

- `ceilingStopped: number[]` is required in `OcrInfo` (`lib/doc-to-md-handle.ts:23`), `emptyOcr` (`lib/doc-to-md-core.ts:539`), and the child's `new_ocr` (`scripts/doc_to_md.py:103`), always emitted like `budgetStopped`; it travels inside `TierJson.ocr` (`lib/doc-to-md-core.ts:470`), which is already typed `OcrInfo`, so `TierJson` itself gains no top-level field. `OcrInfo` also gains `ocrMaxPages: number`, filled by `handleOcr` in core from `o.ocrMaxPages` (the child never learns the setting's provenance; the TS side owns it), so the formatter and the JSON handle carry the effective ceiling.
- Only the textless `ran` branch of `ocrLine` (`lib/doc-to-md-handle.ts:117-124`) gains a clause, appended after the budget clause when the bucket is non-empty. With `all = compactRanges(ceilingStopped, Infinity)` and `next = compactRanges(ceilingStopped.slice(0, ocrMaxPages), Infinity)` (both with `", "` collapsed to `","` like the budget clause, so sparse pages render as `11,14,19`, never as a min-max span):
  - PDF/PPTX/DOC/image: `OCR page ceiling (<ocrMaxPages>) reached for pages=<all>; rerun with pages=<next> or raise quiver.docToMd.ocrMaxPages`
  - DOCX (`type === "docx"`, the LibreOffice route; a paged rerun is impossible there because that route rejects `pages` and the direct route reads `pages` as break segments): `OCR page ceiling (<ocrMaxPages>) reached for rendered pages=<all>; export the document to PDF and rerun on it with pages=<next>, or raise quiver.docToMd.ocrMaxPages`
- `forcedOcrLine` and its merged `rerun` are unchanged: forced mode is pre-rejected by D2, so its `ceilingStopped` is always empty.
- `budgetStopped` and its "raise primaryTimeoutMs" clause are unchanged; raising the ceiling does not change any timeout.

### D5. Documentation and generated surfaces

Tool description (`extensions/doc_to_md.ts:40`), `renderHelp`, `USAGE_PATTERNS`, `skills/doc-to-md/SKILL.head.md` and the regenerated `SKILL.md`, `README.md` settings table, and `doc/doc-to-md.md` Configuration and Child contract sections state the same facts: default 10, settings-only, forced mode rejects oversized selections pre-work, textless mode caps and reports with a rerun selection, convert without OCR and read Page-Stats first. `CHANGELOG.md` gets an `## Unreleased` bullet.

## Errors and edge cases

| case | behavior |
|---|---|
| forced, selection > ceiling | `UsageError` (D2 message) in `resolveOptions`, before expansion and before any spawn; CLI exit 2 (resolve phase) |
| forced, `--pages 1-9999999999` | counted by interval, rejected without allocating the range |
| any mode, endpoint above `Number.MAX_SAFE_INTEGER` | `UsageError` from the tokenizer |
| forced, selection == ceiling | runs |
| forced, overlapping ranges `1-5,3` | counts 5 |
| forced, selection out of document bounds but <= ceiling | passes D2; child `check_pages` rejects as today |
| forced on DOCX, selection > ceiling | ceiling error (resolve) wins over the type error (convert) |
| `ocrMaxPages` tool parameter | ignored by `resolveOptions`; ceiling unchanged |
| `--ocr-max-pages` flag | CLI unknown-flag error |
| settings `ocrMaxPages` invalid (`0`, `-1`, `1.5`, `"10"`, `true`, `null`, `2**53`) | warning, key dropped, lower layer or default 10 |
| project settings invalid, user settings valid | user value applies, unrelated user fields preserved |
| textless, textless pages <= ceiling | all OCR'd, `ceilingStopped` absent, OCR line unchanged |
| textless, textless pages > ceiling | first N in page order OCR'd, rest in `ceilingStopped`, pictures kept, clause and rerun rendered |
| textless, ceiling and time budget both hit | ceiling checked first; a page is in exactly one bucket |
| textless page admitted then Tesseract fails | slot consumed; page reported in the existing failed bucket |
| textless page time-budget-stopped | no slot consumed |
| textless, `ocr: false` | counter and bucket untouched; `ceilingStopped` stays `[]` |
| textless DOCX via LibreOffice over ceiling | DOCX clause (export to PDF) instead of a paged DOCX rerun |
| DOCX, `ocr: true`, mammoth route | no OCR runs (unchanged) |
| DOCX, `ocr: true`, LibreOffice fallback | capped PDF tier (D3) |
| DOCX, `ocrMode: all` | existing type guard rejects (unchanged) |
| image input, `ocr: true` | one page, OCR'd (unchanged) |
| `ocr: false` / `--no-ocr` with settings `ocr: true` | no OCR, ceiling irrelevant (unchanged override) |
| `--info` | never OCRs, untouched; existing `--info` + `ocrMode: all` incompatibility unchanged |

## Tests

`node --test`, extended in existing files:

| file | asserts |
|---|---|
| `test/doc-to-md-options.test.ts` | descriptor default 10; flag-pin exempts `settingsOnly`; `resolveOptions` ignores per-call `ocrMaxPages`; `resolveOptions` with `ocrMode: all` rejects 11 pages at default with the D2 message naming count, spec, and ceiling, passes 10, counts `1-8,5-10` as 10 and `2,7,19` as 3, rejects `1-9999999999` without expansion (asserted by timing or by a spy on the expansion), rejects an unsafe endpoint in any mode; ceiling 5 from settings rejects 6, ceiling 20 accepts 15; `coerceDocToMdSettings` warns and drops each invalid value in the AC list, including `2**53`; `renderHelp` and skill generator render the settings-only row |
| `test/doc_to_md.test.ts` | the existing `pages: "1-100"` forced test (`:83`, expects the no-Python-backend error) becomes a within-ceiling selection so that path keeps coverage; the registered tool's schema (via the extension's `registerTool` seam) has no `ocrMaxPages` property and a call carrying `ocrMaxPages: 999` still rejects 11 pages |
| `test/doc-to-md-cli.test.ts` | `--ocr-max-pages` rejected as unknown; forced over-ceiling exits 2 (resolve phase); project `.pi/settings.json` ceiling overrides user ceiling and preserves unrelated user fields; `--no-ocr` with settings `ocr: true` converts unpaged |
| `test/doc-to-md-handle.test.ts` | ceiling clause on the textless `ran` branch with sparse pages (`11,14,19`) and the `next` subset at ceilings 2 and 10; DOCX variant; `forcedOcrLine` unchanged |
| `test/doc_to_md.child.test.ts` | `mode_pdf_primary` on `test/fixtures/textless-3.pdf` with `ocrMaxPages: 1` under the existing fake-clock harness (`:522-575`) -> `ceilingStopped` holds pages 2 and 3, their pictures stay in `images/`, OCR text present for page 1; with the clock advanced so the budget would also stop page 2, page 2 is only in `ceilingStopped`; `ocr: false` leaves `ceilingStopped` `[]`; missing `ocrMaxPages` key defaults to 10 |
| `test/doc_to_md.test.ts` (seam test) | DOCX on the LibreOffice route (backend without DOCX packages, `office` seam returning a PDF) with `ocr: true` and settings `ocrMaxPages: 1`: the `pdf-primary` child options carry `ocrMaxPages: 1`, and a child reply with `ceilingStopped: [2, 3]` renders the DOCX clause in the handle; no scanned-DOCX fixture, soffice, or Tesseract needed |
| `test/extension-config.test.ts` | `QUIVER_CONFIG_KEYS.docToMd` includes `ocrMaxPages` |
| `test/skill-generation.test.ts` | regenerated skill matches |

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` - `doc_to_md` settings table (operations / tunable parameters: the key, default 10, settings-only, why no per-call override); `doc/doc-to-md.md` - Configuration (same category: the key and the two enforcement points) and Child contract (communication contract: `ocrMaxPages` in, `ceilingStopped` out); `CHANGELOG.md` - deferred: release
- Derived / memory docs invalidated: `skills/doc-to-md/SKILL.md` - regenerated by `scripts/gen-skill.mjs`

Materiality bar: `reference/documentation-impact.md`.

## Out of scope

- Range expansion for non-OCR and textless conversions (`--pages 1-9999999999` without `ocrMode: all` still expands as today). Pre-existing, not an OCR concern; a separate ticket if wanted.
- Automatic page-need detection beyond what textless mode already does, auto-splitting, auto-retry, parallel batches, aggregate or cross-session limits.
- Changing timeouts, raster limits, OCR output format, or the `ocrMode` per-call-only rule.
- Downstream adoption, staging, and Windows evidence (E-3314).
- Removing the existing `--info` + `ocrMode: all` incompatibility.

## Open questions

none
