import {
  sanitizeProviderContextForPersistence,
} from '../providers/provider-context-normalization.js'
import {
  DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE,
} from '../../claude-adaptive-thinking.js'
import { DEFAULT_CLAUDE_MAX_THINKING_TOKENS } from '../../claude-max-thinking-tokens.js'
import { DEFAULT_CLAUDE_EFFORT_LEVEL } from '../../claude-effort.js'
import type { MachineRegistryStore } from '../machines.js'
import {
  DEFAULT_SESSION_MESSAGE_QUEUE_LIMIT,
  SessionMessageQueue,
} from '../message-queue.js'
import { COMMANDER_PATH_SEGMENT_PATTERN, RESTORED_REPLAY_TURN_LIMIT } from '../constants.js'
import {
  applyRestoredReplayState,
  asObject,
  buildPersistedEntryFromExitedSession,
  buildPersistedEntryFromLiveStreamSession,
  countCompletedTurnEntries,
  mergePersistedSessionWithTranscriptMeta,
  snapshotExitedStreamSession,
  toCompletedSession,
} from './state.js'
import type {
  AnySession,
  CompletedSession,
  CommanderTranscriptAppender,
  ExitedStreamSessionState,
  MachineConfig,
  PersistedSessionsState,
  PersistedStreamSession,
  StreamJsonEvent,
  StreamSession,
} from '../types.js'
import {
  appendTranscriptEvent,
  readSessionMeta,
  readTranscriptTail,
  type TranscriptMeta,
  writeSessionMeta,
} from '../transcript-store.js'
import {
  extractTranscriptUsageUpdate,
  isTranscriptTurnEndRecord,
  isTranscriptTurnStartRecord,
} from '../transcript-records.js'
import {
  asClaudeProviderContext,
  createClaudeProviderContext,
  createCodexProviderContext,
  ensureCodexProviderContext,
} from '../providers/provider-session-context.js'
import { getProvider } from '../providers/registry.js'
import { ProviderAuthRequiredError } from '../provider-auth.js'
import { isTranscriptEnvelope } from '../../../src/types/transcript-envelope.js'
import {
  isCommanderPackageRemovalPending,
  withCommanderRuntimeLaunch,
} from '../../commanders/package-lifecycle-state.js'
import { resolveCommanderDataDir } from '../../commanders/paths.js'

export interface PersistedSessionsWriteDeps {
  sessions: Map<string, AnySession>
  exitedStreamSessions: Map<string, ExitedStreamSessionState>
}

export interface PersistedRestoreDeps {
  sessions: Map<string, AnySession>
  completedSessions: Map<string, CompletedSession>
  exitedStreamSessions: Map<string, ExitedStreamSessionState>
  maxSessions: number
  persistedState: PersistedSessionsState
  machineRegistry: MachineRegistryStore
  applyUsageEvent: (session: StreamSession, event: StreamJsonEvent) => void
  restoreProviderSession: (
    entry: PersistedStreamSession,
    machine?: MachineConfig,
  ) => StreamSession | Promise<StreamSession>
  commanderLifecycleScope?: string
  shouldRestoreSession?(
    entry: PersistedStreamSession,
  ): boolean | Promise<boolean>
  shouldAutoRestoreSession?(
    entry: PersistedStreamSession,
    machine?: MachineConfig,
  ): boolean
  restoreCredentialPoolRecovery?(session: StreamSession): void
}

export function sanitizeTranscriptFileKey(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function warnTranscriptStoreFailure(action: string, sessionName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[agents] Failed to ${action} for "${sessionName}": ${message}`)
}

export function buildTranscriptMeta(session: StreamSession): TranscriptMeta {
  return {
    agentType: session.agentType,
    model: session.model,
    effort: session.effort,
    adaptiveThinking: session.adaptiveThinking,
    maxThinkingTokens: session.maxThinkingTokens,
    cwd: session.cwd,
    host: session.host,
    createdAt: session.createdAt,
    promptAudit: session.promptAudit,
    providerContext: sanitizeProviderContextForPersistence(session.providerContext, {
      effort: session.effort,
      adaptiveThinking: session.adaptiveThinking,
      maxThinkingTokens: session.maxThinkingTokens,
    }),
    spawnedBy: session.spawnedBy,
  }
}

const lastTranscriptMetaJsonBySession = new WeakMap<StreamSession, string>()

export function writeTranscriptMetaForSession(session: StreamSession): void {
  const meta = buildTranscriptMeta(session)
  const serialized = JSON.stringify(meta)
  if (lastTranscriptMetaJsonBySession.get(session) === serialized) {
    return
  }
  lastTranscriptMetaJsonBySession.set(session, serialized)

  void writeSessionMeta(session.name, meta).catch((error) => {
    if (lastTranscriptMetaJsonBySession.get(session) === serialized) {
      lastTranscriptMetaJsonBySession.delete(session)
    }
    warnTranscriptStoreFailure('write transcript meta', session.name, error)
  })
}

export function appendGenericTranscriptEvent(session: StreamSession, event: StreamJsonEvent): void {
  if (!isTranscriptEnvelope(event)) {
    return
  }
  void appendTranscriptEvent(session.name, event).catch((error) => {
    warnTranscriptStoreFailure('append transcript event', session.name, error)
  })
  writeTranscriptMetaForSession(session)
}

export function appendCommanderTranscriptEvent(
  session: StreamSession,
  event: StreamJsonEvent,
  transcriptAppender: CommanderTranscriptAppender | undefined,
  extractClaudeSessionId: (event: StreamJsonEvent) => string | undefined,
): void {
  if (!isTranscriptEnvelope(event)) {
    return
  }
  if (!transcriptAppender || session.sessionType !== 'commander' || session.creator.kind !== 'commander') {
    return
  }

  const commanderId = session.creator.id?.trim()
  if (!commanderId || !COMMANDER_PATH_SEGMENT_PATTERN.test(commanderId)) {
    return
  }

  const rawTranscriptId = getProvider(session.agentType)?.transcriptId(session, event)
    ?? extractClaudeSessionId(event)
    ?? session.name
  const transcriptId = sanitizeTranscriptFileKey(rawTranscriptId)
  if (!transcriptId) {
    return
  }

  transcriptAppender.appendEvent({
    commanderId,
    transcriptId,
    event,
  })
}

export async function resolveRestoredReplaySource(
  entry: PersistedStreamSession,
): Promise<{ entry: PersistedStreamSession; events: StreamJsonEvent[] }> {
  let resolvedEntry = entry
  try {
    resolvedEntry = mergePersistedSessionWithTranscriptMeta(entry, await readSessionMeta(entry.name))
  } catch (error) {
    warnTranscriptStoreFailure('read transcript meta', entry.name, error)
  }

  try {
    const transcriptEvents = await readTranscriptTail(entry.name, RESTORED_REPLAY_TURN_LIMIT)
    if (transcriptEvents.length > 0) {
      return {
        entry: resolvedEntry,
        events: transcriptEvents,
      }
    }
  } catch (error) {
    warnTranscriptStoreFailure('read transcript tail', entry.name, error)
  }

  return {
    entry: resolvedEntry,
    events: resolvedEntry.events ? [...resolvedEntry.events] : [],
  }
}

function readCompletedSessionCost(event: StreamJsonEvent): number {
  const usageUpdate = extractTranscriptUsageUpdate(event)
  if (typeof usageUpdate?.totalCostUsd === 'number') {
    return usageUpdate.totalCostUsd
  }
  if (typeof usageUpdate?.costUsd === 'number') {
    return usageUpdate.costUsd
  }

  const rawEvent = event as { total_cost_usd?: unknown; cost_usd?: unknown }
  if (typeof rawEvent.total_cost_usd === 'number') {
    return rawEvent.total_cost_usd
  }
  if (typeof rawEvent.cost_usd === 'number') {
    return rawEvent.cost_usd
  }
  return 0
}

export function serializePersistedSessionsState(
  deps: PersistedSessionsWriteDeps,
): PersistedSessionsState {
  const sessionsByName = new Map<string, PersistedStreamSession>()
  for (const session of deps.sessions.values()) {
    if (session.kind !== 'stream') continue
    if (
      (session.sessionType === 'cron' || session.sessionType === 'automation') &&
      session.lastTurnCompleted &&
      session.finalResultEvent
    ) continue
    if (!session.credentialPoolRecovery && !getProvider(session.agentType)?.snapshotForPersist(session)) continue
    sessionsByName.set(session.name, buildPersistedEntryFromLiveStreamSession(session.name, session))
  }

  for (const [sessionName, exited] of deps.exitedStreamSessions) {
    if (exited.sessionType === 'cron' || exited.sessionType === 'automation') continue
    const persistedExited = buildPersistedEntryFromExitedSession(sessionName, exited)
    if (!getProvider(exited.agentType)?.hasResumeIdentifier(persistedExited)) {
      continue
    }
    sessionsByName.set(sessionName, persistedExited)
  }

  const restoredSessions = [...sessionsByName.values()]
  restoredSessions.sort((left, right) => left.name.localeCompare(right.name))
  return { sessions: restoredSessions }
}

function buildRecoveryProviderContext(entry: PersistedStreamSession): StreamSession['providerContext'] {
  if (!entry.credentialPoolRecovery?.clearResumeProviderContext) {
    return entry.providerContext
  }

  if (entry.agentType === 'codex') {
    return createCodexProviderContext()
  }

  if (entry.agentType === 'claude') {
    const context = asClaudeProviderContext(entry.providerContext)
    const omitEffort = context?.omitEffort === true
    return createClaudeProviderContext({
      effort: omitEffort
        ? undefined
        : context?.effort ?? entry.effort ?? DEFAULT_CLAUDE_EFFORT_LEVEL,
      ...(omitEffort ? { omitEffort: true } : {}),
      adaptiveThinking: context?.adaptiveThinking ?? entry.adaptiveThinking ?? DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE,
      maxThinkingTokens: context?.maxThinkingTokens ?? entry.maxThinkingTokens ?? DEFAULT_CLAUDE_MAX_THINKING_TOKENS,
    })
  }

  return entry.providerContext
}

function readRestoredTurnState(events: readonly StreamJsonEvent[]): {
  lastTurnCompleted: boolean
  completedTurnAt?: string
  finalResultEvent?: StreamJsonEvent
} {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (isTranscriptTurnEndRecord(event)) {
      return {
        lastTurnCompleted: true,
        ...(isTranscriptEnvelope(event) ? { completedTurnAt: event.time } : {}),
        finalResultEvent: event,
      }
    }
    if (isTranscriptTurnStartRecord(event)) {
      return { lastTurnCompleted: false }
    }
  }
  return { lastTurnCompleted: true }
}

function buildPendingCredentialRecoverySession(
  entry: PersistedStreamSession,
  events: readonly StreamJsonEvent[],
): StreamSession | null {
  if (!entry.sessionType || !entry.creator || !entry.credentialPoolRecovery) {
    return null
  }

  const turnState = readRestoredTurnState(events)
  const lastEvent = events.at(-1)
  const recovery: NonNullable<PersistedStreamSession['credentialPoolRecovery']> = {
    ...entry.credentialPoolRecovery,
    ...((entry.activeTurnMessage ?? entry.currentQueuedMessage) && !entry.credentialPoolRecovery.interruptedMessage
      ? { interruptedMessage: entry.activeTurnMessage ?? entry.currentQueuedMessage }
      : {}),
    ...((entry.activeTurnMessage ?? entry.currentQueuedMessage)
      && entry.credentialPoolRecovery.interruptedTurnHadSideEffects === undefined
      ? { interruptedTurnHadSideEffects: true }
      : {}),
    ...(entry.activeTurnId && !entry.credentialPoolRecovery.interruptedTurnId
      ? { interruptedTurnId: entry.activeTurnId }
      : {}),
  }
  return {
    kind: 'stream',
    name: entry.name,
    sessionType: entry.sessionType,
    creator: entry.creator,
    ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    agentType: entry.agentType,
    effort: entry.effort,
    adaptiveThinking: entry.adaptiveThinking,
    maxThinkingTokens: entry.maxThinkingTokens,
    mode: entry.mode,
    cwd: entry.cwd,
    ...(entry.host ? { host: entry.host } : {}),
    ...(entry.currentSkillInvocation ? { currentSkillInvocation: entry.currentSkillInvocation } : {}),
    ...(entry.spawnedBy ? { spawnedBy: entry.spawnedBy } : {}),
    spawnedWorkers: entry.spawnedWorkers ? [...entry.spawnedWorkers] : [],
    process: { kill: () => true } as unknown as StreamSession['process'],
    events: [],
    clients: new Set(),
    createdAt: entry.createdAt,
    lastEventAt: isTranscriptEnvelope(lastEvent) ? lastEvent.time : entry.createdAt,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    stdoutBuffer: '',
    stdinDraining: false,
    // This is a process-free recovery placeholder. No provider event can end
    // an interrupted turn, so replacement owns the next safe transition.
    lastTurnCompleted: true,
    ...(turnState.completedTurnAt ? { completedTurnAt: turnState.completedTurnAt } : {}),
    providerContext: buildRecoveryProviderContext(entry),
    ...(entry.credentialPoolId ? { credentialPoolId: entry.credentialPoolId } : {}),
    ...(entry.credentialPoolMode ? { credentialPoolMode: entry.credentialPoolMode } : {}),
    credentialPoolRecovery: recovery,
    ...(entry.approvalBridgeNonce ? { approvalBridgeNonce: entry.approvalBridgeNonce } : {}),
    ...(turnState.lastTurnCompleted ? {} : { activeTurnId: entry.activeTurnId }),
    ...(entry.resumedFrom ? { resumedFrom: entry.resumedFrom } : {}),
    ...(turnState.finalResultEvent ? { finalResultEvent: turnState.finalResultEvent } : {}),
    conversationEntryCount: entry.conversationEntryCount ?? countCompletedTurnEntries([...events]),
    autoRotatePending: false,
    codexUnclassifiedIncomingCount: 0,
    codexPendingApprovals: new Map(),
    messageQueue: new SessionMessageQueue(DEFAULT_SESSION_MESSAGE_QUEUE_LIMIT),
    pendingDirectSendMessages: [],
    queuedMessageRetryDelayMs: 0,
    queuedMessageDrainScheduled: false,
    queuedMessageDrainPending: false,
    queuedMessageDrainPendingForce: false,
    restoredIdle: true,
  } as StreamSession
}

export async function restorePersistedSessions(
  deps: PersistedRestoreDeps,
): Promise<void> {
  const persisted = deps.persistedState
  if (persisted.sessions.length === 0) return

  const machines = await deps.machineRegistry.readMachineRegistry()
  let remainingLiveSlots = Math.max(0, deps.maxSessions - deps.sessions.size)

  await Promise.allSettled(persisted.sessions.map(async (rawEntry) => {
    if (deps.sessions.has(rawEntry.name)) {
      return
    }

    try {
      const { entry, events } = await resolveRestoredReplaySource(rawEntry)
      const restoreEntry = async (): Promise<void> => {
        const commanderId = entry.creator?.kind === 'commander'
          ? entry.creator.id?.trim()
          : undefined
        if (commanderId && await isCommanderPackageRemovalPending(
          commanderId,
          deps.commanderLifecycleScope ?? resolveCommanderDataDir(),
        )) {
          return
        }
        if (deps.shouldRestoreSession && !await deps.shouldRestoreSession(entry)) {
          return
        }

      if (entry.sessionState === 'exited') {
        if (!entry.sessionType || !entry.creator) {
          return
        }
        const hadResult = entry.hadResult ?? false
        if (!getProvider(entry.agentType)?.hasResumeIdentifier(entry)) {
          return
        }

        const provider = getProvider(entry.agentType)
        const supportsEffort = provider?.uiCapabilities.supportsEffort ?? false
        const supportsAdaptiveThinking = provider?.uiCapabilities.supportsAdaptiveThinking ?? false
        const supportsMaxThinkingTokens = provider?.uiCapabilities.supportsMaxThinkingTokens ?? false
        deps.exitedStreamSessions.set(entry.name, {
          phase: 'exited',
          hadResult,
          sessionType: entry.sessionType,
          creator: entry.creator,
          agentType: entry.agentType,
          model: entry.model,
          mode: entry.mode,
          cwd: entry.cwd,
          host: entry.host,
          currentSkillInvocation: entry.currentSkillInvocation
            ? { ...entry.currentSkillInvocation }
            : undefined,
          spawnedBy: entry.spawnedBy,
          spawnedWorkers: entry.spawnedWorkers ? [...entry.spawnedWorkers] : [],
          createdAt: entry.createdAt,
          providerContext: entry.providerContext,
          credentialPoolRecovery: entry.credentialPoolRecovery,
          activeTurnId: entry.activeTurnId,
          effort: supportsEffort && asClaudeProviderContext(entry.providerContext)?.omitEffort !== true
            ? entry.effort ?? (entry.agentType === 'claude' ? DEFAULT_CLAUDE_EFFORT_LEVEL : undefined)
            : undefined,
          adaptiveThinking: supportsAdaptiveThinking
            ? entry.adaptiveThinking ?? DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE
            : undefined,
          maxThinkingTokens: supportsMaxThinkingTokens
            ? entry.maxThinkingTokens ?? DEFAULT_CLAUDE_MAX_THINKING_TOKENS
            : undefined,
          resumedFrom: entry.resumedFrom,
          conversationEntryCount: entry.conversationEntryCount ?? countCompletedTurnEntries(events),
          events: [...events],
          queuedMessages: entry.queuedMessages ? [...entry.queuedMessages] : [],
          currentQueuedMessage: entry.currentQueuedMessage,
          pendingDirectSendMessages: entry.pendingDirectSendMessages ? [...entry.pendingDirectSendMessages] : [],
        })

        if (hadResult) {
          const resultEvent = [...events].reverse().find(isTranscriptTurnEndRecord)
          if (resultEvent) {
            const totalCost = readCompletedSessionCost(resultEvent)
            deps.completedSessions.set(
              entry.name,
              toCompletedSession(
                entry.name,
                entry.createdAt,
                resultEvent,
                totalCost,
                {
                  sessionType: entry.sessionType,
                  creator: entry.creator,
                  spawnedBy: entry.spawnedBy,
                  createdAt: entry.createdAt,
                },
              ),
            )
          } else {
            deps.completedSessions.set(entry.name, {
              name: entry.name,
              createdAt: entry.createdAt,
              completedAt: entry.createdAt,
              subtype: 'success',
              finalComment: '',
              costUsd: 0,
              sessionType: entry.sessionType,
              creator: entry.creator,
              spawnedBy: entry.spawnedBy,
            })
          }
        }
        return
      }

      if (!entry.sessionType || !entry.creator) {
        return
      }

      let machine: MachineConfig | undefined
      if (entry.host) {
        machine = machines.find((candidate) => candidate.id === entry.host)
        if (!machine) {
          return
        }
      }

      if (deps.shouldAutoRestoreSession && !deps.shouldAutoRestoreSession(entry, machine)) {
        return
      }

      if (remainingLiveSlots <= 0) {
        return
      }
      remainingLiveSlots -= 1

        try {
        let session = buildPendingCredentialRecoverySession(entry, events)
        if (!session) {
          try {
            session = await deps.restoreProviderSession(entry, machine)
          } catch (error) {
            const recoverableLocalClaude = error instanceof ProviderAuthRequiredError
              && entry.agentType === 'claude'
              && !entry.host
              && (!entry.credentialPoolMode || entry.credentialPoolMode === 'global-continuity')
            if (!recoverableLocalClaude) {
              throw error
            }
            const recoveryEntry: PersistedStreamSession = {
              ...entry,
              credentialPoolMode: 'global-continuity',
              credentialPoolRecovery: {
                provider: 'claude',
                ...(entry.credentialPoolId
                  ? { previousCredentialPoolId: entry.credentialPoolId }
                  : {}),
                clearResumeProviderContext: false,
                reason: 'quota_threshold',
                requestedAt: new Date().toISOString(),
                ...((entry.activeTurnMessage ?? entry.currentQueuedMessage)
                  ? { interruptedMessage: entry.activeTurnMessage ?? entry.currentQueuedMessage }
                  : {}),
                ...((entry.activeTurnMessage ?? entry.currentQueuedMessage)
                  ? { interruptedTurnHadSideEffects: true }
                  : {}),
                ...(entry.activeTurnId ? { interruptedTurnId: entry.activeTurnId } : {}),
              },
            }
            session = buildPendingCredentialRecoverySession(recoveryEntry, events)
            if (!session) {
              throw error
            }
          }
        }

        applyRestoredReplayState(session, events, deps.applyUsageEvent, entry.conversationEntryCount)
        session.messageQueue = new SessionMessageQueue(
          DEFAULT_SESSION_MESSAGE_QUEUE_LIMIT,
          entry.queuedMessages ?? [],
        )
        session.currentQueuedMessage = entry.currentQueuedMessage
        session.activeTurnMessage = entry.activeTurnMessage
        session.pendingDirectSendMessages = entry.pendingDirectSendMessages
          ? [...entry.pendingDirectSendMessages]
          : []
        session.credentialPoolRecovery = session.credentialPoolRecovery ?? entry.credentialPoolRecovery
        session.activeTurnId = session.credentialPoolRecovery?.clearResumeProviderContext
          ? undefined
          : entry.activeTurnId
        if (entry.agentType === 'codex' && session.activeTurnId) {
          session.lastTurnCompleted = false
          session.completedTurnAt = undefined
          session.finalResultEvent = undefined
        }
        deps.sessions.set(entry.name, session)
        if (session.credentialPoolRecovery) {
          deps.restoreCredentialPoolRecovery?.(session)
        }
        } catch (error) {
          remainingLiveSlots += 1
          throw error
        }
      }
      const commanderId = entry.creator?.kind === 'commander'
        ? entry.creator.id?.trim()
        : undefined
      if (commanderId) {
        await withCommanderRuntimeLaunch(
          commanderId,
          deps.commanderLifecycleScope ?? resolveCommanderDataDir(),
          restoreEntry,
        )
      } else {
        await restoreEntry()
      }
    } catch (error) {
      console.warn(
        `[agents][restore] Failed to restore persisted session "${rawEntry.name}"`,
        error,
      )
    }
  }))
}

export function clearCodexResumeMetadata(
  sessionName: string,
  sessions: Map<string, AnySession>,
  exitedStreamSessions: Map<string, ExitedStreamSessionState>,
  schedulePersistedSessionsWrite: () => void,
): void {
  const liveSession = sessions.get(sessionName)
  if (liveSession?.kind === 'stream' && liveSession.agentType === 'codex') {
    ensureCodexProviderContext(liveSession).threadId = undefined
    liveSession.activeTurnId = undefined
    liveSession.codexTurnStaleAt = undefined
  }

  const exitedSession = exitedStreamSessions.get(sessionName)
  if (exitedSession?.agentType === 'codex') {
    ensureCodexProviderContext(exitedSession).threadId = undefined
    exitedSession.activeTurnId = undefined
  }

  schedulePersistedSessionsWrite()
}

export function retireLiveCodexSessionForResume(
  sessionName: string,
  session: StreamSession,
  exitedStreamSessions: Map<string, ExitedStreamSessionState>,
  sessions: Map<string, AnySession>,
  sessionEventHandlers: Map<string, Set<(event: StreamJsonEvent) => void>>,
  clearCodexTurnWatchdog: (session: StreamSession) => void,
  markCodexTurnHealthy: (session: StreamSession) => void,
): void {
  clearCodexTurnWatchdog(session)
  markCodexTurnHealthy(session)
  ensureCodexProviderContext(session).notificationCleanup?.()
  ensureCodexProviderContext(session).notificationCleanup = undefined
  for (const client of session.clients) {
    client.close(1000, 'Session resumed')
  }
  exitedStreamSessions.set(sessionName, snapshotExitedStreamSession(session))
  sessions.delete(sessionName)
  sessionEventHandlers.delete(sessionName)
}
