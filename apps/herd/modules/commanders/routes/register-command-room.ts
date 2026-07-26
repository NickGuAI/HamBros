import { validateAutomationCronExpression } from '../../automations/cron-validation.server.js'
import { InvalidAutomationCronExpressionError } from '../../automations/scheduler.js'
import {
  getProvider,
  parseProviderId,
  resolveAutomationDefaultProviderId,
  resolveProviderIdForRequest,
} from '../../agents/providers/registry.js'
import { validateModelForAgentType } from '../../agents/providers/validate-model.js'
import {
  buildGitHubHeaders,
  readGitHubError,
} from '../github-http.js'
import type {
  CreateAutomationInput,
  UpdateAutomationInput,
} from '../../automations/store.js'
import {
  isObject,
  parseCommanderId,
  parseCronInstruction,
  parseCronTaskId,
  parseIssueNumber,
  parseOptionalEnabled,
  parseSchedule,
  parseSessionId,
} from '../route-parsers.js'
import type { CommanderRoutesContext, GitHubIssueResponse } from './types.js'
import type { Automation } from '../../automations/types.js'

function parseAutomationTrigger(raw: unknown): 'schedule' | 'quest' | 'manual' | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  return raw === 'schedule' || raw === 'quest' || raw === 'manual'
    ? raw
    : null
}

function parseAutomationStatus(raw: unknown): 'active' | 'paused' | 'completed' | 'cancelled' | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  return raw === 'active' || raw === 'paused' || raw === 'completed' || raw === 'cancelled'
    ? raw
    : null
}

function parseOptionalString(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseOptionalQuestTrigger(
  raw: unknown,
): { event: 'completed'; commanderId?: string } | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isObject(raw) || raw.event !== 'completed') {
    return null
  }
  const commanderId = raw.commanderId === undefined ? undefined : parseCommanderId(raw.commanderId)
  if (raw.commanderId !== undefined && !commanderId) {
    return null
  }
  return {
    event: 'completed',
    ...(commanderId ? { commanderId } : {}),
  }
}

function parseOptionalDefaultPermissionMode(raw: unknown): 'default' | null | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined
  }
  return raw === 'default' ? 'default' : null
}

function parseOptionalSkillList(raw: unknown): string[] | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw)) {
    return null
  }
  const nextSkills: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return null
    }
    nextSkills.push(entry.trim())
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
  const observations: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return null
    }
    const trimmed = entry.trim()
    if (trimmed) {
      observations.push(trimmed)
    }
  }
  return observations
}

function parseOptionalTimezone(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) {
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

function parseOptionalSessionType(raw: unknown): 'stream' | 'pty' | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  return raw === 'stream' || raw === 'pty' ? raw : null
}

function parsePositiveInteger(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined
  }
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null
  }
  return parsed
}

function toIsoString(value: Date | null | undefined): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null
  }
  return value.toISOString()
}

function toCommanderAutomationResponse(
  automation: Automation,
  context: CommanderRoutesContext,
): Automation & { nextRun: string | null } {
  return {
    ...automation,
    nextRun: toIsoString(context.automationScheduler?.getNextRun(automation.id)),
  }
}

export function registerCommandRoomRoutes(
  router: import('express').Router,
  context: CommanderRoutesContext,
): void {
  router.get('/:id/tasks', context.requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const state = typeof req.query.state === 'string' && req.query.state.trim().length > 0
      ? req.query.state.trim()
      : 'open'

    if (!session.taskSource || !session.taskSource.owner || !session.taskSource.repo) {
      res.json([])
      return
    }

    const params = new URLSearchParams({
      state,
      per_page: '100',
    })
    if (session.taskSource.label) {
      params.set('labels', session.taskSource.label)
    }

    const response = await context.fetchImpl(
      `https://api.github.com/repos/${session.taskSource.owner}/${session.taskSource.repo}/issues?${params.toString()}`,
      {
        method: 'GET',
        headers: buildGitHubHeaders(context.githubToken),
      },
    )

    if (!response.ok) {
      res.status(response.status).json({ error: await readGitHubError(response) })
      return
    }

    const payload = (await response.json()) as unknown
    const issues = Array.isArray(payload) ? payload : []
    const tasks = issues
      .filter(
        (issue): issue is GitHubIssueResponse =>
          isObject(issue) && !('pull_request' in issue),
      )
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        issueUrl: issue.html_url,
        state: issue.state,
        labels: Array.isArray(issue.labels)
          ? issue.labels
              .map((label) => (typeof label?.name === 'string' ? label.name : null))
              .filter((name): name is string => Boolean(name))
          : [],
      }))

    res.json(tasks)
  })

  router.post('/:id/tasks', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const issueNumber = parseIssueNumber(req.body?.issueNumber)
    if (!issueNumber) {
      res.status(400).json({ error: 'issueNumber must be a positive integer' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    if (!session.taskSource || !session.taskSource.owner || !session.taskSource.repo) {
      res.status(400).json({ error: 'No GitHub task source configured for this commander' })
      return
    }

    const label = typeof req.body?.label === 'string' && req.body.label.trim().length > 0
      ? req.body.label.trim()
      : session.taskSource.label

    if (!label) {
      res.status(400).json({ error: 'No task label configured for assignment' })
      return
    }

    const response = await context.fetchImpl(
      `https://api.github.com/repos/${session.taskSource.owner}/${session.taskSource.repo}/issues/${issueNumber}/labels`,
      {
        method: 'POST',
        headers: {
          ...buildGitHubHeaders(context.githubToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          labels: [label],
        }),
      },
    )

    if (!response.ok) {
      res.status(response.status).json({ error: await readGitHubError(response) })
      return
    }

    const currentTask = {
      issueNumber,
      issueUrl: `https://github.com/${session.taskSource.owner}/${session.taskSource.repo}/issues/${issueNumber}`,
      startedAt: context.now().toISOString(),
    }
    const defaultConversation = await context.ensureDefaultConversation(session)
    const previousIssueNumber = defaultConversation.currentTask?.issueNumber ?? null

    const updated = await context.conversationStore.update(defaultConversation.id, (current) => ({
      ...current,
      currentTask,
    }))

    const runtime = context.runtimes.get(commanderId)
    if (runtime && previousIssueNumber !== issueNumber) {
      runtime.forceNextFatHeartbeat = true
    }

    res.status(201).json({
      assigned: true,
      currentTask: updated?.currentTask ?? currentTask,
    })
  })

  router.get('/:id/automations', context.requireReadAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    try {
      await context.automationSchedulerInitialized
      const trigger = parseAutomationTrigger(req.query.trigger)
      if (trigger === null) {
        res.status(400).json({ error: 'trigger must be schedule, quest, or manual when provided' })
        return
      }
      const status = parseAutomationStatus(req.query.status)
      if (status === null) {
        res.status(400).json({ error: 'status must be active, paused, completed, or cancelled when provided' })
        return
      }
      const automations = await context.automationStore.list({
        parentCommanderId: commanderId,
        ...(trigger ? { trigger } : {}),
        ...(status ? { status } : {}),
      })
      res.json(automations.map((automation) => toCommanderAutomationResponse(automation, context)))
    } catch {
      res.status(500).json({ error: 'Failed to list automations' })
    }
  })

  router.post('/:id/automations', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const trigger = parseAutomationTrigger(req.body?.trigger) ?? 'schedule'
    if (!trigger) {
      res.status(400).json({ error: 'trigger must be schedule, quest, or manual when provided' })
      return
    }

    const name = typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : `commander-${commanderId}-automation`
    const instruction = parseCronInstruction(req.body?.instruction)
    if (!instruction) {
      res.status(400).json({ error: 'instruction is required' })
      return
    }
    const schedule = parseSchedule(req.body?.schedule)
    if (trigger === 'schedule' && !schedule) {
      res.status(400).json({ error: 'schedule is required when trigger=schedule' })
      return
    }
    if (schedule && !validateAutomationCronExpression(schedule)) {
      res.status(400).json({ error: 'Invalid cron expression' })
      return
    }
    const questTrigger = parseOptionalQuestTrigger(req.body?.questTrigger)
    if (trigger === 'quest' && !questTrigger) {
      res.status(400).json({ error: 'questTrigger is required when trigger=quest' })
      return
    }
    if (questTrigger === null) {
      res.status(400).json({ error: 'questTrigger must be { event: completed, commanderId? } when provided' })
      return
    }

    const enabled = parseOptionalEnabled(req.body?.enabled)
    if (enabled === null) {
      res.status(400).json({ error: 'enabled must be a boolean when provided' })
      return
    }
    const explicitStatus = parseAutomationStatus(req.body?.status)
    if (explicitStatus === null) {
      res.status(400).json({ error: 'status must be active, paused, completed, or cancelled when provided' })
      return
    }

    const providerResolution = resolveProviderIdForRequest(req.body?.agentType, {
      defaultProviderId: resolveAutomationDefaultProviderId(),
    })
    if (providerResolution.error || !providerResolution.providerId) {
      res.status(400).json({
        error: providerResolution.error ?? 'agentType must be a registered provider id',
        validIds: providerResolution.validIds,
      })
      return
    }
    const agentType = providerResolution.providerId
    if (!getProvider(agentType)?.capabilities.supportsAutomation) {
      res.status(400).json({ error: `Provider ${agentType} cannot run automations` })
      return
    }
    const sessionType = parseOptionalSessionType(req.body?.sessionType)
    if (sessionType === null) {
      res.status(400).json({ error: 'sessionType must be stream or pty when provided' })
      return
    }
    const permissionMode = parseOptionalDefaultPermissionMode(req.body?.permissionMode)
    if (permissionMode === null) {
      res.status(400).json({ error: 'permissionMode must be default when provided' })
      return
    }
    const workDir = parseOptionalWorkDir(req.body?.workDir)
    if (workDir === null) {
      res.status(400).json({ error: 'workDir must be an absolute path when provided' })
      return
    }
    const timezone = parseOptionalTimezone(req.body?.timezone)
    if (timezone === null) {
      res.status(400).json({ error: 'timezone must be a valid IANA timezone when provided' })
      return
    }
    const maxRuns = parsePositiveInteger(req.body?.maxRuns)
    if (maxRuns === null) {
      res.status(400).json({ error: 'maxRuns must be a positive integer when provided' })
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
    const description = parseOptionalString(req.body?.description)
    if (description === null) {
      res.status(400).json({ error: 'description must be a string when provided' })
      return
    }
    const model = parseOptionalString(req.body?.model)
    if (model === null) {
      res.status(400).json({ error: 'model must be a string when provided' })
      return
    }
    const modelValidation = validateModelForAgentType(agentType, model ?? null)
    if (!modelValidation.ok) {
      res.status(400).json({ error: modelValidation.error, validIds: modelValidation.validIds })
      return
    }
    const machine = typeof req.body?.machine === 'string' ? req.body.machine.trim() : ''
    const status = explicitStatus ?? (enabled === false ? 'paused' : 'active')
    const createInput: CreateAutomationInput = {
      name,
      parentCommanderId: commanderId,
      trigger,
      ...(schedule ? { schedule } : {}),
      ...(questTrigger ? { questTrigger } : {}),
      instruction,
      agentType,
      ...(permissionMode ? { permissionMode } : {}),
      ...(skills ? { skills } : {}),
      status,
      ...(description ? { description } : {}),
      ...(timezone ? { timezone } : {}),
      machine,
      ...(workDir ? { workDir } : {}),
      ...(model ? { model } : {}),
      ...(sessionType ? { sessionType } : {}),
      ...(observations ? { observations } : {}),
      ...(typeof req.body?.seedMemory === 'string' ? { seedMemory: req.body.seedMemory } : {}),
      ...(maxRuns ? { maxRuns } : {}),
    }

    try {
      await context.automationSchedulerInitialized
      const created = await context.automationScheduler!.createAutomation(createInput)
      res.status(201).json(toCommanderAutomationResponse(created, context))
    } catch (error) {
      if (error instanceof InvalidAutomationCronExpressionError) {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }
      res.status(500).json({ error: 'Failed to create automation' })
    }
  })

  router.patch('/:id/automations/:automationId', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const automationId = parseCronTaskId(req.params.automationId)
    if (!automationId) {
      res.status(400).json({ error: 'Invalid automation id' })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const patch: UpdateAutomationInput = {}

    if ('schedule' in body) {
      const schedule = parseSchedule(body.schedule)
      if (!schedule) {
        res.status(400).json({ error: 'schedule must be a non-empty string' })
        return
      }
      if (!validateAutomationCronExpression(schedule)) {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }
      patch.schedule = schedule
    }

    if ('instruction' in body) {
      const instruction = parseCronInstruction(body.instruction)
      if (!instruction) {
        res.status(400).json({ error: 'instruction must be a non-empty string' })
        return
      }
      patch.instruction = instruction
    }

    if ('enabled' in body) {
      const enabled = parseOptionalEnabled(body.enabled)
      if (enabled === null || enabled === undefined) {
        res.status(400).json({ error: 'enabled must be a boolean' })
        return
      }
      patch.status = enabled ? 'active' : 'paused'
    }

    if ('name' in body) {
      const name = parseOptionalString(body.name)
      if (name === null) {
        res.status(400).json({ error: 'name must be a non-empty string when provided' })
        return
      }
      patch.name = name
    }
    if ('trigger' in body) {
      const trigger = parseAutomationTrigger(body.trigger)
      if (!trigger) {
        res.status(400).json({ error: 'trigger must be schedule, quest, or manual when provided' })
        return
      }
      patch.trigger = trigger
    }
    if ('status' in body) {
      const status = parseAutomationStatus(body.status)
      if (!status) {
        res.status(400).json({ error: 'status must be active, paused, completed, or cancelled when provided' })
        return
      }
      patch.status = status
    }
    if ('questTrigger' in body) {
      if (body.questTrigger === null) {
        patch.questTrigger = null
      } else {
        const questTrigger = parseOptionalQuestTrigger(body.questTrigger)
        if (!questTrigger) {
          res.status(400).json({ error: 'questTrigger must be { event: completed, commanderId? } when provided' })
          return
        }
        patch.questTrigger = questTrigger
      }
    }
    if ('description' in body) {
      const description = parseOptionalString(body.description)
      if (description === null) {
        res.status(400).json({ error: 'description must be a string when provided' })
        return
      }
      patch.description = description
    }
    if ('timezone' in body) {
      const timezone = parseOptionalTimezone(body.timezone)
      if (timezone === null) {
        res.status(400).json({ error: 'timezone must be a valid IANA timezone when provided' })
        return
      }
      patch.timezone = timezone
    }
    if ('machine' in body) {
      const machine = parseOptionalString(body.machine)
      if (machine === null) {
        res.status(400).json({ error: 'machine must be a string when provided' })
        return
      }
      patch.machine = machine ?? ''
    }
    if ('workDir' in body) {
      const workDir = parseOptionalWorkDir(body.workDir)
      if (workDir === null) {
        res.status(400).json({ error: 'workDir must be an absolute path when provided' })
        return
      }
      patch.workDir = workDir
    }
    if ('agentType' in body) {
      const agentType = parseProviderId(body.agentType)
      const provider = agentType ? getProvider(agentType) : undefined
      if (!provider?.capabilities.supportsCommanderConversation) {
        res.status(400).json({
          error: agentType
            ? `Provider ${agentType} cannot host commander conversations`
            : 'agentType must be a registered provider when provided',
        })
        return
      }
      patch.agentType = provider.id
    }
    if ('model' in body) {
      if (body.model === null) {
        patch.model = null
      } else {
        const model = parseOptionalString(body.model)
        if (model === null) {
          res.status(400).json({ error: 'model must be a string when provided' })
          return
        }
        patch.model = model
      }
    }
    if ('permissionMode' in body) {
      const permissionMode = parseOptionalDefaultPermissionMode(body.permissionMode)
      if (permissionMode === null) {
        res.status(400).json({ error: 'permissionMode must be default when provided' })
        return
      }
      patch.permissionMode = permissionMode
    }
    if ('sessionType' in body) {
      if (body.sessionType === null) {
        patch.sessionType = null
      } else {
        const sessionType = parseOptionalSessionType(body.sessionType)
        if (!sessionType) {
          res.status(400).json({ error: 'sessionType must be stream or pty when provided' })
          return
        }
        patch.sessionType = sessionType
      }
    }
    if ('skills' in body) {
      const skills = parseOptionalSkillList(body.skills)
      if (skills === null) {
        res.status(400).json({ error: 'skills must be an array of non-empty strings when provided' })
        return
      }
      patch.skills = skills
    }
    if ('observations' in body) {
      const observations = parseOptionalObservations(body.observations)
      if (observations === null) {
        res.status(400).json({ error: 'observations must be an array of strings when provided' })
        return
      }
      patch.observations = observations
    }
    if ('seedMemory' in body) {
      if (typeof body.seedMemory !== 'string') {
        res.status(400).json({ error: 'seedMemory must be a string when provided' })
        return
      }
      patch.seedMemory = body.seedMemory
    }
    if ('maxRuns' in body) {
      const maxRuns = parsePositiveInteger(body.maxRuns)
      if (maxRuns === null) {
        res.status(400).json({ error: 'maxRuns must be a positive integer when provided' })
        return
      }
      patch.maxRuns = maxRuns
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'At least one automation field is required' })
      return
    }

    try {
      await context.automationSchedulerInitialized
      const current = await context.automationStore.get(automationId)
      if (!current || current.parentCommanderId !== commanderId) {
        res.status(404).json({ error: 'Automation not found' })
        return
      }
      const nextAgentType = patch.agentType ?? current.agentType
      const nextModel = patch.model !== undefined ? patch.model : (current.model ?? null)
      const modelValidation = validateModelForAgentType(nextAgentType, nextModel ?? null)
      if (!modelValidation.ok) {
        res.status(400).json({ error: modelValidation.error, validIds: modelValidation.validIds })
        return
      }
      const updated = await context.automationScheduler!.updateAutomation(automationId, patch)
      if (!updated || updated.parentCommanderId !== commanderId) {
        res.status(404).json({ error: 'Automation not found' })
        return
      }
      res.json(toCommanderAutomationResponse(updated, context))
    } catch (error) {
      if (error instanceof InvalidAutomationCronExpressionError) {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }
      res.status(500).json({ error: 'Failed to update automation' })
    }
  })

  router.delete('/:id/automations/:automationId', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const automationId = parseCronTaskId(req.params.automationId)
    if (!automationId) {
      res.status(400).json({ error: 'Invalid automation id' })
      return
    }

    try {
      await context.automationSchedulerInitialized
      const current = await context.automationStore.get(automationId)
      if (!current || current.parentCommanderId !== commanderId) {
        res.status(404).json({ error: 'Automation not found' })
        return
      }
      const deleted = await context.automationScheduler!.deleteAutomation(automationId)
      if (!deleted) {
        res.status(404).json({ error: 'Automation not found' })
        return
      }
      res.status(204).send()
    } catch {
      res.status(500).json({ error: 'Failed to delete automation' })
    }
  })

  router.post('/:id/automations/:automationId/run', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const automationId = parseCronTaskId(req.params.automationId)
    if (!automationId) {
      res.status(400).json({ error: 'Invalid automation id' })
      return
    }

    try {
      await context.automationSchedulerInitialized
      const current = await context.automationStore.get(automationId)
      if (!current || current.parentCommanderId !== commanderId) {
        res.status(404).json({ error: 'Automation not found' })
        return
      }
      const result = await context.automationScheduler!.runAutomation(automationId, 'manual')
      if (!result) {
        res.status(409).json({ error: 'Automation could not be triggered in its current state' })
        return
      }
      res.status(201).json({
        automation: toCommanderAutomationResponse(result.automation, context),
        historyEntry: result.historyEntry,
      })
    } catch {
      res.status(500).json({ error: 'Failed to trigger automation' })
    }
  })
}
