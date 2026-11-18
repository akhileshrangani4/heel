import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import { Geist_Mono, Inter } from 'next/font/google';
import { siteUrl } from '@/lib/shared';
import './global.css';

const sans = Inter({ subsets: ['latin'], variable: '--font-inter' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'heel: intent-based access control for AI agents', template: '%s | heel' },
  description:
    'heel sits between an agent and everything it touches, holds the credentials, and checks every call against rules on its actual arguments. Open source and self-hosted.',
  icons: {
    icon: [
      { url: '/heel-icon.svg', type: 'image/svg+xml' },
      { url: '/heel-icon-32.png', sizes: '32x32' },
    ],
    apple: '/heel-icon-180.png',
  },
  openGraph: { siteName: 'heel', images: '/heel-icon-512.png' },
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
      </body>
    </html>
  );
}
