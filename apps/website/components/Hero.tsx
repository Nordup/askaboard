import { formatStars, getStars } from '@/lib/github'
import { REPO_URL } from '@/lib/site'
import { DownloadButton } from './DownloadButton'
import styles from './Hero.module.css'

/** The hero (decision D11): the top bar as on t3.codes and the headline. The board round it is Board.tsx, over the whole page. */
export async function Hero() {
  const stars = await getStars()
  return (
    <section className={styles.hero} data-hero="">
      <header className={styles.bar} data-ui="">
        <a href="/" className={styles.name}>
          <span className={styles.nameStrong}>Learning</span> Space
        </a>
        <nav className={styles.links}>
          <a href="#download" className={styles.link}>
            Download
          </a>
          <a href={REPO_URL} className={styles.stars}>
            <span className={styles.star} aria-hidden="true">
              ★
            </span>
            {stars === null ? (
              'GitHub'
            ) : (
              <>
                <b className={styles.count}>{formatStars(stars)}</b> GitHub stars
              </>
            )}
          </a>
        </nav>
      </header>

      <div className={styles.head}>
        <h1 className={styles.title}>
          Ask anything.
          <br />
          Learn anything.
        </h1>
        <p className={styles.sub}>A shared canvas for learning with your AI.</p>
        <DownloadButton className={styles.download} />
        <a className={`${styles.note} ${styles.source}`} href={REPO_URL} target="_blank" rel="noreferrer">
          <svg className={styles.github} viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
          Open source on GitHub
          <svg className={styles.out} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 17 17 7M8 7h9v9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      </div>

    </section>
  )
}
