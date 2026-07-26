import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { appendFileDurably } from '../durable-file.js'
import { extractTranscriptUsageUpdate } from '../agents/transcript-records.js'
import type { StreamJsonEvent } from '../agents/types.js'
import type { CommanderSessionStore } from './store.js'
import { withCommanderMutation } from './child-mutation-coordinator.js'

export const COMMANDER_COST_CAP_WINDOW = 'calendar_month_utc'
const COST_LEDGER_FILE = 'cost-ledger.jsonl'
const MAX_COST_LEDGER_LINE_LENGTH = 8 * 1024 * 1024

interface MonthWindow {
  startMs: number
  endMs: number
}

interface CommanderCostConversationReader {
  listByCommander(commanderId: string): Promise<Array<{
    id: string
    commanderId: string
  }>>
}

interface CommanderCostLiveSessionReader {
  getSession(name: string): {
    createdAt?: string
    events?: StreamJsonEvent[]
    usage?: {
      costUsd?: number
    }
  } | undefined
}

export interface CommanderCostRecord {
  commanderId: string
  conversationId: string
  costUsd: number
  occurredAt: string
}

export interface CommanderCostContext {
  commanderDataDir: string
  now: () => Date
  sessionStore: Pick<CommanderSessionStore, 'get'>
  conversationStore?: CommanderCostConversationReader
  sessionsInterface?: CommanderCostLiveSessionReader
}

export interface CommanderCostCapBlockPayload {
  error: string
  reason: 'budget_blocked'
  commanderId: string
  costCapUsd: number
  monthlyCostUsd: number
  window: typeof COMMANDER_COST_CAP_WINDOW
}

export type CommanderCostCapGateResult =
  | { ok: true; costCapUsd: number | null; monthlyCostUsd: number }
  | { ok: false; status: 404; body: { error: string } }
  | { ok: false; status: 402; body: CommanderCostCapBlockPayload }

function resolveCommanderCostLedgerPath(dataDir: string, commanderId: string): string {
  return path.join(path.resolve(dataDir), encodeURIComponent(commanderId), COST_LEDGER_FILE)
}

function buildConversationSessionName(commanderId: string, conversationId: string): string {
  return `commander-${commanderId}-conversation-${conversationId}`
}

function utcMonthWindow(now: Date): MonthWindow {
  return {
    startMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    endMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  }
}

function isInWindow(timestampMs: number, window: MonthWindow): boolean {
  return timestampMs >= window.startMs && timestampMs < window.endMs
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  const timestampMs = Date.parse(value)
  return Number.isFinite(timestampMs) ? timestampMs : null
}

function readStreamEventTimestampMs(event: StreamJsonEvent): number | null {
  const raw = event as { time?: unknown; timestamp?: unknown }
  return parseTimestampMs(raw.time) ?? parseTimestampMs(raw.timestamp)
}

function readStreamEventCostUsd(event: StreamJsonEvent): number | null {
  const usageUpdate = extractTranscriptUsageUpdate(event)
  const costUsd = usageUpdate?.totalCostUsd ?? usageUpdate?.costUsd
  return typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0
    ? costUsd
    : null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseCostRecord(raw: unknown): CommanderCostRecord | null {
  if (!isObject(raw)) {
    return null
  }

  const commanderId = typeof raw.commanderId === 'string' ? raw.commanderId.trim() : ''
  const conversationId = typeof raw.conversationId === 'string' ? raw.conversationId.trim() : ''
  const costUsd = typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd)
    ? raw.costUsd
    : null
  const occurredAt = typeof raw.occurredAt === 'string' ? raw.occurredAt.trim() : ''
  if (!commanderId || !conversationId || costUsd === null || costUsd <= 0 || !occurredAt) {
    return null
  }

  return {
    commanderId,
    conversationId,
    costUsd,
    occurredAt,
  }
}

async function forEachJsonlLine(
  filePath: string,
  onLine: (line: string) => void,
): Promise<void> {
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }

  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({
    input: stream,
    crlfDelay: Infinity,
  })

  try {
    for await (const line of lines) {
      onLine(line)
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

export async function appendCommanderCostRecord(
  context: Pick<CommanderCostContext, 'commanderDataDir'>,
  record: CommanderCostRecord,
): Promise<void> {
  if (!Number.isFinite(record.costUsd) || record.costUsd <= 0) {
    return
  }

  const filePath = resolveCommanderCostLedgerPath(context.commanderDataDir, record.commanderId)
  await withCommanderMutation(record.commanderId, context.commanderDataDir, () => (
    appendFileDurably(filePath, `${JSON.stringify(record)}\n`)
  ))
}

export function computeLiveSessionMonthlySpendUsd(
  liveSession: {
    createdAt?: string
    events?: StreamJsonEvent[]
    usage?: {
      costUsd?: number
    }
  },
  now: Date,
): number {
  const window = utcMonthWindow(now)
  const createdAtMs = parseTimestampMs(liveSession.createdAt)
  const sessionStartedBeforeWindow = createdAtMs !== null && createdAtMs < window.startMs
  const events = Array.isArray(liveSession.events) ? liveSession.events : []
  let previousCostUsd = 0
  let hasPreviousCost = false
  let hasTimestampedCostEvent = false
  let total = 0

  for (const event of events) {
    const costUsd = readStreamEventCostUsd(event)
    if (costUsd === null) {
      continue
    }

    const eventTimestampMs = readStreamEventTimestampMs(event)
    if (eventTimestampMs === null) {
      continue
    }

    hasTimestampedCostEvent = true
    if (eventTimestampMs < window.startMs) {
      previousCostUsd = costUsd
      hasPreviousCost = true
      continue
    }

    if (!isInWindow(eventTimestampMs, window)) {
      previousCostUsd = costUsd
      hasPreviousCost = true
      continue
    }

    if (!hasPreviousCost && sessionStartedBeforeWindow) {
      previousCostUsd = costUsd
      hasPreviousCost = true
      continue
    }

    total += Math.max(0, costUsd - previousCostUsd)
    previousCostUsd = costUsd
    hasPreviousCost = true
  }

  if (hasTimestampedCostEvent) {
    return Number(total.toFixed(6))
  }

  const aggregateCostUsd = liveSession.usage?.costUsd
  if (
    typeof aggregateCostUsd !== 'number'
    || !Number.isFinite(aggregateCostUsd)
    || aggregateCostUsd <= 0
  ) {
    return 0
  }

  if (createdAtMs !== null && !isInWindow(createdAtMs, window)) {
    return 0
  }

  return Number(aggregateCostUsd.toFixed(6))
}

async function computeLedgerMonthlySpendUsd(
  context: Pick<CommanderCostContext, 'commanderDataDir' | 'now'>,
  commanderId: string,
): Promise<number> {
  const filePath = resolveCommanderCostLedgerPath(context.commanderDataDir, commanderId)
  const window = utcMonthWindow(context.now())
  let total = 0
  await forEachJsonlLine(filePath, (line) => {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }
    if (trimmed.length > MAX_COST_LEDGER_LINE_LENGTH) {
      return
    }

    try {
      const record = parseCostRecord(JSON.parse(trimmed) as unknown)
      const occurredAtMs = record ? Date.parse(record.occurredAt) : Number.NaN
      if (
        record?.commanderId === commanderId
        && Number.isFinite(occurredAtMs)
        && isInWindow(occurredAtMs, window)
      ) {
        total += record.costUsd
      }
    } catch {
      // Ignore malformed ledger rows; a single bad append must not disable starts.
    }
  })

  return Number(total.toFixed(6))
}

async function computeActiveConversationSessionSpendUsd(
  context: Pick<CommanderCostContext, 'conversationStore' | 'sessionsInterface' | 'now'>,
  commanderId: string,
): Promise<number> {
  if (!context.conversationStore || !context.sessionsInterface) {
    return 0
  }

  const conversations = await context.conversationStore.listByCommander(commanderId)
  let total = 0
  for (const conversation of conversations) {
    if (conversation.commanderId !== commanderId) {
      continue
    }
    const liveSession = context.sessionsInterface.getSession(
      buildConversationSessionName(commanderId, conversation.id),
    )
    if (liveSession) {
      total += computeLiveSessionMonthlySpendUsd(liveSession, context.now())
    }
  }

  return Number(total.toFixed(6))
}

export async function computeCommanderMonthlySpendUsd(
  context: Pick<CommanderCostContext, 'commanderDataDir' | 'now' | 'conversationStore' | 'sessionsInterface'>,
  commanderId: string,
): Promise<number> {
  const [ledgerSpendUsd, activeSpendUsd] = await Promise.all([
    computeLedgerMonthlySpendUsd(context, commanderId),
    computeActiveConversationSessionSpendUsd(context, commanderId),
  ])
  return Number((ledgerSpendUsd + activeSpendUsd).toFixed(6))
}

export async function enforceCommanderCostCap(
  context: CommanderCostContext,
  commanderId: string,
): Promise<CommanderCostCapGateResult> {
  const commander = await context.sessionStore.get(commanderId)
  if (!commander) {
    return {
      ok: false,
      status: 404,
      body: { error: `Commander "${commanderId}" not found` },
    }
  }

  const costCapUsd = commander.costCapUsd ?? null
  if (costCapUsd === null) {
    return { ok: true, costCapUsd, monthlyCostUsd: 0 }
  }

  const monthlyCostUsd = await computeCommanderMonthlySpendUsd(context, commanderId)
  if (monthlyCostUsd < costCapUsd) {
    return { ok: true, costCapUsd, monthlyCostUsd }
  }

  return {
    ok: false,
    status: 402,
    body: {
      error: `Commander "${commanderId}" has reached its monthly spend cap.`,
      reason: 'budget_blocked',
      commanderId,
      costCapUsd,
      monthlyCostUsd,
      window: COMMANDER_COST_CAP_WINDOW,
    },
  }
}
