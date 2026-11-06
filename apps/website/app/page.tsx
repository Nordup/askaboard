import { AppShot } from '@/components/AppShot'
import { Hero } from '@/components/Hero'
import { REPO_URL } from '@/lib/site'
import styles from './page.module.css'

export default function Home() {
  return (
    <main>
      <Hero />
      <AppShot />
      <footer id="download" className={styles.footer}>
        MIT · <a href={REPO_URL}>GitHub</a>
      </footer>
    </main>
  )
}
