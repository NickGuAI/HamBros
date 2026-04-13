import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../sentinels/components/SentinelPanel', () => ({
  SentinelPanel: ({
    commanderId,
    showCreateForm,
  }: {
    commanderId: string
    showCreateForm: boolean
  }) => createElement(
    'div',
    {
      'data-testid': 'sentinel-panel',
      'data-commander-id': commanderId,
      'data-show-create-form': String(showCreateForm),
    },
    'SentinelPanel',
  ),
}))

import { CommanderSentinelsTab } from '../components/CommanderSentinelsTab'

describe('CommanderSentinelsTab', () => {
  it('renders the shared sentinel panel for the selected commander', () => {
    const html = renderToStaticMarkup(
      createElement(CommanderSentinelsTab, {
        commander: {
          id: 'commander-1',
          host: 'worker-1',
          pid: null,
          state: 'idle',
          created: '2026-04-11T00:00:00.000Z',
          heartbeat: {
            intervalMs: 900_000,
            messageTemplate: 'Check status',
            lastSentAt: null,
          },
          lastHeartbeat: null,
          taskSource: null,
          currentTask: null,
          completedTasks: 0,
          questCount: 0,
          scheduleCount: 0,
          totalCostUsd: 0,
          effort: 'max',
        },
      }),
    )

    expect(html).toContain('Attached sentinels')
    expect(html).toContain('Scheduled automations scoped to worker-1.')
    expect(html).toContain('Add Sentinel')
    expect(html).toContain('data-commander-id="commander-1"')
    expect(html).toContain('data-show-create-form="false"')
  })
})
