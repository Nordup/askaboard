import sections from '@/components/Sections.module.css'
import { DISCUSSIONS_URL, DOWNLOAD_URL, PLUGINS_URL, PRIVACY_URL, REPO_URL, SITE_NAME } from '@/lib/site'

/** The footer of every page (website plan: as on t3.codes): the app icon and the copyright line, and five text links. */
export function SiteFooter() {
  return (
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
  )
}
