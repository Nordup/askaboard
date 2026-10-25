// live: shader  size: 600x340  params: k=16 omega=3 amp=0.3
// An electromagnetic plane wave travelling to the right: the electric field E
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
  // E: y = amp sin(k x - wt); stems every `cell` from the axis to the curve.
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
}
