// The learner's fusion drawing (task "fusion"; was the bench's S3 strokes): two atoms side by side, an arrow from
// one to the other and a question mark above, in the white pen. learner-board.mjs makes it their ink.
const WHITE = "#ececef", pen = { color: WHITE, width: 3.5, jitter: 0.4 }
const ring = (cx, cy, r) => Array.from({ length: 41 }, (_, i) => {
  const a = (i / 40) * Math.PI * 2 - Math.PI / 2
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
})
stroke(ring(300, -200, 45), pen)
stroke(ring(520, -200, 45), pen)
stroke([[360, -200], [460, -200]], pen)
stroke([[444, -212], [460, -200], [444, -188]], pen)
write("?", { at: [396, -300], size: 40, color: WHITE })
