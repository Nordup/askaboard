import type { Metadata } from 'next'
import Image from 'next/image'
import { SiteFooter } from '@/components/SiteFooter'
import hero from '@/components/Hero.module.css'
import sections from '@/components/Sections.module.css'
import { SITE_NAME, SOCIAL_IMAGE } from '@/lib/site'
import page from '../page.module.css'
import styles from './privacy.module.css'

const title = `Privacy | ${SITE_NAME}`
const description = 'What data Askaboard uses, why, and where it goes.'

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: '/privacy' },
  openGraph: { title, description, url: '/privacy', siteName: SITE_NAME, type: 'article', images: [{ url: SOCIAL_IMAGE, width: 1200, height: 630 }] },
  twitter: { card: 'summary_large_image', title, description, images: [SOCIAL_IMAGE] }
}

const EMAIL = 'nordup.ondr@gmail.com'
const Email = () => <a href={`mailto:${EMAIL}`}>{EMAIL}</a>

/**
 * The privacy page: the founder's approved text (2026-11-10), word for word. It is a page of the
 * home page's board: the same page shell and dot grid (page.module.css), the hero's top bar
 * (Hero.module.css), the agent section's heading and quiet line (Sections.module.css) and the footer.
 */
export default function Privacy() {
  return (
    <main className={`${page.page} ${styles.page}`}>
      <header className={hero.bar}>
        <a href="/" className={hero.name}>
          <Image className={hero.mark} src="/askaboard-mark.svg" width={36} height={20} alt="" />
          {SITE_NAME}
        </a>
        <nav className={hero.links}>
          <a href="/#download" className={hero.link}>
            Download
          </a>
        </nav>
      </header>

      <article className={styles.doc}>
        <h1 className={sections.agentTitle}>Privacy</h1>
        <p className={sections.quiet}>Last updated: 12 November 2026</p>

        <p>
          Askaboard is made by Nordup, an independent developer. This page says what data Askaboard uses, why, and where it goes. Questions or requests: <Email />.
        </p>

        <h2>The web app (app.askaboard.com)</h2>
        <ul>
          <li>
            <strong>Your email address.</strong> You sign in with Google or with a code that we email to you. Supabase keeps your account (your email address and, with Google, your name and picture from Google), in Singapore. Resend sends the code emails.
          </li>
          <li>
            <strong>Bot protection.</strong> Email sign-in uses Cloudflare Turnstile to help prevent abuse. Cloudflare processes information about your device and browser for this check. See the <a href="https://www.cloudflare.com/turnstile-privacy-policy/">Cloudflare Turnstile Privacy Addendum</a>.
          </li>
          <li>
            <strong>Your boards and your chat.</strong> Your boards, the files of your learning folder and your chat with the agent are kept on our server (Hetzner, in the EU), so you can come back to them.
          </li>
          <li>
            <strong>The AI agent.</strong> When you send a message, the agent sends your message, the chat so far, text from your learning folder and pictures of your board to Anthropic, which runs the AI model (Claude). Anthropic uses them to answer and does not train its models on them, as its commercial terms say.
          </li>
          <li>
            <strong>Your free credit.</strong> We record the cost of each agent turn against your account, so we can keep your free credit.
          </li>
          <li>
            <strong>Voice.</strong> When a scene reads its lines aloud, the text of each line goes to Google Gemini to make the audio. We do not keep the text or the audio.
          </li>
        </ul>

        <h2>The desktop app</h2>
        <ul>
          <li>
            <strong>Your files stay on your computer.</strong> The board, your learning folder and your notes are on your own disk. The AI agent that you connect (for example Claude or ChatGPT) works under your own agreement with that company.
          </li>
          <li>
            <strong>Usage data.</strong> The app sends anonymous usage events (for example &quot;a board was made&quot;) to our server, which passes them to PostHog. Your computer&apos;s address is used to find your country and city and is not kept. You can turn this off: set <code>ASKABOARD_TELEMETRY_ENABLED=false</code>.
          </li>
          <li>
            <strong>Voice.</strong> The same as in the web app.
          </li>
        </ul>

        <h2>This website</h2>
        <p>askaboard.com uses no cookies and no analytics. Vercel hosts it and keeps normal server logs.</p>

        <h2>What we do not do</h2>
        <p>We do not sell your data. We do not show ads. We do not use your boards or your chat for anything other than running Askaboard for you.</p>

        <h2>Deleting your data</h2>
        <p>
          Email <Email /> from the address you signed in with, and we delete your account, your boards and your chat.
        </p>

        <h2>Changes</h2>
        <p>If this page changes, the date at the top changes.</p>
      </article>

      <SiteFooter />
    </main>
  )
}
