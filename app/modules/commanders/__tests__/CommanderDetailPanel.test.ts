import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../components/QuestBoard', () => ({
  QuestBoard: () => createElement('div', null, 'QuestBoard'),
}))

vi.mock('../components/CommanderSentinelsTab', () => ({
  CommanderSentinelsTab: () => createElement('div', null, 'CommanderSentinelsTab'),
}))

vi.mock('../components/CommanderCronTab', () => ({
  CommanderCronTab: () => createElement('div', null, 'CommanderCronTab'),
}))

vi.mock('../components/CommanderIdentityTab', () => ({
  CommanderIdentityTab: () => createElement('div', null, 'CommanderIdentityTab'),
}))

import { CommanderDetailPanel } from '../components/CommanderDetailPanel'

describe('CommanderDetailPanel', () => {
  it('renders the Commander identity tab when identity is selected', () => {
    const html = renderToStaticMarkup(
      createElement(CommanderDetailPanel, {
        commander: {
          id: 'commander-1',
          host: 'worker-1',
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
        activeTab: 'identity',
        onTabChange: vi.fn(),
        onBack: vi.fn(),
        commanderOptions: [
          { id: 'commander-1', label: 'worker-1' },
          { id: 'commander-2', label: 'worker-2' },
        ],
        onSelectCommander: vi.fn(),
        crons: [],
        cronsLoading: false,
        cronsError: null,
        addCron: vi.fn(),
        addCronPending: false,
        toggleCron: vi.fn(),
        toggleCronPending: false,
        deleteCron: vi.fn(),
        deleteCronPending: false,
      }),
    )

    expect(html).toContain('CommanderIdentityTab')
    expect(html).not.toContain('CommanderCronTab')
    expect(html).not.toContain('QuestBoard')
  })

  it('renders a mobile commander dropdown for switching sessions', () => {
    const html = renderToStaticMarkup(
      createElement(CommanderDetailPanel, {
        commander: {
          id: 'commander-2',
          host: 'worker-2',
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
        activeTab: 'quests',
        onTabChange: vi.fn(),
        onBack: vi.fn(),
        commanderOptions: [
          { id: 'commander-1', label: 'worker-1' },
          { id: 'commander-2', label: 'worker-2' },
        ],
        onSelectCommander: vi.fn(),
        crons: [],
        cronsLoading: false,
        cronsError: null,
        addCron: vi.fn(),
        addCronPending: false,
        toggleCron: vi.fn(),
        toggleCronPending: false,
        deleteCron: vi.fn(),
        deleteCronPending: false,
      }),
    )

    expect(html).toContain('Select commander')
    expect(html).toContain('option value="commander-1"')
    expect(html).toContain('option value="commander-2" selected=""')
  })
})
