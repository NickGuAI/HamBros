// AgentSessionClient has been extracted to @gehirn/ai-services.
// This module re-exports everything for backward compatibility.
export type {
  AgentSessionTransportMode,
  AgentSessionKind,
  AgentType,
  SessionCompletionStatus,
  SessionRuntimeState,
  AgentSessionCreateInput,
  CreatedAgentSession,
  AgentSessionCompletion,
  AgentSessionProgress,
  AgentSessionMonitorOptions,
  AgentSessionClientOptions,
} from '@gehirn/ai-services'
export { AgentSessionClient } from '@gehirn/ai-services'
