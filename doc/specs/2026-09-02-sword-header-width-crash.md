# sword-header: respect terminal width in header render

## Problem

With `quiver.swordHeader` enabled, pi hard-crashes (`uncaughtException`) whenever
the terminal or pane is narrower than 80 columns (the pi-tui check is strict
`visibleWidth(line) > width`, so an 80-column terminal is safe):

```
Error: Rendered line 5 exceeds terminal width (78 > 77)
```

Root cause (triaged and evidenced): `extensions/sword-header.ts:71-76` installs a
persistent screen header via `ctx.ui.setHeader` whose `render(_width)` ignores the
width argument and returns fixed-width ASCII art. The art's visible line widths are
30/30/31/30/**78**/**80**/77/30/31/30 - natural maximum 80 columns. pi-tui's
`TuiMainScreen.doRender` (`tui-main-screen.js:475-489` in the installed
`@earendil-works/pi-tui`) throws on any redrawn line wider than the terminal. The
exception fires on the differential re-render path whenever the header lines
repaint at a too-narrow width - a pane resize is one way that state is reached
(a pure width change itself goes through `fullRender`, which skips the overflow
check; the throw lives in the differential loop) - which is why it manifests
mid-session in narrow Herdr panes ("whenever my terminal window is not max
screen").

Width plumbing is verified single-source: `tui-main-screen.js:214` reads
`width = this.terminal.columns` (`terminal.js:387-388`:
`process.stdout.columns || $COLUMNS || 80`) and passes that exact value to every
component's `render(width)` (`:228`); the overflow check compares against the same
variable. Therefore using the `width` parameter is correct by construction on every
host terminal (Herdr, Ghostty, Linux terminals) - there is no second width to read
and no host-specific divergence possible between what `render` receives and what
the check enforces.

## Decision

Plain per-line truncation (user-selected over hide-below-natural-width and
truncate-with-floor alternatives):

- In the `setHeader` component in `extensions/sword-header.ts`, `render(width)`
  maps each colored line through `truncateToWidth(line, width, "")`, imported from
  `@earendil-works/pi-tui` (already a peer dependency; exported at
  `dist/index.d.ts`).
- Truncation happens **after** theme coloring (`renderSwordLines(theme)`), so ANSI
  sequences remain valid - `truncateToWidth` is ANSI/control-sequence aware
  (`utils.d.ts:60-73`).
- Empty-string ellipsis: a hard clip, never `...` injected into ASCII art.
- `invalidate()` stays a no-op: pi-tui re-calls `render` with the current width on
  every redraw, so there is no cached state to bust.

This matches the pattern pi core itself uses (`footer.js:156-217`: measure with
`visibleWidth`, truncate with `truncateToWidth`) and the canonical minimal
component in pi's TUI docs (`docs/tui.md:312-326` in the installed package).

## Behavior

| Width | Result |
|---|---|
| >= 80 | Lines unchanged (`truncateToWidth` is a no-op at/above natural width) |
| 1-79 | Every line hard-clipped to `width`; sword partially visible, no crash |
| 0 | Lines clip to empty strings; still valid render output, no crash |

No hide threshold, no compact fallback, no width-dependent branching beyond the
single `truncateToWidth` call. We will not special-case any width.

## Out of scope

- Changing the art, its coloring, or the `swordLines()` segment structure.
- The `/builtin-header` restore command (`extensions/sword-header.ts:79-84`) -
  unchanged.
- Upstream pi-tui/pi-core changes (e.g. auto-clipping at the `setHeader`
  boundary) - the component contract explicitly places truncation on the
  component, per the crash message and `docs/tui.md`.
- Other pi-quiver renderers: they build on `Text`, which wraps responsively; only
  sword-header registers a raw fixed-width component.

## Testing

Extend `test/sword-header.test.ts` (node --test, existing suite):

- Capture the component: run the extension with an enabled `swordHeader` config
  and a mock `ctx.ui` whose `setHeader` records the factory; invoke the factory
  with a stub tui and a theme stub whose `fg` has the production arity -
  `fg: (_color, text) => wrap(text)` where `wrap` adds real ANSI color
  sequences (production calls `theme.fg(tok, text)` with two args,
  `extensions/sword-header.ts:63`; a unary stub would return the color token
  and silently break every width assertion).
- Invariant assertions, not golden clipped strings (the art may change later):
  - At widths 77 (the reported crash width), 30, and 1: every line returned by
    `render(width)` satisfies `visibleWidth(line) <= width` (measured with
    pi-tui's `visibleWidth`).
  - At width 120: lines are identical to the expected untruncated output built
    in the test from the exported `swordLines()` mapped through the same theme
    stub (`renderSwordLines` is module-private - the extension exports only
    `coerce`, `swordLines`, and the default; do not export it for the test).
- Existing tests (config coercion, sword shape, malformed-settings notification)
  remain untouched.

Verification command: `npm run test:all` (unit tests + typecheck), same as CI.

## Documentation impact

(materiality bar: a doc entry is listed only when a reader's behavior would
change without it; code-mirroring entries are excluded)

- Feature / user-facing docs introduced: none
- Materially amended existing docs: none (README mentions sword-header only in
  the architecture-table row at `README.md:68` and the `quiver.swordHeader`
  settings key - neither describes width mechanics; CHANGELOG gets a fix entry
  under `## Unreleased`, promoted to the next `## vX.Y.Z - date` heading at
  release per repo convention)
- Derived / memory docs invalidated: none

## Open questions

None - all four scout questions were resolved during the questionary (truncate;
hard clip with `""` ellipsis; no minimum-width threshold; invariant-style test
assertions).
