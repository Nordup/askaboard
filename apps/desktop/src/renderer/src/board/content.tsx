import { memo, useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { isContent, nodeRotation, renderableStyle, type ContentNode } from '@shared/board-format'
import { LiveView } from '../live-pixels/LiveView'
import { parseMarkup, toggleMarker, type Run } from './markup'
import { ROOT, type SceneIndex } from './scene'
import type { BoardNode, LayoutBox } from './types'
import { boardMarkup, installLightTokens, lightStyle, useBoardLight } from '../lib/board-light'
import '../../../../node_modules/katex/dist/katex.min.css'
import './content.css'

/**
 * The content layer: frames, text, svg and images as real DOM under one CSS
 * transform (set by the Board, the same camera as the ink canvas). The layer
 * takes no pointer input; the Board hit-tests through the layout cache.
 * Every node element carries `data-node-id`, which the Board measures.
 */

// ---------- Sanitizing ----------

const svgCache = new Map<string, string>()
let hooked = false

/** SVG markup with no scripts, no foreignObject, no event handlers and no external references. */
export function sanitizeSvg(markup: string): string {
  const cached = svgCache.get(markup)
  if (cached !== undefined) return cached
  if (!hooked) {
    hooked = true
    DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
      const name = data.attrName.toLowerCase()
      const value = data.attrValue.trim()
      // Only same-document references (#id) for href; no url(...) to anything but #id.
      if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) data.keepAttr = false
      if (/url\s*\(\s*['"]?(?!#)/i.test(value)) data.keepAttr = false
    })
  }
  const clean = DOMPurify.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'image', 'style', 'a'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick']
  })
  if (svgCache.size > 500) svgCache.clear()
  svgCache.set(markup, clean)
  return clean
}

const scopedCache = new Map<string, string>()

/**
 * Prefix every id inside one svg node with the node id, and rewrite its
 * references (url(#x), href="#x"), so two drawings that both use "arrow" never
 * point at each other's elements. The stored markup keeps the agent's ids.
 */
export function scopeSvgIds(markup: string, nodeId: string): string {
  const key = `${nodeId}\u0000${markup}`
  const cached = scopedCache.get(key)
  if (cached !== undefined) return cached
  const prefix = `ls-${nodeId.replace(/[^\w-]/g, '')}-`
  const ids = new Set<string>()
  for (const match of markup.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1])
  let out = markup
  if (ids.size) {
    out = out
      .replace(/(\sid=")([^"]+)"/g, (_, head: string, id: string) => `${head}${prefix}${id}"`)
      .replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (whole, quote: string, id: string) => (ids.has(id) ? `url(${quote}#${prefix}${id}${quote})` : whole))
      .replace(/(\s(?:xlink:)?href=")#([^"]+)"/g, (whole, head: string, id: string) => (ids.has(id) ? `${head}#${prefix}${id}"` : whole))
  }
  if (scopedCache.size > 500) scopedCache.clear()
  scopedCache.set(key, out)
  return out
}

const mathCache = new Map<string, string>()

function renderMath(tex: string): string {
  let html = mathCache.get(tex)
  if (html === undefined) {
    html = katex.renderToString(tex, { throwOnError: false, output: 'html', trust: false, strict: 'ignore', maxSize: 100, maxExpand: 500 })
    if (mathCache.size > 2000) mathCache.clear()
    mathCache.set(tex, html)
  }
  return html
}

/** The URL of a learning-folder file for <img>, or null when the src is not a plain relative path. */
export function assetUrl(src: string): string | null {
  if (!src || src.startsWith('/') || src.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null
  return `space-asset://folder/${src.split('/').map(encodeURIComponent).join('/')}`
}

// ---------- Rendering ----------

/** `light`: the light board, where the colours of maths (\color, \colorbox) go through lib/board-light.ts. */
function renderRuns(runs: Run[], light: boolean, key = ''): ReactNode[] {
  return runs.map((run, i) => {
    const k = `${key}${i}`
    switch (run.kind) {
      case 'text':
        return run.text
      case 'math':
        return <span key={k} className="node-math" dangerouslySetInnerHTML={{ __html: boardMarkup(renderMath(run.tex), light) }} />
      case 'bold':
        return <strong key={k}>{renderRuns(run.children, light, `${k}.`)}</strong>
      case 'italic':
        return <em key={k}>{renderRuns(run.children, light, `${k}.`)}</em>
    }
  })
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function runsHtml(runs: Run[]): string {
  return runs
    .map((run) => {
      switch (run.kind) {
        case 'text':
          return escapeHtml(run.text)
        case 'math':
          return `<span class="node-math">${renderMath(run.tex)}</span>`
        case 'bold':
          return `<strong>${runsHtml(run.children)}</strong>`
        case 'italic':
          return `<em>${runsHtml(run.children)}</em>`
      }
    })
    .join('')
}

/** A text node's source as the HTML its view shows (live scenes show changing text with it). Its colours are the stored ones: playback.ts maps them where it shows them. */
export function textHtml(source: string): string {
  return runsHtml(parseMarkup(source))
}

/** What the Board gives every node view: stable across renders (read through a ref). */
export interface ContentContext {
  index: SceneIndex
  editingId: string | null
  editorRef: RefObject<HTMLTextAreaElement | null>
  /** The text the editor opens with. */
  editorInitial: string
  onEditorCommit(): void
  /** The learner ended the edit by key: commit it and go back to the Select tool. */
  onEditorDone(): void
  /** Register or unregister a node element for measuring. */
  register(id: string, element: HTMLElement | null): void
  /** An image loaded (its size may have changed). */
  onMedia(): void
}

interface NodeViewProps {
  node: ContentNode
  /** Every descendant node object, flattened: the view re-renders when one changes. */
  subtree: readonly BoardNode[]
  /** How the parent places this node. */
  placement: 'absolute' | 'flow'
  /** The id being edited when it is this node or inside it, else null. */
  editing: string | null
  ctx: RefObject<ContentContext>
}

function sameProps(a: NodeViewProps, b: NodeViewProps): boolean {
  if (a.node !== b.node || a.placement !== b.placement || a.editing !== b.editing || a.subtree.length !== b.subtree.length) return false
  for (let i = 0; i < a.subtree.length; i++) if (a.subtree[i] !== b.subtree[i]) return false
  return true
}

function subtreeOf(id: string, index: SceneIndex, out: BoardNode[] = []): BoardNode[] {
  for (const child of index.children.get(id) ?? []) {
    out.push(child)
    subtreeOf(child.id, index, out)
  }
  return out
}

function editingWithin(id: string, subtree: readonly BoardNode[], editingId: string | null): string | null {
  if (!editingId) return null
  if (editingId === id || subtree.some((node) => node.id === editingId)) return editingId
  return null
}

/** The one place a node's stored style reaches the DOM: on the light board its colours go through lib/board-light.ts. */
function boxStyle(node: ContentNode, placement: NodeViewProps['placement'], light: boolean): CSSProperties {
  const own = renderableStyle(node.style) as CSSProperties
  const style = light ? lightStyle(own) : own
  if (placement === 'absolute') {
    return { ...style, position: 'absolute', left: node.x, top: node.y, width: style.width ?? 'max-content' }
  }
  return { ...style, position: 'relative' }
}

function TextEditor({ ctx }: { ctx: RefObject<ContentContext> }) {
  const ref = ctx.current.editorRef
  /** An Enter pressed in this editor: a repeat with no such press is the key that opened it, still held. */
  const enterPressed = useRef(false)
  useEffect(() => {
    const area = ref.current
    if (!area) return
    area.focus({ preventScroll: true })
    area.setSelectionRange(area.value.length, area.value.length)
  }, [ref])
  return (
    <textarea
      ref={ref}
      className="node-text__editor"
      defaultValue={ctx.current.editorInitial}
      spellCheck={false}
      rows={1}
      onBlur={() => ctx.current.onEditorCommit()}
      onKeyDown={(event) => {
        const area = event.currentTarget
        const modified = event.metaKey || event.ctrlKey
        if (event.key === 'Enter' && !modified) {
          if (event.repeat && !enterPressed.current) {
            event.preventDefault()
            return
          }
          enterPressed.current = true
        }
        if (!event.nativeEvent.isComposing && (event.key === 'Escape' || (event.key === 'Enter' && modified))) {
          event.preventDefault()
          ctx.current.onEditorDone()
          return
        }
        const key = event.key.toLowerCase()
        if (modified && !event.altKey && (key === 'b' || key === 'i')) {
          event.preventDefault()
          const next = toggleMarker(area.value, area.selectionStart, area.selectionEnd, key === 'b' ? '**' : '*')
          area.value = next.value
          area.setSelectionRange(next.start, next.end)
        }
      }}
    />
  )
}

const NodeView = memo(function NodeView({ node, placement, editing, ctx }: NodeViewProps) {
  const register = (element: HTMLElement | null): void => ctx.current.register(node.id, element)
  // The theme is a subscription, not a prop: a theme change renders every node view again (memo passes it through).
  const light = useBoardLight()
  const style = boxStyle(node, placement, light)
  const common = { 'data-node-id': node.id, 'data-kind': node.kind, ref: register }

  switch (node.kind) {
    case 'frame': {
      const index = ctx.current.index
      const flex = node.style.display === 'flex'
      const children = (index.children.get(node.id) ?? []).filter(isContent)
      return (
        <div {...common} className="node node-frame" style={style}>
          {children.map((child) => (
            <ChildView key={child.id} node={child} placement={flex ? 'flow' : 'absolute'} ctx={ctx} editingId={editing} />
          ))}
        </div>
      )
    }
    case 'text': {
      const rotation = nodeRotation(node)
      const turn = rotation ? { 'data-rotation': rotation, style: { ...style, '--node-rotation': `${rotation}deg` } as CSSProperties } : { style }
      return (
        <div {...common} {...turn} className="node node-text">
          {editing === node.id ? <TextEditor ctx={ctx} /> : node.text ? renderRuns(parseMarkup(node.text), light) : '​'}
        </div>
      )
    }
    case 'svg': {
      const sized = { 'data-w': node.style.width ? '1' : undefined, 'data-h': node.style.height ? '1' : undefined }
      return <div {...common} {...sized} className="node node-svg" style={style} dangerouslySetInnerHTML={{ __html: boardMarkup(scopeSvgIds(sanitizeSvg(node.markup), node.id), light) }} />
    }
    case 'live':
      return <LiveView node={node} style={{ ...style, width: node.w, height: node.h }} common={common} />
    case 'image': {
      const url = assetUrl(node.src)
      if (!url) {
        return (
          <div {...common} className="node node-image node-image--missing" style={style}>
            {node.src}
          </div>
        )
      }
      return (
        <img
          {...common}
          className="node node-image"
          // A raster image shows its true colours in both themes. An SVG file is board material that cannot be recoloured cheaply: content.css maps it with a filter on the light board.
          data-svg-file={/\.svg$|^data:image\/svg/i.test(node.src.split(/[?#]/)[0]) ? '' : undefined}
          style={style}
          src={url}
          alt=""
          draggable={false}
          onLoad={() => ctx.current.onMedia()}
          onError={() => ctx.current.onMedia()}
        />
      )
    }
  }
}, sameProps)

function ChildView({
  node,
  placement,
  ctx,
  editingId
}: {
  node: ContentNode
  placement: NodeViewProps['placement']
  ctx: RefObject<ContentContext>
  editingId: string | null
}) {
  const subtree = subtreeOf(node.id, ctx.current.index)
  return <NodeView node={node} subtree={subtree} placement={placement} editing={editingWithin(node.id, subtree, editingId)} ctx={ctx} />
}

interface ContentLayerProps {
  /** The live index of the content, with no ink. A new object means the content changed. */
  index: SceneIndex
  editingId: string | null
  ctx: RefObject<ContentContext>
  rootRef: RefObject<HTMLDivElement | null>
}

/** The transformed root. Its transform is set by the Board, never by React, so a camera change does not render it. */
export const ContentLayer = memo(function ContentLayer({ index, editingId, ctx, rootRef }: ContentLayerProps) {
  const top = (index.children.get(ROOT) ?? []).filter(isContent)
  // The light --ls-* tokens, computed once from the dark ones (lib/board-light.ts).
  if (useBoardLight()) installLightTokens()
  return (
    <div className="board__content" ref={rootRef} aria-hidden={editingId ? undefined : 'true'}>
      {top.map((node) => (
        <ChildView key={node.id} node={node} placement="absolute" ctx={ctx} editingId={editingId} />
      ))}
    </div>
  )
})

/**
 * Measure node elements into world boxes (board points). `root` is the
 * transformed content root (board origin); `zoom` is the scale its transform shows.
 */
export function measureContent(root: HTMLElement, elements: ReadonlyMap<string, HTMLElement>, zoom: number): Map<string, LayoutBox> {
  const layout = new Map<string, LayoutBox>()
  const rootRect = root.getBoundingClientRect()
  for (const [id, element] of elements) {
    if (!element.isConnected) continue
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0 && getComputedStyle(element).display === 'none') continue
    const rotation = Number(element.dataset.rotation) || 0
    if (rotation) {
      // A turned element's rect is its bounds, with the same centre as its box. Its computed size is the box before it turns, exact to the fraction.
      const computed = getComputedStyle(element)
      const width = parseFloat(computed.width) || element.offsetWidth
      const height = parseFloat(computed.height) || element.offsetHeight
      const x = ((rect.left + rect.right) / 2 - rootRect.left) / zoom - width / 2
      const y = ((rect.top + rect.bottom) / 2 - rootRect.top) / zoom - height / 2
      layout.set(id, { x, y, width, height, rotation, ox: x + element.clientLeft, oy: y + element.clientTop })
      continue
    }
    const x = (rect.left - rootRect.left) / zoom
    const y = (rect.top - rootRect.top) / zoom
    layout.set(id, { x, y, width: rect.width / zoom, height: rect.height / zoom, ox: x + element.clientLeft, oy: y + element.clientTop })
  }
  return layout
}
