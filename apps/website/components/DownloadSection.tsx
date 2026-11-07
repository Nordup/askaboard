import { DownloadButton } from './DownloadButton'
import { GAPS, sectionBox } from '@/lib/spacing'
import type { CSSProperties } from 'react'
import styles from './Sections.module.css'

/**
 * The download (website plan, page item 5): the last part of the board. The big hand line and the
 * loose drawings round the button are board items placed from this section (layout.ts, anchor `download`).
 */
/** The button and its line (.cta), design units from the section's top (Sections.module.css). */
const TEXT = { desk: [{ top: 200, bottom: 311 }], phone: [{ top: 110, bottom: 192 }] }
const BOX = sectionBox('download', TEXT, GAPS.agentsToDownload, GAPS.downloadToFooter)

export function DownloadSection() {
  const style = { '--m-desk': BOX.marginDesk, '--h-desk': BOX.heightDesk, '--m-phone': BOX.marginPhone, '--h-phone': BOX.heightPhone } as CSSProperties
  return (
    <section id="download" className={`${styles.section} ${styles.download}`} data-anchor="download" aria-labelledby="dl-title" style={style}>
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
