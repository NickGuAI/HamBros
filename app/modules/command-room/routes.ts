import { Router } from 'express'
import type { AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import { CommandRoomExecutor, type CommandRoomExecutorOptions } from './executor.js'
import { CommandRoomRunStore, type WorkflowRun } from './run-store.js'
import { CommandRoomScheduler, InvalidCronExpressionError } from './scheduler.js'
import {
  CommandRoomTaskStore,
  type CommandRoomAgentType,
  type CronTask,
  type UpdateCronTaskInput,
} from './task-store.js'

const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const COMMANDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseTaskId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  if (!trimmed || !TASK_ID_PATTERN.test(trimmed)) {
    return null
  }
  return trimmed
}

function parseOptionalCommanderId(raw: unknown): string | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return undefined
  }
  if (!COMMANDER_ID_PATTERN.test(trimmed)) {
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

function parseWorkDir(raw: unknown): string | null {
  const workDir = parseNonEmptyString(raw)
  if (!workDir || !workDir.startsWith('/')) {
    return null
  }
  return workDir
}

function parseOptionalString(raw: unknown): string | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseOptionalModel(
  raw: unknown,
  options: { allowClear: boolean },
): string | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (raw === null) {
    return options.allowClear ? undefined : null
  }
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return options.allowClear ? undefined : null
  }
  return trimmed
}

function parseAgentType(raw: unknown): CommandRoomAgentType | null {
  if (raw === 'claude' || raw === 'codex') {
    return raw
  }
  return null
}

function parseOptionalEnabled(raw: unknown): boolean | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw === 'boolean') {
    return raw
  }
  return null
}

function parseOptionalSessionType(raw: unknown): 'stream' | 'pty' | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    return undefined
  }
  if (trimmed === 'pty' || trimmed === 'stream') {
    return trimmed
  }
  return null
}

function parseOptionalTimezone(raw: unknown): string | null | undefined {
  if (raw === undefined) {
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

function isInvalidCronError(error: unknown): error is InvalidCronExpressionError {
  return error instanceof InvalidCronExpressionError
}

export interface CommandRoomRouterOptions extends Pick<CommandRoomExecutorOptions, 'agentSessionFactory' | 'monitorOptions' | 'now'> {
  taskStore?: CommandRoomTaskStore
  runStore?: CommandRoomRunStore
  executor?: CommandRoomExecutor
  scheduler?: CommandRoomScheduler
  schedulerInitialized?: Promise<void>
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
  internalToken?: string
}

export interface CommandRoomRouterResult {
  router: Router
  scheduler: CommandRoomScheduler
  taskStore: CommandRoomTaskStore
  runStore: CommandRoomRunStore
  ready: Promise<void>
}

function toIsoString(value: Date | null | undefined): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null
  }
  return value.toISOString()
}

function toTaskResponse(
  task: CronTask,
  latestRun: WorkflowRun | null,
  scheduler: CommandRoomScheduler,
) {
  return {
    ...task,
    nextRun: toIsoString(scheduler.getNextRun(task.id)),
    lastRunStatus: latestRun?.status ?? null,
    lastRunAt: latestRun?.completedAt ?? latestRun?.startedAt ?? null,
  }
}

export function createCommandRoomRouter(
  options: CommandRoomRouterOptions = {},
): CommandRoomRouterResult {
  const router = Router()
  const taskStore = options.taskStore ?? new CommandRoomTaskStore()
  const runStore = options.runStore ?? new CommandRoomRunStore({ taskStore })
  const executor = options.executor ?? new CommandRoomExecutor({
    taskStore,
    runStore,
    now: options.now,
    monitorOptions: options.monitorOptions,
    agentSessionFactory: options.agentSessionFactory,
    internalToken: options.internalToken,
  })
  const scheduler = options.scheduler ?? new CommandRoomScheduler({
    taskStore,
    executor,
  })

  const initialized = options.schedulerInitialized ?? scheduler.initialize()
  if (!options.schedulerInitialized) {
    void initialized.catch((error) => {
      console.error('[command-room] Failed to initialize scheduler:', error)
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

  router.get('/tasks', requireReadAccess, async (req, res) => {
    const commanderId = parseOptionalCommanderId(req.query.commanderId)
    if (commanderId === null) {
      res.status(400).json({ error: 'commanderId must be a valid commander id when provided' })
      return
    }

    try {
      await initialized
      const tasks = await taskStore.listTasks(commanderId ? { commanderId } : {})
      const latestByTask = await runStore.listLatestRunsByTaskIds(tasks.map((task) => task.id))
      res.json(
        tasks.map((task) => {
          const latest = latestByTask.get(task.id) ?? null
          return toTaskResponse(task, latest, scheduler)
        }),
      )
    } catch {
      res.status(500).json({ error: 'Failed to list cron tasks' })
    }
  })

  router.post('/tasks', requireWriteAccess, async (req, res) => {
    const name = parseNonEmptyString(req.body?.name)
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }

    const schedule = parseNonEmptyString(req.body?.schedule)
    if (!schedule) {
      res.status(400).json({ error: 'schedule is required' })
      return
    }

    const machine = typeof req.body?.machine === 'string' ? req.body.machine.trim() : ''

    const workDir = typeof req.body?.workDir === 'string' ? req.body.workDir.trim() : ''
    if (workDir && !workDir.startsWith('/')) {
      res.status(400).json({ error: 'workDir must be an absolute path when provided' })
      return
    }

    const agentType = parseAgentType(req.body?.agentType)
    if (!agentType) {
      res.status(400).json({ error: 'agentType must be claude or codex' })
      return
    }

    const instruction = parseNonEmptyString(req.body?.instruction)
    if (!instruction) {
      res.status(400).json({ error: 'instruction is required' })
      return
    }

    const enabled = parseOptionalEnabled(req.body?.enabled)
    if (enabled === null) {
      res.status(400).json({ error: 'enabled must be a boolean when provided' })
      return
    }

    const timezone = parseOptionalTimezone(req.body?.timezone)
    if (timezone === null) {
      res.status(400).json({ error: 'timezone must be a valid IANA timezone when provided' })
      return
    }
    const commanderId = parseOptionalCommanderId(req.body?.commanderId)
    if (commanderId === null) {
      res.status(400).json({ error: 'commanderId must be a valid commander id when provided' })
      return
    }

    const description = parseOptionalString(req.body?.description)
    if (description === null) {
      res.status(400).json({ error: 'description must be a string when provided' })
      return
    }
    const model = parseOptionalModel(req.body?.model, { allowClear: false })
    if (model === null) {
      res.status(400).json({ error: 'model must be a non-empty string when provided' })
      return
    }
    const permissionMode = typeof req.body?.permissionMode === 'string' && req.body.permissionMode ? req.body.permissionMode as string : undefined
    const sessionType = req.body?.sessionType === 'pty' ? 'pty' : req.body?.sessionType === 'stream' ? 'stream' : undefined

    try {
      await initialized
      const created = await scheduler.createTask({
        name,
        description,
        schedule,
        timezone,
        machine,
        workDir,
        agentType,
        instruction,
        enabled: enabled ?? true,
        commanderId,
        model,
        permissionMode,
        sessionType,
      })
      res.status(201).json(toTaskResponse(created, null, scheduler))
    } catch (error) {
      if (isInvalidCronError(error)) {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }

      res.status(500).json({ error: 'Failed to create cron task' })
    }
  })

  router.patch('/tasks/:id', requireWriteAccess, async (req, res) => {
    const taskId = parseTaskId(req.params.id)
    if (!taskId) {
      res.status(400).json({ error: 'Invalid task id' })
      return
    }

    const update: UpdateCronTaskInput = {}
    const body = isObject(req.body) ? req.body : {}

    if ('name' in body) {
      const name = parseNonEmptyString(body.name)
      if (!name) {
        res.status(400).json({ error: 'name must be a non-empty string' })
        return
      }
      update.name = name
    }

    if ('description' in body) {
      const description = parseOptionalString(body.description)
      if (description === null) {
        res.status(400).json({ error: 'description must be a string when provided' })
        return
      }
      update.description = description
    }

    if ('schedule' in body) {
      const schedule = parseNonEmptyString(body.schedule)
      if (!schedule) {
        res.status(400).json({ error: 'schedule must be a non-empty string' })
        return
      }
      update.schedule = schedule
    }

    if ('machine' in body) {
      const machine = parseNonEmptyString(body.machine)
      if (!machine) {
        res.status(400).json({ error: 'machine must be a non-empty string' })
        return
      }
      update.machine = machine
    }

    if ('workDir' in body) {
      const workDir = parseWorkDir(body.workDir)
      if (!workDir) {
        res.status(400).json({ error: 'workDir must be an absolute path' })
        return
      }
      update.workDir = workDir
    }

    if ('agentType' in body) {
      const agentType = parseAgentType(body.agentType)
      if (!agentType) {
        res.status(400).json({ error: 'agentType must be claude or codex' })
        return
      }
      update.agentType = agentType
    }

    if ('instruction' in body) {
      const instruction = parseNonEmptyString(body.instruction)
      if (!instruction) {
        res.status(400).json({ error: 'instruction must be a non-empty string' })
        return
      }
      update.instruction = instruction
    }

    if ('model' in body) {
      const model = parseOptionalModel(body.model, { allowClear: true })
      if (model === null) {
        res.status(400).json({ error: 'model must be a non-empty string when provided' })
        return
      }
      update.model = model
    }

    if ('enabled' in body) {
      const enabled = parseOptionalEnabled(body.enabled)
      if (enabled === null || enabled === undefined) {
        res.status(400).json({ error: 'enabled must be a boolean' })
        return
      }
      update.enabled = enabled
    }

    if ('timezone' in body) {
      const timezone = parseOptionalTimezone(body.timezone)
      if (timezone === null || timezone === undefined) {
        res.status(400).json({ error: 'timezone must be a valid IANA timezone' })
        return
      }
      update.timezone = timezone
    }

    if ('permissionMode' in body) {
      const permissionMode = parseOptionalString(body.permissionMode)
      if (permissionMode === null) {
        res.status(400).json({ error: 'permissionMode must be a string when provided' })
        return
      }
      update.permissionMode = permissionMode
    }

    if ('sessionType' in body) {
      const sessionType = parseOptionalSessionType(body.sessionType)
      if (sessionType === null) {
        res.status(400).json({ error: 'sessionType must be stream or pty when provided' })
        return
      }
      update.sessionType = sessionType
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({
        error: 'At least one updatable field is required',
      })
      return
    }

    try {
      await initialized
      const updated = await scheduler.updateTask(taskId, update)
      if (!updated) {
        res.status(404).json({ error: 'Task not found' })
        return
      }

      const latestRun = (await runStore.listLatestRunsByTaskIds([updated.id])).get(updated.id) ?? null
      res.json(toTaskResponse(updated, latestRun, scheduler))
    } catch (error) {
      if (isInvalidCronError(error)) {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }
      res.status(500).json({ error: 'Failed to update task' })
    }
  })

  router.delete('/tasks/:id', requireWriteAccess, async (req, res) => {
    const taskId = parseTaskId(req.params.id)
    if (!taskId) {
      res.status(400).json({ error: 'Invalid task id' })
      return
    }

    try {
      await initialized
      const deleted = await scheduler.deleteTask(taskId)
      if (!deleted) {
        res.status(404).json({ error: 'Task not found' })
        return
      }

      await runStore.deleteRunsForTask(taskId)
      res.status(200).json({ deleted: true })
    } catch {
      res.status(500).json({ error: 'Failed to delete task' })
    }
  })

  router.post('/tasks/:id/trigger', requireWriteAccess, async (req, res) => {
    const taskId = parseTaskId(req.params.id)
    if (!taskId) {
      res.status(400).json({ error: 'Invalid task id' })
      return
    }

    try {
      await initialized
      const run = await executor.executeTask(taskId, 'manual', {
        authToken: req.headers.authorization,
      })
      if (!run) {
        res.status(404).json({ error: 'Task not found' })
        return
      }

      res.status(201).json(run)
    } catch {
      res.status(500).json({ error: 'Failed to trigger task run' })
    }
  })

  router.get('/tasks/:id/runs', requireReadAccess, async (req, res) => {
    const taskId = parseTaskId(req.params.id)
    if (!taskId) {
      res.status(400).json({ error: 'Invalid task id' })
      return
    }

    try {
      const task = await taskStore.getTask(taskId)
      if (!task) {
        res.status(404).json({ error: 'Task not found' })
        return
      }

      const runs = await runStore.listRunsForTask(taskId)
      res.json(runs)
    } catch {
      res.status(500).json({ error: 'Failed to list task runs' })
    }
  })

  return {
    router,
    scheduler,
    taskStore,
    runStore,
    ready: initialized,
  }
}
