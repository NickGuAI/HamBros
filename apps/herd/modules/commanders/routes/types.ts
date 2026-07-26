import type { AuthUser } from '@gehirn/auth-providers'
import type { Request, RequestHandler, Router } from 'express'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store.js'
import type { ProviderSecretsStoreLike } from '../../../server/api-keys/provider-secrets-store.js'
import type { CommanderSessionsInterface } from '../../agents/routes.js'
import type { StreamJsonEvent } from '../../agents/types.js'
import type { TranscriptEnvelope } from '../../../src/types/transcript-envelope.js'
import type { AutomationStore } from '../../automations/store.js'
import type { AutomationScheduler } from '../../automations/scheduler.js'
import type { ChannelSurfaceBindingStore } from '../../channels/surface-binding-store.js'
import type { CommanderChannelBindingStore } from '../../channels/store.js'
import type { ProviderSessionContext } from '../../agents/providers/provider-session-context.js'
import type { ActionPolicyGate } from '../../policies/action-policy-gate.js'
import type { WorkspaceResolverCapability } from '../../workspace/capability.js'
import type { EvalAdapterPreflight } from '../../eval/adapter-preflight.js'
import type { ChannelMessageIdempotencyLedger } from '../channel-idempotency-ledger.js'
import type { ChannelReplyStreamDispatch } from '../channel-dispatchers.js'
import type { ConversationCredentialSelectionModes } from '../conversation-credential-selection.js'
import type {
  CommanderHeartbeatManager,
  CommanderHeartbeatConfig,
} from '../heartbeat.js'
import type { HeartbeatLog } from '../heartbeat-log.js'
import type { CommanderSubagentLifecycleEvent, CommanderManager } from '../manager.js'
import type { ChannelReplyDelivery, Conversation, ConversationStore } from '../conversation-store.js'
import type { QuestStore } from '../quest-store.js'
import type {
  CommanderChannelMeta,
  CommanderCurrentTask,
  CommanderLastRoute,
  CommanderSession,
  CommanderSessionStore,
  CommanderTaskSource,
} from '../store.js'
import type { GhTasks } from '../tools/gh-tasks.js'
import type { CommanderRuntimeConfig } from '../runtime-config.shared.js'
import type { GeminiImageGenerationOptions } from '../../../server/image-generation/gemini-client.js'

export interface CommanderChannelReplyDispatchInput {
  commanderId: string
  message: string
  channelMeta: CommanderChannelMeta
  lastRoute: CommanderLastRoute
}

export type CommanderChannelReplyDispatcher = (
  input: CommanderChannelReplyDispatchInput,
) => Promise<void> | void

export interface CommandersRouterOptions {
  sessionStore?: CommanderSessionStore
  sessionStorePath?: string
  conversationStore?: ConversationStore
  runtimeConfig?: CommanderRuntimeConfig
  runtimeConfigPath?: string
  questStore?: QuestStore
  questStoreDataDir?: string
  ghTasksFactory?: (repo: string) => Pick<GhTasks, 'readTask'>
  heartbeatLog?: HeartbeatLog
  fetchImpl?: typeof fetch
  providerSecretsStore?: ProviderSecretsStoreLike
  generateGeminiImage?: (
    options: GeminiImageGenerationOptions,
  ) => Promise<Buffer>
  sessionsInterface?: CommanderSessionsInterface
  conversationSessionWebSocket?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  automationStore?: AutomationStore
  automationScheduler?: AutomationScheduler
  automationSchedulerInitialized?: Promise<void>
  apiKeyStore?: ApiKeyStoreLike
  internalToken?: string
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
  memoryBasePath?: string
  heartbeatBasePath?: string
  contextPressureInputTokenThreshold?: number
  now?: () => Date
  githubToken?: string
  remoteSyncSharedSecret?: string
  channelReplyDispatchers?: Partial<Record<CommanderChannelMeta['provider'], CommanderChannelReplyDispatcher>>
  surfaceBindingStore?: ChannelSurfaceBindingStore
  channelBindingStore?: CommanderChannelBindingStore
  channelMessageIdempotencyLedger?: ChannelMessageIdempotencyLedger
  actionPolicyGate?: ActionPolicyGate
  getWorkspaceResolver?: () => WorkspaceResolverCapability | undefined
  evalAdapterPreflight?: EvalAdapterPreflight
}

export interface CommandersRouterResult {
  router: Router
  conversationRouter: Router
  handleConversationUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  dispose: () => void
}

export interface GitHubIssueResponse {
  number: number
  title: string
  body?: string | null
  html_url: string
  state: string
  labels?: Array<{ name?: string }>
  pull_request?: unknown
}

export interface GitHubIssueUrlParts {
  owner: string
  repo: string
  issueNumber: number
  normalizedUrl: string
}

export type StreamEvent = Record<string, unknown> | TranscriptEnvelope

export interface ContextPressureBridge {
  onContextPressure(handler: () => Promise<void> | void): void
  trigger(): Promise<void>
}

export interface CommanderSubAgentEntry {
  sessionId: string
  dispatchedAt: string
  state: 'running' | 'completed' | 'failed'
  result?: string
}

export interface CommanderTerminalState {
  kind: 'max_turns'
  subtype?: string
  terminalReason?: string
  message: string
  errors: string[]
}

export interface CommanderRuntime {
  manager: CommanderManager
  contextPressureBridge: ContextPressureBridge
  lastTaskState: string
  heartbeatCount: number
  lastKnownInputTokens: number
  forceNextFatHeartbeat: boolean
  pendingCollect: string[]
  pendingInternalUserMessages: Map<string, number>
  collectTimer: ReturnType<typeof setTimeout> | null
  subAgents: Map<string, CommanderSubAgentEntry>
  terminalState: CommanderTerminalState | null
  unsubscribeEvents?: () => void
}

export interface ChannelReplyForwarder {
  unsubscribe: () => void
  pendingClientSendIds: Set<string>
  activeClientSendId: string | null
  activeTurnId: string | null
  turnEvents: StreamJsonEvent[]
  streamDispatch: {
    delivery: ChannelReplyDelivery
    controller: ChannelReplyStreamDispatch
  } | null
  streamDispatchPromise: Promise<ChannelReplyForwarder['streamDispatch']> | null
  skippedTurnIds: Set<string>
  skippedCompletedTurns: number
}

export interface CommanderSessionStats {
  questCount: number
  scheduleCount: number
}

export interface CommanderConversationRuntimeView {
  heartbeat: CommanderHeartbeatConfig
  lastHeartbeat: string | null
  heartbeatTickCount: number
  currentTask: CommanderCurrentTask | null
  completedTasks: number
  totalCostUsd: number
  monthlyCostUsd: number
  channelMeta?: CommanderChannelMeta
  lastRoute?: CommanderLastRoute
  providerContext?: ProviderSessionContext
}

export type CommanderSessionResponseBase = Omit<CommanderSession, 'remoteOrigin'> & CommanderConversationRuntimeView & {
  name: string
  credentialSelectionModes: ConversationCredentialSelectionModes
  remoteOrigin?: {
    machineId: string
    label: string
  }
}

export type CommanderUiPublic = {
  speakingTone?: string
  portraitStyleId?: string
} | null

export type CommanderSessionResponse = CommanderSessionResponseBase &
  CommanderSessionStats & {
    ui?: CommanderUiPublic
    avatarUrl?: string | null
  }

export type RemoteSyncAuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export interface CommanderRoutesContext {
  now: () => Date
  commanderDataDir: string
  commanderBasePath: string
  contextPressureInputTokenThreshold: number
  fetchImpl: typeof fetch
  providerSecretsStore: ProviderSecretsStoreLike
  apiKeyStore?: ApiKeyStoreLike
  generateGeminiImage: (
    options: GeminiImageGenerationOptions,
  ) => Promise<Buffer>
  githubToken: string | null
  runtimeConfig: CommanderRuntimeConfig
  sessionStore: CommanderSessionStore
  conversationStore: ConversationStore
  surfaceBindingStore: ChannelSurfaceBindingStore
  channelBindingStore: CommanderChannelBindingStore
  channelMessageIdempotencyLedger: ChannelMessageIdempotencyLedger
  questStore: QuestStore
  ghTasksFactory: (repo: string) => Pick<GhTasks, 'readTask'>
  heartbeatLog: HeartbeatLog
  sessionsInterface?: CommanderSessionsInterface
  requireReadAccess: RequestHandler
  requireWriteAccess: RequestHandler
  requireConversationCreateAccess: RequestHandler
  requireChannelIngestAccess: RequestHandler
  /**
   * Auth gate for commander-scoped writes where the `:id` path segment is the
   * authority boundary, such as conversation creation, `POST /:id/workers`,
   * and quest claim routes.
   * Requires both `agents:write` (creates an agent session) and
   * `commanders:write` (acts on behalf of a commander). See issue #1223.
   */
  requireWorkerDispatchAccess: RequestHandler
  getWorkspaceResolver?: () => WorkspaceResolverCapability | undefined
  evalAdapterPreflight?: EvalAdapterPreflight
  heartbeatManager: CommanderHeartbeatManager
  runtimes: Map<string, CommanderRuntime>
  activeCommanderSessions: Map<string, { sessionName: string; startedAt: string }>
  channelReplyForwarders: Map<string, ChannelReplyForwarder>
  heartbeatFiredAtByConversation: Map<string, string>
  avatarUpload: { single(fieldname: string): RequestHandler }
  automationStore: AutomationStore
  automationScheduler?: AutomationScheduler
  automationSchedulerInitialized: Promise<void>
  getCommanderSessionStats: (commanderId: string) => Promise<CommanderSessionStats>
  onSubagentLifecycleEvent: (
    commanderId: string,
    event: CommanderSubagentLifecycleEvent,
  ) => void
  authorizeRemoteSync: (req: Request, session: CommanderSession) => RemoteSyncAuthResult
  dispatchCommanderMessage: (input: {
    commanderId: string
    message: string
    mode: 'collect' | 'followup'
    session?: CommanderSession
    runtime?: CommanderRuntime
  }) => Promise<{ ok: true } | { ok: false; status: number; error: string }>
  dispatchCommanderChannelReply: (input: {
    commanderId: string
    message: string
    conversationId?: string
  }) => Promise<
    | {
      ok: true
      conversationId: string
      provider: CommanderChannelMeta['provider']
      sessionKey: string
      lastRoute: CommanderLastRoute
    }
    | { ok: false; status: number; error: string }
  >
  attachCommanderPublicUi: (
    commanderId: string,
    payload: CommanderSessionResponse & {
      contextConfig: { fatPinInterval: number }
      runtime: {
        heartbeatCount: number
        terminalState: CommanderRuntime['terminalState']
      }
    },
  ) => Promise<
    CommanderSessionResponse & {
      contextConfig: { fatPinInterval: number }
      runtime: {
        heartbeatCount: number
        terminalState: CommanderRuntime['terminalState']
      }
    }
  >
  resolveHeartbeatConversation: (
    commanderId: string,
    conversationId?: string,
  ) => Promise<Conversation | null>
  resolveDefaultConversation: (commanderId: string) => Promise<Conversation | null>
  resolveCommanderRuntimeView: (commanderId: string) => Promise<CommanderConversationRuntimeView>
  ensureDefaultConversation: (
    session: CommanderSession,
    options?: {
      surface?: Conversation['surface']
      currentTask?: CommanderCurrentTask | null
    },
  ) => Promise<Conversation>
  reconcileCommanderSessions: () => Promise<void>
}
