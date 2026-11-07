// The learner's board before they ask (council.mjs --learner-board; learner-board.mjs makes it their pen ink).
// The exercise, as someone gave it to them, is in green at the top left: the question and a neat sketch. Their own
// work is in blue, with room between the lines: they tried subtracting and adding, remembered a² + b² = c² but put
// the ladder on the wrong side, got an answer longer than the ladder, and gave up. The agent has the right half.
const GREEN = "#5fd38d", BLUE = "#6e8bff"

// The exercise.
write("A 5 m ladder leans on a wall.", { at: [-585, -405], size: 26, color: GREEN })
write("Its foot is 3 m from the wall.", { at: [-585, -360], size: 26, color: GREEN })
write("How high up the wall does it reach?", { at: [-585, -315], size: 26, color: GREEN })
const wall = -545, ground = 60, neat = { color: GREEN, width: 2.4, jitter: 0.1 }
stroke([[wall - 20, ground], [wall + 200, ground]], neat)
stroke([[wall, ground], [wall, ground - 230]], neat)
stroke([[wall + 150, ground], [wall, ground - 200]], neat)
stroke([[wall, ground - 16], [wall + 16, ground - 16], [wall + 16, ground]], neat)
write("5 m", { at: [wall + 84, ground - 128], size: 22, color: GREEN })
write("3 m", { at: [wall + 56, ground + 16], size: 22, color: GREEN })
write("?", { at: [wall - 34, ground - 116], size: 26, color: GREEN })

// The learner's work.
const col = -280, pen = { size: 26, color: BLUE }
const crossOut = (o) => {
  const b = o.bounds, y = b.y + b.height * 0.55
  stroke([[b.x - 6, y + 2], [b.x + b.width * 0.72, y - 3]], { color: BLUE, width: 2.4, jitter: 0.6 })
}
crossOut(write("5 − 3 = 2", { at: [col, -235], ...pen }))
crossOut(write("5 + 3 = 8", { at: [col, -170], ...pen }))
write("a² + b² = c²", { at: [col, -90], ...pen })
write("5² + 3² = 25 + 9 = 34", { at: [col, -25], ...pen })
write("h = √34 ≈ 5.8", { at: [col, 40], ...pen })
write("longer than the ladder??", { at: [col, 108], size: 20, color: BLUE })
write("I'm stuck", { at: [col, 168], size: 28, color: BLUE })
