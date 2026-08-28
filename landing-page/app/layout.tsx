import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Whiteboard AI — A personal tutor on your iPad',
  description: 'Explore ideas, solve problems, and learn with a tutor that follows your work.',
  icons: {
    icon: [{ url: '/favicon-candidates/06-supplied-render-rounded.png', type: 'image/png' }],
    shortcut: '/favicon-candidates/06-supplied-render-rounded.png',
    apple: '/favicon-candidates/06-supplied-render-rounded.png',
  },
  openGraph: {
    title: 'Whiteboard AI — A personal tutor on your iPad',
    description: 'Explore ideas, solve problems, and learn with a tutor that follows your work.',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Whiteboard AI — a personal tutor on your iPad',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Whiteboard AI — A personal tutor on your iPad',
    description: 'Explore ideas, solve problems, and learn with a tutor that follows your work.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
