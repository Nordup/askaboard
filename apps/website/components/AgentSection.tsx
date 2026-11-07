import type { Logo } from '@/lib/agents'
import { LOGO_PATHS } from '@/lib/logos'
import { GLIDE } from '@/lib/shell-steps'
import { GAPS, sectionBox } from '@/lib/spacing'
import type { CSSProperties } from 'react'
import styles from './Sections.module.css'

/** The words of this section, in one place (the founder may rewrite them). The captions by the windows are in layout.ts (`agent-*-note`, `agent-*-caption`). */
const COPY = {
  heading: 'Connect your agent',
  line: 'Connect Claude, ChatGPT or Cursor over MCP, using your existing subscription. Learning Space is free.',
  logos: [
    ['claude', 'Claude'],
    ['openai', 'ChatGPT and Codex'],
    ['googlegemini', 'Gemini'],
    ['cursor', 'Cursor']
  ] as [Logo, string][]
}

/**
 * The agent section (website plan, page item 4), in the board's own look: a heading and one line
 * as on the hero, then three quiet app windows, one case each (it sees, it checks, it explains),
 * with hand-ink captions. The windows and captions are board items placed from this section
 * (layout.ts, anchor `agents`).
 */
/** The heading and line block (.agentWords), design units from the section's top: on a phone the line wraps. */
const TEXT = { desk: [{ top: 0, bottom: 104 }], phone: [{ top: 0, bottom: 112 }] }
const BOX = sectionBox('agents', TEXT, GAPS.shellToAgents)

export function AgentSection() {
  const style = { '--m-desk': BOX.marginDesk, '--h-desk': BOX.heightDesk, '--m-phone': BOX.marginPhone, '--h-phone': BOX.heightPhone, '--glide-tail': `${GLIDE * 50}svh` } as CSSProperties
  return (
    <section className={`${styles.section} ${styles.agents}`} data-anchor="agents" aria-labelledby="agent-title" style={style}>
      <div className={styles.agentWords}>
        <h2 id="agent-title" className={styles.agentTitle}>
          {COPY.heading}
        </h2>
        <p className={styles.agentLine}>
          <span>{COPY.line}</span>
          <span className={styles.logos}>
            {COPY.logos.map(([logo, name]) => (
              <svg key={logo} viewBox="0 0 24 24" className={styles[logo]} role="img" aria-label={name}>
                <path d={LOGO_PATHS[logo]} />
              </svg>
            ))}
          </span>
        </p>
      </div>
    </section>
  )
}
