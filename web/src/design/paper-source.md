# Paper product UI source

This UI is a code port of the live Paper document **AI Whiteboard Tutor — Design System, Components & Page**, file `01KZAH9BZ4FRZXKG2309B7SSRG`, product page `1-0`. Read with Paper MCP `get_guide(topic="paper-mcp-instructions")` first. No Paper artboard or token was edited.

## Exact exports used

- `get_basic_info`: token hash `eda65190`; artboards `OR-0` (Board + Tutor), `1AB-0` (in conversation), `RJ-0` (collapsed), `ZU-0` (full screen), `60P-0` (sessions), `3KT-0` (settings), `7U1-0` and `84H-0` (voice), `FH2-0` (unified activity). The artboards are 1376 × 1032.
- `get_tree_summary(OR-0)`: whiteboard 863 × 976, tool rail 72 × 628, tutor 337 × 976. Their positions are x=485, x=389 and x=28 respectively; the live JSX export preserves the 24 px between surfaces and 28 px edge inset.
- `get_jsx(OR-0, inline-styles)`: exact screen, board and panel surface tokens, 28 px outer edge, toolbar 72 px width, 54 px tool slots, 27 px swatches, 301 px content column, 337 px chat panel, and Source Sans 3 text. It also confirms the only selected-tool fill is `--color-brand-tint`, with violet `--color-brand` as the selected pen glyph.
- `get_tree_summary(1AB-0)`: message thread, bubble, board rail and bottom control structure for a live conversation.
- `get_tree_summary(60P-0)`: session drawer is contained in the tutor panel, with recent sessions, new-session action and settings action.
- `get_tree_summary(3KT-0)` and `get_jsx(4TN-0, inline-styles)`: 760 × 560 Settings window, 216 px settings navigation, 32 px pane inset, Tutor model and Reasoning effort rows at 120 px each, using the paper divider and Source Sans 3 hierarchy.
- `get_tree_summary(3Q1-0)` and `get_screenshot(3Q1-0)`: session plan lives inline in the tutor thread with kicker, title, goal, numbered steps, outcomes and primary action. The screenshot was used only to understand the authored content hierarchy; code style values are taken from JSX and token exports.
- `get_jsx(7TV-0, inline-styles)` and `get_jsx(7RN-0, inline-styles)`: the exact four-bar voice-chat glyph and its 38 px violet round composer button.
- `get_jsx(QO-0, inline-styles)`, `get_jsx(7X6-0, inline-styles)`, `get_jsx(85E-0, inline-styles)` and `get_jsx(T8-0, inline-styles)`: the greeting, live, resting and collapsed tutor orb use Paper-exported gradients, positions, sizes and eye shapes.
- `get_tree_summary(7U1-0)`, `get_tree_summary(84H-0)`, `get_tree_summary(FH2-0)`: live voice, rest, research source and activity thread patterns.
- `design/tokens.json` and `design/icons.json` are the existing checked-in Paper exports. `tokens.css` copies the product tokens used by the web shell, and `Icon.tsx` renders the exact exported SVG path data.

## Browser adaptations

The Paper artboard height (1032 px) is replaced by viewport height minus its 28 px top/bottom insets. The 337 px tutor column, 72 px rail, 24 px gaps and corner radius are retained at desktop widths; the panel may be dragged to resize because the web client must work at different window sizes. At narrow widths the tutor panel and rail overlay the board to preserve drawing space. These are layout adaptations; no new palette, typography, component styling or decorative content was introduced.

The settings selectors derive their model and effort choices from the API config; the voice launcher is disabled when Live is unavailable.

Board actions, session CRUD and file selection are interactive controls required by the web client. The hand/selection interaction remains with the board and lasso control; no additional toolbar glyph was invented.
