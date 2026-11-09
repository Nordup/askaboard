import { AppShell } from '@/components/AppShell'
import { Board } from '@/components/Board'
import { AgentSection } from '@/components/AgentSection'
import { DownloadSection } from '@/components/DownloadSection'
import { Hero } from '@/components/Hero'
import { StructuredData } from '@/components/StructuredData'
import { SiteFooter } from '@/components/SiteFooter'
import styles from './page.module.css'

export default function Home() {
  return (
    <main className={styles.page} data-board="">
      <StructuredData />
      <Hero />
      <AppShell />
      <AgentSection />
      <DownloadSection />
      <SiteFooter />
      <Board />
    </main>
  )
}
