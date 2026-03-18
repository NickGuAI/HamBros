import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveCommanderDataDir } from './paths.js'

export type CommanderQuestStatus = 'pending' | 'active' | 'done' | 'failed'
export type CommanderQuestSource = 'manual' | 'github-issue' | 'idea' | 'voice-log'
export type QuestArtifactType = 'github_issue' | 'github_pr' | 'url' | 'file'

export interface QuestArtifact {
  type: QuestArtifactType
  label: string
  href: string
}

export interface CommanderQuestContract {
  cwd: string
  permissionMode: string
  agentType: string
  skillsToUse: string[]
}

export interface CommanderQuest {
  id: string
  commanderId: string
  createdAt: string
  status: CommanderQuestStatus
  source: CommanderQuestSource
  instruction: string
  githubIssueUrl?: string
  note?: string
  artifacts?: QuestArtifact[]
  contract: CommanderQuestContract
}

interface PersistedCommanderQuests {
  quests: CommanderQuest[]
}

export interface CreateCommanderQuestInput {
  commanderId: string
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
  status?: CommanderQuestStatus
  source?: CommanderQuestSource
  instruction?: string
  githubIssueUrl?: string | null
  note?: string | null
  artifacts?: QuestArtifact[] | null
  contract?: CommanderQuestContract
}

const QUEST_STATUSES = new Set<CommanderQuestStatus>(['pending', 'active', 'done', 'failed'])
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

function normalizeContract(raw: unknown): CommanderQuestContract | null {
  if (!isObject(raw)) {
    return null
  }

  const cwd = asTrimmedString(raw.cwd)
  const permissionMode = asTrimmedString(raw.permissionMode)
  const agentType = asTrimmedString(raw.agentType)
  const skillsToUse = normalizeSkillsToUse(raw.skillsToUse)
  if (!cwd || !permissionMode || !agentType || skillsToUse === null) {
    return null
  }

  return {
    cwd,
    permissionMode,
    agentType,
    skillsToUse,
  }
}

function parseQuest(raw: unknown): CommanderQuest | null {
  if (!isObject(raw)) {
    return null
  }

  const id = asTrimmedString(raw.id)
  const commanderId = asTrimmedString(raw.commanderId)
  const createdAt = asTrimmedString(raw.createdAt)
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
    createdAt,
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
  if (Array.isArray(raw)) {
    return {
      quests: raw
        .map((entry) => parseQuest(entry))
        .filter((entry): entry is CommanderQuest => entry !== null),
    }
  }

  if (isObject(raw) && Array.isArray(raw.quests)) {
    return {
      quests: raw.quests
        .map((entry) => parseQuest(entry))
        .filter((entry): entry is CommanderQuest => entry !== null),
    }
  }

  return { quests: [] }
}

function cloneQuest(quest: CommanderQuest): CommanderQuest {
  return {
    ...quest,
    artifacts: (quest.artifacts ?? []).map((artifact) => ({ ...artifact })),
    contract: {
      ...quest.contract,
      skillsToUse: [...quest.contract.skillsToUse],
    },
  }
}

function sortQuests(quests: CommanderQuest[]): CommanderQuest[] {
  return [...quests].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  )
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    isObject(error) &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === code
  )
}

export function defaultQuestStoreDataDir(): string {
  return resolveCommanderDataDir()
}

export class QuestStore {
  private readonly dataDir: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(dataDir: string = defaultQuestStoreDataDir()) {
    this.dataDir = path.resolve(dataDir)
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

  async claimNext(commanderId: string): Promise<CommanderQuest | null> {
    const safeCommanderId = asTrimmedString(commanderId)
    if (!safeCommanderId) {
      throw new Error('commanderId is required')
    }

    return this.withMutationLock(async () => {
      const quests = await this.readQuestsForCommander(safeCommanderId)
      const ordered = sortQuests(quests)
      const nextIndex = ordered.findIndex((quest) => quest.status === 'pending')
      if (nextIndex < 0) {
        return null
      }

      const claimedQuest: CommanderQuest = {
        ...ordered[nextIndex],
        status: 'active',
      }
      ordered[nextIndex] = claimedQuest
      await this.writeQuestsForCommander(safeCommanderId, ordered)
      return cloneQuest(claimedQuest)
    })
  }

  async create(input: CreateCommanderQuestInput): Promise<CommanderQuest> {
    const commanderId = asTrimmedString(input.commanderId)
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

    const nextQuest: CommanderQuest = {
      id: randomUUID(),
      commanderId,
      createdAt,
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

      const nextQuest: CommanderQuest = cloneQuest(current)
      if (update.status !== undefined) {
        if (!isQuestStatus(update.status)) {
          throw new Error(`Invalid quest status: ${String(update.status)}`)
        }
        nextQuest.status = update.status
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
        note: existingNote ? `${existingNote}\n${safeNote}` : safeNote,
      }

      quests[index] = nextQuest
      await this.writeQuestsForCommander(safeCommanderId, quests)
      return cloneQuest(nextQuest)
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
        }
      })

      if (changedCount > 0) {
        await this.writeQuestsForCommander(safeCommanderId, nextQuests)
      }
      return changedCount
    })
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

    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        return []
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      return []
    }

    return parsePersistedQuests(parsed).quests
  }

  private async writeQuestsForCommander(commanderId: string, quests: CommanderQuest[]): Promise<void> {
    const filePath = this.resolveCommanderFilePath(commanderId)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(
      filePath,
      JSON.stringify({ quests: sortQuests(quests) } satisfies PersistedCommanderQuests, null, 2),
      'utf8',
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
