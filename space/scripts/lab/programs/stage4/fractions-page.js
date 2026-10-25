// A page of five fraction exercises in one frame: the frame fades in, then each part in order.
const card = (n, task) => `
  <div layer-name="ex${n}" style="display:flex; flex-direction:column; gap:6px; padding:12px 14px; background:var(--ls-card-2); border-radius:10px">
    <p style="font-size:13px; color:var(--ls-muted)">Exercise ${n}</p>
    <p style="font-size:20px">${task}</p>
  </div>`
const page = html(`
  <div style="display:flex; flex-direction:column; gap:12px; padding:24px; width:420px; background:var(--ls-card); border-radius:12px">
    <h2>Adding fractions</h2>
    ${card(1, '$\\frac{1}{2} + \\frac{1}{4} = ?$')}
    ${card(2, '$\\frac{2}{3} + \\frac{1}{6} = ?$')}
    ${card(3, '$\\frac{3}{5} - \\frac{1}{10} = ?$')}
    ${card(4, '$\\frac{1}{3} + \\frac{1}{4} = ?$')}
    ${card(5, '$\\frac{5}{8} - \\frac{1}{4} = ?$')}
  </div>`, { at: [-210, -330], name: 'fractions' })
console.log('page', JSON.stringify(page.bounds), 'parts', page.parts.length)
camera({ fit: page, pad: 40 }, 0.6)
say('Five sums to try, one after another.')
step('page')
await draw(page, 4)
step('first')
const first = page.part('ex1')
const ring = around(first, { shape: 'box', color: 'accent' })
await draw(ring, 0.8)
say('Start with the first one.')
