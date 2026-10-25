import { lookup } from 'node:dns/promises'
import { Agent, request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { LookupFunction } from 'node:net'
import { BlockList, isIP } from 'node:net'

/**
 * Image downloads for agent-chosen URLs (a scene's image() and html() <img src="https://…">).
 * The URL comes from an agent, so treat it as hostile (SSRF):
 * - https only; the host is normalized (lowercase, no trailing dot);
 * - every resolved address must be public: no loopback, private, link-local,
 *   CGNAT, unspecified, multicast, documentation or reserved ranges, and no
 *   IPv6 address that embeds an IPv4 address (mapped, compatible, NAT64,
 *   6to4, Teredo);
 * - the connection is pinned to the address that passed the check: a custom
 *   `lookup` returns it, so the name is never resolved a second time (no DNS
 *   rebinding). SNI and the Host header carry the original name, and the
 *   certificate is verified against it as usual;
 * - after connect, the socket's remote address is checked again;
 * - redirects are followed by hand, at most MAX_HOPS, each one checked again;
 * - Node https: no cookies, no cache, a private agent (no proxy from env);
 * - size cap while streaming, an image/* content type, one total deadline.
 * Errors stay generic: no upstream detail goes back to the agent.
 */

const MAX_HOPS = 3
const TIMEOUT_MS = 15_000

export class DownloadError extends Error {}
const refused = (): DownloadError => new DownloadError('Image download refused: that address is not allowed.')
const failed = (): DownloadError => new DownloadError('Image download failed.')
const tooLarge = (maxBytes: number): DownloadError =>
  new DownloadError(`Image download failed: larger than ${maxBytes / 1024 / 1024} MB.`)

// One list per family: Node's BlockList matches an IPv4 query against IPv6
// rules such as ::ffff:0:0/96, so a shared list would block every IPv4 address.
const blocked4 = new BlockList()
const blocked6 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
  ['255.255.255.255', 32] // broadcast
] as const) {
  blocked4.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['::', 96], // IPv4-compatible (deprecated)
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local NAT64
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8] // multicast
] as const) {
  blocked6.addSubnet(network, prefix, 'ipv6')
}

/** True when an IP address must not be fetched. Anything that is not an IP address is blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked4.check(address, 'ipv4')
  if (family === 6) return blocked6.check(address, 'ipv6')
  return true
}

interface Target {
  url: URL
  host: string // normalized, no brackets
  address: string // the checked address the connection is pinned to
  family: 4 | 6
}

/** Check one URL: https, a normalized host, and only public addresses. Returns the pinned target. */
async function checkUrl(raw: string, resolve: typeof lookup): Promise<Target> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw refused()
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw refused()
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw refused()
  url.hostname = isIP(host) === 6 ? `[${host}]` : host
  let addresses: { address: string; family: number }[]
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }]
  else {
    try {
      addresses = await resolve(host, { all: true, verbatim: true })
    } catch {
      throw failed()
    }
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) throw refused()
  const { address, family } = addresses[0]
  if (family !== 4 && family !== 6) throw refused()
  return { url, host, address, family }
}

type Hop =
  | { kind: 'redirect'; location: string }
  | { kind: 'response'; type: string; data: Buffer }

const header = (response: IncomingMessage, name: string): string => {
  const value = response.headers[name]
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/** One GET to the pinned address, no automatic redirects. */
function requestOnce(
  target: Target,
  maxBytes: number,
  allowedTypes: Readonly<Record<string, string>>,
  deadline: number
): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      reject(failed())
      return
    }
    // Answer every lookup with the checked address: no second resolution.
    const pinned: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: target.address, family: target.family }])
      else callback(null, target.address, target.family)
    }
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 })
    const request = httpsRequest({
      agent,
      protocol: 'https:',
      host: target.host,
      port: target.url.port || 443,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'GET',
      lookup: pinned,
      // SNI must be a name, never an IP literal; certificate checks stay on (rejectUnauthorized defaults to true).
      servername: isIP(target.host) ? undefined : target.host,
      headers: {
        Host: target.url.host,
        Accept: 'image/*',
        'Accept-Encoding': 'identity',
        // Some hosts (Wikimedia) refuse requests without a User-Agent.
        'User-Agent': 'LearningSpace/0.0.1 (image download)'
      }
    })
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.destroy()
      agent.destroy()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(failed())), remaining)
    request.on('error', () => finish(() => reject(failed())))
    request.on('response', (response) => {
      // Defence in depth: the peer we actually reached must also be public.
      const remote = response.socket?.remoteAddress
      if (!remote || isBlockedAddress(remote)) {
        finish(() => reject(refused()))
        return
      }
      const status = response.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = header(response, 'location')
        finish(() => (location ? resolve({ kind: 'redirect', location }) : reject(failed())))
        return
      }
      if (status < 200 || status >= 300) {
        finish(() => reject(failed()))
        return
      }
      const type = header(response, 'content-type').split(';')[0].trim().toLowerCase()
      if (!allowedTypes[type]) {
        finish(() => reject(new DownloadError('Image download failed: the address does not serve a supported image.')))
        return
      }
      if (Number(header(response, 'content-length') || 0) > maxBytes) {
        finish(() => reject(tooLarge(maxBytes)))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          finish(() => reject(tooLarge(maxBytes)))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => finish(() => resolve({ kind: 'response', type, data: Buffer.concat(chunks) })))
      response.on('error', () => finish(() => reject(failed())))
      response.on('aborted', () => finish(() => reject(failed())))
    })
    request.end()
  })
}

/**
 * Download an image. Resolves the bytes and the content type (image/* only).
 * `resolve` is the DNS lookup; it exists only so a check script can stub it.
 */
export async function downloadImage(
  raw: string,
  maxBytes: number,
  allowedTypes: Readonly<Record<string, string>>,
  resolve: typeof lookup = lookup
): Promise<{ data: Buffer; type: string; url: URL }> {
  const deadline = Date.now() + TIMEOUT_MS
  let target = await checkUrl(raw, resolve)
  for (let hop = 0; ; hop++) {
    const result = await requestOnce(target, maxBytes, allowedTypes, deadline)
    if (result.kind === 'redirect') {
      if (hop >= MAX_HOPS) throw failed()
      target = await checkUrl(new URL(result.location, target.url).toString(), resolve)
      continue
    }
    return { data: result.data, type: result.type, url: target.url }
  }
}
