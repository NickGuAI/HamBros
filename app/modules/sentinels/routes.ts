import { Router } from 'express'
import type { AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import { SentinelExecutor, type SentinelExecutorOptions } from './executor.js'
import {
  InvalidSentinelCronExpressionError,
  MissingSentinelSkillError,
  ParentCommanderNotFoundError,
  SentinelScheduler,
} from './scheduler.js'
import { SentinelStore } from './store.js'
import type {
  CreateSentinelInput,
  Sentinel,
  SentinelAgentType,
  SentinelStatus,
  UpdateSentinelInput,
} from './types.js'

const SENTINEL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const COMMANDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
const SENTINEL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

interface CommanderLookupStore {
  get(commanderId: string): Promise<unknown | null>
}

export interface SentinelsRouterOptions extends Pick<SentinelExecutorOptions, 'agentSessionFactory' | 'monitorOptions' | 'now'> {
  store?: SentinelStore
  executor?: SentinelExecutor
  scheduler?: SentinelScheduler
  schedulerInitialized?: Promise<void>
  commanderStore?: CommanderLookupStore
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
  internalToken?: string
}

export interface SentinelsRouterResult {
  router: Router
  scheduler: SentinelScheduler
  store: SentinelStore
  ready: Promise<void>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseSentinelId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  if (!trimmed || !SENTINEL_ID_PATTERN.test(trimmed)) {
    return null
  }
  return trimmed
}

function parseCommanderId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  if (!trimmed || !COMMANDER_ID_PATTERN.test(trimmed)) {
    return null
  }
  return trimmed
}

function parseSentinelName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  if (!trimmed || !SENTINEL_NAME_PATTERN.test(trimmed)) {
    return null
  }
  return trimmed
}

function parseNonEmptyString(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseOptionalString(raw: unknown): string | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (raw === null) {
    return undefined
  }
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseOptionalStatus(raw: unknown): SentinelStatus | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (raw === 'active' || raw === 'paused' || raw === 'completed' || raw === 'cancelled') {
    return raw
  }
  return null
}

function parseOptionalAgentType(raw: unknown): SentinelAgentType | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (raw === 'claude' || raw === 'codex') {
    return raw
  }
  return null
}

function parseOptionalTimezone(raw: unknown): string | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (raw === null) {
    return undefined
  }
  if (typeof raw !== 'string') {
    return null
  }
  const timezone = raw.trim()
  if (!timezone) {
    return undefined
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    return null
  }
  return timezone
}

function parseOptionalWorkDir(raw: unknown): string | null | undefined {
  const workDir = parseOptionalString(raw)
  if (workDir === undefined) {
    return undefined
  }
  if (workDir === null) {
    return null
  }
  return workDir.startsWith('/') ? workDir : null
}

function parseOptionalMaxRuns(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined
  }

  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

function parseOptionalSkillList(raw: unknown): string[] | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw)) {
    return null
  }

  const nextSkills: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return null
    }
    const skill = entry.trim()
    if (!skill) {
      return null
    }
    if (seen.has(skill)) {
      continue
    }
    seen.add(skill)
    nextSkills.push(skill)
  }

  return nextSkills
}

function parseOptionalObservations(raw: unknown): string[] | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw)) {
    return null
  }

  const values: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return null
    }
    const observation = entry.trim()
    if (!observation) {
      continue
    }
    values.push(observation)
  }
  return values
}

function parsePagination(raw: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) {
      return Math.max(minimum, Math.min(maximum, parsed))
    }
  }
  return fallback
}

function toIsoString(value: Date | null | undefined): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null
  }
  return value.toISOString()
}

function toSentinelResponse(sentinel: Sentinel, scheduler: SentinelScheduler): Sentinel & { nextRun: string | null } {
  return {
    ...sentinel,
    nextRun: toIsoString(scheduler.getNextRun(sentinel.id)),
  }
}

function isCronError(error: unknown): error is InvalidSentinelCronExpressionError {
  return error instanceof InvalidSentinelCronExpressionError
}

function isMissingSkillError(error: unknown): error is MissingSentinelSkillError {
  return error instanceof MissingSentinelSkillError
}

function isMissingParentError(error: unknown): error is ParentCommanderNotFoundError {
  return error instanceof ParentCommanderNotFoundError
}

export function createSentinelsRouter(options: SentinelsRouterOptions = {}): SentinelsRouterResult {
  const router = Router()
  const store = options.store ?? new SentinelStore()
  const executor = options.executor ?? new SentinelExecutor({
    store,
    now: options.now,
    monitorOptions: options.monitorOptions,
    agentSessionFactory: options.agentSessionFactory,
    internalToken: options.internalToken,
  })
  const scheduler = options.scheduler ?? new SentinelScheduler({
    store,
    executor,
    commanderStore: options.commanderStore,
  })

  const initialized = options.schedulerInitialized ?? scheduler.initialize()
  if (!options.schedulerInitialized) {
    void initialized.catch((error) => {
      console.error('[sentinel] Failed to initialize scheduler:', error)
    })
  }

  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['commanders:read'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
    internalToken: options.internalToken,
  })
  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['commanders:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
    internalToken: options.internalToken,
  })

  router.get('/', requireReadAccess, async (req, res) => {
    const commanderIdRaw = req.query.parent ?? req.query.commander
    const parentCommanderId = commanderIdRaw === undefined
      ? undefined
      : parseCommanderId(commanderIdRaw)

    if (commanderIdRaw !== undefined && !parentCommanderId) {
      res.status(400).json({ error: 'parent/commander must be a valid commander id when provided' })
      return
    }

    try {
      await initialized
      const sentinels = await scheduler.listSentinels(
        parentCommanderId ? { parentCommanderId } : {},
      )
      res.json(sentinels.map((sentinel) => toSentinelResponse(sentinel, scheduler)))
    } catch {
      res.status(500).json({ error: 'Failed to list sentinels' })
    }
  })

  router.post('/', requireWriteAccess, async (req, res) => {
    const parentCommanderId = parseCommanderId(req.body?.parentCommanderId)
    if (!parentCommanderId) {
      res.status(400).json({ error: 'parentCommanderId is required' })
      return
    }

    const name = parseSentinelName(req.body?.name)
    if (!name) {
      res.status(400).json({ error: 'name is required (letters, numbers, _ and - only)' })
      return
    }

    const instruction = parseNonEmptyString(req.body?.instruction)
    if (!instruction) {
      res.status(400).json({ error: 'instruction is required' })
      return
    }

    const schedule = parseNonEmptyString(req.body?.schedule)
    if (!schedule) {
      res.status(400).json({ error: 'schedule is required' })
      return
    }

    const timezone = parseOptionalTimezone(req.body?.timezone)
    if (timezone === null) {
      res.status(400).json({ error: 'timezone must be a valid IANA timezone when provided' })
      return
    }

    const agentType = parseOptionalAgentType(req.body?.agentType)
    if (agentType === null) {
      res.status(400).json({ error: 'agentType must be claude, codex, or gemini when provided' })
      return
    }

    const permissionMode = parseOptionalString(req.body?.permissionMode)
    if (permissionMode === null) {
      res.status(400).json({ error: 'permissionMode must be a string when provided' })
      return
    }

    const model = parseOptionalString(req.body?.model)
    if (model === null) {
      res.status(400).json({ error: 'model must be a string when provided' })
      return
    }

    const workDir = parseOptionalWorkDir(req.body?.workDir)
    if (workDir === null) {
      res.status(400).json({ error: 'workDir must be an absolute path when provided' })
      return
    }

    const maxRuns = parseOptionalMaxRuns(req.body?.maxRuns)
    if (maxRuns === null) {
      res.status(400).json({ error: 'maxRuns must be a positive integer when provided' })
      return
    }

    const status = parseOptionalStatus(req.body?.status)
    if (status === null) {
      res.status(400).json({ error: 'status must be active, paused, completed, or cancelled when provided' })
      return
    }

    const skills = parseOptionalSkillList(req.body?.skills)
    if (skills === null) {
      res.status(400).json({ error: 'skills must be an array of non-empty strings when provided' })
      return
    }

    const observations = parseOptionalObservations(req.body?.observations)
    if (observations === null) {
      res.status(400).json({ error: 'observations must be an array of strings when provided' })
      return
    }

    const seedMemory = parseOptionalString(req.body?.seedMemory)
    if (seedMemory === null) {
      res.status(400).json({ error: 'seedMemory must be a string when provided' })
      return
    }

    const createInput: CreateSentinelInput = {
      parentCommanderId,
      name,
      instruction,
      schedule,
      ...(timezone ? { timezone } : {}),
      ...(agentType ? { agentType } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(model ? { model } : {}),
      ...(skills ? { skills } : {}),
      ...(seedMemory ? { seedMemory } : {}),
      ...(workDir ? { workDir } : {}),
      ...(maxRuns ? { maxRuns } : {}),
      ...(status ? { status } : {}),
      ...(observations ? { observations } : {}),
    }

    try {
      await initialized
      const sentinel = await scheduler.createSentinel(createInput)
      res.status(201).json(toSentinelResponse(sentinel, scheduler))
    } catch (error) {
      if (isCronError(error)) {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }
      if (isMissingParentError(error)) {
        res.status(400).json({ error: error.message })
        return
      }
      if (isMissingSkillError(error)) {
        res.status(400).json({ error: error.message })
        return
      }
      res.status(500).json({ error: 'Failed to create sentinel' })
    }
  })

  router.get('/:id', requireReadAccess, async (req, res) => {
    const sentinelId = parseSentinelId(req.params.id)
    if (!sentinelId) {
      res.status(400).json({ error: 'Invalid sentinel id' })
      return
    }

    try {
      await initialized
      const sentinel = await scheduler.getSentinel(sentinelId)
      if (!sentinel) {
        res.status(404).json({ error: 'Sentinel not found' })
        return
      }

      res.json(toSentinelResponse(sentinel, scheduler))
    } catch {
      res.status(500).json({ error: 'Failed to load sentinel' })
    }
  })

  router.patch('/:id', requireWriteAccess, async (req, res) => {
    const sentinelId = parseSentinelId(req.params.id)
    if (!sentinelId) {
      res.status(400).json({ error: 'Invalid sentinel id' })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const patch: UpdateSentinelInput = {}

    if ('name' in body) {
      const name = parseSentinelName(body.name)
      if (!name) {
        res.status(400).json({ error: 'name must use letters, numbers, _ and - only' })
        return
      }
      patch.name = name
    }

    if ('instruction' in body) {
      const instruction = parseNonEmptyString(body.instruction)
      if (!instruction) {
        res.status(400).json({ error: 'instruction must be a non-empty string' })
        return
      }
      patch.instruction = instruction
    }

    if ('schedule' in body) {
      const schedule = parseNonEmptyString(body.schedule)
      if (!schedule) {
        res.status(400).json({ error: 'schedule must be a non-empty string' })
        return
      }
      patch.schedule = schedule
    }

    if ('timezone' in body) {
      const timezone = parseOptionalTimezone(body.timezone)
      if (timezone === null) {
        res.status(400).json({ error: 'timezone must be a valid IANA timezone when provided' })
        return
      }
      patch.timezone = timezone
    }

    if ('status' in body) {
      const status = parseOptionalStatus(body.status)
      if (!status) {
        res.status(400).json({ error: 'status must be active, paused, completed, or cancelled' })
        return
      }
      patch.status = status
    }

    if ('agentType' in body) {
      const agentType = parseOptionalAgentType(body.agentType)
      if (!agentType) {
        res.status(400).json({ error: 'agentType must be claude, codex, or gemini' })
        return
      }
      patch.agentType = agentType
    }

    if ('permissionMode' in body) {
      const permissionMode = parseOptionalString(body.permissionMode)
      if (permissionMode === null) {
        res.status(400).json({ error: 'permissionMode must be a string when provided' })
        return
      }
      patch.permissionMode = permissionMode
    }

    if ('model' in body) {
      const model = parseOptionalString(body.model)
      if (model === null) {
        res.status(400).json({ error: 'model must be a string when provided' })
        return
      }
      patch.model = model
    }

    if ('skills' in body) {
      const skills = parseOptionalSkillList(body.skills)
      if (skills === null || skills === undefined) {
        res.status(400).json({ error: 'skills must be an array of non-empty strings' })
        return
      }
      patch.skills = skills
    }

    if ('seedMemory' in body) {
      const seedMemory = parseOptionalString(body.seedMemory)
      if (seedMemory === null) {
        res.status(400).json({ error: 'seedMemory must be a string when provided' })
        return
      }
      patch.seedMemory = seedMemory ?? ''
    }

    if ('workDir' in body) {
      const workDir = parseOptionalWorkDir(body.workDir)
      if (workDir === null || workDir === undefined) {
        res.status(400).json({ error: 'workDir must be an absolute path' })
        return
      }
      patch.workDir = workDir
    }

    if ('maxRuns' in body) {
      const maxRuns = parseOptionalMaxRuns(body.maxRuns)
      if (maxRuns === null) {
        res.status(400).json({ error: 'maxRuns must be a positive integer when provided' })
        return
      }
      patch.maxRuns = maxRuns
    }

    if ('observations' in body) {
      const observations = parseOptionalObservations(body.observations)
      if (observations === null || observations === undefined) {
        res.status(400).json({ error: 'observations must be an array of strings' })
        return
      }
      patch.observations = observations
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'At least one updatable field is required' })
      return
    }

    try {
      await initialized
      const updated = await scheduler.updateSentinel(sentinelId, patch)
      if (!updated) {
        res.status(404).json({ error: 'Sentinel not found' })
        return
      }

      res.json(toSentinelResponse(updated, scheduler))
    } catch (error) {
      if (isCronError(error)) {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }
      if (isMissingSkillError(error)) {
        res.status(400).json({ error: error.message })
        return
      }
      res.status(500).json({ error: 'Failed to update sentinel' })
    }
  })

  router.delete('/:id', requireWriteAccess, async (req, res) => {
    const sentinelId = parseSentinelId(req.params.id)
    if (!sentinelId) {
      res.status(400).json({ error: 'Invalid sentinel id' })
      return
    }

    try {
      await initialized
      const deleted = await scheduler.deleteSentinel(sentinelId)
      if (!deleted) {
        res.status(404).json({ error: 'Sentinel not found' })
        return
      }

      res.status(204).send()
    } catch {
      res.status(500).json({ error: 'Failed to delete sentinel' })
    }
  })

  router.post('/:id/trigger', requireWriteAccess, async (req, res) => {
    const sentinelId = parseSentinelId(req.params.id)
    if (!sentinelId) {
      res.status(400).json({ error: 'Invalid sentinel id' })
      return
    }

    try {
      await initialized
      const result = await scheduler.triggerSentinel(sentinelId)
      if (!result) {
        const existing = await scheduler.getSentinel(sentinelId)
        if (!existing) {
          res.status(404).json({ error: 'Sentinel not found' })
          return
        }

        res.status(409).json({
          error: 'Sentinel could not be triggered in its current state',
        })
        return
      }

      res.status(201).json({
        sentinel: toSentinelResponse(result.sentinel, scheduler),
        historyEntry: result.historyEntry,
      })
    } catch {
      res.status(500).json({ error: 'Failed to trigger sentinel' })
    }
  })

  router.get('/:id/history', requireReadAccess, async (req, res) => {
    const sentinelId = parseSentinelId(req.params.id)
    if (!sentinelId) {
      res.status(400).json({ error: 'Invalid sentinel id' })
      return
    }

    try {
      await initialized
      const sentinel = await scheduler.getSentinel(sentinelId)
      if (!sentinel) {
        res.status(404).json({ error: 'Sentinel not found' })
        return
      }

      const limit = parsePagination(req.query.limit, 50, 1, 200)
      const offset = parsePagination(req.query.offset, 0, 0, 10_000)
      const { entries, total } = await store.listHistory(sentinelId, { limit, offset })
      res.json({
        entries,
        total,
        limit,
        offset,
      })
    } catch {
      res.status(500).json({ error: 'Failed to list sentinel history' })
    }
  })

  router.get('/:id/memory', requireReadAccess, async (req, res) => {
    const sentinelId = parseSentinelId(req.params.id)
    if (!sentinelId) {
      res.status(400).json({ error: 'Invalid sentinel id' })
      return
    }

    try {
      await initialized
      const sentinel = await scheduler.getSentinel(sentinelId)
      if (!sentinel) {
        res.status(404).json({ error: 'Sentinel not found' })
        return
      }

      const memory = (await store.readMemory(sentinelId)) ?? ''
      res.json({
        sentinelId,
        memory,
      })
    } catch {
      res.status(500).json({ error: 'Failed to read sentinel memory' })
    }
  })

  return {
    router,
    scheduler,
    store,
    ready: initialized,
  }
}
