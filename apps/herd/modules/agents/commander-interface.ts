/**
 * Commander sessions interface — the implementation that backs the
 * CommanderSessionsInterface contract declared in `./types.ts`.
 *
 * Extracted from `createAgentsRouter()` inside `routes.ts` in #921 Phase P5
 * so commander lifecycle lives in a focused module instead of as an inline
 * 157-line object literal nested in a 2300-line router closure.
 *
 * The implementation depends on several router-local factories (session
 * creators, queue plumbing, runtime teardown) that cannot be module-imported
 * because they themselves close over router state. Those dependencies are
 * passed through `CommanderInterfaceContext` at construction time — the
 * router instantiates this interface once and the contract is explicit.
 *
 * Non-closure dependencies stay imported directly so the context interface
 * stays focused on what's actually router-local.
 */
import { SessionMessageQueue, type QueuedMessage, type QueuedMessageImage, type QueuedMessagePriority } from './message-queue.js'
import { WebSocket } from 'ws'
import { resolveProviderDefaults, type ProviderCreateOptions } from './providers/provider-adapter.js'
import { getProvider } from './providers/registry.js'
import { getNextStreamEventSeq } from './messages/canonical-timeline.js'
import { resolveNativeProviderResumeId } from './providers/native-resume.js'
import { sanitizeProviderContextForPersistence } from './providers/provider-context-normalization.js'
import { shouldClearResumeProviderContextForCredentialPoolRecovery } from './provider-auth.js'
import type { MachineLaunchRuntime } from './session/machine-launch.js'
import { withCommanderRuntimeLaunch } from '../commanders/package-lifecycle-state.js'
import { resolveCommanderDataDir } from '../commanders/paths.js'
import type {
  AgentType,
  AnySession,
  ClaudePermissionMode,
  CommanderSessionsInterface,
  CredentialPoolRecoveryRequest,
  MachineConfig,
  SessionSendPayload,
  StreamJsonEvent,
  StreamSession,
} from './types.js'

type ProviderSessionCreateOptions = Omit<
  ProviderCreateOptions,
  'sessionName' | 'mode' | 'task' | 'cwd' | 'machine'
>

export type ProviderSessionCreator = (
  sessionName: string,
  mode: ClaudePermissionMode,
  task: string,
  cwd: string | undefined,
  machine: MachineConfig | undefined,
  agentType: AgentType,
  options?: ProviderSessionCreateOptions,
) => Promise<StreamSession>

export type SessionTeardown = (session: StreamSession, reason: string) => Promise<void>
export type RuntimeShutdown = (reason?: string) => Promise<void>

export class CommanderSessionReplacementConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommanderSessionReplacementConflictError'
  }
}

function hasQueuedSessionWork(session: StreamSession): boolean {
  return Boolean(
    session.currentQueuedMessage
      || session.pendingDirectSendMessages.length > 0
      || session.messageQueue.size > 0,
  )
}

export type CreateQueuedMessage = (
  text: string,
  priority: QueuedMessagePriority,
  images?: QueuedMessageImage[],
  displayText?: string,
  clientSendId?: string,
  userEventSubtype?: string,
) => QueuedMessage

export type EnqueueQueuedMessage = (
  session: StreamSession,
  message: QueuedMessage,
) => { ok: true } | { ok: false; error: string }

export type ScheduleQueueDrain = (
  session: StreamSession,
  options?: { force?: boolean },
) => void

export type SendImmediateText = (
  session: StreamSession,
  text: string,
  images?: QueuedMessageImage[],
  displayText?: string,
  clientSendId?: string,
  userEventSubtype?: string,
) => Promise<
  | { ok: true; disposition: 'started' | 'interrupted'; message: QueuedMessage }
  | { ok: false; code?: 'credential_recovery_failed'; error: string; retryable: boolean }
>

/**
 * Every router-local closure the CommanderSessionsInterface implementation
 * needs. Keeping the context explicit means any future change to
 * commander-lifecycle dependencies shows up in the type, not as a hidden
 * closure reference.
 */
export interface CommanderInterfaceContext {
  sessions: Map<string, AnySession>
  sessionEventHandlers: Map<string, Set<(event: StreamJsonEvent) => void>>
  schedulePersistedSessionsWrite: () => void

  createProviderStreamSession: ProviderSessionCreator
  resolveProviderLaunchMachine: MachineLaunchRuntime['resolveProviderLaunchMachine']

  createQueuedMessage: CreateQueuedMessage
  enqueueQueuedMessage: EnqueueQueuedMessage
  scheduleQueuedMessageDrain: ScheduleQueueDrain
  sendImmediateTextToStreamSession: SendImmediateText

  teardownProviderSession: SessionTeardown
  shutdownProviderRuntimes: RuntimeShutdown

  /** Shared lifecycle scope for commander-owned provider runtime launches. */
  commanderDataDir?: string

  getCredentialRecoveryRequest?: (sessionName: string) => CredentialPoolRecoveryRequest | undefined
  clearCredentialRecoveryRequest?: (sessionName: string) => void
  getActiveCredentialPoolId?: (provider: AgentType) => Promise<string | undefined>
}

/**
 * Subset of `CommanderSessionsInterface` covered by this factory. The
 * `dispatchWorkerForCommander` method is composed in by the router itself
 * (issue #1223) because it needs router-local state — the machine registry,
 * `maxSessions` budget, and direct access to the session-creator closures —
 * that is intentionally not part of `CommanderInterfaceContext`. Keeping it
 * out of this factory's return type means the router's compose step is the
 * single place that sees both halves.
 */
export type BaseCommanderSessionsInterface = Omit<
  CommanderSessionsInterface,
  'dispatchWorkerForCommander'
>

type CreateCommanderSessionInput = Parameters<BaseCommanderSessionsInterface['createCommanderSession']>[0]

function clearResumeContextOnCredentialPoolChange(
  input: CreateCommanderSessionInput,
  previous: AnySession | undefined,
): CreateCommanderSessionInput {
  if (
    !input.resumeProviderContext ||
    !input.credentialPoolId ||
    !previous ||
    previous.kind !== 'stream' ||
    !previous.credentialPoolId ||
    previous.credentialPoolId === input.credentialPoolId
  ) {
    return input
  }

  const provider = input.agentType === 'claude' || input.agentType === 'codex'
    ? input.agentType
    : null
  if (
    provider &&
    !shouldClearResumeProviderContextForCredentialPoolRecovery(provider, undefined, input.credentialPoolMode)
  ) {
    return input
  }

  return {
    ...input,
    resumeProviderContext: undefined,
  }
}

function normalizeSendPayload(payload: string | SessionSendPayload): SessionSendPayload {
  if (typeof payload === 'string') {
    return { text: payload }
  }
  const images = payload.images && payload.images.length > 0 ? [...payload.images] : undefined
  const displayText = payload.displayText !== undefined ? payload.displayText.trim() : undefined
  const clientSendId = payload.clientSendId !== undefined ? payload.clientSendId.trim() : undefined
  const userEventSubtype = payload.userEventSubtype !== undefined ? payload.userEventSubtype.trim() : undefined
  return {
    text: payload.text,
    ...(displayText !== undefined ? { displayText } : {}),
    images,
    ...(clientSendId ? { clientSendId } : {}),
    ...(userEventSubtype ? { userEventSubtype } : {}),
  }
}

/**
 * Construct the commander-session interface backed by the given router
 * context. Behavior is identical to the pre-#921-P5 inline object literal
 * that lived in `routes.ts`; this is pure refactor.
 */
export function createCommanderSessionsInterface(
  ctx: CommanderInterfaceContext,
): BaseCommanderSessionsInterface {
  const {
    sessions,
    sessionEventHandlers,
    schedulePersistedSessionsWrite,
    createProviderStreamSession,
    createQueuedMessage,
    enqueueQueuedMessage,
    scheduleQueuedMessageDrain,
    sendImmediateTextToStreamSession,
    teardownProviderSession,
    shutdownProviderRuntimes,
    getCredentialRecoveryRequest,
    clearCredentialRecoveryRequest,
    getActiveCredentialPoolId,
  } = ctx
  const commanderDataDir = ctx.commanderDataDir ?? resolveCommanderDataDir()

  async function runCommanderRuntimeLaunch<T>(
    input: Pick<CreateCommanderSessionInput, 'name' | 'commanderId'>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = sessions.get(input.name)
    const commanderId = input.commanderId?.trim()
      || (previous?.creator?.kind === 'commander' ? previous.creator.id?.trim() ?? '' : '')
    if (!commanderId) {
      return operation()
    }
    return withCommanderRuntimeLaunch(commanderId, commanderDataDir, operation)
  }

  async function buildCommanderSession({
    name,
    commanderId,
    conversationId,
    systemPrompt,
    agentType,
    model,
    effort,
    omitEffort,
    adaptiveThinking,
    maxThinkingTokens,
    cwd,
    machineId,
    resumeProviderContext,
    credentialPoolId,
    credentialPoolMode,
    maxTurns,
    env,
    gaiaOpsApiKeyExpiresAt,
  }: CreateCommanderSessionInput): Promise<StreamSession> {
    const creator = {
      kind: 'commander' as const,
      id: commanderId?.trim() || name,
    }
    const provider = getProvider(agentType)
    if (!provider) {
      throw new Error(`Unknown provider: ${agentType}`)
    }
    const resolvedMachine = await ctx.resolveProviderLaunchMachine(machineId, agentType)
    if (!resolvedMachine.ok) {
      throw resolvedMachine.cause
    }
    const machine = resolvedMachine.machine
    const sessionCwd = cwd ?? machine?.cwd ?? process.env.HOME ?? '/tmp'
    const resumeSessionId = resolveNativeProviderResumeId({
      provider,
      agentType,
      providerContext: resumeProviderContext,
      sessionName: name,
      cwd: sessionCwd,
    })
    const baseOptions: ProviderSessionCreateOptions = {
      systemPrompt,
      model,
      effort,
      omitEffort,
      adaptiveThinking,
      maxThinkingTokens,
      maxTurns,
      sessionType: 'commander',
      creator,
      conversationId,
      resumeProviderContext,
      credentialPoolId,
      credentialPoolMode,
      env,
    }

    const session = resumeSessionId
      ? await createProviderStreamSession(
        name,
        'default',
        '',
        sessionCwd,
        machine,
        agentType,
        {
          ...baseOptions,
          resumeSessionId,
        },
      )
      : await createProviderStreamSession(
        name,
        'default',
        '',
        sessionCwd,
        machine,
        agentType,
        baseOptions,
      )
    if (gaiaOpsApiKeyExpiresAt) {
      session.gaiaOpsApiKeyExpiresAt = gaiaOpsApiKeyExpiresAt
    }
    return session
  }

  return {
    async createCommanderSession(input) {
      return runCommanderRuntimeLaunch(input, async () => {
        const { name } = input
        const session = await buildCommanderSession(
          clearResumeContextOnCredentialPoolChange(input, sessions.get(name)),
        )
        sessions.set(name, session)
        schedulePersistedSessionsWrite()
        return session
      })
    },

    async replaceCommanderSession(input) {
      return runCommanderRuntimeLaunch(input, async () => {
        const { name } = input
        const previous = sessions.get(name)
        const inputWithPreservedMachine = input.machineId === undefined
          && previous?.kind === 'stream'
          && previous.host
          ? { ...input, machineId: previous.host }
          : input
        const replacement = await buildCommanderSession(
          clearResumeContextOnCredentialPoolChange(inputWithPreservedMachine, previous),
        )
        if (input.requireIdleReplacement && previous?.kind === 'stream') {
          let conflictReason: string | null = null
          if (sessions.get(name) !== previous) {
            conflictReason = 'Runtime session changed while settings update was prepared; retry the update'
          } else if (!previous.lastTurnCompleted) {
            conflictReason = 'Conversation is mid-turn; runtime settings can change after the current turn completes'
          } else if (hasQueuedSessionWork(previous)) {
            conflictReason = 'Conversation has queued work; runtime settings can change after the queue drains'
          }
          if (conflictReason) {
            await teardownProviderSession(replacement, `Aborted runtime settings update for session "${name}"`)
            throw new CommanderSessionReplacementConflictError(conflictReason)
          }
        }
        if (previous && previous.kind === 'stream' && replacement.kind === 'stream') {
          // Mirror websocket.ts auto-rotate replacement so same-name provider
          // swaps preserve replay, usage, entry count, and auto-rotate state.
          replacement.events = previous.events.slice()
          replacement.nextEventSeq = getNextStreamEventSeq(replacement.events)
          replacement.usage = previous.usage ? { ...previous.usage } : previous.usage
          replacement.conversationEntryCount = previous.conversationEntryCount
          replacement.autoRotatePending = previous.autoRotatePending
          const queuedMessages = previous.messageQueue ? previous.messageQueue.list() : replacement.messageQueue.list()
          const pendingDirectSendMessages = [...previous.pendingDirectSendMessages]
          const currentQueuedMessage = previous.currentQueuedMessage
          if (currentQueuedMessage) {
            if (currentQueuedMessage.priority === 'high') {
              pendingDirectSendMessages.unshift(currentQueuedMessage)
            } else {
              queuedMessages.unshift(currentQueuedMessage)
            }
          }
          replacement.currentQueuedMessage = undefined
          replacement.pendingDirectSendMessages = pendingDirectSendMessages.filter((message, index, messages) => {
            return message.priority === 'high'
              && messages.findIndex((candidate) => candidate.id === message.id) === index
          })
          replacement.messageQueue = new SessionMessageQueue(
            previous.messageQueue?.maxSize ?? replacement.messageQueue.maxSize,
            queuedMessages.filter((message, index, messages) => {
              return message.priority !== 'high'
                && messages.findIndex((candidate) => candidate.id === message.id) === index
            }),
          )
          // Transfer connected WS clients to the replacement so broadcasts
          // from the new runtime reach them without a reconnect round-trip.
          for (const client of previous.clients) {
            replacement.clients.add(client)
          }
          previous.clients.clear()
        }
        // sessionEventHandlers is keyed by `name`, so the replacement that
        // reuses the same slot naturally keeps prior subscribers attached. Swap
        // the routable slot before awaiting teardown so a concurrent send cannot
        // enter the provider runtime that is being retired.
        sessions.set(name, replacement)
        schedulePersistedSessionsWrite()
        if (
          replacement.kind === 'stream' &&
          !replacement.currentQueuedMessage &&
          (replacement.pendingDirectSendMessages.length > 0 || replacement.messageQueue.size > 0)
        ) {
          scheduleQueuedMessageDrain(replacement, { force: true })
        }
        if (previous && previous.kind === 'stream') {
          // Keep the old provider alive until the replacement is fully built and
          // its replay/queue state has moved. The slot already points at the new
          // runtime, so messages arriving during asynchronous teardown are sent
          // to the replacement instead of being lost with the old provider.
          await teardownProviderSession(previous, `Provider swap on session "${name}"`)
        }
        return replacement
      })
    },

    updateCommanderSessionRuntimeSettings(name, settings) {
      const session = sessions.get(name)
      if (!session || session.kind !== 'stream' || session.agentType !== settings.agentType) {
        return undefined
      }

      const provider = getProvider(settings.agentType)
      if (Object.prototype.hasOwnProperty.call(settings, 'model')) {
        session.model = settings.model
          ?? (provider ? resolveProviderDefaults(provider).model ?? undefined : undefined)
      }
      session.effort = settings.effort
      session.adaptiveThinking = settings.adaptiveThinking
      session.maxThinkingTokens = settings.maxThinkingTokens
      delete (session.providerContext as { effort?: unknown } | undefined)?.effort
      const persistedProviderContext = sanitizeProviderContextForPersistence(session.providerContext, {
        effort: settings.effort,
        adaptiveThinking: settings.adaptiveThinking,
        maxThinkingTokens: settings.maxThinkingTokens,
      })
      if (persistedProviderContext) {
        Object.assign(session.providerContext, persistedProviderContext)
      }
      schedulePersistedSessionsWrite()
      return session
    },

    async sendToSession(name, payload, options) {
      const session = sessions.get(name)
      if (!session || session.kind !== 'stream') {
        return {
          ok: false,
          code: 'session_unavailable',
          error: 'Stream session unavailable',
          retryable: false,
        }
      }
      const { text, images, displayText, clientSendId, userEventSubtype } = normalizeSendPayload(payload)
      if (options.intent === 'queue') {
        const message = displayText !== undefined || clientSendId || userEventSubtype
          ? createQueuedMessage(text, options.priority ?? 'normal', images, displayText, clientSendId, userEventSubtype)
          : createQueuedMessage(text, options.priority ?? 'normal', images)
        const queued = enqueueQueuedMessage(session, message)
        if (!queued.ok) {
          return {
            ok: false,
            code: 'queue_rejected',
            error: queued.error,
            retryable: false,
          }
        }
        scheduleQueuedMessageDrain(session)
        return { ok: true, disposition: 'queued' }
      }

      const result = displayText !== undefined || clientSendId || userEventSubtype
        ? await sendImmediateTextToStreamSession(session, text, images, displayText, clientSendId, userEventSubtype)
        : await sendImmediateTextToStreamSession(session, text, images)
      if (!result.ok) {
        return {
          ok: false,
          code: result.code
            ?? (result.error === 'Stream session unavailable' ? 'session_unavailable' : 'interrupt_unavailable'),
          error: result.error,
          retryable: result.retryable,
        }
      }
      return { ok: true, disposition: result.disposition }
    },

    recordSessionEvent(name, event) {
      const session = sessions.get(name)
      if (!session || session.kind !== 'stream') {
        return false
      }

      session.lastEventAt = new Date().toISOString()
      session.events.push(event)
      const handlers = sessionEventHandlers.get(name)
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(event)
          } catch {
            // Session event observers must not interrupt commander routing.
          }
        }
      }
      const payload = JSON.stringify(event)
      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload)
        }
      }
      schedulePersistedSessionsWrite()
      return true
    },

    deleteSession(name) {
      const session = sessions.get(name)
      if (!session) {
        return
      }

      for (const client of session.clients) {
        client.close(1000, 'Commander stopped')
      }

      if (session.kind === 'stream') {
        void teardownProviderSession(session, `Commander stopped session "${name}"`)
      } else if (session.kind === 'pty') {
        session.pty.kill()
      }
      // External sessions have no local process.

      sessions.delete(name)
      sessionEventHandlers.delete(name)
      schedulePersistedSessionsWrite()
    },

    getSession(name) {
      const session = sessions.get(name)
      return session?.kind === 'stream' ? session : undefined
    },

    getCredentialRecoveryRequest,

    clearCredentialRecoveryRequest,

    getActiveCredentialPoolId,

    subscribeToEvents(name, handler) {
      let handlers = sessionEventHandlers.get(name)
      if (!handlers) {
        handlers = new Set()
        sessionEventHandlers.set(name, handlers)
      }
      handlers.add(handler)
      return () => {
        const currentHandlers = sessionEventHandlers.get(name)
        if (!currentHandlers) {
          return
        }
        currentHandlers.delete(handler)
        if (currentHandlers.size === 0) {
          sessionEventHandlers.delete(name)
        }
      }
    },

    async shutdown() {
      await shutdownProviderRuntimes()
    },
  }
}
