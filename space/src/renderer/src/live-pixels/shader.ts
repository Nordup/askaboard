/**
 * Shader mode of live pixel items: one shared WebGL 2 context for every
 * shader item on the page. Chromium allows only about 16 WebGL contexts per
 * page, so items do not get their own: each frame the engine draws an item
 * into the shared offscreen canvas and copies the result into the item's own
 * 2D canvas (a GPU-to-GPU copy).
 *
 * The agent's code is a GLSL ES 3.0 fragment shader in Shadertoy style:
 * `void mainImage(out vec4 fragColor, in vec2 fragCoord)`. A shader that
 * defines its own `void main()` (and its own `out vec4`) is used as it is.
 * The engine declares `iTime`, `iResolution`, `iFrame`, one `uniform float`
 * per param, and the board colour tokens as `const vec3 ls_<name>`.
 *
 * A shader is a pure function of item time and the params (clock.ts): iTime
 * is the item time and iFrame its grid tick. On the board a ShaderHost draws
 * at the item clock's time on each display frame where it moved; a step host
 * draws the asked tick at once.
 */

import { itemTime, paramsAt, tickOf, timeOfTick, type ItemClock, type SceneView } from './clock'
import { blobUrl, type CanvasSize, type HostEvents, type HostStart, type LiveFrame, type LiveHost } from './host'

export interface ShaderProgram {
  program: WebGLProgram
  iTime: WebGLUniformLocation | null
  iResolution: WebGLUniformLocation | null
  iFrame: WebGLUniformLocation | null
  params: Map<string, WebGLUniformLocation | null>
}

export type CompileResult = { ok: true; program: ShaderProgram } | { ok: false; error: string }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED = new Set(['iTime', 'iResolution', 'iFrame', 'main', 'mainImage'])

/** Param names that can be GLSL uniforms, sorted. */
export function uniformNames(params: Record<string, number>): string[] {
  return Object.keys(params)
    .filter((name) => IDENT.test(name) && !RESERVED.has(name) && !name.startsWith('gl_'))
    .sort()
}

// ---------- Board colour tokens as GLSL constants ----------

const TOKENS: Array<[glsl: string, css: string]> = [
  ['ls_text', '--ls-text'],
  ['ls_muted', '--ls-muted'],
  ['ls_accent', '--ls-accent'],
  ['ls_good', '--ls-good'],
  ['ls_bad', '--ls-bad'],
  ['ls_warn', '--ls-warn'],
  ['ls_card', '--ls-card'],
  ['ls_card2', '--ls-card-2'],
  ['ls_border', '--ls-border'],
  ['ls_bg', '--bg-canvas']
]

let tokenBlock: string | null = null

function cssColourToVec3(value: string): string | null {
  const probe = document.createElement('canvas').getContext('2d')
  if (!probe) return null
  probe.fillStyle = '#000000'
  probe.fillStyle = value.trim()
  const parsed = String(probe.fillStyle)
  const hex = /^#([0-9a-f]{6})$/i.exec(parsed)
  let rgb: number[] | null = null
  if (hex) rgb = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16))
  else {
    const m = /rgba?\(([^)]+)\)/.exec(parsed)
    if (m) rgb = m[1].split(',').slice(0, 3).map((part) => Number(part.trim()))
  }
  if (!rgb || rgb.some((c) => !Number.isFinite(c))) return null
  return `vec3(${rgb.map((c) => (c / 255).toFixed(4)).join(', ')})`
}

/** The tokens, read once from the content layer's CSS (content.css, tokens.css). */
function tokenConstants(): string {
  if (tokenBlock !== null) return tokenBlock
  const probe = document.createElement('div')
  probe.className = 'board__content'
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const style = getComputedStyle(probe)
  const lines: string[] = []
  for (const [glsl, css] of TOKENS) {
    const vec = cssColourToVec3(style.getPropertyValue(css))
    if (vec) lines.push(`const vec3 ${glsl} = ${vec};`)
  }
  probe.remove()
  tokenBlock = lines.join('\n')
  return tokenBlock
}

// ---------- Source assembly ----------

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

interface Assembled {
  source: string
  /** Lines before the agent's first line, to map error line numbers back. */
  offset: number
}

function assemble(code: string, names: string[]): Assembled {
  const body = code.replace(/^\s*#version[^\n]*\n?/, '')
  const ownMain = /\bvoid\s+main\s*\(/.test(body) && !/\bmainImage\s*\(/.test(body)
  const declared = (name: string): boolean => new RegExp(`\\buniform\\s+\\w+\\s+${name}\\b`).test(body)
  const head = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    declared('iTime') ? '' : 'uniform float iTime;',
    declared('iResolution') ? '' : 'uniform vec3 iResolution;',
    declared('iFrame') ? '' : 'uniform int iFrame;',
    ...names.filter((name) => !declared(name)).map((name) => `uniform float ${name};`),
    tokenConstants(),
    ownMain ? '' : 'out vec4 ls_fragColor;'
  ]
    .filter(Boolean)
    .join('\n')
  const foot = ownMain ? '' : '\nvoid main() {\n  ls_fragColor = vec4(0.0, 0.0, 0.0, 1.0);\n  mainImage(ls_fragColor, gl_FragCoord.xy);\n}\n'
  return { source: `${head}\n#line 1\n${body}\n${foot}`, offset: 0 }
}

/** The compile log, trimmed: "ERROR: 0:12: …" lines with the agent's line numbers (via #line). */
function cleanLog(log: string): string {
  const lines = log
    .split('\n')
    .map((line) => line.replace(/\u0000/g, '').trim())
    .filter(Boolean)
    .map((line) => line.replace(/^ERROR:\s*0:(\d+):\s*/, 'line $1: '))
  return lines.join('\n') || 'The shader did not compile.'
}

// ---------- The engine ----------

class ShaderEngine {
  private canvas: OffscreenCanvas | null = null
  private gl: WebGL2RenderingContext | null = null
  private vertex: WebGLShader | null = null
  private cache = new Map<string, CompileResult>()
  private unavailable: string | null = null
  /** Bumped on context loss and restore: items compile again and draw. */
  generation = 0
  private listeners = new Set<() => void>()

  /** Call `listener` when the context was lost or restored. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private bump(): void {
    this.generation++
    for (const listener of this.listeners) listener()
  }

  private context(): WebGL2RenderingContext | null {
    if (this.gl && !this.gl.isContextLost()) return this.gl
    if (this.unavailable) return null
    try {
      this.canvas = new OffscreenCanvas(256, 256)
      // A lost context: the next draw makes a new one (see above); its programs are compiled again.
      this.canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault()
        this.cache.clear()
        this.vertex = null
        this.bump()
      })
      this.canvas.addEventListener('webglcontextrestored', () => this.bump())
      const gl = this.canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
      if (!gl) {
        this.unavailable = 'WebGL 2 is not available in this window.'
        return null
      }
      this.gl = gl
      this.cache.clear()
      this.vertex = null
      return gl
    } catch (error) {
      this.unavailable = `WebGL 2 failed to start: ${error instanceof Error ? error.message : String(error)}`
      return null
    }
  }

  /** Compile (cached by source). Never throws. */
  compile(code: string, params: Record<string, number>): CompileResult {
    const gl = this.context()
    if (!gl) return { ok: false, error: this.unavailable ?? 'WebGL 2 is not available.' }
    const names = uniformNames(params)
    const { source } = assemble(code, names)
    const key = source
    const cached = this.cache.get(key)
    if (cached) return cached
    const result = this.build(gl, source, names)
    if (this.cache.size > 200) this.cache.clear()
    this.cache.set(key, result)
    return result
  }

  private build(gl: WebGL2RenderingContext, source: string, names: string[]): CompileResult {
    if (!this.vertex) {
      const vs = gl.createShader(gl.VERTEX_SHADER)
      if (!vs) return { ok: false, error: 'WebGL could not create a shader.' }
      gl.shaderSource(vs, VERTEX)
      gl.compileShader(vs)
      this.vertex = vs
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER)
    if (!fs) return { ok: false, error: 'WebGL could not create a shader.' }
    gl.shaderSource(fs, source)
    gl.compileShader(fs)
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const error = cleanLog(gl.getShaderInfoLog(fs) ?? '')
      gl.deleteShader(fs)
      return { ok: false, error }
    }
    const program = gl.createProgram()
    if (!program) return { ok: false, error: 'WebGL could not create a program.' }
    gl.attachShader(program, this.vertex)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = cleanLog(gl.getProgramInfoLog(program) ?? '')
      gl.deleteProgram(program)
      return { ok: false, error }
    }
    const params = new Map<string, WebGLUniformLocation | null>()
    for (const name of names) params.set(name, gl.getUniformLocation(program, name))
    return {
      ok: true,
      program: {
        program,
        iTime: gl.getUniformLocation(program, 'iTime'),
        iResolution: gl.getUniformLocation(program, 'iResolution'),
        iFrame: gl.getUniformLocation(program, 'iFrame'),
        params
      }
    }
  }

  /** Draw one frame of `program` at pw × ph device pixels into `target` (a 2D context of that size). */
  render(program: ShaderProgram, pw: number, ph: number, time: number, frame: number, params: Record<string, number>, target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): boolean {
    const gl = this.context()
    const canvas = this.canvas
    if (!gl || !canvas) return false
    // The shared canvas only grows: a resize reallocates its buffer.
    if (canvas.width < pw || canvas.height < ph) {
      canvas.width = Math.max(canvas.width, pw)
      canvas.height = Math.max(canvas.height, ph)
    }
    gl.viewport(0, 0, pw, ph)
    gl.useProgram(program.program)
    if (program.iTime) gl.uniform1f(program.iTime, time)
    if (program.iResolution) gl.uniform3f(program.iResolution, pw, ph, 1)
    if (program.iFrame) gl.uniform1i(program.iFrame, frame)
    for (const [name, location] of program.params) if (location) gl.uniform1f(location, params[name] ?? 0)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    // GL draws from the bottom-left: the item's pixels are the bottom rows of the shared canvas.
    target.clearRect(0, 0, pw, ph)
    target.drawImage(canvas, 0, canvas.height - ph, pw, ph, 0, 0, pw, ph)
    return true
  }
}

export const shaderEngine = new ShaderEngine()

/** Compile a shader and return its error log, or null when it compiles. For agents and the scene API. */
export function shaderError(code: string, params: Record<string, number> = {}): string | null {
  const result = shaderEngine.compile(code, params)
  return result.ok ? null : result.error
}

/** One shader item: it draws with the shared engine into the item's own 2D canvas (a <canvas> on the board, an OffscreenCanvas for a step host). */
export class ShaderHost implements LiveHost {
  readonly element: HTMLCanvasElement | null
  private canvas: HTMLCanvasElement | OffscreenCanvas
  private target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  private program: ShaderProgram | null = null
  private generation = -1
  private tick = -1
  private time = -1
  private dirty = true
  private visible: boolean
  private clock: ItemClock
  private params: Record<string, number>
  private size: CanvasSize
  private frames = 0
  private failed = false

  constructor(
    private start: HostStart,
    private events: HostEvents,
    container: HTMLElement | null
  ) {
    this.clock = start.clock
    this.params = start.params
    this.size = start.size
    this.visible = start.visible
    if (container) {
      const canvas = document.createElement('canvas')
      canvas.className = 'node-live__canvas'
      container.prepend(canvas)
      this.element = canvas
      this.canvas = canvas
    } else {
      this.element = null
      this.canvas = new OffscreenCanvas(1, 1)
    }
    this.canvas.width = this.size.pw
    this.canvas.height = this.size.ph
    this.target = this.canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    // A compile error goes out after the constructor: the item has its host by then.
    queueMicrotask(() => this.compile())
  }

  private compile(): boolean {
    if (this.failed) return false
    if (this.program && this.generation === shaderEngine.generation) return true
    this.generation = shaderEngine.generation
    const result = shaderEngine.compile(this.start.code, this.start.params)
    if (!result.ok) {
      this.program = null
      this.failed = true
      this.events.onError(result.error)
      return false
    }
    this.program = result.program
    this.dirty = true
    return true
  }

  /** Draw at item time `time` (s): iTime is that time, iFrame its grid tick. */
  private draw(time: number, params: Record<string, number>): boolean {
    if (!this.target || !this.compile() || !this.program) return false
    const tick = tickOf(time)
    if (!shaderEngine.render(this.program, this.size.pw, this.size.ph, time, tick, params, this.target)) return false
    this.time = time
    this.tick = tick
    this.dirty = false
    this.frames++
    this.events.onAlive(this.frames, tick)
    return true
  }

  /** The item time to draw: any time from 0, so a seek back before the time the host started still shows. */
  private now(): number {
    return Math.max(0, itemTime(this.clock))
  }

  /**
   * One display frame (registry.ts): draw at the clock's time now when it
   * moved or the picture is out of date. True while the host wants more
   * frames (its time moves).
   */
  frame(): boolean {
    if (this.failed || !this.visible) return false
    if (this.generation !== shaderEngine.generation) this.dirty = true
    const time = this.now()
    if (time !== this.time || this.dirty) this.draw(time, this.params)
    return this.clock.rate > 0
  }

  follow(clock: ItemClock, _scene: SceneView): void {
    this.clock = clock
  }

  goLive(clock: ItemClock, scene: SceneView, params: Record<string, number>): void {
    this.follow(clock, scene)
    this.setParams(params)
  }

  run(on: boolean): void {
    this.visible = on
  }

  setParams(params: Record<string, number>): void {
    this.params = params
    this.dirty = true
  }

  resize(size: CanvasSize): void {
    this.size = size
    this.canvas.width = size.pw
    this.canvas.height = size.ph
    this.dirty = true
  }

  /** A shader keeps no state from tick to tick: it draws tick `to` at once, with the timeline's params of that moment. */
  async advance(to: number, capture: boolean): Promise<LiveFrame | null> {
    const params = paramsAt(this.start.timeline, this.start.params, timeOfTick(to))
    if (!this.draw(timeOfTick(to), params)) return null
    return capture ? this.picture() : { url: null, tick: to }
  }

  async capture(): Promise<LiveFrame | null> {
    if (this.tick < 0 || this.dirty || this.time !== this.now()) this.draw(this.now(), this.params)
    return this.tick < 0 ? null : this.picture()
  }

  private async picture(): Promise<LiveFrame | null> {
    const tick = this.tick
    const canvas = this.canvas
    try {
      const blob = canvas instanceof OffscreenCanvas ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      return { url: await blobUrl(blob), tick }
    } catch {
      return { url: null, tick }
    }
  }

  setEntered(): void {
    // Shader items take no input.
  }

  stop(): void {
    // Nothing runs between frames: the shared context stays, the canvas keeps its picture.
    this.failed = true
  }

  dispose(): void {
    this.stop()
    this.element?.remove()
    this.target = null
    this.program = null
  }
}
