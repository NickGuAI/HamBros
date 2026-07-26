import type { DatabaseSync } from 'node:sqlite'
import { isClaudeAdaptiveThinkingMode } from '../../claude-adaptive-thinking.js'
import { isClaudeMaxThinkingTokens } from '../../claude-max-thinking-tokens.js'
import { parseStoredAgentEffort } from '../effort.js'
import type {
  AgentType,
  ClaudePermissionMode,
  CredentialPoolRecoveryRequest,
  PersistedDaemonProcess,
  PersistedSessionsState,
  PersistedStreamSession,
  SessionCreator,
  SessionTransportType,
  SessionType,
  StreamJsonEvent,
} from '../types.js'
import type { ProviderSessionContext } from '../providers/provider-session-context.js'
import { parseProviderId } from '../providers/registry.js'
import { parseActiveSkillInvocation } from './input.js'

type RuntimeRow = {
  name: string
  session_type: string
  creator_kind: string
  creator_id: string | null
  conversation_id: string | null
  spawned_by: string | null
  transport_type: string
  machine_id: string
  state: 'active' | 'paused' | 'archived'
  provider: string
  provider_resume_json: string
  runtime_state_json: string
  cwd: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

type ParsedProviderResume = {
  providerContext: ProviderSessionContext
  daemonProcess?: PersistedDaemonProcess
}

type RuntimeStatePayload = Partial<Pick<
  PersistedStreamSession,
  | 'mode'
  | 'model'
  | 'resumedFrom'
  | 'spawnedWorkers'
  | 'hadResult'
  | 'credentialPoolId'
  | 'credentialPoolRecovery'
  | 'activeTurnId'
  | 'conversationEntryCount'
  | 'approvalBridgeNonce'
  | 'currentSkillInvocation'
  | 'queuedMessages'
  | 'currentQueuedMessage'
  | 'pendingDirectSendMessages'
  | 'activeTurnMessage'
  | 'events'
>>

const RUNTIME_EVENTS_JSON_FRAGMENT = ',"events":'
const RUNTIME_EVENTS_JSON_ONLY_PREFIX = '{"events":'
const LEGACY_RUNTIME_EVENTS_STRIP_THRESHOLD_BYTES = 2 * 1024 * 1024
const MAX_RUNTIME_STATE_EMBEDDED_EVENTS = 100
const MAX_RUNTIME_STATE_EMBEDDED_EVENTS_BYTES = 512 * 1024

function isSessionType(value: string): value is SessionType {
  return value === 'commander'
    || value === 'worker'
    || value === 'cron'
    || value === 'sentinel'
    || value === 'automation'
}

function isCreatorKind(value: string): value is SessionCreator['kind'] {
  return value === 'human'
    || value === 'commander'
    || value === 'cron'
    || value === 'sentinel'
    || value === 'automation'
}

function isTransportType(value: string): value is SessionTransportType {
  return value === 'stream' || value === 'pty' || value === 'external'
}

function isPermissionMode(value: unknown): value is ClaudePermissionMode {
  return value === 'default' || value === 'acceptEdits' || value === 'bypassPermissions'
}

function optionalString(value: string | null): string | undefined {
  return value && value.trim().length > 0 ? value : undefined
}

function parseDaemonProcess(value: unknown): PersistedDaemonProcess | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.processId !== 'string'
    || !record.processId.trim()
    || (record.mode !== 'pipe' && record.mode !== 'pty')
  ) {
    return undefined
  }
  return {
    processId: record.processId.trim(),
    mode: record.mode,
  }
}

function parseProviderResumeJson(value: string, provider: AgentType): ParsedProviderResume | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const parsedRecord = parsed as Record<string, unknown>
      const payload: Record<string, unknown> = {
        providerId: provider,
        ...parsedRecord,
      }
      const daemonProcess = parseDaemonProcess(payload.daemonProcess)
      const providerPayload = { ...payload }
      delete providerPayload.daemonProcess
      return {
        providerContext: providerPayload as unknown as ProviderSessionContext,
        ...(daemonProcess ? { daemonProcess } : {}),
      }
    }
  } catch {
    return null
  }
  return null
}

function parseRuntimeStateJson(value: string): RuntimeStatePayload {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as RuntimeStatePayload
    }
  } catch {
    return {}
  }
  return {}
}

function serializedJsonLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized.length : null
  } catch {
    return null
  }
}

function compactRuntimeStateEvents(
  events: PersistedStreamSession['events'],
): StreamJsonEvent[] | undefined {
  if (!events || events.length === 0) {
    return undefined
  }

  const selected: StreamJsonEvent[] = []
  let totalLength = 2
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_RUNTIME_STATE_EMBEDDED_EVENTS) {
      break
    }

    const event = events[index]
    const eventLength = serializedJsonLength(event)
    if (eventLength === null) {
      continue
    }

    const nextLength = totalLength + eventLength + (selected.length > 0 ? 1 : 0)
    if (nextLength > MAX_RUNTIME_STATE_EMBEDDED_EVENTS_BYTES) {
      if (selected.length > 0) {
        break
      }
      continue
    }

    selected.unshift(event)
    totalLength = nextLength
  }

  return selected.length > 0 ? selected : undefined
}

function parseSpawnedWorkers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function parseQueuedMessages(
  value: unknown,
): PersistedStreamSession['queuedMessages'] {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.filter((item): item is NonNullable<PersistedStreamSession['queuedMessages']>[number] => {
    if (typeof item !== 'object' || item === null) {
      return false
    }
    const record = item as Record<string, unknown>
    return typeof record.id === 'string'
      && typeof record.text === 'string'
      && typeof record.queuedAt === 'string'
      && (record.priority === 'high' || record.priority === 'normal' || record.priority === 'low')
  })
}

function parseCurrentQueuedMessage(value: unknown): PersistedStreamSession['currentQueuedMessage'] {
  const parsed = parseQueuedMessages([value])
  return parsed?.[0]
}

function parseCredentialPoolRecoveryRequest(value: unknown): CredentialPoolRecoveryRequest | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const parsedProvider = parseProviderId(record.provider)
  const provider = parsedProvider === 'claude' || parsedProvider === 'codex'
    ? parsedProvider
    : undefined
  const reason = record.reason === 'auth_required'
    || record.reason === 'manual_switch'
    || record.reason === 'quota_threshold'
    || record.reason === 'usage_limit'
    ? record.reason
    : undefined
  const requestedAt = parseOptionalNonEmptyString(record.requestedAt)
  if (!provider || !reason || !requestedAt) {
    return undefined
  }

  const interruptedMessage = parseCurrentQueuedMessage(record.interruptedMessage)
  const credentialPoolId = parseOptionalNonEmptyString(record.credentialPoolId)
  const previousCredentialPoolId = parseOptionalNonEmptyString(record.previousCredentialPoolId)
  const resetAt = parseOptionalNonEmptyString(record.resetAt)
  const failureCode = parseOptionalNonEmptyString(record.failureCode)
  const failureReason = parseOptionalNonEmptyString(record.failureReason)
  const blockedUntil = parseOptionalNonEmptyString(record.blockedUntil)
  const interruptedTurnId = parseOptionalNonEmptyString(record.interruptedTurnId)
  const state = record.state === 'awaiting_safe_boundary'
    || record.state === 'stopping_old_runtime'
    || record.state === 'activating_credential'
    || record.state === 'reloading_session'
    || record.state === 'retry_scheduled'
    || record.state === 'blocked'
    ? record.state
    : blockedUntil
      ? 'blocked'
      : credentialPoolId
        ? 'reloading_session'
        : 'awaiting_safe_boundary'
  return {
    provider,
    ...(credentialPoolId ? { credentialPoolId } : {}),
    ...(previousCredentialPoolId ? { previousCredentialPoolId } : {}),
    clearResumeProviderContext: record.clearResumeProviderContext !== false,
    reason,
    requestedAt,
    state,
    ...(failureCode ? { failureCode } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...(blockedUntil ? { blockedUntil } : {}),
    ...(interruptedMessage ? { interruptedMessage } : {}),
    ...(typeof record.interruptedTurnHadSideEffects === 'boolean'
      ? { interruptedTurnHadSideEffects: record.interruptedTurnHadSideEffects }
      : {}),
    ...(interruptedTurnId ? { interruptedTurnId } : {}),
  }
}

function parseReplayEvents(value: unknown): StreamJsonEvent[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const events = value.filter((item): item is StreamJsonEvent => typeof item === 'object' && item !== null)
  return events.length > 0 ? events : undefined
}

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function parseOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function readRuntimeOptions(
  agentType: AgentType,
  providerContext: ProviderSessionContext,
): Pick<PersistedStreamSession, 'effort' | 'adaptiveThinking' | 'maxThinkingTokens'> {
  const record = providerContext as unknown as Record<string, unknown>
  const effort = parseStoredAgentEffort(agentType, record.effort)
  return {
    ...(effort ? { effort } : {}),
    ...(agentType === 'claude' && isClaudeAdaptiveThinkingMode(record.adaptiveThinking)
      ? { adaptiveThinking: record.adaptiveThinking }
      : {}),
    ...(agentType === 'claude' && isClaudeMaxThinkingTokens(record.maxThinkingTokens)
      ? { maxThinkingTokens: record.maxThinkingTokens }
      : {}),
  }
}

function buildRuntimeStatePayload(entry: PersistedStreamSession): RuntimeStatePayload {
  const events = compactRuntimeStateEvents(entry.events)
  return {
    mode: entry.mode,
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.resumedFrom ? { resumedFrom: entry.resumedFrom } : {}),
    ...(entry.spawnedWorkers && entry.spawnedWorkers.length > 0 ? { spawnedWorkers: entry.spawnedWorkers } : {}),
    ...(entry.hadResult !== undefined ? { hadResult: entry.hadResult } : {}),
    ...(entry.credentialPoolId ? { credentialPoolId: entry.credentialPoolId } : {}),
    ...(entry.credentialPoolRecovery ? { credentialPoolRecovery: entry.credentialPoolRecovery } : {}),
    ...(entry.activeTurnId ? { activeTurnId: entry.activeTurnId } : {}),
    ...(entry.conversationEntryCount !== undefined ? { conversationEntryCount: entry.conversationEntryCount } : {}),
    ...(entry.approvalBridgeNonce ? { approvalBridgeNonce: entry.approvalBridgeNonce } : {}),
    ...(entry.currentSkillInvocation ? { currentSkillInvocation: entry.currentSkillInvocation } : {}),
    ...(entry.queuedMessages && entry.queuedMessages.length > 0 ? { queuedMessages: entry.queuedMessages } : {}),
    ...(entry.currentQueuedMessage ? { currentQueuedMessage: entry.currentQueuedMessage } : {}),
    ...(entry.pendingDirectSendMessages && entry.pendingDirectSendMessages.length > 0
      ? { pendingDirectSendMessages: entry.pendingDirectSendMessages }
      : {}),
    ...(entry.activeTurnMessage ? { activeTurnMessage: entry.activeTurnMessage } : {}),
    ...(events ? { events } : {}),
  }
}

function rowToPersistedStreamSession(row: RuntimeRow): PersistedStreamSession | null {
  if (!isSessionType(row.session_type) || !isCreatorKind(row.creator_kind)) {
    return null
  }
  const agentType = parseProviderId(row.provider)
  if (!agentType) {
    return null
  }
  const providerContext = parseProviderResumeJson(row.provider_resume_json, agentType)
  if (!providerContext) {
    return null
  }
  const runtimeState = parseRuntimeStateJson(row.runtime_state_json)
  const mode = isPermissionMode(runtimeState.mode) ? runtimeState.mode : 'default'
  const queuedMessages = parseQueuedMessages(runtimeState.queuedMessages)
  const currentQueuedMessage = parseCurrentQueuedMessage(runtimeState.currentQueuedMessage)
  const pendingDirectSendMessages = parseQueuedMessages(runtimeState.pendingDirectSendMessages)
  const activeTurnMessage = parseCurrentQueuedMessage(runtimeState.activeTurnMessage)
  const resumedFrom = parseOptionalNonEmptyString(runtimeState.resumedFrom)
  const activeTurnId = parseOptionalNonEmptyString(runtimeState.activeTurnId)
  const credentialPoolId = parseOptionalNonEmptyString(runtimeState.credentialPoolId)
  const credentialPoolRecovery = parseCredentialPoolRecoveryRequest(runtimeState.credentialPoolRecovery)
  const approvalBridgeNonce = parseOptionalNonEmptyString(runtimeState.approvalBridgeNonce)
  const conversationEntryCount = parseOptionalFiniteNumber(runtimeState.conversationEntryCount)
  const currentSkillInvocation = parseActiveSkillInvocation(runtimeState.currentSkillInvocation)
  const events = parseReplayEvents(runtimeState.events)
  const runtimeOptions = readRuntimeOptions(agentType, providerContext.providerContext)

  return {
    name: row.name,
    sessionType: row.session_type,
    creator: {
      kind: row.creator_kind,
      ...(row.creator_id ? { id: row.creator_id } : {}),
    },
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    transportType: isTransportType(row.transport_type) ? row.transport_type : 'stream',
    agentType,
    ...(typeof runtimeState.model === 'string' && runtimeState.model.trim().length > 0
      ? { model: runtimeState.model.trim() }
      : {}),
    ...runtimeOptions,
    mode,
    cwd: row.cwd,
    ...(row.machine_id && row.machine_id !== 'local' ? { host: row.machine_id } : {}),
    createdAt: row.created_at,
    providerContext: providerContext.providerContext,
    ...(credentialPoolId ? { credentialPoolId } : {}),
    ...(credentialPoolRecovery ? { credentialPoolRecovery } : {}),
    ...(providerContext.daemonProcess ? { daemonProcess: providerContext.daemonProcess } : {}),
    ...(row.spawned_by ? { spawnedBy: row.spawned_by } : {}),
    ...(resumedFrom ? { resumedFrom } : {}),
    spawnedWorkers: parseSpawnedWorkers(runtimeState.spawnedWorkers),
    sessionState: row.state === 'paused' ? 'exited' : 'active',
    hadResult: runtimeState.hadResult === true,
    ...(activeTurnId ? { activeTurnId } : {}),
    ...(conversationEntryCount !== undefined ? { conversationEntryCount } : {}),
    ...(approvalBridgeNonce ? { approvalBridgeNonce } : {}),
    ...(currentSkillInvocation ? { currentSkillInvocation } : {}),
    ...(queuedMessages ? { queuedMessages } : {}),
    ...(currentQueuedMessage ? { currentQueuedMessage } : {}),
    ...(pendingDirectSendMessages ? { pendingDirectSendMessages } : {}),
    ...(activeTurnMessage ? { activeTurnMessage } : {}),
    ...(events ? { events } : {}),
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function providerResumePayload(entry: PersistedStreamSession): unknown {
  return {
    ...entry.providerContext as unknown as Record<string, unknown>,
    ...(entry.daemonProcess ? { daemonProcess: entry.daemonProcess } : {}),
  }
}

function stateForPersistedEntry(entry: PersistedStreamSession): 'active' | 'paused' {
  return entry.sessionState === 'exited' ? 'paused' : 'active'
}

function transportTypeForPersistedEntry(entry: PersistedStreamSession): SessionTransportType {
  return entry.transportType ?? 'stream'
}

function assertPersistableEntry(entry: PersistedStreamSession): asserts entry is PersistedStreamSession & {
  sessionType: SessionType
  creator: SessionCreator
} {
  if (!entry.sessionType || !entry.creator) {
    throw new Error(`Runtime session "${entry.name}" is missing sessionType or creator`)
  }
}

export function readSqlitePersistedSessionsState(db: DatabaseSync): PersistedSessionsState {
  const rows = db.prepare(
    `SELECT
       name,
       session_type,
       creator_kind,
       creator_id,
       conversation_id,
       spawned_by,
       transport_type,
       machine_id,
       state,
       provider,
       provider_resume_json,
       CASE
         WHEN length(runtime_state_json) > ?
          AND instr(runtime_state_json, ?) > 0
         THEN substr(runtime_state_json, 1, instr(runtime_state_json, ?) - 1) || '}'
         WHEN length(runtime_state_json) > ?
          AND instr(runtime_state_json, ?) = 1
         THEN '{}'
         ELSE runtime_state_json
       END AS runtime_state_json,
       cwd,
       created_at,
       updated_at,
       archived_at
     FROM agent_runtime_sessions
     WHERE state <> 'archived'
     ORDER BY name ASC`,
  ).all(
    LEGACY_RUNTIME_EVENTS_STRIP_THRESHOLD_BYTES,
    RUNTIME_EVENTS_JSON_FRAGMENT,
    RUNTIME_EVENTS_JSON_FRAGMENT,
    LEGACY_RUNTIME_EVENTS_STRIP_THRESHOLD_BYTES,
    RUNTIME_EVENTS_JSON_ONLY_PREFIX,
  ) as RuntimeRow[]

  return {
    sessions: rows
      .map((row) => rowToPersistedStreamSession(row))
      .filter((entry): entry is PersistedStreamSession => entry !== null),
  }
}

export function writeSqlitePersistedSessionsState(
  db: DatabaseSync,
  payload: PersistedSessionsState,
  now: string = new Date().toISOString(),
  options: {
    /**
     * Rows that are durable but not represented by the caller's authoritative
     * in-memory snapshot yet. They remain untouched until the runtime claims
     * them or explicitly archives them.
     */
    preserveSessionNames?: Iterable<string>
  } = {},
): void {
  const names = new Set<string>()
  db.exec('BEGIN IMMEDIATE')
  try {
    const upsert = db.prepare(
      `INSERT INTO agent_runtime_sessions (
         name,
         session_type,
         creator_kind,
         creator_id,
         conversation_id,
         spawned_by,
         transport_type,
         machine_id,
         state,
         provider,
         provider_resume_json,
         runtime_state_json,
         cwd,
         created_at,
         updated_at,
         archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(name) DO UPDATE SET
         session_type = excluded.session_type,
         creator_kind = excluded.creator_kind,
         creator_id = excluded.creator_id,
         conversation_id = excluded.conversation_id,
         spawned_by = excluded.spawned_by,
         transport_type = excluded.transport_type,
         machine_id = excluded.machine_id,
         state = excluded.state,
         provider = excluded.provider,
         provider_resume_json = excluded.provider_resume_json,
         runtime_state_json = excluded.runtime_state_json,
         cwd = excluded.cwd,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         archived_at = NULL`,
    )

    for (const entry of payload.sessions) {
      assertPersistableEntry(entry)
      names.add(entry.name)
      upsert.run(
        entry.name,
        entry.sessionType,
        entry.creator.kind,
        entry.creator.id ?? null,
        optionalString(entry.conversationId ?? null) ?? null,
        optionalString(entry.spawnedBy ?? null) ?? null,
        transportTypeForPersistedEntry(entry),
        entry.host ?? 'local',
        stateForPersistedEntry(entry),
        entry.agentType,
        json(providerResumePayload(entry)),
        json(buildRuntimeStatePayload(entry)),
        entry.cwd,
        entry.createdAt,
        now,
      )
    }

    for (const sessionName of options.preserveSessionNames ?? []) {
      if (sessionName.trim()) {
        names.add(sessionName)
      }
    }

    if (names.size === 0) {
      db.prepare("DELETE FROM agent_runtime_sessions WHERE state <> 'archived'").run()
    } else {
      const placeholders = [...names].map(() => '?').join(', ')
      db.prepare(
        `DELETE FROM agent_runtime_sessions
         WHERE state <> 'archived'
           AND name NOT IN (${placeholders})`,
      ).run(...names)
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function archiveSqliteRuntimeSession(
  db: DatabaseSync,
  sessionName: string,
  entry?: PersistedStreamSession,
  now: string = new Date().toISOString(),
): boolean {
  const result = db.prepare(
    `UPDATE agent_runtime_sessions
     SET state = 'archived',
         updated_at = ?,
         archived_at = COALESCE(archived_at, ?)
     WHERE name = ?`,
  ).run(now, now, sessionName)
  if (result.changes > 0 || !entry) {
    return result.changes > 0
  }

  assertPersistableEntry(entry)
  db.prepare(
    `INSERT INTO agent_runtime_sessions (
       name,
       session_type,
       creator_kind,
       creator_id,
       conversation_id,
       spawned_by,
       transport_type,
       machine_id,
       state,
       provider,
       provider_resume_json,
       runtime_state_json,
       cwd,
       created_at,
       updated_at,
       archived_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'archived', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionName,
    entry.sessionType,
    entry.creator.kind,
    entry.creator.id ?? null,
    optionalString(entry.conversationId ?? null) ?? null,
    optionalString(entry.spawnedBy ?? null) ?? null,
    transportTypeForPersistedEntry(entry),
    entry.host ?? 'local',
    entry.agentType,
    json(providerResumePayload(entry)),
    json(buildRuntimeStatePayload(entry)),
    entry.cwd,
    entry.createdAt,
    now,
    now,
  )
  return true
}
