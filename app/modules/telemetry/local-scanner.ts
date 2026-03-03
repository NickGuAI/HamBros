import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { TelemetryHub } from './hub.js'

export interface FileIngestionState {
  mtime: number
  size: number
  lastIngestedAt: number
}

export type IngestionState = Map<string, FileIngestionState>

export interface LocalScanResult {
  scanned: number
  ingested: number
  skipped: number
  durationMs: number
}

export interface LocalScannerLike {
  scan: () => Promise<LocalScanResult>
}

export interface PrecomputedCostSummary {
  updatedAt: number
  daily: Record<string, number>
}

export interface LocalTelemetryScannerOptions {
  hub: TelemetryHub
  now?: () => Date
  claudeProjectsDir?: string
  codexSessionsDir?: string
  stateFilePath?: string
  summaryCachePath?: string
}

interface TokenTotals {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

interface ScannerStats {
  scanned: number
  ingested: number
  skipped: number
}

interface ScanSessionState {
  skipSession: boolean
  existingCallKeys: Set<string>
}

interface ClaudeUsageEntry {
  sessionId: string
  messageId: string
  model: string
  timestamp: Date
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface CostConfig {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const TOKENS_PER_MILLION = 1_000_000
const GPT_PRICING = {
  inputPerMillion: 1.75,
  cachedInputPerMillion: 0.175,
  outputPerMillion: 14,
}

const CLAUDE_PRICING: Array<{ pattern: RegExp; cost: CostConfig }> = [
  {
    pattern: /opus/i,
    cost: {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    },
  },
  {
    pattern: /sonnet/i,
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
  },
  {
    pattern: /haiku/i,
    cost: {
      input: 0.8,
      output: 4,
      cacheRead: 0.08,
      cacheWrite: 1,
    },
  },
]

function defaultScanStatePath(): string {
  return path.resolve(process.cwd(), 'data/telemetry/scan-state.json')
}

function defaultSummaryCachePath(): string {
  return path.resolve(process.cwd(), 'data/telemetry/cost-summary-cache.json')
}

function defaultClaudeProjectsDir(): string {
  return path.join(homedir(), '.claude', 'projects')
}

function defaultCodexSessionsDir(): string {
  return path.join(homedir(), '.codex', 'sessions')
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed
    }
  }
  return null
}

function asPositiveInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value))
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed))
    }
  }
  return 0
}

function asNonNegativeNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, value)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed)
    }
  }
  return 0
}

function readTokenValue(
  source: Record<string, unknown> | null,
  keys: string[],
): number {
  if (!source) {
    return 0
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return asPositiveInteger(source[key])
    }
  }
  return 0
}

function getUtcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function toCallKey(value: {
  timestamp: string
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
}): string {
  return `${value.timestamp}|${value.model}|${value.inputTokens}|${value.outputTokens}|${value.cost.toFixed(6)}`
}

function isLocalAgentName(agentName: string): boolean {
  const normalized = agentName.trim().toLowerCase()
  return normalized === 'claude-local' || normalized === 'codex-local'
}

function estimateClaudeCost(model: string, usage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}): number {
  const pricing = CLAUDE_PRICING.find((entry) => entry.pattern.test(model))?.cost
  if (!pricing) {
    return 0
  }

  return (
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.cacheWriteTokens * pricing.cacheWrite) /
    TOKENS_PER_MILLION
  )
}

function estimateCodexCost(
  model: string,
  totalInputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  if (!/^gpt-5\./i.test(model)) {
    return 0
  }
  const safeCachedInput = Math.min(Math.max(cachedInputTokens, 0), Math.max(totalInputTokens, 0))
  const uncachedInput = Math.max(totalInputTokens - safeCachedInput, 0)
  return (
    (uncachedInput * GPT_PRICING.inputPerMillion +
      safeCachedInput * GPT_PRICING.cachedInputPerMillion +
      Math.max(outputTokens, 0) * GPT_PRICING.outputPerMillion) /
    TOKENS_PER_MILLION
  )
}

function resolveClaudeUsageEntry(
  rawRecord: Record<string, unknown>,
  fallbackSessionId: string,
  now: Date,
): ClaudeUsageEntry | null {
  const sessionId = asNonEmptyString(rawRecord.sessionId) ?? fallbackSessionId
  const rawMessage = asObject(rawRecord.message)
  if (!rawMessage) {
    return null
  }

  const role = asNonEmptyString(rawMessage.role)
  if (role !== 'assistant') {
    return null
  }

  const usage = asObject(rawMessage.usage)
  if (!usage) {
    return null
  }

  const model = asNonEmptyString(rawMessage.model) ?? 'unknown'
  const messageId =
    asNonEmptyString(rawMessage.id) ??
    asNonEmptyString(rawRecord.uuid) ??
    `${sessionId}:${asNonEmptyString(rawRecord.timestamp) ?? now.toISOString()}`
  const timestamp =
    asDate(rawRecord.timestamp) ??
    asDate(rawMessage.timestamp) ??
    now

  return {
    sessionId,
    messageId,
    model,
    timestamp,
    inputTokens: readTokenValue(usage, ['input_tokens', 'inputTokens']),
    outputTokens: readTokenValue(usage, ['output_tokens', 'outputTokens']),
    cacheReadTokens: readTokenValue(usage, [
      'cache_read_input_tokens',
      'cacheReadInputTokens',
      'cached_input_tokens',
      'cachedInputTokens',
    ]),
    cacheWriteTokens: readTokenValue(usage, [
      'cache_creation_input_tokens',
      'cacheCreationInputTokens',
      'cache_write_input_tokens',
      'cacheWriteInputTokens',
    ]),
  }
}

function resolveNestedClaudeUsageEntry(
  rawRecord: Record<string, unknown>,
  fallbackSessionId: string,
  now: Date,
): ClaudeUsageEntry | null {
  const data = asObject(rawRecord.data)
  const progressMessageEnvelope = asObject(data?.message)
  if (!progressMessageEnvelope) {
    return null
  }
  if (asNonEmptyString(progressMessageEnvelope.type) !== 'assistant') {
    return null
  }

  const nestedMessage = asObject(progressMessageEnvelope.message)
  if (!nestedMessage) {
    return null
  }

  const synthesizedRecord: Record<string, unknown> = {
    ...rawRecord,
    timestamp:
      asNonEmptyString(progressMessageEnvelope.timestamp) ??
      asNonEmptyString(rawRecord.timestamp),
    message: nestedMessage,
  }

  return resolveClaudeUsageEntry(synthesizedRecord, fallbackSessionId, now)
}

function messageUsageMagnitude(entry: ClaudeUsageEntry): number {
  return (
    entry.inputTokens +
    entry.outputTokens +
    entry.cacheReadTokens +
    entry.cacheWriteTokens
  )
}

function computeTokenDelta(previous: TokenTotals | null, current: TokenTotals): TokenTotals {
  if (!previous) {
    return current
  }

  const delta: TokenTotals = {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
  }

  if (
    delta.inputTokens < 0 ||
    delta.cachedInputTokens < 0 ||
    delta.outputTokens < 0 ||
    delta.reasoningOutputTokens < 0
  ) {
    return current
  }

  return delta
}

function hasTokenDelta(delta: TokenTotals): boolean {
  return (
    delta.inputTokens > 0 ||
    delta.cachedInputTokens > 0 ||
    delta.outputTokens > 0 ||
    delta.reasoningOutputTokens > 0
  )
}

function parseTokenTotals(record: Record<string, unknown>): TokenTotals {
  return {
    inputTokens: readTokenValue(record, ['input_tokens', 'inputTokens']),
    cachedInputTokens: readTokenValue(record, ['cached_input_tokens', 'cachedInputTokens']),
    outputTokens: readTokenValue(record, ['output_tokens', 'outputTokens']),
    reasoningOutputTokens: readTokenValue(record, [
      'reasoning_output_tokens',
      'reasoningOutputTokens',
    ]),
  }
}

function isFileUnchanged(
  state: IngestionState,
  filePath: string,
  fileStats: { mtimeMs: number; size: number },
): boolean {
  const current = state.get(filePath)
  if (!current) {
    return false
  }
  return current.mtime === fileStats.mtimeMs && current.size === fileStats.size
}

async function listJsonlFiles(
  rootDir: string,
  matcher?: (fileName: string) => boolean,
): Promise<string[]> {
  const stack = [rootDir]
  const files: string[] = []

  while (stack.length > 0) {
    const currentDir = stack.pop()
    if (!currentDir) {
      continue
    }
    const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      if (!entry.name.endsWith('.jsonl')) {
        continue
      }
      if (matcher && !matcher(entry.name)) {
        continue
      }
      files.push(fullPath)
    }
  }

  files.sort((left, right) => left.localeCompare(right))
  return files
}

function resolveSessionState(
  hub: TelemetryHub,
  sessionId: string,
): ScanSessionState {
  const detail = hub.getSessionDetail(sessionId)
  if (!detail) {
    return {
      skipSession: false,
      existingCallKeys: new Set<string>(),
    }
  }

  if (!isLocalAgentName(detail.session.agentName)) {
    return {
      skipSession: true,
      existingCallKeys: new Set<string>(),
    }
  }

  return {
    skipSession: false,
    existingCallKeys: new Set(detail.calls.map((call) => toCallKey(call))),
  }
}

function addDailyCost(
  dailyCostDelta: Map<string, number> | undefined,
  timestamp: Date,
  cost: number,
): void {
  if (!dailyCostDelta || cost <= 0) {
    return
  }
  const dayKey = getUtcDayKey(timestamp)
  dailyCostDelta.set(dayKey, (dailyCostDelta.get(dayKey) ?? 0) + cost)
}

export class IngestionStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<IngestionState> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (asObject(error)?.code === 'ENOENT') {
        return new Map()
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return new Map()
    }

    const root = asObject(parsed)
    if (!root) {
      return new Map()
    }

    const source = asObject(root.files) ?? root
    const state: IngestionState = new Map()
    for (const [filePath, value] of Object.entries(source)) {
      const item = asObject(value)
      if (!item) {
        continue
      }
      const mtime = asNonNegativeNumber(item.mtime)
      const size = asNonNegativeNumber(item.size)
      const lastIngestedAt = asPositiveInteger(item.lastIngestedAt)
      if (!filePath || (mtime === 0 && size === 0 && lastIngestedAt === 0)) {
        continue
      }
      state.set(filePath, {
        mtime,
        size,
        lastIngestedAt,
      })
    }

    return state
  }

  async save(state: IngestionState): Promise<void> {
    const out: Record<string, FileIngestionState> = {}
    const ordered = [...state.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )
    for (const [filePath, entry] of ordered) {
      out[filePath] = entry
    }
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(out, null, 2), 'utf8')
  }
}

class PrecomputedCostSummaryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PrecomputedCostSummary> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (asObject(error)?.code === 'ENOENT') {
        return { updatedAt: 0, daily: {} }
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { updatedAt: 0, daily: {} }
    }

    const root = asObject(parsed)
    const dailyRaw = asObject(root?.daily)
    if (!root || !dailyRaw) {
      return { updatedAt: 0, daily: {} }
    }

    const daily: Record<string, number> = {}
    for (const [day, value] of Object.entries(dailyRaw)) {
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < 0) {
        continue
      }
      daily[day] = numeric
    }

    return {
      updatedAt: asPositiveInteger(root.updatedAt),
      daily,
    }
  }

  async save(summary: PrecomputedCostSummary): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(summary, null, 2), 'utf8')
  }
}

export async function scanClaudeSessions(params: {
  projectDir: string
  state: IngestionState
  hub: TelemetryHub
  now?: () => Date
  dailyCostDelta?: Map<string, number>
}): Promise<ScannerStats> {
  const now = params.now ?? (() => new Date())
  const stats: ScannerStats = { scanned: 0, ingested: 0, skipped: 0 }
  const files = await listJsonlFiles(params.projectDir)

  for (const filePath of files) {
    stats.scanned += 1
    const fileStats = await stat(filePath).catch(() => null)
    if (!fileStats) {
      stats.skipped += 1
      continue
    }

    if (isFileUnchanged(params.state, filePath, fileStats)) {
      stats.skipped += 1
      continue
    }

    const fallbackSessionId = path.basename(filePath, '.jsonl')
    const dedupedMessages = new Map<string, ClaudeUsageEntry>()

    const fileStream = createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity })
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }

      const record = asObject(parsed)
      if (!record) {
        continue
      }

      const resolvedAt = now()
      const candidates = [
        resolveClaudeUsageEntry(record, fallbackSessionId, resolvedAt),
        resolveNestedClaudeUsageEntry(record, fallbackSessionId, resolvedAt),
      ].filter((entry): entry is ClaudeUsageEntry => Boolean(entry))

      for (const entry of candidates) {
        const dedupeKey = `${entry.sessionId}:${entry.messageId}`
        const previous = dedupedMessages.get(dedupeKey)
        if (!previous) {
          dedupedMessages.set(dedupeKey, entry)
          continue
        }
        const previousMagnitude = messageUsageMagnitude(previous)
        const currentMagnitude = messageUsageMagnitude(entry)
        if (currentMagnitude > previousMagnitude) {
          dedupedMessages.set(dedupeKey, entry)
          continue
        }
        if (
          currentMagnitude === previousMagnitude &&
          entry.timestamp.getTime() > previous.timestamp.getTime()
        ) {
          dedupedMessages.set(dedupeKey, entry)
        }
      }
    }

    const usageEntries = [...dedupedMessages.values()].sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
    )
    const sessionStateById = new Map<string, ScanSessionState>()

    for (const entry of usageEntries) {
      const sessionState =
        sessionStateById.get(entry.sessionId) ??
        resolveSessionState(params.hub, entry.sessionId)
      sessionStateById.set(entry.sessionId, sessionState)

      if (sessionState.skipSession) {
        continue
      }

      const cost = estimateClaudeCost(entry.model, entry)
      const inputTokens =
        entry.inputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
      const outputTokens = entry.outputTokens

      const callKey = toCallKey({
        timestamp: entry.timestamp.toISOString(),
        model: entry.model,
        inputTokens,
        outputTokens,
        cost,
      })

      if (sessionState.existingCallKeys.has(callKey)) {
        continue
      }

      await params.hub.ingest({
        sessionId: entry.sessionId,
        agentName: 'claude-local',
        model: entry.model,
        provider: 'claude-local',
        inputTokens,
        outputTokens,
        cost,
        durationMs: 0,
        currentTask: 'Local scan',
        timestamp: entry.timestamp,
      })

      sessionState.existingCallKeys.add(callKey)
      stats.ingested += 1
      addDailyCost(params.dailyCostDelta, entry.timestamp, cost)
    }

    params.state.set(filePath, {
      mtime: fileStats.mtimeMs,
      size: fileStats.size,
      lastIngestedAt: now().getTime(),
    })
  }

  return stats
}

function deriveSessionIdFromCodexFile(filePath: string): string {
  const baseName = path.basename(filePath, '.jsonl')
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(baseName)
  return match?.[1] ?? baseName
}

export async function scanCodexSessions(params: {
  sessionsDir: string
  state: IngestionState
  hub: TelemetryHub
  now?: () => Date
  dailyCostDelta?: Map<string, number>
}): Promise<ScannerStats> {
  const now = params.now ?? (() => new Date())
  const stats: ScannerStats = { scanned: 0, ingested: 0, skipped: 0 }
  const files = await listJsonlFiles(params.sessionsDir, (fileName) =>
    /^rollout-.*\.jsonl$/i.test(fileName),
  )

  for (const filePath of files) {
    stats.scanned += 1
    const fileStats = await stat(filePath).catch(() => null)
    if (!fileStats) {
      stats.skipped += 1
      continue
    }

    if (isFileUnchanged(params.state, filePath, fileStats)) {
      stats.skipped += 1
      continue
    }

    let sessionId = deriveSessionIdFromCodexFile(filePath)
    let model = 'unknown'
    let previousTotals: TokenTotals | null = null
    let sessionState: ScanSessionState | null = null

    const fileStream = createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity })
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }

      const record = asObject(parsed)
      if (!record) {
        continue
      }

      if (asNonEmptyString(record.type) === 'session_meta') {
        const payload = asObject(record.payload)
        const payloadId = asNonEmptyString(payload?.id)
        if (payloadId) {
          sessionId = payloadId
        }
      }

      if (asNonEmptyString(record.type) === 'turn_context') {
        const payload = asObject(record.payload)
        model = asNonEmptyString(payload?.model) ?? model
      }

      if (!sessionState) {
        sessionState = resolveSessionState(params.hub, sessionId)
      }
      if (sessionState.skipSession) {
        continue
      }

      if (asNonEmptyString(record.type) !== 'event_msg') {
        continue
      }

      const payload = asObject(record.payload)
      if (asNonEmptyString(payload?.type) !== 'token_count') {
        continue
      }

      const info = asObject(payload?.info)
      const totalUsage = asObject(info?.total_token_usage)
      if (!totalUsage) {
        continue
      }

      const currentTotals = parseTokenTotals(totalUsage)
      const delta = computeTokenDelta(previousTotals, currentTotals)
      previousTotals = currentTotals
      if (!hasTokenDelta(delta)) {
        continue
      }

      const timestamp = asDate(record.timestamp) ?? now()
      const totalOutputTokens =
        delta.outputTokens + delta.reasoningOutputTokens
      const cost = estimateCodexCost(
        model,
        delta.inputTokens,
        delta.cachedInputTokens,
        totalOutputTokens,
      )

      const callKey = toCallKey({
        timestamp: timestamp.toISOString(),
        model,
        inputTokens: delta.inputTokens,
        outputTokens: totalOutputTokens,
        cost,
      })
      if (sessionState.existingCallKeys.has(callKey)) {
        continue
      }

      await params.hub.ingest({
        sessionId,
        agentName: 'codex-local',
        model,
        provider: 'codex-local',
        inputTokens: delta.inputTokens,
        outputTokens: totalOutputTokens,
        cost,
        durationMs: 0,
        currentTask: 'Local scan',
        timestamp,
      })

      sessionState.existingCallKeys.add(callKey)
      stats.ingested += 1
      addDailyCost(params.dailyCostDelta, timestamp, cost)
    }

    params.state.set(filePath, {
      mtime: fileStats.mtimeMs,
      size: fileStats.size,
      lastIngestedAt: now().getTime(),
    })
  }

  return stats
}

export class LocalTelemetryScanner implements LocalScannerLike {
  private readonly stateStore: IngestionStateStore
  private readonly summaryStore: PrecomputedCostSummaryStore
  private readonly now: () => Date
  private activeScan: Promise<LocalScanResult> | null = null

  private readonly claudeProjectsDir: string
  private readonly codexSessionsDir: string

  constructor(private readonly options: LocalTelemetryScannerOptions) {
    this.now = options.now ?? (() => new Date())
    this.claudeProjectsDir = options.claudeProjectsDir ?? defaultClaudeProjectsDir()
    this.codexSessionsDir = options.codexSessionsDir ?? defaultCodexSessionsDir()
    this.stateStore = new IngestionStateStore(
      options.stateFilePath ?? defaultScanStatePath(),
    )
    this.summaryStore = new PrecomputedCostSummaryStore(
      options.summaryCachePath ?? defaultSummaryCachePath(),
    )
  }

  async scan(): Promise<LocalScanResult> {
    if (this.activeScan) {
      return this.activeScan
    }

    this.activeScan = this.runScan()
    try {
      return await this.activeScan
    } finally {
      this.activeScan = null
    }
  }

  async getCostSummary(): Promise<PrecomputedCostSummary> {
    return this.summaryStore.load()
  }

  private async runScan(): Promise<LocalScanResult> {
    await this.options.hub.ensureReady()

    const startedAt = Date.now()
    const state = await this.stateStore.load()
    const existingSummary = await this.summaryStore.load()
    const dailyCostDelta = new Map<string, number>()

    const claudeStats = await scanClaudeSessions({
      projectDir: this.claudeProjectsDir,
      state,
      hub: this.options.hub,
      now: this.now,
      dailyCostDelta,
    })
    const codexStats = await scanCodexSessions({
      sessionsDir: this.codexSessionsDir,
      state,
      hub: this.options.hub,
      now: this.now,
      dailyCostDelta,
    })

    await this.stateStore.save(state)

    const mergedDaily = { ...existingSummary.daily }
    for (const [day, value] of dailyCostDelta.entries()) {
      mergedDaily[day] = (mergedDaily[day] ?? 0) + value
    }
    await this.summaryStore.save({
      updatedAt: this.now().getTime(),
      daily: mergedDaily,
    })

    return {
      scanned: claudeStats.scanned + codexStats.scanned,
      ingested: claudeStats.ingested + codexStats.ingested,
      skipped: claudeStats.skipped + codexStats.skipped,
      durationMs: Date.now() - startedAt,
    }
  }
}
