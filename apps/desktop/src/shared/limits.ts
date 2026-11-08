/**
 * Caps on every size an agent controls through the MCP tools. The main
 * process refuses larger values in the zod schemas; the renderer checks them
 * again, so a bad value never reaches a loop or an allocation.
 */

/** The largest |x| or |y| an agent may give, in board points. */
export const MAX_COORD = 100_000
/** The largest region a screenshot may cover, in board points. */
export const MAX_REGION_SIZE = 2 * MAX_COORD
/** Elements of one html() call. */
export const MAX_HTML_ELEMENTS = 5_000
/** Element nesting depth of one html() call. */
export const MAX_HTML_DEPTH = 48
/** Characters of one style value. */
export const MAX_STYLE_CHARS = 2_000
/** Characters of a node name. */
export const MAX_NAME_CHARS = 200
/** Nesting depth of **bold** / *italic* markup in text. */
export const MAX_MARKUP_DEPTH = 16
/** Bytes of one image brought into the folder's assets/ (an agent's download or data: URL, a pasted image). */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024
