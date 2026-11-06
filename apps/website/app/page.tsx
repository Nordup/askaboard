import { AppShell } from '@/components/AppShell'
import { Board } from '@/components/Board'
import { Hero } from '@/components/Hero'
import { REPO_URL } from '@/lib/site'
import styles from './page.module.css'

export default function Home() {
  return (
    <main className={styles.page} data-board="">
      <Hero />
      <AppShell />
      <footer id="download" className={styles.footer}>
        MIT · <a href={REPO_URL}>GitHub</a>
      </footer>
      <Board />
    </main>
  )
}
