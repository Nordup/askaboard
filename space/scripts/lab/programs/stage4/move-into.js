// A flex frame (made in an earlier scene) and a note: the note moves into the frame and joins its flow.
const frame = board.node('notes')
const note = html('<p style="font-size:18px; padding:8px 12px; background:var(--ls-card-2); border-radius:8px">Third note</p>', { at: [320, 1200] })
await fadeIn(note, 0.5)
step('into')
await move(note, { into: frame }, 1.2)
say('It joins the list.')
