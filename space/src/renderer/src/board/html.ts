import { MAX_COORD, MAX_HTML_DEPTH, MAX_HTML_ELEMENTS, MAX_STYLE_CHARS } from '@shared/limits'
import { isContent, isInk, isKnown, newItemId, STYLE_KEYS, type BoardNode, type NodeStyle } from '@shared/board-format'
import { sanitizeSvg } from './content'
import { parseMarkup, type Run } from './markup'
import type { SceneIndex } from './scene'

/**
 * HTML ⇄ nodes. The agent writes a strict HTML subset with inline styles; it
 * becomes native nodes. DOMParser builds an inert document (no script runs,
 * no resource loads), and only whitelisted tags, attributes and style keys
 * survive. `nodesToHtml` writes the same subset back, so
 * write_html(get_html(x)) gives x again (ids kept with data-id).
 */

const STYLE_KEY_SET: ReadonlySet<string> = new Set(STYLE_KEYS)

/** Tags whose content is dropped with them. */
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'template', 'noscript', 'head', 'title', 'canvas', 'video', 'audio', 'form', 'input', 'button', 'select', 'textarea'])
/** Inline tags: their content joins the surrounding text. */
const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'span', 'a', 'code', 'sub', 'sup', 'u', 'small', 'mark', 'label', 'br', 'kbd', 'abbr', 's', 'del', 'ins', 'q', 'cite', 'time', 'var'])

const HEADING_STYLE: Record<string, NodeStyle> = {
  h1: { fontSize: '28px', fontWeight: '700', lineHeight: '34px' },
  h2: { fontSize: '22px', fontWeight: '600', lineHeight: '28px' },
  h3: { fontSize: '18px', fontWeight: '600', lineHeight: '24px' },
  h4: { fontSize: '16px', fontWeight: '600' },
  h5: { fontSize: '15px', fontWeight: '600' },
  h6: { fontSize: '14px', fontWeight: '600' }
}

/** What a conversion dropped, for the tool result. */
export class Ignored {
  readonly tags = new Set<string>()
  readonly styles = new Set<string>()
  readonly attributes = new Set<string>()
  readonly notes = new Set<string>()

  summary(): { tags?: string[]; styles?: string[]; attributes?: string[]; notes?: string[] } | null {
    const out: Record<string, string[]> = {}
    if (this.tags.size) out.tags = [...this.tags]
    if (this.styles.size) out.styles = [...this.styles]
    if (this.attributes.size) out.attributes = [...this.attributes]
    if (this.notes.size) out.notes = [...this.notes]
    return Object.keys(out).length ? out : null
  }
}

// ---------- Styles ----------

const camel = (name: string): string => name.trim().toLowerCase().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** Read a style attribute as written (shorthands kept). Position keys go to `position`. */
function readStyle(raw: string | null, ignored: Ignored): { style: NodeStyle; position: { absolute: boolean; left?: number; top?: number } } {
  const style: NodeStyle = {}
  const position: { absolute: boolean; left?: number; top?: number } = { absolute: false }
  if (!raw) return { style, position }
  for (const declaration of raw.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const key = camel(declaration.slice(0, colon))
    const value = declaration
      .slice(colon + 1)
      .replace(/!important/i, '')
      .trim()
    if (!key || !value) continue
    if (key === 'position') {
      position.absolute = value === 'absolute'
      continue
    }
    if (value.length > MAX_STYLE_CHARS) {
      ignored.styles.add(`${key} (value over ${MAX_STYLE_CHARS} characters)`)
      continue
    }
    if (key === 'left' || key === 'top') {
      const number = parseFloat(value)
      if (Number.isFinite(number) && Math.abs(number) <= MAX_COORD && /px$|^-?[\d.]+$/.test(value)) position[key] = number
      else ignored.styles.add(`${key}: ${value}`)
      continue
    }
    if (!STYLE_KEY_SET.has(key) || /url\s*\(|expression\s*\(|javascript:/i.test(value)) {
      ignored.styles.add(key)
      continue
    }
    if (key === 'display' && !['flex', 'block', 'none'].includes(value)) {
      ignored.styles.add(`display: ${value}`)
      continue
    }
    style[key] = value
  }
  return { style, position }
}

function styleText(style: NodeStyle, extra: Record<string, string> = {}): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries({ ...extra, ...style })) {
    if (typeof value === 'string' && value !== '') parts.push(`${kebab(key)}: ${value}`)
  }
  return parts.join('; ')
}

// ---------- HTML → drafts ----------

/** A node before it gets an id, a parent and a z. */
export interface Draft {
  kind: 'frame' | 'text' | 'svg' | 'image'
  /** From data-id: reuse this id when it is free. */
  wantedId?: string
  name?: string
  style: NodeStyle
  x: number
  y: number
  text?: string
  markup?: string
  src?: string
  children: Draft[]
}

/** Escape markup characters in plain text: `*` and `\` outside math. */
function escapeText(text: string): string {
  let out = ''
  let inMath = false
  for (const char of text) {
    if (char === '$') inMath = !inMath
    if (!inMath && char === '*') out += '\\*'
    else out += char
  }
  return out
}

function isInlineOnly(element: Element): boolean {
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) continue
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const tag = (child as Element).tagName.toLowerCase()
    if (!INLINE_TAGS.has(tag) || !isInlineOnly(child as Element)) return false
  }
  return true
}

/** Inline content as markup: b/strong → **, i/em → *, br → newline. */
function inlineMarkup(node: Node, ignored: Ignored, pre: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent ?? ''
    return escapeText(pre ? value : value.replace(/\s+/g, ' '))
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const element = node as Element
  const tag = element.tagName.toLowerCase()
  if (DROP_TAGS.has(tag)) {
    ignored.tags.add(tag)
    return ''
  }
  if (tag === 'br') return '\n'
  if (element.getAttribute('style') && tag !== 'b' && tag !== 'strong' && tag !== 'i' && tag !== 'em') {
    ignored.notes.add(`style on inline <${tag}> is dropped (style the whole text block instead)`)
  }
  const inner = [...element.childNodes].map((child) => inlineMarkup(child, ignored, pre)).join('')
  if (!inner.trim()) return inner
  // Markers hug the words: leading and trailing spaces stay outside.
  const wrap = (marker: string): string => {
    const lead = inner.match(/^\s*/)?.[0] ?? ''
    const trail = inner.match(/\s*$/)?.[0] ?? ''
    return `${lead}${marker}${inner.trim()}${marker}${trail}`
  }
  if (tag === 'b' || tag === 'strong') return wrap('**')
  if (tag === 'i' || tag === 'em') return wrap('*')
  if (!INLINE_TAGS.has(tag)) ignored.tags.add(tag)
  return inner
}

function cleanText(text: string, pre: boolean): string {
  if (pre) return text.replace(/^\n/, '').replace(/\n$/, '')
  return text
    .split('\n')
    .map((line) => line.replace(/ +/g, ' ').trim())
    .join('\n')
    .trim()
}

function baseDraft(element: Element, kind: Draft['kind'], ignored: Ignored): { draft: Draft; absolute: boolean } {
  const { style, position } = readStyle(element.getAttribute('style'), ignored)
  for (const attribute of element.getAttributeNames()) {
    if (!['style', 'data-id', 'layer-name', 'src', 'alt', 'width', 'height'].includes(attribute) && !attribute.startsWith('xmlns')) {
      if (kind !== 'svg') ignored.attributes.add(attribute)
    }
  }
  const draft: Draft = { kind, style, x: position.left ?? 0, y: position.top ?? 0, children: [] }
  const wanted = element.getAttribute('data-id')
  if (wanted) draft.wantedId = wanted
  const name = element.getAttribute('layer-name')
  if (name) draft.name = name
  return { draft, absolute: position.absolute }
}

function sizeFromAttributes(element: Element, style: NodeStyle): void {
  for (const key of ['width', 'height'] as const) {
    if (style[key]) continue
    const value = element.getAttribute(key)
    if (value && /^\d+(\.\d+)?(px)?$/.test(value.trim())) style[key] = `${parseFloat(value)}px`
  }
}

function textDraft(element: Element, ignored: Ignored, prefix = ''): { draft: Draft; absolute: boolean } {
  const tag = element.tagName.toLowerCase()
  const result = baseDraft(element, 'text', ignored)
  const pre = tag === 'pre' || result.draft.style.whiteSpace === 'pre' || result.draft.style.whiteSpace === 'pre-wrap'
  if (tag === 'pre') {
    result.draft.style = { whiteSpace: 'pre', fontFamily: 'var(--ls-mono)', ...result.draft.style }
    // Code: every * and $ is literal.
    result.draft.text = (element.textContent ?? '').replace(/^\n/, '').replace(/\n$/, '').replace(/([\\*$])/g, '\\$1')
    return result
  }
  if (HEADING_STYLE[tag]) result.draft.style = { ...HEADING_STYLE[tag], ...result.draft.style }
  const markup = [...element.childNodes].map((child) => inlineMarkup(child, ignored, pre)).join('')
  result.draft.text = prefix + cleanText(markup, pre)
  return result
}

/** Convert one element. Returns null when it is dropped. */
function convertElement(element: Element, ignored: Ignored): { draft: Draft; absolute: boolean } | null {
  const tag = element.tagName.toLowerCase()
  if (DROP_TAGS.has(tag)) {
    ignored.tags.add(tag)
    return null
  }
  if (tag === 'svg') {
    const result = baseDraft(element, 'svg', ignored)
    sizeFromAttributes(element, result.draft.style)
    const viewBox = element.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
    if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite)) {
      if (!result.draft.style.width) result.draft.style.width = `${viewBox[2]}px`
      if (!result.draft.style.height && !element.getAttribute('height')) result.draft.style.height = `${viewBox[3]}px`
    }
    const clone = element.cloneNode(true) as Element
    for (const attribute of ['style', 'data-id', 'layer-name']) clone.removeAttribute(attribute)
    const markup = sanitizeSvg(clone.outerHTML)
    if (!markup.trim().startsWith('<svg')) {
      ignored.tags.add('svg (nothing safe was left)')
      return null
    }
    result.draft.markup = markup
    return result
  }
  if (tag === 'img') {
    const result = baseDraft(element, 'image', ignored)
    sizeFromAttributes(element, result.draft.style)
    result.draft.src = element.getAttribute('src') ?? ''
    if (!result.draft.src) {
      ignored.notes.add('<img> without src')
      return null
    }
    return result
  }
  if (tag === 'table' || tag === 'tr' || tag === 'td' || tag === 'th' || tag === 'tbody' || tag === 'thead') {
    ignored.notes.add('tables become plain flex boxes; use flex rows and columns')
  }
  if (tag === 'ul' || tag === 'ol') {
    const result = baseDraft(element, 'frame', ignored)
    result.draft.style = { display: 'flex', flexDirection: 'column', gap: '4px', ...result.draft.style }
    let number = 1
    for (const child of element.children) {
      if (child.tagName.toLowerCase() !== 'li') {
        const other = convertElement(child, ignored)
        if (other) result.draft.children.push(other.draft)
        continue
      }
      const prefix = tag === 'ol' ? `${number++}. ` : '• '
      if (isInlineOnly(child)) result.draft.children.push(textDraft(child, ignored, prefix).draft)
      else {
        const nested = convertBlock(child, ignored)
        if (nested) result.draft.children.push(nested.draft)
      }
    }
    return result
  }
  if (INLINE_TAGS.has(tag) || isInlineOnly(element) || tag === 'pre' || /^h[1-6]$/.test(tag) || tag === 'p') {
    if (tag === 'p' || /^h[1-6]$/.test(tag) || tag === 'pre' || isInlineOnly(element)) {
      const result = textDraft(element, ignored)
      return result.draft.text || result.draft.style.width || result.draft.style.height ? result : null
    }
  }
  return convertBlock(element, ignored)
}

/** A block with element children: a frame. Loose inline runs become text nodes. */
function convertBlock(element: Element, ignored: Ignored): { draft: Draft; absolute: boolean } | null {
  const result = baseDraft(element, 'frame', ignored)
  const children: { draft: Draft; absolute: boolean }[] = []
  let run: Node[] = []
  const flush = (): void => {
    const markup = cleanText(run.map((node) => inlineMarkup(node, ignored, false)).join(''), false)
    run = []
    if (markup) children.push({ draft: { kind: 'text', style: {}, x: 0, y: 0, text: markup, children: [] }, absolute: false })
  }
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE || (child.nodeType === Node.ELEMENT_NODE && INLINE_TAGS.has((child as Element).tagName.toLowerCase()) && isInlineOnly(child as Element))) {
      run.push(child)
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    flush()
    const converted = convertElement(child as Element, ignored)
    if (converted) children.push(converted)
  }
  flush()
  const style = result.draft.style
  const free = children.some((child) => child.absolute)
  if (style.display !== 'flex' && style.display !== 'none') {
    if (free) delete style.display
    else {
      // Block flow without margins is a flex column; say so once.
      if (children.length > 1) ignored.notes.add('block layout became flex column (set display:flex yourself to control it)')
      style.display = 'flex'
      if (!style.flexDirection) style.flexDirection = 'column'
    }
  } else if (style.display === 'flex' && free) {
    ignored.notes.add('position:absolute children of a flex box are placed by the flex layout')
  }
  result.draft.children = children.map((child) => child.draft)
  return result
}

/** Refuse HTML with too many elements or too deep a nesting, before the recursive conversion. */
function checkSize(body: HTMLElement): void {
  const count = body.getElementsByTagName('*').length
  if (count > MAX_HTML_ELEMENTS) throw new Error(`The HTML has ${count} elements; the limit is ${MAX_HTML_ELEMENTS}. Write it in smaller parts.`)
  const stack: [Element, number][] = [[body, 0]]
  while (stack.length) {
    const [element, depth] = stack.pop() as [Element, number]
    if (depth > MAX_HTML_DEPTH) throw new Error(`The HTML is nested more than ${MAX_HTML_DEPTH} elements deep.`)
    for (const child of element.children) stack.push([child, depth + 1])
  }
}

/** Parse agent HTML into drafts. Nothing in it runs or loads. */
export function htmlToDrafts(html: string, ignored: Ignored): Draft[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  checkSize(doc.body)
  const drafts: Draft[] = []
  let loose = ''
  for (const child of doc.body.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      loose += child.textContent ?? ''
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const converted = convertElement(child as Element, ignored)
    if (converted) drafts.push(converted.draft)
  }
  if (loose.trim()) {
    ignored.notes.add('top-level loose text was wrapped in a text node')
    drafts.unshift({ kind: 'text', style: {}, x: 0, y: 0, text: escapeText(cleanText(loose.replace(/\s+/g, ' '), false)), children: [] })
  }
  return drafts
}

/** Every draft in a tree, depth first. */
export function walkDrafts(drafts: readonly Draft[], visit: (draft: Draft) => void): void {
  for (const draft of drafts) {
    visit(draft)
    walkDrafts(draft.children, visit)
  }
}

/**
 * Turn drafts into nodes under `parent` (undefined = top level). Ids from
 * data-id are reused when `canUse(id)` says they are free.
 */
export function draftsToNodes(
  drafts: readonly Draft[],
  options: { parent?: string; zStart: number; canUse(id: string): boolean; author: 'agent' | 'learner' }
): { nodes: BoardNode[]; roots: string[]; named: Record<string, string> } {
  const nodes: BoardNode[] = []
  const named: Record<string, string> = {}
  const used = new Set<string>()
  const build = (draft: Draft, parent: string | undefined, z: number): string => {
    const id =
      draft.wantedId && !used.has(draft.wantedId) && /^[\w-]{1,64}$/.test(draft.wantedId) && options.canUse(draft.wantedId)
        ? draft.wantedId
        : newItemId('n')
    used.add(id)
    if (draft.name) named[draft.name] = id
    const base = { id, kind: draft.kind, ...(draft.name ? { name: draft.name } : {}), ...(parent ? { parent } : {}), x: draft.x, y: draft.y, z, author: options.author, seq: 0 }
    const fields =
      draft.kind === 'text'
        ? { text: draft.text ?? '', style: draft.style }
        : draft.kind === 'svg'
          ? { style: draft.style, markup: draft.markup ?? '' }
          : draft.kind === 'image'
            ? { src: draft.src ?? '', style: draft.style }
            : { style: draft.style }
    nodes.push({ ...base, ...fields } as BoardNode)
    draft.children.forEach((child, index) => build(child, id, index + 1))
    return id
  }
  const roots = drafts.map((draft, index) => build(draft, options.parent, options.zStart + index))
  return { nodes, roots, named }
}

// ---------- Nodes → HTML ----------

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttribute = (text: string): string => escapeHtml(text).replace(/"/g, '&quot;')

function runsToHtml(runs: Run[]): string {
  return runs
    .map((run) => {
      switch (run.kind) {
        case 'text':
          // A literal * stays plain: write_html escapes plain text again on the way in.
          return escapeHtml(run.text).replace(/\n/g, '<br>')
        case 'math':
          return `$${escapeHtml(run.tex)}$`
        case 'bold':
          return `<b>${runsToHtml(run.children)}</b>`
        case 'italic':
          return `<i>${runsToHtml(run.children)}</i>`
      }
    })
    .join('')
}

/** A subtree as HTML with inline styles. Ink cannot be HTML: it shows as a comment. */
export function nodesToHtml(rootId: string, index: SceneIndex, includeIds: boolean): string {
  const lines: string[] = []
  const attrs = (node: BoardNode): string => {
    let out = includeIds ? ` data-id="${escapeAttribute(node.id)}"` : ''
    if (typeof node.name === 'string' && node.name) out += ` layer-name="${escapeAttribute(node.name)}"`
    return out
  }
  const emit = (node: BoardNode, depth: number, placed: boolean): void => {
    const pad = '  '.repeat(depth)
    if (!isKnown(node)) {
      lines.push(`${pad}<!-- ${escapeHtml(node.kind)} node ${escapeHtml(node.id)} (not HTML) -->`)
      return
    }
    if (isInk(node)) return
    const position: Record<string, string> = placed ? { position: 'absolute', left: `${node.x}px`, top: `${node.y}px` } : {}
    const style = styleText(node.style, position)
    const styleAttr = style ? ` style="${escapeAttribute(style)}"` : ''
    switch (node.kind) {
      case 'frame': {
        const children = index.children.get(node.id) ?? []
        const ink = children.filter(isInk)
        const free = node.style.display !== 'flex'
        lines.push(`${pad}<div${attrs(node)}${styleAttr}>`)
        for (const child of children) if (isContent(child) || !isKnown(child)) emit(child, depth + 1, free)
        if (ink.length) {
          const learner = ink.filter((stroke) => stroke.author === 'learner').length
          lines.push(`${pad}  <!-- ink: ${ink.length} stroke(s) inside (${learner} by the learner); kept on replace -->`)
        }
        lines.push(`${pad}</div>`)
        return
      }
      case 'text': {
        lines.push(`${pad}<p${attrs(node)}${styleAttr}>${runsToHtml(parseMarkup(node.text))}</p>`)
        return
      }
      case 'svg': {
        const markup = node.markup.trim().replace(/^<svg\b/, `<svg${attrs(node)}${styleAttr}`)
        lines.push(`${pad}${markup}`)
        return
      }
      case 'image':
        lines.push(`${pad}<img${attrs(node)} src="${escapeAttribute(node.src)}"${styleAttr}>`)
        return
    }
  }
  const root = index.byId.get(rootId)
  if (!root) throw new Error(`No node "${rootId}" on this board.`)
  if (isInk(root)) return `<!-- ink stroke ${escapeHtml(root.id)}: not HTML; use get_node_info -->`
  emit(root, 0, false)
  return lines.join('\n')
}
