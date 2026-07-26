import { registerProvider } from '../../providers/registry-core.js'
import {
  asCodexProviderContext,
  createCodexProviderContext,
  ensureCodexProviderContext,
} from '../../providers/provider-session-context.js'
import type {
  ProviderAdapter,
  ProviderAdapterDeps,
  ProviderCreateOptions,
  ProviderTeardownOptions,
} from '../../providers/provider-adapter.js'
import type {
  ExitedStreamSessionState,
  PersistedStreamSession,
  StreamSession,
} from '../../types.js'
import { codexMachineProvider } from './machine-adapter.js'
import { codexApprovalAdapter } from './approval-adapter.js'
import { clearCodexTurnWatchdog } from './helpers.js'
import { availableModels } from './models.js'
import { discoverCodexModels } from './model-discovery.js'
import {
  createCodexSessionAdapter,
  createCodexAppServerSession,
  shutdownCodexRuntimes,
  teardownCodexSessionRuntime,
} from './session.js'

function snapshotCodexSession(
  session: StreamSession,
): PersistedStreamSession | null {
  const context = asCodexProviderContext(session.providerContext)
  if (!context?.threadId) {
    return null
  }

  return {
    name: session.name,
    sessionType: session.sessionType,
    creator: session.creator,
    conversationId: session.conversationId,
    agentType: session.agentType,
    model: session.model,
    effort: session.effort,
    mode: session.mode,
    cwd: session.cwd,
    host: session.host,
    currentSkillInvocation: session.currentSkillInvocation
      ? { ...session.currentSkillInvocation }
      : undefined,
    createdAt: session.createdAt,
    providerContext: createCodexProviderContext({
      threadId: context.threadId,
      codexHome: context.codexHome,
      effort: session.effort,
    }),
    credentialPoolId: session.credentialPoolId,
    credentialPoolMode: session.credentialPoolMode,
    credentialPoolRecovery: session.credentialPoolRecovery,
    activeTurnId: session.activeTurnId,
    spawnedBy: session.spawnedBy,
    spawnedWorkers: [...session.spawnedWorkers],
    resumedFrom: session.resumedFrom,
    sessionState: 'active',
    hadResult: Boolean(session.finalResultEvent),
    conversationEntryCount: session.conversationEntryCount,
    events: [...session.events],
    queuedMessages: session.messageQueue.list(),
    currentQueuedMessage: session.currentQueuedMessage,
    pendingDirectSendMessages: [...session.pendingDirectSendMessages],
    activeTurnMessage: session.activeTurnMessage,
  }
}

function snapshotExitedCodexSession(session: StreamSession): ExitedStreamSessionState {
  const context = ensureCodexProviderContext(session)
  return {
    phase: 'exited',
    hadResult: Boolean(session.finalResultEvent),
    sessionType: session.sessionType,
    creator: session.creator,
    conversationId: session.conversationId,
    agentType: session.agentType,
    model: session.model,
    effort: session.effort,
    mode: session.mode,
    cwd: session.cwd,
    host: session.host,
    currentSkillInvocation: session.currentSkillInvocation
      ? { ...session.currentSkillInvocation }
      : undefined,
    spawnedBy: session.spawnedBy,
    spawnedWorkers: [...session.spawnedWorkers],
    createdAt: session.createdAt,
    providerContext: createCodexProviderContext({
      threadId: context.threadId,
      codexHome: context.codexHome,
      effort: session.effort,
    }),
    credentialPoolId: session.credentialPoolId,
    credentialPoolMode: session.credentialPoolMode,
    credentialPoolRecovery: session.credentialPoolRecovery,
    activeTurnId: session.activeTurnId,
    resumedFrom: session.resumedFrom,
    conversationEntryCount: session.conversationEntryCount,
    events: [...session.events],
    queuedMessages: session.messageQueue.list(),
    currentQueuedMessage: session.currentQueuedMessage,
    pendingDirectSendMessages: [...session.pendingDirectSendMessages],
    activeTurnMessage: session.activeTurnMessage,
  }
}

export const codexProvider: ProviderAdapter = registerProvider({
  id: 'codex',
  label: 'Codex',
  eventProvider: 'codex',
  approvalAdapter: codexApprovalAdapter,
  capabilities: {
    supportsAutomation: true,
    supportsCommanderConversation: true,
    supportsWorkerDispatch: true,
    supportsMessageImages: true,
  },
  availableModels,
  modelDiscovery: {
    discover: discoverCodexModels,
    catalogScope: 'provider',
    authoritativeDynamicModels: true,
  },
  machineAuth: codexMachineProvider,
  uiCapabilities: {
    supportsEffort: true,
    supportsAdaptiveThinking: false,
    supportsMaxThinkingTokens: false,
    supportsSkills: false,
    supportsLoginMode: true,
    permissionModes: [
      {
        value: 'default',
        label: 'default',
        description: 'Codex approval requests route through Herd action policies',
      },
      {
        value: 'acceptEdits',
        label: 'acceptEdits',
        description: 'Codex approval requests route through Herd action policies',
      },
      {
        value: 'bypassPermissions',
        label: 'bypassPermissions',
        description: 'Codex runs without approval prompts for explicitly autonomous workers',
      },
    ],
  },
  skillScanPaths: ['~/.codex/skills'],
  buildStreamSessionAdapter(deps: ProviderAdapterDeps) {
    return createCodexSessionAdapter(deps)
  },
  preparePtyEnv() {
    return {}
  },
  runtimeWatchdog(session) {
    return {
      teardown: () => {
        clearCodexTurnWatchdog(session)
      },
    }
  },
  create(options: ProviderCreateOptions, deps: ProviderAdapterDeps) {
    const cwd = options.cwd ?? process.env.HOME ?? '/tmp'
    return createCodexAppServerSession(
      options.sessionName,
      options.mode,
      options.task,
      cwd,
      {
        resumeSessionId: options.resumeSessionId,
        systemPrompt: options.systemPrompt,
        model: options.model,
        effort: options.effort,
        createdAt: options.createdAt,
        spawnedBy: options.spawnedBy,
        spawnedWorkers: options.spawnedWorkers,
        resumedFrom: options.resumedFrom,
        machine: options.machine,
        sessionType: options.sessionType,
        creator: options.creator,
        conversationId: options.conversationId,
        currentSkillInvocation: options.currentSkillInvocation,
        providerAuth: options.providerAuth,
      },
      deps,
    )
  },
  restore(entry, machine, deps, providerAuth) {
    const context = asCodexProviderContext(entry.providerContext)
    return this.create({
      sessionName: entry.name,
      mode: entry.mode,
      task: '',
      cwd: entry.cwd,
      machine,
      resumeSessionId: context?.threadId,
      systemPrompt: undefined,
      model: entry.model,
      effort: entry.effort,
      createdAt: entry.createdAt,
      spawnedBy: entry.spawnedBy,
      spawnedWorkers: entry.spawnedWorkers,
      resumedFrom: entry.resumedFrom,
      sessionType: entry.sessionType,
      creator: entry.creator,
      conversationId: entry.conversationId,
      currentSkillInvocation: entry.currentSkillInvocation,
      providerAuth,
    }, deps)
  },
  snapshotForPersist(session) {
    return snapshotCodexSession(session)
  },
  snapshotExited(session) {
    return snapshotExitedCodexSession(session)
  },
  hasResumeIdentifier(entry) {
    return Boolean(asCodexProviderContext(entry.providerContext)?.threadId)
  },
  canResumeLiveSession(session) {
    const context = asCodexProviderContext(session.providerContext)
    return Boolean(context?.threadId && session.codexTurnStaleAt)
  },
  getResumeId(session) {
    return asCodexProviderContext(session.providerContext)?.threadId
  },
  transcriptId(session) {
    return this.getResumeId(session) ?? session.name
  },
  teardown(session, reason, options?: ProviderTeardownOptions) {
    return teardownCodexSessionRuntime(session, reason, options)
  },
  async shutdownFleet(sessions, reason) {
    await Promise.allSettled(
      [...sessions]
        .filter((session) => session.agentType === 'codex')
        .map(async (session) => teardownCodexSessionRuntime(session, reason ?? 'Herd shutdown')),
    )
  },
})
