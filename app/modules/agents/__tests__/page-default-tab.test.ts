import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentSession } from '@/types'

const mocks = vi.hoisted(() => ({
  useAgentSessions: vi.fn(),
  useMachines: vi.fn(),
}))

vi.mock('@/hooks/use-agents', () => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
  useAgentSessions: mocks.useAgentSessions,
  useMachines: mocks.useMachines,
}))

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {},
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {},
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))
vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {},
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {},
}))
vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {},
}))
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {},
}))

import AgentsPage from '../page'

function renderAgentsPageHtml(): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, null, createElement(AgentsPage)),
    ),
  )
}

describe('AgentsPage default session tab', () => {
  it('defaults to commander and shows commander sessions on initial render', () => {
    const sessions: AgentSession[] = [
      {
        name: 'commander-alpha',
        created: '2026-03-09T00:00:00.000Z',
        pid: 101,
        sessionType: 'pty',
        agentType: 'claude',
      },
      {
        name: 'worker-beta',
        created: '2026-03-09T00:00:00.000Z',
        pid: 102,
        sessionType: 'pty',
        agentType: 'claude',
      },
    ]

    mocks.useAgentSessions.mockReturnValue({
      data: sessions,
      isLoading: false,
    })
    mocks.useMachines.mockReturnValue({
      data: [],
      isLoading: false,
    })

    const html = renderAgentsPageHtml()

    expect(html).toMatch(
      /class="[^"]*badge-sumi capitalize transition-colors[^"]*bg-sumi-black text-white[^"]*"[^>]*>commander<\/button>/,
    )
    expect(html).toMatch(
      /class="[^"]*badge-sumi capitalize transition-colors[^"]*hover:bg-washi-shadow[^"]*"[^>]*>regular<\/button>/,
    )
    expect(html).toContain('commander-alpha')
    expect(html).not.toContain('worker-beta')
  })
})
