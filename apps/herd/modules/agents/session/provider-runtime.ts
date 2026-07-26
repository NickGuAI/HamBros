import { spawn } from 'node:child_process'
import type { ActionPolicyGate } from '../../policies/action-policy-gate.js'
import type { QuestStore } from '../../commanders/quest-store.js'
import { truncateLogText } from './helpers.js'
import { isDaemonMachine, isRemoteMachine } from '../machines.js'
import {
  clearCodexTurnWatchdog,
  extractCodexUsageTotals,
  hasPendingCodexApprovals,
  markCodexTurnHealthy,
} from '../adapters/codex/helpers.js'
import {
  applyCodexApprovalDecision as applyCodexApprovalDecisionAdapter,
} from '../adapters/codex/index.js'
import { CodexSessionRuntime, GeminiAcpRuntime, OpenCodeAcpRuntime } from '../launchers/runtimes.js'
import {
  prepareProviderSpawnAuth,
  findLocalCodexHomeForThread,
  ProviderAuthRequiredError,
  resolveProviderAuthScopeId,
  isReadyPoolCredentialForHost,
  shouldClearResumeProviderContextForCredentialPoolRecovery,
  type ProviderAuthStore,
  type ProviderAuthSnapshot,
  type ProviderSpawnAuth,
} from '../provider-auth.js'
import {
  extractProviderLimitDetails,
  type ProviderLimitDetails,
} from '../provider-errors.js'
import {
  asCodexProviderContext,
  readCodexRuntime,
  readCodexThreadId,
} from '../providers/provider-session-context.js'
import { mapCodexToTranscriptEnvelopes } from '../event-normalizers/codex.js'
import { createTranscriptId } from '../transcript-id.js'
import type { TranscriptEnvelope } from '../../../src/types/transcript-envelope.js'
import { isTranscriptEnvelope } from '../../../src/types/transcript-envelope.js'
import {
  isTranscriptExitRecord,
  isTranscriptTurnEndRecord,
  isTranscriptTurnStartRecord,
} from '../transcript-records.js'
import {
  getProvider,
  listProviders,
} from '../providers/registry.js'
import type {
  ProviderAdapterDeps,
  ProviderCreateOptions,
  ProviderTeardownOptions,
  ProviderTeardownResult,
} from '../providers/provider-adapter.js'
import { asObject } from './state.js'
import type { MachineDaemonRegistry } from '../daemon/registry.js'
import type {
  AgentType,
  AnySession,
  ClaudePermissionMode,
  CodexApprovalDecision,
  CodexPendingApprovalRequest,
  CodexRuntimeFailure,
  CompletedSession,
  CredentialPoolRecoveryRequest,
  ExitedStreamSessionState,
  MachineConfig,
  PersistedStreamSession,
  StreamJsonEvent,
  StreamSession,
} from '../types.js'
import type { QueuedMessage } from '../message-queue.js'
import {
  listProviderProcessMembers,
  providerProcessAlive,
  signalProviderProcess,
  waitForProviderProcessExit,
} from '../provider-process.js'
import {
  assertProviderExecutionAllowed,
  DEFAULT_PROVIDER_EXECUTION_MODE,
  type ProviderExecutionMode,
} from '../provider-execution-mode.js'
import { withCommanderRuntimeLaunch } from '../../commanders/package-lifecycle-state.js'
import { resolveCommanderDataDir } from '../../commanders/paths.js'

type ProviderStreamSessionOptions = Omit<
  ProviderCreateOptions,
  'sessionName' | 'mode' | 'task' | 'cwd' | 'machine'
>

export interface UsageLimitRecoveryOptions {
  resetAt?: string
  interruptedMessage?: QueuedMessage
  interruptedTurnHadSideEffects?: boolean
  interruptedTurnId?: string
}

interface ProviderRuntimeApprovalQueue {
  notifyApprovalEnqueued(
    session: StreamSession,
    pendingRequest: CodexPendingApprovalRequest,
  ): void
  notifyApprovalResolved(
    session: StreamSession,
    pendingRequest: CodexPendingApprovalRequest,
    decision: CodexApprovalDecision,
    delivered: boolean,
  ): void
}

interface ProviderSessionRuntimeDeps {
  commanderDataDir?: string
  sessions: Map<string, AnySession>
  completedSessions: Map<string, CompletedSession>
  exitedStreamSessions: Map<string, ExitedStreamSessionState>
  sessionEventHandlers: Map<string, Set<(event: StreamJsonEvent) => void>>
  providerAuthStore: ProviderAuthStore
  questStore?: QuestStore
  daemonRegistry: MachineDaemonRegistry
  providerExecutionMode?: ProviderExecutionMode
  approvalQueue: ProviderRuntimeApprovalQueue
  wsKeepAliveIntervalMs: number
  codexTurnWatchdogTimeoutMs: number
  internalToken?: string
  approvalBridgeSigningSecret?: string
  resolveConversationApprovalBridgeCredential?(
    conversationId: string,
  ): Promise<{ credentialId: string; epoch: number } | null>
  getActionPolicyGate?: () => ActionPolicyGate | null
  appendStreamEvent(session: StreamSession, event: StreamJsonEvent): void
  broadcastStreamEvent(session: StreamSession, event: StreamJsonEvent): void
  resetActiveTurnState(session: StreamSession): void
  schedulePersistedSessionsWrite(): void
  markCredentialRecoveryRequest?(sessionName: string, request: CredentialPoolRecoveryRequest): void
  scheduleCredentialRecoveryReplacement?(sessionName: string): void
  acquireClaudeGlobalCredentialLease?(): Promise<() => void>
  rotateCredentialAfterUsageLimit?(
    session: StreamSession,
    options: UsageLimitRecoveryOptions,
  ): Promise<Awaited<ReturnType<ProviderAuthStore['switchToNextPoolCredential']>> | null>
  writeToStdin(session: StreamSession, data: string): boolean
  writeTranscriptMeta(session: StreamSession): void
  markProviderAuthRequired(
    session: StreamSession,
    detail: string,
    recovery?: {
      interruptedMessage?: StreamSession['currentQueuedMessage']
      interruptedTurnHadSideEffects?: boolean
      interruptedTurnId?: string
    },
  ): Promise<ProviderAuthSnapshot>
}

export interface ProviderSessionRuntime {
  createProviderStreamSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    task: string,
    cwd: string | undefined,
    machine: MachineConfig | undefined,
    agentType?: AgentType,
    sessionOptions?: ProviderStreamSessionOptions,
  ): Promise<StreamSession>
  restoreProviderStreamSession(
    entry: PersistedStreamSession,
    machine: MachineConfig | undefined,
  ): Promise<StreamSession>
  teardownProviderSession(
    session: StreamSession,
    reason: string,
    options?: ProviderTeardownOptions,
  ): Promise<ProviderTeardownResult>
  shutdownProviderRuntimes(reason?: string): Promise<void>
  applyCodexApprovalDecision(
    session: StreamSession,
    requestId: number,
    decision: CodexApprovalDecision,
  ): { ok: true } | {
    ok: false
    code: 'invalid_session' | 'unavailable' | 'not_found' | 'protocol_error'
    reason: string
  }
  handleAuthRequiredSignal(
    session: StreamSession,
    detail: string,
    recovery?: {
      interruptedMessage?: StreamSession['currentQueuedMessage']
      interruptedTurnHadSideEffects?: boolean
      interruptedTurnId?: string
    },
  ): void
  scheduleCodexTurnWatchdog(session: StreamSession): void
  handleUsageLimitSignal(
    session: StreamSession,
    options?: UsageLimitRecoveryOptions,
  ): void
  restoreCredentialPoolRecovery(session: StreamSession): void
}

function collectUnknownErrorText(value: unknown, seen: Set<object>): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (value instanceof Error) {
    return [value.message]
  }
  const record = asObject(value)
  if (!record) {
    return []
  }
  if (seen.has(record)) {
    return []
  }
  seen.add(record)

  return [
    typeof record.message === 'string' ? record.message : '',
    typeof record.error === 'string' ? record.error : '',
    typeof record.detail === 'string' ? record.detail : '',
    typeof record.reason === 'string' ? record.reason : '',
    ...collectUnknownErrorText(record.error, seen),
    ...collectUnknownErrorText(record.cause, seen),
  ].filter(Boolean)
}

export function unknownToErrorText(value: unknown): string {
  return collectUnknownErrorText(value, new Set()).join('\n')
}

export function unknownToErrorCode(value: unknown): string | undefined {
  const record = asObject(value)
  if (!record) {
    return undefined
  }
  if (typeof record.code === 'string') {
    return record.code
  }
  if (typeof record.type === 'string') {
    return record.type
  }
  return unknownToErrorCode(record.error)
}

function eventUsageLimitDetails(event: StreamJsonEvent): ProviderLimitDetails | null {
  if (!isTranscriptEnvelope(event)) return null
  if (event.ev.type === 'provider.error') {
    return event.ev.classification === 'usage_limit'
      ? {
          classification: 'usage_limit',
          ...(event.ev.resetAt ? { resetAt: event.ev.resetAt } : {}),
        }
      : null
  }
  if (event.ev.type !== 'turn.end') {
    return null
  }
  const errorText = [
    unknownToErrorText(event.ev.error),
    unknownToErrorText(event.ev.result),
  ].filter(Boolean).join('\n')
  const code = unknownToErrorCode(event.ev.error) ?? unknownToErrorCode(event.ev.result)
  const details = extractProviderLimitDetails(errorText, code, { referenceTime: event.time })
  return Boolean(errorText || code) && details.classification === 'usage_limit' ? details : null
}

function activeUsageLimitScanStartIndex(events: readonly StreamJsonEvent[]): number {
  for (let index = events.length - 2; index >= 0; index -= 1) {
    const candidate = events[index]!
    if (isTranscriptTurnStartRecord(candidate)) {
      return index
    }
    if (isTranscriptTurnEndRecord(candidate) || isTranscriptExitRecord(candidate)) {
      return index + 1
    }
  }
  return 0
}

function latestUsageLimitDetails(session: StreamSession): ProviderLimitDetails | null {
  const startIndex = activeUsageLimitScanStartIndex(session.events)
  for (let index = session.events.length - 1; index >= startIndex; index -= 1) {
    const details = eventUsageLimitDetails(session.events[index]!)
    if (details) {
      return details
    }
  }
  return null
}

type UsageLimitRecoveryDeps = Pick<
  ProviderSessionRuntimeDeps,
  | 'providerAuthStore'
  | 'appendStreamEvent'
  | 'broadcastStreamEvent'
  | 'markCredentialRecoveryRequest'
  | 'rotateCredentialAfterUsageLimit'
  | 'scheduleCredentialRecoveryReplacement'
> & {
  schedulePersistedSessionsWrite?: () => void
}

type RestoredCredentialPoolRecoveryDeps = Pick<
  ProviderSessionRuntimeDeps,
  | 'markCredentialRecoveryRequest'
  | 'scheduleCredentialRecoveryReplacement'
>

function buildRecoveryRequest(
  session: StreamSession,
  credentialPoolId: string | undefined,
  options: UsageLimitRecoveryOptions,
): CredentialPoolRecoveryRequest {
  return {
    provider: session.agentType as CredentialPoolRecoveryRequest['provider'],
    state: credentialPoolId ? 'reloading_session' : 'awaiting_safe_boundary',
    ...(credentialPoolId ? { credentialPoolId } : {}),
    ...(session.credentialPoolId ? { previousCredentialPoolId: session.credentialPoolId } : {}),
    clearResumeProviderContext: shouldClearResumeProviderContextForCredentialPoolRecovery(
      session.agentType as CredentialPoolRecoveryRequest['provider'],
      session.host,
      session.credentialPoolMode,
    ),
    reason: 'usage_limit',
    requestedAt: new Date().toISOString(),
    ...(options.resetAt ? { resetAt: options.resetAt } : {}),
    ...(options.interruptedMessage ? { interruptedMessage: options.interruptedMessage } : {}),
    ...(options.interruptedTurnHadSideEffects !== undefined
      ? { interruptedTurnHadSideEffects: options.interruptedTurnHadSideEffects }
      : {}),
    ...(options.interruptedTurnId ? { interruptedTurnId: options.interruptedTurnId } : {}),
  }
}

export function markUsageLimitRecoveryPending(
  session: StreamSession,
  options: UsageLimitRecoveryOptions = {},
): CredentialPoolRecoveryRequest | null {
  if (!session.credentialPoolId || session.credentialPoolRecovery?.credentialPoolId) {
    return null
  }

  const latestDetails = latestUsageLimitDetails(session)
  const resetAt = options.resetAt ?? latestDetails?.resetAt
  const existing = session.credentialPoolRecovery
  const request = buildRecoveryRequest(session, undefined, {
    ...options,
    ...(resetAt ? { resetAt } : {}),
  })
  session.credentialPoolRecovery = existing && !existing.credentialPoolId
    ? {
        ...request,
        requestedAt: existing.requestedAt,
        ...(existing.blockedUntil ? { blockedUntil: existing.blockedUntil } : {}),
      }
    : request
  return session.credentialPoolRecovery
}

export function installBlockedCredentialPoolRecovery(
  deps: UsageLimitRecoveryDeps,
  session: StreamSession,
  options: UsageLimitRecoveryOptions & {
    reason?: CredentialPoolRecoveryRequest['reason']
    blockedUntil?: string
  } = {},
): CredentialPoolRecoveryRequest | null {
  if (!session.credentialPoolId || session.credentialPoolRecovery?.credentialPoolId) {
    return null
  }

  const request = buildRecoveryRequest(session, undefined, options)
  request.reason = options.reason ?? 'usage_limit'
  request.state = 'blocked'
  if (options.blockedUntil) {
    request.blockedUntil = options.blockedUntil
  }
  session.credentialPoolRecovery = request
  deps.markCredentialRecoveryRequest?.(session.name, request)
  const event = createCredentialPoolBlockedEvent(session, options.blockedUntil)
  deps.appendStreamEvent(session, event)
  deps.broadcastStreamEvent(session, event)
  deps.schedulePersistedSessionsWrite?.()
  return request
}

function createCredentialSwitchStartedSystemEvent(
  session: StreamSession,
  result: Awaited<ReturnType<ProviderAuthStore['switchToNextPoolCredential']>>,
  resetAt: string | undefined,
): StreamJsonEvent {
  const previousLabel = result.previousCredential?.label ?? session.credentialPoolId ?? 'previous credential'
  const activeLabel = result.activeCredential?.label ?? result.activeCredential?.id ?? 'next credential'
  return {
    type: 'system',
    subtype: 'credential_pool_recovery',
    reason: 'credential-usage-limit',
    provider: session.agentType,
    previousCredentialId: result.previousCredential?.id ?? session.credentialPoolId,
    activeCredentialId: result.activeCredential?.id,
    ...(resetAt ? { resetAt } : {}),
    text: `${previousLabel} hit a usage limit${resetAt ? ` until ${resetAt}` : ''}; recovering in place on ${activeLabel}.`,
  }
}

function createCredentialPoolBlockedEvent(
  session: StreamSession,
  resetAt: string | undefined,
): TranscriptEnvelope {
  return {
    schemaVersion: 2,
    id: createTranscriptId(),
    time: new Date().toISOString(),
    source: {
      provider: session.agentType,
      backend: 'herd',
      rawEventType: 'credential-pool/blocked',
    },
    ev: {
      type: 'provider.error',
      message: resetAt
        ? `All ${session.agentType} credential-pool credentials are cooling down until ${resetAt}.`
        : `All ${session.agentType} credential-pool credentials are unavailable.`,
      classification: 'usage_limit',
      code: 'credential_pool_exhausted',
      ...(resetAt ? { resetAt } : {}),
      retryable: false,
      data: {
        provider: session.agentType,
        credentialPoolId: session.credentialPoolId,
        ...(resetAt ? { resetAt } : {}),
      },
    },
  }
}

function isReadyCredentialPoolRecoveryTarget(
  session: StreamSession,
  credential: Awaited<ReturnType<ProviderAuthStore['switchToNextPoolCredential']>>['activeCredential'],
): credential is NonNullable<Awaited<ReturnType<ProviderAuthStore['switchToNextPoolCredential']>>['activeCredential']> {
  if (session.agentType !== 'claude' && session.agentType !== 'codex') {
    return false
  }
  const canReloadSameGlobalCredential = session.agentType === 'claude'
    && (session.host ?? 'local') === 'local'
    && session.credentialPoolMode !== 'isolated-runtime'
  return Boolean(
    credential
    && (credential.id !== session.credentialPoolId || canReloadSameGlobalCredential)
    && isReadyPoolCredentialForHost(session.agentType, credential, session.host ?? 'local'),
  )
}

export function registerRestoredCredentialPoolRecovery(
  deps: RestoredCredentialPoolRecoveryDeps,
  session: StreamSession,
): void {
  const request = session.credentialPoolRecovery
  if (!request) {
    return
  }

  deps.markCredentialRecoveryRequest?.(session.name, request)
  if (request.credentialPoolId) {
    deps.scheduleCredentialRecoveryReplacement?.(session.name)
  }
}

export async function switchCredentialAfterUsageLimit(
  deps: UsageLimitRecoveryDeps,
  session: StreamSession,
  options: UsageLimitRecoveryOptions = {},
): Promise<void> {
  if (!session.credentialPoolId || session.credentialPoolRecovery?.credentialPoolId) {
    return
  }
  const latestDetails = latestUsageLimitDetails(session)
  const resetAt = options.resetAt ?? latestDetails?.resetAt
  if (!latestDetails && !options.resetAt) {
    return
  }
  const result = await (deps.rotateCredentialAfterUsageLimit
    ? deps.rotateCredentialAfterUsageLimit(session, {
        ...options,
        ...(resetAt ? { resetAt } : {}),
      })
    : deps.providerAuthStore.switchToNextPoolCredential(
        session.agentType,
        session.credentialPoolId,
        {
          resetAt,
          host: session.host,
          ...(session.agentType === 'claude'
            && (session.host ?? 'local') === 'local'
            && session.credentialPoolMode === 'isolated-runtime'
            ? { preserveActive: true }
            : {}),
        },
      )).catch((error) => {
    console.warn(
      '[agents/provider-auth] failed to switch credential pool after usage limit',
      { session: session.name, provider: session.agentType, error: error instanceof Error ? error.message : String(error) },
    )
    return null
  })
  if (!result) {
    return
  }

  const recoveryTarget = result.blocked ? undefined : result.activeCredential
  if (!result.switched && isReadyCredentialPoolRecoveryTarget(session, recoveryTarget)) {
    const request = buildRecoveryRequest(session, recoveryTarget.id, {
      ...options,
      resetAt,
    })
    session.credentialPoolRecovery = request
    deps.markCredentialRecoveryRequest?.(session.name, request)
    const event = createCredentialSwitchStartedSystemEvent(session, result, resetAt)
    deps.appendStreamEvent(session, event)
    deps.broadcastStreamEvent(session, event)
    deps.schedulePersistedSessionsWrite?.()
    deps.scheduleCredentialRecoveryReplacement?.(session.name)
    return
  }

  if (!result.switched || !recoveryTarget) {
    const blockedUntil = result.blocked?.earliestExhaustedUntil ?? result.pool.earliestExhaustedUntil
    installBlockedCredentialPoolRecovery(deps, session, {
      ...options,
      ...(resetAt ? { resetAt } : {}),
      ...(blockedUntil ? { blockedUntil } : {}),
    })
    return
  }

  const request = buildRecoveryRequest(session, recoveryTarget.id, {
    ...options,
    resetAt,
  })
  session.credentialPoolRecovery = request
  deps.markCredentialRecoveryRequest?.(session.name, request)
  const event = createCredentialSwitchStartedSystemEvent(session, result, resetAt)
  deps.appendStreamEvent(session, event)
  deps.broadcastStreamEvent(session, event)
  deps.schedulePersistedSessionsWrite?.()
  deps.scheduleCredentialRecoveryReplacement?.(session.name)
}

export function createProviderSessionRuntime(
  deps: ProviderSessionRuntimeDeps,
): ProviderSessionRuntime {
  const preservedForReplacement = new WeakSet<StreamSession>()

  async function beginLocalClaudeSpawn(
    agentType: AgentType,
    machine: MachineConfig | undefined,
  ): Promise<() => void> {
    if (agentType !== 'claude' || isRemoteMachine(machine) || isDaemonMachine(machine)) {
      return () => undefined
    }
    return deps.acquireClaudeGlobalCredentialLease?.() ?? (() => undefined)
  }

  function preservedLiveSession(name: string): StreamSession | undefined {
    const session = deps.sessions.get(name)
    return session?.kind === 'stream' && (
      preservedForReplacement.has(session)
      || (
        session.agentType === 'claude'
        && (session.host ?? 'local') === 'local'
        && session.credentialPoolMode !== 'isolated-runtime'
        && Boolean(session.credentialPoolRecovery)
      )
    )
      ? session
      : undefined
  }

  function listActiveCodexSessionNames(): string[] {
    return [...deps.sessions.entries()]
      .filter(([, candidate]) => (
        candidate.kind === 'stream'
        && getProvider(candidate.agentType)?.id === 'codex'
      ))
      .map(([sessionName]) => sessionName)
  }

  const providerSessionBaseDeps = {
    appendEvent: deps.appendStreamEvent,
    broadcastEvent: deps.broadcastStreamEvent,
    clearExitedSession: (name: string) => {
      if (preservedLiveSession(name)) {
        return
      }
      deps.exitedStreamSessions.delete(name)
    },
    deleteLiveSession: (name: string) => {
      if (preservedLiveSession(name)) {
        return
      }
      deps.sessions.delete(name)
    },
    deleteSessionEventHandlers: (name: string) => {
      if (preservedLiveSession(name)) {
        return
      }
      deps.sessionEventHandlers.delete(name)
    },
    getActiveSession: (name: string) => deps.sessions.get(name),
    resetActiveTurnState: deps.resetActiveTurnState,
    schedulePersistedSessionsWrite: deps.schedulePersistedSessionsWrite,
    setCompletedSession: async (name: string, session: CompletedSession) => {
      const active = deps.sessions.get(name)
      if (active?.kind === 'stream' && preservedForReplacement.has(active)) {
        return
      }
      if (active?.kind === 'stream') {
        await switchCredentialAfterUsageLimit(deps, active)
      }
      deps.completedSessions.set(name, session)
    },
    setExitedSession: (name: string, session: ExitedStreamSessionState) => {
      if (preservedLiveSession(name)) {
        return
      }
      deps.exitedStreamSessions.set(name, session)
    },
    shouldPreserveSession: (session: StreamSession) => preservedLiveSession(session.name) === session,
    spawnImpl: spawn,
    daemonRegistry: deps.daemonRegistry,
    internalToken: deps.internalToken,
    approvalBridgeSigningSecret: deps.approvalBridgeSigningSecret,
    resolveConversationApprovalBridgeCredential: deps.resolveConversationApprovalBridgeCredential,
    writeToStdin: deps.writeToStdin,
    writeTranscriptMeta: deps.writeTranscriptMeta,
    getActionPolicyGate: deps.getActionPolicyGate,
    markProviderAuthRequired: deps.markProviderAuthRequired,
  }

  function getProviderSessionDeps(agentType: AgentType): ProviderAdapterDeps {
    const providerId = getProvider(agentType)?.id
    if (providerId === 'codex') {
      return {
        ...providerSessionBaseDeps,
        clearTurnWatchdog: clearCodexTurnWatchdog,
        getAllSessions: () => deps.sessions.values(),
        notifyApprovalEnqueued: deps.approvalQueue.notifyApprovalEnqueued,
        notifyApprovalResolved: deps.approvalQueue.notifyApprovalResolved,
        runtimeFactory: (
          sessionName: string,
          machine: MachineConfig | undefined,
          handleOwningSessionFailure: (failure: CodexRuntimeFailure) => void,
          providerAuth?: ProviderSpawnAuth,
        ) => new CodexSessionRuntime(
          sessionName,
          machine,
          listActiveCodexSessionNames,
          deps.wsKeepAliveIntervalMs,
          handleOwningSessionFailure,
          spawn,
          deps.daemonRegistry,
          providerAuth,
        ),
        scheduleTurnWatchdog: scheduleCodexTurnWatchdog,
      } as unknown as ProviderAdapterDeps
    }

    if (providerId === 'gemini') {
      return {
        ...providerSessionBaseDeps,
        runtimeFactory: (
          sessionName: string,
          machine?: MachineConfig,
          model?: string,
          providerAuth?: ProviderSpawnAuth,
        ) =>
          new GeminiAcpRuntime(sessionName, machine, model, deps.daemonRegistry, providerAuth),
      } as unknown as ProviderAdapterDeps
    }

    if (providerId === 'opencode') {
      return {
        ...providerSessionBaseDeps,
        runtimeFactory: (
          sessionName: string,
          machine?: MachineConfig,
          model?: string,
          providerAuth?: ProviderSpawnAuth,
        ) =>
          new OpenCodeAcpRuntime(sessionName, machine, model, deps.daemonRegistry, providerAuth),
      } as unknown as ProviderAdapterDeps
    }

    return providerSessionBaseDeps as unknown as ProviderAdapterDeps
  }

  async function prepareSessionProviderAuth(
    agentType: AgentType,
    machine: MachineConfig | undefined,
    creator: ProviderStreamSessionOptions['creator'],
    resumeProviderContext?: ProviderStreamSessionOptions['resumeProviderContext'],
    credentialPoolId?: string,
    credentialPoolMode?: ProviderStreamSessionOptions['credentialPoolMode'],
  ): Promise<ProviderSpawnAuth> {
    try {
      const codexContext = agentType === 'codex'
        ? asCodexProviderContext(resumeProviderContext)
        : null
      const codexHome = codexContext?.codexHome
        ?? (codexContext?.threadId && !machine
          ? await findLocalCodexHomeForThread({
            threadId: codexContext.threadId,
            store: deps.providerAuthStore,
            env: process.env,
          })
          : undefined)
      return await prepareProviderSpawnAuth({
        provider: agentType,
        scopeId: resolveProviderAuthScopeId(creator),
        machine,
        store: deps.providerAuthStore,
        env: process.env,
        codexHome,
        credentialPoolId,
        credentialPoolMode,
      })
    } catch (error) {
      if (
        error instanceof ProviderAuthRequiredError
        && creator?.kind === 'commander'
        && creator.id
) {
        await deps.questStore?.blockActiveForAuthRequired(creator.id, error.message)
      }
      throw error
    }
  }

  async function createProviderStreamSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    task: string,
    cwd: string | undefined,
    machine: MachineConfig | undefined,
    agentType: AgentType = 'claude',
    sessionOptions: ProviderStreamSessionOptions = {},
  ): Promise<StreamSession> {
    assertProviderExecutionAllowed(
      deps.providerExecutionMode ?? DEFAULT_PROVIDER_EXECUTION_MODE,
      machine,
    )
    const provider = getProvider(agentType)
    if (!provider) {
      throw new Error(`Unknown provider: ${agentType}`)
    }

    const create = async (): Promise<StreamSession> => {
      const releaseSpawn = await beginLocalClaudeSpawn(agentType, machine)
      try {
        const providerAuth = await prepareSessionProviderAuth(
          agentType,
          machine,
          sessionOptions.creator,
          sessionOptions.resumeProviderContext,
          sessionOptions.credentialPoolId,
          sessionOptions.credentialPoolMode,
        )
        const providerSessionOptions = { ...sessionOptions }
        delete providerSessionOptions.env
        const mergedProviderAuth = sessionOptions.env
          ? {
              ...providerAuth,
              env: {
                ...(providerAuth.env ?? {}),
                ...sessionOptions.env,
              },
            }
          : providerAuth

        return await provider.create({
          sessionName,
          mode,
          task,
          cwd,
          machine,
          ...providerSessionOptions,
          providerAuth: mergedProviderAuth,
        }, getProviderSessionDeps(agentType))
      } finally {
        setImmediate(releaseSpawn)
      }
    }
    const commanderId = sessionOptions.creator?.kind === 'commander'
      ? sessionOptions.creator.id?.trim()
      : undefined
    return commanderId
      ? withCommanderRuntimeLaunch(
          commanderId,
          deps.commanderDataDir ?? resolveCommanderDataDir(),
          create,
        )
      : create()
  }

  async function restoreProviderStreamSession(
    entry: PersistedStreamSession,
    machine: MachineConfig | undefined,
  ): Promise<StreamSession> {
    assertProviderExecutionAllowed(
      deps.providerExecutionMode ?? DEFAULT_PROVIDER_EXECUTION_MODE,
      machine,
    )
    const provider = getProvider(entry.agentType)
    if (!provider) {
      throw new Error(`Unknown provider: ${entry.agentType}`)
    }
    const restore = async (): Promise<StreamSession> => {
      const releaseSpawn = await beginLocalClaudeSpawn(entry.agentType, machine)
      try {
        const providerAuth = await prepareSessionProviderAuth(
          entry.agentType,
          machine,
          entry.creator,
          entry.providerContext,
          entry.credentialPoolId,
          entry.credentialPoolMode,
        )
        return await provider.restore(entry, machine, getProviderSessionDeps(entry.agentType), providerAuth)
      } finally {
        setImmediate(releaseSpawn)
      }
    }
    const commanderId = entry.creator?.kind === 'commander'
      ? entry.creator.id?.trim()
      : undefined
    return commanderId
      ? withCommanderRuntimeLaunch(
          commanderId,
          deps.commanderDataDir ?? resolveCommanderDataDir(),
          restore,
        )
      : restore()
  }

  async function teardownProviderSession(
    session: StreamSession,
    reason: string,
    options?: ProviderTeardownOptions,
  ): Promise<ProviderTeardownResult> {
    const startedAt = Date.now()
    const resultBase = (): Omit<ProviderTeardownResult, 'verified' | 'phase'> => ({
      elapsedMs: Date.now() - startedAt,
      ...(session.process.pid ? { pid: session.process.pid } : {}),
      ...(session.processTree?.processGroupId
        ? { processGroupId: session.processTree.processGroupId }
        : {}),
      ownership: session.processTree?.ownership ?? 'untracked',
      survivingPids: listProviderProcessMembers(session.processTree),
    })
    const provider = getProvider(session.agentType)
    if (!provider) {
      return { verified: false, phase: 'not-verified', ...resultBase() }
    }
    if (options?.preserveForReplacement) {
      preservedForReplacement.add(session)
    }
    let teardownError: unknown
    try {
      await provider.teardown(session, reason, options)
    } catch (error) {
      teardownError = error
    }
    if (options?.preserveForReplacement) {
      let stopped = await waitForProviderProcessExit(session.process, session.processTree, 5_000)
      let phase: ProviderTeardownResult['phase'] = 'sigterm'
      if (!stopped) {
        console.warn('[agents/provider-auth] provider runtime did not stop after SIGTERM; escalating', {
          session: session.name,
          provider: session.agentType,
          pid: session.process.pid,
          processGroupId: session.processTree?.processGroupId,
          elapsedMs: Date.now() - startedAt,
          survivingPids: listProviderProcessMembers(session.processTree),
        })
        signalProviderProcess(session.process, session.processTree, 'SIGKILL')
        phase = 'sigkill'
        stopped = await waitForProviderProcessExit(session.process, session.processTree, 2_000)
      }
      if (!stopped || providerProcessAlive(session.process, session.processTree)) {
        const exitError = new Error(`Timed out stopping session "${session.name}" for credential replacement`)
        console.warn('[agents/provider-auth] provider runtime process tree survived credential replacement teardown', {
          session: session.name,
          provider: session.agentType,
          pid: session.process.pid,
          processGroupId: session.processTree?.processGroupId,
          elapsedMs: Date.now() - startedAt,
          survivingPids: listProviderProcessMembers(session.processTree),
        })
        if (teardownError) {
          throw new AggregateError([teardownError, exitError], `Failed to stop session "${session.name}"`)
        }
        throw exitError
      }
      session.cleanupProcessResources?.()
      if (teardownError) {
        console.warn('[agents/provider-auth] provider teardown failed after process stopped', {
          session: session.name,
          error: teardownError instanceof Error ? teardownError.message : String(teardownError),
        })
      }
      return { verified: true, phase, ...resultBase() }
    }
    if (teardownError) {
      console.warn('[agents/provider-auth] provider teardown failed after process stopped', {
        session: session.name,
        error: teardownError instanceof Error ? teardownError.message : String(teardownError),
      })
    }
    return { verified: false, phase: 'not-verified', ...resultBase() }
  }

  async function shutdownProviderRuntimes(reason = 'Herd shutdown'): Promise<void> {
    await Promise.allSettled(
      listProviders().map(async (provider) => {
        const providerSessions = [...deps.sessions.values()].filter((session): session is StreamSession => (
          session.kind === 'stream' && session.agentType === provider.id
        ))
        if (provider.shutdownFleet) {
          await provider.shutdownFleet(providerSessions, reason)
          return
        }
        // Preserve resumable live-session snapshots on server shutdown for
        // providers that do not own a fleet-level runtime hook.
        for (const session of providerSessions) {
          for (const client of session.clients) {
            client.close(1001, 'Server shutting down')
          }
        }
      }),
    )
  }

  function applyCodexApprovalDecision(
    session: StreamSession,
    requestId: number,
    decision: CodexApprovalDecision,
  ): { ok: true } | {
    ok: false
    code: 'invalid_session' | 'unavailable' | 'not_found' | 'protocol_error'
    reason: string
  } {
    return applyCodexApprovalDecisionAdapter(
      session,
      requestId,
      decision,
      getProviderSessionDeps('codex') as Parameters<typeof applyCodexApprovalDecisionAdapter>[3],
    )
  }

  function buildCodexAssistantMessageEventsFromThreadSnapshot(
    turnId: string | undefined,
    turn: Record<string, unknown>,
    thread: Record<string, unknown>,
  ): TranscriptEnvelope[] {
    const threadId = typeof thread.id === 'string' && thread.id.trim().length > 0
      ? thread.id.trim()
      : undefined
    const items = Array.isArray(turn.items) ? turn.items : []

    return items.flatMap((entry) => {
      const item = asObject(entry)
      if (!item || item.type !== 'agentMessage') {
        return []
      }
      const envelopes = mapCodexToTranscriptEnvelopes('item/completed', {
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        item,
      })
      return envelopes.some((envelope) => envelope.ev.type === 'message.delta')
        ? envelopes
        : []
    })
  }

  function buildCodexEventsFromThreadSnapshot(
    session: StreamSession,
    status: string,
    turn: Record<string, unknown>,
    thread: Record<string, unknown>,
  ): StreamJsonEvent[] {
    const turnUsage = extractCodexUsageTotals(asObject(turn.tokenUsage) ?? asObject(turn.usage))
    const threadUsage = extractCodexUsageTotals(asObject(thread.tokenUsage) ?? asObject(thread.usage))
    const usage = turnUsage.usage ?? threadUsage.usage
    const totalCostUsd = turnUsage.totalCostUsd ?? threadUsage.totalCostUsd

    const turnId = typeof turn.id === 'string' && turn.id.trim().length > 0 ? turn.id.trim() : undefined
    const assistantMessageEvents = buildCodexAssistantMessageEventsFromThreadSnapshot(turnId, turn, thread)
    const payload = {
      turn,
      thread,
      ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
    }
    const error = asObject(turn.error)
    const failureMessage = typeof error?.message === 'string' && error.message.trim().length > 0
      ? error.message.trim()
      : 'Codex turn failed'

    const resultEvent = {
      schemaVersion: 2,
      id: createTranscriptId(),
      time: new Date().toISOString(),
      source: {
        provider: 'codex',
        backend: 'rpc',
        ...(readCodexThreadId(session) ? { sessionId: readCodexThreadId(session) } : {}),
        rawEventType: 'herd/codex-watchdog-thread-read',
        ...(turnId ? { rawEventId: turnId } : {}),
      },
      ...(turnId ? { turnId } : {}),
      ev: {
        type: 'turn.end',
        status,
        ...(usage ? { usage } : {}),
        ...(status === 'failed'
          ? { error: failureMessage, result: payload }
          : { result: status === 'interrupted' ? { ...payload, message: 'Turn interrupted' } : payload }),
      },
    } satisfies TranscriptEnvelope

    return [...assistantMessageEvents, resultEvent]
  }

  async function handleCodexTurnWatchdogTimeout(session: StreamSession): Promise<void> {
    if (deps.sessions.get(session.name) !== session) {
      return
    }
    const threadId = readCodexThreadId(session)
    if (session.lastTurnCompleted || !threadId) {
      clearCodexTurnWatchdog(session)
      markCodexTurnHealthy(session)
      return
    }

    clearCodexTurnWatchdog(session)

    if (hasPendingCodexApprovals(session)) {
      readCodexRuntime(session)?.log('info', 'Codex watchdog paused while waiting for approval decision', {
        sessionName: session.name,
        threadId,
        pendingApprovals: session.codexPendingApprovals.size,
      })
      return
    }

    let resolved = false
    try {
      const runtime = readCodexRuntime(session)
      if (!runtime) {
        return
      }
      const runtimeThreadId = readCodexThreadId(session)
      if (!runtimeThreadId) {
        return
      }
      const readResult = await runtime.sendRequest('thread/read', {
        threadId: runtimeThreadId,
        includeTurns: true,
      })

      if (deps.sessions.get(session.name) !== session || session.lastTurnCompleted) {
        return
      }

      const resultObj = asObject(readResult)
      const thread = asObject(resultObj?.thread)
      const turns = Array.isArray(thread?.turns) ? thread.turns : []
      let latestTurn: Record<string, unknown> | null = null
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = asObject(turns[i])
        if (turn) {
          latestTurn = turn
          break
        }
      }

      const status = typeof latestTurn?.status === 'string'
        ? latestTurn.status.trim().toLowerCase()
        : ''

      if (latestTurn && thread && (status === 'completed' || status === 'failed' || status === 'interrupted')) {
        const syntheticEvents = buildCodexEventsFromThreadSnapshot(session, status, latestTurn, thread)
        for (const syntheticEvent of syntheticEvents) {
          deps.appendStreamEvent(session, syntheticEvent)
          deps.broadcastStreamEvent(session, syntheticEvent)
        }
        deps.schedulePersistedSessionsWrite()
        resolved = true
      }
    } catch (error) {
      readCodexRuntime(session)?.log('warn', 'Codex watchdog thread/read reconciliation failed', {
        sessionName: session.name,
        threadId: readCodexThreadId(session),
        error: truncateLogText(error instanceof Error ? error.message : String(error)),
      })
    }

    if (resolved || deps.sessions.get(session.name) !== session || session.lastTurnCompleted) {
      return
    }

    const timeoutSeconds = Math.max(1, Math.round(deps.codexTurnWatchdogTimeoutMs / 1000))
    session.codexTurnStaleAt = new Date().toISOString()
    const lastIncomingMethod = session.codexLastIncomingMethod
    const lastIncomingAt = session.codexLastIncomingAt
    const unclassifiedIncomingCount = session.codexUnclassifiedIncomingCount
    const diagnosticDetails = [
      lastIncomingMethod ? `last sidecar method: ${lastIncomingMethod}` : 'no sidecar method observed yet',
      lastIncomingAt ? `last sidecar event at: ${lastIncomingAt}` : null,
      unclassifiedIncomingCount > 0
        ? `${unclassifiedIncomingCount} unclassified incoming approval request(s) declined this turn`
        : null,
    ].filter((value): value is string => value !== null).join('; ')
    const staleEvent: StreamJsonEvent = {
      schemaVersion: 2,
      id: createTranscriptId(),
      time: session.codexTurnStaleAt,
      source: {
        provider: 'codex',
        backend: 'rpc',
        sessionId: threadId,
        rawEventType: 'herd/codex-watchdog-stale',
      },
      ev: {
        type: 'provider.activity',
        title: 'Codex turn is stale',
        detail: `No sidecar events for ${timeoutSeconds}s. Session remains recoverable via resume.`,
        data: {
          timeoutSeconds,
          lastIncomingMethod: lastIncomingMethod ?? null,
          lastIncomingAt: lastIncomingAt ?? null,
          unclassifiedIncomingCount,
          diagnostics: diagnosticDetails,
        },
      },
    } satisfies TranscriptEnvelope
    deps.appendStreamEvent(session, staleEvent)
    deps.broadcastStreamEvent(session, staleEvent)
    deps.schedulePersistedSessionsWrite()
    readCodexRuntime(session)?.log('warn', 'Codex turn marked stale after watchdog timeout', {
      sessionName: session.name,
      threadId: readCodexThreadId(session),
      timeoutSeconds,
      lastIncomingMethod: lastIncomingMethod ?? null,
      lastIncomingAt: lastIncomingAt ?? null,
      unclassifiedIncomingCount,
    })
  }

  function scheduleCodexTurnWatchdog(session: StreamSession): void {
    if (session.agentType !== 'codex' || session.lastTurnCompleted) {
      clearCodexTurnWatchdog(session)
      return
    }
    clearCodexTurnWatchdog(session)
    markCodexTurnHealthy(session)
    session.codexTurnWatchdogTimer = setTimeout(() => {
      void handleCodexTurnWatchdogTimeout(session)
    }, deps.codexTurnWatchdogTimeoutMs)
  }

  function handleUsageLimitSignal(
    session: StreamSession,
    options: UsageLimitRecoveryOptions = {},
  ): void {
    const pending = markUsageLimitRecoveryPending(session, options)
    if (pending) {
      deps.markCredentialRecoveryRequest?.(session.name, pending)
      deps.schedulePersistedSessionsWrite()
    }
    void switchCredentialAfterUsageLimit(deps, session, options).catch((error) => {
      console.warn(
        '[agents/provider-auth] failed to recover after usage limit',
        { session: session.name, provider: session.agentType, error: error instanceof Error ? error.message : String(error) },
      )
    })
  }

  function handleAuthRequiredSignal(
    session: StreamSession,
    detail: string,
    recovery: {
      interruptedMessage?: StreamSession['currentQueuedMessage']
      interruptedTurnHadSideEffects?: boolean
      interruptedTurnId?: string
    } = {},
  ): void {
    if (session.credentialPoolRecovery?.reason === 'auth_required') {
      return
    }
    void deps.markProviderAuthRequired(session, detail, recovery).catch((error) => {
      console.warn('[agents/provider-auth] failed to recover after authentication rejection', {
        session: session.name,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  function restoreCredentialPoolRecovery(session: StreamSession): void {
    registerRestoredCredentialPoolRecovery(deps, session)
  }

  return {
    createProviderStreamSession,
    restoreProviderStreamSession,
    teardownProviderSession,
    shutdownProviderRuntimes,
    applyCodexApprovalDecision,
    scheduleCodexTurnWatchdog,
    handleUsageLimitSignal,
    handleAuthRequiredSignal,
    restoreCredentialPoolRecovery,
  }
}
