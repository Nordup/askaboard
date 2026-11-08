// The first sketch from docs/history/live-drawing-plan.md ("The medium").
// The API is not final: change this file to match the scene API as it is built.
const r = 120
const ball = circle(0, 0, r)                   // nothing is visible yet
await draw(ball, 1.2)                          // a pen draws it in 1.2 s
step("slices")
for (let i = 0; i < 6; i++) {
  const y = -100 + i * 40
  fillIn(ellipse(0, y, Math.sqrt(r ** 2 - y ** 2), 8, { fill: "accent" }), 0.3)
  await wait(0.15)                             // slices overlap in time
}
step("formula")
await write("V = 4/3 π r³", { at: [170, 0] })  // handwritten, stroke by stroke
