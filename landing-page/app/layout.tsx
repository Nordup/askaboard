import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Learn AI — A learning engine for iPad',
  description: 'Turn a goal into a living study plan, work it out by hand, and let every session adapt to what you learn.',
  openGraph: {
    title: 'Learn AI — A learning engine for iPad',
    description: 'Turn a goal into a living study plan, work it out by hand, and let every session adapt to what you learn.',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Learn AI adapts a study plan around your work.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Learn AI — A learning engine for iPad',
    description: 'Turn a goal into a living study plan, work it out by hand, and let every session adapt to what you learn.',
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
