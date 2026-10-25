import { useEffect, useRef, useState } from 'react'
import { useSceneState, type SceneCueState } from '../live/state'
import { fadeMs, usePresence } from '../lib/presence'

/** How long a line stays after its cue ends, before it fades out. */
const LINGER_MS = 1200

interface CaptionView {
  key: string
  spoken: string
  rest: string
}

/** The part of a cue read so far (at the reading pace), and the rest. */
function split(cue: SceneCueState): { spoken: string; rest: string } {
  const spoken = cue.text.startsWith(cue.readSoFar) ? cue.readSoFar : ''
  return { spoken, rest: cue.text.slice(spoken.length) }
}

let measureContext: CanvasRenderingContext2D | null = null

/**
 * A cue longer than two caption lines shows as pages of at most two lines,
 * like film subtitles: the page that holds the word being read. Lines are
 * packed with the caption's own font and width (a hidden probe element).
 */
function page(probe: HTMLElement | null, spoken: string, rest: string): { spoken: string; rest: string } {
  if (!probe) return { spoken, rest }
  const style = getComputedStyle(probe)
  const width = probe.clientWidth
  if (!width) return { spoken, rest }
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) return { spoken, rest }
  measureContext.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const words = (spoken + rest).split(/(?<=\s)/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && measureContext.measureText((line + word).trimEnd()).width > width) {
      lines.push(line)
      line = word
    } else line += word
  }
  if (line) lines.push(line)
  if (lines.length <= 2) return { spoken, rest }
  // Pages of two lines; show the one where the spoken part ends.
  let start = 0
  for (let i = 0; i < lines.length; i += 2) {
    const text = lines[i] + (lines[i + 1] ?? '')
    const end = start + text.length
    if (spoken.length < end || i + 2 >= lines.length) {
      const cut = Math.min(Math.max(spoken.length - start, 0), text.length)
      return { spoken: text.slice(0, cut), rest: text.slice(cut) }
    }
    start = end
  }
  return { spoken, rest }
}

/**
 * The tutor's words above the tool palette while a scene plays a line: one
 * or two centred lines, the words read so far bright, the rest muted. No card: a halo in the
 * canvas colour keeps the text readable over the board.
 */
export function SceneCaption() {
  const scene = useSceneState()
  const probe = useRef<HTMLDivElement>(null)
  const cue = scene.currentCue
  const live: CaptionView | null = cue ? { key: `${cue.at_s}:${cue.text}`, ...split(cue) } : null

  // After a cue ends, its full line stays for LINGER_MS; a new cue replaces it at once.
  const [held, setHeld] = useState<CaptionView | null>(null)
  const liveKey = live?.key ?? null
  const liveText = cue?.text ?? null
  useEffect(() => {
    if (liveKey !== null && liveText !== null) {
      setHeld({ key: liveKey, spoken: liveText, rest: '' })
      return
    }
    const timer = setTimeout(() => setHeld(null), LINGER_MS)
    return () => clearTimeout(timer)
  }, [liveKey, liveText])

  const { value, shown } = usePresence(live ?? held, fadeMs())
  const text = value ? page(probe.current, value.spoken, value.rest) : null
  return (
    <>
      <div ref={probe} className="scene-caption__probe" aria-hidden="true" />
      {text && (
        <div className={`scene-caption${shown ? ' is-shown' : ''}`}>
          <p className="scene-caption__text">
            <span className="scene-caption__spoken">{text.spoken}</span>
            {text.rest}
          </p>
        </div>
      )}
    </>
  )
}
