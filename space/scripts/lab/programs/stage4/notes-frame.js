// Set-up for move-into.js: a flex frame named "notes" with two notes.
const notes = html(`<div style="display:flex; flex-direction:column; gap:8px; padding:16px; width:240px; background:var(--ls-card); border-radius:10px">
  <p style="font-size:18px; padding:8px 12px; background:var(--ls-card-2); border-radius:8px">First note</p>
  <p style="font-size:18px; padding:8px 12px; background:var(--ls-card-2); border-radius:8px">Second note</p>
</div>`, { at: [-120, 1000], name: 'notes' })
camera({ fit: [-160, 960, 620, 360] }, 0.5)
await draw(notes, 1.5)
