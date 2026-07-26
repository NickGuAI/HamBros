import {
  CLAUDE_EFFORT_LEVELS,
  DEFAULT_CLAUDE_EFFORT_LEVEL,
  type ClaudeEffortLevel,
} from '../claude-effort.js'

// Codex reports an ordered effort vocabulary per model through app-server
// model/list. Keep the value opaque so a Codex upgrade does not require a
// matching Herd release.
export type CodexEffortLevel = string
export type AgentEffortLevel = ClaudeEffortLevel | CodexEffortLevel

export function getAgentEffortLevels(agentType: string): readonly AgentEffortLevel[] {
  if (agentType === 'claude') {
    return CLAUDE_EFFORT_LEVELS
  }
  return []
}

export function getAgentEffortLevelsForModel(
  agentType: string,
  model: {
    supportsEffort?: boolean
    supportedEffortLevels?: readonly string[]
  } | null | undefined,
): AgentEffortLevel[] {
  return getAgentModelEffortCapability(agentType, model).supportedEffortLevels
}

export function getAgentModelEffortCapability(
  agentType: string,
  model: {
    supportsEffort?: boolean
    supportedEffortLevels?: readonly string[]
  } | null | undefined,
): {
  supportsEffort: boolean
  supportedEffortLevels: AgentEffortLevel[]
} {
  if (model?.supportsEffort === false) {
    return { supportsEffort: false, supportedEffortLevels: [] }
  }

  if (agentType === 'codex') {
    const supportedEffortLevels = [...new Set(
      (model?.supportedEffortLevels ?? []).flatMap((level) => {
        if (typeof level !== 'string') {
          return []
        }
        const normalized = level.trim()
        return normalized ? [normalized] : []
      }),
    )]
    return {
      supportsEffort: supportedEffortLevels.length > 0,
      supportedEffortLevels,
    }
  }

  const providerLevels = getAgentEffortLevels(agentType)
  if (providerLevels.length === 0) {
    return { supportsEffort: false, supportedEffortLevels: [] }
  }
  const modelLevels = (model?.supportedEffortLevels ?? [])
    .filter((level): level is AgentEffortLevel => providerLevels.includes(level as AgentEffortLevel))
  if (model?.supportedEffortLevels !== undefined) {
    return {
      supportsEffort: modelLevels.length > 0,
      supportedEffortLevels: modelLevels,
    }
  }
  const supportedEffortLevels = [...providerLevels]
  return {
    supportsEffort: supportedEffortLevels.length > 0,
    supportedEffortLevels,
  }
}

export function getDefaultAgentEffortForModel(
  agentType: string,
  model: {
    supportsEffort?: boolean
    supportedEffortLevels?: readonly string[]
    defaultEffort?: string
  } | null | undefined,
  providerDefault: unknown = getDefaultAgentEffort(agentType),
): AgentEffortLevel | undefined {
  const supportedEffortLevels = getAgentEffortLevelsForModel(agentType, model)
  if (supportedEffortLevels.length === 0) {
    return undefined
  }
  const modelDefault = parseOptionalAgentEffort(agentType, model?.defaultEffort)
  if (modelDefault && supportedEffortLevels.includes(modelDefault)) {
    return modelDefault
  }
  const parsedProviderDefault = parseOptionalAgentEffort(agentType, providerDefault)
  if (parsedProviderDefault && supportedEffortLevels.includes(parsedProviderDefault)) {
    return parsedProviderDefault
  }
  return agentType === 'codex' ? undefined : supportedEffortLevels[0]
}

export function getDefaultAgentEffort(agentType: string): AgentEffortLevel | undefined {
  if (agentType === 'claude') {
    return DEFAULT_CLAUDE_EFFORT_LEVEL
  }
  return undefined
}

export function parseOptionalAgentEffort(
  agentType: string,
  value: unknown,
): AgentEffortLevel | undefined | null {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (agentType === 'codex') {
    if (typeof value !== 'string') {
      return null
    }
    const normalized = value.trim()
    return normalized || null
  }
  return getAgentEffortLevels(agentType).includes(value as AgentEffortLevel)
    ? value as AgentEffortLevel
    : null
}

/** Parse persisted runtime state without rewriting provider-owned values. */
export function parseStoredAgentEffort(
  agentType: string,
  value: unknown,
): AgentEffortLevel | undefined {
  const parsed = parseOptionalAgentEffort(agentType, value)
  if (parsed) {
    return parsed
  }
  return undefined
}

export function normalizeAgentEffort(
  agentType: string,
  value: unknown,
  fallback: AgentEffortLevel | undefined = getDefaultAgentEffort(agentType),
): AgentEffortLevel | undefined {
  const parsed = parseStoredAgentEffort(agentType, value)
  if (parsed) {
    return parsed
  }
  return parseOptionalAgentEffort(agentType, fallback) ?? undefined
}
