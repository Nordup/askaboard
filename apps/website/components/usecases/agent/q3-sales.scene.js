// Q3-sales.xlsx — the shape of the quarter, built one idea at a time.
const base = 250, k = 3.3            // board points per $1k
const xs = [-430, -250, -70], w = 110
const months = ["July", "August", "September"]
const rev = [117.1, 105.7, 101.1]       // actual revenue, $k
const tgt = [113.0, 117.5, 122.0]       // sum of the four regional targets, $k
const list = [117.7, 125.1, 101.6]      // revenue at list price (no discounts)
const y = v => base - v * k

// Step 1: one bar per month
const axis = line(-500, base, 20, base, { color: "muted", width: 2 })
await draw(axis, 0.6)
say("Each row of the Orders sheet is one sale. Add up the Revenue column month by month, and you get these three bars.")
for (let i = 0; i < 3; i++) {
  const h = value(0)
  const bar = rect(xs[i], () => base - h.get(), w, () => h.get(), { fill: "blue", fillOpacity: 0.55, width: 0 })
  write(months[i], { center: [xs[i] + w / 2, base + 26], size: 20 })
  await tween(h, rev[i] * k, { dur: 1, ease: "out" })
  write("$" + Math.round(rev[i]) + "k", { center: [xs[i] + w / 2, y(rev[i]) + 40], size: 18 })
  await wait(0.4)
}
await say("Sales fall every month: about 117 thousand, then 106, then 101.")

step("targets", { pause: true })
// Step 2: the targets climb while sales fall
const tl = xs.map((x, i) => line(x - 12, y(tgt[i]), x + w + 12, y(tgt[i]), { color: "orange", width: 4, dash: [10, 6] }))
await say("The Targets sheet asks for more each month. Here's the total of the four regions' targets.", { during: (async () => { for (const l of tl) await draw(l, 0.5) })() })
await say("July beats its target. August and September fall short, and the gap gets wider.")
const gap = arrow(xs[2] + w + 22, y(tgt[2]), xs[2] + w + 22, y(rev[2]), { color: "orange", width: 2, head: 9 })
await draw(gap, 0.6)
write("−$21k", { at: [xs[2] + w + 32, (y(tgt[2]) + y(rev[2])) / 2 - 10], size: 18, color: "orange" })
await say("Across the whole quarter, sales come to 324 thousand against a target of 353, about 8 percent short.")

step("august", { pause: true })
// Step 3: August sold more units than any month, but at a discount
const ghost = rect(xs[1], y(list[1]), w, (list[1] - rev[1]) * k, { color: "red", width: 2, dash: [6, 4], hatch: "red" })
say("August isn't a slow month. It sold more units than any other month: 849.")
await wait(1.5)
await say("But every grinder and espresso machine went out at 15 to 25 percent off, all month long.", { during: draw(ghost, 1.5) })
label(ghost, "given away: $19k", { side: "above", size: 18, color: "red" })
await say("At full price, August would have reached 125 thousand, above its target. The discount pulled it under, and profit fell from 49 thousand in July to 34 thousand.")

step("west", { pause: true })
// Step 4: September — one region falls away
const px = 150, pw = 380, py = -40, ph = 260
const reg = { North: [25.7, 22.7, 32.5], South: [27.0, 28.0, 23.5], East: [33.9, 31.4, 31.8], West: [30.5, 23.6, 13.3] }
const col = { North: "green", South: "purple", East: "teal", West: "red" }
const rx = i => px + 30 + i * (pw - 80) / 2
const ry = v => py + ph - (v - 10) * (ph / 26)
const frame = line(px, py + ph, px + pw, py + ph, { color: "muted", width: 2 })
await draw(frame, 0.5)
months.forEach((m, i) => write(m.slice(0, 3), { center: [rx(i), py + ph + 22], size: 16, color: "muted" }))
say("September has a different cause. Split the sales by region.")
for (const r of ["East", "South", "North"]) {
  const pl = polygon(reg[r].map((v, i) => [rx(i), ry(v)]), { closed: false, color: col[r], width: 3 })
  await draw(pl, 0.7)
  write(r, { at: [rx(2) + 14, ry(reg[r][2]) + (r === "North" ? -26 : r === "East" ? 4 : -10)], size: 16, color: col[r] })
}
await say("Three regions hold roughly level. North even has its best month.")
const west = polygon(reg.West.map((v, i) => [rx(i), ry(v)]), { closed: false, color: "red", width: 5 })
await say("West drops from 30 thousand in July to 13 thousand in September, less than half.", { during: draw(west, 2) })
write("West", { at: [rx(2) + 32, ry(13.3) - 10], size: 18, color: "red" })
around([rx(2), ry(13.3)], { color: "red" })
await say("Most of that is West's retail orders. They fell from 58 in July to 16. The sheet shows it happened, but not why.")
