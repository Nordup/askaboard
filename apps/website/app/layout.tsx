import type { Metadata, Viewport } from 'next'
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL, SOCIAL_IMAGE } from '@/lib/site'
import './globals.css'

const title = `${SITE_NAME} | A shared canvas for learning with your AI`
const description = SITE_DESCRIPTION
const socialImage = { url: SOCIAL_IMAGE, width: 1200, height: 630, alt: 'Askaboard: a board with drawings and the words "Ask anything. Learn anything.", and a Claude Code window' }

export const metadata: Metadata = {
  title,
  description,
  // An `icons` field replaces Next's file icon (app/icon.svg), so the tab icon is named here too. Search engines want the raster /favicon.ico (16, 32, 48 px).
  icons: { icon: [{ url: '/favicon.ico', sizes: '48x48' }, { url: '/icon.svg', type: 'image/svg+xml' }], apple: { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' } },
  metadataBase: new URL(SITE_URL),
  // One address for the page: a query (the dev-only ?scene=) still names the home page.
  alternates: { canonical: '/' },
  openGraph: { title, description, url: '/', siteName: SITE_NAME, type: 'website', images: [socialImage] },
  twitter: { card: 'summary_large_image', title, description, images: [socialImage] }
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
