import type { AgentType } from '../agents/types.js'

export type ConversationCredentialSelectionMode =
  | 'global-local'
  | 'per-conversation'
  | 'none'

export type ConversationCredentialSelectionModes = Record<
  AgentType,
  ConversationCredentialSelectionMode
>

/**
 * Canonical backend policy for conversation-level credential selection.
 *
 * `executionTarget` is execution placement (`executionMachineId` for an idle
 * commander or the live session host), never the commander's identity host.
 */
export function resolveConversationCredentialSelectionMode(
  agentType: AgentType,
  executionTarget?: string | null,
): ConversationCredentialSelectionMode {
  if (agentType === 'codex') {
    return 'per-conversation'
  }
  if (agentType !== 'claude') {
    return 'none'
  }

  const target = executionTarget?.trim()
  return target && target !== 'local'
    ? 'per-conversation'
    : 'global-local'
}

export function buildConversationCredentialSelectionModes(
  agentTypes: readonly AgentType[],
  executionTarget?: string | null,
): ConversationCredentialSelectionModes {
  return Object.fromEntries(agentTypes.map((agentType) => [
    agentType,
    resolveConversationCredentialSelectionMode(agentType, executionTarget),
  ]))
}
