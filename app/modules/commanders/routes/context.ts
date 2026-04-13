import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import multer from 'multer'
import { type Request, type Response as ExpressResponse } from 'express'
import { combinedAuth } from '../../../server/middleware/combined-auth.js'
import {
  CommandRoomRunStore,
  defaultCommandRoomRunStorePath,
  type WorkflowRun,
} from '../../command-room/run-store.js'
import {
  CommandRoomTaskStore,
  defaultCommandRoomTaskStorePath,
  type CreateCronTaskInput,
  type CronTask as CommandRoomCronTask,
} from '../../command-room/task-store.js'
import {
  resolveWorkspaceRoot,
  toWorkspaceError,
  WorkspaceError,
} from '../../workspace/index.js'
import { CommanderAgent } from '../agent.js'
import {
  buildFatHeartbeatMessage as appendHeartbeatChecklist,
  chooseHeartbeatMode,
  resolveFatPinInterval,
} from '../choose-heartbeat-mode.js'
import {
  profileForApiResponse,
  readCommanderUiProfile,
  resolveCommanderAvatarPath,
} from '../commander-profile.js'
import {
  CommanderEmailConfigStore,
  CommanderEmailStateStore,
} from '../email-config.js'
import { EmailPoller } from '../email-poller.js'
import {
  CommanderHeartbeatManager,
  DEFAULT_HEARTBEAT_MESSAGE,
  type CommanderHeartbeatState,
} from '../heartbeat.js'
import { HeartbeatLog, type HeartbeatLogAppendInput } from '../heartbeat-log.js'
import { CommanderManager, type CommanderSubagentLifecycleEvent } from '../manager.js'
import {
  type FlushContext,
  type JournalEntry,
  WorkingMemoryStore,
} from '../memory/index.js'
import { syncCommanderMemoryHybridIndex } from '../memory/recollection.js'
import type { GHIssue } from '../memory/skill-matcher.js'
import {
  resolveCommanderDataDir,
  resolveCommanderPaths,
} from '../paths.js'
import { QuestStore, type CommanderQuest } from '../quest-store.js'
import { resolveGitHubToken } from '../github-http.js'
import {
  buildCommanderMemoryCompactTaskName,
  COMMANDER_INSTRUCTION_TASK_TYPE,
  COMMANDER_MEMORY_COMPACT_TASK_TYPE,
  parseBearerToken,
  parseContextPressureInputTokenThreshold,
  parseMessage,
  parseSessionId,
  resolveWorkflowHeartbeatIntervalMs,
} from '../route-parsers.js'
import { runSemanticSearchScript } from '../semantic-search-runner.js'
import {
  CommanderSessionStore,
  type CommanderChannelMeta,
  type CommanderCurrentTask,
  type CommanderLastRoute,
  type CommanderSession,
  type CommanderTaskSource,
} from '../store.js'
import { GhTasks } from '../tools/gh-tasks.js'
import {
  COMMANDER_WORKFLOW_FILE,
  loadCommanderWorkflow,
  mergeWorkflows,
  type CommanderWorkflow,
} from '../workflow.js'
import type {
  CommanderChannelReplyDispatchInput,
  CommanderCronScheduler,
  CommanderCronStores,
  CommanderCronTaskRecord,
  CommanderCronTaskResponse,
  CommanderRoutesContext,
  CommanderRuntime,
  CommanderSessionResponse,
  CommanderSessionSeedParams,
  CommanderSessionStats,
  CommanderSubAgentEntry,
  CommandersRouterOptions,
  ContextPressureBridge,
  ResolvedCommanderWorkflow,
  StreamEvent,
} from './types.js'

const STARTUP_PROMPT = 'Commander runtime started. Acknowledge readiness and await instructions.'
const BASE_SYSTEM_PROMPT =
  'You are Commander, the orchestration agent for GitHub task execution. Follow repo instructions exactly.'
const COMMANDER_SESSION_NAME_PREFIX = 'commander-'
const DEFAULT_AGENTS_SESSION_STORE_PATH = 'data/agents/stream-sessions.json'
const COLLECT_MODE_DEBOUNCE_MS = 1_000
const DEFAULT_COMMANDER_MEMORY_COMPACT_CRON = '0 2 * * *'
const DEFAULT_COMMANDER_MEMORY_COMPACT_TIMEZONE = 'UTC'
const COMMANDER_MEMORY_COMPACT_INSTRUCTION = 'Run internal commander memory compaction maintenance.'

export { BASE_SYSTEM_PROMPT, STARTUP_PROMPT }

export function toCommanderSessionName(commanderId: string): string {
  return `${COMMANDER_SESSION_NAME_PREFIX}${commanderId}`
}

function mergeCommanderWorkflowPromptTemplates(
  commanderWorkflow: CommanderWorkflow | null,
  workspaceWorkflow: CommanderWorkflow | null,
): string | undefined {
  const commanderPrompt = commanderWorkflow?.systemPromptTemplate?.trim() ?? ''
  const workspacePrompt = workspaceWorkflow?.systemPromptTemplate?.trim() ?? ''

  if (commanderPrompt && workspacePrompt) {
    return `${commanderPrompt}\n\n## Workspace Context\n${workspacePrompt}`
  }

  if (workspacePrompt) {
    return workspacePrompt
  }

  if (commanderPrompt) {
    return commanderPrompt
  }

  return undefined
}

function parsePersistedCommanderSessionNames(value: unknown): Set<string> {
  const parsed = new Set<string>()
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { sessions?: unknown }).sessions)
  ) {
    return parsed
  }

  for (const entry of (value as { sessions: unknown[] }).sessions) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const name = (entry as { name?: unknown }).name
    if (typeof name !== 'string' || !name.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
      continue
    }
    parsed.add(name)
  }

  return parsed
}

async function readPersistedCommanderSessionNames(
  sessionStorePath: string,
): Promise<Set<string>> {
  try {
    const raw = await readFile(sessionStorePath, 'utf8')
    return parsePersistedCommanderSessionNames(JSON.parse(raw) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set<string>()
    }
    throw error
  }
}

export async function resolveCommanderWorkflow(
  commanderId: string,
  cwd: string | undefined,
  commanderBasePath?: string,
): Promise<ResolvedCommanderWorkflow> {
  const commanderRoot = resolveCommanderPaths(commanderId, commanderBasePath).commanderRoot
  const [commanderWorkflow, workspaceWorkflow] = await Promise.all([
    loadCommanderWorkflow(commanderRoot),
    cwd ? loadCommanderWorkflow(cwd) : Promise.resolve(null),
  ])
  const mergedWorkflow = mergeWorkflows(commanderWorkflow, workspaceWorkflow)

  if (mergedWorkflow) {
    const mergedPromptTemplate = mergeCommanderWorkflowPromptTemplates(
      commanderWorkflow,
      workspaceWorkflow,
    )
    return {
      workflow: {
        ...mergedWorkflow,
        ...(mergedPromptTemplate ? { systemPromptTemplate: mergedPromptTemplate } : {}),
      },
      exists: true,
    }
  }

  return {
    workflow: null,
    exists: false,
  }
}

export async function commanderWorkflowFileExists(cwd: string): Promise<boolean> {
  try {
    await access(path.join(cwd, COMMANDER_WORKFLOW_FILE))
    return true
  } catch {
    return false
  }
}

export function resolveEffectiveBasePrompt(workflow: CommanderWorkflow | null): string {
  return workflow?.systemPromptTemplate?.trim().length
    ? workflow.systemPromptTemplate
    : BASE_SYSTEM_PROMPT
}

export function resolveEffectiveHeartbeat(
  heartbeat: CommanderHeartbeatState,
  workflow: CommanderWorkflow | null,
): CommanderHeartbeatState {
  const workflowHeartbeatIntervalMs = resolveWorkflowHeartbeatIntervalMs(workflow?.heartbeatInterval)
  const shouldApplyWorkflowInterval = workflowHeartbeatIntervalMs !== undefined
    && heartbeat.intervalOverridden !== true
  const shouldApplyWorkflowMessage = workflow?.heartbeatMessage !== undefined
    && heartbeat.messageTemplate.trim() === DEFAULT_HEARTBEAT_MESSAGE.trim()
  return {
    ...heartbeat,
    ...(shouldApplyWorkflowInterval
      ? { intervalMs: workflowHeartbeatIntervalMs }
      : {}),
    ...(shouldApplyWorkflowMessage
      ? { messageTemplate: workflow.heartbeatMessage }
      : {}),
  }
}

export function warnInvalidWorkflowHeartbeatInterval(
  commanderId: string,
  workflow: ResolvedCommanderWorkflow,
): void {
  const workflowInterval = workflow.workflow?.heartbeatInterval
  if (workflowInterval !== undefined && resolveWorkflowHeartbeatIntervalMs(workflowInterval) === undefined) {
    console.warn(
      `[commanders] Invalid COMMANDER.md heartbeat.interval "${workflowInterval}" for "${commanderId}" (must be a positive integer milliseconds value); using stored interval.`,
    )
  }
}

export function isLegacyContextPressureEvent(event: StreamEvent): boolean {
  const type = typeof event.type === 'string' ? event.type : ''
  const subtype = typeof event.subtype === 'string' ? event.subtype : ''
  return type === 'context_pressure' || subtype === 'context_pressure'
}

function isUsageBearingContextPressureEvent(event: StreamEvent): boolean {
  const type = typeof event.type === 'string' ? event.type : ''
  return type === 'message_delta' || type === 'result'
}

export function isInputTokenContextPressureEvent(
  event: StreamEvent,
  sessionInputTokens: number,
  threshold: number,
): boolean {
  if (!isUsageBearingContextPressureEvent(event)) {
    return false
  }

  return Number.isFinite(sessionInputTokens) && sessionInputTokens >= threshold
}

function toPromptIssueFromTaskContext(
  currentTask: CommanderCurrentTask | null,
  taskSource: CommanderTaskSource | null,
): GHIssue | null {
  if (!currentTask || !taskSource) {
    return null
  }

  const labels = taskSource.label ? [{ name: taskSource.label }] : undefined
  return {
    number: currentTask.issueNumber,
    title: `Issue #${currentTask.issueNumber}`,
    body: '',
    labels,
    owner: taskSource.owner,
    repo: taskSource.repo,
    repository: `${taskSource.owner}/${taskSource.repo}`,
  }
}

export function toPromptIssue(session: CommanderSession): GHIssue | null {
  return toPromptIssueFromTaskContext(session.currentTask, session.taskSource)
}

export async function buildCommanderSessionSeedFromResolvedWorkflow(
  params: CommanderSessionSeedParams,
  resolvedWorkflow: ResolvedCommanderWorkflow,
): Promise<{ systemPrompt: string; maxTurns?: number }> {
  const agent = new CommanderAgent(params.commanderId, params.memoryBasePath)
  const built = await agent.buildTaskPickupSystemPrompt(
    resolveEffectiveBasePrompt(resolvedWorkflow.workflow),
    {
      currentTask: toPromptIssueFromTaskContext(params.currentTask, params.taskSource),
      recentConversation: [],
    },
  )

  return {
    systemPrompt: built.systemPrompt,
    maxTurns: resolvedWorkflow.workflow?.maxTurns,
  }
}

export async function buildCommanderSessionSeed(
  params: CommanderSessionSeedParams,
): Promise<{ systemPrompt: string; maxTurns?: number }> {
  const resolvedWorkflow = await resolveCommanderWorkflow(
    params.commanderId,
    params.cwd,
    params.memoryBasePath,
  )
  return buildCommanderSessionSeedFromResolvedWorkflow(params, resolvedWorkflow)
}

export function buildFlushContext(
  session: CommanderSession,
  runtime: CommanderRuntime,
): Omit<FlushContext, 'trigger'> {
  const repo = toSessionRepo(session) ?? ''
  return {
    currentIssue: session.currentTask
      ? {
          number: session.currentTask.issueNumber,
          repo,
          url: session.currentTask.issueUrl,
          title: `Issue #${session.currentTask.issueNumber}`,
        }
      : null,
    taskState: runtime.lastTaskState || 'Commander running',
    pendingSpikeObservations: [...runtime.pendingSpikeObservations],
  }
}

export function toSessionRepo(session: CommanderSession | null | undefined): string | null {
  if (!session?.taskSource) return null
  const owner = session.taskSource.owner?.trim()
  const repo = session.taskSource.repo?.trim()
  if (!owner || !repo) return null
  return `${owner}/${repo}`
}

export function extractHypothesisFromMessage(message: string): string | null {
  const lower = message.toLowerCase()
  const marker = 'hypothesis:'
  const idx = lower.indexOf(marker)
  if (idx === -1) return null
  const raw = message.slice(idx + marker.length).split('\n')[0]?.trim() ?? ''
  return raw.length > 0 ? raw : null
}

export function extractFileMentionsFromMessage(message: string): string[] {
  const matches = message.match(/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8}/g) ?? []
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const match of matches) {
    const normalized = match.replace(/^\.\/+/, '').trim()
    if (!normalized) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    deduped.push(normalized)
    if (deduped.length >= 12) break
  }
  return deduped
}

function compactSingleLine(message: string, maxLen: number = 260): string {
  const normalized = message.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLen) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, maxLen - 3))}...`
}

function formatSubAgentLifecycleSummary(event: CommanderSubagentLifecycleEvent): string {
  const prefix = event.state === 'running'
    ? 'Sub-agent dispatched'
    : event.state === 'completed'
      ? 'Sub-agent completed'
      : 'Sub-agent failed'
  const details = event.result?.trim()
    ? ` — ${compactSingleLine(event.result, 180)}`
    : ''
  return `${prefix}: ${event.sessionId}${details}`
}

function resolveSubAgentLifecycleSalience(
  event: CommanderSubagentLifecycleEvent,
): JournalEntry['salience'] {
  if (event.state === 'failed') return 'SPIKE'
  if (event.state === 'completed') return 'NOTABLE'
  return 'ROUTINE'
}

export function listSubAgentEntries(runtime: CommanderRuntime | undefined): CommanderSubAgentEntry[] {
  if (!runtime) {
    return []
  }
  return [...runtime.subAgents.values()]
    .sort((left, right) => left.dispatchedAt.localeCompare(right.dispatchedAt))
}

function consumeCompletedSubAgentEntries(runtime: CommanderRuntime): CommanderSubAgentEntry[] {
  const completed: CommanderSubAgentEntry[] = []
  for (const [sessionId, entry] of runtime.subAgents.entries()) {
    if (entry.state !== 'completed') {
      continue
    }
    completed.push(entry)
    runtime.subAgents.delete(sessionId)
  }
  completed.sort((left, right) => left.dispatchedAt.localeCompare(right.dispatchedAt))
  return completed
}

function formatSubAgentResultsSection(completedEntries: CommanderSubAgentEntry[]): string | null {
  if (completedEntries.length === 0) {
    return null
  }

  return [
    '[SUB-AGENT RESULTS]',
    ...completedEntries.map((entry, index) => {
      const summary = entry.result?.trim() || 'No sub-agent summary provided.'
      return `${index + 1}. ${entry.sessionId}: ${summary}`
    }),
  ].join('\n')
}

function toHeartbeatLogTaskSnapshot(session: CommanderSession | null): {
  questCount: number
  claimedQuestId?: string
  claimedQuestInstruction?: string
} {
  const claimedTask = session?.currentTask
  if (!claimedTask) {
    return { questCount: 0 }
  }

  return {
    questCount: 1,
    claimedQuestId: String(claimedTask.issueNumber),
    claimedQuestInstruction: `Issue #${claimedTask.issueNumber}`,
  }
}

export function resolveCommanderAgentType(
  session: Pick<CommanderSession, 'agentType'>,
): 'claude' | 'codex' | 'gemini' {
  if (session.agentType === 'codex' || session.agentType === 'gemini') {
    return session.agentType
  }
  return 'claude'
}

export function toCommanderSessionResponse(
  session: CommanderSession,
  runtime?: CommanderRuntime | undefined,
  stats: CommanderSessionStats = { questCount: 0, scheduleCount: 0 },
): CommanderSessionResponse & {
  contextConfig: { fatPinInterval: number }
  runtime: { heartbeatCount: number }
} {
  const normalizedAgentType = resolveCommanderAgentType(session)
  const base = session.remoteOrigin
    ? {
        ...session,
        name: session.host,
        agentType: normalizedAgentType,
        remoteOrigin: {
          machineId: session.remoteOrigin.machineId,
          label: session.remoteOrigin.label,
        },
      }
    : {
        ...session,
        name: session.host,
        agentType: normalizedAgentType,
      }

  return {
    ...base,
    name: session.host,
    questCount: stats.questCount,
    scheduleCount: stats.scheduleCount,
    contextConfig: {
      fatPinInterval: resolveFatPinInterval(session.contextConfig?.fatPinInterval),
    },
    runtime: {
      heartbeatCount: runtime?.heartbeatCount ?? session.heartbeatTickCount ?? 0,
    },
  }
}

export function createContextPressureBridge(): ContextPressureBridge {
  const handlers = new Set<() => Promise<void> | void>()
  return {
    onContextPressure(handler: () => Promise<void> | void): void {
      handlers.add(handler)
    },
    async trigger(): Promise<void> {
      for (const handler of handlers) {
        await handler()
      }
    },
  }
}

function toCommanderCronTask(
  task: CommandRoomCronTask,
  fallbackCommanderId: string,
  metadata: {
    lastRun?: string | null
    nextRun?: string | null
  } = {},
): CommanderCronTaskResponse {
  return {
    id: task.id,
    commanderId: task.commanderId ?? fallbackCommanderId,
    schedule: task.schedule,
    instruction: task.instruction,
    taskType: task.taskType ?? COMMANDER_INSTRUCTION_TASK_TYPE,
    enabled: task.enabled,
    lastRun: metadata.lastRun ?? null,
    nextRun: metadata.nextRun ?? null,
    agentType: task.agentType,
    ...(task.sessionType ? { sessionType: task.sessionType } : {}),
    ...(task.permissionMode ? { permissionMode: task.permissionMode } : {}),
    ...(task.workDir ? { workDir: task.workDir } : {}),
    ...(task.machine ? { machine: task.machine } : {}),
  }
}

function pickLatestWorkflowRun(runs: Array<WorkflowRun | null | undefined>): WorkflowRun | null {
  let latest: WorkflowRun | null = null
  for (const run of runs) {
    if (!run) {
      continue
    }
    if (!latest) {
      latest = run
      continue
    }
    const latestTimestamp = latest.completedAt ?? latest.startedAt
    const candidateTimestamp = run.completedAt ?? run.startedAt
    if (
      candidateTimestamp > latestTimestamp ||
      (candidateTimestamp === latestTimestamp && run.startedAt > latest.startedAt)
    ) {
      latest = run
    }
  }
  return latest
}

function resolveCommanderCronStorePaths(
  commanderId: string,
  basePath?: string,
): {
  tasksPath: string
  runsPath: string
} {
  const commanderPaths = resolveCommanderPaths(commanderId, basePath)
  const cronRoot = path.join(commanderPaths.memoryRoot, 'cron')
  return {
    tasksPath: path.join(cronRoot, 'tasks.json'),
    runsPath: path.join(cronRoot, 'runs.json'),
  }
}

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
    if (allowed.has(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'))
    }
  },
})

export function buildQuestInstructionFromGitHubIssue(issue: { title: string; body: string }): string {
  const title = issue.title.trim()
  const body = issue.body.trim()
  if (title && body) {
    return `${title}\n\n${body}`
  }
  return title || body || 'Review and execute the linked GitHub issue.'
}

export function summarizeQuestInstruction(instruction: string): string {
  const firstLine = instruction
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ?? instruction
}

function formatPendingQuestsSummary(pendingQuests: CommanderQuest[]): string | null {
  if (pendingQuests.length === 0) {
    return null
  }

  return [
    '[QUEST BOARD] Top pending quests:',
    ...pendingQuests.slice(0, 3).map((quest, index) => `${index + 1}. ${summarizeQuestInstruction(quest.instruction)}`),
  ].join('\n')
}

export function buildCommandersContext(
  options: CommandersRouterOptions = {},
): CommanderRoutesContext {
  const commanderDataDir = options.sessionStorePath
    ? path.dirname(path.resolve(options.sessionStorePath))
    : resolveCommanderDataDir()
  const commanderBasePath = options.memoryBasePath ?? commanderDataDir
  const now = options.now ?? (() => new Date())
  const contextPressureInputTokenThreshold = parseContextPressureInputTokenThreshold(
    options.contextPressureInputTokenThreshold,
  )
  const fetchImpl = options.fetchImpl ?? fetch
  const githubToken = resolveGitHubToken(options.githubToken)
  const sessionStore = options.sessionStore ?? new CommanderSessionStore(options.sessionStorePath)
  const emailStoresDataDir = parseMessage(options.memoryBasePath)
    ?? parseMessage(options.heartbeatBasePath)
    ?? commanderDataDir
  const questStore = options.questStore ?? (
    options.questStoreDataDir
      ? new QuestStore(options.questStoreDataDir)
      : options.sessionStorePath
        ? new QuestStore(path.dirname(path.resolve(options.sessionStorePath)))
        : new QuestStore()
  )
  const emailConfigStore = options.emailConfigStore ?? new CommanderEmailConfigStore(emailStoresDataDir)
  const emailStateStore = options.emailStateStore ?? new CommanderEmailStateStore(emailStoresDataDir)
  const ghTasksFactory = options.ghTasksFactory ?? ((repo: string) => new GhTasks({ repo }))
  const sharedCommanderCronStores = (
    options.commandRoomTaskStore || options.commandRoomRunStore
  )
    ? {
        taskStore: options.commandRoomTaskStore ?? new CommandRoomTaskStore(),
        runStore: options.commandRoomRunStore ?? new CommandRoomRunStore(),
      }
    : null
  const legacyCommanderCronStores = sharedCommanderCronStores
    ? null
    : {
        taskStore: new CommandRoomTaskStore(defaultCommandRoomTaskStorePath()),
        runStore: new CommandRoomRunStore({
          filePath: defaultCommandRoomRunStorePath(),
          commanderDataDir: commanderBasePath,
        }),
      }
  const commandRoomScheduler = options.commandRoomScheduler
  const commandRoomSchedulerInitialized = commandRoomScheduler
    ? (options.commandRoomSchedulerInitialized ?? Promise.resolve())
    : Promise.resolve()
  const runSemanticSearch = options.semanticSearchRunner ?? runSemanticSearchScript
  const commanderCronStoresById = new Map<string, CommanderCronStores>()
  const sendWorkspaceError = (res: ExpressResponse, error: unknown): void => {
    const workspaceError = toWorkspaceError(error)
    res.status(workspaceError.statusCode).json({ error: workspaceError.message })
  }

  async function defaultRefreshCommanderMemoryIndex(commanderId: string): Promise<void> {
    try {
      await syncCommanderMemoryHybridIndex(commanderId, commanderBasePath)
    } catch (error) {
      console.warn(
        `[commanders] Failed to refresh commander memory index for "${commanderId}":`,
        error,
      )
    }
  }
  const refreshCommanderMemoryIndex =
    options.refreshCommanderMemoryIndex ?? defaultRefreshCommanderMemoryIndex

  async function resolveCommanderWorkspace(rawCommanderId: unknown) {
    const commanderId = parseSessionId(rawCommanderId)
    if (!commanderId) {
      throw new WorkspaceError(400, 'Invalid commander id')
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      throw new WorkspaceError(404, `Commander "${commanderId}" not found`)
    }

    return resolveWorkspaceRoot({
      rootPath: session.cwd,
      source: {
        kind: 'commander',
        id: session.id,
        label: session.host,
        host: session.remoteOrigin?.machineId,
        readOnly: true,
        repo: session.taskSource
          ? {
              owner: session.taskSource.owner,
              repo: session.taskSource.repo,
            }
          : undefined,
      },
    })
  }

  const getCommanderCronStores = (commanderId: string): CommanderCronStores => {
    if (sharedCommanderCronStores) {
      return sharedCommanderCronStores
    }
    const existing = commanderCronStoresById.get(commanderId)
    if (existing) {
      return existing
    }
    const paths = resolveCommanderCronStorePaths(commanderId, commanderBasePath)
    const created: CommanderCronStores = {
      taskStore: new CommandRoomTaskStore(paths.tasksPath),
      runStore: new CommandRoomRunStore(paths.runsPath),
    }
    commanderCronStoresById.set(commanderId, created)
    return created
  }

  const listCommanderCronRunStores = (commanderId: string): CommandRoomRunStore[] => {
    const runStores = [getCommanderCronStores(commanderId).runStore]
    if (legacyCommanderCronStores && !runStores.includes(legacyCommanderCronStores.runStore)) {
      runStores.push(legacyCommanderCronStores.runStore)
    }
    return runStores
  }

  const listCommanderCronTaskStores = (commanderId: string): CommandRoomTaskStore[] => {
    const taskStores = [getCommanderCronStores(commanderId).taskStore]
    if (legacyCommanderCronStores && !taskStores.includes(legacyCommanderCronStores.taskStore)) {
      taskStores.push(legacyCommanderCronStores.taskStore)
    }
    return taskStores
  }

  const listCommanderCronTasksWithStores = async (
    commanderId: string,
  ): Promise<CommanderCronTaskRecord[]> => {
    const primaryStores = getCommanderCronStores(commanderId)
    const tasksById = new Map<string, CommanderCronTaskRecord>()

    const primaryTasks = await primaryStores.taskStore.listTasks({ commanderId })
    for (const task of primaryTasks) {
      tasksById.set(task.id, { task, stores: primaryStores })
    }

    if (legacyCommanderCronStores) {
      const legacyTasks = await legacyCommanderCronStores.taskStore.listTasks({ commanderId })
      for (const task of legacyTasks) {
        if (!tasksById.has(task.id)) {
          tasksById.set(task.id, { task, stores: legacyCommanderCronStores })
        }
      }
    }

    return [...tasksById.values()]
  }

  const getCommanderSessionStats = async (commanderId: string): Promise<CommanderSessionStats> => {
    await commandRoomSchedulerInitialized
    const [quests, cronTasks] = await Promise.all([
      questStore.list(commanderId),
      listCommanderCronTasksWithStores(commanderId),
    ])

    return {
      questCount: quests.length,
      scheduleCount: cronTasks.length,
    }
  }

  const findCommanderCronTaskWithStores = async (
    commanderId: string,
    taskId: string,
  ): Promise<CommanderCronTaskRecord | null> => {
    const primaryStores = getCommanderCronStores(commanderId)
    const primaryTask = await primaryStores.taskStore.getTask(taskId)
    if (primaryTask?.commanderId === commanderId) {
      return {
        task: primaryTask,
        stores: primaryStores,
      }
    }

    if (legacyCommanderCronStores) {
      const legacyTask = await legacyCommanderCronStores.taskStore.getTask(taskId)
      if (legacyTask?.commanderId === commanderId) {
        return {
          task: legacyTask,
          stores: legacyCommanderCronStores,
        }
      }
    }

    return null
  }

  const commanderMemoryCompactEnsureQueue = new Map<string, Promise<void>>()
  const ensureCommanderMemoryCompactCronTask = (commanderId: string): Promise<void> => {
    const previous = commanderMemoryCompactEnsureQueue.get(commanderId) ?? Promise.resolve()
    const next = previous.then(async () => {
      await commandRoomSchedulerInitialized
      const taskRecords = await listCommanderCronTasksWithStores(commanderId)
      const hasMemoryCompactTask = taskRecords.some(({ task }) => (
        task.taskType === COMMANDER_MEMORY_COMPACT_TASK_TYPE ||
        (
          task.name === buildCommanderMemoryCompactTaskName(commanderId) &&
          task.schedule === DEFAULT_COMMANDER_MEMORY_COMPACT_CRON &&
          task.instruction === COMMANDER_MEMORY_COMPACT_INSTRUCTION
        )
      ))
      if (hasMemoryCompactTask) {
        return
      }

      const createInput: CreateCronTaskInput = {
        name: buildCommanderMemoryCompactTaskName(commanderId),
        commanderId,
        schedule: DEFAULT_COMMANDER_MEMORY_COMPACT_CRON,
        timezone: DEFAULT_COMMANDER_MEMORY_COMPACT_TIMEZONE,
        machine: '',
        workDir: '',
        agentType: 'claude',
        instruction: COMMANDER_MEMORY_COMPACT_INSTRUCTION,
        taskType: COMMANDER_MEMORY_COMPACT_TASK_TYPE,
        enabled: true,
      }
      if (commandRoomScheduler) {
        await commandRoomScheduler.createTask(createInput)
        return
      }
      await getCommanderCronStores(commanderId).taskStore.createTask(createInput)
    })

    const guarded = next.catch(() => {})
    commanderMemoryCompactEnsureQueue.set(commanderId, guarded)
    return next.finally(() => {
      if (commanderMemoryCompactEnsureQueue.get(commanderId) === guarded) {
        commanderMemoryCompactEnsureQueue.delete(commanderId)
      }
    })
  }

  void (async () => {
    try {
      await commandRoomSchedulerInitialized
      const sessions = await sessionStore.list()
      for (const session of sessions) {
        await ensureCommanderMemoryCompactCronTask(session.id)
      }
    } catch (error) {
      console.warn('[commanders] Failed to backfill memory compact cron tasks:', error)
    }
  })()

  const heartbeatDataDir = parseMessage(options.heartbeatBasePath) ?? parseMessage(commanderBasePath)
  const heartbeatLog = options.heartbeatLog ?? new HeartbeatLog(
    heartbeatDataDir ? { dataDir: heartbeatDataDir } : undefined,
  )
  const sessionsInterface = options.sessionsInterface
  const channelReplyDispatchers = options.channelReplyDispatchers ?? {}
  const agentsSessionStorePath = path.resolve(
    options.agentsSessionStorePath ?? DEFAULT_AGENTS_SESSION_STORE_PATH,
  )
  const runtimes = new Map<string, CommanderRuntime>()
  const activeCommanderSessions = new Map<string, { sessionName: string; startedAt: string }>()
  const heartbeatFiredAtByCommander = new Map<string, string>()
  const emailReplyService = options.emailPoller ?? (
    sessionsInterface
      ? new EmailPoller({
          sessionStore,
          configStore: emailConfigStore,
          stateStore: emailStateStore,
          sessionsInterface,
          ...(options.emailClient ? { emailClient: options.emailClient } : {}),
          now,
        })
      : null
  )

  const buildCommanderCronTask = async (
    task: CommandRoomCronTask,
    fallbackCommanderId: string,
  ): Promise<CommanderCronTaskResponse> => {
    const runStores = listCommanderCronRunStores(fallbackCommanderId)
    const latestByStore = await Promise.all(
      runStores.map((runStore) => runStore.listLatestRunsByTaskIds([task.id])),
    )
    const latestRun = pickLatestWorkflowRun(latestByStore.map((runs) => runs.get(task.id)))
    return toCommanderCronTask(task, fallbackCommanderId, {
      lastRun: latestRun?.completedAt ?? latestRun?.startedAt ?? null,
      nextRun: commandRoomScheduler?.getNextRun?.(task.id)?.toISOString() ?? null,
    })
  }

  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:read'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  const onSubagentLifecycleEvent = (
    commanderId: string,
    event: CommanderSubagentLifecycleEvent,
  ): void => {
    const runtime = runtimes.get(commanderId)
    if (!runtime) {
      return
    }

    const existing = runtime.subAgents.get(event.sessionId)
    runtime.subAgents.set(event.sessionId, {
      sessionId: event.sessionId,
      dispatchedAt: existing?.dispatchedAt ?? event.dispatchedAt,
      state: event.state,
      result: event.result?.trim() || existing?.result,
    })

    void (async () => {
      const session = await sessionStore.get(commanderId)
      const issueNumber = session?.currentTask?.issueNumber ?? null
      const repo = toSessionRepo(session)
      const summary = formatSubAgentLifecycleSummary(event)

      await runtime.workingMemory.update({
        source: 'system',
        summary,
        issueNumber,
        repo,
        tags: ['subagent', event.state],
      })

      if (event.state === 'running') {
        return
      }

      await runtime.manager.journalWriter.append({
        timestamp: now().toISOString(),
        issueNumber,
        repo,
        outcome: event.state === 'completed' ? 'Sub-agent result captured' : 'Sub-agent failure captured',
        durationMin: null,
        salience: resolveSubAgentLifecycleSalience(event),
        body: [
          `- Session: \`${event.sessionId}\``,
          `- State: ${event.state}`,
          `- Result: ${event.result?.trim() || '_no summary provided_'}`,
        ].join('\n'),
      })
      await refreshCommanderMemoryIndex(commanderId)
    })().catch((error) => {
      console.error(
        `[commanders] Failed to persist sub-agent lifecycle memory for "${commanderId}":`,
        error,
      )
    })
  }

  const scheduleCollectSend = (commanderId: string, runtime: CommanderRuntime): void => {
    if (runtime.collectTimer) {
      clearTimeout(runtime.collectTimer)
    }

    runtime.collectTimer = setTimeout(() => {
      void (async () => {
        runtime.collectTimer = null
        const merged = runtime.pendingCollect.splice(0).join('\n\n').trim()
        if (!merged || !sessionsInterface) {
          return
        }

        if (runtimes.get(commanderId) !== runtime) {
          return
        }

        const sessionName = activeCommanderSessions.get(commanderId)?.sessionName
          ?? toCommanderSessionName(commanderId)
        const sent = await sessionsInterface.sendToSession(sessionName, merged)
        if (!sent) {
          console.warn(`[commanders] Collect mode send failed for "${commanderId}" (session unavailable).`)
        }
      })().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[commanders] Collect mode send failed for "${commanderId}": ${message}`)
      })
    }, COLLECT_MODE_DEBOUNCE_MS)
  }

  const remoteSyncSharedSecret = parseMessage(
    options.remoteSyncSharedSecret ?? process.env.COMMANDER_REMOTE_SYNC_SHARED_SECRET,
  )

  const authorizeRemoteSync = (
    req: Request,
    session: CommanderSession,
  ): { ok: true } | { ok: false; status: number; error: string } => {
    const bearerToken = parseBearerToken(req)
    if (!bearerToken) {
      return {
        ok: false,
        status: 401,
        error: 'Bearer token is required',
      }
    }

    if (remoteSyncSharedSecret && bearerToken === remoteSyncSharedSecret) {
      return { ok: true }
    }

    if (session.remoteOrigin?.syncToken && bearerToken === session.remoteOrigin.syncToken) {
      return { ok: true }
    }

    return {
      ok: false,
      status: 403,
      error: 'Invalid sync token',
    }
  }

  const heartbeatManager = new CommanderHeartbeatManager({
    now,
    preCompactionFlush: sessionsInterface
      ? {
          getConversationEntryCount(commanderId: string): number | null {
            const active = activeCommanderSessions.get(commanderId)
            if (!active) return null
            const session = sessionsInterface.getSession(active.sessionName)
            return session?.conversationEntryCount ?? null
          },
          async sendFlushMessage(commanderId: string, message: string): Promise<boolean> {
            const active = activeCommanderSessions.get(commanderId)
            if (!active) return false
            return sessionsInterface.sendToSession(active.sessionName, message)
          },
        }
      : undefined,
    sendHeartbeat: async ({ commanderId, renderedMessage, timestamp }) => {
      const appendHeartbeatLog = async (
        input: HeartbeatLogAppendInput,
        label: string,
      ): Promise<void> => {
        try {
          await heartbeatLog.append(commanderId, input)
        } catch (appendError) {
          console.error(
            `[commanders] Failed to append heartbeat log (${label}) for "${commanderId}":`,
            appendError,
          )
        }
      }

      heartbeatFiredAtByCommander.set(commanderId, timestamp)
      const session = await sessionStore.get(commanderId)
      if (!session) return false  // commander deleted — valid stop
      if (session.state !== 'running') {
        if (session.state === 'idle') {
          // Idle commanders can be resumed without recreating the loop.
          await appendHeartbeatLog(
            {
              firedAt: timestamp,
              ...toHeartbeatLogTaskSnapshot(session),
              outcome: 'skipped',
              errorMessage: 'Commander idle — heartbeat skipped, loop alive',
            },
            'commander-idle',
          )
          heartbeatFiredAtByCommander.delete(commanderId)
          return true
        }

        await appendHeartbeatLog(
          {
            firedAt: timestamp,
            ...toHeartbeatLogTaskSnapshot(session),
            outcome: 'error',
            errorMessage: 'Commander session was not running when heartbeat fired',
          },
          'commander-not-running',
        )
        heartbeatFiredAtByCommander.delete(commanderId)
        return false
      }

      if (!sessionsInterface) {
        await appendHeartbeatLog(
          {
            firedAt: timestamp,
            ...toHeartbeatLogTaskSnapshot(session),
            outcome: 'error',
            errorMessage: 'sessionsInterface not configured',
          },
          'no-sessions-interface',
        )
        heartbeatFiredAtByCommander.delete(commanderId)
        return false
      }

      const sessionName = toCommanderSessionName(commanderId)
      const activeAgentSession = sessionsInterface.getSession(sessionName)
      const runtime = runtimes.get(commanderId)
      let heartbeatMessage: string

      const buildFatHeartbeatMessage = async (
        commanderBody: string,
        completedSubAgentEntries: CommanderSubAgentEntry[],
      ): Promise<string> => {
        const pendingQuests = await questStore.listPending(commanderId, 3)
        const pendingQuestsSummary = formatPendingQuestsSummary(pendingQuests)
        const subAgentResultsSection = formatSubAgentResultsSection(completedSubAgentEntries)
        return [commanderBody.trim(), pendingQuestsSummary, renderedMessage.trim(), subAgentResultsSection]
          .filter((section): section is string => typeof section === 'string' && section.trim().length > 0)
          .join('\n\n')
      }

      if (runtime) {
        const heartbeatMode = chooseHeartbeatMode(runtime, session, activeAgentSession)

        if (heartbeatMode === 'fat') {
          const workflow = await resolveCommanderWorkflow(
            commanderId,
            session.cwd,
            commanderBasePath,
          )
          const commanderBody = resolveEffectiveBasePrompt(workflow.workflow)
          const completedSubAgentEntries = consumeCompletedSubAgentEntries(runtime)
          heartbeatMessage = await buildFatHeartbeatMessage(
            commanderBody,
            completedSubAgentEntries,
          )
          const enriched = await appendHeartbeatChecklist(
            heartbeatMessage,
            commanderId,
            commanderBasePath,
          )
          if (enriched) heartbeatMessage = enriched
        } else {
          heartbeatMessage = renderedMessage
        }

        runtime.heartbeatCount += 1
        runtime.forceNextFatHeartbeat = false
        runtime.lastTaskState = heartbeatMessage
        runtime.pendingSpikeObservations = []
        void runtime.workingMemory.update({
          source: 'heartbeat',
          summary: '{heartbeat}',
          issueNumber: session.currentTask?.issueNumber ?? null,
          repo: toSessionRepo(session),
          tags: ['heartbeat', heartbeatMode],
        }).catch((error) => {
          console.error(`[commanders] Failed to update working memory on heartbeat for "${commanderId}":`, error)
        })
      } else {
        const heartbeatMode = chooseHeartbeatMode(
          {
            heartbeatCount: session.heartbeatTickCount ?? 0,
            forceNextFatHeartbeat: false,
          },
          session,
          activeAgentSession,
        )

        if (heartbeatMode === 'fat') {
          const workflow = await resolveCommanderWorkflow(
            commanderId,
            session.cwd,
            commanderBasePath,
          )
          const commanderBody = resolveEffectiveBasePrompt(workflow.workflow)
          heartbeatMessage = await buildFatHeartbeatMessage(commanderBody, [])
          const enriched = await appendHeartbeatChecklist(
            heartbeatMessage,
            commanderId,
            commanderBasePath,
          )
          if (enriched) heartbeatMessage = enriched
        } else {
          heartbeatMessage = renderedMessage
        }
      }

      const sent = await sessionsInterface.sendToSession(sessionName, heartbeatMessage)
      if (!sent) {
        await appendHeartbeatLog(
          {
            firedAt: timestamp,
            ...toHeartbeatLogTaskSnapshot(session),
            outcome: 'error',
            errorMessage: 'stream session unavailable',
          },
          'session-unavailable',
        )
        heartbeatFiredAtByCommander.delete(commanderId)
        return false
      }

      const taskSnapshot = toHeartbeatLogTaskSnapshot(session)
      const outcome = taskSnapshot.questCount > 0 ? 'ok' : 'no-quests'
      await appendHeartbeatLog(
        {
          firedAt: timestamp,
          ...taskSnapshot,
          outcome,
        },
        'heartbeat-success',
      )
      return true
    },
    onHeartbeatSent: async ({ commanderId, timestamp }) => {
      await sessionStore.updateLastHeartbeat(commanderId, timestamp)
    },
    onHeartbeatError: ({ commanderId, error }) => {
      const errorMessage = error instanceof Error ? error.message : String(error)
      void (async () => {
        const session = await sessionStore.get(commanderId)
        try {
          await heartbeatLog.append(commanderId, {
            firedAt: heartbeatFiredAtByCommander.get(commanderId) ?? now().toISOString(),
            ...toHeartbeatLogTaskSnapshot(session),
            outcome: 'error',
            errorMessage,
          })
        } catch (appendError) {
          console.error(
            `[commanders] Failed to append heartbeat error log for "${commanderId}":`,
            appendError,
          )
        }
      })().catch((appendError) => {
        console.error(
          `[commanders] Failed to append heartbeat error log for "${commanderId}":`,
          appendError,
        )
      })
    },
  })

  async function reconcileCommanderSessions(): Promise<void> {
    if (!sessionsInterface) {
      return
    }

    const persistedCommanderSessions = await readPersistedCommanderSessionNames(agentsSessionStorePath)
    const allCommanders = await sessionStore.list()
    const runningCommanders = allCommanders.filter((session) => session.state === 'running')
    for (const commander of runningCommanders) {
      const sessionName = toCommanderSessionName(commander.id)
      const liveSession = persistedCommanderSessions.has(sessionName)
        ? sessionsInterface.getSession(sessionName)
        : undefined
      if (liveSession) {
        const workflow = await resolveCommanderWorkflow(
          commander.id,
          commander.cwd,
          commanderBasePath,
        )
        warnInvalidWorkflowHeartbeatInterval(commander.id, workflow)
        const effectiveHeartbeat = resolveEffectiveHeartbeat(commander.heartbeat, workflow.workflow)
        activeCommanderSessions.set(commander.id, {
          sessionName,
          startedAt: liveSession.createdAt ?? commander.created,
        })
        heartbeatManager.start(commander.id, effectiveHeartbeat)
        continue
      }

      await sessionStore.update(commander.id, (current) => ({
        ...current,
        state: 'idle',
      }))
    }
  }

  const dispatchCommanderMessage = async (input: {
    commanderId: string
    message: string
    mode: 'collect' | 'followup'
    pendingSpikeObservations: string[]
    session?: CommanderSession
    runtime?: CommanderRuntime
  }): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
    const session = input.session ?? await sessionStore.get(input.commanderId)
    if (!session) {
      return { ok: false, status: 404, error: `Commander "${input.commanderId}" not found` }
    }

    const runtime = input.runtime ?? runtimes.get(input.commanderId)
    if (!runtime || session.state !== 'running') {
      return { ok: false, status: 409, error: `Commander "${input.commanderId}" is not running` }
    }

    runtime.lastTaskState = input.message
    runtime.pendingSpikeObservations = input.pendingSpikeObservations

    if (!sessionsInterface) {
      return { ok: false, status: 500, error: 'sessionsInterface not configured' }
    }

    const sessionName = activeCommanderSessions.get(input.commanderId)?.sessionName
      ?? toCommanderSessionName(input.commanderId)
    if (input.mode === 'followup') {
      const sent = await sessionsInterface.sendToSession(sessionName, input.message)
      if (!sent) {
        return {
          ok: false,
          status: 409,
          error: `Commander "${input.commanderId}" stream session unavailable`,
        }
      }
    } else {
      runtime.pendingCollect.push(input.message)
      scheduleCollectSend(input.commanderId, runtime)
    }

    const issueNumber = session.currentTask?.issueNumber ?? null
    const repo = toSessionRepo(session)
    const salience = input.pendingSpikeObservations.length > 0 ? 'SPIKE' : 'NOTABLE'
    const memoryTags = input.pendingSpikeObservations.length > 0
      ? ['instruction', 'spike']
      : ['instruction']
    try {
      await Promise.all([
        runtime.workingMemory.update({
          source: 'message',
          summary: input.message,
          issueNumber,
          repo,
          hypothesis: extractHypothesisFromMessage(input.message),
          files: extractFileMentionsFromMessage(input.message),
          tags: memoryTags,
        }),
        runtime.manager.journalWriter.append({
          timestamp: now().toISOString(),
          issueNumber,
          repo,
          outcome: 'Commander instruction received',
          durationMin: null,
          salience,
          body: [
            '### Instruction',
            input.message,
            ...(input.pendingSpikeObservations.length > 0
              ? ['', '### Pending Spike Observations', ...input.pendingSpikeObservations.map((spike) => `- ${spike}`)]
              : []),
          ].join('\n'),
        }),
      ])
      await refreshCommanderMemoryIndex(input.commanderId)
    } catch (memoryError) {
      console.error(`[commanders] Failed to persist message memory for "${input.commanderId}":`, memoryError)
    }

    return { ok: true }
  }

  const dispatchCommanderChannelReply = async (input: {
    commanderId: string
    message: string
  }): Promise<
    | {
      ok: true
      provider: CommanderChannelMeta['provider']
      sessionKey: string
      lastRoute: CommanderLastRoute
    }
    | { ok: false; status: number; error: string }
  > => {
    const session = await sessionStore.get(input.commanderId)
    if (!session) {
      return { ok: false, status: 404, error: `Commander "${input.commanderId}" not found` }
    }

    if (!session.channelMeta || !session.lastRoute) {
      return {
        ok: false,
        status: 409,
        error: `Commander "${input.commanderId}" has no external channel route`,
      }
    }

    const provider = session.channelMeta.provider
    const dispatcher = channelReplyDispatchers[provider]
    if (!dispatcher) {
      return {
        ok: false,
        status: 501,
        error: `No outbound dispatcher configured for provider "${provider}"`,
      }
    }

    const normalizedLastRoute: CommanderLastRoute = {
      ...session.lastRoute,
      channel: provider,
    }

    try {
      await dispatcher({
        commanderId: input.commanderId,
        message: input.message,
        channelMeta: {
          ...session.channelMeta,
        },
        lastRoute: normalizedLastRoute,
      } satisfies CommanderChannelReplyDispatchInput)
    } catch (error) {
      const details = error instanceof Error ? parseMessage(error.message) : null
      return {
        ok: false,
        status: 502,
        error: details ?? `Failed to dispatch outbound ${provider} reply`,
      }
    }

    return {
      ok: true,
      provider,
      sessionKey: session.channelMeta.sessionKey,
      lastRoute: normalizedLastRoute,
    }
  }

  const attachCommanderPublicUi = async (
    commanderId: string,
    payload: CommanderSessionResponse & {
      contextConfig: { fatPinInterval: number }
      runtime: { heartbeatCount: number }
    },
  ): Promise<
    CommanderSessionResponse & {
      contextConfig: { fatPinInterval: number }
      runtime: { heartbeatCount: number }
    }
  > => {
    const profile = await readCommanderUiProfile(commanderId, commanderBasePath)
    const avatarPath = await resolveCommanderAvatarPath(commanderId, commanderBasePath, profile)
    return {
      ...payload,
      ui: profileForApiResponse(profile),
      avatarUrl: avatarPath ? `/api/commanders/${encodeURIComponent(commanderId)}/avatar` : null,
    }
  }

  return {
    now,
    commanderDataDir,
    commanderBasePath,
    contextPressureInputTokenThreshold,
    fetchImpl,
    githubToken,
    sessionStore,
    questStore,
    emailConfigStore,
    emailStateStore,
    emailReplyService,
    ghTasksFactory,
    heartbeatLog,
    sessionsInterface,
    requireReadAccess,
    requireWriteAccess,
    heartbeatManager,
    runtimes,
    activeCommanderSessions,
    heartbeatFiredAtByCommander,
    avatarUpload,
    commandRoomScheduler,
    commandRoomSchedulerInitialized,
    runSemanticSearch,
    refreshCommanderMemoryIndex,
    sendWorkspaceError,
    resolveCommanderWorkspace,
    getCommanderSessionStats,
    listCommanderCronRunStores,
    listCommanderCronTaskStores,
    listCommanderCronTasksWithStores,
    findCommanderCronTaskWithStores,
    ensureCommanderMemoryCompactCronTask,
    buildCommanderCronTask,
    onSubagentLifecycleEvent,
    authorizeRemoteSync,
    dispatchCommanderMessage,
    dispatchCommanderChannelReply,
    attachCommanderPublicUi,
    reconcileCommanderSessions,
  }
}
