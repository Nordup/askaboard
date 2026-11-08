// Beat 1 of 5 (the volume of a ball, after Archimedes): the half ball, and the
// values that the later beats use. stage keeps them for the next programs.
const R = 110
const cx = -170
const base = 90
Object.assign(stage, { R, cx, base, cx2: 170 })
stage.h = value(0) // the height of the cut; beats 2 to 4 move it

const dome = path(`M${cx - R} ${base} A ${R} ${R} 0 0 1 ${cx + R} ${base} Z`, { name: "half ball" })
const radius = line(cx, base, cx + R, base, { color: "accent", width: 3 })
stage.dome = dome

say("Here is half of a ball [[dome]] with a radius R [[r]] sitting on its flat face.")
await mark("dome")
draw(dome, 1.3)
await mark("r")
await draw(radius, 0.5)
label(radius, "R", { side: "below" })
