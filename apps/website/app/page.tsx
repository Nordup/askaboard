import { AppShell } from '@/components/AppShell'
import { Board } from '@/components/Board'
import { AgentSection } from '@/components/AgentSection'
import { DownloadSection } from '@/components/DownloadSection'
import { Hero } from '@/components/Hero'
import { StructuredData } from '@/components/StructuredData'
import sections from '@/components/Sections.module.css'
import { DISCUSSIONS_URL, DOWNLOAD_URL, PLUGINS_URL, PRIVACY_URL, REPO_URL, SITE_NAME } from '@/lib/site'
import styles from './page.module.css'

export default function Home() {
  return (
    <main className={styles.page} data-board="">
      <StructuredData />
      <Hero />
      <AppShell />
      <AgentSection />
      <DownloadSection />
      <footer className={sections.footer}>
        <span className={sections.legal}>
          {/* app/icon.svg: Next serves the app icon at /icon.svg. */}
          <img src="/icon.svg" alt="" width={20} height={20} />© 2026 Nordup · MIT licensed
        </span>
        <nav className={sections.footerLinks} aria-label={`${SITE_NAME} links`}>
          <a href={REPO_URL}>GitHub</a>
          <a href={DISCUSSIONS_URL}>Discussions</a>
          <a href={DOWNLOAD_URL}>Download</a>
          <a href={PLUGINS_URL}>Plugins</a>
          <a href={PRIVACY_URL}>Privacy</a>
        </nav>
      </footer>
      <Board />
    </main>
  )
}
