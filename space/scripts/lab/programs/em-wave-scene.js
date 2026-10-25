// An electromagnetic plane wave, explained as a scene: the field appears as a
// live shader, handwritten labels E and B stay attached to it, and the wave
// number k and the angular frequency omega change while the voice explains.
// A pause step waits for scene_control resume. At the end the field moves and
// shrinks to the side; the labels follow it.
const v = board.view
const c = [v.x + v.width / 2, v.y + v.height / 2]
const W = 600
const H = 340

const glsl = `// An electromagnetic plane wave travelling to the right: the electric field E
// (yellow) swings in the vertical plane, the magnetic field B (blue) in the
// horizontal plane, drawn in an oblique view. E and B are in phase and at right
// angles to each other and to the direction of travel. k: wave number,
// omega: angular frequency (the wave moves at omega / k), amp: amplitude.

float stroke(float d, float w) {
  float px = 1.0 / iResolution.y;
  return 1.0 - smoothstep(0.5 * w, 0.5 * w + 1.5 * px, d);
}

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float px = 1.0 / iResolution.y;
  float aspect = iResolution.x / iResolution.y;
  vec3 col = ls_bg;
  vec2 depth = vec2(0.10, 0.32); // oblique view of the depth axis (depth.x * amp * k < 1 keeps the B curve single-valued)

  // The horizontal plane (faint lines along the depth axis) and the axis of travel.
  float inPlane = step(abs(uv.y / depth.y), amp * 1.1);
  vec2 q = uv - depth * (uv.y / depth.y);
  col = mix(col, ls_border, 0.6 * stroke(abs(fract(q.x / 0.1 + 0.5) - 0.5) * 0.1, px) * inPlane);
  col = mix(col, ls_muted, stroke(abs(uv.y), 1.5 * px));

  float wt = omega * iTime;
  // E: y = amp sin(k x - wt); stems every cell from the axis to the curve.
  float cell = 0.04;
  float xs = (floor(uv.x / cell) + 0.5) * cell;
  float es = amp * sin(k * xs - wt);
  col = mix(col, ls_warn * 0.6, stroke(segment(uv, vec2(xs, 0.0), vec2(xs, es)), 1.2 * px));
  float e = amp * sin(k * uv.x - wt);
  float de = amp * k * cos(k * uv.x - wt);
  col = mix(col, ls_warn, stroke(abs(uv.y - e) / sqrt(1.0 + de * de), 3.0 * px));

  // B: the same phase, along the depth axis: screen point = (s, 0) + depth * B(s).
  float bs = amp * sin(k * xs - wt);
  col = mix(col, ls_accent * 0.7, stroke(segment(uv, vec2(xs, 0.0), vec2(xs, 0.0) + depth * bs), 1.2 * px));
  float s = uv.x;
  for (int i = 0; i < 5; i++) {
    float b = amp * sin(k * s - wt);
    float db = amp * k * cos(k * s - wt);
    s -= (s + depth.x * b - uv.x) / (1.0 + depth.x * db);
  }
  float b = amp * sin(k * s - wt);
  float db = amp * k * cos(k * s - wt);
  float slope = depth.y * db / (1.0 + depth.x * db);
  col = mix(col, ls_accent, stroke(abs(uv.y - depth.y * b) / sqrt(1.0 + slope * slope), 3.0 * px));

  // The direction of travel: an arrow head at the right end of the axis.
  vec2 tip = vec2(0.5 * aspect - 0.03, 0.0);
  float head = min(segment(uv, tip, tip + vec2(-0.03, 0.018)), segment(uv, tip, tip + vec2(-0.03, -0.018)));
  col = mix(col, ls_text, stroke(head, 2.0 * px));

  // Fade at the left and right edges.
  float edge = smoothstep(0.0, 0.08, 0.5 * aspect - abs(uv.x));
  fragColor = vec4(mix(ls_bg, col, edge), 1.0);
}`

step('field')
const field = shader(glsl, { center: c, size: [W, H], params: { k: 8, omega: 1, amp: 0.3 }, name: 'em field' })
const title = write('electromagnetic wave', { center: [c[0], c[1] - H / 2 - 40], size: 26, color: 'text' })
await all(fadeIn(field, 1), draw(title, 1.2), say('This is an electromagnetic wave, travelling to the right.'))

step('E and B')
// E swings in the vertical plane (yellow), B in the horizontal plane (blue).
const e = label(field, 'E', { at: [c[0] - W * 0.3, c[1] - H * 0.33], side: 'above', color: 'warn', size: 30 })
await all(draw(e, 0.6), say('The electric field E swings up and down.'))
const b = label(field, 'B', { at: [c[0] + W * 0.26, c[1] + H * 0.12], side: 'below-right', color: 'accent', size: 30 })
await all(draw(b, 0.6), say('The magnetic field B swings sideways, in step with E.'))

step('wave number')
await all(tween(field, { params: { k: 20 } }, 3), say('Raise the wave number k, and the crests crowd closer together.'))

step('think', { pause: true })
await say('What do you think happens when the frequency goes up?')

step('frequency')
await all(tween(field, { params: { omega: 5 } }, 3), say('Raise omega, and every point swings faster.'))
await wait(1)

step('aside')
await all(move(field, { to: [c[0] - 150, c[1] + 40] }, 1.2), tween(field, { scale: 0.6 }, 1.2), fadeOut(title, 0.8))
await wait(1)
