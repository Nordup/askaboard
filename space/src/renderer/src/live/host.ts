import { createElement, createRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { isContent, isFrame, isInk, isKnown, type BoardNode, type ContentNode, type InkNode } from '@shared/board-format'
import type { SceneDraft } from '@shared/live-scene'
import type { BoardHandle } from '../board/Board'
import { ContentLayer, measureContent, type ContentContext } from '../board/content'
import { checkDrafts, draftsToNodes, htmlToDrafts, nodesToHtml, walkDrafts, type Draft } from '../board/html'
import { buildIndex, inkOffset, isFlowed, ROOT, topLevelOf, withDescendants, zAbove } from '../board/scene'
import type { LayoutBox } from '../board/types'
import { coveredOf } from '../agent/covered'
import { anchorFor, findSpace, obstacles, viewOf, type Scene } from '../agent/placement'
import { traceGlyphs } from './glyphs'

/**
 * The board's answers to a scene program while it runs (html(), image(),
 * space(), copy() in main/live-prelude.js): the sandbox asks, the main
 * process forwards the question here, and the program waits for the answer.
 *
 * - html: the HTML converter's drafts (images fetched into the folder), laid
 *   out in a hidden copy of the content layer: the root's size and its parts.
 * - space: an empty rect on the board (the find-space rule), clear of the
 *   board's items and of the scene's own objects.
 * - item: what a board item holds now (ink points, or its content as drafts).
 * - glyphs: characters that write()'s handwriting font lacks, traced from the
 *   board's text font (glyphs.ts).
 */

export interface HostContext {
  board: BoardHandle
  scene: () => Scene
  importAsset(src: string): Promise<string>
}

const r2 = (value: number): number => Math.round(value * 100) / 100
const box = (b: { x: number; y: number; width: number; height: number }) => ({ x: r2(b.x), y: r2(b.y), width: r2(b.width), height: r2(b.height) })

/** Default largest side of a picture from image() without a size, in board points. */
const IMAGE_FIT = 480
/** How long the layout waits for pictures to load before it measures (ms). */
const IMAGE_WAIT_MS = 4000

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Images in drafts: https and data: URLs are saved into the folder's assets/; folder paths must name a file there. A picture that fails is an error (decision B18). */
async function resolveImages(ctx: HostContext, drafts: Draft[]): Promise<Draft[]> {
  const jobs: Draft[] = []
  walkDrafts(drafts, (draft) => {
    if (draft.kind === 'image') jobs.push(draft)
  })
  for (const draft of jobs) {
    try {
      draft.src = await ctx.importAsset(draft.src ?? '')
    } catch (error) {
      throw new Error(`<img src=${JSON.stringify(draft.src ?? '')}>: ${message(error)}`)
    }
  }
  return drafts
}

/**
 * Lay nodes out as the board does, in a hidden copy of the content layer,
 * and return every content node's world box (top-level x, y are world points).
 */
async function layoutOf(nodes: readonly BoardNode[]): Promise<Map<string, LayoutBox>> {
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  Object.assign(container.style, { position: 'fixed', left: '-200000px', top: '0', width: '100000px', height: '100000px', visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden' })
  document.body.appendChild(container)
  const root = createRoot(container)
  const elements = new Map<string, HTMLElement>()
  const index = buildIndex(nodes)
  const ctx: RefObject<ContentContext> = {
    current: {
      index,
      editingId: null,
      editorRef: createRef<HTMLTextAreaElement>(),
      editorInitial: '',
      onEditorCommit: () => undefined,
      register: (id, element) => {
        if (element) elements.set(id, element)
        else elements.delete(id)
      },
      onMedia: () => undefined
    }
  }
  const rootRef = createRef<HTMLDivElement>()
  try {
    flushSync(() => root.render(createElement(ContentLayer, { index, editingId: null, ctx, rootRef })))
    const images = [...container.querySelectorAll('img')].filter((image) => !image.complete)
    if (images.length) {
      await Promise.race([
        Promise.all(images.map((image) => new Promise<void>((resolve) => {
          image.addEventListener('load', () => resolve(), { once: true })
          image.addEventListener('error', () => resolve(), { once: true })
        }))),
        new Promise<void>((resolve) => setTimeout(resolve, IMAGE_WAIT_MS))
      ])
    }
    await document.fonts.ready
    const layer = rootRef.current
    if (!layer) throw new Error('the layout could not be measured')
    layer.style.transform = 'none'
    return measureContent(layer, elements, 1)
  } finally {
    root.unmount()
    container.remove()
  }
}

/** A picture's display size: o.size [w, h], a width (the height keeps the picture's shape), or its own size fitted into IMAGE_FIT. */
function imageSize(natural: { width: number; height: number }, wanted: unknown): [number, number] {
  const aspect = natural.width > 0 && natural.height > 0 ? natural.height / natural.width : 0.75
  if (Array.isArray(wanted) && wanted.length === 2) return [Number(wanted[0]), Number(wanted[1])]
  if (typeof wanted === 'number') return [wanted, wanted * aspect]
  const w = natural.width || IMAGE_FIT
  const h = natural.height || IMAGE_FIT * aspect
  const k = Math.min(1, IMAGE_FIT / Math.max(w, h))
  return [Math.round(w * k), Math.round(h * k)]
}

/** The drafts as plain data for the sandbox (and the scene description). */
function plainDrafts(drafts: readonly Draft[]): SceneDraft[] {
  return drafts.map((draft) => ({
    kind: draft.kind,
    ...(draft.name ? { name: draft.name } : {}),
    style: { ...(draft.style as Record<string, string>) },
    x: draft.x,
    y: draft.y,
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.markup !== undefined ? { markup: draft.markup } : {}),
    ...(draft.src !== undefined ? { src: draft.src } : {}),
    children: plainDrafts(draft.children)
  }))
}

/** Several top-level elements become one column frame with gap 12px (one item with parts). */
function oneRoot(drafts: Draft[]): Draft[] {
  if (drafts.length <= 1) return drafts.map((draft) => ({ ...draft, x: 0, y: 0 }))
  return [{ kind: 'frame', style: { display: 'flex', flexDirection: 'column', gap: '12px' }, x: 0, y: 0, children: drafts }]
}

interface HtmlAnswer {
  drafts: SceneDraft[]
  size: [number, number]
  /** into: the root's world box where the frame puts it. */
  box?: { x: number; y: number; width: number; height: number }
  /** The root's children, relative to the root's top-left. */
  parts: Array<{ x: number; y: number; width: number; height: number; name?: string }>
}

async function htmlAnswer(ctx: HostContext, request: Record<string, unknown>): Promise<HtmlAnswer | { error: string }> {
  let drafts: Draft[]
  const picture = request.image as { src?: unknown; size?: unknown } | undefined
  if (picture) {
    const src = String(picture.src ?? '')
    let saved: string
    try {
      saved = await ctx.importAsset(src)
    } catch (error) {
      return { error: message(error) }
    }
    drafts = [{ kind: 'image', style: {}, x: 0, y: 0, src: saved, children: [] }]
    const natural = (await layoutOf(draftsToNodes(drafts, { zStart: 1, canUse: () => true, author: 'agent' }).nodes)).values().next().value
    if (!natural || natural.width <= 1) return { error: `the picture ${src} did not load (saved as ${saved})` }
    const [w, h] = imageSize(natural, picture.size)
    drafts[0].style = { width: `${r2(w)}px`, height: `${r2(h)}px` }
  } else if (Array.isArray(request.drafts)) {
    // Drafts from the program (copy()) are its data: they pass the HTML whitelist again.
    try {
      drafts = oneRoot(checkDrafts(request.drafts))
    } catch (error) {
      return { error: message(error) }
    }
    if (typeof request.width === 'number' && drafts[0] && !drafts[0].style.width) drafts[0].style = { ...drafts[0].style, width: `${r2(request.width)}px` }
    drafts = await resolveImages(ctx, drafts)
  } else {
    try {
      drafts = htmlToDrafts(String(request.markup ?? ''))
    } catch (error) {
      return { error: message(error) }
    }
    drafts = oneRoot(await resolveImages(ctx, drafts))
  }
  if (!drafts.length) return { error: 'nothing to show: the HTML has no content that the board draws' }

  const into = request.into as { ref?: unknown; mode?: unknown; index?: unknown } | undefined
  const built = draftsToNodes(drafts, { zStart: 1, canUse: () => false, author: 'agent' })
  const rootId = built.roots[0]
  let nodes: BoardNode[] = built.nodes
  let place: HtmlAnswer['box']
  if (into) {
    // Into an existing frame (or in place of an item): laid out with the board's own subtree around it.
    const s = ctx.scene()
    const ref = String(into.ref ?? '')
    const target = s.index.byId.get(ref)
    if (!target || !isKnown(target) || isInk(target)) return { error: `there is no frame or material "${ref}" on the board` }
    const replace = into.mode === 'replace'
    if (!replace && !isFrame(target)) return { error: `"${ref}" is a ${target.kind}, not a frame; html goes into frames (or use mode "replace")` }
    const top = topLevelOf(target, s.index.byId)
    const subtree = withDescendants([top.id], s.index)
    const dropped = replace ? withDescendants([target.id], s.index) : new Set<string>()
    const around = s.nodes.filter((node) => subtree.has(node.id) && !dropped.has(node.id) && isContent(node))
    const parent = replace ? (target.parent as string | undefined) : target.id
    const siblings = (s.index.children.get(parent ?? ROOT) ?? []).filter((node) => !dropped.has(node.id))
    const z = replace ? (target.z as number) : typeof into.index === 'number' ? (siblings[into.index] ? (siblings[into.index].z as number) - 0.5 : zAbove(siblings)) : zAbove(siblings)
    const root = { ...(built.nodes.find((node) => node.id === rootId) as ContentNode), z } as ContentNode
    if (parent) (root as { parent?: string }).parent = parent
    if (replace) Object.assign(root, { x: (target as ContentNode).x, y: (target as ContentNode).y })
    nodes = [...around, ...built.nodes.map((node) => (node.id === rootId ? root : node))]
    if (!parent) {
      // Replacing a top-level item: the new root takes its place on its own.
      nodes = built.nodes.map((node) => (node.id === rootId ? root : node))
    }
  }
  const layout = await layoutOf(nodes)
  const rootBox = layout.get(rootId)
  if (!rootBox) return { error: 'the material could not be laid out' }
  if (into) place = box(rootBox)
  const children = built.nodes.filter((node) => node.parent === rootId && isContent(node)).sort((a, b) => (a.z as number) - (b.z as number))
  const parts = children.map((child) => {
    const b = layout.get(child.id) ?? { x: rootBox.x, y: rootBox.y, width: 0, height: 0 }
    return { ...box({ x: b.x - rootBox.x, y: b.y - rootBox.y, width: b.width, height: b.height }), ...(child.name ? { name: child.name as string } : {}) }
  })
  return {
    drafts: plainDrafts(drafts),
    size: [r2(rootBox.width), r2(rootBox.height)],
    ...(place ? { box: place } : {}),
    parts
  }
}

function spaceAnswer(ctx: HostContext, request: Record<string, unknown>): unknown {
  const width = Number(request.width)
  const height = Number(request.height)
  if (!(width > 0) || !(height > 0)) return { error: 'width and height must be positive' }
  const s = ctx.scene()
  const view = viewOf(ctx.board)
  const near = request.near as { x: number; y: number; width: number; height: number } | null
  const anchor = near && [near.x, near.y, near.width, near.height].every(Number.isFinite) ? near : anchorFor(s, ctx.board, undefined)
  const avoid = Array.isArray(request.avoid) ? (request.avoid as Array<{ x: number; y: number; width: number; height: number }>) : []
  const spot = findSpace({ width, height }, anchor, [...obstacles(s), ...coveredOf(ctx.board), ...avoid], view, request.inView !== false)
  if (!spot) return { error: `no empty place of ${width}×${height} was found near ${near ? 'that place' : 'the learner’s work'}; try a smaller size` }
  return spot
}

async function itemAnswer(ctx: HostContext, request: Record<string, unknown>): Promise<unknown> {
  const s = ctx.scene()
  const ref = String(request.ref ?? '')
  const group = s.groupById.get(ref)
  const strokeOf = (node: InkNode) => {
    const box = s.layout.get(node.id)
    const [ox, oy] = box ? [box.ox, box.oy] : inkOffset(node, s.index.byId, s.layout)
    return { points: node.points.map(([x, y, p]) => [r2(x + ox), r2(y + oy), p]), color: node.color, width: node.width, tool: node.tool }
  }
  if (group) {
    const strokes = group.strokes.map((id) => s.index.byId.get(id)).filter((node): node is InkNode => !!node && isInk(node))
    return { kind: 'ink', strokes: strokes.map(strokeOf) }
  }
  const node = s.index.byId.get(ref)
  if (!node || !isKnown(node)) return { error: `there is no item "${ref}" on the board` }
  if (isInk(node)) return { kind: 'ink', strokes: [strokeOf(node)] }
  if (node.kind === 'live') return { error: `"${ref}" is a live item made before this stage; make it again with world()` }
  const drafts = htmlToDrafts(nodesToHtml(node.id, s.index, false))
  const box = s.layout.get(node.id)
  if (drafts[0] && box && isFlowed(node, s.index.byId) && !drafts[0].style.width) drafts[0].style = { ...drafts[0].style, width: `${r2(box.width)}px` }
  return { kind: 'html', drafts: plainDrafts(drafts.map((draft) => ({ ...draft, x: 0, y: 0 }))) }
}

/** Answer one sandbox request. Errors come back as {error} for the program to report. */
export async function sceneHost(ctx: HostContext, request: Record<string, unknown>): Promise<unknown> {
  try {
    switch (request.kind) {
      case 'html':
        return await htmlAnswer(ctx, request)
      case 'space':
        return spaceAnswer(ctx, request)
      case 'item':
        return await itemAnswer(ctx, request)
      case 'glyphs':
        return { glyphs: traceGlyphs(Array.isArray(request.chars) ? request.chars.filter((ch): ch is string => typeof ch === 'string').slice(0, 512) : []) }
      default:
        return { error: `unknown request ${String(request.kind)}` }
    }
  } catch (error) {
    return { error: message(error) }
  }
}
