export type {
  AgentProvider,
  AgentCallSettings,
  AgentEvent,
  AgentUsage,
  McpServerConfig,
} from './types'

export { runClaude } from './claude-adapter'
export { runCodex } from './codex-adapter'

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
} from './agent-session-client'
export { AgentSessionClient } from './agent-session-client'

import type { AgentProvider, AgentCallSettings, AgentEvent } from './types'
import { runClaude } from './claude-adapter'
import { runCodex } from './codex-adapter'

/**
 * Unified agent call that routes to the appropriate provider.
 *
 * @example
 * ```ts
 * import { agentCall } from '@hambros/ai-services'
 *
 * for await (const event of agentCall('Fix the failing tests', 'claude', { passive: true })) {
 *   if (event.type === 'text') console.log(event.content)
 * }
 * ```
 */
export async function* agentCall(
  prompt: string,
  provider: AgentProvider,
  settings: AgentCallSettings = {},
): AsyncGenerator<AgentEvent> {
  switch (provider) {
    case 'claude':
      yield* runClaude(prompt, settings)
      break
    case 'codex':
      yield* runCodex(prompt, settings)
      break
    default:
      yield { type: 'error', content: `Unknown provider: ${provider}` }
  }
}
