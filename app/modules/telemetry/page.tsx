import { useState } from 'react'
import {
  BarChart3,
  DollarSign,
  Zap,
  Clock,
  ArrowLeft,
  Circle,
  Trash2,
} from 'lucide-react'
import {
  ComposedChart,
  Area,
  AreaChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import {
  useTelemetrySessions,
  useTelemetrySessionDetail,
  useTelemetrySummary,
} from '@/hooks/use-telemetry'
import { fetchJson } from '@/lib/api'
import { timeAgo, formatCost, formatTokens, cn } from '@/lib/utils'
import type { SessionStatus, TelemetrySession } from '@/types'

const RETENTION_STORAGE_KEY = 'hammurabi:telemetry:retentionDays'
const DEFAULT_RETENTION_DAYS = 14

function getStoredRetentionDays(): number {
  try {
    const raw = localStorage.getItem(RETENTION_STORAGE_KEY)
    if (raw) {
      const parsed = Number.parseInt(raw, 10)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
  } catch {
    // ignore
  }
  return DEFAULT_RETENTION_DAYS
}

type TrendPeriod = '7d' | '30d' | '90d'

const PERIOD_DAYS: Record<TrendPeriod, number> = { '7d': 7, '30d': 30, '90d': 90 }

function CostTrendChart({
  dailyCosts,
}: {
  dailyCosts: { date: string; costUsd: number }[]
}) {
  const [period, setPeriod] = useState<TrendPeriod>('30d')
  const [retentionDays, setRetentionDays] = useState(getStoredRetentionDays)
  const [compacting, setCompacting] = useState(false)
  const [compactMsg, setCompactMsg] = useState<string | null>(null)

  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - PERIOD_DAYS[period])
  const cutoffKey = cutoff.toISOString().slice(0, 10)

  const chartData = dailyCosts
    .filter((d) => d.date >= cutoffKey)
    .map((d) => ({
      date: d.date,
      cost: d.costUsd,
    }))

  async function handleCompact() {
    setCompacting(true)
    setCompactMsg(null)
    try {
      localStorage.setItem(RETENTION_STORAGE_KEY, String(retentionDays))
      await fetchJson('/api/telemetry/compact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays }),
      })
      setCompactMsg(`Compacted — entries older than ${retentionDays} days removed.`)
    } catch {
      setCompactMsg('Compaction failed.')
    } finally {
      setCompacting(false)
    }
  }

  return (
    <div className="card-sumi p-5">
      <div className="flex items-center justify-between mb-4">
        <h4 className="section-title">Cost over time</h4>
        <div className="flex items-center gap-1">
          {(['7d', '30d', '90d'] as TrendPeriod[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                'badge-sumi text-[10px] cursor-pointer transition-colors',
                period === p ? 'bg-sumi-black text-white' : 'hover:bg-washi-shadow',
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1C1C1C" stopOpacity={0.15} />
                <stop offset="100%" stopColor="#1C1C1C" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: '#8B8B8B' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#8B8B8B' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            />
            <Tooltip
              formatter={(value: number) => [formatCost(value), 'Cost']}
              contentStyle={{
                background: '#FAF8F5',
                border: '1px solid rgba(28,28,28,0.06)',
                borderRadius: '4px 12px 4px 12px',
                fontSize: 12,
              }}
            />
            <Area
              type="monotone"
              dataKey="cost"
              stroke="#1C1C1C"
              strokeWidth={1.5}
              fill="url(#trendGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Retention management */}
      <div className="mt-4 pt-4 border-t border-ink-border flex flex-wrap items-center gap-3">
        <span className="text-xs text-sumi-diluted">Retention:</span>
        <input
          type="number"
          min={1}
          max={365}
          value={retentionDays}
          onChange={(e) => {
            const v = Number.parseInt(e.target.value, 10)
            if (v > 0) {
              setRetentionDays(v)
              try { localStorage.setItem(RETENTION_STORAGE_KEY, String(v)) } catch { /* ignore */ }
            }
          }}
          className="w-16 text-xs px-2 py-1 rounded border border-ink-border bg-washi-aged/40 text-sumi-black text-center"
        />
        <span className="text-xs text-sumi-diluted">days</span>
        <button
          onClick={() => void handleCompact()}
          disabled={compacting}
          className="btn-ghost inline-flex items-center gap-1.5 text-xs"
        >
          <Trash2 size={12} />
          {compacting ? 'Compacting…' : 'Compact now'}
        </button>
        {compactMsg && <span className="text-xs text-sumi-diluted">{compactMsg}</span>}
      </div>
    </div>
  )
}

const STATUS_CLASSES: Record<SessionStatus, string> = {
  active: 'badge-active',
  idle: 'badge-idle',
  stale: 'badge-stale',
  completed: 'badge-completed',
}

const PIE_COLORS = ['#1C1C1C', '#4A4A4A', '#8B8B8B', '#C4C4C4']

function SummaryCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: React.ComponentType<{ size?: number | string; className?: string }>
}) {
  return (
    <div className="card-sumi p-5">
      <div className="flex items-center gap-2 mb-3">
        <Icon size={14} className="text-sumi-diluted" />
        <span className="section-title text-xs">{label}</span>
      </div>
      <p className="font-display text-heading text-sumi-black">{value}</p>
    </div>
  )
}

function SessionRow({
  session,
  onSelect,
}: {
  session: TelemetrySession
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className="w-full text-left card-sumi p-4 md:p-5 transition-all duration-300 ease-gentle"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-sumi-black truncate">
              {session.agentName}
            </span>
            <span className={cn('badge-sumi shrink-0', STATUS_CLASSES[session.status])}>
              {session.status}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-sumi-diluted leading-relaxed">
            {session.currentTask}
          </p>
          <p className="mt-1 text-whisper text-sumi-mist font-mono truncate">
            {session.id}
          </p>
        </div>
        <div className="sm:text-right shrink-0">
          <p className="font-mono text-sm text-sumi-black">
            {formatCost(session.totalCost)}
          </p>
          <p className="text-whisper text-sumi-mist mt-1">
            {formatTokens(session.totalTokens)} tokens
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 md:gap-4 text-whisper text-sumi-diluted">
        <span className="flex items-center gap-1.5">
          <Circle
            size={6}
            className={cn(
              'fill-current',
              session.status === 'active'
                ? 'text-accent-moss'
                : session.status === 'idle'
                  ? 'text-accent-persimmon'
                  : session.status === 'stale'
                    ? 'text-accent-vermillion'
                    : 'text-sumi-mist',
            )}
          />
          {timeAgo(session.lastHeartbeat)}
        </span>
        <span>{session.model}</span>
        <span>{session.callCount} calls</span>
      </div>
    </button>
  )
}

function SessionDetail({
  sessionId,
  onBack,
}: {
  sessionId: string
  onBack: () => void
}) {
  const { data, isLoading } = useTelemetrySessionDetail(sessionId)

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
      </div>
    )
  }

  const { session, calls } = data

  const chartData = calls.map((c) => ({
    time: new Date(c.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
    cost: c.cost,
    tokens: c.inputTokens + c.outputTokens,
  }))

  return (
    <div className="animate-fade-in">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-sumi-diluted hover:text-sumi-black transition-colors mb-6"
      >
        <ArrowLeft size={16} />
        Back to sessions
      </button>

      {/* Session header */}
      <div className="flex flex-col gap-4 mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="font-display text-heading text-sumi-black">
              {session.agentName}
            </h3>
            <span className={cn('badge-sumi', STATUS_CLASSES[session.status])}>
              {session.status}
            </span>
          </div>
          <p className="mt-1 text-sm text-sumi-diluted">{session.currentTask}</p>
          <p className="mt-1 text-whisper text-sumi-mist">
            {session.model} &middot; started {timeAgo(session.startedAt)}
          </p>
        </div>
        <div className="sm:text-right">
          <p className="font-display text-heading text-sumi-black">
            {formatCost(session.totalCost)}
          </p>
          <p className="text-sm text-sumi-diluted">
            {formatTokens(session.totalTokens)} tokens
          </p>
        </div>
      </div>

      {/* Cost chart */}
      <div className="mb-8">
        <h4 className="section-title mb-4">Cost and tokens per call</h4>
        <div className="card-sumi p-4 h-48">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData}>
              <defs>
                <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#1C1C1C" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#1C1C1C" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="time"
                tick={{ fontSize: 11, fill: '#8B8B8B' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                yAxisId="cost"
                tick={{ fontSize: 11, fill: '#8B8B8B' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              />
              <YAxis
                yAxisId="tokens"
                orientation="right"
                tick={{ fontSize: 11, fill: '#8B8B8B' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => formatTokens(v)}
              />
              <Tooltip
                contentStyle={{
                  background: '#FAF8F5',
                  border: '1px solid rgba(28,28,28,0.06)',
                  borderRadius: '4px 12px 4px 12px',
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="cost"
                yAxisId="cost"
                stroke="#1C1C1C"
                strokeWidth={1.5}
                fill="url(#costGradient)"
              />
              <Line
                type="monotone"
                dataKey="tokens"
                yAxisId="tokens"
                stroke="#8B8B8B"
                strokeWidth={1.2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Call history */}
      <div>
        <h4 className="section-title mb-4">Call history</h4>
        <div className="space-y-2">
          {calls.map((call) => (
            <div
              key={call.id}
              className="flex flex-col gap-1 px-4 py-3 rounded-lg bg-washi-aged/50 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="flex items-center gap-4">
                <span className="font-mono text-whisper text-sumi-diluted w-16">
                  {new Date(call.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="text-sumi-gray">{call.model}</span>
              </div>
              <div className="flex items-center gap-4 sm:gap-6 text-sumi-diluted">
                <span>{formatTokens(call.inputTokens + call.outputTokens)}</span>
                <span className="font-mono text-sumi-black">
                  {formatCost(call.cost)}
                </span>
                <span className="text-whisper">
                  {(call.durationMs / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function GlobalSummary() {
  const { data: summary, isLoading } = useTelemetrySummary()

  if (isLoading || !summary) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
      </div>
    )
  }

  const modelPieData = summary.topModels.map((m) => ({
    name: m.model,
    value: m.cost,
  }))

  return (
    <div className="space-y-6 mb-8">
      {/* Cost summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <SummaryCard label="Today" value={formatCost(summary.costToday)} icon={DollarSign} />
        <SummaryCard label="This week" value={formatCost(summary.costWeek)} icon={DollarSign} />
        <SummaryCard label="This month" value={formatCost(summary.costMonth)} icon={DollarSign} />
        <SummaryCard
          label="Active"
          value={`${summary.activeSessions} / ${summary.totalSessions}`}
          icon={Zap}
        />
      </div>

      {/* Cost trend chart */}
      <CostTrendChart dailyCosts={summary.dailyCosts} />

      {/* Model breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card-sumi p-5">
          <h4 className="section-title mb-4">Cost by model</h4>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={modelPieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={35}
                  outerRadius={60}
                  dataKey="value"
                  stroke="none"
                >
                  {modelPieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => formatCost(value)}
                  contentStyle={{
                    background: '#FAF8F5',
                    border: '1px solid rgba(28,28,28,0.06)',
                    borderRadius: '4px 12px 4px 12px',
                    fontSize: 12,
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 space-y-1.5">
            {summary.topModels.map((m, i) => (
              <div key={m.model} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
                  />
                  <span className="text-sumi-gray font-mono">{m.model}</span>
                </div>
                <span className="text-sumi-diluted">{formatCost(m.cost)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card-sumi p-5">
          <h4 className="section-title mb-4">Top agents</h4>
          <div className="space-y-3 mt-6">
            {summary.topAgents.map((a) => {
              const maxCost = summary.topAgents[0]?.cost ?? 1
              const width = (a.cost / maxCost) * 100
              return (
                <div key={a.agent}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-mono text-sumi-gray">{a.agent}</span>
                    <span className="text-sumi-diluted">
                      {formatCost(a.cost)} &middot; {a.sessions} sessions
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-washi-shadow overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500 ease-gentle"
                      style={{
                        width: `${width}%`,
                        background: 'linear-gradient(90deg, #8B8B8B, #1C1C1C)',
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function TelemetryPage() {
  const { data: sessions, isLoading } = useTelemetrySessions()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  return (
    <div className="px-4 py-6 md:px-8 md:py-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h2 className="font-display text-display text-sumi-black">Telemetry</h2>
        <p className="mt-2 text-sm text-sumi-diluted leading-relaxed">
          Cost tracking and usage metrics across all AI agents
        </p>
      </div>

      {selectedId ? (
        <SessionDetail sessionId={selectedId} onBack={() => setSelectedId(null)} />
      ) : (
        <>
          <GlobalSummary />

          {/* Sessions list */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="section-title">Sessions</h3>
              <span className="text-whisper text-sumi-mist flex items-center gap-1.5">
                <Clock size={12} />
                auto-refreshing
              </span>
            </div>

            <div className="space-y-3">
              {isLoading ? (
                <div className="flex justify-center py-12">
                  <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
                </div>
              ) : sessions?.length === 0 ? (
                <div className="text-center py-12 text-sumi-diluted text-sm">
                  No telemetry sessions yet
                </div>
              ) : (
                sessions?.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    onSelect={() => setSelectedId(session.id)}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
