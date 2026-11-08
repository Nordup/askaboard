#!/usr/bin/env node
/**
 * Make a learning folder for checks: boards/demo-v2.board.json (the v2 demo
 * board), assets/earth.png (a blue circle, drawn here) and boards/old-v1.board.json
 * (a step 1 ink-only board, to check that v1 still loads).
 *
 *   node scripts/boards/make-demo-folder.mjs <folder>
 *
 * Existing files in <folder> with the same names are replaced.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const folder = process.argv[2]
if (!folder) {
  console.error('usage: node scripts/boards/make-demo-folder.mjs <folder>')
  process.exit(1)
}

/** A minimal RGBA PNG encoder. */
function png(width, height, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buffer) => {
    let c = 0xffffffff
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y)
      raw.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const size = 128
const earth = png(size, size, (x, y) => {
  const dx = x + 0.5 - size / 2
  const dy = y + 0.5 - size / 2
  const d = Math.hypot(dx, dy)
  const edge = Math.max(0, Math.min(1, size / 2 - 4 - d + 0.5))
  if (edge <= 0) return [0, 0, 0, 0]
  // A lit side: brighter to the upper left.
  const light = Math.max(0, Math.min(1, 0.55 - (dx + dy) / (size * 1.6)))
  return [Math.round(40 + 60 * light), Math.round(110 + 80 * light), Math.round(220 + 30 * light), Math.round(255 * edge)]
})

mkdirSync(join(folder, 'boards'), { recursive: true })
mkdirSync(join(folder, 'assets'), { recursive: true })
writeFileSync(join(folder, 'assets', 'earth.png'), earth)
copyFileSync(join(here, 'demo-v2.board.json'), join(folder, 'boards', 'demo-v2.board.json'))

// A step 1 board (format version 1, ink strokes in "items").
const strokes = JSON.parse(readFileSync(join(here, '..', 'strokes', 'two-plus-two.json'), 'utf8'))
const items = strokes.map((points, i) => ({ id: `s_v1stroke${i}`, kind: 'stroke', seq: i + 1, tool: 'pen', color: '#ececef', width: 3.5, points }))
const v1 = [
  '{',
  '  "format": "askaboard.board",',
  '  "version": 1,',
  `  "nextSeq": ${items.length + 1},`,
  '  "items": [',
  ...items.map((item, i) => `    ${JSON.stringify(item)}${i < items.length - 1 ? ',' : ''}`),
  '  ]',
  '}',
  ''
].join('\n')
writeFileSync(join(folder, 'boards', 'old-v1.board.json'), v1)
console.log(`demo folder ready: ${folder}`)
