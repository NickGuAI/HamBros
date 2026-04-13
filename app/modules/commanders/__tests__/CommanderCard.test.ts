import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { CommanderCard } from '../components/CommanderCard'
import type { CommanderCardProps } from '../components/CommanderCard'

function renderCommanderCard(props: CommanderCardProps): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(CommanderCard, props),
    ),
  )
}

function createProps(
  overrides: Partial<CommanderCardProps> = {},
): CommanderCardProps {
  return {
    commander: {
      id: 'commander-1',
      host: 'Athena',
      pid: 123,
      state: 'running',
      created: '2026-04-10T00:00:00.000Z',
      agentType: 'claude',
      heartbeat: {
        intervalMs: 900_000,
        messageTemplate: 'heartbeat',
        lastSentAt: null,
      },
      lastHeartbeat: null,
      taskSource: null,
      currentTask: null,
      completedTasks: 0,
      questCount: 2,
      scheduleCount: 1,
      totalCostUsd: 0,
      ui: null,
      avatarUrl: null,
    },
    onStart: vi.fn(),
    onStop: vi.fn(),
    onTriggerHeartbeat: vi.fn(),
    onOpenChat: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    isStartPending: false,
    isStopPending: false,
    isTriggerHeartbeatPending: false,
    isDeletePending: false,
    ...overrides,
  }
}

describe('CommanderCard', () => {
  it('shows the heartbeat button for running commanders', () => {
    const html = renderCommanderCard(createProps())

    expect(html).toContain('Heartbeat')
    expect(html).not.toContain('Triggering...')
  })

  it('shows the pending heartbeat label while a manual trigger is in flight', () => {
    const html = renderCommanderCard(createProps({
      isTriggerHeartbeatPending: true,
    }))

    expect(html).toContain('Triggering...')
  })

  it('hides the heartbeat button for stopped commanders', () => {
    const baseProps = createProps()
    const html = renderCommanderCard({
      ...baseProps,
      commander: {
        ...baseProps.commander,
        state: 'stopped',
        pid: null,
      },
    })

    expect(html).not.toContain('Heartbeat')
  })
})
