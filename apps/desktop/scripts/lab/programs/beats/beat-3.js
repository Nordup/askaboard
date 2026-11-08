// Beat 3: tween the value made in beat 1; the disc and its tag from beat 2 follow.
const { R, h } = stage
say("As the cut rises [[rise]] the disc shrinks, and near the top [[top]] it is almost a point.")
await mark("rise")
await tween(h, 70, 1.6)
await mark("top")
await tween(h, R - 6, 0.9)
