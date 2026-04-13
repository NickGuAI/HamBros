import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_CLAUDE_EFFORT_LEVEL } from '../../claude-effort.js'
import {
  mimeTypeForAvatarFile,
  readCommanderUiProfile,
  resolveCommanderAvatarPath,
  writeCommanderUiProfile,
  type CommanderUiProfile,
} from '../commander-profile.js'
import {
  createDefaultHeartbeatState,
  mergeHeartbeatState,
  parseHeartbeatPatch,
} from '../heartbeat.js'
import { buildGitHubHeaders, parseRepoFullName, readGitHubError } from '../github-http.js'
import { CommanderManager } from '../manager.js'
import { EmergencyFlusher, WorkingMemoryStore } from '../memory/index.js'
import { withNamesLock } from '../names-lock.js'
import { resolveCommanderPaths } from '../paths.js'
import {
  parseHost,
  parseMessage,
  parseMessageMode,
  parseOptionalCommanderAgentType,
  parseOptionalCommanderEffort,
  parseOptionalCurrentTask,
  parseOptionalHeartbeatContextConfig,
  parseOptionalPersona,
  parseOptionalStringArray,
  parseSessionId,
  parseTaskSource,
} from '../route-parsers.js'
import { readCommanderIdentity, scaffoldCommanderIdentity } from '../templates/render.js'
import {
  readCommanderWorkflowMarkdown,
  scaffoldCommanderWorkflow,
} from '../templates/workflow.js'
import type { CommanderSession } from '../store.js'
import {
  STARTUP_PROMPT,
  buildCommanderSessionSeedFromResolvedWorkflow,
  buildFlushContext,
  createContextPressureBridge,
  extractFileMentionsFromMessage,
  extractHypothesisFromMessage,
  isInputTokenContextPressureEvent,
  isLegacyContextPressureEvent,
  listSubAgentEntries,
  resolveCommanderAgentType,
  resolveCommanderWorkflow,
  resolveEffectiveHeartbeat,
  toCommanderSessionName,
  toCommanderSessionResponse,
  toSessionRepo,
  warnInvalidWorkflowHeartbeatInterval,
} from './context.js'
import type { CommanderRoutesContext, CommanderRuntime, StreamEvent } from './types.js'

const MAX_PERSONA_LENGTH = 500

export function registerCoreRoutes(
  router: import('express').Router,
  context: CommanderRoutesContext,
): void {
  const triggerHeartbeatRoute = async (
    req: import('express').Request,
    res: import('express').Response,
  ) => {
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

    if (session.state !== 'running') {
      res.status(409).json({
        error: `Commander "${commanderId}" is not running (state: ${session.state})`,
      })
      return
    }

    if (!context.heartbeatManager.isRunning(commanderId)) {
      const restartSessionName = toCommanderSessionName(commanderId)
      const liveSession = context.sessionsInterface?.getSession(restartSessionName)
      if (liveSession) {
        context.heartbeatManager.start(commanderId, resolveEffectiveHeartbeat(session.heartbeat, null))
        // fall through to fire manual heartbeat below
      } else {
        res.status(409).json({
          error: 'No live session to restart heartbeat against',
        })
        return
      }
    }

    if (context.heartbeatManager.isInFlight(commanderId)) {
      res.status(409).json({
        error: `Commander "${commanderId}" heartbeat is already in flight`,
      })
      return
    }

    const timestamp = context.now().toISOString()
    const sessionName = toCommanderSessionName(commanderId)
    const triggered = context.heartbeatManager.fireManual(commanderId, timestamp)
    if (!triggered) {
      res.status(409).json({
        error: `Commander "${commanderId}" heartbeat could not be triggered`,
      })
      return
    }

    res.json({
      runId: timestamp,
      timestamp,
      sessionName,
      triggered: true,
    })
  }

  router.get('/', context.requireReadAccess, async (_req, res) => {
    const sessions = await context.sessionStore.list()
    // Read display names persisted at creation time, best-effort
    let displayNames: Record<string, string> = {}
    try {
      const { resolveCommanderNamesPath } = await import('../paths.js')
      const namesPath = resolveCommanderNamesPath(context.commanderDataDir)
      displayNames = JSON.parse(await readFile(namesPath, 'utf8')) as Record<string, string>
    } catch {
      // names.json may not exist yet — fall back to host for all
    }
    const response = await Promise.all(
      sessions.map(async (session) => {
        const stats = await context.getCommanderSessionStats(session.id)
        const base = toCommanderSessionResponse(session, undefined, stats)
        const withUi = await context.attachCommanderPublicUi(session.id, base)
        const displayName = displayNames[session.id]
        return displayName && displayName !== session.host
          ? { ...withUi, displayName }
          : withUi
      }),
    )
    res.json(response)
  })

  // No auth on avatar — <img src> cannot send bearer headers, and the URL
  // is already keyed on a non-guessable UUID.
  router.get('/:id/avatar', async (req, res) => {
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

    const profile = await readCommanderUiProfile(commanderId, context.commanderBasePath)
    const avatarPath = await resolveCommanderAvatarPath(commanderId, context.commanderBasePath, profile)
    if (!avatarPath) {
      res.status(404).json({ error: 'Avatar not configured' })
      return
    }

    try {
      const buf = await readFile(avatarPath)
      res.setHeader('Content-Type', mimeTypeForAvatarFile(avatarPath))
      res.setHeader('Cache-Control', 'private, max-age=300')
      res.send(buf)
    } catch {
      res.status(404).json({ error: 'Avatar file missing' })
    }
  })

  router.post('/:id/avatar', context.requireWriteAccess, context.avatarUpload.single('avatar'), async (req, res) => {
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

    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'No avatar file uploaded' })
      return
    }

    const extMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
    }
    const ext = extMap[file.mimetype] ?? '.bin'
    const avatarFileName = `avatar${ext}`

    const { commanderRoot } = resolveCommanderPaths(commanderId, context.commanderBasePath)
    await mkdir(commanderRoot, { recursive: true })
    await writeFile(path.join(commanderRoot, avatarFileName), file.buffer)

    const existing = await readCommanderUiProfile(commanderId, context.commanderBasePath)
    await writeCommanderUiProfile(commanderId, context.commanderBasePath, {
      ...(existing ?? {}),
      avatar: avatarFileName,
    } satisfies CommanderUiProfile)

    res.json({ avatarUrl: `/api/commanders/${encodeURIComponent(commanderId)}/avatar` })
  })

  router.patch('/:id/profile', context.requireWriteAccess, async (req, res) => {
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

    const parseField = (value: unknown): string | undefined =>
      typeof value === 'string' ? value.trim() || undefined : undefined

    const persona = parseField(req.body?.persona)
    const borderColor = parseField(req.body?.borderColor)
    const accentColor = parseField(req.body?.accentColor)
    const speakingTone = parseField(req.body?.speakingTone)
    const parsedEffort = parseOptionalCommanderEffort(req.body?.effort)

    if (persona !== undefined && persona.length > MAX_PERSONA_LENGTH) {
      res.status(400).json({ error: `persona must be a string up to ${MAX_PERSONA_LENGTH} characters` })
      return
    }
    if (parsedEffort === null) {
      res.status(400).json({ error: 'effort must be one of: low, medium, high, max' })
      return
    }

    const existing = await readCommanderUiProfile(commanderId, context.commanderBasePath)
    const merged: CommanderUiProfile = {
      ...(existing ?? {}),
      ...(req.body?.borderColor !== undefined ? { borderColor } : {}),
      ...(req.body?.accentColor !== undefined ? { accentColor } : {}),
      ...(req.body?.speakingTone !== undefined ? { speakingTone } : {}),
    }
    await writeCommanderUiProfile(commanderId, context.commanderBasePath, merged)

    if (req.body?.persona !== undefined || req.body?.effort !== undefined) {
      await context.sessionStore.update(commanderId, (current) => ({
        ...current,
        ...(req.body?.persona !== undefined ? { persona } : {}),
        ...(req.body?.effort !== undefined ? { effort: parsedEffort ?? DEFAULT_CLAUDE_EFFORT_LEVEL } : {}),
      }))
    }

    res.json({ ok: true })
  })

  router.get('/:id', context.requireReadAccess, async (req, res) => {
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

    const runtime = context.runtimes.get(commanderId)
    const commanderMd = await readCommanderWorkflowMarkdown(commanderId, context.commanderBasePath)
    const identityMd = await readCommanderIdentity(commanderId, context.commanderBasePath)
    const stats = await context.getCommanderSessionStats(commanderId)
    const base = toCommanderSessionResponse(session, runtime, stats)
    res.json({
      ...(await context.attachCommanderPublicUi(commanderId, base)),
      subAgents: listSubAgentEntries(runtime),
      commanderMd,
      identityMd,
      workflowMd: commanderMd,
    })
  })

  router.get('/:id/heartbeat-log', context.requireReadAccess, async (req, res) => {
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

    const entries = (await context.heartbeatLog.read(commanderId, 50))
      .slice()
      .sort((left, right) => right.firedAt.localeCompare(left.firedAt))
    res.json({ entries })
  })

  router.post('/', context.requireWriteAccess, async (req, res) => {
    const host = parseHost(req.body?.host)
    if (!host) {
      res.status(400).json({ error: 'Invalid host' })
      return
    }

    const taskSource = req.body?.taskSource != null
      ? parseTaskSource(req.body.taskSource)
      : null
    if (req.body?.taskSource != null && !taskSource) {
      res.status(400).json({ error: 'Invalid taskSource' })
      return
    }

    const parsedContextConfig = parseOptionalHeartbeatContextConfig(req.body?.contextConfig)
    if (!parsedContextConfig.valid) {
      res.status(400).json({ error: 'Invalid contextConfig' })
      return
    }

    const existing = await context.sessionStore.list()
    if (existing.some((session) => session.host === host)) {
      res.status(409).json({ error: `Commander for host "${host}" already exists` })
      return
    }

    const displayName = parseMessage(req.body?.displayName) ?? host
    const cwd = parseMessage(req.body?.cwd) ?? undefined
    const avatarSeed = parseMessage(req.body?.avatarSeed) ?? undefined
    const parsedPersona = parseOptionalPersona(req.body?.persona)
    if (!parsedPersona.valid) {
      res.status(400).json({ error: `persona must be a string up to ${MAX_PERSONA_LENGTH} characters` })
      return
    }
    const persona = parsedPersona.value
    const defaultHeartbeat = createDefaultHeartbeatState()
    let heartbeat = defaultHeartbeat

    if (req.body?.heartbeat !== undefined) {
      const parsedHeartbeat = parseHeartbeatPatch(req.body.heartbeat)
      if (!parsedHeartbeat.ok) {
        res.status(400).json({ error: parsedHeartbeat.error })
        return
      }
      heartbeat = mergeHeartbeatState(defaultHeartbeat, parsedHeartbeat.value)
    }

    const parsedAgentTypeCreate = parseOptionalCommanderAgentType(req.body?.agentType)
    if (parsedAgentTypeCreate === null) {
      res.status(400).json({ error: 'agentType must be either "claude", "codex", or "gemini"' })
      return
    }
    const parsedEffortCreate = parseOptionalCommanderEffort(req.body?.effort)
    if (parsedEffortCreate === null) {
      res.status(400).json({ error: 'effort must be one of: low, medium, high, max' })
      return
    }

    const session: CommanderSession = {
      id: randomUUID(),
      host,
      avatarSeed,
      persona,
      pid: null,
      state: 'idle',
      created: context.now().toISOString(),
      agentType: parsedAgentTypeCreate ?? 'claude',
      effort: parsedEffortCreate ?? DEFAULT_CLAUDE_EFFORT_LEVEL,
      heartbeat,
      lastHeartbeat: null,
      heartbeatTickCount: 0,
      contextConfig: parsedContextConfig.value,
      taskSource,
      currentTask: null,
      completedTasks: 0,
      totalCostUsd: 0,
      cwd,
    }

    try {
      const created = await context.sessionStore.create(session)
      try {
        await scaffoldCommanderIdentity(
          created.id,
          {
            id: created.id,
            host: created.host,
            persona,
            created: created.created,
            cwd: created.cwd,
          },
          context.commanderBasePath,
        )
        await scaffoldCommanderWorkflow(
          created.id,
          {
            cwd: created.cwd,
          },
          context.commanderBasePath,
        )
        await context.ensureCommanderMemoryCompactCronTask(created.id)
      } catch (scaffoldError) {
        await context.sessionStore.delete(created.id).catch(() => {})
        throw scaffoldError
      }
      try {
        await withNamesLock(context.commanderDataDir, (names) => { names[created.id] = displayName })
      } catch (error) {
        console.warn(
          `[commanders] Failed to persist display name for "${created.id}":`,
          error,
        )
      }
      res.status(201).json(created)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create commander session',
      })
    }
  })

  router.post('/:id/start', context.requireWriteAccess, async (req, res) => {
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
    if (session.state === 'running') {
      res.status(409).json({ error: `Commander "${commanderId}" is already running` })
      return
    }

    const parsedCurrentTask = parseOptionalCurrentTask(req.body?.currentTask, context.now().toISOString())
    if (!parsedCurrentTask.valid) {
      res.status(400).json({ error: 'Invalid currentTask payload' })
      return
    }
    const parsedAgentType = parseOptionalCommanderAgentType(req.body?.agentType)
    if (parsedAgentType === null) {
      res.status(400).json({ error: 'agentType must be either "claude", "codex", or "gemini"' })
      return
    }
    const selectedAgentType = parsedAgentType ?? resolveCommanderAgentType(session)
    const previousState = session.state
    const previousPid = session.pid
    const previousHeartbeatTickCount = session.heartbeatTickCount
    const sessionName = toCommanderSessionName(commanderId)
    let runtime: CommanderRuntime | null = null
    let startStateUpdated = false

    const rollbackCommanderStart = async (): Promise<void> => {
      context.heartbeatManager.stop(commanderId)
      context.heartbeatFiredAtByCommander.delete(commanderId)

      if (runtime?.collectTimer) {
        clearTimeout(runtime.collectTimer)
        runtime.collectTimer = null
      }
      if (runtime) {
        runtime.pendingCollect = []
        runtime.unsubscribeEvents?.()
        context.runtimes.delete(commanderId)
      }

      context.activeCommanderSessions.delete(commanderId)
      context.sessionsInterface?.deleteSession(sessionName)

      if (!startStateUpdated) {
        return
      }

      await context.sessionStore.update(commanderId, (current) => ({
        ...current,
        state: previousState,
        pid: previousPid,
        heartbeatTickCount: previousHeartbeatTickCount,
      }))
    }

    try {
      await context.questStore.resetActiveToPending(commanderId)

      const manager = new CommanderManager(
        commanderId,
        context.commanderBasePath,
        {
          onSubagentLifecycleEvent: (event) => context.onSubagentLifecycleEvent(commanderId, event),
        },
      )
      await manager.init()
      const contextPressureBridge = createContextPressureBridge()
      const workflow = await resolveCommanderWorkflow(
        commanderId,
        session.cwd,
        context.commanderBasePath,
      )
      const flusher = new EmergencyFlusher(
        commanderId,
        manager.journalWriter,
        {
          postIssueComment: async ({ repo, issueNumber, body }) => {
            const parsedRepo = parseRepoFullName(repo)
            if (!parsedRepo) {
              throw new Error(`Invalid repository reference: ${repo}`)
            }

            const response = await context.fetchImpl(
              `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.name}/issues/${issueNumber}/comments`,
              {
                method: 'POST',
                headers: {
                  ...buildGitHubHeaders(context.githubToken),
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ body }),
              },
            )

            if (!response.ok) {
              throw new Error(await readGitHubError(response))
            }
          },
        },
      )
      const workingMemory = new WorkingMemoryStore(commanderId, context.commanderBasePath)
      await workingMemory.ensure()

      const started = await context.sessionStore.update(commanderId, (current) => ({
        ...current,
        state: 'running',
        agentType: selectedAgentType,
        pid: null,
        heartbeatTickCount: 0,
        currentTask: parsedCurrentTask.value ?? current.currentTask,
      }))

      if (!started) {
        res.status(404).json({ error: `Commander "${commanderId}" not found` })
        return
      }
      startStateUpdated = true

      warnInvalidWorkflowHeartbeatInterval(commanderId, workflow)
      const effectiveHeartbeat = resolveEffectiveHeartbeat(started.heartbeat, workflow.workflow)
      const built = await buildCommanderSessionSeedFromResolvedWorkflow(
        {
          commanderId,
          cwd: started.cwd ?? undefined,
          currentTask: started.currentTask,
          taskSource: started.taskSource,
          memoryBasePath: context.commanderBasePath,
        },
        workflow,
      )

      if (!context.sessionsInterface) {
        throw new Error('sessionsInterface not configured — agents router bridge missing')
      }

      context.sessionsInterface.deleteSession(sessionName)
      await context.sessionsInterface.createCommanderSession({
        name: sessionName,
        systemPrompt: built.systemPrompt,
        agentType: selectedAgentType,
        effort: selectedAgentType === 'claude'
          ? started.effort ?? DEFAULT_CLAUDE_EFFORT_LEVEL
          : undefined,
        cwd: started.cwd ?? undefined,
        resumeSessionId: undefined,
        maxTurns: built.maxTurns,
      })

      const initialStreamSession = context.sessionsInterface.getSession(sessionName)
      const initialInputTokens = (
        typeof initialStreamSession?.usage.inputTokens === 'number' &&
        Number.isFinite(initialStreamSession.usage.inputTokens)
      )
        ? initialStreamSession.usage.inputTokens
        : 0

      runtime = {
        manager,
        flusher,
        workingMemory,
        contextPressureBridge,
        lastTaskState: 'Commander started',
        heartbeatCount: 0,
        lastKnownInputTokens: initialInputTokens,
        forceNextFatHeartbeat: false,
        preCompactionFlushTriggeredForCycle: false,
        pendingSpikeObservations: [],
        pendingCollect: [],
        collectTimer: null,
        subAgents: new Map(),
      }

      let contextPressureTriggeredForTurn = false
      const unsubscribeEvents = context.sessionsInterface.subscribeToEvents(sessionName, (event) => {
        const eventType = typeof event.type === 'string' ? event.type : ''
        if (eventType === 'message_start') {
          contextPressureTriggeredForTurn = false
        }
        const streamSession = context.sessionsInterface?.getSession(sessionName)
        const sessionInputTokens = (
          typeof streamSession?.usage.inputTokens === 'number' &&
          Number.isFinite(streamSession.usage.inputTokens)
        )
          ? streamSession.usage.inputTokens
          : 0

        if (
          runtime &&
          !runtime.preCompactionFlushTriggeredForCycle &&
          !contextPressureTriggeredForTurn &&
          (
            isLegacyContextPressureEvent(event) ||
            isInputTokenContextPressureEvent(
              event,
              sessionInputTokens,
              context.contextPressureInputTokenThreshold,
            )
          )
        ) {
          contextPressureTriggeredForTurn = true
          runtime.preCompactionFlushTriggeredForCycle = true
          void contextPressureBridge.trigger()
        }

        if (eventType === 'result' && runtime) {
          const observedPostCompactionBoundary = (
            runtime.lastKnownInputTokens > 0 &&
            sessionInputTokens > 0 &&
            sessionInputTokens < runtime.lastKnownInputTokens * 0.5
          )

          if (observedPostCompactionBoundary) {
            runtime.forceNextFatHeartbeat = true
            runtime.preCompactionFlushTriggeredForCycle = false
          }
          runtime.lastKnownInputTokens = sessionInputTokens
          contextPressureTriggeredForTurn = false
        }
      })

      runtime.unsubscribeEvents = unsubscribeEvents

      manager.wirePreCompactionFlush(
        contextPressureBridge,
        flusher,
        () => buildFlushContext(started, runtime!),
      )

      context.runtimes.set(commanderId, runtime)
      context.activeCommanderSessions.set(commanderId, {
        sessionName,
        startedAt: context.now().toISOString(),
      })
      context.heartbeatManager.start(commanderId, effectiveHeartbeat)
      const startPrompt = parseMessage(req.body?.message) ?? STARTUP_PROMPT
      const sessionRepo = toSessionRepo(started)
      const startIssueNumber = started.currentTask?.issueNumber ?? null

      try {
        await Promise.all([
          workingMemory.update({
            source: 'start',
            summary: startPrompt,
            hypothesis: extractHypothesisFromMessage(startPrompt),
            files: extractFileMentionsFromMessage(startPrompt),
            issueNumber: startIssueNumber,
            repo: sessionRepo,
            tags: startIssueNumber != null ? ['startup', 'task-linked'] : ['startup'],
          }),
          manager.journalWriter.append({
            timestamp: context.now().toISOString(),
            issueNumber: startIssueNumber,
            repo: sessionRepo,
            outcome: 'Commander session started',
            durationMin: null,
            salience: startIssueNumber != null ? 'NOTABLE' : 'ROUTINE',
            body: [
              `- Session: \`${sessionName}\``,
              `- Fat pin interval: \`${started.contextConfig?.fatPinInterval ?? 0}\` heartbeat(s)`,
              `- Start prompt: ${startPrompt}`,
              startIssueNumber != null
                ? `- Current task URL: ${started.currentTask?.issueUrl ?? '_unknown_'}`
                : '- Current task: _none_',
            ].join('\n'),
          }),
        ])
        await context.refreshCommanderMemoryIndex(commanderId)
      } catch (memoryError) {
        console.error(`[commanders] Failed to persist startup memory for "${commanderId}":`, memoryError)
      }

      const startupSent = await context.sessionsInterface.sendToSession(sessionName, startPrompt)
      if (!startupSent) {
        console.warn(
          `[commanders] Startup message failed for "${commanderId}" (${selectedAgentType}); resetting runtime state`,
        )
        await rollbackCommanderStart()

        res.status(503).json({
          error: 'Commander startup message could not be delivered. Please retry start.',
        })
        return
      }

      res.json({
        id: started.id,
        state: started.state,
        started: true,
      })
    } catch (error) {
      try {
        await rollbackCommanderStart()
      } catch (rollbackError) {
        console.error(`[commanders] Failed to roll back start for "${commanderId}":`, rollbackError)
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to start commander',
      })
    }
  })

  router.post('/:id/heartbeat', context.requireWriteAccess, triggerHeartbeatRoute)
  router.post('/:id/heartbeat/trigger', context.requireWriteAccess, triggerHeartbeatRoute)

  router.post('/:id/stop', context.requireWriteAccess, async (req, res) => {
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

    context.heartbeatManager.stop(commanderId)
    context.heartbeatFiredAtByCommander.delete(commanderId)
    const activeSession = context.activeCommanderSessions.get(commanderId)
    const sessionName = activeSession?.sessionName ?? toCommanderSessionName(commanderId)

    const runtime = context.runtimes.get(commanderId)
    if (runtime) {
      if (runtime.collectTimer) {
        clearTimeout(runtime.collectTimer)
        runtime.collectTimer = null
      }
      runtime.pendingCollect = []
      const stopState = parseMessage(req.body?.state) ?? 'Commander stop requested'
      runtime.lastTaskState = stopState
      runtime.unsubscribeEvents?.()

      try {
        await Promise.all([
          runtime.workingMemory.update({
            source: 'stop',
            summary: stopState,
            issueNumber: session.currentTask?.issueNumber ?? null,
            repo: toSessionRepo(session),
            hypothesis: extractHypothesisFromMessage(stopState),
            files: extractFileMentionsFromMessage(stopState),
            tags: ['stop'],
          }),
          runtime.manager.journalWriter.append({
            timestamp: context.now().toISOString(),
            issueNumber: session.currentTask?.issueNumber ?? null,
            repo: toSessionRepo(session),
            outcome: 'Commander stop requested',
            durationMin: null,
            salience: 'NOTABLE',
            body: [
              `- Session: \`${sessionName}\``,
              `- State: ${stopState}`,
            ].join('\n'),
          }),
        ])
        await context.refreshCommanderMemoryIndex(commanderId)
      } catch (memoryError) {
        console.error(`[commanders] Failed to persist stop memory for "${commanderId}":`, memoryError)
      }

      const agentSession = context.sessionsInterface?.getSession(sessionName)
      if (agentSession) {
        const sessionCostUsd = agentSession.usage?.costUsd ?? 0
        await context.sessionStore.update(commanderId, (current) => ({
          ...current,
          agentType: resolveCommanderAgentType(current),
          claudeSessionId: agentSession.claudeSessionId ?? current.claudeSessionId,
          codexThreadId: agentSession.codexThreadId ?? current.codexThreadId,
          geminiSessionId: agentSession.geminiSessionId ?? current.geminiSessionId,
          totalCostUsd: current.totalCostUsd + sessionCostUsd,
        }))
      }

      const latestSession = (await context.sessionStore.get(commanderId)) ?? session
      try {
        await runtime.manager.flushBetweenTasksAndPickNext(
          runtime.flusher,
          () => buildFlushContext(latestSession, runtime),
          async () => {
            runtime.forceNextFatHeartbeat = true
          },
        )
      } catch (error) {
        const flushErrorEvent = {
          type: 'system',
          text: `Commander flush failed on stop: ${error instanceof Error ? error.message : String(error)}`,
        } satisfies StreamEvent
        console.error('[commanders] Failed to flush on stop:', flushErrorEvent.text)
      }

      context.runtimes.delete(commanderId)
    }

    context.activeCommanderSessions.delete(commanderId)
    context.sessionsInterface?.deleteSession(sessionName)

    const stopped = await context.sessionStore.update(commanderId, (current) => ({
      ...current,
      state: 'stopped',
      pid: null,
      currentTask: null,
    }))

    if (!stopped) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    res.json({
      id: stopped.id,
      state: stopped.state,
      stopped: true,
    })
  })

  router.delete('/:id', context.requireWriteAccess, async (req, res) => {
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

    if (session.state === 'running') {
      res.status(409).json({ error: `Commander "${commanderId}" is running. Stop it before deleting.` })
      return
    }

    context.heartbeatManager.stop(commanderId)
    context.heartbeatFiredAtByCommander.delete(commanderId)

    const runtime = context.runtimes.get(commanderId)
    if (runtime) {
      if (runtime.collectTimer) {
        clearTimeout(runtime.collectTimer)
        runtime.collectTimer = null
      }
      runtime.pendingCollect = []
      runtime.unsubscribeEvents?.()
      context.runtimes.delete(commanderId)
    }
    context.activeCommanderSessions.delete(commanderId)
    context.sessionsInterface?.deleteSession(toCommanderSessionName(commanderId))

    await context.sessionStore.delete(commanderId)
    try {
      await withNamesLock(context.commanderDataDir, (names) => { delete names[commanderId] })
    } catch (error) {
      console.warn(
        `[commanders] Failed to remove display name for "${commanderId}":`,
        error,
      )
    }
    res.status(204).send()
  })

  router.patch('/:id/heartbeat', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const parsed = parseHeartbeatPatch(req.body)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }

    const updated = await context.sessionStore.update(commanderId, (current) => {
      const heartbeat = mergeHeartbeatState(current.heartbeat, parsed.value)
      return {
        ...current,
        heartbeat,
      }
    })

    if (!updated) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    if (updated.state === 'running') {
      const workflow = await resolveCommanderWorkflow(
        commanderId,
        updated.cwd,
        context.commanderBasePath,
      )
      warnInvalidWorkflowHeartbeatInterval(commanderId, workflow)
      const effectiveHeartbeat = resolveEffectiveHeartbeat(updated.heartbeat, workflow.workflow)
      context.heartbeatManager.start(commanderId, effectiveHeartbeat)
    } else {
      context.heartbeatManager.stop(commanderId)
    }

    res.json({
      id: updated.id,
      heartbeat: {
        intervalMs: updated.heartbeat.intervalMs,
        messageTemplate: updated.heartbeat.messageTemplate,
        lastSentAt: updated.heartbeat.lastSentAt,
      },
      lastHeartbeat: updated.lastHeartbeat,
    })
  })

  router.post('/:id/message', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const message = parseMessage(req.body?.message)
    if (!message) {
      res.status(400).json({ error: 'Message must be a non-empty string' })
      return
    }
    const mode = parseMessageMode(req.query.mode)
    if (!mode) {
      res.status(400).json({ error: 'mode must be either "collect" or "followup"' })
      return
    }

    const spikes = parseOptionalStringArray(req.body?.pendingSpikeObservations)
    if (spikes === null) {
      res.status(400).json({ error: 'pendingSpikeObservations must be an array of strings' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const runtime = context.runtimes.get(commanderId)
    if (!runtime || session.state !== 'running') {
      res.status(409).json({ error: `Commander "${commanderId}" is not running` })
      return
    }

    const delivered = await context.dispatchCommanderMessage({
      commanderId,
      message,
      mode,
      pendingSpikeObservations: spikes,
      session,
      runtime,
    })
    if (!delivered.ok) {
      if (delivered.status === 409) {
        res.status(409).json({ error: `Commander "${commanderId}" is not running` })
        return
      }
      res.status(delivered.status).json({ error: delivered.error })
      return
    }

    res.json({ accepted: true })
  })
}
