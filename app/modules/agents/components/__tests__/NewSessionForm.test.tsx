import { createElement, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentSession } from '@/types'

vi.mock('@/hooks/use-agents', () => ({
  useDirectories: vi.fn(() => ({ data: undefined })),
}))

import { NewSessionForm } from '../NewSessionForm'

function renderNewSessionFormHtml(props: Partial<ComponentProps<typeof NewSessionForm>> = {}): string {
  return renderToStaticMarkup(
    createElement(NewSessionForm, {
      cwd: '',
      setCwd: vi.fn(),
      mode: 'default',
      setMode: vi.fn(),
      task: '',
      setTask: vi.fn(),
      agentType: 'claude',
      setAgentType: vi.fn(),
      sessionType: 'stream',
      setSessionType: vi.fn(),
      machines: [],
      selectedHost: '',
      setSelectedHost: vi.fn(),
      isCreating: false,
      createError: null,
      onSubmit: vi.fn(),
      ...props,
    }),
  )
}

describe('NewSessionForm resume source selector', () => {
  it('shows resumable sources and locks the workspace fields to the selected source', () => {
    const resumeSource: AgentSession = {
      name: 'claude-source',
      created: '2026-04-07T00:00:00.000Z',
      pid: 0,
      sessionType: 'stream',
      agentType: 'claude',
      cwd: '/home/ec2-user/App/apps/hammurabi',
      processAlive: false,
      status: 'exited',
      resumeAvailable: true,
    }

    const html = renderNewSessionFormHtml({
      resumeOptions: [resumeSource],
      resumeSourceName: 'claude-source',
      setResumeSourceName: vi.fn(),
      resumeSource,
      cwd: '/home/ec2-user/App/apps/hammurabi',
      setCwd: vi.fn(),
    })

    expect(html).toContain('Resume From Previous Session')
    expect(html).toContain('claude-source · claude · exited')
    expect(html).toContain('Machine: Local (this server)')
    expect(html).toContain('Workspace: /home/ec2-user/App/apps/hammurabi')
    expect(html).toContain('Agent, session type, machine, and workspace are locked to the selected source.')
    expect(html).not.toContain('Browse directories')
  })
})
