// Beat 2: a cut at height h. The disc reads stage.h, so it follows every later tween of it.
const { R, cx, base, h } = stage
const y = () => base - h.get()
const disc = ellipse(cx, y, () => Math.sqrt(Math.max(1, R * R - h.get() ** 2)), 9, { fill: "accent", fillOpacity: 0.35, color: "accent", name: "slice" })
const tag = write("h", { at: () => [cx - R - 34, y() - 14], size: 24, color: "muted" })
stage.disc = disc

say("Cut it flat at a height h [[cut]] and the slice is a disc [[disc]] of area pi times R squared minus h squared.")
await mark("cut")
draw(disc, 0.7)
draw(tag, 0.4)
await mark("disc")
stage.area = tex("\\pi\\,(R^2 - h^2)", { at: [cx - 70, base + 40], size: 26, color: "accent" })
fadeIn(stage.area, 0.5)
