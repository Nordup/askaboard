/**
 * Lab switches: settings for live-drawing experiments (scripts/lab/), read
 * from the environment when the app starts. All are off by default, and off
 * they change nothing.
 *
 * LS_LAB_NO_CODE=1: code items do not exist for agents. Scene programs have
 * no shader(), canvas() or program() (live-prelude.js), and every agent text
 * leaves out what points to them:
 *
 * - in the markdown resources (brief.md, guide.md, instructions.md), a span
 *   between `<!-- code-items -->` and `<!-- /code-items -->` (or
 *   `<!-- /code-items: other text -->`, which puts "other text" in its place);
 * - in tool descriptions (mcp.ts), a clause wrapped in codeItems().
 *
 * Without the switch, the markers go and the text between them stays, so the
 * text is the same as without markers, byte for byte.
 */

export const NO_CODE_ITEMS = process.env.LS_LAB_NO_CODE === '1'

/** A clause of an agent text in code (a tool description): the text, or `without` when code items are off. */
export function codeItems(text: string, without = ''): string {
  return NO_CODE_ITEMS ? without : text
}

const OPEN = '<!-- code-items -->'
const CLOSE = '<!-- /code-items'
const END = ' -->'

/**
 * A markdown resource with its code-item spans applied: kept without their
 * markers, or (no code items) replaced by their other text. A marker without
 * its pair throws, so a broken edit cannot pass silently.
 */
export function codeItemText(text: string, name: string): string {
  let out = ''
  let from = 0
  for (;;) {
    const open = text.indexOf(OPEN, from)
    const stray = text.indexOf(CLOSE, from)
    if (open < 0) {
      if (stray >= 0) throw new Error(`${name}: a ${CLOSE} marker without ${OPEN}`)
      return out + text.slice(from)
    }
    if (stray >= 0 && stray < open) throw new Error(`${name}: a ${CLOSE} marker without ${OPEN}`)
    const close = text.indexOf(CLOSE, open + OPEN.length)
    if (close < 0) throw new Error(`${name}: ${OPEN} without its ${CLOSE} -->`)
    const inner = text.slice(open + OPEN.length, close)
    if (inner.includes(OPEN)) throw new Error(`${name}: nested ${OPEN} markers`)
    const end = text.indexOf(END, close + CLOSE.length)
    if (end < 0) throw new Error(`${name}: an unterminated ${CLOSE} marker`)
    const tail = text.slice(close + CLOSE.length, end)
    let without = ''
    if (tail.startsWith(':')) without = tail.slice(1).trim()
    else if (tail !== '') throw new Error(`${name}: a ${CLOSE} marker in an unknown form`)
    out += text.slice(from, open) + (NO_CODE_ITEMS ? without : inner)
    from = end + END.length
  }
}
