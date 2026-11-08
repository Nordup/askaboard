import type { Metadata, Viewport } from 'next'
import { SITE_NAME } from '@/lib/site'
import './globals.css'

const title = `${SITE_NAME} | A shared canvas for learning with your AI`
const description = 'Your agent explains any topic on a shared board. It draws, animates and talks.'
const siteUrl = process.env.ASKABOARD_SITE_URL
const socialImage = { url: '/askaboard-social.png', width: 1200, height: 630, alt: 'Askaboard: a board with drawings and the words "Ask anything. Learn anything.", and a Claude Code window' }

export const metadata: Metadata = {
  title,
  description,
  // An `icons` field replaces Next's file icon (app/icon.svg), so the tab icon is named here too.
  icons: { icon: { url: '/icon.svg', type: 'image/svg+xml' }, apple: { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' } },
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  openGraph: { title, description, siteName: SITE_NAME, type: 'website', images: siteUrl ? [socialImage] : [] },
  twitter: { card: 'summary_large_image', title, description, images: siteUrl ? [socialImage] : [] }
}

export const viewport: Viewport = {
  themeColor: '#111113',
  width: 'device-width',
  initialScale: 1
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
