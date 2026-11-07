/**
 * The use cases that play in the app shell under the hero (decision D12, website-plan.md,
 * "Use cases: an app shell that plays drawings"): hand-made scenes, drawn in code as the agent
 * draws them on the app's board.
 *
 * THE ANIMATION INTERFACE
 *
 * One use case is one module in this folder. Its default export is a factory:
 *
 *   export default function create(): Animation
 *
 *   interface Animation {
 *     duration: number                                            // seconds
 *     draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void
 *   }
 *
 * - The shell calls create() once, when the module loads, and draws the instance once offscreen
 *   then (so its ink is built before the first switch). Each time the use case becomes current it
 *   plays the same instance again from t = 0, and during a crossfade it may draw it on two
 *   canvases at two times. So draw() must depend only on t; caches in the closure are fine.
 * - draw() paints one frame. `ctx` is the board canvas, already cleared and scaled so that one
 *   unit is one CSS pixel on screen: draw in the box 0..w × 0..h. The board's dot grid is behind
 *   the canvas (CSS); do not paint a background. The shell's chrome shows at 0.8 of the app's size
 *   (a screenshot of a bigger window); the tool pill covers about the bottom 52 px.
 * - `t` is the seconds since the chat window finished typing the request (AgentPrompt.tsx). The
 *   scene plays once: from `duration` on, it shows its last frame.
 * - With reduced motion, the shell draws one frame at t = duration and no more frames.
 * - Draw in board ink with the site's copy of the app's code: lib/board/kit.ts (Pen, write(),
 *   pen(), Ink: text in the stroke font and hand-drawn lines that draw on), lib/board/hand.ts
 *   (humanize), lib/board/paint.ts (drawStroke, revealPoints) and lib/board/colors.ts (the
 *   colour names). Use the hero's bright colours: yellow, blue, green, pink, orange, purple, teal
 *   and text (white). components/hero/scene.ts shows the patterns.
 * - w and h change with the window (a phone shows a smaller board). Scale the drawing to fit:
 *   placeholder.ts has fit().
 * - Material besides the ink (the app's UI over the board, as its reading panel, script-panel.ts):
 *   mount(host) gets an empty element over the ink canvas, the size of the board in the window's
 *   own CSS px (the window is scaled: w / host.clientWidth is that scale). The shell mounts the
 *   scene when it becomes current and fades the host with the ink; unmount() takes it out again
 *   (the scene shows on another layer, or the page goes). draw() updates the material for t as
 *   well, and may run before mount() (the offscreen draw).
 *
 * Add a use case: write the module, then add an entry to USE_CASES below. The page loads the
 * modules with import() only when the section comes near the viewport.
 */

import type { Logo } from '@/lib/agents'

export interface Animation {
  /** Seconds until the drawing is finished. */
  duration: number
  /** One frame; see the comment above. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void
  /** Put the scene's other board material into `host`; see the comment above. */
  mount?(host: HTMLElement): void
  unmount?(): void
}

export type CreateAnimation = () => Animation

export interface UseCase {
  id: string
  /** The board's name: the sidebar row and the top bar title. */
  board: string
  /** The learner's request, typed into the agent app's window before the board plays (AgentPrompt.tsx). */
  request: string
  /** The chat app the request is typed into: one per use case, so any agent works. Its name and its mark (lib/logos.ts) show in the window's title bar. */
  app: string
  logo: Logo
  /** The module. */
  load(): Promise<{ default: CreateAnimation }>
}

export const USE_CASES: readonly UseCase[] = [
  { id: 'sky', board: 'Blue sky', request: 'Why is the sky blue?', app: 'Claude', logo: 'claude', load: () => import('./blue-sky') },
  { id: 'check', board: 'Algebra', request: 'Can you check my work?', app: 'ChatGPT', logo: 'openai', load: () => import('./waves') },
  { id: 'sheet', board: 'Q3 sales', request: 'Help me understand Q3-sales.xlsx', app: 'Claude', logo: 'claude', load: () => import('./sky') }
]
