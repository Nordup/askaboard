/**
 * "I cannot solve it. Can you help me? Explain everything.": the scene Claude (Opus, medium) drew in the lab for that
 * one sentence, on a board that opened with the learner's own work (space/scripts/lab/council/learners/ladder.js: the
 * exercise in green, their stuck attempt in blue; decision D17), with nothing else but the app's brief
 * (space/.lab/runs/20261107-213221-custom-claude-opus). Its program is agent/ladder.scene.js, as the agent wrote it;
 * agent/ladder.json is what the app's scene library makes of it, with the learner's ink
 * (space/scripts/lab/export-scene.mjs), and public/voice/ladder.m4a is its voice. agent-scene.ts plays it.
 */
import scene from './agent/ladder.json'
import { agentScene, type AgentScene } from './agent-scene'

export default function create() {
  return agentScene(scene as unknown as AgentScene, '/voice/ladder.m4a')
}
