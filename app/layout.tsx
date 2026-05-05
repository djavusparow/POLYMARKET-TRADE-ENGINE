import type { Metadata, Viewport } from 'next'
import { Inter, Fira_Code } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const firaCode = Fira_Code({ subsets: ['latin'], variable: '--font-mono', weight: ['400', '500', '600', '700'] })

export const metadata: Metadata = {
  title: 'Polytrade AI — Polymarket Auto Trading',
  description: 'AI-powered auto trading platform for Polymarket prediction markets with real-time signals and full auto execution.',
  keywords: ['polymarket', 'prediction markets', 'AI trading', 'auto trading', 'CLOB API', 'trading bot'],
  authors: [{ name: 'Polytrade AI Team' }],
  
  // Canonical URL & Base
  metadataBase: new URL('https://polytrade-ai.com'),
  alternates: {
    canonical: '/',
  },

  // Open Graph
  openGraph: {
    title: 'Polytrade AI — Polymarket Auto Trading',
    description: 'AI-powered auto trading platform for Polymarket prediction markets',
    type: 'website',
    url: '/',
    siteName: 'Polytrade AI',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Polytrade AI Dashboard',
      },
    ],
  },

  // Twitter
  twitter: {
    card: 'summary_large_image',
    title: 'Polytrade AI',
    description: 'AI-powered Polymarket trading',
  },

  // Icons
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },

  // PWA Manifest
  manifest: '/manifest.json',

  // Robots & Security
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
}

export const viewport: Viewport = {
  themeColor: '#0a0f1a',
  colorScheme: 'dark',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark bg-background">
      <body className={`${inter.variable} ${firaCode.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  )
}
