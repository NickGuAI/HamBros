import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AgentSessionClient,
  type AgentSessionCompletion,
  type AgentSessionCreateInput,
  type AgentSessionMonitorOptions,
} from '@gehirn/ai-services'
import { withCommanderRuntimeLaunch } from '../commanders/package-lifecycle-state.js'
import { resolveCommanderDataDir, resolveCommanderPaths } from '../commanders/paths.js'
import { AutomationStore, type UpdateAutomationInput } from './store.js'
import { isValidSkillName, resolveSkills } from './skills.js'
import type {
  Automation,
  AutomationExecutionSource,
  AutomationHistoryEntry,
  AutomationRunMetadata,
  AutomationRunTranscriptRef,
} from './types.js'

interface AgentSessionClientLike {
  createSession(input: AgentSessionCreateInput): Promise<{ sessionId: string }>
  monitorSession(
    sessionId: string,
    options?: AgentSessionMonitorOptions,
  ): Promise<AgentSessionCompletion>
  killSession?(sessionId: string): Promise<void>
}

export interface AutomationExecutionResult {
  automation: Automation
  historyEntry: AutomationHistoryEntry
}

export interface AutomationExecutorOptions {
  store?: AutomationStore
  commanderDataDir?: string
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
  return 'Automation execution failed without an error message.'
}

function isSessionTimeoutError(error: unknown): boolean {
  return error instanceof Error && /did not complete after/i.test(error.message)
}

function resolveBaseUrl(): string {
  const explicit = process.env.HERD_API_BASE_URL?.trim()
  if (explicit) {
    return explicit
  }
  const port = process.env.PORT?.trim() || '20001'
  return `http://127.0.0.1:${port}`
}

function resolveApiKey(): string | undefined {
  const apiKey = process.env.HERD_INTERNAL_API_KEY?.trim() || process.env.HERD_API_KEY?.trim()
  return apiKey || undefined
}

function defaultAgentSessionFactory(internalToken?: string): () => AgentSessionClientLike {
  if (!resolveApiKey() && !internalToken) {
    console.warn('[automations] WARNING: No internal token or HERD_INTERNAL_API_KEY set - automation triggers may fail')
  }
  return () => new AgentSessionClient({
    baseUrl: resolveBaseUrl(),
    apiKey: resolveApiKey(),
    internalToken,
  })
}

function resolveSessionName(name: string, now: Date): string {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-')
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  return `automation-${safeName}-${timestamp}`
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
      action: 'Run completed without final output',
      result: 'The automation session completed, but the agent returned an empty final comment.',
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

function buildTranscriptRef(sessionId: string): AutomationRunTranscriptRef | undefined {
  const normalized = sessionId.trim()
  return normalized ? { sessionId: normalized } : undefined
}

function resolveEmptyOutputReason(
  completionOutput: string,
  status: AgentSessionCompletion['status'],
): string | undefined {
  if (completionOutput.trim().length > 0) {
    return undefined
  }
  if (status === 'SUCCESS' || status === 'PARTIAL') {
    return 'The automation session completed, but the agent returned an empty final comment.'
  }
  return 'The automation session ended without a final comment.'
}

function completionToRunStatus(
  status: AgentSessionCompletion['status'],
): AutomationRunMetadata['status'] {
  if (status === 'SUCCESS' || status === 'PARTIAL') {
    return 'complete'
  }
  return 'failed'
}

async function assembleAutomationPrompt(
  automation: Automation,
  memoryContent: string,
  now: Date,
  runFile: string,
): Promise<string> {
  const commanderSkillsDir = automation.parentCommanderId
    ? resolveCommanderPaths(automation.parentCommanderId).skillsRoot
    : undefined
  const configuredSkills = [...new Set(
    automation.skills
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 0),
  )]
  const validConfiguredSkills = configuredSkills.filter(isValidSkillName)
  const invalidSkillCount = configuredSkills.length - validConfiguredSkills.length
  const resolvedSkills = await resolveSkills(validConfiguredSkills, commanderSkillsDir)
  const missingSkills = validConfiguredSkills.filter((skill) => !resolvedSkills.has(skill))
  if (invalidSkillCount > 0) {
    missingSkills.push(`${invalidSkillCount} invalid skill name${invalidSkillCount === 1 ? '' : 's'}`)
  }
  if (missingSkills.length > 0) {
    throw new Error(`Configured automation skills are unavailable: ${missingSkills.join(', ')}`)
  }
  const skillSections = resolvedSkills.size === 0
    ? 'No special skills configured.'
    : [...resolvedSkills.entries()]
      .map(([name, content]) => [`### Skill: ${name}`, content].join('\n'))
      .join('\n\n')
  const history = (automation.history ?? [])
    .slice(0, 3)
    .map((entry, index) => {
      const runNumber = (automation.totalRuns ?? 0) - index
      return [
        `### Run #${runNumber} - ${entry.timestamp}`,
        `Action: ${entry.action}`,
        `Result: ${entry.result}`,
      ].join('\n')
    })
    .join('\n\n') || 'This is your first run. No prior history.'

  return [
    `# Automation: ${automation.name}`,
    '',
    'You are a focused automation agent. Execute the instruction, update memory when needed, write a run report, then exit.',
    '',
    '## Run Context',
    `- Trigger: ${automation.trigger}`,
    `- Schedule: ${automation.schedule ?? '(not scheduled)'}`,
    `- Current time: ${now.toISOString()}`,
    `- Last run: ${automation.lastRun ?? 'This is your first run.'}`,
    `- Parent commander: ${automation.parentCommanderId ?? '(operator-level)'}`,
    `- Output directory: ${automation.outputDir ?? '(unset)'}`,
    '',
    '## Memory',
    `Update memory via Write tool at: ${automation.memoryPath ?? '(unset)'} whenever you learn durable facts.`,
    '---BEGIN MEMORY---',
    memoryContent.trim() || '(Memory file is empty.)',
    '---END MEMORY---',
    '',
    '## Recent Run History',
    history,
    '',
    '## Available Skills',
    skillSections,
    '',
    '## Instruction',
    automation.instruction,
    '',
    '## Output Requirements',
    `1. If you learned new facts, update memory at ${automation.memoryPath ?? '(unset)'}.`,
    `2. Write a markdown run report to ${runFile}.`,
    '3. End with exactly one JSON block:',
    '```json',
    '{',
    '  "action": "Brief description of what you did",',
    '  "result": "Outcome and key details",',
    '  "memoryUpdated": true',
    '}',
    '```',
  ].join('\n')
}

export class AutomationExecutor {
  private readonly store: AutomationStore
  private readonly commanderDataDir: string
  private readonly now: () => Date
  private readonly monitorOptions?: AgentSessionMonitorOptions
  private readonly agentSessionFactory: () => AgentSessionClientLike
  private readonly inFlightByAutomationId = new Map<string, Promise<AutomationExecutionResult | null>>()

  constructor(options: AutomationExecutorOptions = {}) {
    this.store = options.store ?? new AutomationStore()
    this.commanderDataDir = path.resolve(options.commanderDataDir ?? resolveCommanderDataDir())
    this.now = options.now ?? (() => new Date())
    this.monitorOptions = options.monitorOptions
    this.agentSessionFactory = options.agentSessionFactory ?? defaultAgentSessionFactory(options.internalToken)
  }

  async executeAutomation(
    automationId: string,
    source: AutomationExecutionSource,
  ): Promise<AutomationExecutionResult | null> {
    const inFlight = this.inFlightByAutomationId.get(automationId)
    if (inFlight) {
      return inFlight
    }

    const execution = this.executeAutomationInternal(automationId, source).finally(() => {
      this.inFlightByAutomationId.delete(automationId)
    })
    this.inFlightByAutomationId.set(automationId, execution)
    return execution
  }

  private async executeAutomationInternal(
    automationId: string,
    source: AutomationExecutionSource,
  ): Promise<AutomationExecutionResult | null> {
    const automation = await this.store.get(automationId)
    if (!automation) {
      return null
    }
    if ((source === 'schedule' || source === 'quest') && automation.status !== 'active') {
      return null
    }
    if (automation.status === 'completed' || automation.status === 'cancelled') {
      return null
    }
    if (automation.maxRuns && (automation.totalRuns ?? 0) >= automation.maxRuns) {
      await this.store.update(automation.id, { status: 'completed' })
      return null
    }

    const startedAtDate = this.now()
    const startedAt = startedAtDate.toISOString()
    const runTimestampKey = resolveRunTimestampKey(startedAt)
    const outputDir = automation.outputDir ?? path.join(process.cwd(), '.herd', 'automations', automation.id)
    const runFile = path.join(outputDir, 'runs', `${runTimestampKey}.md`)
    const runJsonPath = this.store.resolveRunJsonPath(automation, runTimestampKey)
    const memoryContent = (await this.store.readMemory(automation.id)) ?? ''

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
    const writeRunMetadata = async (metadata: AutomationRunMetadata): Promise<boolean> => {
      for (;;) {
        const current = await this.store.get(automation.id)
        if (!current) {
          return false
        }
        const parentCommanderId = current.parentCommanderId?.trim()
        const write = async (): Promise<boolean> => {
          const revalidated = await this.store.get(automation.id)
          if (!revalidated || revalidated.parentCommanderId?.trim() !== parentCommanderId) {
            return false
          }
          await mkdir(path.dirname(runJsonPath), { recursive: true })
          await writeFile(runJsonPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
          return true
        }
        if (!parentCommanderId) {
          return write()
        }
        const written = await withCommanderRuntimeLaunch(
          parentCommanderId,
          this.commanderDataDir,
          write,
        )
        if (written) {
          return true
        }
      }
    }

    try {
      const prompt = await assembleAutomationPrompt(automation, memoryContent, startedAtDate, runFile)
      client = this.agentSessionFactory()
      const createSession = () => client!.createSession({
          name: resolveSessionName(automation.name, startedAtDate),
          task: prompt,
          agentType: automation.agentType,
          cwd: automation.workDir ?? process.cwd(),
          host: automation.machine,
          mode: automation.permissionMode,
          transportType: automation.sessionType ?? 'stream',
          sessionType: 'automation',
          creator: {
            kind: 'automation',
            id: automation.id,
          },
          model: automation.model,
        })
      const created = automation.parentCommanderId
        ? await withCommanderRuntimeLaunch(
            automation.parentCommanderId,
            this.commanderDataDir,
            createSession,
          )
        : await createSession()
      sessionId = created.sessionId

      const completion = await client.monitorSession(sessionId, this.monitorOptions)
      await killSessionSafely()

      const completionSessionId = completion.sessionId || sessionId
      const transcriptRef = buildTranscriptRef(completionSessionId)
      const completionOutput = completion.finalComment
      const emptyOutputReason = resolveEmptyOutputReason(completionOutput, completion.status)
      const parsedOutput = parseStructuredOutput(completionOutput)
      const finishedAt = this.now().toISOString()
      const durationSec = Math.max(
        0,
        Math.round((new Date(finishedAt).getTime() - startedAtDate.getTime()) / 1000),
      )
      const costUsd = extractCostUsd(completion.raw)
      const historyEntry: AutomationHistoryEntry = {
        timestamp: finishedAt,
        action: parsedOutput.action,
        result: parsedOutput.result,
        costUsd,
        durationSec,
        runKey: runTimestampKey,
        sessionId: completionSessionId,
        transcriptRef,
        runFile,
        completionOutput,
        emptyOutputReason,
        memoryUpdated: parsedOutput.memoryUpdated,
        source,
      }
      const runMetadata: AutomationRunMetadata = {
        automationId: automation.id,
        automationName: automation.name,
        runNumber: (automation.totalRuns ?? 0) + 1,
        runKey: runTimestampKey,
        startedAt,
        timestamp: finishedAt,
        action: parsedOutput.action,
        result: parsedOutput.result,
        costUsd,
        durationSec,
        sessionId: completionSessionId,
        transcriptRef,
        completionOutput,
        emptyOutputReason,
        memoryUpdated: parsedOutput.memoryUpdated,
        status: completionToRunStatus(completion.status),
        source,
      }
      await writeRunMetadata(runMetadata)
      const updated = await this.store.appendHistory(automation.id, historyEntry)
      if (!updated) {
        return null
      }
      return { automation: updated, historyEntry }
    } catch (error) {
      const finishedAt = this.now().toISOString()
      const durationSec = Math.max(
        0,
        Math.round((new Date(finishedAt).getTime() - startedAtDate.getTime()) / 1000),
      )
      const status: AutomationRunMetadata['status'] = isSessionTimeoutError(error) ? 'timeout' : 'failed'
      const result = toErrorMessage(error)
      const historyEntry: AutomationHistoryEntry = {
        timestamp: finishedAt,
        action: 'ERROR',
        result,
        costUsd: 0,
        durationSec,
        runKey: runTimestampKey,
        sessionId,
        transcriptRef: buildTranscriptRef(sessionId),
        runFile,
        completionOutput: result,
        memoryUpdated: false,
        source,
      }
      const runMetadata: AutomationRunMetadata = {
        automationId: automation.id,
        automationName: automation.name,
        runNumber: (automation.totalRuns ?? 0) + 1,
        runKey: runTimestampKey,
        startedAt,
        timestamp: finishedAt,
        action: historyEntry.action,
        result,
        costUsd: 0,
        durationSec,
        sessionId,
        transcriptRef: buildTranscriptRef(sessionId),
        completionOutput: result,
        memoryUpdated: false,
        status,
        source,
      }
      await writeRunMetadata(runMetadata)
      const patch: UpdateAutomationInput = {}
      if (status === 'timeout' || status === 'failed') {
        patch.status = automation.status
      }
      await this.store.update(automation.id, patch)
      const updated = await this.store.appendHistory(automation.id, historyEntry)
      if (!updated) {
        return null
      }
      return { automation: updated, historyEntry }
    } finally {
      await killSessionSafely()
    }
  }
}
