import { formatStars, getStars } from '@/lib/github'
import { REPO_URL, SITE_NAME } from '@/lib/site'
import { Board } from './Board'
import styles from './Hero.module.css'

export async function Hero() {
  const stars = await getStars()
  return (
    <section className={styles.hero}>
      <header className={styles.bar}>
        <a href="/" className={styles.name} data-clear="name">
          <span className={`hand ${styles.mark}`}>~</span>
          {SITE_NAME}
        </a>
        <nav className={styles.links} data-clear="links">
          <a href="#download" className={styles.link}>
            Download
          </a>
          <a href={REPO_URL} className={styles.stars}>
            <span className={styles.star}>★</span>
            {stars === null ? 'GitHub' : `${formatStars(stars)} GitHub stars`}
          </a>
        </nav>
      </header>

      <div className={styles.stage}>
        <div className={styles.head} data-clear="head">
          <h1 className={styles.title}>
            Learn anything.
            <br />
            Watch it drawn.
          </h1>
          <p className={styles.sub}>Your agent explains any topic on a shared board. It draws, animates and talks. Bring the Claude, ChatGPT or Codex you already pay for.</p>
          <a href="#download" className={styles.download}>
            Download for Mac
          </a>
        </div>
      </div>

      <Board boardClass={styles.board} inkClass={styles.ink} />
    </section>
  )
}
