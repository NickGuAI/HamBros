import cron from 'node-cron'
import {
  buildGitHubHeaders,
  readGitHubError,
} from '../github-http.js'
import {
  buildCommanderMemoryCompactTaskName,
  COMMANDER_INSTRUCTION_TASK_TYPE,
  COMMANDER_MEMORY_COMPACT_TASK_TYPE,
  isObject,
  parseCommanderId,
  parseCronInstruction,
  parseCronTaskId,
  parseCronTaskType,
  parseIssueNumber,
  parseOptionalEnabled,
  parseSchedule,
  parseSessionId,
  parseTriggerInstruction,
} from '../route-parsers.js'
import type { CommanderRoutesContext, GitHubIssueResponse } from './types.js'

const COMMANDER_MEMORY_COMPACT_INSTRUCTION = 'Run internal commander memory compaction maintenance.'

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
    const previousIssueNumber = session.currentTask?.issueNumber ?? null

    const updated = await context.sessionStore.update(commanderId, (current) => ({
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

  router.get('/:id/crons', context.requireReadAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    try {
      await context.commandRoomSchedulerInitialized
      const taskRecords = await context.listCommanderCronTasksWithStores(commanderId)
      const response = await Promise.all(
        taskRecords.map(({ task }) => context.buildCommanderCronTask(task, commanderId)),
      )
      res.json(response)
    } catch {
      res.status(500).json({ error: 'Failed to list cron tasks' })
    }
  })

  router.post('/:id/crons', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const schedule = parseSchedule(req.body?.schedule)
    if (!schedule) {
      res.status(400).json({ error: 'schedule is required' })
      return
    }

    const taskType = parseCronTaskType(req.body?.taskType)
    if (!taskType) {
      res.status(400).json({ error: 'taskType must be instruction or memory_compact when provided' })
      return
    }

    const instruction = taskType === COMMANDER_MEMORY_COMPACT_TASK_TYPE
      ? COMMANDER_MEMORY_COMPACT_INSTRUCTION
      : parseCronInstruction(req.body?.instruction)
    if (taskType === COMMANDER_INSTRUCTION_TASK_TYPE && !instruction) {
      res.status(400).json({ error: 'instruction is required' })
      return
    }

    const enabled = parseOptionalEnabled(req.body?.enabled)
    if (enabled === null) {
      res.status(400).json({ error: 'enabled must be a boolean when provided' })
      return
    }

    if (!cron.validate(schedule)) {
      res.status(400).json({ error: 'Invalid cron expression' })
      return
    }

    const name = typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : taskType === COMMANDER_MEMORY_COMPACT_TASK_TYPE
        ? buildCommanderMemoryCompactTaskName(commanderId)
        : `commander-${commanderId}-cron`
    const agentType = req.body?.agentType === 'codex'
      ? 'codex'
      : (req.body?.agentType === 'gemini' ? 'gemini' : 'claude')
    const sessionType = req.body?.sessionType === 'pty'
      ? 'pty'
      : req.body?.sessionType === 'stream'
        ? 'stream'
        : undefined
    const permissionMode = typeof req.body?.permissionMode === 'string' && req.body.permissionMode
      ? req.body.permissionMode as string
      : undefined
    const workDir = typeof req.body?.workDir === 'string' ? req.body.workDir.trim() : ''
    if (workDir && !workDir.startsWith('/')) {
      res.status(400).json({ error: 'workDir must be an absolute path when provided' })
      return
    }
    const machine = typeof req.body?.machine === 'string' ? req.body.machine.trim() : ''

    try {
      await context.commandRoomSchedulerInitialized
      const created = context.commandRoomScheduler
        ? await context.commandRoomScheduler.createTask({
            name,
            commanderId,
            schedule,
            machine,
            workDir,
            agentType,
            instruction: instruction ?? COMMANDER_MEMORY_COMPACT_INSTRUCTION,
            taskType,
            enabled: enabled ?? true,
            sessionType,
            permissionMode,
          })
        : await context.listCommanderCronTaskStores(commanderId)[0].createTask({
            name,
            commanderId,
            schedule,
            machine,
            workDir,
            agentType,
            instruction: instruction ?? COMMANDER_MEMORY_COMPACT_INSTRUCTION,
            taskType,
            enabled: enabled ?? true,
            sessionType,
            permissionMode,
          })
      res.status(201).json(await context.buildCommanderCronTask(created, commanderId))
    } catch {
      res.status(500).json({ error: 'Failed to create cron task' })
    }
  })

  router.patch('/:id/crons/:cronId', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const cronTaskId = parseCronTaskId(req.params.cronId)
    if (!cronTaskId) {
      res.status(400).json({ error: 'Invalid cron task id' })
      return
    }

    const update: {
      schedule?: string
      instruction?: string
      enabled?: boolean
    } = {}

    if ('schedule' in (req.body ?? {})) {
      const schedule = parseSchedule(req.body?.schedule)
      if (!schedule) {
        res.status(400).json({ error: 'schedule must be a non-empty string' })
        return
      }
      update.schedule = schedule
    }

    if ('instruction' in (req.body ?? {})) {
      const instruction = parseCronInstruction(req.body?.instruction)
      if (!instruction) {
        res.status(400).json({ error: 'instruction must be a non-empty string' })
        return
      }
      update.instruction = instruction
    }

    if ('enabled' in (req.body ?? {})) {
      const enabled = parseOptionalEnabled(req.body?.enabled)
      if (enabled === null || enabled === undefined) {
        res.status(400).json({ error: 'enabled must be a boolean' })
        return
      }
      update.enabled = enabled
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: 'At least one of schedule, instruction, or enabled is required' })
      return
    }

    if (update.schedule && !cron.validate(update.schedule)) {
      res.status(400).json({ error: 'Invalid cron expression' })
      return
    }

    try {
      await context.commandRoomSchedulerInitialized
      const record = await context.findCommanderCronTaskWithStores(commanderId, cronTaskId)
      if (!record) {
        res.status(404).json({ error: 'Cron task not found' })
        return
      }

      let updated = context.commandRoomScheduler
        ? await context.commandRoomScheduler.updateTask(cronTaskId, update)
        : null
      if (!updated) {
        updated = await record.stores.taskStore.updateTask(cronTaskId, update)
      }
      if (!updated || updated.commanderId !== commanderId) {
        res.status(404).json({ error: 'Cron task not found' })
        return
      }

      res.json(await context.buildCommanderCronTask(updated, commanderId))
    } catch {
      res.status(500).json({ error: 'Failed to update cron task' })
    }
  })

  router.delete('/:id/crons/:cronId', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const cronTaskId = parseCronTaskId(req.params.cronId)
    if (!cronTaskId) {
      res.status(400).json({ error: 'Invalid cron task id' })
      return
    }

    try {
      await context.commandRoomSchedulerInitialized
      const record = await context.findCommanderCronTaskWithStores(commanderId, cronTaskId)
      if (!record) {
        res.status(404).json({ error: 'Cron task not found' })
        return
      }

      const schedulerDeleted = context.commandRoomScheduler
        ? await context.commandRoomScheduler.deleteTask(cronTaskId)
        : false

      let deletedCount = 0
      for (const taskStore of context.listCommanderCronTaskStores(commanderId)) {
        deletedCount += await taskStore.deleteTaskEverywhere(cronTaskId, commanderId)
      }
      if (!schedulerDeleted && deletedCount === 0) {
        res.status(404).json({ error: 'Cron task not found' })
        return
      }
      await Promise.all(
        context.listCommanderCronRunStores(commanderId).map((runStore) => runStore.deleteRunsForTask(cronTaskId)),
      )
      res.status(204).send()
    } catch {
      res.status(500).json({ error: 'Failed to delete cron task' })
    }
  })

  router.post('/:id/cron-trigger', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const instruction = parseTriggerInstruction(req.body)
    if (!instruction) {
      res.status(200).json({ ok: true, triggered: false })
      return
    }

    try {
      const runtime = context.runtimes.get(commanderId)
      if (runtime && context.sessionsInterface) {
        const session = await context.sessionStore.get(commanderId)
        if (session && session.state === 'running') {
          runtime.lastTaskState = instruction
          runtime.pendingSpikeObservations = []
          const sent = await context.sessionsInterface.sendToSession(`commander-${commanderId}`, instruction)
          res.status(200).json({ ok: true, triggered: sent })
          return
        }
      }
      res.status(200).json({ ok: true, triggered: false })
    } catch {
      res.status(500).json({ error: 'Failed to trigger commander instruction' })
    }
  })
}
