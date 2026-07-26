import { useEffect } from 'react'
import type {
  AgentType,
  ProviderRegistryEntry,
  SessionTransportType,
} from '@/types'
import { getProviderControlDefaults } from '@/hooks/use-providers'
import type { ClaudeAdaptiveThinkingMode } from '../../../claude-adaptive-thinking.js'
import {
  getAgentEffortLevelsForModel,
  getDefaultAgentEffortForModel,
  type AgentEffortLevel,
} from '../../effort.js'
import type { ClaudeMaxThinkingTokens } from '../../../claude-max-thinking-tokens.js'

interface UseNewSessionConstraintsOptions {
  providers: readonly ProviderRegistryEntry[]
  agentType: AgentType
  model?: string | null
  setAgentType: (value: AgentType) => void
  transportType: Exclude<SessionTransportType, 'external'>
  setTransportType: (value: Exclude<SessionTransportType, 'external'>) => void
  effort: AgentEffortLevel
  setEffort: (value: AgentEffortLevel) => void
  adaptiveThinking: ClaudeAdaptiveThinkingMode
  setAdaptiveThinking: (value: ClaudeAdaptiveThinkingMode) => void
  maxThinkingTokens: ClaudeMaxThinkingTokens
  setMaxThinkingTokens: (value: ClaudeMaxThinkingTokens) => void
}

function findProvider(
  providers: readonly ProviderRegistryEntry[],
  agentType: AgentType,
): ProviderRegistryEntry | null {
  return providers.find((provider) => provider.id === agentType) ?? null
}

export function getFallbackAgent(
  providers: readonly ProviderRegistryEntry[],
  agentType: AgentType,
): AgentType | null {
  if (providers.some((provider) => provider.id === agentType)) {
    return null
  }

  return providers[0]?.id ?? null
}

export function getForcedTransportType(
  providers: readonly ProviderRegistryEntry[],
  agentType: AgentType,
  transportType: Exclude<SessionTransportType, 'external'>,
): Exclude<SessionTransportType, 'external'> | null {
  const forcedTransport = findProvider(providers, agentType)?.uiCapabilities.forcedTransport
  return forcedTransport && transportType !== forcedTransport ? forcedTransport : null
}

export function getNormalizedEffort(
  providers: readonly ProviderRegistryEntry[],
  agentType: AgentType,
  model: string | null | undefined,
  effort: AgentEffortLevel,
): AgentEffortLevel | null {
  const provider = findProvider(providers, agentType)
  const defaultEffort = getProviderControlDefaults(provider).effort
  if (!provider?.uiCapabilities.supportsEffort) {
    return effort !== defaultEffort ? defaultEffort : null
  }
  const effectiveModel = model ?? provider.defaults?.model ?? null
  const modelOption = provider.availableModels?.find((option) => option.id === effectiveModel)
  const effortOptions = getAgentEffortLevelsForModel(agentType, modelOption)
  if (effortOptions.includes(effort)) {
    return null
  }
  return getDefaultAgentEffortForModel(
    agentType,
    modelOption,
    provider.defaults?.effort,
  ) ?? null
}

export function getNormalizedAdaptiveThinking(
  providers: readonly ProviderRegistryEntry[],
  agentType: AgentType,
  adaptiveThinking: ClaudeAdaptiveThinkingMode,
): ClaudeAdaptiveThinkingMode | null {
  const provider = findProvider(providers, agentType)
  const defaultAdaptiveThinking = getProviderControlDefaults(provider).adaptiveThinking
  return !provider?.uiCapabilities.supportsAdaptiveThinking && adaptiveThinking !== defaultAdaptiveThinking
    ? defaultAdaptiveThinking
    : null
}

export function getNormalizedMaxThinkingTokens(
  providers: readonly ProviderRegistryEntry[],
  agentType: AgentType,
  maxThinkingTokens: ClaudeMaxThinkingTokens,
): ClaudeMaxThinkingTokens | null {
  const provider = findProvider(providers, agentType)
  const defaultMaxThinkingTokens = getProviderControlDefaults(provider).maxThinkingTokens
  return !provider?.uiCapabilities.supportsMaxThinkingTokens && maxThinkingTokens !== defaultMaxThinkingTokens
    ? defaultMaxThinkingTokens
    : null
}

export function useNewSessionConstraints({
  providers,
  agentType,
  model,
  setAgentType,
  transportType,
  setTransportType,
  effort,
  setEffort,
  adaptiveThinking,
  setAdaptiveThinking,
  maxThinkingTokens,
  setMaxThinkingTokens,
}: UseNewSessionConstraintsOptions) {
  useEffect(() => {
    const fallbackAgent = getFallbackAgent(providers, agentType)
    if (fallbackAgent) {
      setAgentType(fallbackAgent)
    }
  }, [providers, agentType, setAgentType])

  useEffect(() => {
    const nextTransportType = getForcedTransportType(providers, agentType, transportType)
    if (nextTransportType) {
      setTransportType(nextTransportType)
    }
  }, [providers, agentType, setTransportType, transportType])

  useEffect(() => {
    const nextEffort = getNormalizedEffort(providers, agentType, model, effort)
    if (nextEffort) {
      setEffort(nextEffort)
    }
  }, [providers, agentType, effort, model, setEffort])

  useEffect(() => {
    const nextAdaptiveThinking = getNormalizedAdaptiveThinking(providers, agentType, adaptiveThinking)
    if (nextAdaptiveThinking) {
      setAdaptiveThinking(nextAdaptiveThinking)
    }
  }, [providers, adaptiveThinking, agentType, setAdaptiveThinking])

  useEffect(() => {
    const nextMaxThinkingTokens = getNormalizedMaxThinkingTokens(providers, agentType, maxThinkingTokens)
    if (nextMaxThinkingTokens) {
      setMaxThinkingTokens(nextMaxThinkingTokens)
    }
  }, [providers, maxThinkingTokens, agentType, setMaxThinkingTokens])
}
