import { DownloadButton } from './DownloadButton'
import styles from './Sections.module.css'

/**
 * The download (website plan, page item 5): the last part of the board. The big hand line and the
 * loose drawings round the button are board items placed from this section (layout.ts, anchor `download`).
 */
export function DownloadSection() {
  return (
    <section id="download" className={`${styles.section} ${styles.download}`} data-anchor="download" aria-labelledby="dl-title">
      <h2 id="dl-title" className={styles.hiddenTitle}>
        Open a board, ask anything
      </h2>
      <div className={styles.cta}>
        <DownloadButton />
        <p className={styles.quiet}>Free and open source · Apple silicon and Intel</p>
      </div>
    </section>
  )
}
