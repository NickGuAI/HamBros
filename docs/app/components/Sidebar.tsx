'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface NavItem {
  title: string
  href: string
  children?: NavItem[]
}

const navigation: NavItem[] = [
  {
    title: 'Getting Started',
    href: '/docs/docs/getting-started',
    children: [
      { title: 'Installation', href: '/docs/docs/getting-started/installation' },
      { title: 'Configuration', href: '/docs/docs/getting-started/configuration' },
      { title: 'First Agent Session', href: '/docs/docs/getting-started/first-agent' },
    ],
  },
  {
    title: 'Modules',
    href: '/docs/docs/modules/agents',
    children: [
      { title: 'Agents Monitor', href: '/docs/docs/modules/agents' },
      { title: 'Commanders', href: '/docs/docs/modules/commanders' },
      { title: 'Command Room', href: '/docs/docs/modules/command-room' },
      { title: 'Telemetry Hub', href: '/docs/docs/modules/telemetry' },
      { title: 'Factory', href: '/docs/docs/modules/factory' },
      { title: 'Services', href: '/docs/docs/modules/services' },
    ],
  },
  {
    title: 'API Reference',
    href: '/docs/docs/api',
    children: [
      { title: 'Agents API', href: '/docs/docs/api/agents' },
      { title: 'Commanders API', href: '/docs/docs/api/commanders' },
      { title: 'Command Room API', href: '/docs/docs/api/command-room' },
      { title: 'Telemetry API', href: '/docs/docs/api/telemetry' },
      { title: 'Authentication', href: '/docs/docs/api/authentication' },
    ],
  },
  {
    title: 'CLI Reference',
    href: '/docs/docs/cli',
  },
  {
    title: 'Deployment',
    href: '/docs/docs/deployment',
    children: [
      { title: 'iOS / Capacitor', href: '/docs/docs/deployment/ios' },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <nav className="w-64 shrink-0 border-r border-ink-border h-[calc(100vh-64px)] sticky top-16 overflow-y-auto py-8 px-6 hidden lg:block">
      <ul className="space-y-6">
        {navigation.map((section) => (
          <li key={section.href}>
            <Link
              href={section.href}
              className={`section-title block mb-2 hover:text-sumi-gray transition-colors ${
                pathname === section.href ? 'text-sumi-black' : ''
              }`}
            >
              {section.title}
            </Link>
            {section.children && (
              <ul className="space-y-1 ml-1">
                {section.children.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`block py-1.5 px-3 text-sm transition-colors rounded ${
                        pathname === item.href
                          ? 'text-sumi-black bg-ink-focus font-medium'
                          : 'text-sumi-diluted hover:text-sumi-gray hover:bg-ink-wash'
                      }`}
                    >
                      {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function MobileNav() {
  const pathname = usePathname()

  return (
    <details className="lg:hidden mb-6">
      <summary className="btn-ghost cursor-pointer text-sm">Navigation</summary>
      <nav className="mt-4 p-4 card-sumi">
        <ul className="space-y-4">
          {navigation.map((section) => (
            <li key={section.href}>
              <span className="section-title block mb-1">{section.title}</span>
              <ul className="space-y-1 ml-1">
                {section.children?.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`block py-1 px-2 text-sm rounded ${
                        pathname === item.href
                          ? 'text-sumi-black bg-ink-focus font-medium'
                          : 'text-sumi-diluted hover:text-sumi-gray'
                      }`}
                    >
                      {item.title}
                    </Link>
                  </li>
                )) ?? (
                  <li>
                    <Link
                      href={section.href}
                      className={`block py-1 px-2 text-sm rounded ${
                        pathname === section.href
                          ? 'text-sumi-black bg-ink-focus font-medium'
                          : 'text-sumi-diluted hover:text-sumi-gray'
                      }`}
                    >
                      View
                    </Link>
                  </li>
                )}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  )
}
