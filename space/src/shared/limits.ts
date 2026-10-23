/**
 * Caps on every size an agent controls through the MCP tools. The main
 * process refuses larger values in the zod schemas; the renderer checks them
 * again, so a bad value never reaches a loop or an allocation.
 */

/** The largest |x| or |y| an agent may give, in board points. */
export const MAX_COORD = 100_000
/** The largest width or height an agent may ask for (find_space, frames), in board points. */
export const MAX_BOX_SIZE = 20_000
/** The largest region a screenshot may cover, in board points. */
export const MAX_REGION_SIZE = 2 * MAX_COORD
/** Points in one draw_ink call, after the strokes are densified. */
export const MAX_INK_POINTS = 20_000
/** Strokes in one draw_ink call. */
export const MAX_INK_LINES = 200
/** Characters of an svg_path "d" string. */
export const MAX_SVG_PATH_CHARS = 100_000
/** Characters of one write_html call. */
export const MAX_HTML_CHARS = 1_000_000
/** Elements of one write_html call. */
export const MAX_HTML_ELEMENTS = 5_000
/** Element nesting depth of one write_html call. */
export const MAX_HTML_DEPTH = 48
/** Characters of one text node (set_text). */
export const MAX_TEXT_CHARS = 100_000
/** Characters of one style value. */
export const MAX_STYLE_CHARS = 2_000
/** Characters of a node name. */
export const MAX_NAME_CHARS = 200
/** Ids or updates in one call. */
export const MAX_LIST_ITEMS = 1_000
/** Nesting depth of **bold** / *italic* markup in text. */
export const MAX_MARKUP_DEPTH = 16
