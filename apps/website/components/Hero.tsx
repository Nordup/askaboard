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
        <p className={styles.sub}>A shared canvas for you and your AI.</p>
        <DownloadButton className={styles.download} />
        <p className={styles.note}>Open source. Bring your own AI.</p>
      </div>

    </section>
  )
}
