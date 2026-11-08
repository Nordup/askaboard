import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')
const require = createRequire(join(root, 'apps/website/package.json'))
const sharp = require('sharp')
const exportsDir = join(here, 'exports')
const mark = (await readFile(join(here, 'mark.svg'), 'utf8')).trim()
const wordmark = (await readFile(join(here, 'wordmark.svg'), 'utf8')).trim()

const dark = '#111113'
const light = '#ececef'
const ink = '#161618'
const markAspect = 562 / 316

function svg(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${body}
</svg>
`
}

function place(asset, x, y, width, height) {
  return asset.replace(/<svg ([^>]+)>/, (_, attributes) => {
    const source = attributes.replace(/ (width|height)="[^"]+"/g, '')
    return `<svg x="${x}" y="${y}" width="${width}" height="${height}" ${source}>`
  })
}

function solidMark(color) {
  return mark.replace(/  <defs>[\s\S]*?<\/defs>\n/, '').replace(/fill="url\(#[^)]+\)"/g, `fill="${color}"`)
}

function squareMark(size, markWidth, asset = mark, background = '') {
  const height = markWidth / markAspect
  return svg(size, size, background + place(asset, (size - markWidth) / 2, (size - height) / 2, markWidth, height))
}

function dockTile(size, inset, radius, markWidth) {
  const background = `<defs><linearGradient id="tile" x2="0" y2="1"><stop stop-color="#232327"/><stop offset="1" stop-color="#101012"/></linearGradient></defs>
<rect x="${inset}" y="${inset}" width="${size - inset * 2}" height="${size - inset * 2}" rx="${radius}" fill="url(#tile)"/>`
  return squareMark(size, markWidth, mark, background)
}

function lockup(width, height, color) {
  return svg(width, height, place(mark, 12, 14, 96, 54) +
    place(wordmark.replace('currentColor', color), 125, 11, 270, 60))
}

async function save(file, content) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

function png(source, width, { height = width, density = 72, opaque = false } = {}) {
  const image = sharp(Buffer.from(source)).resize(width, height).withMetadata({ density })
  if (opaque) image.removeAlpha()
  return image.png().toBuffer()
}

async function exportIconset(source) {
  const scratch = await mkdtemp(join(tmpdir(), 'askaboard-icon-'))
  try {
    const iconset = join(scratch, 'Askaboard.iconset')
    for (const points of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const suffix = scale === 2 ? '@2x' : ''
        await save(join(iconset, `icon_${points}x${points}${suffix}.png`), await png(source, points * scale))
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(exportsDir, 'mac/Askaboard.icns')])
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function faviconIco(source) {
  const sizes = [16, 32, 48]
  const directory = Buffer.alloc(6 + sizes.length * 16)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(sizes.length, 4)
  const images = []
  let offset = directory.length
  for (const [index, size] of sizes.entries()) {
    const image = await png(source, size)
    const entry = 6 + index * 16
    directory[entry] = size
    directory[entry + 1] = size
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(image.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.length
    images.push(image)
  }
  return Buffer.concat([directory, ...images])
}

const logo = join(exportsDir, 'logo')
const mac = join(exportsDir, 'mac')
const web = join(exportsDir, 'web')
const publicDir = join(root, 'apps/website/public')
const transparent = squareMark(1024, 880)
const backed = squareMark(1024, 880, mark, `<rect width="1024" height="1024" fill="${ink}"/>`)
// Keep the entire mark inside a circular avatar crop, including at the corners
// of its rectangular viewBox.
const avatar = squareMark(1024, 700, mark, `<rect width="1024" height="1024" fill="${ink}"/>`)
const appIcon = dockTile(1024, 100, 182, 672)

await save(join(logo, 'mark-transparent.svg'), transparent)
await save(join(logo, 'mark-dark.svg'), backed)
await save(join(logo, 'avatar-dark.svg'), avatar)
await save(join(logo, 'avatar-dark-1024.png'), await png(avatar, 1024, { opaque: true }))
await save(join(mac, 'Askaboard.svg'), appIcon)
for (const [name, color] of [['black', '#000000'], ['white', '#ffffff']]) {
  const source = solidMark(color)
  await save(join(logo, `mark-${name}.svg`), source)
  await save(join(logo, `mark-${name}-512.png`), await png(squareMark(1024, 880, source), 512))
}
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  await save(join(logo, `mark-transparent-${size}.png`), await png(transparent, size))
  await save(join(logo, `mark-dark-${size}.png`), await png(backed, size, { opaque: true }))
}
for (const [name, color] of [['light-text', light], ['dark-text', ink]]) {
  const source = lockup(408, 82, color)
  await save(join(logo, `lockup-${name}.svg`), source)
  await save(join(logo, `lockup-${name}.png`), await png(source, 1224, { height: 246 }))
}

const template = squareMark(32, 28, solidMark('#000000'))
await save(join(mac, 'AskaboardTemplate.svg'), template)
await save(join(mac, 'AskaboardTemplate.png'), await png(template, 16))
await save(join(mac, 'AskaboardTemplate@2x.png'), await png(template, 32, { density: 144 }))
const appPng = await png(appIcon, 1024)
await save(join(root, 'apps/desktop/resources/icon.png'), appPng)
await exportIconset(appIcon)

const favicon = dockTile(32, 1, 7, 25)
const touch = dockTile(180, 0, 0, 140)
await save(join(web, 'favicon.ico'), await faviconIco(favicon))
await save(join(root, 'apps/website/app/icon.svg'), favicon)
await save(join(publicDir, 'askaboard-mark.svg'), mark + '\n')
await save(join(publicDir, 'apple-touch-icon.png'), await png(touch, 180, { opaque: true }))
