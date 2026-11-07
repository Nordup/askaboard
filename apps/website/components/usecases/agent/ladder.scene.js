// The ladder problem: squares on the sides of the right triangle.
const u = 40                       // board points per metre
const C = [460, 170]                // right angle (foot of the wall)
const B = [C[0] + 3 * u, C[1]]     // foot of the ladder
const A = [C[0], C[1] - 4 * u]     // top of the ladder
const GROUND = "#5ec8e5", LADDER = "#f2b45a", WALL = "#c79bf2"

const add = (p, q) => [p[0] + q[0], p[1] + q[1]]
const mul = (p, k) => [p[0] * k, p[1] * k]

// n×n cells of a square with corner P and edge vectors e1, e2 (each n*u long)
function cells(P, e1, e2, n, color) {
  const a = mul(e1, 1 / n), b = mul(e2, 1 / n), out = []
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const p0 = add(P, add(mul(a, i), mul(b, j)))
    out.push(polygon([p0, add(p0, a), add(add(p0, a), b), add(p0, b)],
      { color, width: 1.5, fill: color, fillOpacity: 0.22 }))
  }
  return out
}
async function grow(list, dt = 0.07) {
  for (const c of list) { fadeIn(c, 0.25); await wait(dt) }
  await wait(0.25)
}

// ---- 1. the same triangle, beside theirs
await camera({ fit: { x: -640, y: -440, width: 1480, height: 790 } }, 1.2)
const tick = write("✓", { at: [78, 98], size: 30, color: "green" })
await say("First: your alarm bell was exactly right. A ladder leaning on a wall can't reach higher than its own length, so 5.8 m must be wrong.", { during: draw(tick, 1) })
await wait(0.5)
const ground = line(...C, ...B, { color: GROUND, width: 4 })
const wall = line(...C, ...A, { color: WALL, width: 4 })
const ladder = line(...A, ...B, { color: LADDER, width: 4 })
const corner = polygon([[C[0], C[1] - 14], [C[0] + 14, C[1] - 14], [C[0] + 14, C[1]]], { closed: false, width: 2 })
say("Here is your triangle again, drawn to scale: the ground, the wall, and the ladder slanting between them.")
await draw(ground, 0.8); await draw(wall, 0.8); await draw(corner, 0.3); await draw(ladder, 1)
const l3 = write("3 m", { center: [C[0] + 60, C[1] - 18], size: 18, color: GROUND })
const l5 = write("5 m", { center: [C[0] + 92, C[1] - 108], size: 18, color: LADDER })
const lq = write("?", { center: [C[0] - 20, C[1] - 80], size: 22, color: WALL })
await all(draw(l3, 0.6), draw(l5, 0.6), draw(lq, 0.4))
await say("Notice where the ladder sits: it is the side opposite the right angle, and it is the longest side.")

// ---- 2. square on the ground
step("ground square")
const gCells = cells(C, [3 * u, 0], [0, 3 * u], 3, GROUND)
await say("a² + b² = c² is really a statement about squares. Build a square on the 3 m side: 3 by 3, that's 9 little squares.", { during: (async () => { await fadeOut(l3, 0.3); await grow(gCells, 0.12) })() })
const t9 = write("9", { center: [C[0] + 1.5 * u, C[1] + 1.5 * u], size: 30, color: GROUND })
await draw(t9, 0.5)
await wait(0.6)

// ---- 3. square on the ladder
step("ladder square")
const dir = [(B[0] - A[0]) / (5 * u), (B[1] - A[1]) / (5 * u)]   // along the ladder, unit
const out = [dir[1], -dir[0]]                                     // away from the triangle
const lCells = cells(A, [5 * dir[0] * u, 5 * dir[1] * u], [5 * out[0] * u, 5 * out[1] * u], 5, LADDER)
await say("Now a square on the ladder: 5 by 5, that's 25. It's the biggest square, because the ladder is the longest side.", { during: (async () => { await fadeOut(l5, 0.3); await grow(lCells, 0.06) })() })
const lc = add(add(A, mul(add(mul(dir, 5 * u), mul(out, 5 * u)), 0.5)), [0, 0])
const t25 = write("25", { center: lc, size: 34, color: LADDER })
await draw(t25, 0.6)
await wait(0.6)

// ---- 4. the rule
step("the rule")
const wBox = rect(A[0] - 4 * u, A[1], 4 * u, 4 * u, { color: WALL, width: 2.5, dash: true })
await say("And the square on the wall, whose side we don't know yet.", { during: (async () => { await fadeOut(lq, 0.3); await draw(wBox, 1.2) })() })
await wait(1.8)
const tq = write("?", { center: [A[0] - 2 * u, A[1] + 2 * u], size: 34, color: WALL })
await draw(tq, 0.4)
say("Here is the whole rule: the two smaller squares, put together, exactly fill the biggest one. The square on the longest side is the sum, never one of the parts.")
point(t9, 0.6); await wait(2.5); point(tq, 0.6); await wait(2.5); point(t25, 0.6); await wait(3.5)
point(null, 0.3)
await say("So, wall square plus 9 equals 25. That leaves 25 minus 9, which is 16 for the wall.")

// ---- 5. the answer
step("answer")
const wCells = cells([A[0] - 4 * u, A[1]], [4 * u, 0], [0, 4 * u], 4, WALL)
await say("16 little squares fit in a square 4 by 4. So the side of that square, the height on the wall, is 4 metres.", { during: (async () => { await fadeOut(tq, 0.3); await grow(wCells, 0.09) })() })
const t16 = write("16", { center: [A[0] - 2 * u, A[1] + 2 * u], size: 34, color: WALL })
await draw(t16, 0.5)
const h4 = write("4 m", { center: [A[0] - 4 * u - 32, C[1] - 2 * u], size: 20, color: WALL })
await draw(h4, 0.6)
await wait(1.5)
await say("Check: 4 m is less than 5 m, so it makes sense. And 9 plus 16 really is 25.")

// ---- 6. back to their working
step("your line")
await camera({ fit: { x: -640, y: -440, width: 1480, height: 820 } }, 0.8)
const ring = around({ x: -285, y: -32, width: 160, height: 42 }, { color: LADDER })
await say("Now your line. You added 5 squared and 3 squared, which treats the ladder as one of the short sides. That's why the answer came out longer than the ladder.", { during: draw(ring, 1) })
await wait(2)
const f1 = write("3² + h² = 5²", { at: [-281, 235], size: 26, color: LADDER })
const f2 = write("h² = 25 − 9 = 16", { at: [-281, 280], size: 26, color: LADDER })
const f3 = write("h = 4 m", { at: [-281, 325], size: 26, color: LADDER })
await say("The ladder goes alone on the right side, as c. Then h squared is 25 minus 9, which is 16, and h is 4 metres.", { during: (async () => { await draw(f1, 2); await draw(f2, 2); await draw(f3, 1.2) })() })
await wait(1)
