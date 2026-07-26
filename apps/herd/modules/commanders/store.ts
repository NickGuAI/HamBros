import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE,
  normalizeClaudeAdaptiveThinkingMode,
  type ClaudeAdaptiveThinkingMode,
} from '../claude-adaptive-thinking.js'
import { normalizeAgentEffort, type AgentEffortLevel } from '../agents/effort.js'
import {
  DEFAULT_CLAUDE_MAX_THINKING_TOKENS,
  normalizeClaudeMaxThinkingTokens,
  type ClaudeMaxThinkingTokens,
} from '../claude-max-thinking-tokens.js'
import { parseProviderId, resolveDefaultProviderId } from '../agents/providers/registry.js'
import type { ProviderSessionContext } from '../agents/providers/provider-session-context.js'
import type { AgentType } from '../agents/types.js'
import {
  normalizeHeartbeatConfig,
  type CommanderHeartbeatConfig,
} from './heartbeat.js'
import { resolveCommanderSessionStorePath } from './paths.js'
import {
  createDefaultCommanderRuntimeConfig,
  DEFAULT_COMMANDER_RUNTIME_DEFAULT_MAX_TURNS,
  type CommanderRuntimeConfig,
} from './runtime-config.shared.js'
import { writeJsonFileAtomically } from '../json-file.js'
import { withJsonStoreSchema } from '../json-store-schema.js'
import {
  parseCanonicalProviderContext,
} from '../agents/providers/provider-context-normalization.js'
import type { ChannelChatType, ChannelProvider } from '../channels/types.js'
import { withCommanderMutation } from './child-mutation-coordinator.js'

const COMMANDER_STATES = new Set<CommanderSession['state']>([
  'idle',
  'running',
  'paused',
  'stopped',
])

export const DEFAULT_COMMANDER_MAX_TURNS = DEFAULT_COMMANDER_RUNTIME_DEFAULT_MAX_TURNS
export type CommanderContextMode = 'thin' | 'fat'
export const DEFAULT_COMMANDER_CONTEXT_MODE: CommanderContextMode = 'fat'

export interface CommanderTaskSource {
  owner: string
  repo: string
  label?: string
  project?: string
}

export interface CommanderCurrentTask {
  issueNumber: number
  issueUrl: string
  startedAt: string
}

export interface HeartbeatContextConfig {
  fatPinInterval?: number
}

export interface CommanderRemoteOrigin {
  machineId: string
  label: string
  syncToken: string
}

export interface CommanderChannelMeta {
  provider: ChannelProvider
  chatType: ChannelChatType
  accountId: string
  peerId: string
  parentPeerId?: string
  groupId?: string
  threadId?: string
  references?: string[]
  sessionKey: string
  displayName: string
  subject?: string
  space?: string
}

export interface CommanderLastRoute {
  channel: string
  to: string
  accountId: string
  threadId?: string
}

export interface CommanderSession {
  id: string
  /** Stable commander identity slug. Never use this field for process routing. */
  host: string
  /** Explicit machine preference for provider execution. Omitted means runtime policy selects. */
  executionMachineId?: string
  avatarSeed?: string
  state: 'idle' | 'running' | 'paused' | 'stopped'
  created: string
  agentType?: AgentType
  model?: string | null
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  providerContext?: ProviderSessionContext
  cwd?: string
  heartbeat: CommanderHeartbeatConfig
  maxTurns: number
  costCapUsd?: number | null
  contextMode: CommanderContextMode
  contextConfig?: HeartbeatContextConfig
  taskSource: CommanderTaskSource | null
  operatorId?: string
  templateId?: string | null
  replicatedFromCommanderId?: string | null
  system?: boolean
  archived?: boolean
  archivedAt?: string
  remoteOrigin?: CommanderRemoteOrigin
}

export type CommanderConversationSurface =
  | 'discord'
  | 'slack'
  | 'email'
  | 'circle'
  | 'imessage'
  | 'matrix'
  | 'telegram'
  | 'whatsapp'
  | 'ui'
  | 'cli'
  | 'api'
  | (string & {})

interface ParsedCommanderSessions {
  sessions: CommanderSession[]
  needsExecutionMachineBackfill: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseTaskSource(raw: unknown): CommanderTaskSource | null {
  if (!isObject(raw)) {
    return null
  }

  const owner = typeof raw.owner === 'string' ? raw.owner.trim() : ''
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : ''
  if (!owner || !repo) {
    return null
  }

  const label = typeof raw.label === 'string' && raw.label.trim().length > 0
    ? raw.label.trim()
    : undefined
  const project = typeof raw.project === 'string' && raw.project.trim().length > 0
    ? raw.project.trim()
    : undefined

  return { owner, repo, label, project }
}

function parseHeartbeatContextConfig(raw: unknown): HeartbeatContextConfig | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }

  if (!isObject(raw)) {
    return undefined
  }

  const fatPinInterval = raw.fatPinInterval
  if (
    fatPinInterval === undefined ||
    (
      typeof fatPinInterval === 'number' &&
      Number.isInteger(fatPinInterval) &&
      fatPinInterval > 0
    )
  ) {
    return fatPinInterval === undefined
      ? {}
      : { fatPinInterval }
  }

  return undefined
}

function parseRemoteOrigin(raw: unknown): CommanderRemoteOrigin | undefined {
  if (!isObject(raw)) {
    return undefined
  }

  const machineId = typeof raw.machineId === 'string' ? raw.machineId.trim() : ''
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  const syncToken = typeof raw.syncToken === 'string' ? raw.syncToken.trim() : ''
  if (!machineId || !label || !syncToken) {
    return undefined
  }

  return {
    machineId,
    label,
    syncToken,
  }
}

function parseOptionalNonEmptyString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0
    ? raw.trim()
    : undefined
}

function parseChannelProvider(raw: unknown): CommanderChannelMeta['provider'] | null {
  if (typeof raw !== 'string') {
    return null
  }
  const normalized = raw.trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{1,63}$/i.test(normalized)
    ? normalized as CommanderChannelMeta['provider']
    : null
}

function parseChannelChatType(raw: unknown): CommanderChannelMeta['chatType'] | null {
  if (typeof raw !== 'string') {
    return null
  }
  const normalized = raw.trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{1,63}$/i.test(normalized)
    ? normalized as CommanderChannelMeta['chatType']
    : null
}

function parseOptionalStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const values = raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return values.length > 0 ? values : undefined
}

export function parseCommanderChannelMeta(raw: unknown): CommanderChannelMeta | undefined {
  if (!isObject(raw)) {
    return undefined
  }

  const provider = parseChannelProvider(raw.provider)
  const chatType = parseChannelChatType(raw.chatType)
  const accountId = parseOptionalNonEmptyString(raw.accountId)
  const peerId = parseOptionalNonEmptyString(raw.peerId)
  const sessionKey = parseOptionalNonEmptyString(raw.sessionKey)
  const displayName = parseOptionalNonEmptyString(raw.displayName)
  if (!provider || !chatType || !accountId || !peerId || !sessionKey || !displayName) {
    return undefined
  }

  return {
    provider,
    chatType,
    accountId,
    peerId,
    parentPeerId: parseOptionalNonEmptyString(raw.parentPeerId),
    groupId: parseOptionalNonEmptyString(raw.groupId),
    threadId: parseOptionalNonEmptyString(raw.threadId),
    references: parseOptionalStringList(raw.references),
    sessionKey,
    displayName,
    subject: parseOptionalNonEmptyString(raw.subject),
    space: parseOptionalNonEmptyString(raw.space),
  }
}

export function parseCommanderLastRoute(raw: unknown): CommanderLastRoute | undefined {
  if (!isObject(raw)) {
    return undefined
  }

  const channel = parseOptionalNonEmptyString(raw.channel)
  const to = parseOptionalNonEmptyString(raw.to)
  const accountId = parseOptionalNonEmptyString(raw.accountId)
  if (!channel || !to || !accountId) {
    return undefined
  }

  return {
    channel,
    to,
    accountId,
    threadId: parseOptionalNonEmptyString(raw.threadId),
  }
}

function parseCommanderMaxTurns(raw: unknown, runtimeConfig: CommanderRuntimeConfig): number {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 1
  ) {
    return runtimeConfig.defaults.maxTurns
  }

  return Math.min(raw, runtimeConfig.limits.maxTurns)
}

export function parseCommanderCostCapUsd(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? raw
    : null
}

function parseCommanderContextMode(raw: unknown): CommanderContextMode {
  return raw === 'thin'
    ? 'thin'
    : DEFAULT_COMMANDER_CONTEXT_MODE
}

function buildCommanderConversationHashId(seed: string): string {
  const hash = createHash('sha256')
    .update(seed)
    .digest('hex')

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}

export function buildDefaultCommanderConversationId(commanderId: string): string {
  return buildCommanderConversationHashId(`default-conversation:${commanderId}`)
}

function parseCommanderSession(
  raw: unknown,
  runtimeConfig: CommanderRuntimeConfig,
): CommanderSession | null {
  if (!isObject(raw)) {
    return null
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  const remoteOrigin = parseRemoteOrigin(raw.remoteOrigin)
  const executionMachineId = parseOptionalNonEmptyString(raw.executionMachineId)
    ?? remoteOrigin?.machineId
  const avatarSeed = typeof raw.avatarSeed === 'string' && raw.avatarSeed.trim().length > 0
    ? raw.avatarSeed.trim()
    : undefined
  const created = typeof raw.created === 'string' ? raw.created.trim() : ''
  const agentType = parseProviderId(raw.agentType) ?? resolveDefaultProviderId()
  const model = raw.model === null
    ? null
    : (typeof raw.model === 'string' && raw.model.trim().length > 0 ? raw.model.trim() : undefined)
  const effort = normalizeAgentEffort(agentType, raw.effort)
  const adaptiveThinking = normalizeClaudeAdaptiveThinkingMode(
    raw.adaptiveThinking,
    DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE,
  )
  const maxThinkingTokens = normalizeClaudeMaxThinkingTokens(
    raw.maxThinkingTokens,
    DEFAULT_CLAUDE_MAX_THINKING_TOKENS,
  )
  const providerContext = parseCanonicalProviderContext(raw.providerContext, {
    ...(effort ? { effort } : {}),
    adaptiveThinking,
    maxThinkingTokens,
  }) ?? undefined
  const cwd = typeof raw.cwd === 'string' && raw.cwd.trim().length > 0
    ? raw.cwd.trim()
    : undefined
  const taskSource = raw.taskSource != null ? parseTaskSource(raw.taskSource) : null
  const contextConfig = parseHeartbeatContextConfig(raw.contextConfig)
  const maxTurns = parseCommanderMaxTurns(raw.maxTurns, runtimeConfig)
  const costCapUsd = parseCommanderCostCapUsd(raw.costCapUsd)
  const contextMode = parseCommanderContextMode(raw.contextMode)
  if (!Object.prototype.hasOwnProperty.call(raw, 'heartbeat')) {
    return null
  }
  if (
    !isObject(raw.heartbeat) ||
    Object.prototype.hasOwnProperty.call(raw.heartbeat, 'lastSentAt')
  ) {
    return null
  }
  const heartbeat = normalizeHeartbeatConfig(raw.heartbeat)
  const operatorId = parseOptionalNonEmptyString(raw.operatorId)
  const templateId = raw.templateId === null ? null : parseOptionalNonEmptyString(raw.templateId)
  const replicatedFromCommanderId = raw.replicatedFromCommanderId === null
    ? null
    : parseOptionalNonEmptyString(raw.replicatedFromCommanderId)
  const system = raw.system === true
  const archived = raw.archived === true
  const archivedAt = archived ? parseOptionalNonEmptyString(raw.archivedAt) : undefined
  const state = raw.state

  if (
    !id ||
    !host ||
    !created ||
    !COMMANDER_STATES.has(state as CommanderSession['state'])
  ) {
    return null
  }

  const session: CommanderSession = {
    id,
    host,
    ...(executionMachineId ? { executionMachineId } : {}),
    avatarSeed,
    state: state as CommanderSession['state'],
    created,
    agentType,
    ...(model !== undefined ? { model } : {}),
    effort,
    adaptiveThinking,
    maxThinkingTokens,
    ...(providerContext ? { providerContext } : {}),
    cwd,
    heartbeat,
    maxTurns,
    costCapUsd,
    contextMode,
    contextConfig,
    taskSource,
    ...(operatorId ? { operatorId } : {}),
    ...(templateId !== undefined ? { templateId } : {}),
    ...(replicatedFromCommanderId !== undefined ? { replicatedFromCommanderId } : {}),
    ...(system ? { system: true } : {}),
    ...(archived ? { archived: true } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(remoteOrigin ? { remoteOrigin } : {}),
  }

  return session
}

function parsePersistedCommanderSessions(
  raw: unknown,
  runtimeConfig: CommanderRuntimeConfig,
): ParsedCommanderSessions {
  const candidates: unknown[] = isObject(raw) && Array.isArray(raw.sessions)
    ? raw.sessions
    : []

  const sessions: CommanderSession[] = []
  let needsExecutionMachineBackfill = false

  for (const entry of candidates) {
    const session = parseCommanderSession(entry, runtimeConfig)
    if (!session) {
      continue
    }
    sessions.push(session)
    if (
      isObject(entry)
      && !parseOptionalNonEmptyString(entry.executionMachineId)
      && session.remoteOrigin
      && session.executionMachineId === session.remoteOrigin.machineId
    ) {
      needsExecutionMachineBackfill = true
    }
  }

  return { sessions, needsExecutionMachineBackfill }
}

export function isPersistedCommanderSessionsValid(raw: unknown): boolean {
  if (!isObject(raw) || !Array.isArray(raw.sessions)) {
    return false
  }
  const runtimeConfig = createDefaultCommanderRuntimeConfig()
  return raw.sessions.every((entry) => parseCommanderSession(entry, runtimeConfig) !== null)
}

function cloneSession(session: CommanderSession): CommanderSession {
  return {
    ...session,
    ...(session.providerContext ? { providerContext: { ...session.providerContext } } : {}),
    heartbeat: normalizeHeartbeatConfig(session.heartbeat),
    contextConfig: session.contextConfig ? { ...session.contextConfig } : undefined,
    taskSource: session.taskSource ? { ...session.taskSource } : null,
    ...(session.remoteOrigin ? { remoteOrigin: { ...session.remoteOrigin } } : {}),
  }
}

type SerializedCommanderSession = Record<string, unknown> & { created: string }

function serializeSession(session: CommanderSession): SerializedCommanderSession {
  const cleaned = cloneSession(session) as unknown as Record<string, unknown>
  return {
    ...cleaned,
    created: typeof cleaned.created === 'string' ? cleaned.created : session.created,
  }
}

function compareCommanderSessionsForList(
  left: Pick<CommanderSession, 'created' | 'system'>,
  right: Pick<CommanderSession, 'created' | 'system'>,
): number {
  if (left.system === true && right.system !== true) {
    return -1
  }
  if (left.system !== true && right.system === true) {
    return 1
  }
  return left.created.localeCompare(right.created)
}

export function defaultCommanderSessionStorePath(): string {
  return resolveCommanderSessionStorePath()
}

export interface CommanderSessionStoreOptions {
  runtimeConfig?: CommanderRuntimeConfig
  lifecycleScope?: string
}

export class CommanderSessionStore {
  private readonly filePath: string
  private readonly runtimeConfig: CommanderRuntimeConfig
  private readonly lifecycleScope: string
  private sessionsById: Map<string, CommanderSession> | null = null
  private loadPromise: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    filePath: string = defaultCommanderSessionStorePath(),
    options: CommanderSessionStoreOptions = {},
  ) {
    this.filePath = path.resolve(filePath)
    this.runtimeConfig = options.runtimeConfig ?? createDefaultCommanderRuntimeConfig()
    this.lifecycleScope = path.resolve(options.lifecycleScope ?? path.dirname(this.filePath))
  }

  async list(): Promise<CommanderSession[]> {
    await this.ensureLoaded()
    return [...this.sessions().values()]
      .map((session) => cloneSession(session))
      .sort(compareCommanderSessionsForList)
  }

  async get(id: string): Promise<CommanderSession | null> {
    await this.ensureLoaded()
    const found = this.sessions().get(id)
    return found ? cloneSession(found) : null
  }

  async create(session: CommanderSession): Promise<CommanderSession> {
    return withCommanderMutation(session.id, this.lifecycleScope, () => (
      this.withMutationLock(async () => {
        await this.ensureLoaded()
        const sessions = this.sessions()
        if (sessions.has(session.id)) {
          throw new Error(`Commander session "${session.id}" already exists`)
        }

        sessions.set(session.id, cloneSession(session))
        await this.writeToDisk()
        return cloneSession(session)
      })
    ))
  }

  async update(
    id: string,
    mutate: (current: CommanderSession) => CommanderSession,
  ): Promise<CommanderSession | null> {
    return withCommanderMutation(id, this.lifecycleScope, () => (
      this.withMutationLock(async () => {
        await this.ensureLoaded()
        const sessions = this.sessions()
        const existing = sessions.get(id)
        if (!existing) {
          return null
        }

        const next = mutate(cloneSession(existing))
        sessions.set(id, cloneSession(next))
        await this.writeToDisk()
        return cloneSession(next)
      })
    ))
  }

  async delete(id: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      await this.ensureLoaded()
      const sessions = this.sessions()
      if (!sessions.has(id)) {
        return false
      }
      sessions.delete(id)
      await this.writeToDisk()
      return true
    })
  }

  /**
   * Restores the durable parent anchor after an exclusive cleanup failed.
   * Callers must already own the commander cleanup lease; unlike normal
   * create/update this method intentionally performs no lifecycle acquisition.
   */
  async restoreAfterFailedCleanup(session: CommanderSession): Promise<CommanderSession> {
    return this.withMutationLock(async () => {
      await this.ensureLoaded()
      const sessions = this.sessions()
      const existing = sessions.get(session.id)
      if (existing) {
        return cloneSession(existing)
      }
      sessions.set(session.id, cloneSession(session))
      await this.writeToDisk()
      return cloneSession(session)
    })
  }

  private sessions(): Map<string, CommanderSession> {
    if (!this.sessionsById) {
      throw new Error('CommanderSessionStore not loaded')
    }
    return this.sessionsById
  }

  private async ensureLoaded(): Promise<void> {
    if (this.sessionsById) {
      return
    }
    if (this.loadPromise) {
      await this.loadPromise
      return
    }

    this.loadPromise = (async () => {
      const persisted = await this.readFromDisk()
      if (!this.sessionsById) {
        const loadedSessions = new Map(
          persisted.sessions.map((session) => [session.id, cloneSession(session)]),
        )
        if (persisted.needsExecutionMachineBackfill) {
          await this.writeSessionsToDisk([...loadedSessions.values()], { backup: true })
        }
        this.sessionsById = loadedSessions
      }
    })()

    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  private async readFromDisk(): Promise<ParsedCommanderSessions> {
    let rawFile: string
    try {
      rawFile = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          sessions: [],
          needsExecutionMachineBackfill: false,
        }
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawFile) as unknown
    } catch {
      return {
        sessions: [],
        needsExecutionMachineBackfill: false,
      }
    }

    return parsePersistedCommanderSessions(parsed, this.runtimeConfig)
  }

  private async writeToDisk(options: { backup?: boolean } = {}): Promise<void> {
    await this.writeSessionsToDisk([...this.sessions().values()], options)
  }

  private async writeSessionsToDisk(
    input: CommanderSession[],
    options: { backup?: boolean } = {},
  ): Promise<void> {
    const sessions = input
      .map((session) => serializeSession(session))
      .sort(compareCommanderSessionsForList)

    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeJsonFileAtomically(
      this.filePath,
      withJsonStoreSchema({ sessions }),
      { backup: options.backup },
    )
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
