// The agent side of the README hero image (hero-image.mjs): one MCP session to the app, as Claude
// Code connects (clientInfo name "claude-code"), so the app's agent pill shows "Claude Code" in the
// picture. It uses the app's own MCP SDK dependency.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const SPACE = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(join(SPACE, 'package.json'))

/** Connect to the app's MCP server on this port. Returns { call(name, args) → text, close() }. */
export async function connectAgent(port) {
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
  const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
  const client = new Client({ name: 'claude-code', version: '2.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
  await client.connect(transport)
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })
      const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      if (result.isError) throw new Error(`${name}: ${text}`)
      return text
    },
    async close() {
      await transport.terminateSession().catch(() => undefined)
      await client.close().catch(() => undefined)
    }
  }
}
