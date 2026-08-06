# `design/` — the machine-readable design source

Everything in this directory is **exported from the Paper file, not authored here**:

> AI Whiteboard Tutor — Design System, Components & Page
> `01KZAH9BZ4FRZXKG2309B7SSRG`

It is the input to code generation. Nothing in it is hand-edited — if a value looks
wrong, fix it in Paper and re-export, so the design file stays the single source of
truth and the code cannot drift from it silently.

| File | Contents | Generated into |
|---|---|---|
| `tokens.json` | Every design token with its type, value, and the designer's own description | `MathTutor/DesignSystem/Generated/DesignTokens.swift` |
| `icons.json` | Every product glyph: viewBox, render size, stroke weight, dash texture, and verbatim SVG path data | `MathTutor/DesignSystem/Generated/IconPaths.swift` |
| `reference/screen-0*.png` | The four live screens exported at 1×, i.e. exactly 1376 × 1032 | Nothing — these are the visual-diff targets |

`reference/` exists so the built app can be checked against the design rather than against
someone's memory of it. A simulator screenshot of an iPad Pro 13" is 2752 × 2064 (2× the
point size), so halve it before comparing.

Human-readable specs — the prose, rationale, and layout arithmetic that tokens
cannot express — live in [`../docs/design-system/`](../docs/design-system/).

## Re-exporting

`tokens.json` is the output of Paper's `get_tokens` with `format: "json"`, verbatim.
`contentHash.tokens` at the top of that file is Paper's own hash of the token set: if
it differs from the hash in the live file, this export is stale.

## What is *not* here

Shadows. Paper has no shadow token type, so the elevation scale is documented as prose
on the Foundations board and transcribed by hand into `DesignSystem/Elevation.swift`.
That file is the one place where a design value is hand-carried, and it says so.
