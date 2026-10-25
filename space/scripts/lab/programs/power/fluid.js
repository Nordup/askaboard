// A fluid on the GPU in raw WebGL 2 (no library): velocity and dye advected
// semi-Lagrangian, with a pressure projection that keeps it incompressible.
// The item takes the pointer directly (input "direct"): dragging stirs the
// fluid, and a slider that the program draws itself (slider() from
// ls/interact) sets the swirl. The scene drives the dye sources' strength.
const v = board.view
const c = [v.x + v.width / 2, v.y + v.height / 2]

const src = String.raw`
import { slider } from 'ls/interact'

input('direct')

const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false })
if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('float render targets are not available')
gl.getExtension('OES_texture_float_linear')

const SIM = 192
const simW = SIM
const simH = Math.round(SIM * item.h / item.w)

const VERT = '#version 300 es\nin vec2 p; out vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }'
function program(fragment) {
  const make = (type, text) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, text)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
    return s
  }
  const p = gl.createProgram()
  gl.attachShader(p, make(gl.VERTEX_SHADER, VERT))
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;\nin vec2 uv; out vec4 o;\n' + fragment))
  gl.bindAttribLocation(p, 0, 'p')
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
  const u = {}
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name
    u[name] = gl.getUniformLocation(p, name)
  }
  return { p, u }
}

const quad = gl.createBuffer()
gl.bindBuffer(gl.ARRAY_BUFFER, quad)
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
gl.enableVertexAttribArray(0)
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

function target(w, h) {
  const t = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const f = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, f)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
  return { t, f, w, h }
}
const pair = (w, h) => {
  let a = target(w, h)
  let b = target(w, h)
  return { get read() { return a }, get write() { return b }, swap() { [a, b] = [b, a] } }
}
const vel = pair(simW, simH)
const dye = pair(simW * 2, simH * 2)
const pres = pair(simW, simH)
const div = target(simW, simH)

const advect = program('uniform sampler2D v, q; uniform vec2 texel; uniform float dt, keep; void main(){ vec2 back = uv - dt * texture(v, uv).xy * texel * 60.0; o = keep * texture(q, back); }')
const splat = program('uniform sampler2D q; uniform vec2 at; uniform vec3 add; uniform float r, aspect; void main(){ vec2 d = uv - at; d.x *= aspect; o = texture(q, uv) + vec4(add * exp(-dot(d, d) / r), 0.0); }')
const swirl = program('uniform sampler2D v; uniform vec2 texel; uniform float k, t; ' +
  'float n(vec2 p){ return sin(p.x * 3.1 + t * 0.7) * cos(p.y * 2.7 - t * 0.5) + 0.5 * sin(p.x * 7.3 - p.y * 5.1 + t * 1.3); } ' +
  'void main(){ vec2 e = vec2(0.01, 0.0); float a = n(uv * 4.0 + e.xy), b = n(uv * 4.0 - e.xy), c = n(uv * 4.0 + e.yx), d = n(uv * 4.0 - e.yx); ' +
  'vec2 curl = vec2(c - d, -(a - b)) / 0.02; o = texture(v, uv) + vec4(curl * k * 0.02, 0.0, 0.0); }')
const divergence = program('uniform sampler2D v; uniform vec2 texel; void main(){ float l = texture(v, uv - vec2(texel.x, 0)).x, r = texture(v, uv + vec2(texel.x, 0)).x, b = texture(v, uv - vec2(0, texel.y)).y, t = texture(v, uv + vec2(0, texel.y)).y; o = vec4(0.5 * (r - l + t - b), 0, 0, 1); }')
const jacobi = program('uniform sampler2D p, d; uniform vec2 texel; void main(){ float l = texture(p, uv - vec2(texel.x, 0)).x, r = texture(p, uv + vec2(texel.x, 0)).x, b = texture(p, uv - vec2(0, texel.y)).x, t = texture(p, uv + vec2(0, texel.y)).x; o = vec4((l + r + b + t - texture(d, uv).x) * 0.25, 0, 0, 1); }')
const gradient = program('uniform sampler2D p, v; uniform vec2 texel; void main(){ float l = texture(p, uv - vec2(texel.x, 0)).x, r = texture(p, uv + vec2(texel.x, 0)).x, b = texture(p, uv - vec2(0, texel.y)).x, t = texture(p, uv + vec2(0, texel.y)).x; o = vec4(texture(v, uv).xy - 0.5 * vec2(r - l, t - b), 0, 1); }')
const show = program('uniform sampler2D q, ui; uniform vec3 bg; void main(){ vec3 c = texture(q, uv).rgb; c = 1.0 - exp(-c * 2.0); vec3 col = bg + c; vec4 u = texture(ui, vec2(uv.x, 1.0 - uv.y)); o = vec4(mix(col, u.rgb, u.a), 1.0); }')

function pass(prog, out, set) {
  gl.useProgram(prog.p)
  let unit = 0
  set({
    tex(name, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(prog.u[name], unit++) },
    f(name, ...v) { const l = prog.u[name]; if (v.length === 1) gl.uniform1f(l, v[0]); else if (v.length === 2) gl.uniform2f(l, ...v); else gl.uniform3f(l, ...v) }
  })
  if (out) { gl.bindFramebuffer(gl.FRAMEBUFFER, out.f); gl.viewport(0, 0, out.w, out.h) }
  else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height) }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

// The interface: a 2D canvas the program draws its slider on, shown over the fluid.
const ui = new OffscreenCanvas(canvas.width, canvas.height)
const uiCtx = ui.getContext('2d')
const uiTex = gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, uiTex)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
const swirlSlider = slider({ x: 24, y: item.h - 26, width: 180, min: 0, max: 3, value: 1, label: 'swirl' })
on('resize', () => {
  ui.width = canvas.width
  ui.height = canvas.height
  swirlSlider.y = item.h - 26
})

// Stirring: a drag outside the slider pushes the fluid along the pointer's motion.
let stir = null
const splats = []
on('pointerdown', (e) => { if (!swirlSlider.active) stir = [e.offsetX, e.offsetY] })
on('pointermove', (e) => {
  if (!stir) return
  splats.push({ x: e.offsetX / item.w, y: 1 - e.offsetY / item.h, dx: (e.offsetX - stir[0]) * 0.6, dy: -(e.offsetY - stir[1]) * 0.6, color: [0.2, 0.9, 0.6] })
  stir = [e.offsetX, e.offsetY]
})
on('pointerup', () => (stir = null))
on('pointercancel', () => (stir = null))

const hex = (css) => {
  const ctx = new OffscreenCanvas(1, 1).getContext('2d')
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const d = ctx.getImageData(0, 0, 1, 1).data
  return [d[0] / 255, d[1] / 255, d[2] / 255]
}
const bg = hex(colors.bg)
const palette = [hex(colors.accent), hex(colors.warn), hex(colors.bad), hex(colors.good)]

let last = performance.now()
function frame(now) {
  const dt = Math.min(1 / 30, (now - last) / 1000)
  last = now
  const texel = [1 / simW, 1 / simH]
  const aspect = item.w / item.h
  const t = item.t

  // Four dye sources circle slowly and push the fluid; the scene sets their strength.
  for (let i = 0; i < 4; i++) {
    const a = t * 0.4 + i * Math.PI / 2
    const x = 0.5 + 0.3 * Math.cos(a), y = 0.5 + 0.3 * Math.sin(a)
    const k = params.flow
    splats.push({ x, y, dx: -Math.sin(a) * 4 * k, dy: Math.cos(a) * 4 * k, color: palette[i].map((c) => c * 0.3 * k), r: 0.0012 })
  }
  for (const s of splats.splice(0)) {
    pass(splat, vel.write, (u) => { u.tex('q', vel.read.t); u.f('at', s.x, s.y); u.f('add', s.dx, s.dy, 0); u.f('r', s.r ?? 0.002); u.f('aspect', aspect) }); vel.swap()
    pass(splat, dye.write, (u) => { u.tex('q', dye.read.t); u.f('at', s.x, s.y); u.f('add', ...s.color); u.f('r', s.r ?? 0.002); u.f('aspect', aspect) }); dye.swap()
  }
  pass(swirl, vel.write, (u) => { u.tex('v', vel.read.t); u.f('texel', ...texel); u.f('k', swirlSlider.value); u.f('t', t) }); vel.swap()
  pass(advect, vel.write, (u) => { u.tex('v', vel.read.t); u.tex('q', vel.read.t); u.f('texel', ...texel); u.f('dt', dt); u.f('keep', 0.995) }); vel.swap()
  pass(divergence, div, (u) => { u.tex('v', vel.read.t); u.f('texel', ...texel) })
  for (let i = 0; i < 24; i++) { pass(jacobi, pres.write, (u) => { u.tex('p', pres.read.t); u.tex('d', div.t); u.f('texel', ...texel) }); pres.swap() }
  pass(gradient, vel.write, (u) => { u.tex('p', pres.read.t); u.tex('v', vel.read.t); u.f('texel', ...texel) }); vel.swap()
  pass(advect, dye.write, (u) => { u.tex('v', vel.read.t); u.tex('q', dye.read.t); u.f('texel', ...texel); u.f('dt', dt); u.f('keep', 0.992) }); dye.swap()

  uiCtx.setTransform(1, 0, 0, 1, 0, 0)
  uiCtx.clearRect(0, 0, ui.width, ui.height)
  uiCtx.setTransform(item.dpr, 0, 0, item.dpr, 0, 0)
  swirlSlider.draw(uiCtx)
  gl.bindTexture(gl.TEXTURE_2D, uiTex)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ui)
  pass(show, null, (u) => { u.tex('q', dye.read.t); u.tex('ui', uiTex); u.f('bg', ...bg) })
  report({ swirl: +swirlSlider.value.toFixed(2), flow: +params.flow.toFixed(2) })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
`

step('fluid')
const f = program(src, { center: c, size: [620, 380], params: { flow: 0 }, name: 'fluid' })
await all(fadeIn(f, 0.6), tween(f, { params: { flow: 1 } }, 2), say('Four sources push dye into a still fluid.'))
step('swirl')
await say('Drag in the fluid to stir it, and move the swirl slider.')
await wait(2)
