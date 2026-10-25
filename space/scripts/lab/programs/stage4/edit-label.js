// A label with a mistake and a shape: the text is corrected and the shape recoloured, in time.
const box = html(`<div style="display:flex; flex-direction:column; gap:8px; padding:16px; width:260px; background:var(--ls-card); border-radius:10px">
  <p layer-name="label" style="font-size:20px">Area = 2πr</p>
  <svg viewBox="0 0 120 120" style="width:120px; height:120px; color:var(--ls-accent)"><circle id="disc" cx="60" cy="60" r="50" fill="currentColor" /></svg>
</div>`, { at: [-130, 500], name: 'area-card' })
camera({ fit: box, pad: 80 }, 0.5)
await fadeIn(box, 0.5)
step('wrong')
say('Wait, that formula is the circumference.')
await wait(1)
step('fix')
const label = box.part('label')
await edit(label, { text: 'Area = $\\pi r^2$', style: { color: 'var(--ls-good)' } }, 0.6)
const svg = box.part(1)
await edit(svg, { style: { color: 'var(--ls-good)', opacity: 0.6 } }, 0.8)
say('Area is pi r squared.')
