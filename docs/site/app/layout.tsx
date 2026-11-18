import { Analytics } from '@vercel/analytics/next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata, Viewport } from 'next';
import { Geist_Mono, Inter } from 'next/font/google';
import { siteUrl } from '@/lib/shared';
import './global.css';

const sans = Inter({ subsets: ['latin'], variable: '--font-inter' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'heel: access control for your AI agents', template: '%s | heel' },
  description:
    'heel sits between an agent and everything it touches, holds the credentials, and checks every call against rules on its actual arguments. Open source and self-hosted.',
  icons: {
    icon: [
      { url: '/heel-icon.svg', type: 'image/svg+xml' },
      { url: '/heel-icon-32.png', sizes: '32x32' },
    ],
    apple: '/heel-icon-180.png',
  },
  alternates: { canonical: '/' },
  openGraph: { type: 'website', siteName: 'heel', url: '/', locale: 'en_US' },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f5f4' },
    { media: '(prefers-color-scheme: dark)', color: '#111111' },
  ],
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} font-sans`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
        {/* Vercel Web Analytics: page views only, no cookies. */}
        <Analytics />
      </body>
    </html>
  );
}
