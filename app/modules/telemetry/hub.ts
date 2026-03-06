/**
 * TelemetryHub — in-memory session/call aggregator.
 *
 * Extracted from routes.ts so that both the legacy REST endpoints and the new
 * OTEL receiver can share the same hub instance.
 */

import { randomUUID } from 'node:crypto'
import type { NormalizedCall } from './normalizer.js'
import { normalizeLogRecord, normalizeMetricDataPoint } from './normalizer.js'
import {
  TelemetryJsonlStore,
  type OtelLogPayload,
  type OtelMetricPayload,
  type TelemetryHeartbeatRecord,
  type TelemetryIngestRecord,
  type TelemetryStoreEntry,
} from './store.js'

// ---------------------------------------------------------------------------
// Public view types
// ---------------------------------------------------------------------------

export type SessionStatus = 'active' | 'idle' | 'stale' | 'completed'

export interface TelemetrySessionView {
  id: string
  agentName: string
  model: string
  currentTask: string
  status: SessionStatus
  startedAt: string
  lastHeartbeat: string
  totalCost: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  callCount: number
}

export interface TelemetryCallView {
  id: string
  sessionId: string
  timestamp: string
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
  durationMs: number
}

export interface TelemetrySummaryView {
  costToday: number
  costWeek: number
  costMonth: number
  activeSessions: number
  totalSessions: number
  topModels: { model: string; cost: number; calls: number }[]
  topAgents: { agent: string; cost: number; sessions: number }[]
  dailyCosts: { date: string; costUsd: number }[]
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface IngestInput {
  sessionId: string
  agentName: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cost: number
  durationMs: number
  currentTask: string
  timestamp: Date
}

export interface HeartbeatInput {
  sessionId: string
  agentName?: string
  model?: string
  currentTask?: string
  completed: boolean
  timestamp: Date
}

export interface TelemetryHubOptions {
  store: TelemetryJsonlStore
  now?: () => Date
  /** Days to retain JSONL entries. Default: 14. Set to 0 to disable compaction. */
  retentionDays?: number
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface SessionState {
  id: string
  agentName: string
  model: string
  currentTask: string
  startedAt: string
  lastHeartbeat: string
  completedAt?: string
  totalCost: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  callCount: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTIVE_WINDOW_MS = 60_000
const IDLE_WINDOW_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundToMicros(value: number): number {
  return Number(value.toFixed(6))
}

function toUtcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function getSessionStatus(session: SessionState, now: Date): SessionStatus {
  if (session.completedAt) {
    return 'completed'
  }

  const elapsed = now.getTime() - new Date(session.lastHeartbeat).getTime()
  if (elapsed < ACTIVE_WINDOW_MS) {
    return 'active'
  }
  if (elapsed < IDLE_WINDOW_MS) {
    return 'idle'
  }
  return 'stale'
}

function toSessionView(session: SessionState, now: Date): TelemetrySessionView {
  return {
    id: session.id,
    agentName: session.agentName,
    model: session.model,
    currentTask: session.currentTask,
    status: getSessionStatus(session, now),
    startedAt: session.startedAt,
    lastHeartbeat: session.lastHeartbeat,
    totalCost: roundToMicros(session.totalCost),
    totalTokens: session.totalTokens,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    callCount: session.callCount,
  }
}

function startOfToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function startOfWeek(now: Date): Date {
  const today = startOfToday(now)
  const daysSinceMonday = (today.getUTCDay() + 6) % 7
  return new Date(today.getTime() - daysSinceMonday * 24 * 60 * 60_000)
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

// ---------------------------------------------------------------------------
// TelemetryHub
// ---------------------------------------------------------------------------

export class TelemetryHub {
  private readonly sessions = new Map<string, SessionState>()
  private readonly callsBySession = new Map<string, TelemetryCallView[]>()
  private readonly dailyCostByDay = new Map<string, number>()
  private readonly now: () => Date
  private readonly ready: Promise<void>

  constructor(private readonly options: TelemetryHubOptions) {
    this.now = options.now ?? (() => new Date())
    this.ready = this.restoreFromStore()
    // Run compaction after store is restored (non-blocking — does not delay ensureReady())
    void this.ready.then(() => this.runCompaction())
  }

  private runCompaction(): void {
    const retentionDays = this.options.retentionDays ?? 14
    if (retentionDays <= 0) return
    const compact = () =>
      this.options.store.compact(retentionDays).catch((err) => {
        console.warn('[telemetry] compaction failed', err)
      })
    void compact()
    setInterval(() => void compact(), 24 * 60 * 60_000)
  }

  async ensureReady(): Promise<void> {
    await this.ready
  }

  // -----------------------------------------------------------------------
  // Legacy ingest / heartbeat
  // -----------------------------------------------------------------------

  async ingest(input: IngestInput): Promise<TelemetryIngestRecord> {
    await this.ensureReady()

    const record: TelemetryIngestRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      agentName: input.agentName,
      model: input.model,
      provider: input.provider,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cost: input.cost,
      durationMs: input.durationMs,
      currentTask: input.currentTask,
      timestamp: input.timestamp.toISOString(),
    }

    const entry: TelemetryStoreEntry = {
      type: 'ingest',
      recordedAt: this.now().toISOString(),
      payload: record,
    }

    await this.options.store.append(entry)
    this.applyIngestRecord(record)
    return record
  }

  async heartbeat(input: HeartbeatInput): Promise<TelemetryHeartbeatRecord> {
    await this.ensureReady()

    const record: TelemetryHeartbeatRecord = {
      sessionId: input.sessionId,
      agentName: input.agentName,
      model: input.model,
      currentTask: input.currentTask,
      completed: input.completed,
      timestamp: input.timestamp.toISOString(),
    }

    const entry: TelemetryStoreEntry = {
      type: 'heartbeat',
      recordedAt: this.now().toISOString(),
      payload: record,
    }

    await this.options.store.append(entry)
    this.applyHeartbeatRecord(record)
    return record
  }

  // -----------------------------------------------------------------------
  // OTEL ingest (new)
  // -----------------------------------------------------------------------

  async ingestOtelLog(
    logPayload: Omit<OtelLogPayload, 'normalized'>,
    normalized: NormalizedCall,
  ): Promise<void> {
    await this.ensureReady()

    const entry: TelemetryStoreEntry = {
      type: 'otel_log',
      recordedAt: this.now().toISOString(),
      payload: { ...logPayload, normalized },
    }

    await this.options.store.append(entry)
    this.applyNormalizedCall(normalized)
  }

  async ingestOtelMetric(
    metricPayload: Omit<OtelMetricPayload, 'normalized'>,
    normalized: NormalizedCall,
  ): Promise<void> {
    await this.ensureReady()

    const entry: TelemetryStoreEntry = {
      type: 'otel_metric',
      recordedAt: this.now().toISOString(),
      payload: { ...metricPayload, normalized },
    }

    await this.options.store.append(entry)
    this.applyNormalizedCall(normalized)
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  getSessions(now = this.now()): TelemetrySessionView[] {
    return [...this.sessions.values()]
      .map((session) => toSessionView(session, now))
      .sort(
        (left, right) =>
          new Date(right.lastHeartbeat).getTime() -
          new Date(left.lastHeartbeat).getTime(),
      )
  }

  getSessionDetail(
    sessionId: string,
    now = this.now(),
  ): { session: TelemetrySessionView; calls: TelemetryCallView[] } | null {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }

    const calls = (this.callsBySession.get(sessionId) ?? []).slice()
    calls.sort(
      (left, right) =>
        new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
    )

    return {
      session: toSessionView(session, now),
      calls,
    }
  }

  async getSummary(now = this.now()): Promise<TelemetrySummaryView> {
    await this.ensureReady()

    const sessions = this.getSessions(now)
    const calls = [...this.callsBySession.values()].flat()
    const weekStartKey = toUtcDayKey(startOfWeek(now))
    const todayStartKey = toUtcDayKey(startOfToday(now))
    const monthStartKey = toUtcDayKey(startOfMonth(now))

    let costToday = 0
    let costWeek = 0
    let costMonth = 0
    for (const [dayKey, cost] of this.dailyCostByDay.entries()) {
      if (dayKey >= todayStartKey) {
        costToday += cost
      }
      if (dayKey >= weekStartKey) {
        costWeek += cost
      }
      if (dayKey >= monthStartKey) {
        costMonth += cost
      }
    }

    const modelTotals = new Map<string, { model: string; cost: number; calls: number }>()
    for (const call of calls) {
      const currentModel = modelTotals.get(call.model) ?? {
        model: call.model,
        cost: 0,
        calls: 0,
      }

      currentModel.cost += call.cost
      currentModel.calls += 1
      modelTotals.set(call.model, currentModel)
    }

    const topAgentTotals = new Map<
      string,
      { agent: string; cost: number; sessions: number }
    >()
    for (const session of sessions) {
      const current = topAgentTotals.get(session.agentName) ?? {
        agent: session.agentName,
        cost: 0,
        sessions: 0,
      }
      current.cost += session.totalCost
      current.sessions += 1
      topAgentTotals.set(session.agentName, current)
    }

    const topAgents = [...topAgentTotals.values()]
      .map((item) => ({
        ...item,
        cost: roundToMicros(item.cost),
      }))
      .sort((left, right) => right.cost - left.cost)

    const topModels = [...modelTotals.values()]
      .map((item) => ({
        ...item,
        cost: roundToMicros(item.cost),
      }))
      .sort((left, right) => right.cost - left.cost)

    const ninetyDaysAgoKey = toUtcDayKey(new Date(now.getTime() - 90 * 24 * 60 * 60_000))
    const dailyCosts = [...this.dailyCostByDay.entries()]
      .filter(([date]) => date >= ninetyDaysAgoKey)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, costUsd]) => ({ date, costUsd: roundToMicros(costUsd) }))

    return {
      costToday: roundToMicros(costToday),
      costWeek: roundToMicros(costWeek),
      costMonth: roundToMicros(costMonth),
      activeSessions: sessions.filter((session) => session.status === 'active').length,
      totalSessions: sessions.length,
      topModels,
      topAgents,
      dailyCosts,
    }
  }

  // -----------------------------------------------------------------------
  // Internal apply methods
  // -----------------------------------------------------------------------

  private getOrCreateSession(record: {
    sessionId: string
    timestamp: string
    agentName?: string
    model?: string
  }): SessionState {
    const existing = this.sessions.get(record.sessionId)
    if (existing) {
      return existing
    }

    const created: SessionState = {
      id: record.sessionId,
      agentName: record.agentName ?? 'unknown',
      model: record.model ?? 'unknown',
      currentTask: 'Waiting',
      startedAt: record.timestamp,
      lastHeartbeat: record.timestamp,
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      callCount: 0,
    }

    this.sessions.set(record.sessionId, created)
    return created
  }

  private applyIngestRecord(record: TelemetryIngestRecord): void {
    const session = this.getOrCreateSession({
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      agentName: record.agentName,
      model: record.model,
    })

    session.agentName = record.agentName
    session.model = record.model
    session.currentTask = record.currentTask || session.currentTask
    session.lastHeartbeat = record.timestamp
    session.completedAt = undefined
    session.totalCost += record.cost
    session.inputTokens += record.inputTokens
    session.outputTokens += record.outputTokens
    session.totalTokens += record.inputTokens + record.outputTokens
    session.callCount += 1

    const call: TelemetryCallView = {
      id: record.id,
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cost: record.cost,
      durationMs: record.durationMs,
    }

    const calls = this.callsBySession.get(record.sessionId) ?? []
    calls.push(call)
    this.callsBySession.set(record.sessionId, calls)

    if (record.cost > 0) {
      const dayKey = toUtcDayKey(new Date(record.timestamp))
      this.dailyCostByDay.set(dayKey, (this.dailyCostByDay.get(dayKey) ?? 0) + record.cost)
    }
  }

  private applyHeartbeatRecord(record: TelemetryHeartbeatRecord): void {
    const session = this.getOrCreateSession({
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      agentName: record.agentName,
      model: record.model,
    })

    if (record.agentName) {
      session.agentName = record.agentName
    }
    if (record.model) {
      session.model = record.model
    }
    if (record.currentTask) {
      session.currentTask = record.currentTask
    }

    session.lastHeartbeat = record.timestamp
    if (record.completed) {
      session.completedAt = record.timestamp
    } else {
      session.completedAt = undefined
    }
  }

  private applyNormalizedCall(normalized: NormalizedCall): void {
    const hasCostOrTokens =
      normalized.cost > 0 || normalized.inputTokens > 0 || normalized.outputTokens > 0

    const session = this.getOrCreateSession({
      sessionId: normalized.sessionId,
      timestamp: normalized.timestamp,
      agentName: normalized.agentName,
      model: normalized.model,
    })

    session.agentName = normalized.agentName
    if (normalized.model !== 'unknown') {
      session.model = normalized.model
    }
    session.lastHeartbeat = normalized.timestamp
    session.completedAt = undefined

    if (hasCostOrTokens) {
      session.currentTask = normalized.currentTask || session.currentTask
      session.totalCost += normalized.cost
      session.inputTokens += normalized.inputTokens
      session.outputTokens += normalized.outputTokens
      session.totalTokens += normalized.inputTokens + normalized.outputTokens
      session.callCount += 1

      const call: TelemetryCallView = {
        id: normalized.id,
        sessionId: normalized.sessionId,
        timestamp: normalized.timestamp,
        model: normalized.model,
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        cost: normalized.cost,
        durationMs: normalized.durationMs,
      }

      const calls = this.callsBySession.get(normalized.sessionId) ?? []
      calls.push(call)
      this.callsBySession.set(normalized.sessionId, calls)

      if (normalized.cost > 0) {
        const dayKey = toUtcDayKey(new Date(normalized.timestamp))
        this.dailyCostByDay.set(
          dayKey,
          (this.dailyCostByDay.get(dayKey) ?? 0) + normalized.cost,
        )
      }
    }
  }

  // -----------------------------------------------------------------------
  // Restore from store
  // -----------------------------------------------------------------------

  private async restoreFromStore(): Promise<void> {
    for await (const entry of this.options.store.stream()) {
      if (entry.type === 'ingest') {
        this.applyIngestRecord(entry.payload)
      } else if (entry.type === 'heartbeat') {
        this.applyHeartbeatRecord(entry.payload)
      } else if (entry.type === 'otel_log') {
        // Re-normalize from raw fields so normalizer improvements apply to historical data
        const reNormalized = normalizeLogRecord(
          {
            resource: entry.payload.resource,
            eventName: entry.payload.eventName,
            attributes: entry.payload.attributes,
            timestampNano: '0',
            severityText: '',
          },
          new Date(entry.recordedAt),
        )
        this.applyNormalizedCall(reNormalized ?? entry.payload.normalized)
      } else if (entry.type === 'otel_metric') {
        // Re-normalize from raw fields so normalizer improvements apply to historical data
        const reNormalized = normalizeMetricDataPoint(
          {
            resource: entry.payload.resource,
            metricName: entry.payload.metricName,
            attributes: entry.payload.attributes,
            value: entry.payload.value,
            timestampNano: '0',
          },
          new Date(entry.recordedAt),
        )
        this.applyNormalizedCall(reNormalized ?? entry.payload.normalized)
      }
    }
  }
}
