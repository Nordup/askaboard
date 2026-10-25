// A real picture from a URL with a caption under it, in empty space.
const place = space(360, 320)
const pic = image('https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/960px-Colosseo_2020.jpg', { at: place.at, size: 360, name: 'colosseum' })
console.log('picture', JSON.stringify(pic.bounds))
const b = pic.bounds
const caption = text('The Colosseum, Rome (built 70–80 AD)', { at: [b.x, b.y + b.height + 10], size: 16, color: 'muted' })
camera({ fit: group(pic, caption), pad: 60 }, 0.6)
say('Here is the Colosseum.')
await fadeIn(pic, 0.8)
await draw(caption)
