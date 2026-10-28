import { useEffect, useRef, useState } from 'react'

/**
 * Fade a piece of UI in and out with a CSS opacity transition (`--fade`).
 *
 * Give it the value to show, or null to hide it. It returns the value to
 * render (the last one stays while the UI fades out) and whether the UI is
 * shown. Render the value with an `is-shown` class while `shown` is true.
 * The CSS transition does the fade; reduced motion turns the transition off.
 */
export function usePresence<T>(value: T | null, fadeMs: number): { value: T | null; shown: boolean } {
  const present = value !== null
  const last = useRef<T | null>(value)
  const [mounted, setMounted] = useState(present)
  const [shown, setShown] = useState(false)

  if (present) last.current = value

  useEffect(() => {
    if (present) {
      setMounted(true)
      // Mount first, show on the next frame, so the transition runs.
      const frame = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(frame)
    }
    setShown(false)
    const timer = setTimeout(() => setMounted(false), fadeMs)
    return () => clearTimeout(timer)
  }, [present, fadeMs])

  return { value: present || mounted ? last.current : null, shown: present && shown }
}

/** A motion token's duration in ms (its first number: "220ms ease" → 220). */
export function tokenMs(name: string): number {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(value) ? value : 0
}

/** The `--fade` token's duration in ms (how long faded-out UI stays mounted). */
export function fadeMs(): number {
  return tokenMs('--fade')
}
