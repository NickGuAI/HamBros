import Link from 'next/link'
import Image from 'next/image'
import { Sidebar, MobileNav } from '../components/Sidebar'

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-ink-border bg-washi-white/80 backdrop-blur-sm sticky top-0 z-50 h-16">
        <div className="max-w-screen-2xl mx-auto px-6 h-full flex items-center justify-between">
          <Link href="/docs" className="flex items-center gap-3">
            <Image src="/docs/logo.png" alt="HamBros" width={28} height={28} />
            <span className="font-display text-lg text-sumi-black">HamBros</span>
            <span className="badge-sumi ml-1">Docs</span>
          </Link>
          <nav className="flex items-center gap-6">
            <a
              href="https://github.com/NickGuAI/HamBros"
              className="text-sm text-sumi-diluted hover:text-sumi-black transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </nav>
        </div>
      </header>

      {/* Body */}
      <div className="max-w-screen-2xl mx-auto flex">
        <Sidebar />
        <main className="flex-1 min-w-0 px-6 lg:px-12 py-10 max-w-3xl">
          <MobileNav />
          <article className="prose prose-sumi max-w-none">
            {children}
          </article>
        </main>
      </div>
    </div>
  )
}
