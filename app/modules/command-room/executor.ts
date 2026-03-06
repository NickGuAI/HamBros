import {
  AgentSessionClient,
  type AgentSessionCompletion,
  type AgentSessionCreateInput,
  type AgentSessionMonitorOptions,
} from '../commanders/tools/agent-session.js'
import { CommandRoomRunStore, type WorkflowRun, type WorkflowRunStatus } from './run-store.js'
import { CommandRoomTaskStore } from './task-store.js'

export type WorkflowTriggerSource = 'cron' | 'manual'

interface AgentSessionClientLike {
  createSession(input: AgentSessionCreateInput): Promise<{ sessionId: string }>
  monitorSession(
    sessionId: string,
    options?: AgentSessionMonitorOptions,
  ): Promise<AgentSessionCompletion>
}

export interface CommandRoomExecutorOptions {
  taskStore?: CommandRoomTaskStore
  runStore?: CommandRoomRunStore
  now?: () => Date
  monitorOptions?: AgentSessionMonitorOptions
  agentSessionFactory?: () => AgentSessionClientLike
  internalToken?: string
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
    asNumber(payload.total_cost_usd) ??
    asNumber(payload.cost_usd) ??
    asNumber(payload.totalCostUsd) ??
    asNumber(payload.costUsd)
  if (direct !== null) {
    return Math.max(0, direct)
  }

  const nested = payload.result
  if (isObject(nested)) {
    const value =
      asNumber(nested.total_cost_usd) ??
      asNumber(nested.cost_usd) ??
      asNumber(nested.totalCostUsd) ??
      asNumber(nested.costUsd)
    if (value !== null) {
      return Math.max(0, value)
    }
  }

  return 0
}

function isSessionTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return /did not complete after/i.test(error.message)
}

function resolveSessionName(taskId: string, now: Date): string {
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '')
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  return `command-room-${safeTaskId}-${timestamp}`
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
    console.warn('[command-room] WARNING: No internal token or HAMBROS_INTERNAL_API_KEY set - cron triggers may fail')
  }

  return () =>
    new AgentSessionClient({
      baseUrl: resolveBaseUrl(),
      apiKey: resolveApiKey(),
      internalToken,
    })
}

function completionToRunStatus(status: AgentSessionCompletion['status']): WorkflowRunStatus {
  if (status === 'SUCCESS' || status === 'PARTIAL') {
    return 'complete'
  }
  return 'failed'
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return 'Workflow execution failed without an error message.'
}

export class CommandRoomExecutor {
  private readonly taskStore: CommandRoomTaskStore
  private readonly runStore: CommandRoomRunStore
  private readonly now: () => Date
  private readonly monitorOptions?: AgentSessionMonitorOptions
  private readonly agentSessionFactory: () => AgentSessionClientLike
  private readonly internalToken?: string
  private readonly inFlightByTaskId = new Map<string, Promise<WorkflowRun | null>>()

  constructor(options: CommandRoomExecutorOptions = {}) {
    this.taskStore = options.taskStore ?? new CommandRoomTaskStore()
    this.runStore = options.runStore ?? new CommandRoomRunStore()
    this.now = options.now ?? (() => new Date())
    this.monitorOptions = options.monitorOptions
    this.internalToken = options.internalToken
    this.agentSessionFactory = options.agentSessionFactory ?? defaultAgentSessionFactory(options.internalToken)
  }

  async executeTask(
    taskId: string,
    source: WorkflowTriggerSource,
    opts?: { authToken?: string },
  ): Promise<WorkflowRun | null> {
    const inFlight = this.inFlightByTaskId.get(taskId)
    if (inFlight) {
      return inFlight
    }

    const execution = this.executeTaskInternal(taskId, source, opts?.authToken).finally(() => {
      this.inFlightByTaskId.delete(taskId)
    })
    this.inFlightByTaskId.set(taskId, execution)
    return execution
  }

  private async executeTaskInternal(
    taskId: string,
    source: WorkflowTriggerSource,
    authToken?: string,
  ): Promise<WorkflowRun | null> {
    const task = await this.taskStore.getTask(taskId)
    if (!task) {
      return null
    }

    if (source === 'cron' && !task.enabled) {
      return null
    }

    const startedAt = this.now().toISOString()
    const run = await this.runStore.createRun({
      cronTaskId: task.id,
      startedAt,
      completedAt: null,
      status: 'running',
      report: '',
      costUsd: 0,
      sessionId: '',
    })

    let sessionId = ''
    try {
      const client = authToken
        ? new AgentSessionClient({ baseUrl: resolveBaseUrl(), bearerToken: authToken })
        : this.agentSessionFactory()
      const created = await client.createSession({
        name: resolveSessionName(task.id, this.now()),
        task: task.instruction,
        agentType: task.agentType,
        cwd: task.workDir,
        host: task.machine,
        mode: (task.permissionMode as 'default' | 'acceptEdits' | 'dangerouslySkipPermissions' | undefined) ?? 'acceptEdits',
        sessionType: task.sessionType ?? 'stream',
      })
      sessionId = created.sessionId
      await this.runStore.updateRun(run.id, { sessionId })

      const completion = await client.monitorSession(sessionId, this.monitorOptions)
      const completedAt = this.now().toISOString()
      const updated = await this.runStore.updateRun(run.id, {
        status: completionToRunStatus(completion.status),
        completedAt,
        report: completion.finalComment.trim() || 'No completion report produced.',
        costUsd: extractCostUsd(completion.raw),
        sessionId,
      })

      if (updated) {
        return updated
      }

      return {
        ...run,
        status: completionToRunStatus(completion.status),
        completedAt,
        report: completion.finalComment.trim() || 'No completion report produced.',
        costUsd: extractCostUsd(completion.raw),
        sessionId,
      }
    } catch (error) {
      const completedAt = this.now().toISOString()
      const updated = await this.runStore.updateRun(run.id, {
        status: isSessionTimeoutError(error) ? 'timeout' : 'failed',
        completedAt,
        report: toErrorMessage(error),
        costUsd: 0,
        sessionId,
      })
      if (updated) {
        return updated
      }

      return {
        ...run,
        status: isSessionTimeoutError(error) ? 'timeout' : 'failed',
        completedAt,
        report: toErrorMessage(error),
        costUsd: 0,
        sessionId,
      }
    }
  }
}
