import { resourcePath } from './resources'

/**
 * Lab switches: settings for live-drawing experiments (scripts/lab/), read
 * from the environment when the app starts. All are off by default, and off
 * they change nothing.
 *
 * LS_LAB_NO_CODE=1: code items do not exist for agents. Scene programs have
 * no shader(), canvas() or program() (live-prelude.js), and every agent text
 * leaves out what points to them.
 *
 * LS_LAB_NO_HTML=1: HTML material does not exist for agents. Scene programs
 * have no html(), get_html is not offered, and every agent text leaves out
 * what points to HTML material.
 *
 * LS_LAB_BRIEF=<absolute path>: the brief comes from that file instead of
 * resources/brief.md (the AGENTS.md block and get_brief). The markers below
 * apply to it too.
 *
 * In the markdown resources (brief.md, guide.md, instructions.md) a switch's
 * span is marked `<!-- tag -->` … `<!-- /tag -->`, or `<!-- /tag: other text -->`,
 * which puts "other text" in its place when the switch is on (tags:
 * code-items, html). In tool descriptions (mcp.ts) a clause is wrapped in
 * codeItems() or htmlMaterial(). Without the switch, the markers go and the
 * text between them stays, so the text is the same as without markers, byte
 * for byte.
 */

export const NO_CODE_ITEMS = process.env.LS_LAB_NO_CODE === '1'
export const NO_HTML = process.env.LS_LAB_NO_HTML === '1'
const BRIEF_FILE = process.env.LS_LAB_BRIEF || null

/** The file the brief is read from. */
export function briefPath(): string {
  return BRIEF_FILE ?? resourcePath('brief.md')
}

/** A clause of an agent text in code (a tool description): the text, or `without` when code items are off. */
export function codeItems(text: string, without = ''): string {
  return NO_CODE_ITEMS ? without : text
}

/** A clause of an agent text in code (a tool description): the text, or `without` when HTML material is off. */
export function htmlMaterial(text: string, without = ''): string {
  return NO_HTML ? without : text
}

/** The spans of one tag: kept without their markers, or (switch on) replaced by their other text. A marker without its pair throws. */
function spans(text: string, name: string, tag: string, on: boolean): string {
  const OPEN = `<!-- ${tag} -->`
  const CLOSE = `<!-- /${tag}`
  const END = ' -->'
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
    out += text.slice(from, open) + (on ? without : inner)
    from = end + END.length
  }
}

/** A markdown resource with the switches' spans applied (code items first, then HTML material). */
export function labText(text: string, name: string): string {
  return spans(spans(text, name, 'code-items', NO_CODE_ITEMS), name, 'html', NO_HTML)
}
