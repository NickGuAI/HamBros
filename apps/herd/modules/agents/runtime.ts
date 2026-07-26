import { createAgentsRouter } from './routes.js'
import { listProviders } from './providers/registry.js'
import type {
  ModuleRouteRegistration,
  ModuleRuntimeContext,
} from '../../server/module-runtime.js'

export function createAgentsRuntime(context: ModuleRuntimeContext): ModuleRouteRegistration {
  const {
    approvalBridgeSigningSecret,
    capabilities,
    internalToken,
    machineEnrollmentSigningSecret,
    options,
  } = context
  const initializeAgentSessionRuntimes = options.initializeAgentSessionRuntimes !== false
  if (!options.sqliteDb) {
    throw new Error('SQLite runtime-session database is required for agents runtime')
  }

  capabilities.provide('agents.provider-registry', 'agents', { listProviders })

  const agents = createAgentsRouter({
    apiKeyStore: options.apiKeyStore,
    autoResumeSessions: initializeAgentSessionRuntimes,
    enableSessionPruner: initializeAgentSessionRuntimes,
    sqliteDb: options.sqliteDb,
    getActionPolicyGate: () => capabilities.consume('policies.action-gate', 'agents'),
    maxSessions: options.maxAgentSessions,
    internalToken,
    approvalBridgeSigningSecret,
    machineEnrollmentSigningSecret,
    commanderSessionStore: capabilities.consume('commanders.store', 'agents'),
    commanderDataDir: capabilities.consume('commanders.data-dir', 'agents'),
    commanderConversationStore: capabilities.consume('commanders.conversations', 'agents'),
    buildCommanderSessionSeed: capabilities.consume('commanders.session-seed-builder', 'agents'),
    commanderTranscriptAppender: capabilities.consume('commanders.transcripts', 'agents'),
    questStore: capabilities.consume('commanders.quest-store', 'agents'),
    getWorkspaceResolver: () => capabilities.consume('workspace.resolver', 'agents'),
  })

  capabilities.provide('agents.sessions', 'agents', agents.sessionsInterface)
  capabilities.provide('agents.sessions-interface', 'agents', agents.sessionsInterface)
  capabilities.provide('agents.approval-sessions-interface', 'agents', agents.approvalSessionsInterface)
  capabilities.provide('agents.session-websocket', 'agents', agents.handleUpgrade)
  capabilities.provide('agents.machine-command-executor', 'agents', agents.machineCommandExecutor)
  capabilities.provide('agents.provider-execution', 'agents', agents.providerExecution)
  capabilities.provide('agents.runtime', 'agents', agents)

  return {
    name: 'agents',
    routeIds: ['agents.api'],
    router: agents.router,
    handleUpgrade: agents.handleUpgrade,
    shutdown: agents.sessionsInterface.shutdown,
  }
}
