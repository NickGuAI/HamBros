import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  let useStateCallCount = 0
  const mockedUseState = ((initialState: unknown) => {
    useStateCallCount += 1
    if (useStateCallCount === 1) {
      return [true, vi.fn()] as unknown as ReturnType<typeof actual.useState>
    }
    return actual.useState(initialState as never)
  }) as typeof actual.useState

  return {
    ...actual,
    useState: mockedUseState,
  }
})

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
  useQuery: () => ({
    data: [],
    isLoading: false,
    error: null,
  }),
  useMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
}))

import { QuestBoard } from '../components/QuestBoard'

describe('QuestBoard modal form', () => {
  it('renders the extracted quest create form in modal mode', () => {
    const html = renderToStaticMarkup(
      createElement(QuestBoard, {
        commanders: [{
          id: 'commander-1',
          host: 'Athena',
        }],
        selectedCommanderId: 'commander-1',
      }),
    )

    expect(html).toContain('Commander')
    expect(html).toContain('Add Quest')
    expect(html).toContain('Pending')
    expect(html).toContain('Active')
    expect(html).toContain('Done')
    expect(html).toContain('Failed')
    expect(html).toContain('Source')
    expect(html).toContain('Instruction')
    expect(html).toContain('skills (comma-separated)')
    expect(html).toContain('Artifacts')
  })
})
