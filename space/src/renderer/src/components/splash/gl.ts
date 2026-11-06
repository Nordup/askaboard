/**
 * The splash band's WebGL layer (decision U20): the ground, the breathing grid and the grown tree on the GPU. The grid
 * is one fragment shader over the band (each pixel finds its nearest dot). The tree is still bitmaps (moon, wash, still
 * trunk), one mesh of its swaying bark, instanced flower sprites from an atlas and instanced petals; the vertex shader
 * sways and shifts them from a few uniforms (the two springs, the pointer). The numbers come from grid.ts and tree.ts
 * (one source for both painters); art.ts falls back to the 2D painters when WebGL is missing or its context is lost,
 * and the tree's growth stays 2D.
 */
import { rgba, type Palette, type Size } from './artworks'
import { GRID, gridColours } from './grid'
import { ATLAS, DEPTH, WIND, type TreeFrame, type TreeGpu, type TreeLayer } from './tree'

export interface GlLayer {
  /** True once the context is lost: art.ts then paints with 2D. */
  readonly lost: boolean
  /** Whether this context can paint the grown tree (instancing). */
  readonly canTree: boolean
  /** Paint a frame: the grid at grid time `gridT` shifted by `gridShift` CSS px, then the grown tree if given. */
  draw(size: Size, dpr: number, gridT: number, gridShift: [number, number], tree: { gpu: TreeGpu; frame: TreeFrame; pointer: readonly [number, number]; fade: number; alpha: number } | null): void
  /** Free the context (the band unmounts). */
  release(): void
}

const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n))

const QUAD_VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const GRID_FS = `
precision highp float;
uniform vec2 uRes;
uniform float uDpr;
uniform vec2 uScale;
uniform vec2 uShift;
uniform float uT;
uniform float uPitch;
uniform vec3 uGround;
uniform vec3 uLow;
uniform vec3 uHigh;
void main() {
  // The pixel in CSS px of the band, before the parallax shift (2D draws at dpr · (p − shift)).
  vec2 css = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr + uShift;
  vec2 u = css / uScale;
  float off = uPitch * 0.5;
  vec2 c = off + floor((u - off) / uPitch + 0.5) * uPitch;
  float w = sin(c.x * ${f(GRID.fx)} + uT * ${f(GRID.tx)}) + sin(c.y * ${f(GRID.fy)} + uT * ${f(GRID.ty)}) + sin((c.x + c.y) * ${f(GRID.fxy)} + uT * ${f(GRID.txy)});
  float k = max(0.0, w / 3.0);
  float st = min(${f(GRID.steps - 1)}, floor(k * k * ${f(GRID.steps)}));
  float b = (st + 0.5) / ${f(GRID.steps)};
  vec3 col = floor(mix(uLow, uHigh, b) + 0.5) / 255.0;
  float a = ${f(GRID.alpha0)} + ${f(GRID.alpha1)} * b;
  vec2 centre = vec2(c.x * uScale.x, (c.y - ${f(GRID.lift)} * k) * uScale.y);
  float r = (1.0 + ${f(GRID.grow)} * k) * (uScale.x + uScale.y) * 0.5;
  float cover = clamp((r - length(css - centre)) * uDpr + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(mix(uGround, col, a * cover), 1.0);
}`

// ---------- The tree ----------
const CLIP = `
uniform vec2 uRes;
uniform float uDpr;
uniform vec2 uShift;
vec4 clip(vec2 css, vec2 extraDev, float depth) {
  vec2 dev = (css - uShift * depth) * uDpr + extraDev;
  return vec4(dev.x / uRes.x * 2.0 - 1.0, 1.0 - dev.y / uRes.y * 2.0, 0.0, 1.0);
}`
const SWAY = `
uniform vec4 uSway0; // slow x, slow y, quick x, quick y
uniform vec4 uSway1; // t, A1, A2, A3 (CSS px)
vec2 sway(vec3 s) { // arm, flex, path length
  return vec2(
    s.x * uSway1.y * uSway0.x + s.y * (uSway1.z * uSway0.z + uSway1.w * sin(uSway1.x * ${f(WIND.xt)} - s.z * ${f(WIND.xs)})),
    s.x * uSway1.y * uSway0.y + s.y * (uSway1.z * uSway0.w + uSway1.w * ${f(WIND.yk)} * cos(uSway1.x * ${f(WIND.yt)} - s.z * ${f(WIND.ys)})));
}`

const STILL_VS = `
attribute vec2 aPos;
uniform vec2 uBand;
varying vec2 vUv;
${CLIP}
// A margin past each edge, sampled clamped: a shifted bitmap never shows its edge.
void main() { vec2 p = -20.0 + aPos * (uBand + 40.0); vUv = p / uBand; gl_Position = clip(p, vec2(0.0), 1.0); }`
const STILL_FS = `
precision mediump float;
uniform sampler2D uTex;
uniform float uAlpha;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTex, vUv) * uAlpha; }`

const MESH_VS = `
attribute vec2 aPos;
attribute vec4 aSway; // arm, flex, path length, depth
attribute vec4 aCol;
varying vec4 vCol;
${CLIP}
${SWAY}
void main() { vCol = aCol; gl_Position = clip(aPos + sway(aSway.xyz), vec2(0.0), aSway.w); }`
const COLOUR_FS = `
precision mediump float;
uniform float uAlpha;
varying vec4 vCol;
void main() { gl_FragColor = vCol * uAlpha; }`

const SPRITE_VS = `
attribute vec2 aCorner;
attribute vec4 aI0; // x, y, half size, atlas cell (−1: a bud's disc)
attribute vec4 aI1; // premultiplied colour of a bud
attribute vec4 aI2; // arm, flex, path length, depth
varying vec2 vCorner;
varying vec2 vUv;
varying float vCell;
varying vec4 vCol;
varying float vHalf;
${CLIP}
${SWAY}
void main() {
  vCorner = aCorner;
  vCell = aI0.w;
  vCol = aI1;
  vHalf = aI0.z * uDpr;
  vUv = vec2((aI0.w + aCorner.x * 0.5 + 0.5) / ${f(ATLAS.cells)}, aCorner.y * 0.5 + 0.5);
  float pad = aI0.w < 0.0 ? 1.0 : 0.0; // a bud's disc gets a pixel of room for its edge
  gl_Position = clip(aI0.xy + sway(aI2.xyz), aCorner * (aI0.z * uDpr + pad), aI2.w);
}`
const SPRITE_FS = `
precision mediump float;
uniform sampler2D uTex;
uniform float uAlpha;
varying vec2 vCorner;
varying vec2 vUv;
varying float vCell;
varying vec4 vCol;
varying float vHalf;
void main() {
  if (vCell >= 0.0) { gl_FragColor = texture2D(uTex, vUv) * uAlpha; return; }
  float d = length(vCorner) * (vHalf + 1.0);
  gl_FragColor = vCol * clamp(vHalf - d + 0.5, 0.0, 1.0) * uAlpha;
}`

const PETAL_VS = `
attribute vec2 aCorner;
attribute vec4 aP0; // x, y, rx, ry
attribute vec4 aP1; // turn, alpha, colour, 0
uniform vec3 uColours[5];
varying vec2 vLocal;
varying vec2 vRadii;
varying vec4 vCol;
${CLIP}
void main() {
  float ext = max(aP0.z, aP0.w) + 1.0 / uDpr;
  vLocal = aCorner * ext;
  vRadii = aP0.zw;
  int ci = int(aP1.z + 0.5);
  vec3 c = ci == 0 ? uColours[0] : ci == 1 ? uColours[1] : ci == 2 ? uColours[2] : ci == 3 ? uColours[3] : uColours[4];
  vCol = vec4(c * aP1.y, aP1.y);
  float cs = cos(aP1.x);
  float sn = sin(aP1.x);
  gl_Position = clip(aP0.xy + vec2(cs * vLocal.x - sn * vLocal.y, sn * vLocal.x + cs * vLocal.y), vec2(0.0), 1.0);
}`
const PETAL_FS = `
precision mediump float;
uniform highp float uDpr; // the same precision as in the vertex shader, or the program does not link
uniform float uAlpha;
varying vec2 vLocal;
varying vec2 vRadii;
varying vec4 vCol;
void main() {
  float q = length(vLocal / vRadii);
  gl_FragColor = vCol * clamp((1.0 - q) * min(vRadii.x, vRadii.y) * uDpr + 0.5, 0.0, 1.0) * uAlpha;
}`

/** Dev only: live GL contexts of the band (a StrictMode double mount must not leak one). */
const devCount = (delta: number): void => {
  if (!import.meta.env.DEV) return
  const w = window as unknown as { __splashGlContexts?: number }
  w.__splashGlContexts = (w.__splashGlContexts ?? 0) + delta
}

/** Start the WebGL layer on `canvas`, or null when WebGL is not there (art.ts then paints with 2D). */
export function startGl(canvas: HTMLCanvasElement, palette: Palette): GlLayer | null {
  // MSAA for the bark mesh's edges (the 2D painter anti-aliases its paths too).
  const gl = canvas.getContext('webgl', { alpha: false, antialias: true, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: 'low-power' })
  if (!gl) return null
  devCount(1)
  let lost = false
  let released = false
  const onLost = (event: Event): void => {
    event.preventDefault()
    lost = true
  }
  canvas.addEventListener('webglcontextlost', onLost)

  const program = (vs: string, fs: string): WebGLProgram | null => {
    const p = gl.createProgram()
    for (const [type, src] of [
      [gl.VERTEX_SHADER, vs],
      [gl.FRAGMENT_SHADER, fs]
    ] as const) {
      const s = gl.createShader(type)
      if (!s || !p) return null
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('splash shader:', gl.getShaderInfoLog(s))
        return null
      }
      gl.attachShader(p, s)
    }
    gl.linkProgram(p!)
    if (gl.getProgramParameter(p!, gl.LINK_STATUS)) return p
    console.error('splash program:', gl.getProgramInfoLog(p!))
    return null
  }
  const gridProgram = program(QUAD_VS, GRID_FS)
  if (!gridProgram) {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    devCount(-1)
    return null
  }
  const loc = (p: WebGLProgram, name: string): WebGLUniformLocation | null => gl.getUniformLocation(p, name)

  // The grid: one triangle over the whole band.
  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const gridPos = gl.getAttribLocation(gridProgram, 'aPos')

  // Colours, once.
  const { low, high, pitch } = gridColours(palette)
  const ground = rgba(palette.get('bg-canvas') || '#161618')
  gl.useProgram(gridProgram)
  gl.uniform3f(loc(gridProgram, 'uGround'), ground[0] / 255, ground[1] / 255, ground[2] / 255)
  gl.uniform3f(loc(gridProgram, 'uLow'), low[0], low[1], low[2])
  gl.uniform3f(loc(gridProgram, 'uHigh'), high[0], high[1], high[2])
  gl.uniform1f(loc(gridProgram, 'uPitch'), pitch)
  const g = {
    res: loc(gridProgram, 'uRes'),
    dpr: loc(gridProgram, 'uDpr'),
    scale: loc(gridProgram, 'uScale'),
    shift: loc(gridProgram, 'uShift'),
    t: loc(gridProgram, 'uT')
  }
  gl.disable(gl.DEPTH_TEST)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  // ---------- The tree (needs instancing) ----------
  const inst = gl.getExtension('ANGLE_instanced_arrays')
  const stillProgram = inst && program(STILL_VS, STILL_FS)
  const meshProgram = inst && program(MESH_VS, COLOUR_FS)
  const spriteProgram = inst && program(SPRITE_VS, SPRITE_FS)
  const petalProgram = inst && program(PETAL_VS, PETAL_FS)
  const canTree = !!(inst && stillProgram && meshProgram && spriteProgram && petalProgram)
  const unitQuad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW)
  const corners = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, corners)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  const meshBuffer = gl.createBuffer()
  const spriteBuffer = gl.createBuffer()
  const petalBuffer = gl.createBuffer()
  const moonTex = gl.createTexture()
  const washTex = gl.createTexture()
  const stillTex = gl.createTexture()
  const atlasTex = gl.createTexture()
  /** The layer now in the buffers and textures (a new tree or a new size brings a new layer object). */
  let layerFor: TreeLayer | null = null
  let atlasFor: HTMLCanvasElement | null = null
  let meshCount = 0
  let spriteCount = 0
  const upload = (tex: WebGLTexture | null, image: HTMLCanvasElement, mip: boolean): void => {
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    if (mip) gl.generateMipmap(gl.TEXTURE_2D)
  }
  /** The uniforms every tree program shares. */
  const common = (p: WebGLProgram, w: number, h: number, dpr: number, shift: [number, number], alpha: number): void => {
    gl.useProgram(p)
    gl.uniform2f(loc(p, 'uRes'), w, h)
    gl.uniform1f(loc(p, 'uDpr'), dpr)
    gl.uniform2f(loc(p, 'uShift'), shift[0], shift[1])
    gl.uniform1f(loc(p, 'uAlpha'), alpha)
  }
  const attrib = (p: WebGLProgram, name: string, size: number, stride: number, offset: number, divisor: number): number => {
    const a = gl.getAttribLocation(p, name)
    gl.enableVertexAttribArray(a)
    gl.vertexAttribPointer(a, size, gl.FLOAT, false, stride * 4, offset * 4)
    inst?.vertexAttribDivisorANGLE(a, divisor)
    return a
  }
  const detach = (list: number[]): void => {
    for (const a of list) {
      inst?.vertexAttribDivisorANGLE(a, 0)
      gl.disableVertexAttribArray(a)
    }
  }
  const setLayer = (layer: TreeLayer, atlas: HTMLCanvasElement): void => {
    if (atlasFor !== atlas) {
      upload(atlasTex, atlas, true)
      atlasFor = atlas
    }
    if (layerFor === layer) return
    layerFor = layer
    upload(moonTex, layer.moon, false)
    upload(washTex, layer.wash, false)
    upload(stillTex, layer.still, false)
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, layer.mesh, gl.STATIC_DRAW)
    meshCount = layer.mesh.length / 10
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, layer.sprites, gl.STATIC_DRAW)
    spriteCount = layer.sprites.length / 12
  }
  const drawTree = (size: Size, dpr: number, w: number, h: number, tree: { gpu: TreeGpu; frame: TreeFrame; pointer: readonly [number, number]; fade: number; alpha: number }): void => {
    if (!canTree || !inst) return
    const { frame, pointer } = tree
    const at = (px: number): [number, number] => [pointer[0] * px, pointer[1] * px]
    const shift = at(DEPTH.tree)
    setLayer(frame.layer, tree.gpu.atlas)
    gl.enable(gl.BLEND)

    // The bitmaps, each on its depth: moon, wash, then the still trunk and its flowers.
    gl.activeTexture(gl.TEXTURE0)
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad)
    let used = [attrib(stillProgram!, 'aPos', 2, 2, 0, 0)]
    for (const [tex, px] of [
      [moonTex, DEPTH.moon],
      [washTex, DEPTH.wash],
      [stillTex, DEPTH.tree]
    ] as const) {
      common(stillProgram!, w, h, dpr, at(px), tree.fade)
      gl.uniform2f(loc(stillProgram!, 'uBand'), size.w, size.h)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(loc(stillProgram!, 'uTex'), 0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    detach(used)

    // The swaying bark: fill, core, rim, in that order.
    common(meshProgram!, w, h, dpr, shift, tree.alpha)
    gl.uniform4f(loc(meshProgram!, 'uSway0'), frame.sway[0], frame.sway[1], frame.sway[2], frame.sway[3])
    gl.uniform4f(loc(meshProgram!, 'uSway1'), frame.sway[4], frame.sway[5], frame.sway[6], frame.sway[7])
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer)
    used = [attrib(meshProgram!, 'aPos', 2, 10, 0, 0), attrib(meshProgram!, 'aSway', 4, 10, 2, 0), attrib(meshProgram!, 'aCol', 4, 10, 6, 0)]
    gl.drawArrays(gl.TRIANGLES, 0, meshCount)
    detach(used)

    // The flowers and buds on swaying wood: one instanced draw.
    common(spriteProgram!, w, h, dpr, shift, tree.alpha)
    gl.uniform4f(loc(spriteProgram!, 'uSway0'), frame.sway[0], frame.sway[1], frame.sway[2], frame.sway[3])
    gl.uniform4f(loc(spriteProgram!, 'uSway1'), frame.sway[4], frame.sway[5], frame.sway[6], frame.sway[7])
    gl.bindTexture(gl.TEXTURE_2D, atlasTex)
    gl.uniform1i(loc(spriteProgram!, 'uTex'), 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, corners)
    used = [attrib(spriteProgram!, 'aCorner', 2, 2, 0, 0)]
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer)
    used.push(attrib(spriteProgram!, 'aI0', 4, 12, 0, 1), attrib(spriteProgram!, 'aI1', 4, 12, 4, 1), attrib(spriteProgram!, 'aI2', 4, 12, 8, 1))
    inst.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, spriteCount)
    detach(used)

    // The petals in the air: one instanced draw from this frame's few floats.
    if (!frame.petalCount) return
    common(petalProgram!, w, h, dpr, at(DEPTH.tree * DEPTH.petals), tree.alpha)
    gl.uniform3fv(loc(petalProgram!, 'uColours'), new Float32Array(tree.gpu.petalColours.flatMap((c) => [c[0] / 255, c[1] / 255, c[2] / 255])))
    gl.bindBuffer(gl.ARRAY_BUFFER, corners)
    used = [attrib(petalProgram!, 'aCorner', 2, 2, 0, 0)]
    gl.bindBuffer(gl.ARRAY_BUFFER, petalBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, frame.petals.subarray(0, frame.petalCount * 8), gl.DYNAMIC_DRAW)
    used.push(attrib(petalProgram!, 'aP0', 4, 8, 0, 1), attrib(petalProgram!, 'aP1', 4, 8, 4, 1))
    inst.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, frame.petalCount)
    detach(used)
  }

  return {
    get lost() {
      return lost
    },
    canTree,
    draw(size, dpr, gridT, gridShift, tree) {
      if (lost || released) return
      const w = canvas.width
      const h = canvas.height
      gl.viewport(0, 0, w, h)

      gl.disable(gl.BLEND)
      gl.useProgram(gridProgram)
      gl.bindBuffer(gl.ARRAY_BUFFER, quad)
      gl.enableVertexAttribArray(gridPos)
      gl.vertexAttribPointer(gridPos, 2, gl.FLOAT, false, 0, 0)
      gl.uniform2f(g.res, w, h)
      gl.uniform1f(g.dpr, dpr)
      gl.uniform2f(g.scale, size.w / GRID.unitsW, size.h / GRID.unitsH)
      gl.uniform2f(g.shift, gridShift[0], gridShift[1])
      gl.uniform1f(g.t, gridT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.disableVertexAttribArray(gridPos)

      if (tree) drawTree(size, dpr, w, h, tree)
    },
    release() {
      if (released) return
      released = true
      canvas.removeEventListener('webglcontextlost', onLost)
      for (const b of [quad, unitQuad, corners, meshBuffer, spriteBuffer, petalBuffer]) gl.deleteBuffer(b)
      for (const t of [moonTex, washTex, stillTex, atlasTex]) gl.deleteTexture(t)
      for (const p of [gridProgram, stillProgram, meshProgram, spriteProgram, petalProgram]) if (p) gl.deleteProgram(p)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      devCount(-1)
    }
  }
}
