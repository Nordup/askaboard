import type { Metadata, Viewport } from 'next'
import { SITE_NAME } from '@/lib/site'
import './globals.css'

export const metadata: Metadata = {
  title: `${SITE_NAME}: learn anything, watch it drawn`,
  description: 'Your agent explains any topic on a shared board. It draws, animates and talks.'
}

export const viewport: Viewport = {
  themeColor: '#161618',
  width: 'device-width',
  initialScale: 1
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* The hand font: the regular cut on sharp screens, the heavy cut below 1.5 dppx (globals.css). */}
        <link rel="preload" href="/fonts/hand.woff2" as="font" type="font/woff2" crossOrigin="" media="(min-resolution: 1.5dppx)" />
        <link rel="preload" href="/fonts/hand-heavy.woff2" as="font" type="font/woff2" crossOrigin="" media="(max-resolution: 1.49dppx)" />
      </head>
      <body>{children}</body>
    </html>
  )
}
