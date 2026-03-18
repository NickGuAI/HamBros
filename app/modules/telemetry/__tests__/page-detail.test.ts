import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const summaryData = {
  costToday: 0.5,
  costWeek: 2,
  costMonth: 4,
  inputTokensToday: 200,
  inputTokensWeek: 500,
  inputTokensMonth: 1000,
  outputTokensToday: 100,
  outputTokensWeek: 300,
  outputTokensMonth: 600,
  totalTokensToday: 300,
  totalTokensWeek: 800,
  totalTokensMonth: 1600,
  activeSessions: 1,
  totalSessions: 1,
  topModels: [{ model: 'o3', cost: 4, calls: 2 }],
  topAgents: [{ agent: 'codex', cost: 4, sessions: 1 }],
  dailyCosts: [{ date: '2026-02-10', costUsd: 2 }],
}

const detailData = {
  session: {
    id: 'session-1',
    agentName: 'codex',
    model: 'o3',
    currentTask: 'Token split rendering',
    status: 'active' as const,
    startedAt: '2026-02-10T09:00:00.000Z',
    lastHeartbeat: '2026-02-10T10:00:00.000Z',
    totalCost: 2,
    totalTokens: 12,
    inputTokens: 5,
    outputTokens: 7,
    callCount: 1,
  },
  calls: [
    {
      id: 'call-1',
      sessionId: 'session-1',
      timestamp: '2026-02-10T10:00:00.000Z',
      model: 'o3',
      inputTokens: 5,
      outputTokens: 7,
      cost: 0.42,
      durationMs: 1200,
    },
  ],
}

vi.mock('@/hooks/use-telemetry', () => ({
  useTelemetrySessions: () => ({ data: [detailData.session], isLoading: false }),
  useTelemetrySessionDetail: (sessionId: string | null) => ({
    data: sessionId ? detailData : null,
    isLoading: false,
  }),
  useTelemetrySummary: () => ({ data: summaryData, isLoading: false }),
}))

vi.mock('recharts', async () => {
  const React = await import('react')
  const Mock = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children)

  return {
    ComposedChart: Mock,
    Area: Mock,
    AreaChart: Mock,
    Line: Mock,
    PieChart: Mock,
    Pie: Mock,
    Cell: Mock,
    XAxis: Mock,
    YAxis: Mock,
    Tooltip: Mock,
    ResponsiveContainer: Mock,
  }
})

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  let hookCallCount = 0

  const mockedUseState = ((initialState: unknown) => {
    hookCallCount += 1
    if (hookCallCount === 1) {
      return ['session-1', vi.fn()] as unknown as ReturnType<typeof actual.useState>
    }
    return actual.useState(initialState as never)
  }) as typeof actual.useState

  return {
    ...actual,
    useState: mockedUseState,
  }
})

describe('TelemetryPage session detail token rendering', () => {
  it('renders session-detail and call-level input/output token split', async () => {
    const React = await import('react')
    const { default: TelemetryPage } = await import('../page')
    const html = renderToStaticMarkup(React.createElement(TelemetryPage))

    expect(html).toContain('Cost and input/output tokens per call')
    expect(html).toContain('5 in / 7 out')
    expect(html).toContain('12 total')
  })
})
