/**
 * The libraries that worlds import by bare name, served by the app
 * (main/live-item-protocol.ts) so they load fast and with no network. Any
 * other bare name loads from esm.sh, and any URL loads as it is.
 *
 * To add a library: put its files where the protocol handler can read them
 * (a dependency in package.json or a file in resources/live/), add a route in
 * the handler, and add its bare names here.
 */

export const LIVE_SCHEME = 'live-item'
export const LIVE_ORIGIN = `${LIVE_SCHEME}://host`

/** Bare name (exact) → URL. */
const EXACT: Record<string, string> = {
  three: `${LIVE_ORIGIN}/lib/three/build/three.module.js`,
  'three/webgpu': `${LIVE_ORIGIN}/lib/three/build/three.webgpu.js`,
  'three/tsl': `${LIVE_ORIGIN}/lib/three/build/three.tsl.js`,
  'ls/interact': `${LIVE_ORIGIN}/lib/ls/interact.js`
}

/** Bare name prefix → URL prefix. */
const PREFIX: Array<[string, string]> = [
  ['three/addons/', `${LIVE_ORIGIN}/lib/three/examples/jsm/`],
  ['three/examples/jsm/', `${LIVE_ORIGIN}/lib/three/examples/jsm/`]
]

/** The bare names served locally, for the guide and errors. */
export const LOCAL_LIBRARIES = [...Object.keys(EXACT), ...PREFIX.map(([prefix]) => `${prefix}…`)]

function isBare(spec: string): boolean {
  return !/^(\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(spec)
}

/** Where an import specifier loads from. Relative and absolute URLs stay as they are. */
export function resolveLiveSpecifier(spec: string, external = true): string {
  if (!isBare(spec)) return spec
  if (EXACT[spec]) return EXACT[spec]
  for (const [prefix, url] of PREFIX) if (spec.startsWith(prefix)) return url + spec.slice(prefix.length)
  return external ? `https://esm.sh/${spec}` : spec
}

/** Rewrite the bare specifiers of `from '…'`, `import '…'` and `import('…')` in module source. */
export function rewriteBareImports(source: string, external = true): string {
  const swap = (spec: string): string => resolveLiveSpecifier(spec, external)
  return source
    .replace(/(\bfrom\s*)(['"])([^'"\n]+)\2/g, (_, head: string, quote: string, spec: string) => `${head}${quote}${swap(spec)}${quote}`)
    .replace(/(\bimport\s*)(['"])([^'"\n]+)\2/g, (_, head: string, quote: string, spec: string) => `${head}${quote}${swap(spec)}${quote}`)
    .replace(/(\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g, (_, head: string, quote: string, spec: string) => `${head}${quote}${swap(spec)}${quote}`)
}

/**
 * A program's source as the body of an async function: its static imports
 * become `await import(…)` on the same lines (so error line numbers still
 * match), and bare names resolve as above.
 */
export function programBody(source: string): string {
  let n = 0
  const importRe = /(^|[\n;])([ \t]*)import\s+([\w$\s{},*]+?)\s+from\s*(['"])([^'"\n]+)\4[ \t]*;?|(^|[\n;])([ \t]*)import\s*(['"])([^'"\n]+)\8[ \t]*;?/g
  const body = source.replace(importRe, (match: string, lead1?: string, indent1?: string, clause?: string, _q?: string, spec1?: string, lead2?: string, indent2?: string, _q2?: string, spec2?: string) => {
    const lines = (match.match(/\n/g) ?? []).length - ((lead1 ?? lead2) === '\n' ? 1 : 0)
    const pad = '\n'.repeat(Math.max(0, lines))
    const lead = lead1 ?? lead2 ?? ''
    const indent = indent1 ?? indent2 ?? ''
    if (spec2 !== undefined) return `${lead}${indent}await import(${JSON.stringify(resolveLiveSpecifier(spec2))});${pad}`
    const url = JSON.stringify(resolveLiveSpecifier(spec1 as string))
    const parts: string[] = []
    let rest = (clause as string).replace(/\s+/g, ' ').trim()
    const m = `__lsImport${n++}`
    parts.push(`const ${m} = await import(${url});`)
    const star = /^\*\s+as\s+([\w$]+)$/.exec(rest) ?? /,\s*\*\s+as\s+([\w$]+)$/.exec(rest)
    if (star) {
      parts.push(`const ${star[1]} = ${m};`)
      rest = rest.slice(0, star.index).replace(/,\s*$/, '').trim()
    }
    const named = /\{([^}]*)\}/.exec(rest)
    if (named) {
      const fields = named[1]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.replace(/^([\w$]+)\s+as\s+([\w$]+)$/, '$1: $2'))
      if (fields.length) parts.push(`const { ${fields.join(', ')} } = ${m};`)
      rest = (rest.slice(0, named.index) + rest.slice(named.index + named[0].length)).replace(/,/g, ' ').trim()
    }
    if (rest) parts.push(`const ${rest} = ${m}.default;`)
    return `${lead}${indent}${parts.join(' ')}${pad}`
  })
  // Dynamic import() calls keep their place; only their bare names change. `export` has no meaning here.
  return body
    .replace(/(\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g, (_, head: string, quote: string, spec: string) => `${head}${quote}${resolveLiveSpecifier(spec)}${quote}`)
    .replace(/(^|\n)([ \t]*)export\s+(default\s+)?(?=(const|let|var|function|class|async)\b)/g, '$1$2')
}
