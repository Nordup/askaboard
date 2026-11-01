import { useCallback, useEffect, useRef, useState } from 'react'
import { useMenuDismiss } from '../lib/dismiss'
import { setWorldUncapped } from '../live-pixels/world/surface'
import { usePerfReading } from '../perf-meter'

/** The dot: green from this frame rate, amber from the next, red below it. */
const FPS_GOOD = 55
const FPS_FAIR = 40

const ms = (value: number | null): string => (value === null ? '-' : `${value.toFixed(1)} ms`)
const fixed = (value: number | null, unit: string, digits = 0): string => (value === null ? '-' : `${value.toFixed(digits)} ${unit}`)

function count(value: number | null): string {
  if (value === null) return '-'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value))
}

function Row({ name, value }: { name: string; value: string }) {
  return (
    <div className="menu__row">
      <span className="menu__name">{name}</span>
      <span className="menu__meta menu__meta--mono">{value}</span>
    </div>
  )
}

/**
 * The top-bar performance pill (View > Show performance). It reads the render meter,
 * and while it is mounted the meter runs: a closed pill costs nothing. "Time per
 * picture" is wall time: the timer-query GPU time adds overlapping spans and reads too
 * high here (scripts/perf/README.md). While the pill is mounted and its row is on, worlds
 * render uncapped: pictures per second then show the headroom. With the pill off, the cap holds.
 */
export function PerfPill() {
  const reading = usePerfReading()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useMenuDismiss(open, rootRef, close)
  const [uncapped, setUncapped] = useState<{ on: boolean; launched: boolean } | null>(null)
  useEffect(() => void window.space.getUncappedFrames().then(setUncapped), [])
  const uncappedOn = uncapped?.on ?? false
  useEffect(() => {
    setWorldUncapped(uncappedOn)
    return () => setWorldUncapped(false)
  }, [uncappedOn])
  const flipUncapped = (): void => {
    if (!uncapped) return
    setUncapped({ ...uncapped, on: !uncapped.on })
    void window.space.setUncappedFrames(!uncapped.on)
  }

  const fps = reading?.fps ?? null
  const world = reading?.world && reading.world.pictures > 0 ? reading.world : null
  const dot = fps === null ? '' : fps >= FPS_GOOD ? ' status-dot--live' : fps >= FPS_FAIR ? ' status-dot--warn' : ' status-dot--bad'
  const rate = fixed(fps, 'fps')
  const text = world?.pictureMsMedian != null ? `${rate} · ${ms(world.pictureMsMedian)}` : rate

  return (
    <div className="perf-pill" ref={rootRef}>
      <div className={`pill pill--static${open ? ' pill--open' : ''}`}>
        <button className="pill__toggle" title="Performance" aria-label="Performance details" aria-expanded={open} onClick={() => setOpen((now) => !now)}>
          <span className={`status-dot${dot}`} />
          <span className="pill__time">{text}</span>
        </button>
      </div>
      {open && (
        <div className="menu perf-pop" role="dialog" aria-label="Performance">
          <div className="menu__heading">Board</div>
          <Row name="Frame rate" value={rate} />
          <Row name="Slowest frame" value={fixed(reading?.worstFrameMs ?? null, 'ms')} />
          <Row name="Dropped, last 10 s" value={reading ? String(reading.droppedFrames) : '-'} />
          <div className="menu__separator" />
          <div className="menu__heading">Worlds</div>
          {world ? (
            <>
              <Row name="Pictures" value={fixed(world.picturesPerSecond, '/s')} />
              <Row name="Time per picture" value={ms(world.pictureMsMedian)} />
              <Row name="Resolution" value={`${Math.round(world.resolution * 100)}%`} />
              <Row name="Pixels" value={fixed(world.megapixels, 'MP', 1)} />
              <Row name="Draws, triangles" value={`${count(world.drawCalls)}, ${count(world.triangles)}`} />
            </>
          ) : (
            <div className="menu__line">No world moving</div>
          )}
          <div className="menu__separator" />
          <div className="menu__row">
            <span className="menu__name">Uncapped frame rate</span>
            <span className="menu__control">
              <button className="menu__switch" role="switch" aria-checked={uncappedOn} aria-label="Uncapped frame rate" onClick={flipUncapped} />
            </span>
          </div>
          {uncapped && uncapped.on !== uncapped.launched && <div className="menu__line">Restart to apply</div>}
        </div>
      )}
    </div>
  )
}
