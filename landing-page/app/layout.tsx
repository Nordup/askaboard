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
  },
  twitter: {
    card: 'summary',
    title: 'Whiteboard AI — A personal tutor on your iPad',
    description: 'Explore ideas, solve problems, and learn with a tutor that follows your work.',
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
