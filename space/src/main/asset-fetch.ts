import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { net, session } from 'electron'

/**
 * Image downloads for agent-chosen URLs (write_html <img src="https://…">).
 * The URL comes from an agent, so treat it as hostile (SSRF):
 * - https only; the host is normalized (lowercase, no trailing dot);
 * - every resolved address must be public: no loopback, private, link-local,
 *   CGNAT, unspecified, multicast or reserved ranges (IPv4-mapped IPv6 too);
 * - redirects are followed by hand, at most MAX_HOPS, each one checked again;
 * - the request goes through an in-memory session with no cookies or cache
 *   shared with the app;
 * - size cap and an image/* content type.
 * Errors stay generic: no upstream detail goes back to the agent.
 *
 * Known gap: the check resolves the name, then the request resolves it again,
 * so a DNS answer that changes between the two (rebinding) is not caught.
 */

const MAX_HOPS = 3
const TIMEOUT_MS = 20_000

export class DownloadError extends Error {}
const refused = (): DownloadError => new DownloadError('Image download refused: that address is not allowed.')
const failed = (): DownloadError => new DownloadError('Image download failed.')

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, broadcast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8] // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}

/** The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) IPv6 address. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase()
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (dotted) return dotted[1]
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  return null
}

/** True when an IP address must not be fetched. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family === 6) {
    const inner = embeddedIpv4(address)
    if (inner) return blocked.check(inner, 'ipv4')
    return blocked.check(address, 'ipv6')
  }
  return true
}

/** Check one URL: https, a normalized host, and only public addresses. Returns the normalized URL. */
async function checkUrl(raw: string): Promise<URL> {
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
  let addresses: { address: string }[]
  if (isIP(host)) addresses = [{ address: host }]
  else {
    try {
      addresses = await lookup(host, { all: true, verbatim: true })
    } catch {
      throw failed()
    }
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) throw refused()
  return url
}

let fetchSession: Electron.Session | null = null
function assetSession(): Electron.Session {
  // No "persist:" prefix: in memory only, separate from the app's cookies and cache.
  fetchSession ??= session.fromPartition('assets-fetch', { cache: false })
  return fetchSession
}

type Hop =
  | { kind: 'redirect'; location: string }
  | { kind: 'response'; status: number; headers: Record<string, string | string[]>; data: Buffer }

/**
 * One request, no automatic redirects. Electron's fetch() throws on
 * redirect: 'manual', so this uses net.request, whose "redirect" event lets
 * us read the Location and stop.
 */
function requestOnce(url: URL, maxBytes: number, check: (headers: Record<string, string | string[]>, status: number) => DownloadError | null): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const request = net.request({
      url: url.toString(),
      method: 'GET',
      session: assetSession(),
      redirect: 'manual',
      credentials: 'omit',
      useSessionCookies: false
    })
    const timer = setTimeout(() => {
      request.abort()
      finish(() => reject(failed()))
    }, TIMEOUT_MS)
    request.setHeader('Accept', 'image/*')
    request.on('redirect', (_status, _method, redirectUrl) => {
      request.abort()
      finish(() => resolve({ kind: 'redirect', location: redirectUrl }))
    })
    request.on('error', () => finish(() => reject(failed())))
    request.on('response', (response) => {
      const headers = response.headers as Record<string, string | string[]>
      const problem = check(headers, response.statusCode)
      if (problem) {
        request.abort()
        finish(() => reject(problem))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          request.abort()
          finish(() => reject(new DownloadError(`Image download failed: larger than ${maxBytes / 1024 / 1024} MB.`)))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => finish(() => resolve({ kind: 'response', status: response.statusCode, headers, data: Buffer.concat(chunks) })))
      response.on('error', () => finish(() => reject(failed())))
    })
    request.end()
  })
}

const header = (headers: Record<string, string | string[]>, name: string): string => {
  const value = headers[name]
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/** Download an image. Resolves the bytes and the content type (image/* only). */
export async function downloadImage(
  raw: string,
  maxBytes: number,
  allowedTypes: Readonly<Record<string, string>>
): Promise<{ data: Buffer; type: string; url: URL }> {
  let url = await checkUrl(raw)
  const typeOf = (headers: Record<string, string | string[]>): string => header(headers, 'content-type').split(';')[0].trim().toLowerCase()
  for (let hop = 0; ; hop++) {
    const result = await requestOnce(url, maxBytes, (headers, status) => {
      if (status < 200 || status >= 300) return failed()
      if (!allowedTypes[typeOf(headers)]) return new DownloadError('Image download failed: the address does not serve a supported image.')
      if (Number(header(headers, 'content-length') || 0) > maxBytes) {
        return new DownloadError(`Image download failed: larger than ${maxBytes / 1024 / 1024} MB.`)
      }
      return null
    })
    if (result.kind === 'redirect') {
      if (hop >= MAX_HOPS) throw failed()
      url = await checkUrl(new URL(result.location, url).toString())
      continue
    }
    return { data: result.data, type: typeOf(result.headers), url }
  }
}
