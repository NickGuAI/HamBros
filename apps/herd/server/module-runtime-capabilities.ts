import type { Router } from 'express'
import type { ApiKeyStoreLike, ApiKeyScope } from './api-keys/store.js'
import type { ProviderSecretsStoreLike } from './api-keys/provider-secrets-store.js'
import type { AgentsRouterResult } from '../modules/agents/routes.js'
import type { CommanderSessionsInterface, ApprovalSessionsInterface } from '../modules/agents/types.js'
import type { MachineCommandExecutor } from '../modules/agents/machine-command-executor.js'
import type { EvalAdapterPreflight } from '../modules/eval/adapter-preflight.js'
import type { AutomationExecutor } from '../modules/automations/executor.js'
import type { AutomationQuestEventBus } from '../modules/automations/quest-event-bus.js'
import type { AutomationScheduler } from '../modules/automations/scheduler.js'
import type { AutomationStore } from '../modules/automations/store.js'
import type { CommanderChannelBindingStore } from '../modules/channels/store.js'
import type { ConversationStore } from '../modules/commanders/conversation-store.js'
import type { QuestStore } from '../modules/commanders/quest-store.js'
import type { createCommanderTranscriptAppender } from '../modules/commanders/transcripts.js'
import type { CommandersRouterResult } from '../modules/commanders/routes.js'
import type { CommanderSessionStore } from '../modules/commanders/store.js'
import type { CommanderSessionSeedParams } from '../modules/commanders/memory/module.js'
import type { OperatorStore } from '../modules/operators/store.js'
import type { ActionPolicyGate } from '../modules/policies/action-policy-gate.js'
import type { ApprovalCoordinator } from '../modules/policies/pending-store.js'
import type { PolicyStore } from '../modules/policies/store.js'
import type { AppSettingsStore } from '../modules/settings/store.js'
import type { TelemetryHub, TelemetryRouterResult } from '../modules/telemetry/routes.js'
import type { ProviderAdapter } from '../modules/agents/providers/provider-adapter.js'
import type { ProviderExecutionCapability } from '../modules/agents/provider-execution-mode.js'
import type {
  WorkspaceMachineDescriptorCapability,
  WorkspaceResolverCapability,
} from '../modules/workspace/capability.js'

export interface ProviderRegistryCapability {
  listProviders(): readonly ProviderAdapter[]
}

export interface AuthApiKeysCapability {
  store?: ApiKeyStoreLike
  scopes: readonly ApiKeyScope[]
}

export interface HerdRuntimeCapabilities {
  'auth.api-keys': AuthApiKeysCapability
  'api-key-store': ApiKeyStoreLike | undefined
  'settings.provider-secrets': ProviderSecretsStoreLike
  'provider-secrets-store': ProviderSecretsStoreLike

  'agents.provider-registry': ProviderRegistryCapability
  'agents.sessions': AgentsRouterResult['sessionsInterface']
  'agents.sessions-interface': CommanderSessionsInterface
  'agents.approval-sessions-interface': ApprovalSessionsInterface
  'agents.session-websocket': AgentsRouterResult['handleUpgrade']
  'agents.machine-command-executor': MachineCommandExecutor
  'agents.provider-execution': ProviderExecutionCapability
  'agents.runtime': AgentsRouterResult

  'eval.adapter-preflight': EvalAdapterPreflight

  'policies.store': PolicyStore
  'policies.action-gate': ActionPolicyGate
  'policies.approval-coordinator': ApprovalCoordinator

  'approvals.pending-stream': Router

  'commanders.store': CommanderSessionStore
  'commanders.conversations': ConversationStore
  'commanders.quest-store': QuestStore
  'commanders.runtime': CommandersRouterResult
  'commanders.data-dir': string
  'commanders.session-seed-builder': (
    params: Omit<CommanderSessionSeedParams, 'memoryBasePath'>,
  ) => Promise<{ systemPrompt?: string; maxTurns?: number }>
  'commanders.transcripts': ReturnType<typeof createCommanderTranscriptAppender>

  'channels.bindings': CommanderChannelBindingStore
  'channels.ingest': Router

  'automations.store': AutomationStore
  'automations.executor': AutomationExecutor
  'automations.scheduler': AutomationScheduler
  'automations.scheduler-initialized': Promise<void>
  'automations.quest-event-bus': AutomationQuestEventBus

  'operators.store': OperatorStore
  'settings.app-settings': AppSettingsStore | undefined

  'telemetry.hub': TelemetryHub
  'telemetry.store': TelemetryRouterResult['store']

  'workspace.machineDescriptor': WorkspaceMachineDescriptorCapability
  'workspace.resolver': WorkspaceResolverCapability
}
