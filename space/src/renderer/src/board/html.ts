import { MAX_COORD, MAX_HTML_DEPTH, MAX_HTML_ELEMENTS, MAX_STYLE_CHARS } from '@shared/limits'
import { isContent, isInk, isKnown, newItemId, STYLE_KEYS, styleKey, type BoardNode, type NodeStyle } from '@shared/board-format'
import { sanitizeSvg } from './content'
import { parseMarkup, type Run } from './markup'
import type { SceneIndex } from './scene'

/**
 * HTML ⇄ nodes. The agent writes a strict HTML subset with inline styles; it
 * becomes native nodes. DOMParser builds an inert document (no script runs,
 * no resource loads), and only whitelisted tags, attributes and style keys
 * survive; anything else is skipped without a note (decision B18). `nodesToHtml` writes the same subset back, so
 * html(get_item(x, as "html")) in a scene gives x again (with new ids).
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

// ---------- Styles ----------

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** Read a style attribute as written (shorthands kept). Position keys go to `position`. */
function readStyle(raw: string | null): { style: NodeStyle; position: { absolute: boolean; left?: number; top?: number } } {
  const style: NodeStyle = {}
  const position: { absolute: boolean; left?: number; top?: number } = { absolute: false }
  if (!raw) return { style, position }
  for (const declaration of raw.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const key = styleKey(declaration.slice(0, colon))
    const value = declaration
      .slice(colon + 1)
      .replace(/!important/i, '')
      .trim()
    if (!key || !value) continue
    if (key === 'position') {
      position.absolute = value === 'absolute'
      continue
    }
    if (value.length > MAX_STYLE_CHARS) continue
    if (key === 'left' || key === 'top') {
      const number = parseFloat(value)
      if (Number.isFinite(number) && Math.abs(number) <= MAX_COORD && /px$|^-?[\d.]+$/.test(value)) position[key] = number
      continue
    }
    if (!STYLE_KEY_SET.has(key) || /url\s*\(|expression\s*\(|javascript:/i.test(value)) continue
    if (key === 'display' && !['flex', 'block', 'none'].includes(value)) continue
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
function inlineMarkup(node: Node, pre: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent ?? ''
    return escapeText(pre ? value : value.replace(/\s+/g, ' '))
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const element = node as Element
  const tag = element.tagName.toLowerCase()
  if (DROP_TAGS.has(tag)) return ''
  if (tag === 'br') return '\n'
  // A style on an inline tag is not kept: styles apply to the whole text block.
  const inner = [...element.childNodes].map((child) => inlineMarkup(child, pre)).join('')
  if (!inner.trim()) return inner
  // Markers hug the words: leading and trailing spaces stay outside.
  const wrap = (marker: string): string => {
    const lead = inner.match(/^\s*/)?.[0] ?? ''
    const trail = inner.match(/\s*$/)?.[0] ?? ''
    return `${lead}${marker}${inner.trim()}${marker}${trail}`
  }
  if (tag === 'b' || tag === 'strong') return wrap('**')
  if (tag === 'i' || tag === 'em') return wrap('*')
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

function baseDraft(element: Element, kind: Draft['kind']): { draft: Draft; absolute: boolean } {
  const { style, position } = readStyle(element.getAttribute('style'))
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

function textDraft(element: Element, prefix = ''): { draft: Draft; absolute: boolean } {
  const tag = element.tagName.toLowerCase()
  const result = baseDraft(element, 'text')
  const pre = tag === 'pre' || result.draft.style.whiteSpace === 'pre' || result.draft.style.whiteSpace === 'pre-wrap'
  if (tag === 'pre') {
    result.draft.style = { whiteSpace: 'pre', fontFamily: 'var(--ls-mono)', ...result.draft.style }
    // Code: every * and $ is literal.
    result.draft.text = (element.textContent ?? '').replace(/^\n/, '').replace(/\n$/, '').replace(/([\\*$])/g, '\\$1')
    return result
  }
  if (HEADING_STYLE[tag]) result.draft.style = { ...HEADING_STYLE[tag], ...result.draft.style }
  const markup = [...element.childNodes].map((child) => inlineMarkup(child, pre)).join('')
  result.draft.text = prefix + cleanText(markup, pre)
  return result
}

/** Convert one element. Returns null when it draws nothing. */
function convertElement(element: Element): { draft: Draft; absolute: boolean } | null {
  const tag = element.tagName.toLowerCase()
  if (DROP_TAGS.has(tag)) return null
  if (tag === 'svg') {
    const result = baseDraft(element, 'svg')
    sizeFromAttributes(element, result.draft.style)
    const viewBox = element.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
    if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite)) {
      if (!result.draft.style.width) result.draft.style.width = `${viewBox[2]}px`
      if (!result.draft.style.height && !element.getAttribute('height')) result.draft.style.height = `${viewBox[3]}px`
    }
    const clone = element.cloneNode(true) as Element
    for (const attribute of ['style', 'data-id', 'layer-name']) clone.removeAttribute(attribute)
    const markup = sanitizeSvg(clone.outerHTML)
    if (!markup.trim().startsWith('<svg')) return null
    result.draft.markup = markup
    return result
  }
  if (tag === 'img') {
    const result = baseDraft(element, 'image')
    sizeFromAttributes(element, result.draft.style)
    result.draft.src = element.getAttribute('src') ?? ''
    return result.draft.src ? result : null
  }
  // Tables, like any other block, become frames: a block of blocks is a flex column.
  if (tag === 'ul' || tag === 'ol') {
    const result = baseDraft(element, 'frame')
    result.draft.style = { display: 'flex', flexDirection: 'column', gap: '4px', ...result.draft.style }
    let number = 1
    for (const child of element.children) {
      if (child.tagName.toLowerCase() !== 'li') {
        const other = convertElement(child)
        if (other) result.draft.children.push(other.draft)
        continue
      }
      const prefix = tag === 'ol' ? `${number++}. ` : '• '
      if (isInlineOnly(child)) result.draft.children.push(textDraft(child, prefix).draft)
      else {
        const nested = convertBlock(child)
        if (nested) result.draft.children.push(nested.draft)
      }
    }
    return result
  }
  if (INLINE_TAGS.has(tag) || isInlineOnly(element) || tag === 'pre' || /^h[1-6]$/.test(tag) || tag === 'p') {
    if (tag === 'p' || /^h[1-6]$/.test(tag) || tag === 'pre' || isInlineOnly(element)) {
      const result = textDraft(element)
      return result.draft.text || result.draft.style.width || result.draft.style.height ? result : null
    }
  }
  return convertBlock(element)
}

/** A block with element children: a frame. Loose inline runs become text nodes. */
function convertBlock(element: Element): { draft: Draft; absolute: boolean } | null {
  const result = baseDraft(element, 'frame')
  const children: { draft: Draft; absolute: boolean }[] = []
  let run: Node[] = []
  const flush = (): void => {
    const markup = cleanText(run.map((node) => inlineMarkup(node, false)).join(''), false)
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
    const converted = convertElement(child as Element)
    if (converted) children.push(converted)
  }
  flush()
  const style = result.draft.style
  const free = children.some((child) => child.absolute)
  if (style.display !== 'flex' && style.display !== 'none') {
    if (free) delete style.display
    else {
      // Block flow without margins is a flex column.
      style.display = 'flex'
      if (!style.flexDirection) style.flexDirection = 'column'
    }
  }
  // In a flex frame, position:absolute children are placed by the flex layout.
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
export function htmlToDrafts(html: string): Draft[] {
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
    const converted = convertElement(child as Element)
    if (converted) drafts.push(converted.draft)
  }
  if (loose.trim()) {
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

/** An image src that names a file inside the learning folder: relative, no scheme, no `..`. */
export function isFolderPath(src: string): boolean {
  if (!src || src.length > 1024 || /^[a-z][a-z0-9+.-]*:/i.test(src) || /^[/\\]/.test(src) || src.includes('\\') || src.includes('\0')) return false
  return !src.split('/').some((segment) => segment === '..')
}

/**
 * Drafts that come from outside this module (a scene program's data, which
 * the program controls) pass the same whitelist as HTML: known kinds only,
 * styles through readStyle, SVG through htmlToDrafts (and so sanitizeSvg),
 * image src only as a learning-folder path, the same size and depth limits.
 * Ids are never taken over. Drafts made by htmlToDrafts come out unchanged.
 * An image src that is not a folder path is an error (decision B18).
 */
export function checkDrafts(input: unknown): Draft[] {
  let count = 0
  const check = (raw: unknown, depth: number): Draft | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (++count > MAX_HTML_ELEMENTS) throw new Error(`The material has more than ${MAX_HTML_ELEMENTS} elements.`)
    if (depth > MAX_HTML_DEPTH) throw new Error(`The material is nested more than ${MAX_HTML_DEPTH} elements deep.`)
    const value = raw as Record<string, unknown>
    const kind = value.kind
    if (kind !== 'frame' && kind !== 'text' && kind !== 'svg' && kind !== 'image') return null
    // The style object as a style attribute, read by the HTML whitelist.
    const declarations: string[] = []
    if (value.style && typeof value.style === 'object') {
      for (const [key, v] of Object.entries(value.style as Record<string, unknown>)) {
        if (typeof v === 'string' && v !== '') declarations.push(`${kebab(key)}: ${v}`)
      }
    }
    const { style } = readStyle(declarations.join('; '))
    const coord = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD ? n : 0)
    const draft: Draft = { kind, style, x: coord(value.x), y: coord(value.y), children: [] }
    if (typeof value.name === 'string' && value.name && value.name.length <= 200) draft.name = value.name
    if (kind === 'text') draft.text = typeof value.text === 'string' ? value.text : ''
    if (kind === 'svg') {
      const parsed = typeof value.markup === 'string' ? htmlToDrafts(value.markup) : []
      if (parsed.length !== 1 || parsed[0].kind !== 'svg' || !parsed[0].markup) return null
      draft.markup = parsed[0].markup
    }
    if (kind === 'image') {
      const src = typeof value.src === 'string' ? value.src.trim() : ''
      if (!isFolderPath(src)) throw new Error(`the image ${JSON.stringify(src.slice(0, 80))} is not a file path in the learning folder`)
      draft.src = src
    }
    if (kind === 'frame' && Array.isArray(value.children)) {
      for (const child of value.children) {
        const checked = check(child, depth + 1)
        if (checked) draft.children.push(checked)
      }
    }
    return draft
  }
  if (!Array.isArray(input)) return []
  return input.map((raw) => check(raw, 0)).filter((draft): draft is Draft => draft !== null)
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
          // A literal * stays plain: html() escapes plain text again on the way in.
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
      case 'live': {
        const params = Object.entries(node.params).map(([name, value]) => `${name}=${value}`).join(' ')
        lines.push(`${pad}<!-- world ${escapeHtml(node.id)}${node.name ? ` "${escapeHtml(node.name)}"` : ''} at ${node.x},${node.y} ${node.w}×${node.h}${params ? `, params ${escapeHtml(params)}` : ''} (not HTML) -->`)
        return
      }
    }
  }
  const root = index.byId.get(rootId)
  if (!root) throw new Error(`No node "${rootId}" on this board.`)
  if (isInk(root)) return `<!-- ink stroke ${escapeHtml(root.id)}: not HTML; use get_item -->`
  emit(root, 0, false)
  return lines.join('\n')
}
