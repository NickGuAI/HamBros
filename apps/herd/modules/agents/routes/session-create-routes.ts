import type { Request, RequestHandler, Router } from 'express'
import { WebSocket } from 'ws'
import { CODEX_MODE_COMMANDS, DEFAULT_COLS, DEFAULT_ROWS } from '../constants.js'
import {
  buildClaudePtyCommand,
  resolveClaudeApprovalBaseUrl,
  resolveClaudeApprovalPort,
} from '../adapters/claude/helpers.js'
import {
  DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE,
  type ClaudeAdaptiveThinkingMode,
} from '../../claude-adaptive-thinking.js'
import { DEFAULT_CLAUDE_EFFORT_LEVEL, isClaudeEffortLevel } from '../../claude-effort.js'
import { DEFAULT_CLAUDE_MAX_THINKING_TOKENS } from '../../claude-max-thinking-tokens.js'
import {
  createApprovalBridgeNonce,
  createApprovalBridgeToken,
} from '../../policies/approval-bridge-token.js'
import { appendToBuffer, broadcastOutput } from '../session/helpers.js'
import { ProviderAuthRequiredError } from '../provider-auth.js'
import { ProviderExecutionModeError } from '../provider-execution-mode.js'
import type { MachineLaunchRuntime } from '../session/machine-launch.js'
import {
  getAgentEffortLevels,
  getAgentModelEffortCapability,
  getDefaultAgentEffort,
  parseOptionalAgentEffort,
  parseStoredAgentEffort,
  type AgentEffortLevel,
} from '../effort.js'
import type { ProviderCreateOptions } from '../providers/provider-adapter.js'
import {
  providerSupportsPermissionMode,
  resolveProviderDefaults,
  unsupportedProviderPermissionModeError,
} from '../providers/provider-adapter.js'
import { getProvider, resolveProviderIdForRequest } from '../providers/registry.js'
import { asClaudeProviderContext } from '../providers/provider-session-context.js'
import { getCachedProviderModelsForValidation } from '../providers/model-discovery.js'
import {
  findProviderModelOption,
  validateModelForAgentType,
} from '../providers/validate-model.js'
import {
  codexRolloutUnavailableMessage,
  hasCodexRolloutFile,
  isMissingCodexRolloutError,
} from '../adapters/codex/helpers.js'
import {
  buildLoginShellCommand,
  buildSshArgs,
  countMachineEnvSendKeys,
  isDaemonMachine,
  isRemoteMachine,
  prepareDaemonMachineLaunchEnvironment,
  prepareMachineLaunchEnvironment,
} from '../machines.js'
import { MachineDaemonRegistry } from '../daemon/registry.js'
import {
  parseActiveSkillInvocation,
  parseClaudeAdaptiveThinking,
  parseClaudeMaxThinkingTokens,
  parseCwd,
  parseMachinePlacement,
  parseOptionalClaudePermissionMode,
  parseOptionalModel,
  parseOptionalSessionName,
  parseOptionalTask,
  parseSessionCreator,
  parseSessionName,
  parseSessionTransportType,
  parseSessionType,
} from '../session/input.js'
import type {
  AgentType,
  AnySession,
  ClaudePermissionMode,
  MachineConfig,
  PersistedSessionsState,
  PtySession,
  PtySpawner,
  ResolvedResumableSessionSource,
  SessionCreator,
  SessionTransportType,
  SessionType,
  StreamSession,
} from '../types.js'
import {
  asWorkerLaunchBody,
  COMMANDER_WORKER_LAUNCH_BODY_KEYS,
  launchProviderWorkerSession,
  parseWorkerLaunchRequest,
} from '../worker-launch.js'
import { withCommanderRuntimeLaunch } from '../../commanders/package-lifecycle-state.js'

type ProviderStreamSessionOptions = Omit<
  ProviderCreateOptions,
  'sessionName' | 'mode' | 'task' | 'cwd' | 'machine'
>

const SESSION_CREATE_ROUTE_ONLY_WORKER_BODY_KEYS = new Set([
  'mode',
  'resumeFromSession',
  'transportType',
])

function buildSessionCreateWorkerLaunchBody(rawBody: unknown): Record<string, unknown> {
  const body = asWorkerLaunchBody(rawBody)
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => !SESSION_CREATE_ROUTE_ONLY_WORKER_BODY_KEYS.has(key)),
  )
}

interface SessionCreateRouteDeps {
  commanderLifecycleScope?: string
  router: Router
  requireWriteAccess: RequestHandler
  sessions: Map<string, AnySession>
  maxSessions: number
  taskDelayMs: number
  approvalBridgeSigningSecret?: string
  daemonRegistry: MachineDaemonRegistry
  isInternalSessionRequest(req: Request): boolean
  sessionCreatorIdFromUser(req: Request): string | undefined
  getSpawner(): Promise<PtySpawner>
  readPersistedSessionsState(): Promise<PersistedSessionsState>
  resolveResumableSessionSource(
    sessionName: string,
    persistedState: PersistedSessionsState,
  ): { source?: ResolvedResumableSessionSource; error?: { status: number; message: string } }
  clearCodexResumeMetadata(sessionName: string): void
  resolveProviderLaunchMachine: MachineLaunchRuntime['resolveProviderLaunchMachine']
  createProviderStreamSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    task: string,
    cwd: string | undefined,
    machine: MachineConfig | undefined,
    agentType?: AgentType,
    options?: ProviderStreamSessionOptions,
  ): Promise<StreamSession>
  retireLiveSessionForResume(sessionName: string, session: StreamSession): void
  schedulePersistedSessionsWrite(): void
}

function sendProviderAuthRequiredResponse(res: Parameters<RequestHandler>[1], error: ProviderAuthRequiredError): void {
  res.status(424).json({
    code: 'AUTH_REQUIRED',
    provider: error.provider,
    status: error.snapshot.status,
    authMethod: error.snapshot.authMethod,
    scopeId: error.snapshot.scopeId,
    host: error.snapshot.host,
    reauthUrl: error.snapshot.reauthUrl,
    error: error.message,
  })
}

export function registerSessionCreateRoutes(deps: SessionCreateRouteDeps): void {
  const {
    router,
    requireWriteAccess,
    sessions,
    maxSessions,
    taskDelayMs,
    approvalBridgeSigningSecret,
    daemonRegistry,
  } = deps

  router.post('/sessions/:name/workers', requireWriteAccess, async (req, res) => {
    const sourceSessionName = parseSessionName(req.params.name)
    if (!sourceSessionName) {
      res.status(400).json({ error: 'Invalid source session name' })
      return
    }

    const sourceSession = sessions.get(sourceSessionName)
    if (!sourceSession || sourceSession.kind !== 'stream') {
      res.status(404).json({ error: `Stream session "${sourceSessionName}" not found` })
      return
    }

    const placement = parseMachinePlacement(req.body?.machineId, req.body?.host)
    if (!placement.ok) {
      res.status(400).json({ error: placement.error })
      return
    }

    const generatedName = `${sourceSessionName}-worker-${Date.now()}`
    const parsed = parseWorkerLaunchRequest({
      allowedBodyKeys: COMMANDER_WORKER_LAUNCH_BODY_KEYS,
      creator: sourceSession.creator,
      currentSkillInvocationNull: 'clear',
      fallbackCwd: sourceSession.cwd ?? process.env.HOME ?? '/tmp',
      generatedName,
      preferMachineCwd: placement.machineId !== undefined,
      rawBody: req.body,
      requireName: false,
      routeLabel: '/api/agents/sessions/:name/workers',
      sourceDefaults: {
        agentType: sourceSession.agentType,
        adaptiveThinking: sourceSession.adaptiveThinking,
        currentSkillInvocation: sourceSession.currentSkillInvocation,
        cwd: sourceSession.cwd,
        effort: sourceSession.effort,
        omitEffort: asClaudeProviderContext(sourceSession.providerContext)?.omitEffort,
        host: sourceSession.host,
        maxThinkingTokens: sourceSession.maxThinkingTokens,
        mode: sourceSession.mode,
        model: sourceSession.model,
      },
      spawnedBy: sourceSessionName,
    })
    if (!parsed.ok) {
      res.status(parsed.status).json(parsed.body)
      return
    }

    const launched = await launchProviderWorkerSession(
      {
        commanderLifecycleScope: deps.commanderLifecycleScope,
        createProviderStreamSession: deps.createProviderStreamSession,
        maxSessions,
        resolveMachine: (requestedMachineId) => (
          deps.resolveProviderLaunchMachine(requestedMachineId, parsed.request.agentType)
        ),
        schedulePersistedSessionsWrite: deps.schedulePersistedSessionsWrite,
        sessions,
      },
      parsed.request,
      {
        missingCwdError: `Source session "${sourceSessionName}" has no cwd; provide cwd or machineId when dispatching a worker`,
      },
    )
    if (!launched.ok) {
      res.status(launched.status).json(launched.body)
      return
    }

    if (!sourceSession.spawnedWorkers.includes(launched.session.name)) {
      sourceSession.spawnedWorkers = [...sourceSession.spawnedWorkers, launched.session.name]
      deps.schedulePersistedSessionsWrite()
    }

    res.status(201).json({
      sessionName: launched.session.name,
      mode: parsed.request.mode,
      sessionType: launched.session.sessionType,
      creator: launched.session.creator,
      spawnedBy: launched.session.spawnedBy,
      transportType: 'stream',
      agentType: parsed.request.agentType,
      host: launched.session.host,
      created: true,
    })
  })

  router.post('/sessions', requireWriteAccess, async (req, res) => {
    const sessionName = parseSessionName(req.body?.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const requestedMode = parseOptionalClaudePermissionMode(req.body?.permissionMode ?? req.body?.mode)
    if (requestedMode === null) {
      res.status(400).json({
        error: 'Invalid permissionMode. Expected one of: default, acceptEdits, bypassPermissions',
      })
      return
    }

    const parsedAdaptiveThinking = parseClaudeAdaptiveThinking(req.body?.adaptiveThinking)
    if (parsedAdaptiveThinking === null) {
      res.status(400).json({ error: 'Invalid adaptiveThinking. Expected one of: enabled, disabled' })
      return
    }

    const parsedMaxThinkingTokens = parseClaudeMaxThinkingTokens(req.body?.maxThinkingTokens)
    if (parsedMaxThinkingTokens === null) {
      res.status(400).json({ error: 'Invalid maxThinkingTokens. Expected integer 1024..256000' })
      return
    }

    const task = parseOptionalTask(req.body?.task)
    if (task === null) {
      res.status(400).json({ error: 'Task must be a string' })
      return
    }

    const model = parseOptionalModel(req.body?.model)
    if (model === null) {
      res.status(400).json({ error: 'model must be a string when provided' })
      return
    }

    const resumeFromSession = parseOptionalSessionName(req.body?.resumeFromSession)
    if (resumeFromSession === null) {
      res.status(400).json({ error: 'Invalid resume session name' })
      return
    }

    if (sessions.has(sessionName)) {
      res.status(409).json({ error: `Session "${sessionName}" already exists` })
      return
    }

    let resumeSource: ResolvedResumableSessionSource | undefined
    if (resumeFromSession) {
      let persistedState: PersistedSessionsState
      try {
        persistedState = await deps.readPersistedSessionsState()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load persisted sessions'
        res.status(500).json({ error: message })
        return
      }

      const resolved = deps.resolveResumableSessionSource(resumeFromSession, persistedState)
      if (!resolved.source) {
        res.status(resolved.error?.status ?? 404).json({
          error: resolved.error?.message ?? `Session "${resumeFromSession}" is not resumable`,
        })
        return
      }
      resumeSource = resolved.source
    }

    if (sessions.size >= maxSessions && !resumeSource?.liveSession) {
      res.status(429).json({ error: `Session limit reached (${maxSessions})` })
      return
    }

    const requestedCreator = parseSessionCreator(req.body?.creator)
    if (requestedCreator === null) {
      res.status(400).json({ error: 'Invalid creator. Expected { kind, id? }' })
      return
    }
    const requestedCurrentSkillInvocation = parseActiveSkillInvocation(req.body?.currentSkillInvocation)
    if (requestedCurrentSkillInvocation === null) {
      res.status(400).json({
        error: 'Invalid currentSkillInvocation. Expected { skillId, displayName, startedAt, toolUseId? }',
      })
      return
    }

    const internalSessionRequest = deps.isInternalSessionRequest(req)
    const defaultHumanCreator: SessionCreator = {
      kind: 'human',
      ...(deps.sessionCreatorIdFromUser(req) ? { id: deps.sessionCreatorIdFromUser(req) } : {}),
    }
    const creator = resumeSource?.source.creator ?? requestedCreator ?? defaultHumanCreator
    if (!internalSessionRequest && creator.kind !== 'human') {
      const errorMessage = creator.kind === 'commander'
        ? 'creator: commander requires the canonical /api/commanders/:id/workers route, which provides URL-baked commander identity'
        : `Only internal callers can create ${creator.kind} session creators`
      res.status(403).json({ error: errorMessage })
      return
    }

    const rawRequestedSessionType = req.body?.sessionType
    const requestedSessionType = parseSessionType(rawRequestedSessionType)
    if (requestedSessionType === null) {
      res.status(400).json({
        error: 'Invalid sessionType. Expected one of: commander, worker, cron, sentinel, automation',
      })
      return
    }
    const sessionType: SessionType = resumeSource?.source.sessionType
      ?? requestedSessionType
      ?? (creator.kind === 'human' ? 'worker' : creator.kind)
    if (!internalSessionRequest && sessionType !== 'worker') {
      res.status(403).json({ error: 'Only internal callers can create non-worker session types' })
      return
    }

    const cwd = resumeSource?.source.cwd ?? parseCwd(req.body?.cwd)
    if (cwd === null) {
      res.status(400).json({ error: 'Invalid cwd: must be an absolute path' })
      return
    }

    let agentType = resumeSource?.source.agentType
    if (!agentType) {
      const providerResolution = resolveProviderIdForRequest(req.body?.agentType)
      if (providerResolution.error || !providerResolution.providerId) {
        res.status(400).json({
          error: providerResolution.error ?? 'agentType must be a registered provider id',
          validIds: providerResolution.validIds,
        })
        return
      }
      agentType = providerResolution.providerId
    }
    const provider = getProvider(agentType)
    if (!provider) {
      res.status(400).json({ error: `Unknown provider: ${agentType}` })
      return
    }
    const providerDefaults = resolveProviderDefaults(provider)
    const sourceOmitsEffort = resumeSource?.source.agentType === agentType
      && asClaudeProviderContext(resumeSource.source.providerContext)?.omitEffort === true
    const parsedEffort = parseOptionalAgentEffort(agentType, req.body?.effort)
    if (parsedEffort === null) {
      res.status(400).json({
        error: `Invalid effort for ${agentType}. Expected one of: ${getAgentEffortLevels(agentType).join(', ')}`,
      })
      return
    }
    const mode: ClaudePermissionMode = requestedMode ?? resumeSource?.source.mode ?? 'default'
    if (!providerSupportsPermissionMode(provider, mode)) {
      res.status(400).json({ error: unsupportedProviderPermissionModeError(provider, mode) })
      return
    }
    const effectiveModel = model ?? resumeSource?.source.model ?? null
    const usesTrustedResumeModel = resumeSource?.source.agentType === agentType
      && resumeSource.source.model !== undefined
      && effectiveModel === resumeSource.source.model
      && (model === undefined || model === resumeSource.source.model)
    const resumeOmitsEffort = usesTrustedResumeModel && sourceOmitsEffort
    const modelValidation = usesTrustedResumeModel
      ? { ok: true as const }
      : validateModelForAgentType(agentType, effectiveModel)
    if (!modelValidation.ok) {
      res.status(400).json({ error: modelValidation.error, validIds: modelValidation.validIds })
      return
    }
    const resolvedModels = getCachedProviderModelsForValidation(provider)
    const modelOption = findProviderModelOption(resolvedModels.models, effectiveModel)
    const modelEffortCapability = getAgentModelEffortCapability(agentType, modelOption)
    const supportedEffortLevels = modelEffortCapability.supportedEffortLevels
    const modelOmitsEffort = provider.uiCapabilities.supportsEffort
      && !modelEffortCapability.supportsEffort
    const omitEffort = resumeOmitsEffort || modelOmitsEffort
    if (omitEffort && parsedEffort) {
      res.status(400).json({
        error: `Model "${modelOption?.label ?? effectiveModel ?? agentType}" does not support effort`,
      })
      return
    }
    const storedResumeEffort = parseStoredAgentEffort(agentType, resumeSource?.source.effort)
    const effort: AgentEffortLevel | undefined = provider.uiCapabilities.supportsEffort && !omitEffort
      ? (
        parsedEffort
        ?? storedResumeEffort
        ?? providerDefaults.effort
        ?? getDefaultAgentEffort(agentType)
      )
      : undefined
    if (effort && !supportedEffortLevels.includes(effort)) {
      res.status(400).json({
        error: `Invalid effort for model "${modelOption?.label ?? effectiveModel ?? agentType}". Expected one of: ${supportedEffortLevels.join(', ')}`,
      })
      return
    }
    const adaptiveThinking: ClaudeAdaptiveThinkingMode | undefined = provider.uiCapabilities.supportsAdaptiveThinking
      ? (
        resumeSource?.source.adaptiveThinking
        ?? parsedAdaptiveThinking
        ?? providerDefaults.adaptiveThinking
        ?? DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE
      )
      : undefined
    const maxThinkingTokens = provider.uiCapabilities.supportsMaxThinkingTokens
      ? (
        resumeSource?.source.maxThinkingTokens
        ?? parsedMaxThinkingTokens
        ?? providerDefaults.maxThinkingTokens
        ?? DEFAULT_CLAUDE_MAX_THINKING_TOKENS
      )
      : undefined
    const rawTransportType = req.body?.transportType
    const defaultExplicitWorkerToStream = !resumeSource
      && requestedSessionType === 'worker'
      && (rawTransportType === undefined || rawTransportType === null || rawTransportType === '')
    const transportType: Exclude<SessionTransportType, 'external'> = resumeSource || provider.uiCapabilities.forcedTransport === 'stream'
      ? 'stream'
      : defaultExplicitWorkerToStream
        ? 'stream'
        : parseSessionTransportType(rawTransportType)
    if (!resumeSource && requestedSessionType === 'worker' && transportType !== 'stream') {
      res.status(400).json({
        error: 'sessionType "worker" requires transportType "stream" on /api/agents/sessions',
      })
      return
    }
    const placement = resumeSource
      ? { ok: true as const, machineId: resumeSource.source.host }
      : parseMachinePlacement(req.body?.machineId, req.body?.host)
    if (!placement.ok) {
      res.status(400).json({ error: placement.error })
      return
    }
    const requestedHost = placement.machineId

    const resumeProvider = resumeSource ? getProvider(resumeSource.source.agentType) : undefined
    const resumeProviderId = resumeSource
      ? resumeProvider?.getResumeId(resumeSource.source as unknown as StreamSession)
      : undefined
    if (
      resumeSource &&
      !resumeSource.liveSession &&
      resumeProvider?.id === 'codex' &&
      resumeProviderId &&
      !resumeSource.source.host &&
      !(await hasCodexRolloutFile(resumeProviderId, resumeSource.source.createdAt))
    ) {
      deps.clearCodexResumeMetadata(resumeFromSession!)
      res.status(409).json({
        error: codexRolloutUnavailableMessage(resumeFromSession!),
      })
      return
    }

    if (!resumeSource && sessionType === 'worker' && transportType === 'stream') {
      const parsed = parseWorkerLaunchRequest({
        allowedBodyKeys: COMMANDER_WORKER_LAUNCH_BODY_KEYS,
        creator,
        currentSkillInvocationNull: 'invalid',
        fallbackCwd: process.env.HOME ?? '/tmp',
        mode,
        preferMachineCwd: requestedHost !== undefined,
        rawBody: buildSessionCreateWorkerLaunchBody(req.body),
        requireName: true,
        routeLabel: '/api/agents/sessions',
      })
      if (!parsed.ok) {
        res.status(parsed.status).json(parsed.body)
        return
      }

      const launched = await launchProviderWorkerSession(
        {
          commanderLifecycleScope: deps.commanderLifecycleScope,
          createProviderStreamSession: deps.createProviderStreamSession,
          maxSessions,
          resolveMachine: (requestedMachineId) => (
            deps.resolveProviderLaunchMachine(requestedMachineId, parsed.request.agentType)
          ),
          schedulePersistedSessionsWrite: deps.schedulePersistedSessionsWrite,
          sessions,
        },
        parsed.request,
        {
          missingCwdError: 'Provide cwd or machineId when creating a worker stream session',
        },
      )
      if (!launched.ok) {
        res.status(launched.status).json(launched.body)
        return
      }

      res.status(201).json({
        sessionName: parsed.request.sessionName,
        mode: parsed.request.mode,
        sessionType: launched.session.sessionType,
        creator: launched.session.creator,
        transportType: 'stream',
        agentType: parsed.request.agentType,
        host: launched.session.host,
        created: true,
      })
      return
    }

    const resolvedMachine = await deps.resolveProviderLaunchMachine(requestedHost, agentType)
    if (!resolvedMachine.ok) {
      res.status(resolvedMachine.status).json({
        ...(resolvedMachine.code ? { code: resolvedMachine.code } : {}),
        error: resolvedMachine.error,
      })
      return
    }
    const machine = resolvedMachine.machine

    const requestedMachineCwd = cwd ?? machine?.cwd
    const sessionCwd = requestedMachineCwd ?? process.env.HOME ?? '/tmp'
    const daemonMachine = isDaemonMachine(machine) ? machine : undefined
    const remoteMachine = isRemoteMachine(machine) ? machine : undefined

    if (transportType === 'stream') {
      try {
        const session = await deps.createProviderStreamSession(
          sessionName,
          mode,
          task ?? '',
          requestedMachineCwd,
          machine,
          agentType,
          {
            effort,
            ...(omitEffort ? { omitEffort: true } : {}),
            adaptiveThinking,
            maxThinkingTokens,
            model: effectiveModel ?? undefined,
            resumeSessionId: resumeSource ? provider.getResumeId(resumeSource.source) : undefined,
            resumedFrom: resumeFromSession,
            sessionType,
            creator,
            conversationId: resumeSource?.source.conversationId,
            currentSkillInvocation: resumeSource
              ? resumeSource.source.currentSkillInvocation
              : requestedCurrentSkillInvocation,
            spawnedBy: resumeSource?.source.spawnedBy,
            spawnedWorkers: resumeSource?.source.spawnedWorkers,
          },
        )
        if (resumeSource?.liveSession) {
          deps.retireLiveSessionForResume(resumeFromSession!, resumeSource.liveSession)
        }
        sessions.set(sessionName, session)
        deps.schedulePersistedSessionsWrite()
        res.status(201).json({
          sessionName,
          mode,
          sessionType: session.sessionType,
          creator: session.creator,
          transportType: 'stream',
          agentType,
          host: session.host,
          created: true,
        })
      } catch (err) {
        if (resumeFromSession && isMissingCodexRolloutError(err)) {
          deps.clearCodexResumeMetadata(resumeFromSession)
          res.status(409).json({
            error: codexRolloutUnavailableMessage(resumeFromSession),
          })
          return
        }
        if (err instanceof ProviderAuthRequiredError) {
          sendProviderAuthRequiredResponse(res, err)
          return
        }
        if (err instanceof ProviderExecutionModeError) {
          res.status(err.statusCode).json({ code: err.code, error: err.message })
          return
        }
        const message = err instanceof Error ? err.message : 'Failed to create stream session'
        res.status(500).json({ error: message })
      }
      return
    }

    const launchPtySession = async (): Promise<void> => {
      const ptyEffort = effort ?? providerDefaults.effort ?? getDefaultAgentEffort(agentType)
      const claudeEffort = isClaudeEffortLevel(ptyEffort)
        ? ptyEffort
        : DEFAULT_CLAUDE_EFFORT_LEVEL
      const ptySpawner = daemonMachine ? null : await deps.getSpawner()
      const localSpawnCwd = process.env.HOME || '/tmp'
      const preparedLaunch = daemonMachine
        ? prepareDaemonMachineLaunchEnvironment(daemonMachine)
        : prepareMachineLaunchEnvironment(machine, process.env)
      const providerPtyEnv = provider.preparePtyEnv?.({ mode, effort: ptyEffort }) ?? {}
      const requiresApprovalBridge = provider.uiCapabilities.supportsAdaptiveThinking
      const approvalBridgeNonce = requiresApprovalBridge ? createApprovalBridgeNonce() : undefined
      const approvalBridgeToken = requiresApprovalBridge && approvalBridgeSigningSecret && approvalBridgeNonce
        ? createApprovalBridgeToken({
            signingSecret: approvalBridgeSigningSecret,
            sessionName,
            nonce: approvalBridgeNonce,
          })
        : undefined
      const approvalBaseUrl = resolveClaudeApprovalBaseUrl(process.env)
      const approvalPort = resolveClaudeApprovalPort(process.env)
      const remoteShellCommand = buildLoginShellCommand(
        'exec "${SHELL:-/bin/bash}" -l',
        requestedMachineCwd,
        remoteMachine || daemonMachine ? preparedLaunch.sourcedEnvFile : undefined,
        remoteMachine ? countMachineEnvSendKeys(preparedLaunch.sshSendEnvKeys) : 0,
      )
      const remoteApprovalBridge = remoteMachine && requiresApprovalBridge
        ? {
            port: approvalPort,
            approvalBridgeToken,
            baseUrl: approvalBaseUrl,
          }
        : undefined
      const ptyCommand = remoteMachine ? 'ssh' : daemonMachine ? 'sh' : 'bash'
      const ptyArgs = remoteMachine
        ? buildSshArgs(
          remoteMachine,
          remoteShellCommand,
          true,
          remoteApprovalBridge,
          preparedLaunch.sshSendEnvKeys,
        )
        : daemonMachine
          ? ['-lc', remoteShellCommand]
          : ['-l']
      const ptyEnv = requiresApprovalBridge
        ? {
            ...preparedLaunch.env,
            ...providerPtyEnv,
            HERD_PORT: approvalPort,
            HERD_APPROVAL_BASE_URL: approvalBaseUrl,
            HERD_INTERNAL_TOKEN: undefined,
            HERD_SESSION_NAME: sessionName,
            ...(approvalBridgeToken ? { HERD_APPROVAL_BRIDGE_TOKEN: approvalBridgeToken } : {}),
          }
        : {
            ...preparedLaunch.env,
            ...providerPtyEnv,
            HERD_INTERNAL_TOKEN: undefined,
          }
      const pty = daemonMachine
        ? daemonRegistry.spawnPty(daemonMachine.id, {
            command: ptyCommand,
            args: ptyArgs,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            cwd: sessionCwd,
            env: ptyEnv,
          })
        : ptySpawner!.spawn(ptyCommand, ptyArgs, {
            name: 'xterm-256color',
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            cwd: remoteMachine ? localSpawnCwd : sessionCwd,
            env: ptyEnv,
          })
      const createdAt = new Date().toISOString()

      const session: PtySession = {
        kind: 'pty',
        name: sessionName,
        sessionType,
        creator,
        agentType,
        effort: provider.uiCapabilities.supportsEffort ? ptyEffort : undefined,
        adaptiveThinking: provider.uiCapabilities.supportsAdaptiveThinking ? adaptiveThinking : undefined,
        maxThinkingTokens: provider.uiCapabilities.supportsMaxThinkingTokens ? maxThinkingTokens : undefined,
        cwd: sessionCwd,
        host: daemonMachine?.id ?? remoteMachine?.id,
        task: task && task.length > 0 ? task : undefined,
        pty,
        buffer: '',
        clients: new Set(),
        createdAt,
        lastEventAt: createdAt,
        approvalBridgeNonce,
      }

      pty.onData((data) => {
        session.lastEventAt = new Date().toISOString()
        appendToBuffer(session, data)
        broadcastOutput(session, data)
      })

      pty.onExit(({ exitCode, signal }) => {
        const exitMsg = JSON.stringify({ type: 'exit', exitCode, signal })
        for (const client of session.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(exitMsg)
          }
        }
        sessions.delete(sessionName)
        deps.schedulePersistedSessionsWrite()
      })

      sessions.set(sessionName, session)

      const command = provider.id === 'claude'
        ? buildClaudePtyCommand(
          mode,
          claudeEffort,
          adaptiveThinking ?? DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE,
          maxThinkingTokens ?? DEFAULT_CLAUDE_MAX_THINKING_TOKENS,
        )
        : CODEX_MODE_COMMANDS[mode]
      pty.write(command + '\r')

      if (task && task.length > 0) {
        setTimeout(() => {
          if (sessions.has(sessionName)) {
            session.pty.write(task + '\r')
          }
        }, taskDelayMs)
      }

      res.status(201).json({
        sessionName,
        mode,
        sessionType,
        creator,
        transportType: 'pty',
        agentType,
        host: session.host,
        created: true,
      })
    }

    try {
      const commanderId = creator.kind === 'commander' ? creator.id?.trim() : undefined
      if (commanderId) {
        await withCommanderRuntimeLaunch(
          commanderId,
          deps.commanderLifecycleScope,
          launchPtySession,
        )
      } else {
        await launchPtySession()
      }
    } catch (err) {
      if (remoteMachine) {
        const message = err instanceof Error ? err.message : 'SSH connection failed'
        res.status(500).json({ error: `Failed to create remote PTY session: ${message}` })
        return
      }
      res.status(500).json({ error: 'Failed to create PTY session' })
    }
  })
}
