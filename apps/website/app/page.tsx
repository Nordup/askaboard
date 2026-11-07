import { AppShell } from '@/components/AppShell'
import { Board } from '@/components/Board'
import { AgentSection } from '@/components/AgentSection'
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
      <AgentSection />
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
