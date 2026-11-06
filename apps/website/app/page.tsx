import { AppShell } from '@/components/AppShell'
import { Board } from '@/components/Board'
import { BringYourAI } from '@/components/BringYourAI'
import { DownloadSection } from '@/components/DownloadSection'
import { Hero } from '@/components/Hero'
import sections from '@/components/Sections.module.css'
import { REPO_URL } from '@/lib/site'
import styles from './page.module.css'

export default function Home() {
  return (
    <main className={styles.page} data-board="">
      <Hero />
      <AppShell />
      <BringYourAI />
      <DownloadSection />
      <footer className={sections.footer}>
        <a href="/" className={sections.wordmark}>
          <b>Learning</b> Space
        </a>
        <span>
          MIT · <a href={REPO_URL}>GitHub</a>
        </span>
      </footer>
      <Board />
    </main>
  )
}
