import { memo, useEffect, type CSSProperties, type ReactNode, type RefObject } from 'react'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { isContent, renderableStyle, type ContentNode } from '@shared/board-format'
import { LiveView } from '../live-pixels/LiveView'
import { parseMarkup, toggleMarker, type Run } from './markup'
import { ROOT, type SceneIndex } from './scene'
import type { BoardNode, LayoutBox } from './types'
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

function renderRuns(runs: Run[], key = ''): ReactNode[] {
  return runs.map((run, i) => {
    const k = `${key}${i}`
    switch (run.kind) {
      case 'text':
        return run.text
      case 'math':
        return <span key={k} className="node-math" dangerouslySetInnerHTML={{ __html: renderMath(run.tex) }} />
      case 'bold':
        return <strong key={k}>{renderRuns(run.children, `${k}.`)}</strong>
      case 'italic':
        return <em key={k}>{renderRuns(run.children, `${k}.`)}</em>
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

/** A text node's source as the HTML its view shows (live scenes show changing text with it). */
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

function boxStyle(node: ContentNode, placement: NodeViewProps['placement']): CSSProperties {
  const style = renderableStyle(node.style) as CSSProperties
  if (placement === 'absolute') {
    return { ...style, position: 'absolute', left: node.x, top: node.y, width: style.width ?? 'max-content' }
  }
  return { ...style, position: 'relative' }
}

function TextEditor({ ctx }: { ctx: RefObject<ContentContext> }) {
  const ref = ctx.current.editorRef
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
        if (event.key === 'Escape') {
          event.preventDefault()
          area.blur()
          return
        }
        const modified = event.metaKey || event.ctrlKey
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
  const style = boxStyle(node, placement)
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
    case 'text':
      return (
        <div {...common} className="node node-text" style={style}>
          {editing === node.id ? <TextEditor ctx={ctx} /> : node.text ? renderRuns(parseMarkup(node.text)) : '​'}
        </div>
      )
    case 'svg': {
      const sized = { 'data-w': node.style.width ? '1' : undefined, 'data-h': node.style.height ? '1' : undefined }
      return <div {...common} {...sized} className="node node-svg" style={style} dangerouslySetInnerHTML={{ __html: scopeSvgIds(sanitizeSvg(node.markup), node.id) }} />
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
    const x = (rect.left - rootRect.left) / zoom
    const y = (rect.top - rootRect.top) / zoom
    layout.set(id, { x, y, width: rect.width / zoom, height: rect.height / zoom, ox: x + element.clientLeft, oy: y + element.clientTop })
  }
  return layout
}
