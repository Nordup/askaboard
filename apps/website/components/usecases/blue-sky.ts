/**
 * "Why is the sky blue?": the scene Claude (Opus, medium) drew in the lab for that one sentence, with nothing else
 * but the app's brief (space/.lab/runs/20261107-194701-custom-claude-opus). Its program is agent/blue-sky.scene.js,
 * as the agent wrote it; agent/blue-sky.json is what the app's scene library makes of it
 * (space/scripts/lab/export-scene.mjs), and public/voice/blue-sky.m4a is its voice. agent-scene.ts plays it.
 */
import scene from './agent/blue-sky.json'
import { agentScene, type AgentScene } from './agent-scene'

export default function create() {
  return agentScene(scene as unknown as AgentScene, '/voice/blue-sky.m4a')
}
