import type { Metadata, Viewport } from 'next'
import { SITE_NAME } from '@/lib/site'
import './globals.css'

export const metadata: Metadata = {
  title: `${SITE_NAME}: learn anything, watch it drawn`,
  description: 'Your agent explains any topic on a shared board. It draws, animates and talks.'
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
