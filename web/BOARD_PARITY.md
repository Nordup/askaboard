# Board behavior port

This document records the web board contracts against the current SwiftUI implementation. The source of truth is the Swift board feature and its tests; the web board keeps the wire spelling of scene kinds so saved tutor scenes round-trip without lossy adapters.

## Interaction and state

| Contract | Web behavior | Swift reference |
| --- | --- | --- |
| Learner tools | Pen, highlighter, vector-style whole-stroke eraser, and lasso are the four board tools. Pen widths map to 2.5, 5, and 10 logical points; highlighter uses four times the selected width at 0.3 opacity. Erasing uses a fixed radius independent of pen width. | `MathTutor/Domain/BoardTool.swift`, `MathTutor/Features/Board/BoardInk.swift`, `MathTutor/Features/Board/BoardCanvas.swift` |
| Lasso | Selects whole learner strokes, moves the selected strokes as one edit, and supports Delete/Backspace. A move records one history snapshot and can be undone/redone. Lasso never creates a tutor attachment. | `MathTutor/Features/Board/BoardInk.swift`, `MathTutorTests/BoardSelectionTests.swift`, `MathTutorTests/BoardInkTests.swift` |
| Tutor selection | The controlled `selectionMode` draws a separate rectangular marquee. A selection must be at least 24 screen points on both sides. Its logical rectangle remains attached to the same board content across viewport resizing and camera changes; Escape or disarming selection clears the attachment. | `MathTutor/Features/Board/BoardSelectionMarquee.swift`, `MathTutor/Features/Board/BoardCapture.swift`, `MathTutor/Features/Board/BoardScreen.swift` |
| History and clearing | Undo/redo availability is reported to the host. Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, and Ctrl+Y operate on ink history. Clear removes learner ink only; tutor scene elements remain. | `MathTutor/Features/Board/BoardCapture.swift`, `MathTutor/Features/Board/BoardScreen.swift` |
| Camera | Middle mouse, Space-drag, touch, or the legacy hand tool pans. Wheel pans; Ctrl/Cmd+wheel zooms around the pointer. Zoom is clamped to 0.25–3. Camera changes are debounced and persisted without changing the session's activity timestamp. “Center on work” centers the content at the current zoom, or returns to the logical origin when empty. | `MathTutor/Features/Board/BoardGeometry.swift`, `MathTutor/Features/Board/BoardCanvas.swift`, `MathTutor/Features/Board/BoardCapture.swift`, `MathTutor/TutorStore.swift` |
| Interrupted input | `pointercancel` drops unfinished ink/marquees and rolls back an in-flight erase, move, or pan. Resize observation updates the viewport without rewriting the logical selection. | `MathTutor/Features/Board/BoardCanvas.swift`, `MathTutor/Features/Board/BoardSelectionMarquee.swift` |

## Scene, rendering, and capture

`BoardElement` is a discriminated union covering all 16 Swift scene kinds: `text`, `line`, `arrow`, `rectangle`, `ellipse`, `circle`, `polygon`, `polyline`, `freehand`, `arc`, `angle_marker`, `path`, `math_text`, `ink_text`, `image`, and `svg`. Adding a new kind makes the renderer and bounds switch exhaustive at compile time. Shared style accepts both the current flattened wire keys and older nested `style` values.

Live rendering and capture use the same semantic scene and learner strokes. Bounds include style rotation, stroke extent, arrowheads, SVG dimensions, and measured KaTeX raster dimensions. Images load from the content-addressed blob endpoint and keep a framed placeholder while unavailable. KaTeX is measured in the browser and rasterized into origin-clean PNGs for both the live scene and captures; Shantell Sans is bundled locally for tutor handwriting and embedded in detached captures. Tutor-authored SVG is sanitized before display/export.

The overview uses the complete padded content extent (24 logical points of padding) at a maximum 900-pixel long side. Tutor rectangles are frozen in logical board coordinates and serialized as percentages of that extent. Model `view_board` regions use the same top-left percentage frame, are clamped to the board with a 1% minimum side, and are rendered from vectors at a maximum 1,536-pixel long side (up to 2× scale). Both capture paths flatten onto white paper and include semantic scene plus learner ink.

## Session persistence

The IndexedDB journal preserves the last-opened session across reloads, stores deletion tombstones while offline, and serializes writes so an older snapshot cannot win a race. Camera-only edits are saved but preserve `updatedAt`, so navigating the board does not reorder a session. Creating a session retains the previous one; resetting removes only the active session and starts with the Swift defaults (`gpt-5.6-luna`, high reasoning effort).

## Deliberate platform differences

The web surface uses Pointer Events and a pressure-aware canvas instead of PencilKit, so live nib smoothing and Apple Pencil prediction are platform-specific. The browser eraser removes a whole intersected stroke, matching vector-eraser intent. KaTeX rasterization and text measurement reproduce the scene's placement and content in a portable browser renderer, but do not promise pixel-identical CoreText/PencilKit glyph rasterization.

## Verification

Focused geometry, scene, history, and workspace persistence tests:

```sh
cd web
npx vitest run src/board src/workspace/store.test.ts --reporter=dot
```
