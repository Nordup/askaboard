import { isContent, newItemId } from '@shared/board-format'
import type { SceneContext, SceneDescription, SceneResult } from '@shared/live-scene'
import type { BoardHandle } from '../board/Board'
import type { InkGroupTracker } from '../agent/groups'
import { viewOf, type Scene } from '../agent/placement'
import { compileScene } from './compile'
import { scenePlayer } from './player'
import { multiply } from './timeline'

/**
 * The renderer half of run_scene. The main process runs the program in its
 * sandbox with sceneContext() as its view of the board, then sends the
 * description here: runScene() commits the final state as one undo step and
 * starts playback.
 */

const r1 = (value: number): number => Math.round(value * 10) / 10
const rect = (box: { x: number; y: number; width: number; height: number }) => ({ x: r1(box.x), y: r1(box.y), width: r1(box.width), height: r1(box.height) })

/** Every node and ink group with its bounds, and the learner's view: the board as a scene program sees it. */
export function sceneContext(board: BoardHandle, s: Scene): SceneContext {
  const nodes: SceneContext['nodes'] = {}
  for (const group of s.groups) nodes[group.id] = { kind: 'ink group', author: group.author, bounds: rect(group.bounds) }
  for (const node of s.nodes) {
    const box = s.layout.get(node.id)
    if (!box) continue
    nodes[node.id] = {
      kind: node.kind,
      ...(typeof node.name === 'string' && node.name ? { name: node.name } : {}),
      ...(typeof node.author === 'string' ? { author: node.author } : {}),
      bounds: rect(box)
    }
  }
  return { nodes, view: rect(viewOf(board)) }
}

function checkDescription(value: unknown): SceneDescription {
  const desc = value as SceneDescription
  if (!desc || !Array.isArray(desc.objects) || !Array.isArray(desc.actions) || !Array.isArray(desc.steps) || typeof desc.duration !== 'number') {
    throw new Error('The scene description is malformed.')
  }
  return desc
}

export interface RunSceneContext {
  board: BoardHandle
  scene: () => Scene
  tracker: InkGroupTracker
}

export function runScene(ctx: RunSceneContext, args: Record<string, unknown>): SceneResult {
  const desc = checkDescription(args.scene)
  const sceneId = newItemId('sc')
  const s = ctx.scene()
  const compiled = compileScene(desc, s, sceneId)
  ctx.board.agentCommit(compiled.next)

  // Typeset text placed by its centre: now that it is measured, move it there (same undo step).
  if (compiled.centers.length) {
    const state = ctx.board.liveState()
    const shifts = new Map<string, [number, number]>()
    for (const { nodeId, center } of compiled.centers) {
      const box = state.bounds(nodeId)
      if (box) shifts.set(nodeId, [center[0] - (box.x + box.width / 2), center[1] - (box.y + box.height / 2)])
    }
    if (shifts.size) {
      ctx.board.agentAmend(state.nodes.map((node) => {
        const shift = shifts.get(node.id)
        return shift && isContent(node) ? { ...node, x: r1(node.x + shift[0]), y: r1(node.y + shift[1]) } : node
      }))
      for (const object of compiled.play.objects) {
        for (const target of object.targets) {
          const shift = shifts.get(target.nodeId)
          if (shift) target.inverseBaked = multiply(target.inverseBaked, [1, 0, 0, 1, -shift[0], -shift[1]])
        }
      }
    }
  }

  // Each ink object is one ink group, as one draw_ink call is.
  const groupOf = new Map<number, string>()
  for (const { object, strokes } of compiled.inkGroups) groupOf.set(object, ctx.tracker.pin(strokes))
  scenePlayer.start(ctx.board, compiled.play)

  const items: string[] = []
  for (const object of compiled.play.objects) {
    if (object.ghost) continue
    const group = groupOf.get(object.id)
    if (group) items.push(group)
    else if (compiled.play.timeline.object(object.id).kind !== 'node') {
      items.push(...object.targets.filter((target) => !target.ink).map((target) => target.nodeId))
    }
  }
  const present = new Set(ctx.board.liveState().nodes.map((node) => node.id))
  const lost = items.filter((id) => !id.startsWith('g') && !present.has(id))
  const warnings = [...desc.warnings, ...compiled.warnings]
  if (lost.length) warnings.push(`${lost.length} item(s) did not reach the board`)
  return {
    scene: sceneId,
    duration_s: Math.round(desc.duration * 1000) / 1000,
    steps: desc.steps.map((step) => ({ name: step.name, at_s: step.at })),
    items,
    log: desc.logs,
    warnings
  }
}
