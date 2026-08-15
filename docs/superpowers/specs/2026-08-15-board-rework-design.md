# Board rework: native drawing, images, search, and scripts

Date: 2026-08-15
Status: Approved design, pre-implementation

## Problem

The board becomes slow when the tutor draws many `svg` elements. The cause
is the render path, not the SVG render step. `BoardSceneOverlayView` repaints
the whole scene on every scroll frame. Each repaint parses each element's PDF
data again (`CGDataProvider` → `CGPDFDocument` → `drawPDFPage`). The cost per
frame grows with the element count, on the main thread.

The `svg` element also constrains the agent. It requires a frame
(`x, y, width, height`), renders through an offscreen `WKWebView` with a fixed
2-second settle delay, and serializes renders one at a time.

The product vision widened: a general tutor for studying, not only math. The
board is the agent's first teaching surface. It must draw anything — algebra,
physics, biology, charts, curves — pull images from the internet, and place
script output. Recorded turns show the model reaches for raw SVG mostly to get
typography the native `text` element lacks, math notation above all.

## Goals

- The agent draws native, unconstrained, revisable content anywhere on the
  board, for any subject.
- SVG markup is a first-class, encouraged element kind, with no frame.
- Math notation renders natively on the board with the same engine as chat.
- The agent searches the web, fetches images onto the board, and runs scripts
  whose output lands on the board.
- Pan and zoom stay smooth with hundreds of elements: culling, rasterization,
  GPU compositing.

## Non-goals

- Board composition/auto-layout beyond prompt guidance (a later cycle).
- SVG animation, filters, and external resource loads.
- Editing of learner ink by the tutor (unchanged rule).
- A native chart element. Charts come from scripts as images, or from
  primitives and `path`.

## Element model

The scene stays a flat list of id-addressed elements. The 11 geometry
primitives (`text`, `line`, `arrow`, `rectangle`, `ellipse`, `circle`,
`polygon`, `polyline`, `freehand`, `arc`, `angle_marker`) stay unchanged.

### `svg` — reworked, first-class

- `markup`: a complete SVG document. User units are board points, 1:1.
- `x, y`: where the document origin lands, in board points.
- `width, height`: now optional. When present (legacy elements), the client
  fits the document into that frame. When absent, the client computes content
  bounds from the geometry and places it 1:1. New guidance omits them.
- Shared style: `opacity` and `rotation` apply at composite time. `stroke`,
  `fill`, `stroke_width`, `dash` do not apply; the markup owns its styling.
- Server cap: markup length ≤ 100,000 characters.
- Supported subset (stated in the tool description): paths, shapes, groups,
  transforms, linear and radial gradients, `defs`/`use`, text. Not supported:
  filters, animation, masks, external references, `foreignObject`, scripts.

### `path` — new

- `d`: one SVG path string, absolute board points. Parsed by `SVGPath.swift`
  (already supports `M L H V C S Q T A Z`, absolute and relative).
- `fill_rule`: `nonzero` (default) or `evenodd`.
- Shared style applies in full (stroke, fill, width, opacity, dash, rotation).
- Server cap: `d` length ≤ 20,000 characters.

### `math_text` — new

- `x, y`: top-left anchor, board points.
- `latex`: LaTeX source, ≤ 2,000 characters.
- `font_size`: 8–256 board points.
- Typeset by `Vendor/ExtendedSwiftMath` — the same engine as chat, so board
  notation matches chat notation.
- Color comes from `style.stroke`; `opacity` and `rotation` apply.

### `image` — new

- `x, y, width, height`: frame in board points (bitmaps need a frame).
- `blob_id`: a server-issued blob reference. The server validates it exists.
- `opacity` and `rotation` apply.

## Client rendering pipeline

The per-frame repaint goes away. The new shape:

1. **One content layer.** The overlay view stays pinned to the viewport and
   hosts a single content `CALayer`. Each scroll or zoom tick sets only that
   layer's affine transform. Nothing redraws during a pan; the GPU composites.
2. **Per-element rasterized sublayers.** Each element renders once into a
   bitmap, cached by `(content hash, zoom bucket)`, and attaches as a layer.
   Zoom buckets are powers of two, clamped to `[1/8, 4]`. During a pinch the
   bitmaps scale; at gesture end the visible elements re-rasterize at the new
   bucket.
3. **Culling.** Only elements whose bounds intersect the viewport plus a
   margin have mounted layers. `BoardSceneRenderer.bounds(of:)` already
   computes element bounds; SVG bounds come from the parsed document.
4. **Native SVG.** SwiftDraw (zlib license, vendored) parses markup and
   rasterizes it off the main thread. The parsed document and its bounds are
   cached by markup hash. `BoardSVGRenderer`, the offscreen `UIWindow`, the
   content rule list, and the 2-second settle delay are deleted.
5. **Raster cache.** One LRU cache holds the bitmaps with a byte cap
   (128 MB to start). Eviction re-rasterizes on demand.
6. **Capture path.** `view_board` PNGs composite synchronously from the same
   caches after readiness, so what the model sees equals what the learner
   sees. The existing awaitable render path generalizes from `svg` to every
   async element kind (`svg`, `math_text`, `image`).

## Server capabilities

- **`web_search`** — the provider's hosted tool. One entry in the tools
  array; no infrastructure. Citations flow through prose as today.
- **`fetch_image(url)`** — a server tool. Validations: `https` only, resolve
  and block private and link-local addresses, content types `png`, `jpeg`,
  `webp`, `gif`, size ≤ 10 MB, timeout 10 s. Stores the blob, returns
  `blob_id`, width, height. Failures return tool errors the model can act on.
- **Script execution** — the provider's hosted code interpreter. The server
  relays produced files into the blob store and returns their `blob_id`s and
  sizes in the tool result, so the model can place them as `image` elements.
  The exact file-relay API surface is verified in the plan phase.
- **Blob endpoint** — `GET /v1/blobs/{id}` with device-token auth and
  immutable cache headers. The app keeps an on-device disk cache.

## Prompt and tool description changes

- `update_board` guidance flips: SVG markup is encouraged for any multi-part
  figure, anywhere. `math_text` carries all notation — never simulate math
  with plain `text` or SVG `<text>`. `path` carries curves and freeform
  shapes. `image` carries photos and computed charts. Primitives stay for
  simple geometry and quick annotations.
- The description states the supported SVG subset and the 1:1 board-point
  contract plainly.
- The RESEARCH prompt section points at `web_search` and script execution for
  truthful data and figures.

## Error handling

- **Server lint on `svg` markup:** well-formed XML, length caps, a scan for
  unsupported features (filters, animation, masks, external refs, scripts).
  Problems return as warnings in the tool result so the model revises;
  the element is still stored unless the XML is malformed.
- **Client parse failures** render nothing and never crash; the element id
  stays revisable.
- **`fetch_image` and script failures** return tool errors with the reason.
- **Missing blobs** render a neutral placeholder frame.

## Migration

- Persisted scenes with framed `svg` elements render fitted to their frame
  through the new native renderer. No data migration.
- The WebKit renderer and its tests are deleted; `BoardSVGTests` is rewritten
  against SwiftDraw fixtures.
- The prompt and tool schema ship from the backend, so behavior flips without
  an app-store cycle; the app update carries the renderer.

## Testing

- Swift: SVG subset fixture tests (parse → bounds → pixel assertions), a
  SwiftDraw feature probe (paths, gradients, `<style>` blocks, text), raster
  cache and culling invariant tests (prefix-sweep style), content-layer
  transform tests, `math_text` render tests, capture-parity tests.
- Python: schema validation for the four element kinds, `fetch_image` SSRF
  and size guards, lint warnings, tool wiring, blob endpoint auth.
- Tests are written here and run by you (project rule).

## Risks

- **SwiftDraw subset**: CSS `<style>` and `<text>` support needs the feature
  probe first, before the WebKit path is deleted. Fallback inside the same
  architecture: pre-normalize styles server-side during lint.
- **Code interpreter file relay**: the hosted-tool file API needs
  verification during planning.
- **Layer count**: thousands of mounted layers would strain Core Animation;
  culling bounds the mounted set, and the cap is asserted in tests.

## Implementation order (for the plan)

1. Client foundation: content layer, raster cache, culling — existing
   primitives only. The lag fix ships first.
2. Native SVG via SwiftDraw feature probe, then the `svg` rework and WebKit
   deletion.
3. `path` and `math_text` elements, client and server.
4. `image` element, blob endpoint, `fetch_image`.
5. `web_search` and script execution.
6. Prompt flip.
