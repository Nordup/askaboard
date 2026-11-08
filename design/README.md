# `design/`: Paper design exports

These files are exported from the Paper file of the paused tutor
(`01KZAH9BZ4FRZXKG2309B7SSRG`). They are not edited by hand: fix a value in
Paper and export it again.

| File | Contents | Read by |
| --- | --- | --- |
| `tokens.json` | Every design token, with its type, value and description (Paper's `get_tokens`, `format: "json"`) | `web/src/design/tokens.css` copies its values |
| `icons.json` | Every product glyph: viewBox, size, stroke weight and SVG path data | `web/src/design/Icon.tsx` |

`contentHash.tokens` at the top of `tokens.json` is Paper's hash of the token
set. If it differs from the hash in the live file, this export is stale.

Askaboard (`space/`) does not use these files. Its design system is
[`docs/learning-space/design-system.md`](../docs/learning-space/design-system.md).
