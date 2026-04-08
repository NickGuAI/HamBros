import Link from 'next/link'
import Image from 'next/image'
import { ModuleCard } from './components/ModuleCard'

const modules = [
  {
    title: 'Agents Monitor',
    description: 'Live session view with real-time WebSocket streaming, interactive terminal, and message history.',
    href: '/docs/modules/agents',
    icon: '🔍',
  },
  {
    title: 'Commanders',
    description: 'GitHub-backed personas with memory systems, heartbeat monitoring, and quest boards.',
    href: '/docs/modules/commanders',
    icon: '🎖️',
  },
  {
    title: 'Command Room',
    description: 'Cron-based task scheduler with run history, manual triggers, and status tracking.',
    href: '/docs/modules/command-room',
    icon: '🎯',
  },
  {
    title: 'Telemetry Hub',
    description: 'OTLP/HTTP trace and log ingestion with cost tracking and visualization.',
    href: '/docs/modules/telemetry',
    icon: '📡',
  },
  {
    title: 'Factory',
    description: 'Session creation wizard with worktree-based workers and automated git workflow.',
    href: '/docs/modules/factory',
    icon: '🏭',
  },
  {
    title: 'Services Manager',
    description: 'API key management, encrypted storage, and service configuration.',
    href: '/docs/modules/services',
    icon: '⚙️',
  },
  {
    title: 'Settings',
    description: 'Auth configuration, encryption management, and module toggle controls.',
    href: '/docs/modules/services',
    icon: '🔧',
  },
]

export default function HomePage() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-ink-border bg-washi-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <Image src="/logo.png" alt="HamBros" width={32} height={32} />
            <span className="font-display text-xl text-sumi-black">HamBros</span>
          </Link>
          <nav className="flex items-center gap-6">
            <Link href="/docs" className="text-sm text-sumi-diluted hover:text-sumi-black transition-colors">
              Docs
            </Link>
            <Link href="/docs/api" className="text-sm text-sumi-diluted hover:text-sumi-black transition-colors">
              API
            </Link>
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

      {/* Hero */}
      <section className="py-24 md:py-32">
        <div className="max-w-6xl mx-auto px-6 text-center">
          <p className="section-title mb-4">Source-Available</p>
          <h1 className="font-display text-5xl md:text-6xl text-sumi-black mb-6 leading-tight">
            Agent Observability<br />Platform
          </h1>
          <p className="text-lg text-sumi-diluted max-w-2xl mx-auto mb-10 leading-airy">
            Monitor, manage, and orchestrate AI agent sessions with real-time telemetry,
            commander personas, and a unified command room.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Link href="/docs/getting-started" className="btn-primary">
              Get Started
            </Link>
            <Link href="/docs/api" className="btn-ghost">
              API Reference
            </Link>
          </div>
        </div>
      </section>

      {/* Divider */}
      <div className="divider-ink max-w-6xl mx-auto" />

      {/* Modules grid */}
      <section className="py-20">
        <div className="max-w-6xl mx-auto px-6">
          <p className="section-title mb-3 text-center">Core Modules</p>
          <h2 className="font-display text-display text-sumi-black text-center mb-12">
            Everything you need to run agents
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {modules.map((mod) => (
              <ModuleCard key={mod.title} {...mod} />
            ))}
          </div>
        </div>
      </section>

      {/* Quick start teaser */}
      <section className="py-20 bg-washi-aged">
        <div className="max-w-3xl mx-auto px-6">
          <p className="section-title mb-3 text-center">Quick Start</p>
          <h2 className="font-display text-display text-sumi-black text-center mb-8">
            Up and running in minutes
          </h2>
          <div className="card-sumi p-6 font-mono text-sm leading-loose bg-sumi-black text-washi-white border-none">
            <p className="text-sumi-mist"># Install or upgrade HamBros</p>
            <p>curl -fsSL https://raw.githubusercontent.com/NickGuAI/HamBros/main/install.sh | bash</p>
            <p className="mt-3 text-sumi-mist"># Configure your local instance</p>
            <p>hambros init</p>
            <p className="mt-3 text-sumi-mist"># Start the dashboard</p>
            <p>hambros start</p>
          </div>
          <p className="mt-4 text-sm text-sumi-diluted text-center leading-relaxed">
            The installer uses <code>~/.hambros</code> by default, adds the <code>hambros</code> CLI to your path,
            and serves the built UI from <code>http://localhost:20001</code>.
          </p>
          <div className="text-center mt-8">
            <Link href="/docs/getting-started/installation" className="btn-ghost text-sm">
              Full installation guide
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-ink-border py-12">
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm text-sumi-diluted">
            HamBros — source-available agent observability
          </p>
          <div className="flex items-center gap-6">
            <a
              href="https://github.com/NickGuAI/HamBros"
              className="text-sm text-sumi-diluted hover:text-sumi-black transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <span className="text-sumi-mist">PolyForm Noncommercial 1.0.0</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
