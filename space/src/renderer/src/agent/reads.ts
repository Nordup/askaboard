import { authorOf, clusterByPlace, contextOf, firstWords, isItem, isOrphan, itemTexts, matchText, matchWords, nameOf, num, placeText as place, plural, q, relation, sceneIdOf, shownText, unionRegions, wholeRect } from '@shared/board-digest'
import { boardName, isFrame, isInk, isKnown, isLive, savedInkPoints, type Author, type BoardNode, type InkNode } from '@shared/board-format'
import type { BoardRect, ChangedItem, InkGroupSummary, RemovedItem } from '@shared/space-api'
import type { BoardHandle, LiveBoardState } from '../board/Board'
import { describeChange, type ChangeDescription, type ChangeLog, type Tombstone } from '../board/changes'
import { nodesToHtml } from '../board/html'
import { buildIndex, parentKey, ROOT, withDescendants, type SceneIndex } from '../board/scene'
import type { Region } from '../board/types'
import { liveSummary } from '../live-pixels/registry'
import { scenePlayer } from '../live/player'
import { stepOfObject } from '../live/run'
import { coveredOf } from './covered'
import { getNodeInfo } from './edits'
import { isGroupId, type InkGroup } from './groups'
import { itemIdOf } from './item-names'
import { sceneOf } from './placement'

/**
 * The agent's reads of the open board, as the agent thinks about it
 * (list_items, get_item, get_changes, and the part of get_screenshot):
 * the learner's work (ink groups and the learner's items), the agent's
 * scenes (items by node.scene, with names and steps the app knows this
 * session) and material (frames with a title). These units are views that
 * refer to each other: one item can show in a scene and inside a frame.
 *
 * Results are outline text, small by default; every summary says how to
 * open each part in full, and how large a detail is before it is asked for.
 * Nothing here is stored: units come from what the board holds now.
 */

// ---------- Context and small helpers ----------

export interface ReadContext {
  path: string
  board: BoardHandle
  log: ChangeLog | null
  groups: InkGroup[]
  folder: { name: string; root: string } | null
  boards: string[]
  tool: string
  /** Scene ids and names that the main process's stage log knows. */
  sceneNames: Array<{ id: string; name: string | null }>
}

/** The part forms (docs/learning-space/drafts/board-tools-redesign-2026-10-27.md, section 10). */
export type PartArg =
  | string
  | { region: BoardRect }
  | { id: string | string[] }
  | { scene: string; step?: number | string }
  | { changes: string }

/** Above this many entries, a section of the view or board overview is summarised one level up (by area); each area opens in full with one call. */
const SUMMARY_AT = 25
/** Units this close (board points) form one area. */
const AREA_GAP = 160
/** About this many characters per stroke point in get_item as "points" (JSON "[x,y,p]," at the board file's precision), when no stroke can be measured. */
const CHARS_PER_POINT = 19
/** About this many characters per stroke in get_item as "points" besides its points. */
const CHARS_PER_STROKE_POINTS = 90
/** About this many characters per stroke in get_item as "strokes". */
const CHARS_PER_STROKE_ENTRY = 72

const r1 = (value: number): number => Math.round(value * 10) / 10

export function boardRect(region: Region | null): BoardRect | null {
  return region ? { x: r1(region.x), y: r1(region.y), width: r1(region.width), height: r1(region.height) } : null
}

/** A region as a call argument: {x: …, y: …, width: …, height: …}, the same rounded rect as place(). */
function regionArg(region: Region): string {
  const b = wholeRect(region)
  return `{x: ${b.x}, y: ${b.y}, width: ${b.width}, height: ${b.height}}`
}

function intersects(a: Region | null, b: Region): boolean {
  if (!a) return true
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
}

function viewportRect(state: LiveBoardState): Region {
  const width = state.viewport[0] / state.camera.zoom
  const height = state.viewport[1] / state.camera.zoom
  return { x: state.camera.center[0] - width / 2, y: state.camera.center[1] - height / 2, width, height }
}

/** About how many characters get_item gives for an ink group as "points" and as "strokes" (characters per point measured on a few of its strokes, as get_item gives them). */
function inkSizes(strokes: InkNode[]): { points: number; strokes: number } {
  let count = 0
  for (const stroke of strokes) count += stroke.points.length
  let perPoint = CHARS_PER_POINT
  const sample = strokes.slice(0, 8).filter((stroke) => stroke.points.length)
  const sampled = sample.reduce((total, stroke) => total + stroke.points.length, 0)
  if (sampled) perPoint = sample.reduce((total, stroke) => total + JSON.stringify(savedInkPoints(stroke.points)).length, 0) / sampled
  return { points: Math.round(count * perPoint + strokes.length * CHARS_PER_STROKE_POINTS), strokes: strokes.length * CHARS_PER_STROKE_ENTRY }
}

/** "about 180,000": rounded to 2 significant digits. */
function about(chars: number): string {
  if (chars < 1000) return `about ${num(chars)}`
  const digits = Math.pow(10, Math.floor(Math.log10(chars)) - 1)
  return `about ${num(Math.round(chars / digits) * digits)}`
}

// ---------- The model: units and scenes ----------

interface Unit {
  /** A node id or an ink group id. */
  id: string
  /** "ink" for an ink group, else the node kind. */
  kind: string
  author: Author
  scene?: string
  name?: string
  /** A frame's title from its first text, when it has no name. */
  title?: string
  bounds: Region | null
  node?: BoardNode
  group?: InkGroup
  /** The frame it sits in, or ROOT. */
  parent: string
  /** Items inside a frame. */
  inside: number
  /** Its parent id names no node. */
  orphan?: boolean
  /** A node kind this app version does not know. */
  legacy?: boolean
}

interface SceneInfo {
  id: string
  name: string | null
  steps: Array<{ name: string; at: number; pause?: boolean }> | null
  duration: number | null
  cues: string[]
  /** When it last started playing (Date ms), this session. */
  lastPlayed: number | null
  units: Unit[]
  /** Unit id → the step it appears in, when the app knows it. */
  stepOf: Map<string, string>
}

interface Model {
  ctx: ReadContext
  state: LiveBoardState
  index: SceneIndex
  byId: Map<string, BoardNode>
  units: Unit[]
  unitById: Map<string, Unit>
  groupById: Map<string, InkGroup>
  groupOfStroke: Map<string, InkGroup>
  scenes: Map<string, SceneInfo>
  view: Region
}

function buildModel(ctx: ReadContext): Model {
  const state = ctx.board.liveState()
  const index = buildIndex(state.nodes)
  const byId = index.byId as Map<string, BoardNode>
  const groupById = new Map(ctx.groups.map((group) => [group.id, group]))
  const groupOfStroke = new Map<string, InkGroup>()
  for (const group of ctx.groups) for (const stroke of group.strokes) groupOfStroke.set(stroke, group)
  const units: Unit[] = []

  for (const group of ctx.groups) {
    const strokes = group.strokes.map((id) => byId.get(id)).filter((node): node is BoardNode => !!node)
    const scene = strokes.map(sceneIdOf).find((id) => id)
    const name = strokes.map(nameOf).find((value) => value)
    units.push({ id: group.id, kind: 'ink', author: group.author, ...(scene ? { scene } : {}), ...(name ? { name } : {}), bounds: group.bounds, group, parent: group.parent || ROOT, inside: 0 })
  }
  for (const node of state.nodes) {
    if (isInk(node)) continue
    const known = isKnown(node)
    if (!isItem(node, byId)) continue
    const orphan = isOrphan(node, byId)
    const key = known ? parentKey(node, byId) : ROOT
    const scene = sceneIdOf(node)
    const name = nameOf(node)
    const inside = isFrame(node) ? withDescendants([node.id], index).size - 1 : 0
    let title: string | undefined
    if (!name && isFrame(node)) {
      for (const id of withDescendants([node.id], index)) {
        const text = firstWords(shownText(byId.get(id) as BoardNode), 40)
        if (text) {
          title = text
          break
        }
      }
    }
    units.push({ id: node.id, kind: node.kind, author: authorOf(node), ...(scene ? { scene } : {}), ...(name ? { name } : {}), ...(title ? { title } : {}), bounds: state.bounds(node.id), node, parent: key, inside, ...(orphan ? { orphan } : {}), ...(known ? {} : { legacy: true }) })
  }
  const unitById = new Map(units.map((unit) => [unit.id, unit]))

  // Scenes: from the items' scene ids, with the names and steps the app knows this session.
  const scenes = new Map<string, SceneInfo>()
  const sceneFor = (id: string): SceneInfo => {
    let info = scenes.get(id)
    if (!info) scenes.set(id, (info = { id, name: null, steps: null, duration: null, cues: [], lastPlayed: null, units: [], stepOf: new Map() }))
    return info
  }
  for (const entry of ctx.sceneNames) if (entry.id) sceneFor(entry.id).name = entry.name
  for (const memory of scenePlayer.memories()) {
    const play = memory.play
    if (/~r\d+$/.test(play.id)) continue
    const info = sceneFor(play.id)
    info.name = play.name ?? info.name
    info.steps = play.steps.map((step) => ({ name: step.name, at: step.at, ...(step.pause ? { pause: true } : {}) }))
    info.duration = play.duration
    info.cues = play.cues.map((cue) => cue.text)
    for (const object of play.objects) {
      if (object.ghost) continue
      const step = stepOfObject(play, object.id)
      if (!step) continue
      const ids = object.item ? [object.item] : object.targets.map((target) => target.nodeId)
      for (const id of ids) {
        const node = byId.get(id)
        const unitId = node && isInk(node) ? groupOfStroke.get(id)?.id : id
        if (unitId && !info.stepOf.has(unitId)) info.stepOf.set(unitId, step)
      }
    }
  }
  for (const entry of scenePlayer.playedLog()) {
    const id = entry.scene.replace(/~r\d+$/, '')
    const info = scenes.get(id)
    if (info) info.lastPlayed = entry.start
  }
  for (const unit of units) if (unit.scene && unit.author === 'agent') sceneFor(unit.scene).units.push(unit)
  return { ctx, state, index, byId, units, unitById, groupById, groupOfStroke, scenes, view: viewportRect(state) }
}

// ---------- Lines ----------

function sceneLabel(info: SceneInfo): string {
  return info.name !== null ? `scene ${q(info.name)}` : `an earlier scene ${info.id}`
}

/** The scene call argument: its name when the name is unique, else its id. */
function sceneArg(m: Model, info: SceneInfo): string {
  if (info.name !== null && [...m.scenes.values()].filter((other) => other.name === info.name).length === 1) return q(info.name)
  return q(info.id)
}

function frameLabel(m: Model, id: string): string {
  const unit = m.unitById.get(id)
  const node = m.byId.get(id)
  if (!node) return id
  const name = nameOf(node) ?? unit?.title
  return `${node.kind}${name ? ` ${q(name)}` : ''} ${id}`
}

function strokesOf(m: Model, group: InkGroup): InkNode[] {
  return group.strokes.map((id) => m.byId.get(id)).filter((node): node is InkNode => !!node && isInk(node))
}

/** What a unit holds, in a few words. */
function holds(m: Model, unit: Unit): string {
  if (unit.group) {
    const strokes = strokesOf(m, unit.group)
    const sizes = inkSizes(strokes)
    return `${plural(strokes.length, 'stroke')}${sizes.points >= 2000 ? ` (points ${about(sizes.points)} characters)` : ''}`
  }
  const node = unit.node as BoardNode
  if (node.kind === 'text') return `“${firstWords(shownText(node))}”`
  if (isFrame(node)) return `${unit.title ? `“${unit.title}” · ` : ''}${plural(unit.inside, 'item')} inside`
  if (isLive(node)) return liveSummary(node)
  if (node.kind === 'image') {
    const src = String((node as { src?: unknown }).src ?? '')
    return src.startsWith('data:') ? 'embedded image' : src.slice(src.lastIndexOf('/') + 1)
  }
  if (node.kind === 'svg') {
    const words = firstWords(shownText(node), 32)
    const length = String((node as { markup?: unknown }).markup ?? '').length
    return [words ? `“${words}”` : '', length >= 5000 ? `markup ${num(length)} characters` : ''].filter(Boolean).join(' · ')
  }
  return ''
}

/** One outline line: kind "name" id · place · what it holds · references. */
function unitLine(m: Model, unit: Unit, refs: { scene?: boolean; author?: boolean } = {}): string {
  const parts = [`${unit.kind}${unit.name ? ` ${q(unit.name)}` : ''} ${unit.id}`, place(unit.bounds)]
  const what = holds(m, unit)
  if (what) parts.push(what)
  if (refs.author) parts.push(unit.author === 'learner' ? 'learner' : 'yours')
  if (unit.parent !== ROOT) parts.push(`inside ${frameLabel(m, unit.parent)}`)
  if (refs.scene && unit.scene) {
    const info = m.scenes.get(unit.scene)
    if (info) parts.push(`from ${sceneLabel(info)}`)
  }
  if (unit.orphan) parts.push('orphaned (its frame is gone)')
  if (unit.legacy) parts.push('a kind this app does not know')
  return parts.join(' · ')
}

function kindCounts(units: Unit[]): string {
  const counts = new Map<string, number>()
  for (const unit of units) {
    const word = unit.kind === 'ink' ? 'ink group' : unit.kind
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts].map(([word, count]) => plural(count, word)).join(', ')
}

function sceneLine(info: SceneInfo, inPart?: number): string {
  const parts = [sceneLabel(info)]
  if (info.steps) parts.push(plural(info.steps.length, 'step'))
  parts.push(info.units.length ? `${plural(info.units.length, 'item')} (${kindCounts(info.units)})` : 'no items on the board now')
  if (inPart !== undefined && inPart < info.units.length) parts.push(`${num(inPart)} in this part`)
  const bounds = unionRegions(info.units.map((unit) => unit.bounds))
  if (bounds) parts.push(place(bounds))
  if (info.lastPlayed) parts.push(`last played ${new Date(info.lastPlayed).toLocaleTimeString('en-GB')}`)
  if (info.name === null) parts.push('its name and steps are not known: it played before the app last started')
  return parts.join(' · ')
}

// ---------- Areas: clusters of units by place ----------

const clusterUnits = (units: Unit[], gap: number): Unit[][] => clusterByPlace(units, (unit) => unit.bounds, gap)

/** Units in areas: by closeness, else (one dense area) by a 3×3 grid of their bounds. */
function areas(units: Unit[]): Unit[][] {
  const clusters = clusterUnits(units, AREA_GAP)
  if (clusters.length > 1) return clusters
  const all = unionRegions(units.map((unit) => unit.bounds))
  if (!all) return [units]
  const cells = new Map<number, Unit[]>()
  for (const unit of units) {
    const b = unit.bounds ?? all
    const cx = Math.min(2, Math.floor(((b.x + b.width / 2 - all.x) / Math.max(1, all.width)) * 3))
    const cy = Math.min(2, Math.floor(((b.y + b.height / 2 - all.y) / Math.max(1, all.height)) * 3))
    const key = cy * 3 + cx
    const list = cells.get(key)
    if (list) list.push(unit)
    else cells.set(key, [unit])
  }
  return [...cells.values()]
}

function titlesOf(units: Unit[], count = 3): string {
  const titles: string[] = []
  for (const unit of units) {
    const title = unit.name ?? unit.title ?? (unit.node && unit.node.kind === 'text' ? firstWords(shownText(unit.node), 24) : '')
    if (title && !titles.includes(title)) titles.push(title)
    if (titles.length >= count) break
  }
  return titles.length ? titles.map((title) => `“${title}”`).join(', ') : ''
}

function areaLine(units: Unit[], what: string, call: (region: Region) => string): string {
  const bounds = unionRegions(units.map((unit) => unit.bounds))
  const parts = [`area ${place(bounds)}`, what]
  const titles = titlesOf(units)
  if (titles) parts.push(titles)
  if (bounds) parts.push(call(bounds))
  return parts.join(' · ')
}

// ---------- list_items: the outline of a part ----------

interface Sections {
  learner: Unit[]
  scenes: Array<{ info: SceneInfo; inPart: number }>
  material: Unit[]
  other: Unit[]
}

function isMaterial(unit: Unit): boolean {
  return unit.kind === 'frame' && unit.parent === ROOT && !!(unit.name ?? unit.title)
}

function sectionsOf(m: Model, keep: (unit: Unit) => boolean): Sections {
  const learner: Unit[] = []
  const material: Unit[] = []
  const other: Unit[] = []
  const inScene = new Map<string, number>()
  for (const unit of m.units) {
    if (!keep(unit)) continue
    if (isMaterial(unit)) material.push(unit)
    if (unit.legacy || unit.orphan) {
      other.push(unit)
      continue
    }
    if (unit.author === 'learner') {
      learner.push(unit)
      continue
    }
    if (unit.scene) inScene.set(unit.scene, (inScene.get(unit.scene) ?? 0) + 1)
    else if (!isMaterial(unit)) other.push(unit)
  }
  const scenes = [...inScene].map(([id, inPart]) => ({ info: m.scenes.get(id) as SceneInfo, inPart }))
  return { learner, scenes, material, other }
}

function unitsSection(m: Model, title: string, units: Unit[], summarise: boolean, refs: { scene?: boolean; author?: boolean }, call: (region: Region) => string): string[] {
  if (!units.length) return []
  const lines = [`${title} (${num(units.length)})`]
  if (summarise && units.length > SUMMARY_AT) {
    const groups = areas(units)
    if (groups.length > 1) {
      lines.push(`  in ${num(groups.length)} areas; each area opens in full with its call:`)
      for (const group of groups) lines.push(`  ${areaLine(group, kindCounts(group), call)}`)
      return lines
    }
  }
  for (const unit of units) lines.push(`  ${unitLine(m, unit, refs)}`)
  return lines
}

function outline(m: Model, rect: Region | null, summarise: boolean, depthNote: string): string[] {
  const keep = (unit: Unit): boolean => !rect || intersects(unit.bounds, rect)
  const sections = sectionsOf(m, keep)
  const regionCall = (region: Region): string => `list_items({part: {region: ${regionArg(region)}}})`
  const lines: string[] = []
  lines.push(...unitsSection(m, "Learner's work", sections.learner, summarise, {}, regionCall))
  if (sections.scenes.length) {
    lines.push(`Your scenes (${num(sections.scenes.length)})`)
    if (summarise && sections.scenes.length > SUMMARY_AT) {
      const pseudo: Unit[] = sections.scenes.map(({ info }) => ({ id: info.id, kind: 'scene', author: 'agent', name: info.name ?? undefined, bounds: unionRegions(info.units.map((unit) => unit.bounds)), parent: ROOT, inside: 0 }))
      const groups = areas(pseudo)
      lines.push(`  in ${num(groups.length)} areas; each area opens in full with its call:`)
      for (const group of groups) lines.push(`  ${areaLine(group, plural(group.length, 'scene'), regionCall)}`)
    } else
      for (const { info, inPart } of sections.scenes) {
        lines.push(`  ${sceneLine(info, rect ? inPart : undefined)}`)
        // An explicit part lists the scene's items in it too.
        if (!summarise) for (const unit of info.units) if (keep(unit)) lines.push(`    ${unitLine(m, unit)}`)
      }
  }
  lines.push(...unitsSection(m, 'Material', sections.material, summarise, { scene: true, author: true }, regionCall))
  lines.push(...unitsSection(m, 'Other (no scene known, or orphaned, or an unknown kind)', sections.other, summarise, { author: true }, regionCall))
  const empty = ["Learner's work", 'Your scenes', 'Material', 'Other'].filter((_, i) => ![sections.learner, sections.scenes, sections.material, sections.other][i].length)
  if (empty.length === 4) lines.push(rect ? 'Nothing on the board in this part.' : 'The board is empty.')
  else if (empty.length) lines.push(`${empty.join(', ')}: none.`)
  if (depthNote) lines.push(depthNote)
  return lines
}

function elsewhere(m: Model): string[] {
  const outside = m.units.filter((unit) => unit.bounds && !intersects(unit.bounds, m.view))
  if (!outside.length) return ['Elsewhere: nothing outside the view.']
  const clusters = clusterUnits(outside, AREA_GAP * 2)
  const describe = (units: Unit[]): string => {
    const learner = units.filter((unit) => unit.author === 'learner')
    const byScene = new Map<string, number>()
    for (const unit of units) if (unit.author === 'agent' && unit.scene) byScene.set(unit.scene, (byScene.get(unit.scene) ?? 0) + 1)
    const rest = units.filter((unit) => unit.author === 'agent' && !unit.scene)
    const parts: string[] = []
    if (learner.length) parts.push(`learner: ${kindCounts(learner)}`)
    for (const [id, count] of byScene) {
      const info = m.scenes.get(id)
      parts.push(`${info ? sceneLabel(info) : `scene ${id}`}: ${plural(count, 'item')}`)
    }
    if (rest.length) parts.push(`yours with no scene: ${kindCounts(rest)}`)
    return parts.join('; ')
  }
  const lines = [`Elsewhere (outside the view, ${plural(outside.length, 'item')})`]
  const entries = clusters.map((units) => ({ units, bounds: unionRegions(units.map((unit) => unit.bounds)) as Region }))
  if (entries.length > SUMMARY_AT) {
    // One level up: by side of the view.
    const sides = new Map<string, Unit[]>()
    for (const entry of entries) {
      const side = relation(entry.bounds, m.view).side
      sides.set(side, [...(sides.get(side) ?? []), ...entry.units])
    }
    for (const [side, units] of sides) {
      const bounds = unionRegions(units.map((unit) => unit.bounds)) as Region
      lines.push(`  ${side} the view: ${describe(units)} · area ${place(bounds)} · list_items({part: {region: ${regionArg(bounds)}}})`)
    }
    return lines
  }
  for (const { units, bounds } of entries) {
    const { gap, side } = relation(bounds, m.view)
    const titles = titlesOf(units)
    lines.push(`  ${side} the view, ${num(gap)} away: ${describe(units)} · area ${place(bounds)}${titles ? ` · ${titles}` : ''} · list_items({part: {region: ${regionArg(bounds)}}})`)
  }
  return lines
}

/** The state header: board, revision, view, hidden areas, selection, tool, playback, the agent's last look. */
function header(m: Model, look: number | null): string[] {
  const { ctx, state } = m
  const revision = state.nextSeq - 1
  const lines: string[] = []
  const folder = ctx.folder ? ` in the folder ${q(ctx.folder.name)} (${ctx.folder.root})` : ''
  lines.push(`Board ${q(boardName(ctx.path))} (${ctx.path})${folder}, revision c${revision}.`)
  const others = ctx.boards.filter((path) => path !== ctx.path).length
  lines.push(others ? `Other boards: ${num(others)} · list_boards() lists them.` : 'Other boards: none.')
  lines.push(`View ${place(m.view)}, zoom ${Math.round(state.camera.zoom * 100) / 100}.`)
  const covered = coveredOf(ctx.board)
  if (covered.length) lines.push(`Hidden from the learner: ${covered.map((area) => `${area.by} ${place(area)}`).join('; ')}.`)
  if (state.selectedIds.length) {
    const bounds = unionRegions(state.selectedIds.map((id) => state.bounds(id)))
    lines.push(`Selected by the learner: ${plural(state.selectedIds.length, 'item')} at ${place(bounds)}: get_screenshot({part: "selection"}).`)
  }
  const status = scenePlayer.status()
  const playing = status.scene
    ? `${q(status.name ?? status.scene)}${status.step ? `, step ${q(status.step)}` : ''}, ${status.t ?? 0} s of ${Math.round((status.duration ?? 0) * 10) / 10} s${status.paused ? ', paused' : ''}${status.queue.length ? `; ${plural(status.queue.length, 'scene')} waiting` : ''}. The board already holds the end state; the learner sees an earlier moment`
    : 'nothing'
  lines.push(`Tool: ${ctx.tool}. Playing: ${playing}.`)
  if (look !== null) {
    const present = new Set(state.nodes.map((node) => node.id))
    const changed = state.nodes.filter((node) => node.seq > look).length + (ctx.log?.after(look) ?? []).filter((tombstone) => !present.has(tombstone.id)).length
    lines.push(`Your last look: c${Math.max(0, look)}${changed ? `; ${plural(changed, 'item')} changed since: get_changes()` : '; nothing changed since'}.`)
  }
  return lines
}

/** The short state line for narrow reads (an id, a region, a scene, a name, a search): board, revision, and the cursor when things changed. */
function shortHeader(m: Model, look: number | null): string {
  const { ctx, state } = m
  const revision = state.nextSeq - 1
  let changed = 0
  if (look !== null) {
    const present = new Set(state.nodes.map((node) => node.id))
    changed = state.nodes.filter((node) => node.seq > look).length + (ctx.log?.after(look) ?? []).filter((tombstone) => !present.has(tombstone.id)).length
  }
  return `Board ${q(boardName(ctx.path))} (${ctx.path}), revision c${revision}${changed ? `; ${plural(changed, 'item')} changed since your last look c${Math.max(0, look as number)}: get_changes()` : ''}.`
}

// ---------- Parts ----------

type Resolved =
  | { kind: 'view' }
  | { kind: 'board' }
  | { kind: 'selection' }
  | { kind: 'region'; rect: Region }
  | { kind: 'ids'; ids: string[] }
  | { kind: 'scene'; info: SceneInfo; step?: number | string }
  | { kind: 'changes'; from: number; to: number; handle: string }
  | { kind: 'candidates'; text: string; options: string[] }

/** "c115-c1115" → seqs; c0 (everything) starts below the seq 0 of files that carry none. */
export function parseHandle(handle: string): { from: number; to: number } {
  const match = /^c(\d+)-c(\d+)$/.exec(handle.trim())
  if (!match) throw new Error(`"${handle}" is not a change interval. Intervals look like "c115-c1115"; get_changes returns them.`)
  const from = Number(match[1])
  const to = Number(match[2])
  if (to < from) throw new Error(`The change interval "${handle}" ends before it starts.`)
  return { from: from === 0 ? -1 : from, to }
}

export const handleOf = (from: number, to: number): string => `c${Math.max(0, from)}-c${Math.max(0, to)}`

function findScene(m: Model, ref: string): SceneInfo | null {
  const byId = m.scenes.get(ref)
  if (byId) return byId
  const named = [...m.scenes.values()].filter((info) => info.name === ref)
  return named.length ? named[named.length - 1] : null
}

/** A part argument as one of its explicit forms. A plain string is resolved when exactly one thing has it. */
function resolvePart(m: Model, part: PartArg | undefined, tool: string): Resolved {
  if (part === undefined || part === 'view') return { kind: 'view' }
  if (part === 'board') return { kind: 'board' }
  if (part === 'selection') return { kind: 'selection' }
  if (typeof part === 'string') return resolveName(m, part, tool)
  if ('region' in part) {
    const r = part.region
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) throw new Error('region needs {x, y, width, height} in board points, with width and height above 0.')
    return { kind: 'region', rect: r }
  }
  if ('id' in part) {
    const ids = Array.isArray(part.id) ? part.id : [part.id]
    if (!ids.length) throw new Error('id needs one id or a list of ids.')
    return { kind: 'ids', ids }
  }
  if ('scene' in part) {
    const info = findScene(m, part.scene)
    if (!info) throw new Error(`No scene ${q(part.scene)} on this board. ${knownScenes(m)}`)
    return { kind: 'scene', info, ...(part.step !== undefined ? { step: part.step } : {}) }
  }
  if ('changes' in part) {
    const { from, to } = parseHandle(part.changes)
    return { kind: 'changes', from, to, handle: part.changes.trim() }
  }
  throw new Error('part is "view", "board", "selection", {region}, {id}, {scene} or {changes}, or a plain id or name.')
}

function knownScenes(m: Model): string {
  const named = [...m.scenes.values()].filter((info) => info.name !== null).map((info) => q(info.name as string))
  const unnamed = [...m.scenes.values()].filter((info) => info.name === null).map((info) => info.id)
  return `Scenes: ${[...new Set(named), ...unnamed].join(', ') || 'none'}.`
}

function resolveName(m: Model, text: string, tool: string): Resolved {
  const options: Array<{ form: Resolved; arg: string; what: string }> = []
  const node = m.byId.get(text)
  if (node || m.groupById.has(text)) {
    const unit = m.unitById.get(text)
    options.push({ form: { kind: 'ids', ids: [text] }, arg: `{id: ${q(text)}}`, what: unit ? unitLine(m, unit) : node ? `${node.kind} ${text}` : `ink ${text}` })
  }
  for (const info of m.scenes.values()) {
    if (info.name === text || info.id === text) options.push({ form: { kind: 'scene', info }, arg: `{scene: ${q(info.id === text ? info.id : text)}}`, what: sceneLine(info) })
  }
  const lower = text.toLowerCase()
  for (const unit of m.units) {
    if (unit.id === text) continue
    if (unit.name && unit.name.toLowerCase() === lower) options.push({ form: { kind: 'ids', ids: [unit.id] }, arg: `{id: ${q(unit.id)}}`, what: unitLine(m, unit, { scene: true }) })
  }
  // Named nodes inside units (an html() root's named parts).
  for (const candidate of m.state.nodes) {
    if (m.unitById.has(candidate.id) || isInk(candidate)) continue
    if (nameOf(candidate)?.toLowerCase() === lower) options.push({ form: { kind: 'ids', ids: [candidate.id] }, arg: `{id: ${q(candidate.id)}}`, what: `${candidate.kind} ${q(nameOf(candidate) as string)} ${candidate.id} · ${place(m.state.bounds(candidate.id))}` })
  }
  if (options.length === 1) return options[0].form
  if (!options.length) throw new Error(`No item, ink group or scene has the id or name ${q(text)}. ${knownScenes(m)} list_items() lists the board; list_items({query: ${q(text)}}) searches the text.`)
  const lines = [`${q(text)} names ${num(options.length)} things, so nothing was read. Say which one:`]
  for (const option of options) lines.push(`  ${tool}({part: ${option.arg}}) · ${option.what}`)
  return { kind: 'candidates', text: lines.join('\n'), options: options.map((option) => option.arg) }
}

// ---------- Item trees (part {id}, depth) ----------

function treeLines(m: Model, nodeId: string, depth: number, indent: string, lines: string[]): void {
  const inkIn = (key: string, pad: string): void => {
    for (const group of m.ctx.groups) if ((group.parent || ROOT) === key) lines.push(`${pad}${unitLine(m, m.unitById.get(group.id) as Unit, { author: true }).replace(/ · inside [^·]+$/, '')}`)
  }
  const walk = (key: string, level: number, pad: string): void => {
    for (const child of m.index.children.get(key) ?? []) {
      if (isInk(child)) continue
      lines.push(`${pad}${childLine(m, child)}`)
      if (isLive(child)) inkIn(child.id, `${pad}  `)
      if (isFrame(child)) {
        if (level < depth) {
          walk(child.id, level + 1, `${pad}  `)
          inkIn(child.id, `${pad}  `)
        } else {
          const count = withDescendants([child.id], m.index).size - 1
          if (count) lines.push(`${pad}  … ${plural(count, 'item')} below: list_items({part: {id: ${q(child.id)}}, depth: ${depth + 1}})`)
        }
      }
    }
  }
  walk(nodeId, 2, indent)
  inkIn(nodeId, indent)
}

function childLine(m: Model, node: BoardNode): string {
  const unit = m.unitById.get(node.id)
  if (unit) return unitLine(m, unit, { scene: true, author: true }).replace(/ · inside [^·]+$/, '')
  const parts = [`${node.kind}${nameOf(node) ? ` ${q(nameOf(node) as string)}` : ''} ${node.id}`, place(m.state.bounds(node.id))]
  const pseudo: Unit = { id: node.id, kind: node.kind, author: authorOf(node), bounds: null, node, parent: ROOT, inside: isFrame(node) ? withDescendants([node.id], m.index).size - 1 : 0 }
  const what = holds(m, pseudo)
  if (what) parts.push(what)
  if (isKnown(node) && isFrame(node) && node.style.display === 'flex') parts.push(`flex ${node.style.flexDirection ?? 'row'}`)
  return parts.join(' · ')
}

function idsText(m: Model, ids: string[], depth: number): string[] {
  const lines: string[] = []
  const errors: string[] = []
  for (const id of ids) {
    if (isGroupId(id)) {
      const unit = m.unitById.get(id)
      if (!unit?.group) {
        errors.push(`${id}: no ink group with this id on the open board.`)
        continue
      }
      const sizes = inkSizes(strokesOf(m, unit.group))
      lines.push(unitLine(m, unit, { scene: true, author: true }))
      lines.push(`  stroke ids: get_item({id: ${q(id)}, as: "strokes"}) (${about(sizes.strokes)} characters) · points: as "points" (${about(sizes.points)}) · to read it: get_screenshot({part: {id: ${q(id)}}})`)
      continue
    }
    const node = m.byId.get(id)
    if (!node) {
      errors.push(`${id}: no item with this id on the open board.`)
      continue
    }
    if (isInk(node)) {
      const group = m.groupOfStroke.get(id)
      lines.push(`ink stroke ${id} · ${place(m.state.bounds(id))} · ${plural(node.points.length, 'point')}${group ? ` · in ink group ${group.id}` : ''}`)
      continue
    }
    lines.push(childLine(m, node) + (m.unitById.get(id)?.parent !== undefined && m.unitById.get(id)?.parent !== ROOT ? ` · inside ${frameLabel(m, m.unitById.get(id)!.parent)}` : ''))
    if (depth > 1) treeLines(m, id, depth, '  ', lines)
  }
  if (errors.length) lines.push(...errors.map((error) => `Error: ${error}`))
  return lines
}

function sceneText(m: Model, info: SceneInfo, step: number | string | undefined, depth: number): string[] {
  const lines = [sceneLine(info)]
  let units = info.units
  let stepName: string | null = null
  if (step !== undefined) {
    if (!info.steps) throw new Error(`The steps of ${sceneLabel(info)} are not known: it played before the app last started; list_items({part: {scene: ${sceneArg(m, info)}}}) lists its items.`)
    const found = typeof step === 'number' ? info.steps[step - 1] : info.steps.find((entry) => entry.name === step)
    if (!found) throw new Error(`${sceneLabel(info)} has no step ${typeof step === 'number' ? step : q(step)}. Its steps: ${info.steps.map((entry, i) => `${i + 1} ${q(entry.name)}`).join(', ') || 'none'}.`)
    stepName = found.name
    units = units.filter((unit) => info.stepOf.get(unit.id) === stepName)
  }
  const itemLine = (unit: Unit): string => {
    const line = `    ${unitLine(m, unit, { author: false })}`
    if (unit.node && isFrame(unit.node) && depth > 1) {
      const inner: string[] = []
      treeLines(m, unit.id, Math.min(depth, 2), '      ', inner)
      return [line, ...inner].join('\n')
    }
    return line
  }
  if (info.steps && info.steps.length) {
    info.steps.forEach((entry, i) => {
      if (stepName !== null && entry.name !== stepName) return
      const own = units.filter((unit) => info.stepOf.get(unit.id) === entry.name)
      lines.push(`  step ${i + 1} ${q(entry.name)} at ${Math.round(entry.at * 10) / 10} s${entry.pause ? ' (pause)' : ''}: ${own.length ? plural(own.length, 'item') : 'no items of its own'}`)
      for (const unit of own) lines.push(itemLine(unit))
    })
    const unknown = stepName === null ? units.filter((unit) => !info.stepOf.has(unit.id)) : []
    if (unknown.length) {
      lines.push(`  step not known (made or changed later, or a part of a group): ${plural(unknown.length, 'item')}`)
      for (const unit of unknown) lines.push(itemLine(unit))
    }
  } else {
    lines.push('  items by kind (the steps are not known: the scene played before the app last started):')
    const kinds = [...new Set(units.map((unit) => unit.kind))]
    for (const kind of kinds) for (const unit of units.filter((entry) => entry.kind === kind)) lines.push(itemLine(unit))
  }
  if (info.cues.length) lines.push(`  say lines: ${num(info.cues.length)} (list_items({query: "…"}) searches them)`)
  return lines
}

// ---------- find ----------

interface Match {
  where: string
  context: string
  bounds: Region | null
  /** The unit (top-level frame or item) the match sits in, for summaries. */
  root: string
}

function findText(m: Model, query: string, rect: Region | null, explicit: boolean): string[] {
  const needle = query.toLowerCase().trim()
  if (!needle) throw new Error('query needs some text to search for.')
  const matches: Match[] = []
  const rootOf = (node: BoardNode): string => {
    let current: BoardNode | undefined = node
    while (current) {
      if (m.unitById.has(current.id) && parentKey(current, m.byId) === ROOT) return current.id
      const key = parentKey(current, m.byId)
      current = key === ROOT ? undefined : m.byId.get(key)
    }
    return node.id
  }
  for (const node of m.state.nodes) {
    if (isInk(node)) continue
    const bounds = m.state.bounds(node.id)
    if (rect && !intersects(bounds, rect)) continue
    const label = `${node.kind}${nameOf(node) ? ` ${q(nameOf(node) as string)}` : ''} ${node.id}`
    const key = parentKey(node, m.byId)
    const inside = key !== ROOT ? ` · inside ${frameLabel(m, key)}` : ''
    const scene = sceneIdOf(node)
    const sceneRef = scene && m.scenes.get(scene) ? ` · ${sceneLabel(m.scenes.get(scene) as SceneInfo)}` : ''
    const hit = matchText(itemTexts(node), needle)
    if (hit) matches.push({ where: `${label} · ${place(bounds)}${inside}${sceneRef}`, context: matchWords(hit), bounds, root: rootOf(node) })
  }
  const sceneMatches: string[] = []
  if (!rect || !explicit) {
    for (const info of m.scenes.values()) {
      if (info.name && info.name.toLowerCase().includes(needle)) sceneMatches.push(`  ${sceneLabel(info)} (its name) · list_items({part: {scene: ${sceneArg(m, info)}}})`)
      for (const cue of info.cues) {
        const at = cue.toLowerCase().indexOf(needle)
        if (at >= 0) sceneMatches.push(`  say line of ${sceneLabel(info)}: “${contextOf(cue, at, needle.length)}”`)
      }
    }
  }
  const lines = [`Search for ${q(query)} on ${rect ? 'this part of ' : ''}the open board: ${plural(matches.length + sceneMatches.length, 'match', 'matches')}.`]
  if (!explicit && matches.length > SUMMARY_AT) {
    const byRoot = new Map<string, Match[]>()
    for (const match of matches) byRoot.set(match.root, [...(byRoot.get(match.root) ?? []), match])
    lines.push(`  in ${plural(byRoot.size, 'place')}; each opens in full with its call:`)
    for (const [root, list] of byRoot) {
      const unit = m.unitById.get(root)
      lines.push(`  ${unit ? unitLine(m, unit) : root}: ${plural(list.length, 'match', 'matches')}, first ${list[0].context} · list_items({query: ${q(query)}, part: {id: ${q(root)}}})`)
    }
  } else for (const match of matches) lines.push(`  ${match.where} · ${match.context}`)
  lines.push(...sceneMatches)
  lines.push("Handwriting is not text: the app cannot read ink. To read the learner's writing, look with get_screenshot.")
  return lines
}

// ---------- list_items ----------

export function boardRead(ctx: ReadContext, params: { part?: PartArg; query?: string; depth?: number; look: number | null }): string {
  const m = buildModel(ctx)
  const depth = Math.max(1, Math.min(10, Math.floor(params.depth ?? 3)))
  const resolved = resolvePart(m, params.part, 'list_items')
  if (resolved.kind === 'candidates') return resolved.text
  if (resolved.kind === 'changes') throw new Error('{changes} is a part for get_screenshot; get_changes({changes: "…"}) reports an interval.')
  if (params.query !== undefined) {
    // Without a part, find searches the whole board.
    const rect = params.part === undefined ? null : partRect(m, resolved)
    return [shortHeader(m, params.look), ...findText(m, params.query, rect, params.part !== undefined && resolved.kind !== 'view' && resolved.kind !== 'board')].join('\n')
  }
  // The full state header for the view and the whole board; one short line for narrower parts.
  const lines = resolved.kind === 'view' || resolved.kind === 'board' ? header(m, params.look) : [shortHeader(m, params.look)]
  lines.push('')
  switch (resolved.kind) {
    case 'view': {
      lines.push(...outline(m, m.view, true, ''))
      lines.push(...elsewhere(m))
      const first = [...m.scenes.values()].filter((info) => info.units.length).at(-1)
      const ink = m.units.find((unit) => unit.group && unit.author === 'learner' && intersects(unit.bounds, m.view))
      // No pointers when the view holds nothing: an empty board has nothing to show, and "Elsewhere" gives the calls for items outside the view.
      if (m.units.some((unit) => intersects(unit.bounds, m.view)))
        lines.push('', `Deeper: ${[first ? `list_items({part: {scene: ${sceneArg(m, first)}}})` : '', ink ? `get_item({id: ${q(ink.id)}})` : 'get_item({id: "…"})', 'list_items({part: "board"})', 'list_items({query: "…"})', 'get_screenshot()'].filter(Boolean).join(' · ')}`)
      break
    }
    case 'board':
      lines.push('The whole board:')
      lines.push(...outline(m, null, true, ''))
      if (m.units.length) lines.push('', 'Deeper: list_items({part: {region: …}}) or {scene: …} or {id: …} · list_items({query: "…"}) · get_screenshot({part: "board"})')
      break
    case 'selection':
    case 'region': {
      const rect = partRect(m, resolved)
      if (!rect) {
        lines.push('The learner has nothing selected.')
        break
      }
      lines.push(`Part ${place(rect)}:`)
      lines.push(...outline(m, rect, false, ''))
      lines.push('', `Deeper: list_items({part: {id: "…"}}) · get_item({id: [...]}) for exact values · get_screenshot({part: {region: ${regionArg(rect)}}})`)
      break
    }
    case 'ids':
      lines.push(...idsText(m, resolved.ids, depth))
      lines.push('', `Deeper: get_item({id: ${q(resolved.ids.length === 1 ? resolved.ids[0] : '…')}}) for exact values · get_screenshot({part: {id: ${resolved.ids.length === 1 ? q(resolved.ids[0]) : '[…]'}}})`)
      break
    case 'scene':
      lines.push(...sceneText(m, resolved.info, resolved.step, depth))
      lines.push('', `Deeper: get_item({id: [...]}) for exact values · get_screenshot({part: {scene: ${sceneArg(m, resolved.info)}}})`)
      break
  }
  return lines.join('\n')
}

/** The board rect a resolved part covers (null: the whole board, or nothing selected). */
function partRect(m: Model, resolved: Resolved): Region | null {
  switch (resolved.kind) {
    case 'view':
      return m.view
    case 'region':
      return resolved.rect
    case 'selection':
      return unionRegions(m.state.selectedIds.map((id) => m.state.bounds(id)))
    case 'ids':
      return unionRegions(resolved.ids.map((id) => m.unitById.get(id)?.bounds ?? m.state.bounds(id)))
    case 'scene':
      return unionRegions(resolved.info.units.map((unit) => unit.bounds))
    default:
      return null
  }
}

// ---------- get_screenshot's part ----------

export type ShotPart =
  | { kind: 'empty'; message: string }
  | { kind: 'view' | 'board' | 'selection' | 'region' | 'ids' | 'scene'; rect: Region | null; wide: boolean; labelIds: string[] | null; what: string }
  | { kind: 'changes'; from: number; to: number; handle: string; what: string }

/** What a screenshot part frames, and which units its labels name (null: the top-level items and ink groups in the image). */
export function shotPart(ctx: ReadContext, part: PartArg | undefined): ShotPart {
  const m = buildModel(ctx)
  const resolved = resolvePart(m, part, 'get_screenshot')
  switch (resolved.kind) {
    case 'candidates':
      return { kind: 'empty', message: resolved.text }
    case 'changes':
      return { kind: 'changes', from: resolved.from, to: resolved.to, handle: resolved.handle, what: `the changes ${resolved.handle}` }
    case 'view':
      return { kind: 'view', rect: m.view, wide: true, labelIds: null, what: 'the view' }
    case 'board':
      return { kind: 'board', rect: unionRegions(m.state.nodes.map((node) => m.state.bounds(node.id))), wide: true, labelIds: null, what: 'the whole board' }
    case 'selection':
      return { kind: 'selection', rect: partRect(m, resolved), wide: false, labelIds: null, what: 'the selection' }
    case 'region':
      return { kind: 'region', rect: resolved.rect, wide: false, labelIds: null, what: `the region ${place(resolved.rect)}` }
    case 'ids': {
      const missing = resolved.ids.filter((id) => !m.unitById.has(id) && !m.byId.has(id))
      if (missing.length) throw new Error(`No item or ink group ${missing.map(q).join(', ')} on the open board. list_items() lists the ids.`)
      const rect = partRect(m, resolved)
      if (!rect) throw new Error(`${resolved.ids.map(q).join(', ')} has no layout (it may be hidden with display: none).`)
      // The items and what they hold.
      const labelIds = resolved.ids.flatMap((id) => [id, ...(m.index.children.get(id) ?? []).filter((child) => !isInk(child)).map((child) => child.id), ...m.ctx.groups.filter((group) => group.parent === id).map((group) => group.id)])
      return { kind: 'ids', rect, wide: false, labelIds, what: resolved.ids.length === 1 ? `${resolved.ids[0]}` : `${plural(resolved.ids.length, 'item')}` }
    }
    case 'scene': {
      let units = resolved.info.units
      if (resolved.step !== undefined && resolved.info.steps) {
        const found = typeof resolved.step === 'number' ? resolved.info.steps[resolved.step - 1] : resolved.info.steps.find((entry) => entry.name === resolved.step)
        if (!found) throw new Error(`${sceneLabel(resolved.info)} has no step ${q(String(resolved.step))}.`)
        units = units.filter((unit) => resolved.info.stepOf.get(unit.id) === found.name)
      }
      const rect = unionRegions(units.map((unit) => unit.bounds))
      if (!rect) return { kind: 'empty', message: `${sceneLabel(resolved.info)} has no items on the board now.` }
      return { kind: 'scene', rect, wide: false, labelIds: units.map((unit) => unit.id), what: sceneLabel(resolved.info) }
    }
  }
}

// ---------- get_item ----------

export type ItemAs = 'info' | 'html' | 'svg' | 'strokes' | 'points' | 'source'

function strokeEntry(m: Model, stroke: InkNode): { id: string; bounds: BoardRect | null } {
  return { id: stroke.id, bounds: boardRect(m.state.bounds(stroke.id)) }
}

function pointsEntry(m: Model, stroke: InkNode): Record<string, unknown> {
  const layout = m.state.layout().get(stroke.id) as { ox?: number; oy?: number } | undefined
  return { id: stroke.id, tool: stroke.tool, color: stroke.color, width: stroke.width, origin: [r1(layout?.ox ?? stroke.x), r1(layout?.oy ?? stroke.y)], points: savedInkPoints(stroke.points) }
}

/** One id as one form. Throws an agent-readable error for that id. */
function oneItem(m: Model, key: string, as: ItemAs, includeIds: boolean): unknown {
  // An id, or an item's name by the rule board.node uses (item-names.ts).
  const id = itemIdOf(sceneOf(m.ctx.board, () => m.ctx.groups), key)
  if (id === null) throw new Error(`No item with the id or name "${key}" on the open board. list_items() lists the ids.`)
  const group = isGroupId(id) ? m.groupById.get(id) : undefined
  if (isGroupId(id) && !group) throw new Error(`No ink group "${id}" on the open board.`)
  const node = group ? undefined : m.byId.get(id)
  if (!group && !node) throw new Error(`No item with the id or name "${key}" on the open board. list_items() lists the ids.`)
  const strokes: InkNode[] = group ? strokesOf(m, group) : node && isInk(node) ? [node] : []
  switch (as) {
    case 'info': {
      if (group) {
        const unit = m.unitById.get(group.id) as Unit
        const sizes = inkSizes(strokes)
        const tools = [...new Set(strokes.map((stroke) => stroke.tool))]
        const colors = [...new Set(strokes.map((stroke) => stroke.color))]
        const info = unit.scene ? m.scenes.get(unit.scene) : undefined
        return {
          id: group.id,
          kind: 'ink group',
          author: group.author,
          ...(unit.name ? { name: unit.name } : {}),
          parent: group.parent || null,
          bounds: boardRect(group.bounds),
          strokes: strokes.length,
          points: strokes.reduce((total, stroke) => total + stroke.points.length, 0),
          tool: tools.length === 1 ? tools[0] : tools,
          color: colors.length === 1 ? colors[0] : colors,
          seq: group.seq,
          ...(unit.scene ? { scene: info?.name ?? unit.scene } : {}),
          sizes: { strokes_chars: sizes.strokes, points_chars: sizes.points },
          more: `as "strokes": each stroke id and its bounds (${about(sizes.strokes)} characters); as "points": every point (${about(sizes.points)} characters).`
        }
      }
      const scene = sceneOf(m.ctx.board, () => m.ctx.groups)
      return getNodeInfo(scene, id)
    }
    case 'strokes':
      if (!strokes.length) throw new Error(`"${id}" is not ink: as "strokes" is for ink groups and strokes.`)
      return strokes.map((stroke) => strokeEntry(m, stroke))
    case 'points':
      if (!strokes.length) throw new Error(`"${id}" is not ink: as "points" is for ink groups and strokes.`)
      return strokes.map((stroke) => pointsEntry(m, stroke))
    case 'svg':
      if (!node || node.kind !== 'svg') throw new Error(`"${id}" is ${node ? `a ${node.kind}` : 'an ink group'}, not an SVG item: as "svg" is for svg items.`)
      return String((node as { markup?: unknown }).markup ?? '')
    case 'source':
      if (!node || !isLive(node)) throw new Error(`"${id}" is not a code item: as "source" is for live items (shader, canvas, program).`)
      return node.code
    case 'html':
      if (!node || isInk(node)) throw new Error(`"${id}" is ink, which is not HTML: as "html" is for material (frames, text, svg, images).`)
      return nodesToHtml(node.id, m.index, includeIds)
  }
}

/** get_item: one entry per id; a list gives {items, errors} with one error per id that fails. */
export function itemRead(ctx: ReadContext, params: { id: string | string[]; as?: ItemAs; include_ids?: boolean }): string {
  const m = buildModel(ctx)
  const as = params.as ?? 'info'
  const includeIds = params.include_ids !== false
  if (!Array.isArray(params.id)) {
    const value = oneItem(m, params.id, as, includeIds)
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  const items: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const id of params.id) {
    try {
      items[id] = oneItem(m, id, as, includeIds)
    } catch (error) {
      errors[id] = error instanceof Error ? error.message : String(error)
    }
  }
  return JSON.stringify({ items, ...(Object.keys(errors).length ? { errors } : {}) })
}

// ---------- get_changes ----------

interface IntervalChange {
  node: BoardNode
  /** The node as it was at the interval's end (the current node unless it changed again after). */
  at: BoardNode
  change: ChangeDescription
  by: Author | undefined
  /** It changed again after the interval: `node` is its current state. */
  after: boolean
}

interface Interval {
  from: number
  to: number
  changed: IntervalChange[]
  removed: Array<Tombstone & { back: boolean }>
}

/** The net changes of the items between two seqs (from exclusive, to inclusive), from the change log. */
export function intervalOf(state: LiveBoardState, log: ChangeLog | null, from: number, to: number): Interval {
  const changed: IntervalChange[] = []
  for (const node of state.nodes) {
    if (node.seq <= from) continue
    let at: BoardNode = node
    let after = false
    if (node.seq > to) {
      const revision = log?.lastRevisionIn(node.id, from, to)
      if (!revision) continue
      at = revision.after
      after = true
    }
    const change = log ? describeChange(at, log.stateAt(node.id, from)) : { change: 'changed' as const }
    changed.push({ node, at, change, by: state.editor(node.id) ?? authorOf(node), after })
  }
  const present = new Map(state.nodes.map((node) => [node.id, node]))
  const removed = (log?.between(from, to) ?? [])
    .filter((tombstone) => {
      // Put back within the interval: not a removal of it.
      const back = log?.lastRevisionIn(tombstone.id, tombstone.seq, to)
      const now = present.get(tombstone.id)
      return !back && !(now && now.seq > tombstone.seq && now.seq <= to)
    })
    .map((tombstone) => ({ ...tombstone, back: present.has(tombstone.id) }))
  return { from, to, changed, removed }
}

function changedItem(state: LiveBoardState, entry: IntervalChange): ChangedItem & { changed_after?: string } {
  const node = entry.node
  return {
    id: node.id,
    kind: node.kind,
    ...(isInk(node) ? { tool: node.tool, color: node.color } : {}),
    ...(typeof node.name === 'string' ? { name: node.name } : {}),
    ...(entry.by ? { by: entry.by } : {}),
    change: entry.change.change,
    ...(entry.change.offset ? { offset: entry.change.offset } : {}),
    bounds: boardRect(state.bounds(node.id)),
    seq: node.seq,
    ...(entry.after ? { changed_after: 'it changed again after this interval; this is its current state' } : {})
  }
}

function removedItem(tombstone: Tombstone & { back: boolean }): RemovedItem & { back_now?: boolean } {
  return {
    id: tombstone.id,
    kind: tombstone.kind,
    ...(typeof tombstone.node?.name === 'string' ? { name: tombstone.node.name } : {}),
    ...(tombstone.by ? { by: tombstone.by } : {}),
    bounds: boardRect(tombstone.bounds),
    seq: tombstone.seq,
    ...(tombstone.back ? { back_now: true } : {})
  }
}

function groupSummary(group: InkGroup): InkGroupSummary {
  return { id: group.id, author: group.author, parent: group.parent || 'root', strokes: group.strokes.length, bounds: boardRect(group.bounds) as BoardRect, seq: group.seq }
}

/** detail "items": each item of the interval, complete. */
function intervalItems(ctx: ReadContext, interval: Interval, groups: InkGroup[]): Record<string, unknown> {
  const state = ctx.board.liveState()
  const changed = interval.changed.map((entry) => changedItem(state, entry))
  const ids = new Set(changed.map((item) => item.id))
  const touched = groups.filter((group) => group.strokes.some((id) => ids.has(id)))
  return {
    interval: handleOf(interval.from, interval.to),
    board: ctx.path,
    changed,
    removed: interval.removed.map(removedItem),
    ...(touched.length ? { groups_changed: touched.map(groupSummary) } : {})
  }
}

const CHANGE_WORDS: Record<string, string> = { added: 'new', restored: 'back (undo, redo or paste)', moved: 'moved', resized: 'resized', edited: 'edited', changed: 'changed', unchanged: 'changed and changed back' }

function itemWords(m: Model, entry: IntervalChange, all: boolean): string {
  const node = entry.node
  const unit = m.unitById.get(node.id)
  const label = unit ? unitLine(m, unit) : `${node.kind}${nameOf(node) ? ` ${q(nameOf(node) as string)}` : ''} ${node.id} · ${place(m.state.bounds(node.id))}`
  const what = all ? 'on the board' : CHANGE_WORDS[entry.change.change] ?? entry.change.change
  const offset = entry.change.offset ? ` by ${entry.change.offset.dx},${entry.change.offset.dy}` : ''
  return `${label} · ${what}${offset}${entry.after ? ' (changed again after the interval)' : ''}`
}

/** The changes of one author, by unit: ink by ink group, other items one by one (by kind when many), agent items by scene. */
function actorLines(m: Model, entries: IntervalChange[], removed: Array<Tombstone & { back: boolean }>, actor: 'learner' | 'agent', all: boolean): string[] {
  const lines: string[] = []
  const ink = entries.filter((entry) => isInk(entry.node))
  const rest = entries.filter((entry) => !isInk(entry.node) && entry.change.change !== 'unchanged')
  // Ink by ink group: strokes added and otherwise changed.
  const byGroup = new Map<string, { group: InkGroup | undefined; counts: Map<string, number> }>()
  for (const entry of ink) {
    const group = m.groupOfStroke.get(entry.node.id)
    const key = group?.id ?? ''
    const slot = byGroup.get(key) ?? { group, counts: new Map<string, number>() }
    const word = all ? 'on the board' : entry.change.change === 'added' ? 'added' : CHANGE_WORDS[entry.change.change] ?? entry.change.change
    if (entry.change.change !== 'unchanged') slot.counts.set(word, (slot.counts.get(word) ?? 0) + 1)
    byGroup.set(key, slot)
  }
  const sceneOfGroup = (group: InkGroup | undefined): string | undefined => (group ? m.unitById.get(group.id)?.scene : undefined)
  // Agent work by scene.
  // Per scene and per change word: ink groups and their strokes, other items by kind.
  type Tally = { groups: Set<string>; strokes: number; kinds: Map<string, number> }
  const scenes = new Map<string, Map<string, Tally>>()
  const tally = (scene: string, word: string): Tally => {
    const words = scenes.get(scene) ?? new Map<string, Tally>()
    scenes.set(scene, words)
    const slot = words.get(word) ?? { groups: new Set<string>(), strokes: 0, kinds: new Map<string, number>() }
    words.set(word, slot)
    return slot
  }
  for (const [key, { group, counts }] of byGroup) {
    if (!counts.size) continue
    const scene = actor === 'agent' ? sceneOfGroup(group) : undefined
    if (scene) {
      for (const [word, count] of counts) {
        const slot = tally(scene, word === 'added' ? 'new' : word)
        slot.groups.add(key)
        slot.strokes += count
      }
      continue
    }
    const total = group ? group.strokes.length : 0
    const counted = [...counts].map(([word, count]) => `${plural(count, 'stroke')} ${word}`).join(', ')
    const whole = group && counts.get('added') === total ? ` (a new group)` : ''
    lines.push(`  ${group ? `ink ${group.id} · ${place(group.bounds)} · ${plural(total, 'stroke')}${all ? '' : ' now'}` : 'ink outside any group'}${all ? '' : ` · ${counted}`}${whole}${group && group.parent ? ` · inside ${frameLabel(m, group.parent)}` : ''}`)
  }
  const loose: IntervalChange[] = []
  for (const entry of rest) {
    const scene = actor === 'agent' ? sceneIdOf(entry.node) : undefined
    if (scene) {
      const slot = tally(scene, all ? 'on the board' : CHANGE_WORDS[entry.change.change] ?? entry.change.change)
      slot.kinds.set(entry.node.kind, (slot.kinds.get(entry.node.kind) ?? 0) + 1)
    } else loose.push(entry)
  }
  for (const [scene, words] of scenes) {
    const info = m.scenes.get(scene)
    const said = [...words].map(([word, slot]) => {
      const parts = slot.groups.size ? [`${plural(slot.groups.size, 'ink group')} (${plural(slot.strokes, 'stroke')})`] : []
      for (const [kind, count] of slot.kinds) parts.push(`${num(count)} ${kind}`)
      return `${word}: ${parts.join(', ')}`
    })
    lines.push(`  ${info ? sceneLabel(info) : `scene ${scene}`}: ${said.join('; ')} · list_items({part: {scene: ${info ? sceneArg(m, info) : q(scene)}}})`)
  }
  if (loose.length > SUMMARY_AT) {
    const counts = new Map<string, number>()
    for (const entry of loose) {
      const word = `${entry.node.kind} ${all ? 'on the board' : CHANGE_WORDS[entry.change.change] ?? entry.change.change}`
      counts.set(word, (counts.get(word) ?? 0) + 1)
    }
    lines.push(`  other items: ${[...counts].map(([word, count]) => `${num(count)} ${word}`).join(', ')} (each one: detail "items")`)
  } else for (const entry of loose) lines.push(`  ${itemWords(m, entry, all)}`)
  // Removals: ink by area, other items one by one.
  const erased = removed.filter((tombstone) => tombstone.kind === 'ink')
  if (erased.length) {
    const pseudo: Unit[] = erased.map((tombstone) => ({ id: tombstone.id, kind: 'ink', author: actor, bounds: tombstone.bounds, parent: ROOT, inside: 0 }))
    for (const cluster of clusterUnits(pseudo, 40)) lines.push(`  ink · ${plural(cluster.length, 'stroke')} erased at ${place(unionRegions(cluster.map((unit) => unit.bounds)))}`)
  }
  const gone = removed.filter((tombstone) => tombstone.kind !== 'ink')
  const goneIds = new Set(gone.map((tombstone) => tombstone.id))
  const top = gone.filter((tombstone) => {
    const parent = tombstone.node && isKnown(tombstone.node) ? (tombstone.node as { parent?: string }).parent : undefined
    return !parent || !goneIds.has(parent)
  })
  if (top.length > SUMMARY_AT) lines.push(`  removed: ${kindCounts(top.map((tombstone) => ({ id: tombstone.id, kind: tombstone.kind, author: actor, bounds: null, parent: ROOT, inside: 0 })))} (each one: detail "items")`)
  else for (const tombstone of top) lines.push(`  ${tombstone.kind}${tombstone.node && nameOf(tombstone.node) ? ` ${q(nameOf(tombstone.node) as string)}` : ''} ${tombstone.id} · removed from ${place(tombstone.bounds)}${tombstone.back ? ' (back on the board now)' : ''}`)
  return lines
}

export function changeReport(ctx: ReadContext, params: { from: number; to: number | null; detail?: 'items'; all: boolean; again: boolean }): { board: string; cursor: number; text: string } {
  const state = ctx.board.liveState()
  const cursor = state.nextSeq - 1
  const to = params.to === null ? cursor : Math.min(params.to, cursor)
  const interval = intervalOf(state, ctx.log, params.from, to)
  const handle = handleOf(params.from, to)
  if (params.detail === 'items') return { board: ctx.path, cursor, text: JSON.stringify(intervalItems(ctx, interval, ctx.groups)) }
  const m = buildModel(ctx)
  const real = interval.changed.filter((entry) => entry.change.change !== 'unchanged')
  const lines: string[] = []
  const logNote = (): string => {
    const held = ctx.log?.removalCount()
    return `The app keeps its change log in memory while the folder is open (at most ${num(held?.max ?? 0)} removals and the last 32 changes per item), so it knows no removal from before that.`
  }
  if (params.all) lines.push(`Everything on the board now (revision c${cursor}), plus the removals the change log still holds. ${logNote()}`)
  else lines.push(`Changes ${handle}${params.again ? '' : ' (since your last look)'}: the net change of each item, not the order of events.`)
  if (!real.length && !interval.removed.length) {
    lines.push(params.all ? 'The board is empty, and the log holds no removal.' : `Nothing changed${params.again ? ' in this interval' : ' since your last look'}.`)
    return { board: ctx.path, cursor, text: lines.join('\n') }
  }
  for (const actor of ['learner', 'agent'] as const) {
    const own = real.filter((entry) => (entry.by ?? 'learner') === actor)
    const removed = interval.removed.filter((tombstone) => (tombstone.by ?? 'learner') === actor)
    if (!own.length && !removed.length) continue
    lines.push(actor === 'learner' ? 'Learner:' : 'You:')
    lines.push(...actorLines(m, own, removed, actor, params.all))
  }
  const later = interval.changed.filter((entry) => entry.after).length
  if (later) lines.push(`${plural(later, 'item')} changed again after c${to}: the lines above show them as they are now.`)
  const detail = JSON.stringify(intervalItems(ctx, interval, ctx.groups)).length
  lines.push(`Each item: get_changes({changes: ${q(handle)}, detail: "items"}) (${plural(interval.changed.length + interval.removed.length, 'item')}, ${about(detail)} characters) · See them: get_screenshot({part: {changes: ${q(handle)}}})`)
  if (!params.all && ctx.log === null) lines.push('This board has no change log, so a change shows as "changed".')
  return { board: ctx.path, cursor, text: lines.join('\n') }
}
