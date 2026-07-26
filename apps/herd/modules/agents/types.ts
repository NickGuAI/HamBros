import type { ChildProcess } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthUser } from '@gehirn/auth-providers'
import type { Router } from 'express'
import type { WebSocket } from 'ws'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import type { HerdEvent, PlanApprovalDecision } from '../../src/types/herd-events.js'
import type { TranscriptEnvelope } from '../../src/types/transcript-envelope.js'
import type { ActionPolicyGate } from '../policies/action-policy-gate.js'
import type { ApprovalBridgeTokenClaims } from '../policies/approval-bridge-token.js'
import type { WorkspaceResolverCapability } from '../workspace/capability.js'
import type { QueuedMessage, QueuedMessageImage, SessionMessageQueue } from './message-queue.js'
import type {
  ClaudeAdaptiveThinkingMode,
} from '../claude-adaptive-thinking.js'
import type { ClaudeMaxThinkingTokens } from '../claude-max-thinking-tokens.js'
import type { AgentEffortLevel } from './effort.js'
import type { QuestStore } from '../commanders/quest-store.js'
import type { CommanderSessionStore } from '../commanders/store.js'
import type { ConversationStore } from '../commanders/conversation-store.js'
import type { CommanderSessionSeedParams } from '../commanders/memory/module.js'
import type { GeminiTurnState } from './event-normalizers/gemini.js'
import type { OpenCodeTurnState } from './event-normalizers/opencode.js'
import type { ProviderId } from './adapters/provider-registry-types.js'
import type { ProviderSessionContext } from './providers/provider-session-context.js'
import type { ProviderProcessTree } from './provider-process.js'
import type { ClaudeQuotaReader } from './claude-credential-coordinator.js'
import type {
  ClaudeAccountIdentityResolver,
  ClaudeGlobalAuthValidator,
  CredentialPoolProvider,
  CredentialPoolRuntimeMode,
  ProviderAuthSnapshot,
  ProviderAuthStore,
  ProviderSpawnAuth,
} from './provider-auth.js'

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

export type AgentType = ProviderId
export type SessionType = 'commander' | 'worker' | 'cron' | 'sentinel' | 'automation'
export type SessionTransportType = 'pty' | 'stream' | 'external'
export type MachineTransportType = 'local' | 'ssh' | 'daemon'
export type SessionCreatorKind = 'human' | 'commander' | 'cron' | 'sentinel' | 'automation'

export interface SessionCreator {
  kind: SessionCreatorKind
  id?: string
}

export type CredentialPoolRecoveryState =
  | 'awaiting_safe_boundary'
  | 'stopping_old_runtime'
  | 'activating_credential'
  | 'reloading_session'
  | 'retry_scheduled'
  | 'blocked'

export interface CredentialPoolRecoveryRequest {
  provider: CredentialPoolProvider
  credentialPoolId?: string
  previousCredentialPoolId?: string
  clearResumeProviderContext: boolean
  reason: 'auth_required' | 'manual_switch' | 'quota_threshold' | 'usage_limit'
  requestedAt: string
  state?: CredentialPoolRecoveryState
  failureCode?: string
  failureReason?: string
  resetAt?: string
  blockedUntil?: string
  interruptedMessage?: QueuedMessage
  interruptedTurnHadSideEffects?: boolean
  interruptedTurnId?: string
}

export type AgentSessionProcessState = 'running' | 'exited' | 'none'
export type AgentSessionTurnState = 'idle' | 'running' | 'blocked' | 'stale' | 'completed'
export type AgentSessionConnectionState = 'connected' | 'disconnected' | 'not_applicable'
export type AgentSessionResumeState = 'available' | 'unavailable'

export interface AgentSessionCredentialPoolAttribution {
  provider: 'claude' | 'codex'
  id: string
  label: string
  mode?: CredentialPoolRuntimeMode
}

export interface AgentSession {
  name: string
  label?: string
  created: string
  lastActivityAt?: string
  pid: number
  state?: AgentRuntimeSessionState
  machine?: AgentRuntimeSessionMachine
  allowedActions?: AgentRuntimeSessionAllowedActions
  disabledReasons?: AgentRuntimeSessionDisabledReasons
  sessionType?: SessionType
  transportType?: SessionTransportType
  agentType?: AgentType
  mode?: ClaudePermissionMode
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  model?: string
  cwd?: string
  host?: string
  creator?: SessionCreator
  conversationId?: string
  spawnedBy?: string
  spawnedWorkers?: string[]
  workerSummary?: WorkerSummary
  processState?: AgentSessionProcessState
  turnState?: AgentSessionTurnState
  connectionState?: AgentSessionConnectionState
  resumeState?: AgentSessionResumeState
  processAlive?: boolean
  hadResult?: boolean
  resumedFrom?: string
  status?: 'active' | 'idle' | 'stale' | 'completed' | 'exited'
  resumeAvailable?: boolean
  queuedMessageCount?: number
  credentialPoolId?: string
  credentialPool?: AgentSessionCredentialPoolAttribution
  credentialPoolMode?: CredentialPoolRuntimeMode
}

export type WorldAgentStatus = 'active' | 'idle' | 'stale' | 'completed'
export type WorldAgentPhase = 'idle' | 'thinking' | 'tool_use' | 'blocked' | 'stale' | 'completed'
export type WorldAgentRole = 'commander' | 'worker'

export interface WorldAgent {
  id: string
  agentType: AgentType
  transportType: SessionTransportType
  status: WorldAgentStatus
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  task: string
  phase: WorldAgentPhase
  lastToolUse: string | null
  lastUpdatedAt: string
  role: WorldAgentRole
}

export type AgentRuntimeSessionState = 'active' | 'paused' | 'archived'
export type AgentRuntimeSessionAction = 'send' | 'pause' | 'resume' | 'archive' | 'start'
export type AgentRuntimeSessionAllowedActions = Record<AgentRuntimeSessionAction, boolean>
export type AgentRuntimeSessionDisabledReasons = Record<AgentRuntimeSessionAction, string | null>

export interface AgentRuntimeSessionMachine {
  id: string
  label: string
  known: boolean
  transportType: MachineTransportType
  launchable: boolean
  disabledReason: string | null
}

export interface PtyHandle {
  onData(cb: (data: string) => void): { dispose(): void }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pid: number
}

export interface PtySpawner {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: NodeJS.ProcessEnv
    },
  ): PtyHandle
}

export interface PtySession {
  kind: 'pty'
  name: string
  sessionType: SessionType
  creator: SessionCreator
  agentType: AgentType
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  cwd: string
  host?: string
  task?: string
  pty: PtyHandle
  buffer: string
  clients: Set<WebSocket>
  createdAt: string
  lastEventAt: string
  approvalBridgeNonce?: string
}

export type StreamJsonEvent = HerdEvent | TranscriptEnvelope

export type CodexApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'item/mcpToolCall/requestApproval'
  | 'item/rules/requestApproval'
  | 'item/skill/requestApproval'
export type CodexApprovalDecision = 'accept' | 'decline' | 'cancel'

export interface CodexPendingApprovalRequest {
  requestId: number
  method: CodexApprovalMethod
  threadId: string
  itemId?: string
  turnId?: string
  cwd?: string
  reason?: string
  risk?: string
  permissions?: unknown
  requestedAt: string
}

export interface CodexProtocolMessage {
  method: string
  params: unknown
  requestId?: number
}

export interface CodexRuntimeTerminalFailure {
  reason: string
  exitCode?: number
  signal?: string
}

export type CodexRuntimeFailure =
  | { kind: 'transport_disconnect'; reason: string }
  | ({ kind: 'terminal' } & CodexRuntimeTerminalFailure)

export interface CodexSessionRuntimeHandle {
  process: ChildProcess | null
  ensureConnected(): Promise<void>
  sendRequest(method: string, params: unknown): Promise<unknown>
  sendResponse(id: number, result: unknown): void
  getTerminalFailure(): CodexRuntimeTerminalFailure | null
  waitForTerminalFailure(timeoutMs: number): Promise<CodexRuntimeTerminalFailure | null>
  addNotificationListener(threadId: string, cb: (message: CodexProtocolMessage) => void): () => void
  log(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void
  teardown(options?: { threadId?: string; reason?: string; timeoutMs?: number; archive?: boolean }): Promise<void>
  teardownOnProcessExit(): void
}

export interface GeminiAcpRuntimeHandle {
  process: ChildProcess | null
  ensureConnected(): Promise<void>
  sendRequest(method: string, params: unknown): Promise<unknown>
  sendNotification(method: string, params: unknown): void
  sendResponse(id: number | string, result: unknown): void
  addNotificationListener(sessionId: string, cb: (message: GeminiProtocolMessage) => void): () => void
  teardown(options?: { reason?: string; timeoutMs?: number }): Promise<void>
  teardownOnProcessExit(): void
}

export interface GeminiProtocolMessage {
  method: string
  params: unknown
  requestId?: number | string
}

export interface OpenCodeAcpRuntimeHandle {
  process: ChildProcess | null
  ensureConnected(): Promise<void>
  sendRequest(method: string, params: unknown): Promise<unknown>
  sendNotification(method: string, params: unknown): void
  sendResponse(id: number | string, result: unknown): void
  addNotificationListener(sessionId: string, cb: (message: OpenCodeProtocolMessage) => void): () => void
  teardown(options?: { reason?: string; timeoutMs?: number }): Promise<void>
  teardownOnProcessExit(): void
}

export interface OpenCodeProtocolMessage {
  method: string
  params: unknown
  requestId?: number | string
}

export type StreamDispatchMode = 'live' | 'queue'

export type StreamDispatchResult =
  | { ok: true; delivered: 'live' }
  | { ok: true; delivered: 'queued'; message: QueuedMessage; position: number }
  | { ok: false; retryable: boolean; reason: string }

export interface SessionSendPayload {
  text: string
  displayText?: string
  images?: QueuedMessageImage[]
  clientSendId?: string
  userEventSubtype?: string
}

export type SessionSendIntent = 'interrupt' | 'queue'
export type SessionSendDisposition = 'started' | 'interrupted' | 'queued'
export type SessionSendResult =
  | { ok: true; disposition: SessionSendDisposition }
  | { ok: false; code: 'session_unavailable' | 'interrupt_unavailable' | 'credential_recovery_failed' | 'queue_rejected'; error: string; retryable: boolean }

export interface StreamDispatchOptions {
  userEventSubtype?: string
  displayText?: string
  clientSendId?: string
}

export interface StreamSessionAdapter {
  dispatchSend(
    session: StreamSession,
    text: string,
    mode: StreamDispatchMode,
    images?: QueuedMessageImage[],
    options?: StreamDispatchOptions,
  ): Promise<StreamDispatchResult>
}

export interface PromptAudit {
  transport: 'append-system-prompt-file'
  source: 'herd-commander-bootstrap'
  byteLength: number
  tokenEstimate: number
  maxBytes: number
  sections: string[]
}

export interface StreamSession {
  kind: 'stream'
  name: string
  sessionType: SessionType
  creator: SessionCreator
  conversationId?: string
  agentType: AgentType
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  mode: ClaudePermissionMode
  cwd: string
  host?: string
  /**
   * Canonical active-skill trust context for this session. Worker dispatch
   * inherits this object by default, can override it explicitly, or can clear
   * it with an explicit `null` payload. Approval policy reads this field
   * directly instead of inferring trust from session lineage or names.
   */
  currentSkillInvocation?: ActiveSkillInvocation
  spawnedBy?: string
  spawnedWorkers: string[]
  task?: string
  process: ChildProcess
  processTree?: ProviderProcessTree
  cleanupProcessResources?: () => void
  events: StreamJsonEvent[]
  nextEventSeq?: number
  clients: Set<WebSocket>
  createdAt: string
  lastEventAt: string
  systemPrompt?: string
  promptAudit?: PromptAudit
  maxTurns?: number
  model?: string
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  stdoutBuffer: string
  lastStderrSummary?: string
  stdinDraining: boolean
  lastTurnCompleted: boolean
  completedTurnAt?: string
  providerContext: ProviderSessionContext
  providerAuthSnapshot?: ProviderAuthSnapshot
  credentialPoolId?: string
  credentialPoolMode?: CredentialPoolRuntimeMode
  credentialPoolRecovery?: CredentialPoolRecoveryRequest
  gaiaOpsApiKeyExpiresAt?: string
  approvalBridgeNonce?: string
  activeTurnId?: string
  resumedFrom?: string
  finalResultEvent?: StreamJsonEvent
  conversationEntryCount: number
  autoRotatePending: boolean
  codexTurnWatchdogTimer?: NodeJS.Timeout
  codexTurnStaleAt?: string
  codexLastIncomingMethod?: string
  codexLastIncomingAt?: string
  codexUnclassifiedIncomingCount: number
  codexPendingApprovals: Map<number, CodexPendingApprovalRequest>
  codexDispatchInFlight?: boolean
  messageQueue: SessionMessageQueue
  currentQueuedMessage?: QueuedMessage
  pendingDirectSendMessages: QueuedMessage[]
  /** Accepted live input for the active turn. This is recovery state, not queue state. */
  activeTurnMessage?: QueuedMessage
  queuedMessageRetryTimer?: NodeJS.Timeout
  queuedMessageRetryMessageId?: string
  queuedMessageRetryDelayMs: number
  queuedMessageDrainScheduled: boolean
  queuedMessageDrainPending: boolean
  queuedMessageDrainPendingForce: boolean
  geminiPendingSystemPrompt?: string
  geminiTurnState?: GeminiTurnState
  geminiToolCallSnapshots?: Map<string, Record<string, unknown>>
  opencodePendingSystemPrompt?: string
  opencodeTurnState?: OpenCodeTurnState
  opencodeToolCallSnapshots?: Map<string, Record<string, unknown>>
  adapter?: StreamSessionAdapter
  /** True when this session was spawned during restore with no new task.
   * Used to skip the persist-write on exit so the file is not overwritten
   * with an empty list just because the idle resume process exited. */
  restoredIdle: boolean
}

export interface ExternalSession {
  kind: 'external'
  name: string
  sessionType: SessionType
  creator: SessionCreator
  agentType: AgentType
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  machine: string
  cwd: string
  host?: string
  task?: string
  status: 'connected' | 'stale'
  lastHeartbeat: number
  events: StreamJsonEvent[]
  clients: Set<WebSocket>
  createdAt: string
  lastEventAt: string
  metadata?: Record<string, unknown>
}

export interface CompletedSession {
  name: string
  createdAt?: string
  completedAt: string
  subtype: string
  finalComment: string
  costUsd: number
  sessionType: SessionType
  creator: SessionCreator
  spawnedBy?: string
}

export type WorkerStatus = 'starting' | 'running' | 'down' | 'done'
export type WorkerPhase = 'starting' | 'running' | 'exited'

export interface WorkerState {
  name: string
  status: WorkerStatus
  phase: WorkerPhase
}

export interface WorkerSummary {
  total: number
  starting: number
  running: number
  down: number
  done: number
}

export interface ExitedStreamSessionState {
  phase: 'exited'
  hadResult: boolean
  sessionType: SessionType
  creator: SessionCreator
  conversationId?: string
  agentType: AgentType
  model?: string
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  mode: ClaudePermissionMode
  cwd: string
  host?: string
  currentSkillInvocation?: ActiveSkillInvocation
  spawnedBy?: string
  spawnedWorkers: string[]
  createdAt: string
  providerContext: ProviderSessionContext
  credentialPoolId?: string
  credentialPoolMode?: CredentialPoolRuntimeMode
  credentialPoolRecovery?: CredentialPoolRecoveryRequest
  activeTurnId?: string
  resumedFrom?: string
  conversationEntryCount: number
  events: StreamJsonEvent[]
  queuedMessages?: QueuedMessage[]
  currentQueuedMessage?: QueuedMessage
  pendingDirectSendMessages?: QueuedMessage[]
  activeTurnMessage?: QueuedMessage
}

export interface StreamSessionCreateOptions {
  resumeSessionId?: string
  systemPrompt?: string
  maxTurns?: number
  model?: string
  effort?: AgentEffortLevel
  omitEffort?: boolean
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  createdAt?: string
  spawnedBy?: string
  spawnedWorkers?: string[]
  resumedFrom?: string
  sessionType?: SessionType
  creator?: SessionCreator
  conversationId?: string
  currentSkillInvocation?: ActiveSkillInvocation
  approvalBridgeNonce?: string
  approvalBridgeCredential?: ConversationApprovalBridgeCredential
  daemonProcess?: PersistedDaemonProcess
  providerAuth?: ProviderSpawnAuth
  credentialPoolId?: string
  credentialPoolMode?: CredentialPoolRuntimeMode
}

export interface CodexSessionCreateOptions {
  resumeSessionId?: string
  createdAt?: string
  spawnedBy?: string
  spawnedWorkers?: string[]
  systemPrompt?: string
  model?: string
  effort?: AgentEffortLevel
  resumedFrom?: string
  machine?: MachineConfig
  sessionType?: SessionType
  creator?: SessionCreator
  conversationId?: string
  currentSkillInvocation?: ActiveSkillInvocation
  providerAuth?: ProviderSpawnAuth
}

export interface GeminiSessionCreateOptions {
  resumeSessionId?: string
  createdAt?: string
  spawnedBy?: string
  spawnedWorkers?: string[]
  systemPrompt?: string
  model?: string
  resumedFrom?: string
  machine?: MachineConfig
  maxTurns?: number
  sessionType?: SessionType
  creator?: SessionCreator
  conversationId?: string
  currentSkillInvocation?: ActiveSkillInvocation
  providerAuth?: ProviderSpawnAuth
}

export interface OpenCodeSessionCreateOptions {
  resumeSessionId?: string
  createdAt?: string
  spawnedBy?: string
  spawnedWorkers?: string[]
  systemPrompt?: string
  model?: string
  resumedFrom?: string
  machine?: MachineConfig
  maxTurns?: number
  sessionType?: SessionType
  creator?: SessionCreator
  conversationId?: string
  currentSkillInvocation?: ActiveSkillInvocation
  providerAuth?: ProviderSpawnAuth
}

export interface PersistedDaemonProcess {
  processId: string
  mode: 'pipe' | 'pty'
}

export type AnySession = PtySession | StreamSession | ExternalSession

export interface AgentsRouterOptions {
  ptySpawner?: PtySpawner
  sqliteDb: DatabaseSync
  maxSessions?: number
  taskDelayMs?: number
  wsKeepAliveIntervalMs?: number
  autoRotateEntryThreshold?: number
  codexTurnWatchdogTimeoutMs?: number
  autoResumeSessions?: boolean
  enableSessionPruner?: boolean
  machinesFilePath?: string
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
  internalToken?: string
  approvalBridgeSigningSecret?: string
  machineEnrollmentSigningSecret?: string
  getActionPolicyGate?: () => ActionPolicyGate | null
  getWorkspaceResolver?: () => WorkspaceResolverCapability | undefined
  commanderSessionStore?: Pick<CommanderSessionStore, 'get' | 'list'>
  commanderConversationStore?: Pick<
    ConversationStore,
    'get' | 'listByCommander' | 'ensureApprovalBridgeCredential'
  >
  buildCommanderSessionSeed?: (
    params: Omit<CommanderSessionSeedParams, 'memoryBasePath'>,
  ) => Promise<{ systemPrompt?: string; maxTurns?: number }>
  getCommanderLabels?: () => Promise<Record<string, string>>
  commanderSessionStorePath?: string
  commanderDataDir?: string
  commanderTranscriptAppender?: CommanderTranscriptAppender
  questStore?: QuestStore
  providerAuthStore?: ProviderAuthStore
  claudeQuotaReader?: ClaudeQuotaReader
  claudeQuotaPollIntervalMs?: number
  claudeGlobalConfigDir?: string
  claudeAccountIdentityResolver?: ClaudeAccountIdentityResolver
  claudeGlobalAuthValidator?: ClaudeGlobalAuthValidator
}

export interface CommanderTranscriptAppendInput {
  commanderId: string
  transcriptId: string
  event: StreamJsonEvent
}

export interface CommanderTranscriptAppender {
  appendEvent(input: CommanderTranscriptAppendInput): void
}

export interface AgentsRouterResult {
  router: Router
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  sessionsInterface: CommanderSessionsInterface
  approvalSessionsInterface: ApprovalSessionsInterface
  machineCommandExecutor: import('./machine-command-executor.js').MachineCommandExecutor
  providerExecution: import('./provider-execution-mode.js').ProviderExecutionCapability
}

export interface ActiveSkillInvocation {
  toolUseId?: string
  skillId: string
  /** Persisted display label so approval UI and policy traces do not derive it later. */
  displayName: string
  /** ISO timestamp when this skill context became active for the session. */
  startedAt: string
}

export interface ApprovalSessionContext {
  sessionName: string
  sessionType: SessionType
  creator: SessionCreator
  agentType: AgentType
  mode: ClaudePermissionMode
  cwd: string
  host?: string
  commanderScopeId?: string
  conversationId?: string
  currentSkillInvocation?: ActiveSkillInvocation
}

export interface PendingCodexApprovalView {
  id: string
  sessionName: string
  commanderScopeId?: string
  conversationId?: string
  requestId: number
  actionId: string
  actionLabel: string
  requestedAt: string
  reason?: string
  risk?: string
  threadId?: string
  itemId?: string
  turnId?: string
}

export interface CodexApprovalQueueEvent {
  type: 'enqueued' | 'resolved'
  approval: PendingCodexApprovalView
  decision?: 'approve' | 'reject' | 'cancel'
  delivered?: boolean
}

/**
 * Conversation-lifetime approval bridge credential resolved for a Claude
 * launch. Every provider generation spawned for the same conversation mints
 * a token from this same credential, so rotation never invalidates the
 * approval path.
 */
export interface ConversationApprovalBridgeCredential {
  conversationId: string
  credentialId: string
  epoch: number
}

/**
 * Narrow projection of a conversation used by approval bridge validation.
 * Kept module-local so the agents module does not depend on the full
 * commanders Conversation shape.
 */
export interface ApprovalBridgeConversationState {
  status: 'active' | 'idle' | 'archived'
  /** Raw owning commander id used by action-policy scope resolution. */
  commanderId?: string
  approvalBridge?: {
    credentialId: string
    epoch: number
  }
}

export type ApprovalBridgeCredentialInspection =
  | { ok: true; conversationId?: string }
  | {
    ok: false
    reason: 'session_not_live' | 'nonce_mismatch' | 'conversation_revoked' | 'credential_revoked'
  }

export interface ApprovalSessionsInterface {
  getSessionContext(name: string): ApprovalSessionContext | null
  findSessionContextByClaudeSessionId(sessionId: string): ApprovalSessionContext | null
  getLiveSession(name: string): StreamSession | null
  findLiveSessionByClaudeSessionId(sessionId: string): StreamSession | null
  findLiveSessionByConversationId?(conversationId: string): StreamSession | null
  /**
   * Resolve the policy snapshot for a conversation independently of provider
   * liveness. The persisted runtime row is authoritative for cwd and active
   * skill context during replacement/restart gaps.
   */
  resolveConversationPolicyContext?(
    conversationId: string,
  ): Promise<ApprovalSessionContext | null>
  /**
   * Validate a verified bridge token's claims. Conversation-scoped (v3)
   * credentials are accepted whenever the conversation is known, non-revoked,
   * and the credential id/epoch match — regardless of which provider process
   * or generation presents them and regardless of whether a live provider
   * session currently exists. Session-scoped (v2) credentials resolve their
   * session name to a conversation when possible (live sessions first, then
   * persisted session rows) and otherwise keep the legacy live-session nonce
   * semantics.
   */
  inspectApprovalBridgeCredential?(
    claims: ApprovalBridgeTokenClaims,
  ): Promise<ApprovalBridgeCredentialInspection>
  /** Legacy session-scoped check retained as the fallback for v2 claims. */
  validateApprovalBridgeCredential(sessionName: string, nonce: string): boolean
  listPendingCodexApprovals(): PendingCodexApprovalView[]
  resolvePendingCodexApproval(
    approvalId: string,
    decision: CodexApprovalDecision,
  ): {
    ok: true
  } | {
    ok: false
    code: 'invalid_session' | 'unavailable' | 'not_found' | 'protocol_error'
    reason: string
  }
  subscribeToCodexApprovalQueue(listener: (event: CodexApprovalQueueEvent) => void): () => void
}

/**
 * Result returned by `CommanderSessionsInterface.dispatchWorkerForCommander`.
 * The interface yields `{ status, body }` instead of writing to a Response so
 * the commanders router can forward the result without coupling auth + URL
 * resolution (its job) to session-spawn details (the agents router's job).
 */
export interface DispatchWorkerForCommanderResult {
  status: number
  body: Record<string, unknown>
}

export interface TrustedWorkerLaunchSourceDefaults {
  agentType: AgentType
  model?: string
  effort?: AgentEffortLevel
  omitEffort?: boolean
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
}

export interface CommanderSessionsInterface {
  createCommanderSession(params: {
    name: string
    commanderId?: string
    conversationId?: string
    systemPrompt: string
    agentType: AgentType
    model?: string
    effort?: AgentEffortLevel
    omitEffort?: boolean
    adaptiveThinking?: ClaudeAdaptiveThinkingMode
    maxThinkingTokens?: ClaudeMaxThinkingTokens
    cwd?: string
    machineId?: string
    resumeProviderContext?: ProviderSessionContext
    credentialPoolId?: string
    credentialPoolMode?: CredentialPoolRuntimeMode
    maxTurns?: number
    env?: NodeJS.ProcessEnv
    gaiaOpsApiKeyExpiresAt?: string
  }): Promise<StreamSession>
  replaceCommanderSession(params: {
    name: string
    commanderId?: string
    conversationId?: string
    systemPrompt: string
    agentType: AgentType
    model?: string
    effort?: AgentEffortLevel
    omitEffort?: boolean
    adaptiveThinking?: ClaudeAdaptiveThinkingMode
    maxThinkingTokens?: ClaudeMaxThinkingTokens
    cwd?: string
    machineId?: string
    resumeProviderContext?: ProviderSessionContext
    credentialPoolId?: string
    credentialPoolMode?: CredentialPoolRuntimeMode
    maxTurns?: number
    env?: NodeJS.ProcessEnv
    gaiaOpsApiKeyExpiresAt?: string
    requireIdleReplacement?: boolean
  }): Promise<StreamSession>
  updateCommanderSessionRuntimeSettings?(
    name: string,
    settings: {
      agentType: AgentType
      model?: string | null
      effort?: AgentEffortLevel
      adaptiveThinking?: ClaudeAdaptiveThinkingMode
      maxThinkingTokens?: ClaudeMaxThinkingTokens
    },
  ): StreamSession | undefined
  getCredentialRecoveryRequest?(sessionName: string): CredentialPoolRecoveryRequest | undefined
  clearCredentialRecoveryRequest?(sessionName: string): void
  getActiveCredentialPoolId?(provider: AgentType): Promise<string | undefined>
  /**
   * Dispatch a worker session attributed to a commander whose identity has
   * already been verified by the caller (typically the URL-baked
   * `/api/commanders/:id/workers` route). The spawned session persists with
   * `creator: { kind: "commander", id }` and `sessionType: "worker"` so the
   * Herd TEAM panel — and every other consumer that filters by
   * commander ownership — sees it correctly. See issue #1223.
   */
  dispatchWorkerForCommander(input: {
    commanderId: string
    abortSignal?: AbortSignal
    rawBody: unknown
    /** Runtime settings copied from a server-owned source session, never request input. */
    trustedSourceDefaults?: TrustedWorkerLaunchSourceDefaults
  }): Promise<DispatchWorkerForCommanderResult>
  sendToSession(
    name: string,
    payload: string | SessionSendPayload,
    options: {
      intent: SessionSendIntent
      priority?: 'high' | 'normal' | 'low'
    },
  ): Promise<SessionSendResult>
  verifyWebSocketAccess?(req: IncomingMessage): Promise<boolean>
  recordSessionEvent?(name: string, event: StreamJsonEvent): boolean
  autoResolvePlanApproval?(
    name: string,
    toolId: string,
    decision: PlanApprovalDecision,
    message: string,
  ): Promise<boolean> | boolean
  deleteSession(name: string): void
  getSession(name: string): StreamSession | undefined
  subscribeToEvents(name: string, handler: (event: StreamJsonEvent) => void): () => void
  shutdown?(): Promise<void>
}

export interface MachineConfig {
  id: string
  label: string
  host: string | null
  transport?: MachineTransportType
  tailscaleHostname?: string
  user?: string
  port?: number
  cwd?: string
  envFile?: string
  daemon?: MachineDaemonConfig
}

export interface MachineDaemonConfig {
  pairingTokenHash?: string
  pairedAt?: string
  expiresAt?: string
  revokedAt?: string
  lastSeenAt?: string
  daemonVersion?: string
}

export interface MachineDaemonProviderHealth {
  provider: string
  installed: boolean
  authenticated: boolean
  version: string | null
  authMethod: string | null
  detail: string | null
  checkedAt: string | null
  authMode?: 'native' | 'host-managed' | 'missing'
  nativeAuthenticated?: boolean
  hostManagedAuthenticated?: boolean
}

export type MachineDaemonConnectionState =
  | 'local'
  | 'ssh-local'
  | 'not-paired'
  | 'paired'
  | 'connected'

export type MachineDaemonProviderAuthState = 'ready' | 'missing' | 'not-checked'
export type MachineDaemonProviderAuthMode = 'native' | 'host-managed' | 'mixed' | 'missing' | 'not-checked'

export type MachineDaemonActionId = 'pair' | 'rotate' | 'revoke'

export interface MachineDaemonAction {
  id: MachineDaemonActionId
  label: string
}

export interface MachineDaemonPairCommand {
  shortCommand: string
  fullCommand: string
  disclosureLabel: string
}

export interface MachineDaemonStatus {
  machineId: string
  displayLabel: string
  paired: boolean
  connected: boolean
  connectionState: MachineDaemonConnectionState
  connectionLabel: string
  selectedTransport: MachineTransportType
  providerAuthReady: boolean
  providerAuthMode: MachineDaemonProviderAuthMode
  providerAuthState: MachineDaemonProviderAuthState
  providerAuthLabel: string
  launchable: boolean
  launchUnsupportedReason: string | null
  allowedActions: MachineDaemonAction[]
  pairedAt: string | null
  expiresAt: string | null
  pairingExpired: boolean
  revokedAt: string | null
  connectedAt: string | null
  lastSeenAt: string | null
  connectionId: string | null
  daemonVersion: string | null
  protocolVersion: number | null
  pid: number | null
  platform: string | null
  arch: string | null
  activeProcesses: number | null
  providerHealth: Record<string, MachineDaemonProviderHealth>
}

export interface MachineTransportStatus {
  type: MachineTransportType
  connected: boolean
  providerAuthReady: boolean
  launchable: boolean
  reason: string | null
}

export type MachineToolKey = string

export interface MachineToolStatus {
  ok: boolean
  version: string | null
  raw: string
}

export interface MachineHealthReport {
  machineId: string
  mode: MachineTransportType
  ssh: {
    ok: boolean
    destination?: string
  }
  daemon?: MachineDaemonStatus
  tools: Record<MachineToolKey, MachineToolStatus>
}

export interface PersistedStreamSession {
  name: string
  sessionType?: SessionType
  creator?: SessionCreator
  conversationId?: string
  transportType?: SessionTransportType
  agentType: AgentType
  model?: string
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  mode: ClaudePermissionMode
  cwd: string
  host?: string
  currentSkillInvocation?: ActiveSkillInvocation
  createdAt: string
  providerContext: ProviderSessionContext
  credentialPoolId?: string
  credentialPoolMode?: CredentialPoolRuntimeMode
  credentialPoolRecovery?: CredentialPoolRecoveryRequest
  approvalBridgeNonce?: string
  activeTurnId?: string
  conversationEntryCount?: number
  events?: StreamJsonEvent[]
  spawnedBy?: string
  spawnedWorkers?: string[]
  resumedFrom?: string
  sessionState?: 'active' | 'exited'
  hadResult?: boolean
  daemonProcess?: PersistedDaemonProcess
  queuedMessages?: QueuedMessage[]
  currentQueuedMessage?: QueuedMessage
  pendingDirectSendMessages?: QueuedMessage[]
  activeTurnMessage?: QueuedMessage
}

export interface PersistedSessionsState {
  sessions: PersistedStreamSession[]
}

export interface ResolvedResumableSessionSource {
  source: PersistedStreamSession
  liveSession?: StreamSession
}

export interface CapturedCommandResult {
  stdout: string
  stderr: string
  code: number
  signal: string | null
  timedOut: boolean
}

export interface CompletedSessionMetadata {
  sessionType?: SessionType
  creator?: SessionCreator
  spawnedBy?: string
  createdAt?: string
}
