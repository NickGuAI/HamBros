import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { readJsonFileFailClosed, writeJsonFileAtomically } from '../json-file.js'
import { withJsonStoreSchema } from '../json-store-schema.js'
import { resolveCommanderDataDir } from './paths.js'
import { withCommanderMutation } from './child-mutation-coordinator.js'
import type { AutomationQuestEventBus } from '../automations/quest-event-bus.js'

export type CommanderQuestStatus = 'pending' | 'active' | 'blocked' | 'done' | 'failed'
export type CommanderQuestBlockedReason = 'auth_required'
export type CommanderQuestSource = 'manual' | 'github-issue' | 'idea' | 'voice-log'
export type QuestArtifactType = 'github_issue' | 'github_pr' | 'url' | 'file'

export interface QuestArtifact {
  type: QuestArtifactType
  label: string
  href: string
}

export interface CommanderQuestContract {
  cwd: string
  permissionMode: 'default'
  agentType: string
  model?: string | null
  skillsToUse: string[]
}

export interface CommanderQuest {
  id: string
  commanderId: string
  claimedByConversationId?: string
  createdAt: string
  completedAt?: string
  blockedAt?: string
  blockedReason?: CommanderQuestBlockedReason
  status: CommanderQuestStatus
  source: CommanderQuestSource
  instruction: string
  githubIssueUrl?: string
  note?: string
  artifacts?: QuestArtifact[]
  contract: CommanderQuestContract
}

interface PersistedCommanderQuests {
  schemaVersion?: number
  quests: CommanderQuest[]
}

export interface CreateCommanderQuestInput {
  commanderId: string
  claimedByConversationId?: string
  createdAt?: string
  status: CommanderQuestStatus
  source: CommanderQuestSource
  instruction: string
  githubIssueUrl?: string
  note?: string
  artifacts?: QuestArtifact[]
  contract: CommanderQuestContract
}

export interface UpdateCommanderQuestInput {
  claimedByConversationId?: string | null
  status?: CommanderQuestStatus
  blockedReason?: CommanderQuestBlockedReason | null
  source?: CommanderQuestSource
  instruction?: string
  githubIssueUrl?: string | null
  note?: string | null
  artifacts?: QuestArtifact[] | null
  contract?: CommanderQuestContract
}

export class QuestAlreadyClaimedError extends Error {
  readonly claimedBy: string | null
  readonly status: CommanderQuestStatus

  constructor({
    claimedBy,
    status,
  }: {
    claimedBy: string | null
    status: CommanderQuestStatus
  }) {
    super('Quest already claimed')
    this.name = 'QuestAlreadyClaimedError'
    this.claimedBy = claimedBy
    this.status = status
  }
}

export class QuestUpdateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuestUpdateError'
  }
}

const QUEST_STATUSES = new Set<CommanderQuestStatus>(['pending', 'active', 'blocked', 'done', 'failed'])
const QUEST_BLOCKED_REASONS = new Set<CommanderQuestBlockedReason>(['auth_required'])
const QUEST_SOURCES = new Set<CommanderQuestSource>(['manual', 'github-issue', 'idea', 'voice-log'])
const QUEST_ARTIFACT_TYPES = new Set<QuestArtifactType>(['github_issue', 'github_pr', 'url', 'file'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function isQuestStatus(value: unknown): value is CommanderQuestStatus {
  return typeof value === 'string' && QUEST_STATUSES.has(value as CommanderQuestStatus)
}

function isQuestBlockedReason(value: unknown): value is CommanderQuestBlockedReason {
  return typeof value === 'string' && QUEST_BLOCKED_REASONS.has(value as CommanderQuestBlockedReason)
}

function isQuestSource(value: unknown): value is CommanderQuestSource {
  return typeof value === 'string' && QUEST_SOURCES.has(value as CommanderQuestSource)
}

function isQuestArtifactType(value: unknown): value is QuestArtifactType {
  return typeof value === 'string' && QUEST_ARTIFACT_TYPES.has(value as QuestArtifactType)
}

function normalizeQuestArtifact(raw: unknown): QuestArtifact | null {
  if (!isObject(raw)) {
    return null
  }

  if (!isQuestArtifactType(raw.type)) {
    return null
  }

  const label = asTrimmedString(raw.label)
  const href = asTrimmedString(raw.href)
  if (!label || !href) {
    return null
  }

  return {
    type: raw.type,
    label,
    href,
  }
}

function normalizeQuestArtifacts(raw: unknown): QuestArtifact[] | null {
  if (!Array.isArray(raw)) {
    return null
  }

  const artifacts: QuestArtifact[] = []
  for (const entry of raw) {
    const artifact = normalizeQuestArtifact(entry)
    if (!artifact) {
      return null
    }
    artifacts.push(artifact)
  }

  return artifacts
}

function normalizeSkillsToUse(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null
  }

  const skills: string[] = []
  for (const entry of raw) {
    const skill = asTrimmedString(entry)
    if (!skill) {
      return null
    }
    skills.push(skill)
  }

  return skills
}

function validateClaimStateForCreate(
  status: CommanderQuestStatus,
  claimedByConversationId: string | undefined,
): void {
  if (status === 'active') {
    if (!claimedByConversationId) {
      throw new Error('active quests require claimedByConversationId')
    }
    return
  }

  if (claimedByConversationId) {
    throw new Error('claimedByConversationId is only valid for active quests')
  }
}

function appendQuestNote(current: string | undefined, note: string): string {
  return current ? `${current}\n${note}` : note
}

function parseDefaultPermissionMode(raw: unknown): 'default' | null {
  if (raw === undefined || raw === null || raw === '') {
    return 'default'
  }
  return raw === 'default' ? 'default' : null
}

function normalizeContract(raw: unknown): CommanderQuestContract | null {
  if (!isObject(raw)) {
    return null
  }

  const cwd = asTrimmedString(raw.cwd)
  const permissionMode = parseDefaultPermissionMode(raw.permissionMode)
  const agentType = asTrimmedString(raw.agentType)
  const model = raw.model === null
    ? null
    : asTrimmedString(raw.model) ?? undefined
  const skillsToUse = normalizeSkillsToUse(raw.skillsToUse)
  if (!cwd || permissionMode === null || !agentType || skillsToUse === null) {
    return null
  }

  return {
    cwd,
    permissionMode,
    agentType,
    ...(model !== undefined ? { model } : {}),
    skillsToUse,
  }
}

function parseQuest(raw: unknown): CommanderQuest | null {
  if (!isObject(raw)) {
    return null
  }

  const id = asTrimmedString(raw.id)
  const commanderId = asTrimmedString(raw.commanderId)
  const claimedByConversationId = asTrimmedString(raw.claimedByConversationId) ?? undefined
  const createdAt = asTrimmedString(raw.createdAt)
  const completedAt = asTrimmedString(raw.completedAt) ?? undefined
  const blockedAt = asTrimmedString(raw.blockedAt) ?? undefined
  const blockedReason = isQuestBlockedReason(raw.blockedReason) ? raw.blockedReason : undefined
  const instruction = asTrimmedString(raw.instruction)
  const contract = normalizeContract(raw.contract)
  const artifacts = normalizeQuestArtifacts(raw.artifacts) ?? []

  if (
    !id ||
    !commanderId ||
    !createdAt ||
    !isQuestStatus(raw.status) ||
    !isQuestSource(raw.source) ||
    !instruction ||
    !contract
  ) {
    return null
  }

  const githubIssueUrl = asTrimmedString(raw.githubIssueUrl) ?? undefined
  const note = asTrimmedString(raw.note) ?? undefined

  return {
    id,
    commanderId,
    ...(claimedByConversationId ? { claimedByConversationId } : {}),
    createdAt,
    ...(completedAt ? { completedAt } : {}),
    ...(blockedAt ? { blockedAt } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    status: raw.status,
    source: raw.source,
    instruction,
    ...(githubIssueUrl ? { githubIssueUrl } : {}),
    ...(note ? { note } : {}),
    artifacts,
    contract,
  }
}

function parsePersistedQuests(raw: unknown): PersistedCommanderQuests {
  const candidates: unknown[] = isObject(raw) && Array.isArray(raw.quests) ? raw.quests : []

  const quests = candidates
    .map((entry) => parseQuest(entry))
    .filter((entry): entry is CommanderQuest => entry !== null)

  return { quests }
}

export function isPersistedCommanderQuestsValid(raw: unknown): boolean {
  return isObject(raw)
    && Array.isArray(raw.quests)
    && raw.quests.every((entry) => parseQuest(entry) !== null)
}

function cloneQuest(quest: CommanderQuest): CommanderQuest {
  return {
    ...quest,
    ...(quest.claimedByConversationId ? { claimedByConversationId: quest.claimedByConversationId } : {}),
    ...(quest.completedAt ? { completedAt: quest.completedAt } : {}),
    ...(quest.blockedAt ? { blockedAt: quest.blockedAt } : {}),
    ...(quest.blockedReason ? { blockedReason: quest.blockedReason } : {}),
    artifacts: (quest.artifacts ?? []).map((artifact) => ({ ...artifact })),
    contract: {
      ...quest.contract,
      skillsToUse: [...quest.contract.skillsToUse],
    },
  }
}

function sortQuests(quests: CommanderQuest[]): CommanderQuest[] {
  // Preserve file insertion order when timestamps collide so heartbeat summaries
  // remain stable across fast back-to-back quest creation in tests and UI flows.
  return [...quests].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export function defaultQuestStoreDataDir(): string {
  return resolveCommanderDataDir()
}

export class QuestStore {
  private readonly dataDir: string
  private readonly lifecycleScope: string
  private readonly eventBus?: AutomationQuestEventBus
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    config:
      | string
      | {
        dataDir?: string
        lifecycleScope?: string
        eventBus?: AutomationQuestEventBus
      } = defaultQuestStoreDataDir(),
  ) {
    if (typeof config === 'string') {
      this.dataDir = path.resolve(config)
      this.lifecycleScope = this.dataDir
      this.eventBus = undefined
      return
    }

    this.dataDir = path.resolve(config.dataDir ?? defaultQuestStoreDataDir())
    this.lifecycleScope = path.resolve(config.lifecycleScope ?? this.dataDir)
    this.eventBus = config.eventBus
  }

  getCommanderFilePath(commanderId: string): string {
    return this.resolveCommanderFilePath(commanderId)
  }

  async list(commanderId: string): Promise<CommanderQuest[]> {
    await this.mutationQueue
    const quests = await this.readQuestsForCommander(commanderId)
    return sortQuests(quests).map((quest) => cloneQuest(quest))
  }

  async listPending(commanderId: string, limit = Number.POSITIVE_INFINITY): Promise<CommanderQuest[]> {
    const pending = (await this.list(commanderId))
      .filter((quest) => quest.status === 'pending')
    if (!Number.isFinite(limit)) {
      return pending
    }

    const boundedLimit = Math.max(0, Math.floor(limit))
    return pending.slice(0, boundedLimit)
  }

  async claimNext(
    commanderId: string,
    conversationId: string,
  ): Promise<CommanderQuest | null> {
    const safeCommanderId = asTrimmedString(commanderId)
    const safeConversationId = asTrimmedString(conversationId)
    if (!safeCommanderId) {
      throw new Error('commanderId is required')
    }
    if (!safeConversationId) {
      throw new Error('conversationId is required')
    }

    return this.withMutationLock(async () => {
      const quests = await this.readQuestsForCommander(safeCommanderId)
      const ordered = sortQuests(quests)
      const existingClaim = ordered.find(
        (quest) => quest.status === 'active' && quest.claimedByConversationId === safeConversationId,
      )
      if (existingClaim) {
        return this.claimLocked(safeCommanderId, existingClaim.id, safeConversationId, ordered)
      }

      const nextQuest = ordered.find((quest) => quest.status === 'pending')
      if (!nextQuest) {
        return null
      }

      return this.claimLocked(safeCommanderId, nextQuest.id, safeConversationId, ordered)
    })
  }

  async claim(
    commanderId: string,
    questId: string,
    conversationId: string,
  ): Promise<CommanderQuest | null> {
    const safeCommanderId = asTrimmedString(commanderId)
    const safeQuestId = asTrimmedString(questId)
    const safeConversationId = asTrimmedString(conversationId)
    if (!safeCommanderId || !safeQuestId) {
      throw new Error('commanderId and questId are required')
    }
    if (!safeConversationId) {
      throw new Error('conversationId is required')
    }

    return this.withMutationLock(async () => {
      const quests = await this.readQuestsForCommander(safeCommanderId)
      return this.claimLocked(safeCommanderId, safeQuestId, safeConversationId, quests)
    })
  }

  async create(input: CreateCommanderQuestInput): Promise<CommanderQuest> {
    const commanderId = asTrimmedString(input.commanderId)
    const claimedByConversationId = asTrimmedString(input.claimedByConversationId) ?? undefined
    const instruction = asTrimmedString(input.instruction)
    const createdAt = asTrimmedString(input.createdAt) ?? new Date().toISOString()
    const githubIssueUrl = asTrimmedString(input.githubIssueUrl) ?? undefined
    const note = asTrimmedString(input.note) ?? undefined
    let artifacts: QuestArtifact[] = []
    if (input.artifacts !== undefined) {
      const parsedArtifacts = normalizeQuestArtifacts(input.artifacts)
      if (!parsedArtifacts) {
        throw new Error('artifacts is invalid')
      }
      artifacts = parsedArtifacts
    }
    const contract = normalizeContract(input.contract)
    if (!commanderId) {
      throw new Error('commanderId is required')
    }
    if (!isQuestStatus(input.status)) {
      throw new Error(`Invalid quest status: ${String(input.status)}`)
    }
    if (!isQuestSource(input.source)) {
      throw new Error(`Invalid quest source: ${String(input.source)}`)
    }
    if (!instruction) {
      throw new Error('instruction is required')
    }
    if (!contract) {
      throw new Error('contract is invalid')
    }
    validateClaimStateForCreate(input.status, claimedByConversationId)

    const nextQuest: CommanderQuest = {
      id: randomUUID(),
      commanderId,
      ...(claimedByConversationId ? { claimedByConversationId } : {}),
      createdAt,
      ...(input.status === 'blocked' ? { blockedAt: createdAt, blockedReason: 'auth_required' as const } : {}),
      status: input.status,
      source: input.source,
      instruction,
      ...(githubIssueUrl ? { githubIssueUrl } : {}),
      ...(note ? { note } : {}),
      artifacts,
      contract,
    }

    return this.withMutationLock(async () => {
      const quests = await this.readQuestsForCommander(commanderId)
      quests.push(nextQuest)
      await this.writeQuestsForCommander(commanderId, quests)
      return cloneQuest(nextQuest)
    })
  }

  async update(
    commanderId: string,
    questId: string,
    update: UpdateCommanderQuestInput,
  ): Promise<CommanderQuest | null> {
    const safeCommanderId = asTrimmedString(commanderId)
    const safeQuestId = asTrimmedString(questId)
    if (!safeCommanderId || !safeQuestId) {
      throw new Error('commanderId and questId are required')
    }

    return this.withMutationLock(async () => {
      const quests = await this.readQuestsForCommander(safeCommanderId)
      const index = quests.findIndex((quest) => quest.id === safeQuestId)
      if (index < 0) {
        return null
      }

      const current = quests[index]
      if (!current) {
        return null
      }

      if (update.status === 'active') {
        throw new QuestUpdateError('use claim() to transition into active')
      }
      if (update.claimedByConversationId !== undefined) {
        throw new QuestUpdateError('claimedByConversationId is managed by claim()')
      }

      const nextQuest: CommanderQuest = cloneQuest(current)
      if (update.status !== undefined) {
        if (!isQuestStatus(update.status)) {
          throw new Error(`Invalid quest status: ${String(update.status)}`)
        }
        nextQuest.status = update.status

        if (update.status === 'done' || update.status === 'failed') {
          if (!nextQuest.completedAt) {
            nextQuest.completedAt = new Date().toISOString()
          }
          delete nextQuest.blockedAt
          delete nextQuest.blockedReason
        } else if (update.status === 'blocked') {
          delete nextQuest.completedAt
          nextQuest.blockedAt = new Date().toISOString()
          nextQuest.blockedReason = update.blockedReason ?? nextQuest.blockedReason ?? 'auth_required'
        } else {
          delete nextQuest.completedAt
          delete nextQuest.blockedAt
          delete nextQuest.blockedReason
        }
        delete nextQuest.claimedByConversationId
      }
      if (update.blockedReason !== undefined && update.status !== 'blocked') {
        throw new QuestUpdateError('blockedReason is only valid when status is blocked')
      }
      if (update.blockedReason !== undefined && update.status === 'blocked') {
        if (update.blockedReason === null || !isQuestBlockedReason(update.blockedReason)) {
          throw new Error(`Invalid quest blocked reason: ${String(update.blockedReason)}`)
        }
        nextQuest.blockedReason = update.blockedReason
      }
      if (update.source !== undefined) {
        if (!isQuestSource(update.source)) {
          throw new Error(`Invalid quest source: ${String(update.source)}`)
        }
        nextQuest.source = update.source
      }
      if (update.instruction !== undefined) {
        const instruction = asTrimmedString(update.instruction)
        if (!instruction) {
          throw new Error('instruction must be a non-empty string')
        }
        nextQuest.instruction = instruction
      }
      if (update.githubIssueUrl !== undefined) {
        const githubIssueUrl = asTrimmedString(update.githubIssueUrl)
        if (update.githubIssueUrl !== null && !githubIssueUrl) {
          throw new Error('githubIssueUrl must be a non-empty string or null')
        }
        if (githubIssueUrl) {
          nextQuest.githubIssueUrl = githubIssueUrl
        } else {
          delete nextQuest.githubIssueUrl
        }
      }
      if (update.note !== undefined) {
        const note = asTrimmedString(update.note)
        if (update.note !== null && !note) {
          throw new Error('note must be a non-empty string or null')
        }
        if (note) {
          nextQuest.note = note
        } else {
          delete nextQuest.note
        }
      }
      if (update.artifacts !== undefined) {
        if (update.artifacts === null) {
          nextQuest.artifacts = []
        } else {
          const artifacts = normalizeQuestArtifacts(update.artifacts)
          if (!artifacts) {
            throw new Error('artifacts is invalid')
          }
          nextQuest.artifacts = artifacts
        }
      }
      if (update.contract !== undefined) {
        const contract = normalizeContract(update.contract)
        if (!contract) {
          throw new Error('contract is invalid')
        }
        nextQuest.contract = contract
      }

      quests[index] = nextQuest
      await this.writeQuestsForCommander(safeCommanderId, quests)
      if (update.status === 'done' && this.eventBus) {
        this.eventBus.emit({
          event: 'completed',
          questId: nextQuest.id,
          commanderId: safeCommanderId,
          completedAt: nextQuest.completedAt ?? new Date().toISOString(),
        })
      }
      return cloneQuest(nextQuest)
    })
  }

  async appendNote(commanderId: string, questId: string, note: string): Promise<CommanderQuest | null> {
    const safeCommanderId = asTrimmedString(commanderId)
    const safeQuestId = asTrimmedString(questId)
    const safeNote = asTrimmedString(note)
    if (!safeCommanderId || !safeQuestId) {
      throw new Error('commanderId and questId are required')
    }
    if (!safeNote) {
      throw new Error('note must be a non-empty string')
    }

    return this.withMutationLock(async () => {
      const quests = await this.readQuestsForCommander(safeCommanderId)
      const index = quests.findIndex((quest) => quest.id === safeQuestId)
      if (index < 0) {
        return null
      }

      const current = quests[index]
      if (!current) {
        return null
      }

      const existingNote = asTrimmedString(current.note)
      const nextQuest: CommanderQuest = {
        ...current,
        note: appendQuestNote(existingNote ?? undefined, safeNote),
      }

      quests[index] = nextQuest
      await this.writeQuestsForCommander(safeCommanderId, quests)
      return cloneQuest(nextQuest)
    })
  }

  async blockActiveForAuthRequired(commanderId: string, detail: string): Promise<CommanderQuest[]> {
    const safeCommanderId = asTrimmedString(commanderId)
    const safeDetail = asTrimmedString(detail) ?? 'Provider authentication is required'
    if (!safeCommanderId) {
      throw new Error('commanderId is required')
    }

    return this.withMutationLock(async () => {
      const quests = await this.readQuestsForCommander(safeCommanderId)
      const blockedAt = new Date().toISOString()
      const blocked: CommanderQuest[] = []
      const nextQuests = quests.map((quest) => {
        if (quest.status !== 'active') {
          return quest
        }
        const nextQuest: CommanderQuest = {
          ...quest,
          status: 'blocked',
          blockedReason: 'auth_required',
          blockedAt,
          completedAt: undefined,
          claimedByConversationId: undefined,
          note: appendQuestNote(asTrimmedString(quest.note) ?? undefined, `AUTH_REQUIRED: ${safeDetail}`),
        }
        blocked.push(nextQuest)
        return nextQuest
      })

      if (blocked.length > 0) {
        await this.writeQuestsForCommander(safeCommanderId, nextQuests)
      }
      return blocked.map((quest) => cloneQuest(quest))
    })
  }

  async unblockAuthRequired(commanderId: string, detail: string): Promise<CommanderQuest[]> {
    const safeCommanderId = asTrimmedString(commanderId)
    const safeDetail = asTrimmedString(detail) ?? 'Provider authentication is ready'
    if (!safeCommanderId) {
      throw new Error('commanderId is required')
    }

    return this.withMutationLock(async () => {
      const quests = await this.readQuestsForCommander(safeCommanderId)
      const unblockedAt = new Date().toISOString()
      const unblocked: CommanderQuest[] = []
      const nextQuests = quests.map((quest) => {
        if (quest.status !== 'blocked' || quest.blockedReason !== 'auth_required') {
          return quest
        }
        const nextQuest: CommanderQuest = {
          ...quest,
          status: 'pending',
          blockedAt: undefined,
          blockedReason: undefined,
          completedAt: undefined,
          claimedByConversationId: undefined,
          note: appendQuestNote(
            asTrimmedString(quest.note) ?? undefined,
            `AUTH_READY: ${safeDetail} at ${unblockedAt}`,
          ),
        }
        unblocked.push(nextQuest)
        return nextQuest
      })

      if (unblocked.length > 0) {
        await this.writeQuestsForCommander(safeCommanderId, nextQuests)
      }
      return unblocked.map((quest) => cloneQuest(quest))
    })
  }

  async get(commanderId: string, questId: string): Promise<CommanderQuest | null> {
    const safeQuestId = asTrimmedString(questId)
    if (!safeQuestId) {
      return null
    }

    const quests = await this.list(commanderId)
    return quests.find((quest) => quest.id === safeQuestId) ?? null
  }

  async delete(commanderId: string, questId: string): Promise<boolean> {
    const safeCommanderId = asTrimmedString(commanderId)
    const safeQuestId = asTrimmedString(questId)
    if (!safeCommanderId || !safeQuestId) {
      throw new Error('commanderId and questId are required')
    }

    return this.withMutationLock(async () => {
      const quests = await this.readQuestsForCommander(safeCommanderId)
      const nextQuests = quests.filter((quest) => quest.id !== safeQuestId)
      if (nextQuests.length === quests.length) {
        return false
      }

      await this.writeQuestsForCommander(safeCommanderId, nextQuests)
      return true
    })
  }

  async resetActiveToPending(commanderId: string): Promise<number> {
    const safeCommanderId = asTrimmedString(commanderId)
    if (!safeCommanderId) {
      throw new Error('commanderId is required')
    }

    return this.withMutationLock(async () => {
      const quests = await this.readQuestsForCommander(safeCommanderId)
      let changedCount = 0
      const nextQuests = quests.map((quest) => {
        if (quest.status !== 'active') {
          return quest
        }
        changedCount += 1
        return {
          ...quest,
          status: 'pending' as const,
          claimedByConversationId: undefined,
        }
      })

      if (changedCount > 0) {
        await this.writeQuestsForCommander(safeCommanderId, nextQuests)
      }
      return changedCount
    })
  }

  /** Removes the commander-owned quest directory during parent deletion. */
  async deleteForCommander(commanderId: string): Promise<void> {
    const filePath = this.resolveCommanderFilePath(commanderId)
    await rm(path.dirname(filePath), { recursive: true, force: true })
  }

  private resolveCommanderFilePath(commanderId: string): string {
    const safeCommanderId = asTrimmedString(commanderId)
    if (!safeCommanderId) {
      throw new Error('commanderId is required')
    }

    const resolved = path.resolve(this.dataDir, safeCommanderId, 'quests.json')
    const basePath = this.dataDir.endsWith(path.sep)
      ? this.dataDir
      : `${this.dataDir}${path.sep}`
    if (!resolved.startsWith(basePath)) {
      throw new Error(`Invalid commanderId path: ${commanderId}`)
    }
    return resolved
  }

  private async readQuestsForCommander(commanderId: string): Promise<CommanderQuest[]> {
    const filePath = this.resolveCommanderFilePath(commanderId)
    const parsed = await readJsonFileFailClosed(filePath)
    if (parsed === null) {
      return []
    }

    return parsePersistedQuests(parsed).quests
  }

  private async writeQuestsForCommander(commanderId: string, quests: CommanderQuest[]): Promise<void> {
    await withCommanderMutation(commanderId, this.lifecycleScope, async () => {
      const filePath = this.resolveCommanderFilePath(commanderId)
      await writeJsonFileAtomically(
        filePath,
        withJsonStoreSchema({ quests: sortQuests(quests) }) satisfies PersistedCommanderQuests,
      )
    })
  }

  private async claimLocked(
    commanderId: string,
    questId: string,
    conversationId: string,
    quests: CommanderQuest[],
  ): Promise<CommanderQuest | null> {
    const index = quests.findIndex((quest) => quest.id === questId)
    if (index < 0) {
      return null
    }

    const current = quests[index]
    if (!current) {
      return null
    }

    if (current.status === 'active') {
      if (current.claimedByConversationId === conversationId) {
        return cloneQuest(current)
      }
    }

    if (current.status !== 'pending') {
      throw new QuestAlreadyClaimedError({
        claimedBy: current.claimedByConversationId ?? null,
        status: current.status,
      })
    }

    const nextQuest: CommanderQuest = {
      ...current,
      status: 'active',
      claimedByConversationId: conversationId,
    }
    delete nextQuest.completedAt

    quests[index] = nextQuest
    await this.writeQuestsForCommander(commanderId, quests)
    return cloneQuest(nextQuest)
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
