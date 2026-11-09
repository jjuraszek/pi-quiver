# doc_to_md enum single source: one const array per vocabulary

**Goal:** Every `doc_to_md` result and option vocabulary (`Engine`, `Tier`, `BackendKind`, `SheetInfo.kind`, `OcrInfo.status`, `InputType`, `OcrMode`, `ImageFormat`) is declared once as an `as const` array in `lib/`; the TypeScript union, the extension's `outputSchema`/input schema literals, and the two option descriptors all derive from that array, so a member can no longer exist on one side only; `lib/` stays TypeBox-free and the CLI, `--help`, and public result shape are byte-identical.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Ticket:** #38 (jjuraszek/pi-quiver)
**Branch:** `jacek/gh-38-doc-to-md-enum-single-source` (base `main` @ ec18ada)

## Problem

Since 6.16.0 (#36) `doc_to_md` declares an `outputSchema`, so a codemode script author reads an allowed-value list for `engine`, `tier`, `type`, `backend`, `ocr.status`, `ocr.mode`, and `sheets[].kind`. Each of those seven lists is written at least twice by hand: once as a TypeScript union (`Tier`, `Engine`, `BackendKind` at `lib/doc-to-md-handle.ts:4-6`, the inline `kind` union at `:13`, the inline `status` union at `:25`, `InputType` and `OcrMode` at `lib/doc-to-md-options.ts:7,9`) and once as a `strings([...])` literal list in `extensions/doc_to_md.ts` (`:23` input type, `:26` OCR status, `:29` OCR mode, `:33` sheet kind, `:41` engine, `:42` tier, `:54` backend kind). `BackendKind` has a third copy: `lib/doc-to-md-core.ts:230` exports its own `export type BackendKind = "uv" | "python" | "venv" | "none"`, identical to the handle alias but independent of it, and `DocToMdDetails.backend` (`:527`) uses the core copy. The `Backend` discriminated union next to it (`:231-235`) is not a fourth copy: each variant carries different fields and the `kind` literals stay as they are. The lists match today (12 engines, 8 tiers, 10 input types, 4 backend kinds, 4 OCR statuses, 2 OCR modes, 2 sheet kinds). Nothing couples them: pi forwards `structuredContent` to scripts without checking it against `outputSchema` (host `dist/extensions/codemode/execute.js:411-424`), the existing schema test (`test/doc_to_md.test.ts:69-114`) rejects a deleted top-level field but checks an allowed value only when a fixture happens to produce it, and `tsc` cannot see the string literals inside `Type.Literal(...)`. A member added to the union alone leaves the declared result type wrong, silently.

Two option vocabularies have the same shape with a third copy: `OcrMode` is also spelled out in its option descriptor (`enumValues: ["textless", "all"]`, `lib/doc-to-md-options.ts:81`), and `ImageFormat` (`:8`) is spelled out in its descriptor (`enumValues: ["png", "jpg"]`, `:89`). `enumValues` has exactly two runtime readers: the tool input schema (`schemaFor`, `extensions/doc_to_md.ts:67`) and the CLI `must be one of ...` validator (`lib/doc-to-md-options.ts:118`). `--help` (`renderHelp`, `:266-277`) and `scripts/gen-skill.mjs` (`:13`) render `help` and `default` only, so neither lists enum members and neither reads the descriptor literal. `ImageFormat` is input-only and not in the ticket's list; the user chose to fold it in because it is the same type-plus-descriptor duplication (questionary, 2026-11-09).

The extension already owns a helper that maps a string array to a union of literals (`strings`, `extensions/doc_to_md.ts:20`); it takes a mutable `T[]`, and `as const` tuples are `readonly`, so the parameter widens. `OptionDescriptor.enumValues` is already `readonly string[]` (`lib/doc-to-md-options.ts:61`). `lib/*` must not import `@sinclair/typebox` (AGENTS.md Rules; `test/layout.test.ts:42-49`), because `bin/pi-quiver.ts` is bundled with `--packages=external` and TypeBox is a devDependency.

Framing: kept. The scout's one objection - that a shared array fixes TypeScript-to-schema drift but not drift against the strings the Python child emits - is a scope boundary inside the same design, not an alternative to it; cross-language producer validation is out of scope (below).

Premises verified from source: the eight declaration sites (seven in `lib/doc-to-md-handle.ts` and `lib/doc-to-md-options.ts`, plus the `BackendKind` duplicate at `lib/doc-to-md-core.ts:230`) and the seven schema sites above; `renderHelp` and `gen-skill.mjs` reading `help`/`default`, not `enumValues`; the `strings` helper signature; `enumValues` already `readonly`; the layout test's TypeBox scan; the existing schema test; the predecessor spec for #36 (`doc/specs/2026-11-08-gh-36-typed-tool-results.md`, Design / doc_to_md and Tests). No load-bearing claim was contradicted. Not exercised: installed Python packages and the packed-install network path; neither bears on a TypeScript-only declaration change.

## Acceptance criteria

Ticket #38, Acceptance Criteria, rows verbatim:

- [ ] Each of the seven member lists (`Engine`, `Tier`, `InputType`, `BackendKind`, OCR `status`, `OcrMode`, `SheetInfo.kind`) is declared once as a const array in `lib/`; the TypeScript union is derived from it and `extensions/doc_to_md.ts` builds its `Type.Union` of literals from the same array, with all seven per-field hand-written schema member lists replaced by references to the shared arrays; retain the helper that maps string arrays to literal unions.
  in-scope
- [ ] `test/layout.test.ts` still passes: no file under `lib/` imports TypeBox.
  in-scope

## Legs

### Leg: jjuraszek/pi-quiver
branch: jacek/gh-38-doc-to-md-enum-single-source
contract:
- create: git worktree add <home> -b <branch>
- destroy: git worktree remove <home> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: env -u PI_CODING_AGENT_DIR npm run test:all (run in the worktree)
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/fetch.md
Rules: doc/doc-to-md.md
Rules: doc/provider-stall-watchdog.md
Rules: doc/slack.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
Rules: eval/elevator/README.md
scope: AC 1, AC 2
design: owns `lib/doc-to-md-handle.ts`, `lib/doc-to-md-options.ts`, `lib/doc-to-md-core.ts`, `extensions/doc_to_md.ts`, `test/doc_to_md.test.ts`, `CHANGELOG.md`; observable outcomes are the eight arrays exported from `lib/`, the extension schemas built from them, the extended schema test, and an unchanged CLI/`--help`/result surface.

## Design

Approach chosen (questionary, 2026-11-09): arrays live beside the types they replace, in the file that owns each vocabulary. No new file, no new boundary, no new settings key.

### Data flow

Array -> derived union type (compile time; consumed directly by `Handle`, `Options`, `publicHandle`, and `lib/doc-to-md-core.ts`, which imports `Engine`, `Tier`, `InputType` from the two owning files at `:16-17` and, after this change, `BackendKind`; `bin/pi-quiver.ts` is a transitive consumer only, through `DocToMdDetails`, `PerCallInput`, and `Tunables`, and needs no edit) and array -> `strings(ARRAY)` -> `Type.Union([Type.Literal(...)])` in `outputSchema` (runtime; what codemode scripts see), plus array -> `enumValues` -> `schemaFor` and the CLI `must be one of` validator for `OcrMode` and `ImageFormat`. Adding a member means editing one array; the type, the schema, and the descriptor follow.

### Remove

- The eight hand-written union types: `Tier`, `Engine`, `BackendKind` (`lib/doc-to-md-handle.ts:4-6`); the inline `kind: "worksheet" | "chartsheet"` on `SheetInfo` (`:13`); the inline `status: "off" | "unavailable" | "skipped" | "ran"` on `OcrInfo` (`:25`); `InputType`, `ImageFormat`, `OcrMode` (`lib/doc-to-md-options.ts:7-9`).
- The duplicate `export type BackendKind = "uv" | "python" | "venv" | "none"` at `lib/doc-to-md-core.ts:230`. The `Backend` discriminated union (`:231-235`) stays.
- The two descriptor literals `enumValues: ["textless", "all"]` (`lib/doc-to-md-options.ts:81`) and `enumValues: ["png", "jpg"]` (`:89`).
- The seven literal lists in `extensions/doc_to_md.ts`: `:23` (`inputType`), `:26` (`ocrSchema.status`), `:29` (`ocrSchema.mode`), `:33` (`sheetSchema.kind`), `:41` (`engine`), `:42` (`tier`), `:54` (`backend`).

### Add

- In `lib/doc-to-md-handle.ts`: five exported arrays `TIERS`, `ENGINES`, `BACKEND_KINDS`, `SHEET_KINDS`, `OCR_STATUSES`, each `[...] as const`, with derived exported types `Tier`, `Engine`, `BackendKind`, `SheetKind`, `OcrStatus` as `(typeof ARRAY)[number]`; `SheetInfo.kind: SheetKind`; `OcrInfo.status: OcrStatus`.
- In `lib/doc-to-md-options.ts`: three exported arrays `INPUT_TYPES`, `IMAGE_FORMATS`, `OCR_MODES` with derived exported types `InputType`, `ImageFormat`, `OcrMode`; the `ocrMode` descriptor reads `enumValues: OCR_MODES` and the `imageFormat` descriptor reads `enumValues: IMAGE_FORMATS`.
- In `lib/doc-to-md-core.ts`: add `type BackendKind` to the existing `./doc-to-md-handle.ts` import at `:16` and re-export it (`export type { BackendKind } from "./doc-to-md-handle.ts"`), so `DocToMdDetails.backend` (`:527`) and the core module's existing public export both resolve to the derived type. No in-repo importer reads it from core today (`bin/pi-quiver.ts` imports `DocToMdDetails`, not `BackendKind`); the re-export keeps the public surface unchanged.
- In `extensions/doc_to_md.ts`: the `strings` parameter type widens from `T[]` to `readonly T[]`; one import of the eight arrays from the two `lib/` files; each former literal list becomes `strings(ARRAY)` (`inputType = strings(INPUT_TYPES)` feeds the `type` field on both the conversion and the inspection branch).
- In `test/doc_to_md.test.ts`, inside the existing test "doc_to_md output schema types every public field and nested member", nine (schema field, array) mappings over the eight arrays, read at ten field occurrences because output `type` sits on both `outputSchema` branches: `engine`/`ENGINES`, `tier`/`TIERS`, `type`/`INPUT_TYPES` (conversion branch), `ocr.status`/`OCR_STATUSES`, `ocr.mode`/`OCR_MODES` on `outputSchema.anyOf[0]`; `type`/`INPUT_TYPES` (inspection branch), `backend`/`BACKEND_KINDS`, `sheets[].kind`/`SHEET_KINDS` on `outputSchema.anyOf[1]`; `ocrMode`/`OCR_MODES`, `imageFormat`/`IMAGE_FORMATS` on `registeredDocTool().parameters`. For each occurrence the test walks the schema to the field's `Type.Union`, collects the `const` of every `Type.Literal` member, and `assert.deepEqual`s that complete list to the shared array, so a literal present on only one side (added or retained) fails, not just a missing member. Value validation is kept alongside: each member and one non-member string is substituted into the carrier the field is constrained on and `Value.Check`ed - `projected` for `engine`, `tier`, `type`, `ocr.status`, `ocr.mode`; the existing `info` object (`test/doc_to_md.test.ts:103`) for `backend`, `sheets[0].kind`, `type`; `{ path: "x.pdf", <field>: value }` against `registeredDocTool().parameters` for `ocrMode`, `imageFormat`. The carrier matters: `Type.Object` sets no `additionalProperties`, so an invalid `backend` on the conversion fixture still passes the two-arm union.
- In `CHANGELOG.md` `## Unreleased`: one bullet, `(#38)` trailing per `.pi/gauntlet-overrides.md`.

### Invariants

- Member order and spelling inside every array are copied from the current unions, so no exported type name or member changes for existing importers, the schema's literal order is unchanged, and the CLI `must be one of textless, all` / `must be one of png, jpg` usage errors (`lib/doc-to-md-options.ts:118` joins `enumValues`) read the same.
- The two descriptors keep `type: "enum"`, `default`, and `help`; `renderHelp` and `scripts/gen-skill.mjs` read `help`/`default` and never `enumValues`, so `--help` output and `skills/doc-to-md/SKILL.md` are byte-identical because the strings they render are untouched, not because the array carries the same members.
- `publicHandle` keeps stripping `inputType`; `INPUT_TYPES` changes nothing in the public conversion shape beyond sourcing the existing `type` literal.
- `lib/doc-to-md-handle.ts` and `lib/doc-to-md-options.ts` import nothing from `@sinclair/typebox`; schema construction stays in `extensions/doc_to_md.ts`.
- No change to the Python child or the CLI surface; `BackendKind` remains exported from both `lib/doc-to-md-handle.ts` and `lib/doc-to-md-core.ts`, the latter as a re-export.

### Paid or external actions

No paid actions and no model calls. Implementation and verification are `node --test` and `tsc --noEmit` through `env -u PI_CODING_AGENT_DIR npm run test:all`. That suite includes `test/packed-install.test.ts` (`:13-22`), which runs `npm pack` and then a fresh `npm install --no-save` of the tarball in a `mkdtemp` directory, fetching the package's runtime dependencies from the npm registry on every run; that registry fetch is the one network action this spec names, and the user's ratification of this spec at the gate is its authorization. No other network. The loop treats an action absent from this clause as unreachable; adding one requires separate explicit authorization.

## Errors and edge cases

There is no runtime error path; the change is declaration-only and every failure mode is a compile-time one.

- A member added to an array flows to the type, the output schema, and (for `OcrMode`/`ImageFormat`) the descriptor with no further edit.
- A member removed from an array breaks every site that still names the literal (for example the `SUPPORTED` extension map at `lib/doc-to-md-options.ts:185` or `ocrLine`'s `switch (ocr.status)` at `lib/doc-to-md-handle.ts:118`) at `tsc` time - the intended failure.
- The arrays are `as const`; a consumer that tries to mutate one (`push`, index assignment) is rejected by the compiler.
- The `strings` widening to `readonly T[]` keeps accepting mutable arrays, so no other caller of the helper changes.
- `Value.Check` with a non-member string against a literal-union field fails on the host's installed TypeBox exactly as the existing invalid-string assertions in the schema test do; no new TypeBox feature is relied on.

## Tests

- Every output-schema literal field's complete `Type.Literal` member list equals its shared array at all eight occurrences (`engine`, `tier`, `type`, `ocr.status`, `ocr.mode` on the conversion branch; `type`, `backend`, `sheets[].kind` on the inspection branch), and each member substituted into the branch's own fixture (`projected` or `info`) passes `Value.Check` while a non-member fails - `test/doc_to_md.test.ts`, inside "doc_to_md output schema types every public field and nested member".
- The `ocrMode` and `imageFormat` input-schema literal lists equal `OCR_MODES` / `IMAGE_FORMATS`, and each member passes `Value.Check` against `registeredDocTool().parameters` with a valid input fixture while a non-member fails - same test, the ninth and tenth occurrences of the same comparison.
- No file under `lib/` imports TypeBox after the arrays land - `test/layout.test.ts` (existing, unchanged).
- CLI `--help` text and `skills/doc-to-md/SKILL.md` are unchanged, with no enum listing added to either: `renderHelp` and `scripts/gen-skill.mjs` render `help`/`default`, which this change does not touch - `test/skill-generation.test.ts` (existing, unchanged) pins `SKILL.md` against the generator; no existing test asserts `--help` text, and the `must be one of png, jpg` usage error at `lib/doc-to-md-options.ts:118` joins the same array the schema test pins.
- The derived unions keep their names and members for existing importers (`lib/doc-to-md-core.ts` directly; `bin/pi-quiver.ts` transitively through `DocToMdDetails`), and `BackendKind` stays exported from `lib/doc-to-md-core.ts` - none: `npx tsc --noEmit` inside `npm run test:all` is the check.
- Conversion and inspection results still validate against the schema and match CLI `--json` - `test/doc_to_md.test.ts` existing "structured conversion and info" test (unchanged).

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` `## Unreleased` - one bullet: result and option enums are declared once in `lib/`, so a member cannot drift between the TypeScript type and the tool schema `(#38)`; clears "non-obvious rationale / decisions that outlive the PR"
- Derived / memory docs invalidated: none

Materiality per `reference/documentation-impact.md`: `doc/doc-to-md.md` "Structured results" describes the contract a script author reads, and that contract's shape and members do not change, so it is dropped. `AGENTS.md` gains no rule: the derived-type construction makes the compiler enforce the single source, and a rule restating it would be a code mirror.

## Out of scope

- Cross-language producer validation: `scripts/doc_to_md.py` emits OCR status, sheet kind, and DOCX engine strings that `lib/doc-to-md-core.ts` parses as `TierJson` without runtime checks. The shared arrays cannot catch a Python-side string the array lacks; the fixture-driven conversions in `test/doc_to_md.test.ts` are the existing pin. User declined a producer-side scan (questionary option C).
- Runtime validation of `structuredContent` against `outputSchema` in the extension; pi forwards unvalidated by design (#36).
- A dedicated `lib/doc-to-md-enums.ts` module (approach B); rejected because the per-concern `lib/doc-to-md-*.ts` layout already has an owner for each vocabulary.
- Adding, removing, or renaming any enum member.

## Open questions

None.
