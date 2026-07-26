/**
 * Persistence + restore + prune helpers for the agents router.
 *
 * Extracted from `createAgentsRouter()` in `routes.ts` in issue/921 Phase
 * P6b. Combines four related functions that together manage the SQLite
 * runtime session state: serialize/write on session-lifecycle changes, read on
 * server boot, restore previously-persisted sessions on startup, and
 * periodically prune command-room sessions that have completed.
 *
 * Why these four belong together: they all read/write the same
 * runtime session database, all operate on the same three session maps
 * (`sessions`, `completedSessions`, `exitedStreamSessions`), and both
 * `pruneStaleCommandRoomSessions` and the write path share the
 * `schedulePersistedSessionsWrite` serialization. Keeping them in one
 * module means the write-serialization invariant (a single `Promise<void>`
 * chain that serializes concurrent persist requests) can live here as
 * module-local state rather than leak out as a `persistSessionStateQueue`
 * ref through the context.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  COMMAND_ROOM_COMPLETED_SESSION_TTL_MS,
  MAX_STREAM_EVENTS,
  RESTORED_REPLAY_TURN_LIMIT,
} from './constants.js'
import {
  buildPersistedEntryFromExitedSession,
  getWorldAgentStatus,
} from './session/state.js'
import {
  restorePersistedSessions as restorePersistedSessionsFromStore,
  serializePersistedSessionsState as serializePersistedSessionsStateForStore,
} from './session/persistence.js'
import {
  archiveSqliteRuntimeSession,
  readSqlitePersistedSessionsState,
  writeSqlitePersistedSessionsState,
} from './session/sqlite-runtime-store.js'
import {
  clearCodexTurnWatchdog,
  markCodexTurnHealthy,
} from './adapters/codex/helpers.js'
import { pruneSessionTranscript } from './transcript-store.js'
import type { MachineRegistryStore } from './machines.js'
import { getProvider } from './providers/registry.js'
import type {
  AnySession,
  CompletedSession,
  ExitedStreamSessionState,
  MachineConfig,
  PersistedSessionsState,
  StreamJsonEvent,
  StreamSession,
  PersistedStreamSession,
  SessionCreator,
  SessionType,
} from './types.js'

/**
 * Signature for the router's stream-usage event applier. Called when
 * restoring persisted sessions so the UI can rebuild its usage totals.
 */
export type ApplyStreamUsageEvent = (
  session: StreamSession,
  event: StreamJsonEvent,
) => void

export type ProviderSessionRestorer = (
  entry: PersistedStreamSession,
  machine: MachineConfig | undefined,
) => Promise<StreamSession>

export type ProviderSessionTeardown = (
  session: StreamSession,
  reason: string,
) => Promise<void>

export interface PersistenceHelpersContext {
  sqliteDb: DatabaseSync
  maxSessions: number
  machineRegistry: MachineRegistryStore
  sessions: Map<string, AnySession>
  completedSessions: Map<string, CompletedSession>
  exitedStreamSessions: Map<string, ExitedStreamSessionState>
  applyStreamUsageEvent: ApplyStreamUsageEvent
  restoreProviderSession: ProviderSessionRestorer
  commanderLifecycleScope?: string
  shouldRestoreSession?(
    entry: PersistedStreamSession,
  ): boolean | Promise<boolean>
  shouldAutoRestoreSession?(
    entry: PersistedStreamSession,
    machine?: MachineConfig,
  ): boolean
  restoreCredentialPoolRecovery?(session: StreamSession): void
  teardownProviderSession: ProviderSessionTeardown
  isExitedSessionResumeAvailable(
    entry: ReturnType<typeof buildPersistedEntryFromExitedSession>,
  ): Promise<boolean>
  isLiveSessionResumeAvailable(session: StreamSession): Promise<boolean>
}

export interface SessionPrunerConfig {
  enabled: boolean
  staleSessionTtlMs: number
  exitedSessionTtlMs: number
}

export type SessionPruneLifecycle = 'stale' | 'exited' | 'completed'

export interface SessionPruneCandidate {
  name: string
  sessionType: SessionType
  creator: SessionCreator
  lifecycle: SessionPruneLifecycle
  ageMs: number
  reason:
    | 'cron-completed-ttl'
    | 'stale-non-human-ttl'
    | 'exited-non-human-ttl'
    | 'exited-commander-worker-ttl'
}

export interface PersistenceHelpers {
  schedulePersistedSessionsWrite: () => void
  flushPersistedSessionsWrite: () => Promise<void>
  flushPersistedSessionsForShutdown: () => Promise<void>
  readPersistedSessionsState: () => Promise<PersistedSessionsState>
  restorePersistedSessions: () => Promise<void>
  archivePersistedSession: (sessionName: string, entry?: PersistedStreamSession) => boolean
  getStaleCronSessionCandidates: (nowMs?: number) => SessionPruneCandidate[]
  pruneStaleCronSessions: (nowMs?: number) => number
  pruneStaleCommandRoomSessions: (nowMs?: number) => number
  getStaleNonHumanSessionCandidates: (config: SessionPrunerConfig, nowMs?: number) => Promise<SessionPruneCandidate[]>
  pruneStaleNonHumanSessions: (config: SessionPrunerConfig, nowMs?: number) => Promise<number>
}

/**
 * Build the 4 persistence helpers backed by the given context. Keeps the
 * `Promise<void>` write-serialization chain as module-local state so the
 * single-writer invariant is owned here, not in routes.ts.
 */
export function createPersistenceHelpers(
  ctx: PersistenceHelpersContext,
): PersistenceHelpers {
  const {
    sqliteDb,
    maxSessions,
    machineRegistry,
    sessions,
    completedSessions,
    exitedStreamSessions,
    applyStreamUsageEvent,
    restoreProviderSession,
    commanderLifecycleScope,
    shouldRestoreSession,
    shouldAutoRestoreSession,
    restoreCredentialPoolRecovery,
    teardownProviderSession,
    isExitedSessionResumeAvailable,
    isLiveSessionResumeAvailable,
  } = ctx

  // Single-writer queue: each write is chained off the previous one so
  // concurrent callers never interleave writes to the same durable store. A `.catch`
  // swallow before `.then` prevents a rejected previous write from
  // poisoning every subsequent call.
  let persistSessionStateQueue: Promise<void> = Promise.resolve()
  let transcriptPruneQueue: Promise<void> = Promise.resolve()
  let shutdownPreservedSessionNames: Set<string> | null = null
  const persistedSessionNamesAwaitingDurableSnapshot = new Set(
    readSqlitePersistedSessionsState(sqliteDb).sessions.map((entry) => entry.name),
  )

  /**
   * A persisted row only becomes part of the authoritative in-memory snapshot
   * after the runtime can emit a durable provider snapshot for it. Mere map
   * hydration is insufficient: credential recovery can replace a resumable
   * session with a newly spawned process that has not emitted its provider
   * resume identifier yet. Until that transition becomes durable, the prior
   * row must survive snapshot writes.
   */
  function hasDurableRuntimeIdentity(entry: PersistedStreamSession): boolean {
    return Boolean(
      entry.daemonProcess
      || getProvider(entry.agentType)?.hasResumeIdentifier(entry),
    )
  }

  /**
   * Credential recovery is an explicit ownership handoff, not an ordinary
   * hydrated runtime. A restored recovery placeholder can carry the previous
   * provider's valid resume id while `lastTurnCompleted` is true, but that id
   * is still the fallback row being protected—not proof that the replacement
   * runtime owns a durable snapshot. Keep the row unclaimed until recovery
   * clears and the replacement independently satisfies the provider snapshot
   * contract.
   */
  function hasAuthoritativeDurableRuntimeIdentity(entry: PersistedStreamSession): boolean {
    return !entry.credentialPoolRecovery && hasDurableRuntimeIdentity(entry)
  }

  function claimDurablySnapshottedPersistedSessions(state: PersistedSessionsState): void {
    for (const entry of state.sessions) {
      if (hasAuthoritativeDurableRuntimeIdentity(entry)) {
        persistedSessionNamesAwaitingDurableSnapshot.delete(entry.name)
      }
    }
  }

  function claimCurrentDurableRuntimeIdentities(): void {
    for (const [sessionName, session] of sessions) {
      if (session.kind !== 'stream') continue
      // A raw provider identifier is not necessarily a resumable snapshot.
      // Claude, for example, exposes its session id during an active turn but
      // intentionally withholds that id from persistence until the turn
      // reaches a safe boundary. Claim ownership only through the provider's
      // snapshot contract so an interrupted recovery cannot discard the last
      // known-good row.
      const candidate = getProvider(session.agentType)?.snapshotForPersist(session)
      if (candidate && hasAuthoritativeDurableRuntimeIdentity(candidate)) {
        persistedSessionNamesAwaitingDurableSnapshot.delete(sessionName)
      }
    }
    for (const [sessionName, session] of exitedStreamSessions) {
      const candidate = {
        name: sessionName,
        agentType: session.agentType,
        mode: session.mode,
        cwd: session.cwd,
        createdAt: session.createdAt,
        providerContext: session.providerContext,
        credentialPoolRecovery: session.credentialPoolRecovery,
      } as PersistedStreamSession
      if (hasAuthoritativeDurableRuntimeIdentity(candidate)) {
        persistedSessionNamesAwaitingDurableSnapshot.delete(sessionName)
      }
    }
  }

  function isBenignPersistedSessionWriteError(error: unknown): boolean {
    const maybeNodeError = error as NodeJS.ErrnoException | null
    return maybeNodeError?.code === 'ENOENT'
      || (
        maybeNodeError?.code === 'ERR_INVALID_STATE'
        && typeof maybeNodeError.message === 'string'
        && maybeNodeError.message.includes('database is not open')
      )
  }

  function preservedSessionNamesForWrite(): Set<string> {
    const preserved = new Set(persistedSessionNamesAwaitingDurableSnapshot)
    for (const sessionName of shutdownPreservedSessionNames ?? []) {
      preserved.add(sessionName)
    }
    return preserved
  }

  function enqueuePersistedSessionsWrite(): void {
    persistSessionStateQueue = persistSessionStateQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          const state = serializePersistedSessionsStateForStore({ sessions, exitedStreamSessions })
          claimDurablySnapshottedPersistedSessions(state)
          writeSqlitePersistedSessionsState(sqliteDb, state, undefined, {
            preserveSessionNames: preservedSessionNamesForWrite(),
          })
        } catch (error) {
          // Test teardown and process shutdown can remove ephemeral data dirs
          // before this queued write drains. Treat that as a benign stop case.
          if (isBenignPersistedSessionWriteError(error)) {
            return
          }
          throw error
        }
      })
  }

  function schedulePersistedSessionsWrite(): void {
    if (shutdownPreservedSessionNames) {
      return
    }
    // Capture ownership at the lifecycle event, rather than only when the
    // queued write eventually runs. This keeps a rapid create/delete sequence
    // from reviving the pre-restore row.
    claimCurrentDurableRuntimeIdentities()
    enqueuePersistedSessionsWrite()
  }

  async function flushPersistedSessionsWrite(): Promise<void> {
    await Promise.all([
      persistSessionStateQueue.catch(() => undefined),
      transcriptPruneQueue.catch(() => undefined),
    ])
  }

  async function flushPersistedSessionsForShutdown(): Promise<void> {
    if (!shutdownPreservedSessionNames) {
      // SIGTERM is a process-lifecycle boundary, not a user deletion. systemd
      // can signal provider children at the same time as Herd, so exit handlers
      // may empty or replace the in-memory maps while an already-queued
      // snapshot is draining. Freeze every durable row that exists at shutdown
      // entry and make all pending/final writes non-destructive.
      shutdownPreservedSessionNames = new Set(
        readSqlitePersistedSessionsState(sqliteDb).sessions.map((entry) => entry.name),
      )
    }
    enqueuePersistedSessionsWrite()
    await flushPersistedSessionsWrite()
  }

  async function readPersistedSessionsState(): Promise<PersistedSessionsState> {
    return readSqlitePersistedSessionsState(sqliteDb)
  }

  async function restorePersistedSessions(): Promise<void> {
    const persisted = readSqlitePersistedSessionsState(sqliteDb)
    for (const entry of persisted.sessions) {
      if (!sessions.has(entry.name) && !exitedStreamSessions.has(entry.name)) {
        persistedSessionNamesAwaitingDurableSnapshot.add(entry.name)
      }
    }

    await restorePersistedSessionsFromStore({
      sessions,
      completedSessions,
      exitedStreamSessions,
      maxSessions,
      persistedState: persisted,
      machineRegistry,
      applyUsageEvent: applyStreamUsageEvent,
      restoreProviderSession,
      commanderLifecycleScope,
      shouldRestoreSession,
      shouldAutoRestoreSession,
      restoreCredentialPoolRecovery,
    })

    schedulePersistedSessionsWrite()
    await persistSessionStateQueue
  }

  function archivePersistedSession(sessionName: string, entry?: PersistedStreamSession): boolean {
    const archived = archiveSqliteRuntimeSession(sqliteDb, sessionName, entry)
    if (archived) {
      persistedSessionNamesAwaitingDurableSnapshot.delete(sessionName)
    }
    return archived
  }

  function scheduleTranscriptPrune(sessionName: string): void {
    transcriptPruneQueue = transcriptPruneQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await pruneSessionTranscript(sessionName, {
            maxTurns: RESTORED_REPLAY_TURN_LIMIT,
            maxEvents: MAX_STREAM_EVENTS,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[agents] Failed to prune transcript for "${sessionName}": ${message}`)
        }
      })
  }

  function getStaleCronSessionCandidates(nowMs: number = Date.now()): SessionPruneCandidate[] {
    const candidates: SessionPruneCandidate[] = []

    for (const [sessionName, session] of sessions) {
      if (session.kind !== 'stream') continue
      if (session.sessionType !== 'cron' && session.sessionType !== 'automation') continue
      if (!session.lastTurnCompleted || !session.finalResultEvent) continue

      const completedAtMs = Date.parse(session.completedTurnAt ?? session.createdAt)
      if (!Number.isFinite(completedAtMs)) continue
      const ageMs = nowMs - completedAtMs
      if (ageMs <= COMMAND_ROOM_COMPLETED_SESSION_TTL_MS) continue

      candidates.push({
        name: sessionName,
        sessionType: session.sessionType,
        creator: session.creator,
        lifecycle: 'completed',
        ageMs,
        reason: 'cron-completed-ttl',
      })
    }

    return candidates
  }

  function pruneStaleCronSessions(nowMs: number = Date.now()): number {
    const candidates = getStaleCronSessionCandidates(nowMs)
    if (candidates.length === 0) {
      return 0
    }

    for (const candidate of candidates) {
      const session = sessions.get(candidate.name)
      if (
        !session ||
        session.kind !== 'stream' ||
        (session.sessionType !== 'cron' && session.sessionType !== 'automation')
      ) {
        continue
      }

      for (const client of session.clients) {
        client.close(1000, 'Session ended')
      }
      if (getProvider(session.agentType)?.id === 'codex') {
        clearCodexTurnWatchdog(session)
        markCodexTurnHealthy(session)
      }
      void teardownProviderSession(session, 'Pruning stale automation session')
      sessions.delete(candidate.name)
      scheduleTranscriptPrune(candidate.name)
    }

    schedulePersistedSessionsWrite()
    return candidates.length
  }

  function resolveExitedSessionAgeStartAt(sessionName: string, session: ExitedStreamSessionState): number | null {
    const completedAt = completedSessions.get(sessionName)?.completedAt
    if (completedAt) {
      const completedAtMs = Date.parse(completedAt)
      if (Number.isFinite(completedAtMs)) {
        return completedAtMs
      }
    }

    const latestEvent = [...session.events]
      .reverse()
      .find((event) => typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)))
    if (latestEvent && typeof latestEvent.timestamp === 'string') {
      return Date.parse(latestEvent.timestamp)
    }

    const createdAtMs = Date.parse(session.createdAt)
    return Number.isFinite(createdAtMs) ? createdAtMs : null
  }

  function isCommanderWorkerSession(session: Pick<StreamSession | ExitedStreamSessionState, 'creator' | 'sessionType'>): boolean {
    return session.sessionType === 'worker' && session.creator.kind === 'commander'
  }

  function isCommanderConversationSession(session: Pick<StreamSession, 'creator' | 'sessionType' | 'conversationId'>): boolean {
    return session.sessionType === 'commander'
      && session.creator.kind === 'commander'
      && typeof session.conversationId === 'string'
      && session.conversationId.trim().length > 0
  }

  async function getStaleNonHumanSessionCandidates(
    config: SessionPrunerConfig,
    nowMs: number = Date.now(),
  ): Promise<SessionPruneCandidate[]> {
    if (!config.enabled) {
      return []
    }

    const candidates: SessionPruneCandidate[] = []

    for (const [sessionName, session] of sessions) {
      if (session.kind !== 'stream') continue
      if (session.creator.kind === 'human') continue
      if (session.clients.size > 0) continue
      if (isCommanderConversationSession(session)) continue

      const lifecycle = getWorldAgentStatus(session, nowMs)
      if (lifecycle === 'stale') {
        if (await isLiveSessionResumeAvailable(session)) continue

        const staleAtMs = Date.parse(session.lastEventAt ?? session.createdAt)
        if (!Number.isFinite(staleAtMs)) continue
        const ageMs = nowMs - staleAtMs
        if (ageMs <= config.staleSessionTtlMs) continue

        candidates.push({
          name: sessionName,
          sessionType: session.sessionType,
          creator: session.creator,
          lifecycle: 'stale',
          ageMs,
          reason: 'stale-non-human-ttl',
        })
        continue
      }

      if (lifecycle === 'completed') {
        const completedAtMs = Date.parse(session.completedTurnAt ?? session.createdAt)
        if (!Number.isFinite(completedAtMs)) continue
        const ageMs = nowMs - completedAtMs
        if (ageMs <= config.exitedSessionTtlMs) continue
        const isTeamWorker = isCommanderWorkerSession(session)
        if (!isTeamWorker && await isLiveSessionResumeAvailable(session)) continue

        candidates.push({
          name: sessionName,
          sessionType: session.sessionType,
          creator: session.creator,
          lifecycle: 'exited',
          ageMs,
          reason: isTeamWorker ? 'exited-commander-worker-ttl' : 'exited-non-human-ttl',
        })
      }
    }

    for (const [sessionName, session] of exitedStreamSessions) {
      if (session.creator.kind === 'human') continue

      const exitedAtMs = resolveExitedSessionAgeStartAt(sessionName, session)
      if (exitedAtMs === null || !Number.isFinite(exitedAtMs)) continue
      const ageMs = nowMs - exitedAtMs
      if (ageMs <= config.exitedSessionTtlMs) continue
      const isTeamWorker = isCommanderWorkerSession(session)
      if (!isTeamWorker) {
        const persistedEntry = buildPersistedEntryFromExitedSession(sessionName, session)
        if (await isExitedSessionResumeAvailable(persistedEntry)) continue
      }

      candidates.push({
        name: sessionName,
        sessionType: session.sessionType,
        creator: session.creator,
        lifecycle: 'exited',
        ageMs,
        reason: isTeamWorker ? 'exited-commander-worker-ttl' : 'exited-non-human-ttl',
      })
    }

    return candidates
  }

  async function pruneStaleNonHumanSessions(
    config: SessionPrunerConfig,
    nowMs: number = Date.now(),
  ): Promise<number> {
    const candidates = await getStaleNonHumanSessionCandidates(config, nowMs)
    if (candidates.length === 0) {
      return 0
    }

    for (const candidate of candidates) {
      const liveSession = sessions.get(candidate.name)
      if (liveSession?.kind === 'stream') {
        for (const client of liveSession.clients) {
          client.close(1000, 'Session pruned')
        }
        if (getProvider(liveSession.agentType)?.id === 'codex') {
          clearCodexTurnWatchdog(liveSession)
          markCodexTurnHealthy(liveSession)
        }
        await teardownProviderSession(liveSession, 'Pruning stale non-human session')
        sessions.delete(candidate.name)
        scheduleTranscriptPrune(candidate.name)
        continue
      }

      if (exitedStreamSessions.has(candidate.name)) {
        exitedStreamSessions.delete(candidate.name)
        completedSessions.delete(candidate.name)
        scheduleTranscriptPrune(candidate.name)
      }
    }

    schedulePersistedSessionsWrite()
    return candidates.length
  }

  return {
    schedulePersistedSessionsWrite,
    flushPersistedSessionsWrite,
    flushPersistedSessionsForShutdown,
    readPersistedSessionsState,
    restorePersistedSessions,
    archivePersistedSession,
    getStaleCronSessionCandidates,
    pruneStaleCronSessions,
    pruneStaleCommandRoomSessions: pruneStaleCronSessions,
    getStaleNonHumanSessionCandidates,
    pruneStaleNonHumanSessions,
  }
}
