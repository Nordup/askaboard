#!/usr/bin/env node
/**
 * Call one MCP tool of a lab app and print the text; images go to files.
 *
 *   node scripts/lab/mcp-call.mjs --port 47890 <tool> '<json args>' [--out image.png]
 *
 * Example: node scripts/lab/mcp-call.mjs --port 47890 get_screenshot '{"target":"content"}' --out shot.png
 */
import { writeFileSync } from 'node:fs'
import { args, resultText, withMcp } from './common.mjs'

const { option, positional } = args()
const port = Number(option('--port', '47890'))
const out = option('--out', null)
const [tool, json = '{}'] = positional
if (!tool) {
  console.error("usage: node scripts/lab/mcp-call.mjs --port N <tool> '<json args>' [--out image.png]")
  process.exit(1)
}
await withMcp(port, async (call) => {
  const result = await call(tool, JSON.parse(json))
  console.log(resultText(result))
  const images = (result?.content ?? []).filter((c) => c.type === 'image')
  images.forEach((image, i) => {
    const file = out ? (images.length > 1 ? out.replace(/(\.\w+)?$/, `-${i + 1}$1`) : out) : `mcp-image-${i + 1}.png`
    writeFileSync(file, Buffer.from(image.data, 'base64'))
    console.log(`image: ${file}`)
  })
})
