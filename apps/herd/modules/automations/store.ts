import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseProviderId } from '../agents/providers/registry.js'
import type { AgentType } from '../agents/types.js'
import { resolveAutomationsDataDir } from '../data-dir.js'
import { resolveCommanderDataDir } from '../commanders/paths.js'
import { quarantineJsonFile } from '../json-file.js'
import { withJsonStoreSchema } from '../json-store-schema.js'
import { resolveFounderOperatorId } from './resolve-founder-operator.js'
import {
  withCommanderChildCreation,
  withCommanderMutations,
} from '../commanders/child-mutation-coordinator.js'
import type {
  Automation,
  AutomationExecutionSource,
  AutomationHistoryEntry,
  AutomationQuestTrigger,
  AutomationRunMetadata,
  AutomationRunTranscriptRef,
  AutomationSessionType,
  AutomationStatus,
  AutomationTrigger,
} from './types.js'

const HISTORY_CAP = 50

export interface CreateAutomationInput {
  operatorId?: string
  parentCommanderId?: string | null
  name: string
  trigger: AutomationTrigger
  schedule?: string
  questTrigger?: AutomationQuestTrigger
  instruction: string
  agentType: AgentType
  permissionMode?: 'default'
  skills?: string[]
  templateId?: string | null
  sourceConversationId?: string
  status?: AutomationStatus
  description?: string
  timezone?: string
  machine?: string
  workDir?: string
  model?: string
  sessionType?: AutomationSessionType
  observations?: string[]
  seedMemory?: string
  maxRuns?: number
}

export interface UpdateAutomationInput {
  operatorId?: string
  parentCommanderId?: string | null
  name?: string
  trigger?: AutomationTrigger
  schedule?: string
  questTrigger?: AutomationQuestTrigger | null
  instruction?: string
  agentType?: AgentType
  permissionMode?: 'default'
  skills?: string[]
  templateId?: string | null
  sourceConversationId?: string | null
  status?: AutomationStatus
  description?: string
  timezone?: string
  machine?: string
  workDir?: string
  model?: string | null
  sessionType?: AutomationSessionType | null
  observations?: string[]
  seedMemory?: string
  maxRuns?: number | null
  lastRun?: string | null
  totalRuns?: number
  totalCostUsd?: number
}

export interface AutomationStoreOptions {
  dirPath?: string
  commanderDataDir?: string
}

interface AutomationFilter {
  operatorId?: string
  parentCommanderId?: string | null
  status?: AutomationStatus
  trigger?: AutomationTrigger
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function asOptionalString(value: unknown): string | undefined {
  return asTrimmedString(value) ?? undefined
}

function asNonNegativeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }
  return null
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }
  return null
}

function asAgentType(value: unknown): AgentType | null {
  return parseProviderId(value)
}

function asTrigger(value: unknown): AutomationTrigger | null {
  return value === 'schedule' || value === 'quest' || value === 'manual'
    ? value
    : null
}

function asStatus(value: unknown): AutomationStatus | null {
  return value === 'active' || value === 'paused' || value === 'completed' || value === 'cancelled'
    ? value
    : null
}

function parseQuestTrigger(value: unknown): AutomationQuestTrigger | null {
  if (!isObject(value) || value.event !== 'completed') {
    return null
  }
  return {
    event: 'completed',
    commanderId: asTrimmedString(value.commanderId) ?? undefined,
  }
}

function parseTranscriptRef(value: unknown): AutomationRunTranscriptRef | undefined {
  if (!isObject(value)) {
    return undefined
  }
  const sessionId = asTrimmedString(value.sessionId)
  return sessionId ? { sessionId } : undefined
}

function parseHistoryEntry(entry: unknown): AutomationHistoryEntry | null {
  if (!isObject(entry)) {
    return null
  }
  const timestamp = asTrimmedString(entry.timestamp)
  const action = asTrimmedString(entry.action)
  const result = asTrimmedString(entry.result)
  const costUsd = asNonNegativeNumber(entry.costUsd)
  const durationSec = asNonNegativeNumber(entry.durationSec)
  if (!timestamp || !action || !result || costUsd === null || durationSec === null) {
    return null
  }
  const source: AutomationExecutionSource = entry.source === 'quest'
    ? 'quest'
    : entry.source === 'manual'
      ? 'manual'
      : 'schedule'
  return {
    timestamp,
    action,
    result,
    costUsd,
    durationSec,
    runKey: asTrimmedString(entry.runKey) ?? undefined,
    sessionId: asTrimmedString(entry.sessionId) ?? undefined,
    transcriptRef: parseTranscriptRef(entry.transcriptRef),
    runFile: asTrimmedString(entry.runFile) ?? undefined,
    completionOutput: typeof entry.completionOutput === 'string' ? entry.completionOutput : undefined,
    emptyOutputReason: asTrimmedString(entry.emptyOutputReason) ?? undefined,
    memoryUpdated: entry.memoryUpdated === true,
    source,
  }
}

function parseOptionalPermissionMode(raw: unknown): 'default' | null | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined
  }
  return raw === 'default' ? 'default' : null
}

function formatSeedMemory(name: string, seedMemory: string): string {
  const normalizedSeedMemory = seedMemory.trim().length > 0
    ? seedMemory.trim()
    : '(No seed memory provided)'

  return [
    `# Automation Memory: ${name}`,
    '',
    '## Seed Context',
    normalizedSeedMemory,
    '',
    '## Learned Facts',
    '- Add durable facts here over time.',
  ].join('\n')
}

function cloneAutomation(automation: Automation): Automation {
  return {
    ...automation,
    skills: [...automation.skills],
    history: (automation.history ?? []).map((entry) => ({
      ...entry,
      transcriptRef: entry.transcriptRef ? { ...entry.transcriptRef } : undefined,
    })),
    observations: automation.observations ? [...automation.observations] : undefined,
    questTrigger: automation.questTrigger ? { ...automation.questTrigger } : undefined,
  }
}

function sortAutomations(automations: Automation[]): Automation[] {
  return [...automations].sort(
    (left, right) =>
      (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || left.id.localeCompare(right.id),
  )
}

function normalizeAutomation(raw: unknown): Automation | null {
  if (!isObject(raw)) {
    return null
  }
  const id = asTrimmedString(raw.id)
  const operatorId = asTrimmedString(raw.operatorId)
  const name = asTrimmedString(raw.name)
  const trigger = asTrigger(raw.trigger)
  const instruction = asTrimmedString(raw.instruction)
  const agentType = asAgentType(raw.agentType)
  const permissionMode = parseOptionalPermissionMode(raw.permissionMode)
  const status = asStatus(raw.status)
  if (!id || !operatorId || !name || !trigger || !instruction || !agentType || permissionMode === null || !status) {
    return null
  }
  const schedule = asTrimmedString(raw.schedule) ?? undefined
  const questTrigger = raw.questTrigger === undefined ? undefined : parseQuestTrigger(raw.questTrigger)
  if (trigger === 'schedule' && !schedule) {
    return null
  }
  if (trigger === 'quest' && !questTrigger) {
    return null
  }
  const skills = Array.isArray(raw.skills)
    ? raw.skills.map((entry) => asTrimmedString(entry)).filter((entry): entry is string => Boolean(entry))
    : []
  const history = Array.isArray(raw.history)
    ? raw.history.map(parseHistoryEntry).filter((entry): entry is AutomationHistoryEntry => entry !== null).slice(0, HISTORY_CAP)
    : []
  return {
    id,
    operatorId,
    parentCommanderId: raw.parentCommanderId === null ? null : (asTrimmedString(raw.parentCommanderId) ?? undefined),
    name,
    trigger,
    ...(schedule ? { schedule } : {}),
    ...(questTrigger ? { questTrigger } : {}),
    instruction,
    agentType,
    permissionMode: permissionMode ?? 'default',
    skills,
    templateId: raw.templateId === null ? null : (asTrimmedString(raw.templateId) ?? undefined),
    sourceConversationId: asOptionalString(raw.sourceConversationId),
    status,
    description: asOptionalString(raw.description),
    timezone: asOptionalString(raw.timezone),
    machine: asOptionalString(raw.machine),
    workDir: asOptionalString(raw.workDir),
    model: raw.model === null ? undefined : asOptionalString(raw.model),
    sessionType: raw.sessionType === 'pty' ? 'pty' : raw.sessionType === 'stream' ? 'stream' : undefined,
    createdAt: asOptionalString(raw.createdAt),
    lastRun: raw.lastRun === null ? null : (asTrimmedString(raw.lastRun) ?? undefined),
    totalRuns: asNonNegativeNumber(raw.totalRuns) ?? undefined,
    totalCostUsd: asNonNegativeNumber(raw.totalCostUsd) ?? undefined,
    history,
    observations: Array.isArray(raw.observations)
      ? raw.observations.map((entry) => asTrimmedString(entry)).filter((entry): entry is string => Boolean(entry))
      : undefined,
    seedMemory: typeof raw.seedMemory === 'string' ? raw.seedMemory : undefined,
    memoryPath: asOptionalString(raw.memoryPath),
    outputDir: asOptionalString(raw.outputDir),
    maxRuns: asPositiveInteger(raw.maxRuns) ?? undefined,
  }
}

export function isPersistedAutomationValid(raw: unknown): boolean {
  if (!isObject(raw)) {
    return false
  }
  const normalized = normalizeAutomation(raw)
  if (!normalized) {
    return false
  }
  if (
    raw.skills !== undefined
    && (!Array.isArray(raw.skills) || raw.skills.length !== normalized.skills.length)
  ) {
    return false
  }
  if (
    raw.history !== undefined
    && (
      !Array.isArray(raw.history)
      || raw.history.length > HISTORY_CAP
      || raw.history.length !== (normalized.history ?? []).length
    )
  ) {
    return false
  }
  return raw.observations === undefined
    || (
      Array.isArray(raw.observations)
      && raw.observations.length === (normalized.observations ?? []).length
    )
}

export function defaultAutomationStoreDir(): string {
  return resolveAutomationsDataDir()
}

export class AutomationStore {
  private readonly dirPath: string
  private readonly commanderDataDir: string
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()
  private automations = new Map<string, Automation>()

  constructor(options: AutomationStoreOptions = {}) {
    this.dirPath = path.resolve(options.dirPath ?? defaultAutomationStoreDir())
    this.commanderDataDir = path.resolve(options.commanderDataDir ?? resolveCommanderDataDir())
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }
    if (this.loadPromise) {
      await this.loadPromise
      return
    }
    this.loadPromise = (async () => {
      this.automations = await this.readFromDisk()
      this.loaded = true
    })()
    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  async list(filter: AutomationFilter = {}): Promise<Automation[]> {
    await this.ensureLoaded()
    let automations = sortAutomations([...this.automations.values()])
    if (filter.operatorId) {
      automations = automations.filter((automation) => automation.operatorId === filter.operatorId)
    }
    if (filter.parentCommanderId !== undefined) {
      automations = automations.filter(
        (automation) => (automation.parentCommanderId ?? null) === filter.parentCommanderId,
      )
    }
    if (filter.status) {
      automations = automations.filter((automation) => automation.status === filter.status)
    }
    if (filter.trigger) {
      automations = automations.filter((automation) => automation.trigger === filter.trigger)
    }
    return automations.map(cloneAutomation)
  }

  async get(automationId: string): Promise<Automation | null> {
    await this.ensureLoaded()
    return this.automations.get(automationId)
      ? cloneAutomation(this.automations.get(automationId)!)
      : null
  }

  async create(input: CreateAutomationInput): Promise<Automation> {
    const create = () => this.withMutationLock(async () => {
      await this.ensureLoaded()
      const operatorId = input.operatorId ?? await resolveFounderOperatorId()
      const now = new Date().toISOString()
      const id = randomUUID()
      const automationDir = path.join(this.dirPath, id)
      const outputDir = path.join(automationDir)
      const memoryPath = path.join(automationDir, 'memory.md')
      const automation: Automation = {
        id,
        operatorId,
        parentCommanderId: input.parentCommanderId ?? null,
        name: input.name,
        trigger: input.trigger,
        ...(input.schedule?.trim() ? { schedule: input.schedule.trim() } : {}),
        ...(input.questTrigger ? { questTrigger: input.questTrigger } : {}),
        instruction: input.instruction,
        agentType: input.agentType,
        permissionMode: input.permissionMode ?? 'default',
        skills: (input.skills ?? []).filter((entry) => entry.trim().length > 0),
        templateId: input.templateId ?? undefined,
        sourceConversationId: input.sourceConversationId,
        status: input.status ?? 'active',
        description: input.description,
        timezone: input.timezone,
        machine: input.machine ?? '',
        workDir: input.workDir ?? process.cwd(),
        model: input.model,
        sessionType: input.sessionType,
        createdAt: now,
        lastRun: null,
        totalRuns: 0,
        totalCostUsd: 0,
        history: [],
        observations: input.observations ? [...input.observations] : undefined,
        seedMemory: input.seedMemory ?? '',
        memoryPath,
        outputDir,
        maxRuns: input.maxRuns,
      }
      await this.prepareAutomationArtifacts(automation)
      await this.writeAutomation(automation)
      this.automations.set(automation.id, automation)
      return cloneAutomation(automation)
    })
    return input.parentCommanderId
      ? withCommanderChildCreation(input.parentCommanderId, this.commanderDataDir, create)
      : create()
  }

  async update(automationId: string, update: UpdateAutomationInput): Promise<Automation | null> {
    for (;;) {
      await this.ensureLoaded()
      const observed = this.automations.get(automationId)
      if (!observed) {
        return null
      }
      const observedParentCommanderId = observed.parentCommanderId ?? null
      const nextParentCommanderId = Object.prototype.hasOwnProperty.call(update, 'parentCommanderId')
        ? update.parentCommanderId ?? null
        : observedParentCommanderId
      let parentChangedBeforeCommit = false
      const result = await withCommanderMutations(
        [observedParentCommanderId ?? '', nextParentCommanderId ?? ''],
        this.commanderDataDir,
        () => this.withMutationLock(async () => {
          await this.ensureLoaded()
          const current = this.automations.get(automationId)
          if (!current) {
            return null
          }
          if ((current.parentCommanderId ?? null) !== observedParentCommanderId) {
            parentChangedBeforeCommit = true
            return null
          }
      const next: Automation = cloneAutomation(current)
      if (update.operatorId) next.operatorId = update.operatorId
      if (Object.prototype.hasOwnProperty.call(update, 'parentCommanderId')) {
        next.parentCommanderId = update.parentCommanderId ?? null
      }
      if (update.name) next.name = update.name
      if (update.trigger) next.trigger = update.trigger
      if (Object.prototype.hasOwnProperty.call(update, 'schedule')) {
        const schedule = asTrimmedString(update.schedule)
        if (schedule) {
          next.schedule = schedule
        } else {
          delete next.schedule
        }
      }
      if (Object.prototype.hasOwnProperty.call(update, 'questTrigger')) {
        if (update.questTrigger) {
          next.questTrigger = update.questTrigger
        } else {
          delete next.questTrigger
        }
      }
      if (update.instruction) next.instruction = update.instruction
      if (update.agentType) next.agentType = update.agentType
      if (Object.prototype.hasOwnProperty.call(update, 'permissionMode')) {
        next.permissionMode = update.permissionMode ?? 'default'
      }
      if (Array.isArray(update.skills)) next.skills = [...update.skills]
      if (Object.prototype.hasOwnProperty.call(update, 'templateId')) {
        next.templateId = update.templateId ?? undefined
      }
      if (Object.prototype.hasOwnProperty.call(update, 'sourceConversationId')) {
        next.sourceConversationId = update.sourceConversationId ?? undefined
      }
      if (update.status) next.status = update.status
      if (Object.prototype.hasOwnProperty.call(update, 'description')) {
        next.description = update.description
      }
      if (Object.prototype.hasOwnProperty.call(update, 'timezone')) {
        next.timezone = update.timezone
      }
      if (Object.prototype.hasOwnProperty.call(update, 'machine')) {
        next.machine = update.machine ?? ''
      }
      if (Object.prototype.hasOwnProperty.call(update, 'workDir')) {
        next.workDir = update.workDir ?? process.cwd()
      }
      if (Object.prototype.hasOwnProperty.call(update, 'model')) {
        next.model = update.model ?? undefined
      }
      if (Object.prototype.hasOwnProperty.call(update, 'sessionType')) {
        next.sessionType = update.sessionType ?? undefined
      }
      if (Array.isArray(update.observations)) {
        next.observations = [...update.observations]
      }
      if (Object.prototype.hasOwnProperty.call(update, 'seedMemory') && typeof update.seedMemory === 'string') {
        next.seedMemory = update.seedMemory
      }
      if (Object.prototype.hasOwnProperty.call(update, 'maxRuns')) {
        next.maxRuns = update.maxRuns ?? undefined
      }
      if (Object.prototype.hasOwnProperty.call(update, 'lastRun')) {
        next.lastRun = update.lastRun ?? null
      }
      if (typeof update.totalRuns === 'number') {
        next.totalRuns = Math.max(0, update.totalRuns)
      }
      if (typeof update.totalCostUsd === 'number') {
        next.totalCostUsd = Math.max(0, update.totalCostUsd)
      }
      await this.prepareAutomationArtifacts(next)
      await this.writeAutomation(next)
      this.automations.set(next.id, next)
      return cloneAutomation(next)
        }),
      )
      if (!parentChangedBeforeCommit) {
        return result
      }
    }
  }

  async appendHistory(automationId: string, entry: AutomationHistoryEntry): Promise<Automation | null> {
    for (;;) {
      await this.ensureLoaded()
      const observed = this.automations.get(automationId)
      if (!observed) {
        return null
      }
      const observedParentCommanderId = observed.parentCommanderId ?? null
      let parentChangedBeforeCommit = false
      const result = await withCommanderMutations(
        [observedParentCommanderId ?? ''],
        this.commanderDataDir,
        () => this.withMutationLock(async () => {
          await this.ensureLoaded()
          const current = this.automations.get(automationId)
          if (!current) {
            return null
          }
          if ((current.parentCommanderId ?? null) !== observedParentCommanderId) {
            parentChangedBeforeCommit = true
            return null
          }
      const totalRuns = (current.totalRuns ?? 0) + 1
      const history = [entry, ...(current.history ?? [])].slice(0, HISTORY_CAP)
      const nextStatus = current.maxRuns && totalRuns >= current.maxRuns
        ? 'completed'
        : current.status
      const next: Automation = {
        ...cloneAutomation(current),
        history,
        lastRun: entry.timestamp,
        totalRuns,
        totalCostUsd: Math.max(0, (current.totalCostUsd ?? 0) + Math.max(0, entry.costUsd)),
        status: nextStatus,
      }
      await this.writeAutomation(next)
      this.automations.set(next.id, next)
      return cloneAutomation(next)
        }),
      )
      if (!parentChangedBeforeCommit) {
        return result
      }
    }
  }

  async listHistory(
    automationId: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<{ entries: AutomationHistoryEntry[]; total: number }> {
    const automation = await this.get(automationId)
    if (!automation) {
      return { entries: [], total: 0 }
    }
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.max(1, Math.min(200, options.limit ?? 50))
    const history = automation.history ?? []
    return {
      entries: history.slice(offset, offset + limit),
      total: history.length,
    }
  }

  async delete(automationId: string, options: { removeFiles?: boolean } = {}): Promise<boolean> {
    for (;;) {
      await this.ensureLoaded()
      const observed = this.automations.get(automationId)
      if (!observed) {
        return false
      }
      const observedParentCommanderId = observed.parentCommanderId ?? null
      let parentChangedBeforeCommit = false
      const deleted = await withCommanderMutations(
        [observedParentCommanderId ?? ''],
        this.commanderDataDir,
        () => this.withMutationLock(async () => {
          await this.ensureLoaded()
          const current = this.automations.get(automationId)
          if (!current) {
            return false
          }
          if ((current.parentCommanderId ?? null) !== observedParentCommanderId) {
            parentChangedBeforeCommit = true
            return false
          }
          await rm(this.resolveAutomationFilePath(automationId), { force: true })
          if (options.removeFiles !== false) {
            const outputDir = current.outputDir ?? path.join(this.dirPath, automationId)
            await rm(outputDir, { recursive: true, force: true })
          }
          this.automations.delete(automationId)
          return true
        }),
      )
      if (!parentChangedBeforeCommit) {
        return deleted
      }
    }
  }

  async readMemory(automationId: string): Promise<string | null> {
    const automation = await this.get(automationId)
    if (!automation?.memoryPath) {
      return null
    }
    try {
      return await readFile(automation.memoryPath, 'utf8')
    } catch (error) {
      if (isObject(error) && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  async writeMemory(automationId: string, content: string): Promise<boolean> {
    for (;;) {
      const observed = await this.get(automationId)
      if (!observed?.memoryPath) {
        return false
      }
      const observedParentCommanderId = observed.parentCommanderId ?? null
      let parentChangedBeforeCommit = false
      const result = await withCommanderMutations(
        [observedParentCommanderId ?? ''],
        this.commanderDataDir,
        async () => {
          const current = await this.get(automationId)
          if (!current?.memoryPath) {
            return false
          }
          if ((current.parentCommanderId ?? null) !== observedParentCommanderId) {
            parentChangedBeforeCommit = true
            return false
          }
          await mkdir(path.dirname(current.memoryPath), { recursive: true })
          await writeFile(current.memoryPath, content, 'utf8')
          return true
        },
      )
      if (!parentChangedBeforeCommit) {
        return result
      }
    }
  }

  async readRunReport(automationId: string, timestampKey: string): Promise<string | null> {
    const automation = await this.get(automationId)
    if (!automation?.outputDir) {
      return null
    }
    const filePath = path.join(automation.outputDir, 'runs', `${timestampKey}.md`)
    try {
      return await readFile(filePath, 'utf8')
    } catch (error) {
      if (isObject(error) && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  async readRunMetadata(automationId: string, timestampKey: string): Promise<AutomationRunMetadata | null> {
    const automation = await this.get(automationId)
    if (!automation) {
      return null
    }
    try {
      const parsed = JSON.parse(await readFile(this.resolveRunJsonPath(automation, timestampKey), 'utf8')) as unknown
      return isObject(parsed) ? parsed as unknown as AutomationRunMetadata : null
    } catch (error) {
      if (isObject(error) && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      if (error instanceof SyntaxError) {
        return null
      }
      throw error
    }
  }

  resolveRunJsonPath(automation: Pick<Automation, 'id' | 'outputDir'>, timestampKey: string): string {
    const outputDir = automation.outputDir ?? path.join(this.dirPath, automation.id)
    return path.join(outputDir, 'runs', `${timestampKey}.json`)
  }

  private resolveAutomationFilePath(automationId: string): string {
    return path.join(this.dirPath, `${automationId}.json`)
  }

  private async prepareAutomationArtifacts(automation: Automation): Promise<void> {
    const automationDir = automation.outputDir ?? path.join(this.dirPath, automation.id)
    automation.outputDir = automationDir
    automation.memoryPath = automation.memoryPath ?? path.join(automationDir, 'memory.md')
    await mkdir(path.join(automationDir, 'runs'), { recursive: true })
    await mkdir(path.join(automationDir, 'artifacts'), { recursive: true })
    try {
      await readFile(automation.memoryPath, 'utf8')
    } catch (error) {
      if (isObject(error) && 'code' in error && error.code === 'ENOENT') {
        await writeFile(
          automation.memoryPath,
          formatSeedMemory(automation.name, automation.seedMemory ?? ''),
          'utf8',
        )
      } else {
        throw error
      }
    }
  }

  private async readFromDisk(): Promise<Map<string, Automation>> {
    const automations = new Map<string, Automation>()
    let entries: string[] = []
    try {
      entries = await readdir(this.dirPath)
    } catch (error) {
      if (!(isObject(error) && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'manifest.json') {
        continue
      }
      const filePath = path.join(this.dirPath, entry)
      const raw = await this.readAutomationFile(filePath)
      const parsed = normalizeAutomation(raw)
      if (!parsed) {
        if (raw !== null) {
          await this.quarantineUnreadableAutomation(filePath)
        }
        continue
      }
      automations.set(parsed.id, parsed)
    }
    return automations
  }

  private async readAutomationFile(filePath: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as unknown
    } catch (error) {
      if (isObject(error) && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      if (error instanceof SyntaxError) {
        await this.quarantineUnreadableAutomation(filePath)
        return null
      }
      throw error
    }
  }

  private async quarantineUnreadableAutomation(filePath: string): Promise<void> {
    try {
      await quarantineJsonFile(filePath)
    } catch {
      // Keep the automation list readable even if the operator must clean up the file by hand.
    }
  }

  private async writeAutomation(automation: Automation): Promise<void> {
    await mkdir(this.dirPath, { recursive: true })
    await writeFile(
      this.resolveAutomationFilePath(automation.id),
      `${JSON.stringify(withJsonStoreSchema({ ...automation }), null, 2)}\n`,
      'utf8',
    )
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}
