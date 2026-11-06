import styles from './AppShot.module.css'

/** The app as it is now, under the hero (decision D11): its window peeks above the fold. */
export function AppShot() {
  return (
    <section className={styles.shot} aria-label="The Learning Space app">
      {/* A plain img: the screenshot is one fixed product image (public/app-board.webp, 1996 × 1201). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.image} src="/app-board.webp" width={1996} height={1201} alt="The Learning Space app: the list of boards on the left and a board with a drawing of how a grating splits light." />
    </section>
  )
}
