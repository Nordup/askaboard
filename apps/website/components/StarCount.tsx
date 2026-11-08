'use client'

import { useEffect, useState } from 'react'
import { formatStars } from '@/lib/github'
import { REPO } from '@/lib/site'

/** The star count in the top bar: the build-time count first, then the live count from GitHub, read once in the browser. A failed read keeps the build-time count. */
export function StarCount({ initial, className }: { initial: number | null; className?: string }) {
  const [stars, setStars] = useState(initial)

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    fetch(`https://api.github.com/repos/${REPO}`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { stargazers_count?: unknown } | null) => {
        if (typeof data?.stargazers_count === 'number') setStars(data.stargazers_count)
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer))
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [])

  if (stars === null) return <>GitHub</>
  return (
    <>
      <b className={className}>{formatStars(stars)}</b> GitHub stars
    </>
  )
}
