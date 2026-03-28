import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => ({
  useMachines: vi.fn(),
  useDirectories: vi.fn(),
  useSkills: vi.fn(),
}))

vi.mock('@/hooks/use-agents', () => ({
  useMachines: mocks.useMachines,
  useDirectories: mocks.useDirectories,
}))

vi.mock('@/hooks/use-skills', () => ({
  useSkills: mocks.useSkills,
}))

import { TaskList } from '../components/TaskList'

describe('TaskList modal form', () => {
  it('renders a New Task button that calls onNewTask', () => {
    mocks.useMachines.mockReturnValue({
      data: [],
      isLoading: false,
    })

    const html = renderToStaticMarkup(
      createElement(TaskList, {
        tasks: [],
        selectedTaskId: null,
        onSelect: vi.fn(),
        onNewTask: vi.fn(),
        onToggle: vi.fn(async () => undefined),
        onDelete: vi.fn(async () => undefined),
        onRunNow: vi.fn(async () => undefined),
        updateTaskId: null,
        deleteTaskId: null,
        triggerTaskId: null,
        loading: false,
      }),
    )

    expect(html).toContain('New Task')
    expect(html).toContain('No cron tasks created yet.')
  })
})
