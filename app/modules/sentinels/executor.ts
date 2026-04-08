import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AgentSessionClient,
  type AgentSessionCompletion,
  type AgentSessionCreateInput,
  type AgentSessionMonitorOptions,
} from '../commanders/tools/agent-session.js'
import { resolveCommanderPaths } from '../commanders/paths.js'
import { assemblePrompt } from './prompt.js'
import { resolveSkills } from './skills.js'
import { SentinelStore } from './store.js'
import type { Sentinel, SentinelHistoryEntry, SentinelRunMetadata } from './types.js'

export type SentinelTriggerSource = 'cron' | 'manual'

interface AgentSessionClientLike {
  createSession(input: AgentSessionCreateInput): Promise<{ sessionId: string }>
  monitorSession(
    sessionId: string,
    options?: AgentSessionMonitorOptions,
  ): Promise<AgentSessionCompletion>
  killSession?(sessionId: string): Promise<void>
}

export interface SentinelExecutionResult {
  sentinel: Sentinel
  historyEntry: SentinelHistoryEntry
}

export interface SentinelExecutorOptions {
  store?: SentinelStore
  now?: () => Date
  monitorOptions?: AgentSessionMonitorOptions
  agentSessionFactory?: () => AgentSessionClientLike
  internalToken?: string
}

interface ParsedRunPayload {
  action: string
  result: string
  memoryUpdated: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

function extractCostUsd(payload: unknown): number {
  if (!isObject(payload)) {
    return 0
  }

  const direct =
    asNumber(payload.total_cost_usd)
    ?? asNumber(payload.cost_usd)
    ?? asNumber(payload.totalCostUsd)
    ?? asNumber(payload.costUsd)
  if (direct !== null) {
    return Math.max(0, direct)
  }

  const nested = payload.result
  if (isObject(nested)) {
    const nestedCost =
      asNumber(nested.total_cost_usd)
      ?? asNumber(nested.cost_usd)
      ?? asNumber(nested.totalCostUsd)
      ?? asNumber(nested.costUsd)
    if (nestedCost !== null) {
      return Math.max(0, nestedCost)
    }
  }

  return 0
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return 'Sentinel execution failed without an error message.'
}

function isSessionTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /did not complete after/i.test(error.message)
}

function resolveBaseUrl(): string {
  const explicit = process.env.HAMBROS_API_BASE_URL?.trim()
  if (explicit) {
    return explicit
  }
  const port = process.env.PORT?.trim() || '20001'
  return `http://127.0.0.1:${port}`
}

function resolveApiKey(): string | undefined {
  const apiKey = process.env.HAMBROS_INTERNAL_API_KEY?.trim() || process.env.HAMBROS_API_KEY?.trim()
  return apiKey || undefined
}

function defaultAgentSessionFactory(internalToken?: string): () => AgentSessionClientLike {
  if (!resolveApiKey() && !internalToken) {
    console.warn('[sentinel] WARNING: No internal token or HAMBROS_INTERNAL_API_KEY set - sentinel triggers may fail')
  }

  return () => new AgentSessionClient({
    baseUrl: resolveBaseUrl(),
    apiKey: resolveApiKey(),
    internalToken,
  })
}

function sanitizePermissionMode(
  mode: string,
): 'default' | 'acceptEdits' | 'dangerouslySkipPermissions' {
  if (mode === 'default' || mode === 'acceptEdits' || mode === 'dangerouslySkipPermissions') {
    return mode
  }
  return 'acceptEdits'
}

function resolveSessionName(name: string, now: Date): string {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-')
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  return `sentinel-${safeName}-${timestamp}`
}

function resolveRunTimestampKey(timestamp: string): string {
  return timestamp.replace(/[:.]/g, '-')
}

function parseJsonPayload(rawText: string): ParsedRunPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText) as unknown
  } catch {
    return null
  }

  if (!isObject(parsed)) {
    return null
  }

  const action = typeof parsed.action === 'string' ? parsed.action.trim() : ''
  const result = typeof parsed.result === 'string' ? parsed.result.trim() : ''
  if (!action || !result) {
    return null
  }

  return {
    action,
    result,
    memoryUpdated: parsed.memoryUpdated === true,
  }
}

function parseStructuredOutput(text: string): ParsedRunPayload {
  const normalized = text.trim()
  if (!normalized) {
    return {
      action: 'No summary generated',
      result: 'The agent session finished without a structured response.',
      memoryUpdated: false,
    }
  }

  const codeBlockMatch = normalized.match(/```json\s*([\s\S]*?)```/i)
  if (codeBlockMatch?.[1]) {
    const parsed = parseJsonPayload(codeBlockMatch[1])
    if (parsed) {
      return parsed
    }
  }

  const jsonObjectMatch = normalized.match(/\{[\s\S]*\}/)
  if (jsonObjectMatch?.[0]) {
    const parsed = parseJsonPayload(jsonObjectMatch[0])
    if (parsed) {
      return parsed
    }
  }

  const firstLine = normalized.split('\n').map((line) => line.trim()).find(Boolean)
  return {
    action: firstLine ?? 'Run completed',
    result: normalized,
    memoryUpdated: false,
  }
}

function completionToRunStatus(
  status: AgentSessionCompletion['status'],
): SentinelRunMetadata['status'] {
  if (status === 'SUCCESS' || status === 'PARTIAL') {
    return 'complete'
  }
  return 'failed'
}

export class SentinelExecutor {
  private readonly store: SentinelStore
  private readonly now: () => Date
  private readonly monitorOptions?: AgentSessionMonitorOptions
  private readonly agentSessionFactory: () => AgentSessionClientLike
  private readonly inFlightBySentinelId = new Map<string, Promise<SentinelExecutionResult | null>>()

  constructor(options: SentinelExecutorOptions = {}) {
    this.store = options.store ?? new SentinelStore()
    this.now = options.now ?? (() => new Date())
    this.monitorOptions = options.monitorOptions
    this.agentSessionFactory = options.agentSessionFactory ?? defaultAgentSessionFactory(options.internalToken)
  }

  async executeSentinel(
    sentinelId: string,
    source: SentinelTriggerSource,
  ): Promise<SentinelExecutionResult | null> {
    const inFlight = this.inFlightBySentinelId.get(sentinelId)
    if (inFlight) {
      return inFlight
    }

    const execution = this.executeSentinelInternal(sentinelId, source).finally(() => {
      this.inFlightBySentinelId.delete(sentinelId)
    })
    this.inFlightBySentinelId.set(sentinelId, execution)
    return execution
  }

  private async executeSentinelInternal(
    sentinelId: string,
    source: SentinelTriggerSource,
  ): Promise<SentinelExecutionResult | null> {
    const sentinel = await this.store.get(sentinelId)
    if (!sentinel) {
      return null
    }

    if (source === 'cron' && sentinel.status !== 'active') {
      return null
    }

    if (sentinel.status === 'completed' || sentinel.status === 'cancelled') {
      return null
    }

    if (sentinel.maxRuns && sentinel.totalRuns >= sentinel.maxRuns) {
      await this.store.update(sentinel.id, { status: 'completed' })
      return null
    }

    const startedAtDate = this.now()
    const startedAt = startedAtDate.toISOString()
    const runTimestampKey = resolveRunTimestampKey(startedAt)
    const runFile = path.join(sentinel.outputDir, 'runs', `${runTimestampKey}.md`)
    const runJsonPath = this.store.resolveRunJsonPath(sentinel, runTimestampKey)

    const memoryContent = (await this.store.readMemory(sentinel.id)) ?? ''
    const commanderSkillsDir = resolveCommanderPaths(sentinel.parentCommanderId).skillsRoot
    const resolvedSkills = await resolveSkills(sentinel.skills, commanderSkillsDir)
    const prompt = assemblePrompt({
      sentinel,
      memoryContent,
      resolvedSkills,
      now: startedAtDate,
      recentHistory: sentinel.history.slice(0, 3),
    })

    let sessionId = ''
    let client: AgentSessionClientLike | null = null
    let sessionKilled = false

    const killSessionSafely = async (): Promise<void> => {
      if (!sessionId || !client?.killSession || sessionKilled) {
        return
      }
      try {
        await client.killSession(sessionId)
        sessionKilled = true
      } catch {
        // Best-effort cleanup.
      }
    }

    const writeRunMetadata = async (metadata: SentinelRunMetadata): Promise<void> => {
      await mkdir(path.dirname(runJsonPath), { recursive: true })
      await writeFile(runJsonPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    }

    try {
      client = this.agentSessionFactory()

      const created = await client.createSession({
        name: resolveSessionName(sentinel.name, startedAtDate),
        task: prompt,
        agentType: sentinel.agentType,
        cwd: sentinel.workDir,
        mode: sanitizePermissionMode(sentinel.permissionMode),
        sessionType: 'stream',
        model: sentinel.model,
      })
      sessionId = created.sessionId

      const completion = await client.monitorSession(sessionId, this.monitorOptions)
      await killSessionSafely()

      const parsedOutput = parseStructuredOutput(completion.finalComment)
      const finishedAt = this.now().toISOString()
      const durationSec = Math.max(
        0,
        Math.round((new Date(finishedAt).getTime() - startedAtDate.getTime()) / 1000),
      )
      const costUsd = extractCostUsd(completion.raw)

      const historyEntry: SentinelHistoryEntry = {
        timestamp: finishedAt,
        action: parsedOutput.action,
        result: parsedOutput.result,
        costUsd,
        durationSec,
        sessionId,
        runFile,
        memoryUpdated: parsedOutput.memoryUpdated,
        source,
      }

      const runMetadata: SentinelRunMetadata = {
        sentinelId: sentinel.id,
        sentinelName: sentinel.name,
        runNumber: sentinel.totalRuns + 1,
        timestamp: finishedAt,
        action: parsedOutput.action,
        result: parsedOutput.result,
        costUsd,
        durationSec,
        sessionId,
        memoryUpdated: parsedOutput.memoryUpdated,
        status: completionToRunStatus(completion.status),
        source,
      }

      await writeRunMetadata(runMetadata)

      const updated = await this.store.appendHistory(sentinel.id, historyEntry)
      if (!updated) {
        return null
      }

      return {
        sentinel: updated,
        historyEntry,
      }
    } catch (error) {
      const finishedAt = this.now().toISOString()
      const durationSec = Math.max(
        0,
        Math.round((new Date(finishedAt).getTime() - startedAtDate.getTime()) / 1000),
      )
      const status: SentinelRunMetadata['status'] = isSessionTimeoutError(error)
        ? 'timeout'
        : 'failed'
      const result = toErrorMessage(error)

      const historyEntry: SentinelHistoryEntry = {
        timestamp: finishedAt,
        action: 'ERROR',
        result,
        costUsd: 0,
        durationSec,
        sessionId,
        runFile,
        memoryUpdated: false,
        source,
      }

      const runMetadata: SentinelRunMetadata = {
        sentinelId: sentinel.id,
        sentinelName: sentinel.name,
        runNumber: sentinel.totalRuns + 1,
        timestamp: finishedAt,
        action: historyEntry.action,
        result,
        costUsd: 0,
        durationSec,
        sessionId,
        memoryUpdated: false,
        status,
        source,
      }

      await writeRunMetadata(runMetadata)

      const updated = await this.store.appendHistory(sentinel.id, historyEntry)
      if (!updated) {
        return null
      }

      return {
        sentinel: updated,
        historyEntry,
      }
    } finally {
      await killSessionSafely()
    }
  }
}
