/**
 * "Help me understand Q3-sales.xlsx": the scene Claude (Opus, medium) drew in the lab for that one sentence, with the
 * spreadsheet (apps/desktop/scripts/lab/council/files/Q3-sales.xlsx) in the learning folder and nothing else but the app's
 * brief (apps/desktop/.lab/runs/20261107-204841-custom-claude-opus). Its program is agent/q3-sales.scene.js, as the agent
 * wrote it; agent/q3-sales.json is what the app's scene library makes of it (apps/desktop/scripts/lab/export-scene.mjs), and
 * public/voice/q3-sales.m4a is its voice. agent-scene.ts plays it; its paused steps play straight on.
 */
import scene from './agent/q3-sales.json'
import { agentScene, type AgentScene } from './agent-scene'

export default function create() {
  return agentScene(scene as unknown as AgentScene, '/voice/q3-sales.m4a')
}
