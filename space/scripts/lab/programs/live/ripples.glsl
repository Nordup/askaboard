// live: shader  size: 420x420  params: sep=0.32 k=60 omega=5
// Two point sources in a ripple tank. Each sends out circular waves; where a
// crest meets a crest the water rises twice as high (bright), where a crest
// meets a trough it stays still (dark nodal lines). sep: distance between the
// sources, k: wave number (shorter waves when larger), omega: frequency.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  vec2 a = vec2(-0.5 * sep, 0.0);
  vec2 b = vec2(0.5 * sep, 0.0);
  float ra = length(uv - a);
  float rb = length(uv - b);
  float wt = omega * iTime;
  // Amplitude falls off as 1 / sqrt(r), as for a wave spreading on a surface.
  float wa = cos(k * ra - wt) / sqrt(1.0 + 12.0 * ra);
  float wb = cos(k * rb - wt) / sqrt(1.0 + 12.0 * rb);
  float h = wa + wb;                                // the surface height now
  float envelope = abs(cos(0.5 * k * (ra - rb)));   // 1 where the two waves agree in phase
  vec3 col = mix(ls_bg, ls_accent, clamp(0.5 + 0.6 * h, 0.0, 1.0));
  col = mix(col, ls_text, smoothstep(0.55, 1.1, h));
  // Nodal lines: the surface there never moves.
  col = mix(col * 0.55, col, smoothstep(0.03, 0.22, envelope));
  // The two sources.
  float px = 1.0 / iResolution.y;
  col = mix(col, ls_warn, 1.0 - smoothstep(0.012, 0.012 + 1.5 * px, min(ra, rb)));
  fragColor = vec4(col, 1.0);
}
