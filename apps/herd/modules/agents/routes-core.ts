import { Router, type Request } from 'express'
import type { IncomingMessage } from 'node:http'
import * as path from 'node:path'
import type { Duplex } from 'node:stream'
import { DEFAULT_COMMANDER_MAX_TURNS } from '../commanders/store.js'
import type { PlanApprovalDecision } from '../../src/types/herd-events.js'
import { secureTokenEqual } from '../../server/middleware/secure-compare.js'
import { createAgentsAuthContext } from './router-context.js'
import { resolveSessionPrunerRuntimeConfig } from './session/pruner-config.js'
import {
  parseAutoRotateEntryThreshold,
  parseCodexTurnWatchdogTimeoutMs,
  parseMaxSessions,
  parseSessionName,
  parseTaskDelayMs,
  parseWsKeepAliveIntervalMs,
} from './session/input.js'
import {
  buildSshArgs,
  defaultMachineRegistryStorePath,
  ensureSshControlDir,
  isRemoteMachine,
  resolveTailscaleHostname,
  shellEscape,
  validateMachineConfig,
} from './machines.js'
import { createAgentsWebSocket } from './websocket.js'
import { createDaemonWebSocket } from './daemon/websocket.js'
import { createMachineRuntime } from './machine-runtime.js'
import { registerCodexProcessExitSessionMap } from './process-exit.js'
import { applyStreamUsageEvent } from './session/helpers.js'
import { writeTranscriptMetaForSession as writeTranscriptMeta } from './session/persistence.js'
import { createPersistenceHelpers, type PersistenceHelpers } from './persistence-helpers.js'
import { createStreamIoHelpers } from './stream-io-helpers.js'
import { createSessionQueueRuntime } from './session/queue-runtime.js'
import {
  createCodexApprovalQueueRuntime,
  type CodexApprovalQueueRuntime,
} from './session/approval-queue.js'
import { createMachineLaunchVerifier } from './session/machine-launch-verification.js'
import {
  createProviderSessionRuntime,
  type ProviderSessionRuntime,
} from './session/provider-runtime.js'
import {
  createSessionAutoRotationRuntime,
  type SessionAutoRotationRuntime,
} from './session/auto-rotation.js'
import { createStreamEventAppender } from './session/stream-events.js'
import { createSessionResumeRuntime } from './session/resume-source.js'
import { createCommanderWorkerDispatcher } from './session/commander-worker-dispatch.js'
import { createCommanderSessionsInterface } from './commander-interface.js'
import { resolveCommanderDataDir } from '../commanders/paths.js'
import { approvalBridgeDeps, createApprovalSessionsInterface } from './approval-interface.js'
import {
  buildPlanApprovalAutoResolvedSystemEvent,
  deliverPlanApprovalDecision,
  findPlanApprovalEvent,
} from './plan-approval.js'
import { getWorkerStates as getWorkerStatesFromState } from './session/state.js'
import { HERD_CLAUDE_GLOBAL_CONFIG_DIR, ProviderAuthStore, validateClaudeGlobalAuthWithCli } from './provider-auth.js'
import { createClaudeGlobalRuntime } from './claude-global-runtime.js'
import {
  registerProviderAuthRoutes,
  resolveProviderAuthProbeIntervalMs,
} from './routes/provider-auth-routes.js'
import { registerDiscoveryRoutes } from './routes/discovery-routes.js'
import { registerExternalSessionRoutes } from './routes/external-session-routes.js'
import { registerMachineWorldRoutes } from './routes/machine-world-routes.js'
import { registerSessionCreateRoutes } from './routes/session-create-routes.js'
import { registerSessionControlRoutes } from './routes/session-control-routes.js'
import { registerSessionQueryRoutes } from './routes/session-query-routes.js'
import { registerSessionSweepRoutes } from './routes/session-sweep-routes.js'
import { parseCodexApprovalId } from './codex-approval.js'
import { createProviderExecutionWiring } from './provider-execution-wiring.js'
import type {
  AgentsRouterOptions,
  AgentsRouterResult,
  AnySession,
  CodexApprovalQueueEvent,
  CompletedSession,
  CredentialPoolRecoveryRequest,
  ExitedStreamSessionState,
  MachineConfig,
  PtyHandle,
  PtySpawner,
  StreamJsonEvent,
  StreamSession,
} from './types.js'

export type {
  ActiveSkillInvocation,
  AgentSession,
  AgentType,
  AgentsRouterOptions,
  AgentsRouterResult,
  ApprovalSessionContext,
  ApprovalSessionsInterface,
  ClaudePermissionMode,
  CodexApprovalQueueEvent,
  CommanderSessionsInterface,
  MachineConfig,
  PendingCodexApprovalView,
  PtyHandle,
  PtySpawner,
  SessionType,
  WorldAgent,
} from './types.js'
export { parseCodexApprovalId }

type QueueRuntime = ReturnType<typeof createSessionQueueRuntime>
export function createAgentsRouter(options: AgentsRouterOptions): AgentsRouterResult {
  if (!options.sqliteDb) {
    throw new Error('SQLite runtime-session database is required for agents routes')
  }
  const commanderDataDir = path.resolve(options.commanderDataDir ?? resolveCommanderDataDir())

  const router = Router()
  const sessions = new Map<string, AnySession>()
  registerCodexProcessExitSessionMap(sessions)
  const sessionEventHandlers = new Map<string, Set<(event: StreamJsonEvent) => void>>()
  const completedSessions = new Map<string, CompletedSession>()
  const exitedStreamSessions = new Map<string, ExitedStreamSessionState>()
  const credentialRecoveryRequests = new Map<string, CredentialPoolRecoveryRequest>()

  const {
    broadcastStreamEvent,
    writeToStdin,
    resetActiveTurnState,
  } = createStreamIoHelpers({ sessionEventHandlers })

  const maxSessions = parseMaxSessions(options.maxSessions)
  const taskDelayMs = parseTaskDelayMs(options.taskDelayMs)
  const wsKeepAliveIntervalMs = parseWsKeepAliveIntervalMs(options.wsKeepAliveIntervalMs)
  const autoRotateEntryThreshold = parseAutoRotateEntryThreshold(
    options.autoRotateEntryThreshold ?? process.env.AGENTS_AUTO_ROTATE_ENTRY_THRESHOLD,
  )
  const codexTurnWatchdogTimeoutMs = parseCodexTurnWatchdogTimeoutMs(options.codexTurnWatchdogTimeoutMs)
  const internalToken = options.internalToken
  const approvalBridgeSigningSecret = options.approvalBridgeSigningSecret ?? internalToken
  const machineEnrollmentSigningSecret = options.machineEnrollmentSigningSecret ?? approvalBridgeSigningSecret ?? internalToken ?? ''
  const getActionPolicyGate = options.getActionPolicyGate
  const autoResumeSessions = options.autoResumeSessions ?? true
  const machinesFilePath = options.machinesFilePath
    ? path.resolve(options.machinesFilePath)
    : defaultMachineRegistryStorePath()
  const sqliteDb = options.sqliteDb
  const { machineRegistry, daemonRegistry, machineCommandExecutor } = createMachineRuntime(machinesFilePath)
  const providerAuthStore = options.providerAuthStore ?? new ProviderAuthStore()
  const { providerExecutionMode, machineLaunchRuntime, providerExecution, allowsMachine } = createProviderExecutionWiring({
    daemonRegistry,
    providerAuthStore,
    readMachineRegistry,
  })
  const prunerConfig = resolveSessionPrunerRuntimeConfig(options.enableSessionPruner)
  const codexApprovalQueueSubscribers = new Set<(event: CodexApprovalQueueEvent) => void>()

  let spawner: PtySpawner | null = options.ptySpawner ?? null
  let queueRuntime: QueueRuntime | null = null
  let autoRotationRuntime: SessionAutoRotationRuntime | null = null
  let providerRuntime: ProviderSessionRuntime | null = null
  let persistenceHelpers: PersistenceHelpers | null = null
  let restorePersistedSessionsReady: Promise<void> = Promise.resolve()

  function requireQueueRuntime(): QueueRuntime {
    if (!queueRuntime) {
      throw new Error('Session queue runtime is not initialized')
    }
    return queueRuntime
  }

  function requireAutoRotationRuntime(): SessionAutoRotationRuntime {
    if (!autoRotationRuntime) {
      throw new Error('Session auto-rotation runtime is not initialized')
    }
    return autoRotationRuntime
  }

  function requireProviderRuntime(): ProviderSessionRuntime {
    if (!providerRuntime) {
      throw new Error('Provider session runtime is not initialized')
    }
    return providerRuntime
  }

  function requirePersistenceHelpers(): PersistenceHelpers {
    if (!persistenceHelpers) {
      throw new Error('Session persistence helpers are not initialized')
    }
    return persistenceHelpers
  }

  function isInternalSessionRequest(req: Request): boolean {
    return secureTokenEqual(req.header('x-herd-internal-token'), internalToken)
  }

  function sessionCreatorIdFromUser(req: Request): string | undefined {
    const userId = req.user?.id?.trim()
    if (userId) {
      return userId
    }
    const email = req.user?.email?.trim()
    return email && email.length > 0 ? email : undefined
  }

  async function getSpawner(): Promise<PtySpawner> {
    if (spawner) {
      return spawner
    }

    const nodePty = await import('@lydell/node-pty')
    spawner = {
      spawn: (file, args, opts) => nodePty.spawn(file, args, opts) as unknown as PtyHandle,
    }
    return spawner
  }

  function readMachineRegistry(): Promise<MachineConfig[]> {
    return machineRegistry.readMachineRegistry()
  }

  function writeMachineRegistry(machines: readonly MachineConfig[]): Promise<MachineConfig[]> {
    return machineRegistry.writeMachineRegistry(machines)
  }

  function withMachineRegistryWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    return machineRegistry.withWriteLock(operation)
  }

  async function getCommanderLabels(): Promise<Record<string, string>> {
    if (options.getCommanderLabels) {
      return options.getCommanderLabels()
    }

    const labels: Record<string, string> = {}
    const commanderSessions = await options.commanderSessionStore?.list() ?? []
    for (const commanderSession of commanderSessions) {
      const host = commanderSession.host.trim()
      if (host.length > 0) {
        labels[commanderSession.id] = host
      }
    }
    return labels
  }

  async function buildCommanderReplacementPrompt(
    session: StreamSession,
  ): Promise<{ systemPrompt?: string; maxTurns?: number }> {
    const commanderId = session.creator.id?.trim()
    if (!commanderId || !options.buildCommanderSessionSeed) {
      return {
        systemPrompt: session.systemPrompt,
        maxTurns: session.maxTurns,
      }
    }

    const commanderSession = await options.commanderSessionStore?.get(commanderId)
    const conversationId = session.conversationId?.trim()
    const conversation = conversationId
      ? await options.commanderConversationStore?.get(conversationId)
      : null
    return options.buildCommanderSessionSeed({
      commanderId,
      cwd: commanderSession?.cwd ?? session.cwd,
      currentTask: conversation?.currentTask ?? null,
      taskSource: commanderSession?.taskSource ?? null,
      maxTurns: commanderSession?.maxTurns ?? session.maxTurns ?? DEFAULT_COMMANDER_MAX_TURNS,
    })
  }

  void ensureSshControlDir().catch((error) => {
    console.warn(
      `[agents] Failed to initialize SSH control directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  })

  router.use((_req, _res, next) => {
    restorePersistedSessionsReady.then(() => next(), next)
  })

  const {
    requireReadAccess,
    requireWriteAccess,
    issueSessionStreamTicket,
    verifyWsAuth,
  } = createAgentsAuthContext(options)

  router.post('/auth/stream-ticket', requireWriteAccess, (_req, res) => {
    res.json(issueSessionStreamTicket())
  })

  const approvalRuntime: CodexApprovalQueueRuntime = createCodexApprovalQueueRuntime({
    sessions,
    subscribers: codexApprovalQueueSubscribers,
  })
  const schedulePersistedSessionsWrite = () => {
    requirePersistenceHelpers().schedulePersistedSessionsWrite()
  }
  const appendStreamEvent = createStreamEventAppender({
    autoRotateEntryThreshold,
    commanderTranscriptAppender: options.commanderTranscriptAppender,
    getQueueRuntime: requireQueueRuntime,
    getAutoRotationRuntime: requireAutoRotationRuntime,
    getProviderRuntime: requireProviderRuntime,
    getApprovalRuntime: () => approvalRuntime,
    schedulePersistedSessionsWrite,
  })

  const claudeGlobalRuntime = createClaudeGlobalRuntime({
    providerAuthStore,
    quotaReader: options.claudeQuotaReader,
    globalConfigDir: options.claudeGlobalConfigDir,
    quotaPollIntervalMs: options.claudeQuotaPollIntervalMs,
    resolveAccountId: options.claudeAccountIdentityResolver,
    validateGlobalAuth: options.claudeGlobalAuthValidator,
    sessions,
    credentialRecoveryRequests,
    getProviderRuntime: requireProviderRuntime,
    getAutoRotationRuntime: requireAutoRotationRuntime,
    schedulePersistedSessionsWrite,
  })
  const validateClaudeAuth = options.claudeGlobalAuthValidator ?? validateClaudeGlobalAuthWithCli
  const { markProviderAuthRequired, refreshProviderAuthSnapshots } = registerProviderAuthRoutes({
    router,
    requireReadAccess,
    requireWriteAccess,
    sessions,
    providerAuthStore,
    questStore: options.questStore,
    readMachineRegistry,
    readPersistedSessionsState: () => requirePersistenceHelpers().readPersistedSessionsState(),
    getSpawner,
    sessionCreatorIdFromUser,
    appendStreamEvent,
    broadcastStreamEvent,
    schedulePersistedSessionsWrite,
    markCredentialRecoveryRequest(sessionName, request) {
      credentialRecoveryRequests.set(sessionName, request)
    },
    scheduleCredentialRecoveryReplacement(sessionName) {
      requireAutoRotationRuntime().scheduleAutoRotationIfNeeded(sessionName)
    },
    async recoverCredentialPoolSession(sessionName, request) {
      credentialRecoveryRequests.set(sessionName, request)
      const session = sessions.get(sessionName)
      if (session?.kind === 'stream') {
        session.credentialPoolRecovery = request
        schedulePersistedSessionsWrite()
      } else {
        return {
          status: 'queued' as const,
          sessionName,
          ...(request.credentialPoolId ? { credentialPoolId: request.credentialPoolId } : {}),
          clearResumeProviderContext: request.clearResumeProviderContext,
        }
      }
      const recovered = await requireAutoRotationRuntime().awaitAutoRotationIfNeeded(sessionName)
      if (recovered && recovered.credentialPoolId === request.credentialPoolId) {
        return {
          status: 'recovered_in_place' as const,
          sessionName,
          credentialPoolId: recovered.credentialPoolId,
        }
      }
      return {
        status: 'blocked' as const,
        sessionName,
        ...(request.blockedUntil ? { blockedUntil: request.blockedUntil } : {}),
      }
    },
    getClaudeQuotaSnapshot: (credentialId) => claudeGlobalRuntime.getQuotaSnapshot(credentialId),
    getGlobalClaudeCredentialId: () => claudeGlobalRuntime.getActiveCredentialId(),
    claudeQuotaRefreshIntervalMs: claudeGlobalRuntime.quotaPollIntervalMs,
    activateGlobalClaudeCredential: claudeGlobalRuntime.activateCredential,
    refreshClaudeQuota: (credentialId) => claudeGlobalRuntime.refreshQuota(credentialId, true),
    recoverGlobalClaudeAuthRequired: claudeGlobalRuntime.recoverAuthRequired,
    validateClaudeCredentialLogin: (absoluteDir) => validateClaudeAuth(
      { ...process.env, [HERD_CLAUDE_GLOBAL_CONFIG_DIR]: absoluteDir },
    ),
  })

  providerRuntime = createProviderSessionRuntime({
    commanderDataDir,
    sessions,
    completedSessions,
    exitedStreamSessions,
    sessionEventHandlers,
    providerAuthStore,
    questStore: options.questStore,
    daemonRegistry,
    providerExecutionMode,
    approvalQueue: approvalRuntime,
    wsKeepAliveIntervalMs,
    codexTurnWatchdogTimeoutMs,
    internalToken,
    ...approvalBridgeDeps.provider(approvalBridgeSigningSecret, options.commanderConversationStore),
    getActionPolicyGate,
    appendStreamEvent,
    broadcastStreamEvent,
    resetActiveTurnState,
    schedulePersistedSessionsWrite,
    writeToStdin,
    writeTranscriptMeta,
    markProviderAuthRequired,
    markCredentialRecoveryRequest(sessionName, request) {
      credentialRecoveryRequests.set(sessionName, request)
    },
    scheduleCredentialRecoveryReplacement(sessionName) {
      requireAutoRotationRuntime().scheduleAutoRotationIfNeeded(sessionName)
    },
    acquireClaudeGlobalCredentialLease: claudeGlobalRuntime.acquireCredentialLease,
    rotateCredentialAfterUsageLimit: claudeGlobalRuntime.recoverUsageLimit,
  })

  const resumeRuntime = createSessionResumeRuntime({
    sessions,
    exitedStreamSessions,
    sessionEventHandlers,
    schedulePersistedSessionsWrite,
    teardownProviderSession: (...args) => requireProviderRuntime().teardownProviderSession(...args).then(() => undefined),
  })

  persistenceHelpers = createPersistenceHelpers({
    sqliteDb,
    maxSessions,
    machineRegistry,
    sessions,
    completedSessions,
    exitedStreamSessions,
    applyStreamUsageEvent,
    restoreProviderSession: (...args) => requireProviderRuntime().restoreProviderStreamSession(...args),
    commanderLifecycleScope: commanderDataDir,
    shouldAutoRestoreSession: (_entry, machine) => allowsMachine(machine),
    restoreCredentialPoolRecovery: (...args) => requireProviderRuntime().restoreCredentialPoolRecovery(...args),
    teardownProviderSession: (...args) => requireProviderRuntime().teardownProviderSession(...args).then(() => undefined),
    isExitedSessionResumeAvailable: resumeRuntime.isExitedSessionResumeAvailable,
    isLiveSessionResumeAvailable: resumeRuntime.isLiveSessionResumeAvailable,
  })

  autoRotationRuntime = createSessionAutoRotationRuntime({
    sessions,
    providerAuthStore,
    autoRotateEntryThreshold,
    buildCommanderReplacementPrompt,
    readMachineRegistry,
    createProviderStreamSession: (...args) => requireProviderRuntime().createProviderStreamSession(...args),
    teardownProviderSession: (...args) => requireProviderRuntime().teardownProviderSession(...args).then(() => undefined),
    appendStreamEvent,
    broadcastStreamEvent,
    schedulePersistedSessionsWrite,
    markCredentialRecoveryRequest(sessionName, request) {
      credentialRecoveryRequests.set(sessionName, request)
    },
    clearCredentialRecoveryRequest(sessionName) {
      credentialRecoveryRequests.delete(sessionName)
    },
    getQueueRuntime: requireQueueRuntime,
  })

  queueRuntime = createSessionQueueRuntime({
    sessions,
    appendStreamEvent,
    broadcastStreamEvent,
    writeToStdin,
    resetActiveTurnState,
    schedulePersistedSessionsWrite,
    awaitAutoRotationIfNeeded: (...args) => requireAutoRotationRuntime().awaitAutoRotationIfNeeded(...args),
  })

  for (const session of sessions.values()) {
    if (session.kind === 'stream') {
      requireAutoRotationRuntime().initializeAutoRotationState(session)
    }
  }

  async function runSessionPruners(nowMs: number = Date.now()): Promise<void> {
    requirePersistenceHelpers().pruneStaleCronSessions(nowMs)
    await requirePersistenceHelpers().pruneStaleNonHumanSessions(prunerConfig, nowMs)
  }

  const verifyMachineLaunch = createMachineLaunchVerifier({
    maxSessions,
    sessions,
    completedSessions,
    exitedStreamSessions,
    sessionEventHandlers,
    machineLaunchRuntime,
    getProviderRuntime: requireProviderRuntime,
    getPersistenceHelpers: requirePersistenceHelpers,
  })

  const sessionPrunerTimer = prunerConfig.enabled
    ? setInterval(() => {
      void runSessionPruners()
    }, prunerConfig.sweepIntervalMs)
    : null
  sessionPrunerTimer?.unref?.()
  const clearSessionPrunerTimer = () => {
    if (sessionPrunerTimer) {
      clearInterval(sessionPrunerTimer)
    }
  }
  const handleSessionPrunerSigterm = () => {
    clearSessionPrunerTimer()
  }
  if (sessionPrunerTimer) {
    process.on('SIGTERM', handleSessionPrunerSigterm)
  }

  restorePersistedSessionsReady = claudeGlobalRuntime.initializeBeforeRestore().then(async () => {
    if (autoResumeSessions) {
      await requirePersistenceHelpers().restorePersistedSessions().catch(() => undefined)
      await claudeGlobalRuntime.refreshQuota().catch(() => undefined)
    }
  })
  const providerAuthProbeIntervalMs = resolveProviderAuthProbeIntervalMs()
  const providerAuthProbeTimer = providerAuthProbeIntervalMs > 0
    ? setInterval(() => {
      void refreshProviderAuthSnapshots()
    }, providerAuthProbeIntervalMs)
    : null
  providerAuthProbeTimer?.unref?.()
  const clearProviderAuthProbeTimer = () => {
    if (providerAuthProbeTimer) {
      clearInterval(providerAuthProbeTimer)
    }
  }
  const handleProviderAuthProbeSigterm = () => {
    clearProviderAuthProbeTimer()
  }
  if (providerAuthProbeTimer) {
    process.on('SIGTERM', handleProviderAuthProbeSigterm)
  }

  registerDiscoveryRoutes({
    router,
    requireReadAccess,
    requireWriteAccess,
    buildSshArgs,
    isRemoteMachine,
    readMachineRegistry,
    shellEscape,
  })

  registerMachineWorldRoutes({
    router,
    requireReadAccess,
    requireWriteAccess,
    commanderSessionStore: options.commanderSessionStore,
    conversationStore: options.commanderConversationStore,
    sessions,
    buildSshArgs,
    isRemoteMachine,
    parseSessionName,
    pruneStaleCronSessions: (...args) => requirePersistenceHelpers().pruneStaleCronSessions(...args),
    pruneStaleNonHumanSessions: () => requirePersistenceHelpers().pruneStaleNonHumanSessions(prunerConfig),
    readMachineRegistry,
    resolveTailscaleHostname,
    validateMachineConfig,
    verifyMachineLaunch,
    withMachineRegistryWriteLock,
    writeMachineRegistry,
    daemonRegistry,
    providerAuthStore,
    machineEnrollmentSigningSecret,
  })

  registerSessionSweepRoutes({
    router,
    requireWriteAccess,
    prunerConfig,
    getStaleCronSessionCandidates: (...args) => requirePersistenceHelpers().getStaleCronSessionCandidates(...args),
    getStaleNonHumanSessionCandidates: (...args) =>
      requirePersistenceHelpers().getStaleNonHumanSessionCandidates(...args),
    pruneStaleCronSessions: (...args) => requirePersistenceHelpers().pruneStaleCronSessions(...args),
    pruneStaleNonHumanSessions: (...args) => requirePersistenceHelpers().pruneStaleNonHumanSessions(...args),
  })

  registerSessionQueryRoutes({
    router,
    requireReadAccess,
    getCommanderLabels,
    providerAuthStore,
    readMachineRegistry,
    sessions,
    completedSessions,
    exitedStreamSessions,
    isExitedSessionResumeAvailable: resumeRuntime.isExitedSessionResumeAvailable,
    parseSessionName,
    pruneStaleCronSessions: () => requirePersistenceHelpers().pruneStaleCronSessions(),
    pruneStaleNonHumanSessions: () => requirePersistenceHelpers().pruneStaleNonHumanSessions(prunerConfig),
    getWorkerStates: (sourceSessionName) =>
      getWorkerStatesFromState(sourceSessionName, sessions, exitedStreamSessions, completedSessions),
  })

  registerExternalSessionRoutes({
    router,
    requireWriteAccess,
    maxSessions,
    sessions,
    broadcastEvent: broadcastStreamEvent,
  })

  registerSessionControlRoutes({
    router,
    requireReadAccess,
    requireWriteAccess,
    maxSessions,
    sessions,
    completedSessions,
    exitedStreamSessions,
    sessionEventHandlers,
    clearCodexResumeMetadata: resumeRuntime.clearCodexResumeMetadata,
    createProviderStreamSession: (...args) => requireProviderRuntime().createProviderStreamSession(...args),
    resolveProviderLaunchMachine: machineLaunchRuntime.resolveProviderLaunchMachine,
    readPersistedSessionsState: () => requirePersistenceHelpers().readPersistedSessionsState(),
    resolveResumableSessionSource: resumeRuntime.resolveResumableSessionSource,
    archivePersistedSession: (...args) => requirePersistenceHelpers().archivePersistedSession(...args),
    retireLiveSessionForResume: resumeRuntime.retireLiveSessionForResume,
    schedulePersistedSessionsWrite,
    sendImmediateTextToStreamSession: (...args) => requireQueueRuntime().sendImmediateTextToStreamSession(...args),
    getWorkspaceResolver: options.getWorkspaceResolver,
    queueTextToStreamSession: (...args) => requireQueueRuntime().queueTextToStreamSession(...args),
    createQueuedMessage: (...args) => requireQueueRuntime().createQueuedMessage(...args),
    enqueueQueuedMessage: (...args) => requireQueueRuntime().enqueueQueuedMessage(...args),
    getQueueSnapshot: (...args) => requireQueueRuntime().getQueueSnapshot(...args),
    isQueueBackpressureError: (...args) => requireQueueRuntime().isQueueBackpressureError(...args),
    reorderVisibleQueuedMessages: (...args) => requireQueueRuntime().reorderVisibleQueuedMessages(...args),
    removeQueuedMessageById: (...args) => requireQueueRuntime().removeQueuedMessageById(...args),
    clearVisibleQueuedMessages: (...args) => requireQueueRuntime().clearVisibleQueuedMessages(...args),
    broadcastQueueUpdate: (...args) => requireQueueRuntime().broadcastQueueUpdate(...args),
    clearQueuedMessageRetry: (...args) => requireQueueRuntime().clearQueuedMessageRetry(...args),
    resetQueuedMessageRetryDelay: (...args) => requireQueueRuntime().resetQueuedMessageRetryDelay(...args),
    scheduleQueuedMessageDrain: (...args) => requireQueueRuntime().scheduleQueuedMessageDrain(...args),
    applyRestoredQueueState: (...args) => requireQueueRuntime().applyRestoredQueueState(...args),
    resumeRestoredQueueDrain: (...args) => requireQueueRuntime().resumeRestoredQueueDrain(...args),
    initializeAutoRotationState: (...args) => requireAutoRotationRuntime().initializeAutoRotationState(...args),
    teardownProviderSession: (...args) => requireProviderRuntime().teardownProviderSession(...args).then(() => undefined),
  })

  registerSessionCreateRoutes({
    commanderLifecycleScope: commanderDataDir,
    router,
    requireWriteAccess,
    sessions,
    maxSessions,
    taskDelayMs,
    approvalBridgeSigningSecret,
    daemonRegistry,
    isInternalSessionRequest,
    sessionCreatorIdFromUser,
    getSpawner,
    readPersistedSessionsState: () => requirePersistenceHelpers().readPersistedSessionsState(),
    resolveResumableSessionSource: resumeRuntime.resolveResumableSessionSource,
    clearCodexResumeMetadata: resumeRuntime.clearCodexResumeMetadata,
    resolveProviderLaunchMachine: machineLaunchRuntime.resolveProviderLaunchMachine,
    createProviderStreamSession: (...args) => requireProviderRuntime().createProviderStreamSession(...args),
    retireLiveSessionForResume: resumeRuntime.retireLiveSessionForResume,
    schedulePersistedSessionsWrite,
  })

  const dispatchWorkerForCommander = createCommanderWorkerDispatcher({
    commanderLifecycleScope: commanderDataDir,
    maxSessions,
    sessions,
    resolveProviderLaunchMachine: machineLaunchRuntime.resolveProviderLaunchMachine,
    createProviderStreamSession: (...args) => requireProviderRuntime().createProviderStreamSession(...args),
    teardownProviderSession: (...args) => requireProviderRuntime().teardownProviderSession(...args).then(() => undefined),
    schedulePersistedSessionsWrite,
  })

  const { handleUpgrade: handleSessionUpgrade } = createAgentsWebSocket({
    sessions,
    verifyWsAuth,
    wsKeepAliveIntervalMs,
    getQueueUpdatePayload: (...args) => requireQueueRuntime().getQueueUpdatePayload(...args),
    broadcastStreamEvent,
    sendImmediateTextToStreamSession: (...args) => requireQueueRuntime().sendImmediateTextToStreamSession(...args),
    getWorkspaceResolver: options.getWorkspaceResolver,
    writeToStdin,
    appendStreamEvent,
    scheduleTurnWatchdog: (...args) => requireProviderRuntime().scheduleCodexTurnWatchdog(...args),
    schedulePersistedSessionsWrite,
  })
  const {
    isDaemonUpgrade,
    handleUpgrade: handleDaemonUpgrade,
  } = createDaemonWebSocket({
    machineRegistry,
    daemonRegistry,
    ready: restorePersistedSessionsReady,
  })

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (isDaemonUpgrade(req)) {
      handleDaemonUpgrade(req, socket, head)
      return
    }
    handleSessionUpgrade(req, socket, head)
  }

  const baseSessionsInterface = createCommanderSessionsInterface({
    sessions,
    sessionEventHandlers,
    schedulePersistedSessionsWrite,
    createProviderStreamSession: (...args) => requireProviderRuntime().createProviderStreamSession(...args),
    resolveProviderLaunchMachine: machineLaunchRuntime.resolveProviderLaunchMachine,
    createQueuedMessage: (...args) => requireQueueRuntime().createQueuedMessage(...args),
    enqueueQueuedMessage: (...args) => requireQueueRuntime().enqueueQueuedMessage(...args),
    scheduleQueuedMessageDrain: (...args) => requireQueueRuntime().scheduleQueuedMessageDrain(...args),
    sendImmediateTextToStreamSession: (...args) => requireQueueRuntime().sendImmediateTextToStreamSession(...args),
    teardownProviderSession: (...args) => requireProviderRuntime().teardownProviderSession(...args).then(() => undefined),
    shutdownProviderRuntimes: (...args) => requireProviderRuntime().shutdownProviderRuntimes(...args),
    commanderDataDir,
    getCredentialRecoveryRequest(sessionName) {
      return credentialRecoveryRequests.get(sessionName)
    },
    clearCredentialRecoveryRequest(sessionName) {
      credentialRecoveryRequests.delete(sessionName)
    },
    async getActiveCredentialPoolId(provider) {
      try {
        return (await providerAuthStore.getActivePoolCredential(provider))?.id
      } catch {
        return undefined
      }
    },
  })

  const sessionsInterface = {
    ...baseSessionsInterface,
    dispatchWorkerForCommander,
    autoResolvePlanApproval(
      name: string,
      toolId: string,
      decision: PlanApprovalDecision,
      message: string,
    ) {
      const session = sessions.get(name)
      if (!session || session.kind !== 'stream') {
        return false
      }
      const planApproval = findPlanApprovalEvent(session, toolId)
      if (!planApproval) {
        return false
      }
      const result = deliverPlanApprovalDecision(session, planApproval, decision, message, writeToStdin)
      if (!result.ok) {
        return false
      }

      appendStreamEvent(session, result.payload)
      broadcastStreamEvent(session, result.payload)

      const systemEvent = buildPlanApprovalAutoResolvedSystemEvent(planApproval, decision)
      appendStreamEvent(session, systemEvent)
      broadcastStreamEvent(session, systemEvent)
      schedulePersistedSessionsWrite()
      return true
    },
  }

  const approvalSessionsInterface = createApprovalSessionsInterface({
    sessions,
    codexApprovalQueueSubscribers,
    getApprovalCommanderScopeId: approvalRuntime.getApprovalCommanderScopeId,
    toPendingCodexApprovalView: approvalRuntime.toPendingCodexApprovalView,
    applyCodexApprovalDecision: (...args) => requireProviderRuntime().applyCodexApprovalDecision(...args),
    ...approvalBridgeDeps.sessions(options.commanderConversationStore, requirePersistenceHelpers),
  })
  const shutdownSessionsInterface = {
    ...sessionsInterface,
    async shutdown() {
      clearSessionPrunerTimer()
      if (sessionPrunerTimer) {
        process.off('SIGTERM', handleSessionPrunerSigterm)
      }
      clearProviderAuthProbeTimer()
      if (providerAuthProbeTimer) {
        process.off('SIGTERM', handleProviderAuthProbeSigterm)
      }
      await restorePersistedSessionsReady.catch((error) => {
        console.warn('[agents][restore] Startup restoration did not settle cleanly before shutdown', error)
      })
      claudeGlobalRuntime.shutdown()
      daemonRegistry.shutdown()
      requirePersistenceHelpers().schedulePersistedSessionsWrite()
      await requirePersistenceHelpers().flushPersistedSessionsWrite()
      await sessionsInterface.shutdown?.()
    },
  }

  return {
    router, ready: restorePersistedSessionsReady, handleUpgrade, sessionsInterface: shutdownSessionsInterface,
    approvalSessionsInterface, machineCommandExecutor, providerExecution,
  }
}
