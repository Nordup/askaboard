import { REPO_URL } from '@/lib/site'
import styles from './Sections.module.css'

/**
 * Bring your own AI (website plan, page item 4): the part of the board after the app shell. The
 * hand-written heading, the agent apps' terminal windows and the "open source, MIT" note are board
 * items placed from this section (layout.ts, anchor `agents`); the section holds the plain words.
 */
export function BringYourAI() {
  return (
    <section className={`${styles.section} ${styles.agents}`} data-anchor="agents" aria-labelledby="byo-title">
      <h2 id="byo-title" className={styles.hiddenTitle}>
        Bring the AI you already pay for
      </h2>
      <div className={styles.words}>
        <p className={styles.lead}>No AI inside. It works with the agent app you already pay for.</p>
        <p className={styles.quiet}>No new subscription, no API key. The app connects it in one click.</p>
        <a href={REPO_URL} className={styles.source}>
          Read the code on GitHub
        </a>
      </div>
    </section>
  )
}
