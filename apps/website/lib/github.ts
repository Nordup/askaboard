import { REPO } from './site'

/** The repo's star count, read once at build time. Null when the request fails (for example while the repo is private). */
export async function getStars(): Promise<number | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}`, {
      cache: 'force-cache',
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(4000)
    })
    if (!response.ok) return null
    const data: { stargazers_count?: unknown } = await response.json()
    return typeof data.stargazers_count === 'number' ? data.stargazers_count : null
  } catch {
    return null
  }
}

/** 950 → "950", 1234 → "1.2k", 12345 → "12k". */
export function formatStars(count: number): string {
  if (count < 1000) return String(count)
  const k = count / 1000
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`
}
