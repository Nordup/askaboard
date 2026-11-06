import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronLeft, Folder, FolderOpen, Plug } from 'lucide-react'
import type { RecentFolder } from '@shared/space-api'
import { shortcut } from '../../platform'
import { ConnectList, useAgentClients } from '../ConnectAgents'
import { startArt } from './art'

/** The project's repository (apps/website/lib/site.ts REPO_URL). */
const REPO_URL = 'https://github.com/Nordup/math-tutor'

interface SplashProps {
  recent: RecentFolder[]
  onOpenFolder(): void
  onOpenRecent(path: string): void
}

/** The folder that holds a recent folder, with ~ for the home folder. */
function parentOf(path: string): string {
  const parent = path.replace(/[/\\][^/\\]*[/\\]?$/, '') || '/'
  return parent.replace(/^(\/Users|\/home)\/[^/]+/, '~')
}

/** The order of an element in the entry stagger. */
const at = (i: number): CSSProperties => ({ '--i': i }) as CSSProperties

/**
 * The start screen with no folder open (decision U20): over the whole window, on the
 * window-wide backdrop, not dismissible. The band draws itself (art.ts); under it Start
 * and Recent, then the footer links. "Connect an agent" shows the agents' connect rows
 * in the card.
 */
export function Splash({ recent, onOpenFolder, onOpenRecent }: SplashProps) {
  const bandRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<'start' | 'connect'>('start')
  const { clients, checking, refresh } = useAgentClients()

  useEffect(() => {
    const band = bandRef.current
    const canvas = canvasRef.current
    if (!band || !canvas) return
    return startArt(canvas, band)
  }, [])

  const connect = (): void => {
    refresh()
    setView('connect')
  }

  return (
    <div className="splash">
      <div className="splash__drag" />
      <div className="splash__card" role="dialog" aria-label="Learning Space">
        <div className="splash__band" ref={bandRef}>
          <canvas className="splash__art" ref={canvasRef} />
          <div className="splash__name" style={at(0)}>
            Learning Space
          </div>
          <div className="splash__version" style={at(1)}>
            v{window.space.version}
          </div>
        </div>

        {view === 'start' ? (
          <div className="splash__panel">
            <div className="splash__column">
              <div className="menu__heading" style={at(2)}>
                Start
              </div>
              <button className="menu__item splash__primary" style={at(3)} onClick={onOpenFolder}>
                <span className="menu__icon">
                  <FolderOpen size={16} strokeWidth={1.75} />
                </span>
                <span className="menu__label">Open folder…</span>
                <span className="menu__hint">{shortcut('O')}</span>
              </button>
              <button className="menu__item" style={at(4)} onClick={connect}>
                <span className="menu__icon">
                  <Plug size={16} strokeWidth={1.75} />
                </span>
                <span className="menu__label">Connect an agent</span>
              </button>
            </div>
            <div className="splash__column">
              <div className="menu__heading" style={at(2)}>
                Recent
              </div>
              {recent.length === 0 ? (
                <div className="splash__empty" style={at(3)}>
                  No recent folders
                </div>
              ) : (
                <div className="splash__recent scroll-area">
                  {recent.map((entry, i) => (
                    <button key={entry.path} className="menu__item" style={at(3 + i)} onClick={() => onOpenRecent(entry.path)}>
                      <span className="menu__icon">
                        <Folder size={16} strokeWidth={1.75} />
                      </span>
                      <span className="menu__label splash__recent-name">{entry.name}</span>
                      <span className="menu__sub splash__recent-path">{parentOf(entry.path)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="splash__panel splash__panel--connect">
            <button className="menu__item" data-nav="back" onClick={() => setView('start')}>
              <span className="menu__icon">
                <ChevronLeft size={16} strokeWidth={2} />
              </span>
              <span className="menu__label">Connect an agent</span>
            </button>
            <div className="menu__separator" />
            <ConnectList clients={clients?.clients ?? null} checking={checking} layout="menu" onChanged={refresh} />
          </div>
        )}

        <div className="splash__footer" style={at(6)}>
          <button className="splash__link" onClick={() => window.open(`${REPO_URL}/releases`, '_blank')}>
            What’s new
          </button>
          <button className="splash__link" onClick={() => window.open(REPO_URL, '_blank')}>
            GitHub
          </button>
        </div>
      </div>
    </div>
  )
}
