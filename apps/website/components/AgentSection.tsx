import type { Logo } from '@/lib/agents'
import { LOGO_PATHS } from '@/lib/logos'
import styles from './Sections.module.css'

/** The words of this section, in one place (the founder may rewrite them). The captions by the windows are in layout.ts (`agent-*-note`, `agent-*-caption`). */
const COPY = {
  heading: 'Connect your agent',
  line: 'Claude, ChatGPT or Cursor connects to the board over MCP, on the plan you already pay for.',
  logos: [
    ['claude', 'Claude'],
    ['openai', 'ChatGPT and Codex'],
    ['cursor', 'Cursor']
  ] as [Logo, string][]
}

/**
 * The agent section (website plan, page item 4), in the board's own look: a heading and one line
 * as on the hero, then three quiet app windows, one case each (it sees, it checks, it builds 3D),
 * with hand-ink captions. The windows and captions are board items placed from this section
 * (layout.ts, anchor `agents`).
 */
export function AgentSection() {
  return (
    <section className={`${styles.section} ${styles.agents}`} data-anchor="agents" aria-labelledby="agent-title">
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
