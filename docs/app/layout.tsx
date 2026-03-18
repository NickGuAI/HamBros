import type { Metadata } from 'next'
import { Cormorant_Garamond, Source_Sans_3, JetBrains_Mono } from 'next/font/google'
import './globals.css'

const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  variable: '--font-display',
  display: 'swap',
})

const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
})

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    template: '%s — HamBros Docs',
    default: 'HamBros — Agent Observability Platform',
  },
  description: 'Open-source agent observability platform. Monitor, manage, and orchestrate AI agent sessions with real-time telemetry.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${cormorant.variable} ${sourceSans.variable} ${jetbrains.variable}`}>
      <body className="bg-washi-white text-sumi-gray font-body antialiased">
        {children}
      </body>
    </html>
  )
}
