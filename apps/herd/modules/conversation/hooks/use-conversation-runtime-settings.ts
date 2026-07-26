import { useCallback, useEffect, useMemo, useState } from 'react'
import { useProviderModels } from '@/hooks/use-providers'
import type { AgentType, ProviderModelOption, ProviderRegistryEntry } from '@/types'
import {
  getAgentEffortLevelsForModel,
  getDefaultAgentEffortForModel,
  type AgentEffortLevel,
} from '@modules/agents/effort.js'
import {
  CLAUDE_ADAPTIVE_THINKING_MODES,
  DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE,
  type ClaudeAdaptiveThinkingMode,
} from '@modules/claude-adaptive-thinking.js'
import {
  DEFAULT_CLAUDE_MAX_THINKING_TOKENS,
  MAX_CLAUDE_MAX_THINKING_TOKENS,
  MIN_CLAUDE_MAX_THINKING_TOKENS,
} from '@modules/claude-max-thinking-tokens.js'
import type {
  ConversationRecord,
  UpdateConversationInput,
} from './use-conversations'

export interface ConversationRuntimeSettingsDraft {
  agentType: AgentType
  model: string | null
  credentialPoolId: string | null
  effort: AgentEffortLevel | null
  adaptiveThinking: ClaudeAdaptiveThinkingMode | null
  maxThinkingTokens: number | null
}

function toDraft(
  conversation: ConversationRecord | null | undefined,
): ConversationRuntimeSettingsDraft | null {
  const settings = conversation?.runtimeSettings
  const current = settings?.current
  if (!settings || !current) {
    return null
  }
  const credentialSelectionAllowed =
    settings.credentialSelectionModes?.[current.agentType] === 'per-conversation'
  return {
    ...current,
    credentialPoolId: credentialSelectionAllowed
      ? conversation.liveSession?.credentialPoolId
        ?? conversation.credentialPoolId
        ?? null
      : null,
  }
}

function getModelEffortLevels(
  agentType: AgentType,
  model: ProviderModelOption | null | undefined,
): AgentEffortLevel[] {
  return getAgentEffortLevelsForModel(agentType, model)
}

function resolveModelEffort(
  agentType: AgentType,
  provider: ProviderRegistryEntry | null,
  model: ProviderModelOption | null | undefined,
): AgentEffortLevel | null {
  const allowedLevels = getModelEffortLevels(agentType, model)
  if (provider?.uiCapabilities.supportsEffort !== true || allowedLevels.length === 0) {
    return null
  }
  return getDefaultAgentEffortForModel(agentType, model, provider.defaults.effort) ?? null
}

function mergeModelOptions(
  provider: ProviderRegistryEntry | null,
  readModelOptions: ProviderModelOption[],
): ProviderModelOption[] {
  const merged = new Map<string, ProviderModelOption>()
  for (const option of provider?.availableModels ?? []) {
    if (!option.deprecated) {
      merged.set(option.id, option)
    }
  }
  for (const option of readModelOptions) {
    const existing = merged.get(option.id)
    merged.set(option.id, existing ? { ...existing, ...option } : option)
  }
  return [...merged.values()]
}

export function useConversationRuntimeSettings(
  conversation: ConversationRecord | null | undefined,
  providers: readonly ProviderRegistryEntry[],
) {
  const settings = conversation?.runtimeSettings
  const credentialSelectionModesKey = Object.entries(
    settings?.credentialSelectionModes ?? {},
  )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, mode]) => `${provider}:${mode}`)
    .join('|')
  const [draft, setDraft] = useState<ConversationRuntimeSettingsDraft | null>(() => (
    toDraft(conversation)
  ))

  useEffect(() => {
    setDraft(toDraft(conversation))
  }, [
    conversation?.id,
    credentialSelectionModesKey,
    settings?.current.adaptiveThinking,
    settings?.current.agentType,
    settings?.current.effort,
    settings?.current.maxThinkingTokens,
    settings?.current.model,
    conversation?.credentialPoolId,
    conversation?.liveSession?.credentialPoolId,
    conversation?.liveSession?.host,
  ])

  const providerOptions = useMemo(() => {
    const allowed = new Set(settings?.options.agentType ?? [])
    return allowed.size > 0
      ? providers.filter((provider) => allowed.has(provider.id))
      : [...providers]
  }, [providers, settings?.options.agentType])

  const selectedProvider = providerOptions.find((provider) => provider.id === draft?.agentType) ?? null
  const credentialSelectionMode = draft?.agentType
    ? settings?.credentialSelectionModes?.[draft.agentType] ?? 'none'
    : 'none'
  const credentialSelectionAllowed = credentialSelectionMode === 'per-conversation'
  const currentCredentialSelectionAllowed = settings
    ? settings.credentialSelectionModes?.[settings.current.agentType] === 'per-conversation'
    : false
  const currentCredentialPoolId = currentCredentialSelectionAllowed
    ? conversation?.liveSession?.credentialPoolId
      ?? conversation?.credentialPoolId
      ?? null
    : null
  const selectedCredentialPoolId = credentialSelectionAllowed
    ? draft?.credentialPoolId ?? null
    : null
  const modelCatalogScope = selectedProvider?.modelCatalogScope ?? 'credential'
  const modelCredentialPoolId = modelCatalogScope === 'provider'
    ? undefined
    : selectedCredentialPoolId ?? undefined
  const providerModels = useProviderModels(selectedProvider?.id, modelCredentialPoolId)
  const modelDiscovery = providerModels.data?.modelDiscovery
    ?? (
      selectedProvider?.id === settings?.current.agentType
      && selectedCredentialPoolId === currentCredentialPoolId
        ? settings?.modelDiscovery
        : undefined
    )
    ?? (modelCredentialPoolId === undefined ? selectedProvider?.modelDiscovery : undefined)
    ?? null
  const effectiveCredentialPoolId = credentialSelectionAllowed
    ? selectedCredentialPoolId
      ?? (modelCatalogScope === 'credential' ? modelDiscovery?.credentialPoolId : null)
      ?? null
    : null
  const shouldSendCredentialPoolId = Boolean(
    credentialSelectionAllowed
    && effectiveCredentialPoolId
    && (
      draft?.agentType !== settings?.current.agentType
      || selectedCredentialPoolId !== currentCredentialPoolId
    ),
  )
  const modelOptions = useMemo(() => mergeModelOptions(
    selectedProvider
      ? {
          ...selectedProvider,
          availableModels: providerModels.data?.availableModels ?? selectedProvider.availableModels,
        }
      : null,
    selectedProvider?.id === settings?.current.agentType
      && selectedCredentialPoolId === currentCredentialPoolId
      ? settings?.options.model ?? []
      : [],
  ), [
    currentCredentialPoolId,
    providerModels.data?.availableModels,
    selectedCredentialPoolId,
    selectedProvider,
    settings,
  ])
  const selectedModel = modelOptions.find((model) => (
    model.id === draft?.model
    || model.resolvedModel === draft?.model
    || (draft?.model ? model.aliases?.includes(draft.model) === true : false)
  )) ?? null
  const defaultModel = modelOptions.find((model) => model.default)
    ?? modelOptions.find((model) => model.id === selectedProvider?.defaults.model)
    ?? modelOptions[0]
    ?? null
  const controlModel = selectedModel ?? (draft?.model === null ? defaultModel : null)
  const usesCurrentRuntimeSelection = Boolean(
    draft
    && settings
    && draft.agentType === settings.current.agentType
    && draft.model === settings.current.model
    && selectedCredentialPoolId === currentCredentialPoolId
  )
  const effortOptions = useMemo(() => {
    if (usesCurrentRuntimeSelection) {
      return settings?.options.effort ?? []
    }
    return selectedProvider ? getModelEffortLevels(selectedProvider.id, controlModel) : []
  }, [controlModel, selectedProvider, settings, usesCurrentRuntimeSelection])
  const supportsEffort = selectedProvider?.uiCapabilities.supportsEffort === true
    && effortOptions.length > 0
    && (!usesCurrentRuntimeSelection || settings?.supported.effort === true)
  const supportsAdaptiveThinking = selectedProvider?.uiCapabilities.supportsAdaptiveThinking === true
    && controlModel?.supportsAdaptiveThinking !== false
    && (!usesCurrentRuntimeSelection || settings?.supported.adaptiveThinking === true)
  const supportsMaxThinkingTokens = selectedProvider?.uiCapabilities.supportsMaxThinkingTokens === true
    && (!usesCurrentRuntimeSelection || settings?.supported.maxThinkingTokens === true)
  const maxThinkingTokensRange = supportsMaxThinkingTokens
    ? settings?.options.maxThinkingTokens ?? {
      min: MIN_CLAUDE_MAX_THINKING_TOKENS,
      max: MAX_CLAUDE_MAX_THINKING_TOKENS,
    }
    : null
  const supportsCustomModels = providerModels.data?.supportsCustomModels
    ?? (selectedProvider?.id === settings?.current.agentType ? settings?.supportsCustomModels : undefined)
    ?? selectedProvider?.supportsCustomModels
    ?? false

  useEffect(() => {
    if (!draft || usesCurrentRuntimeSelection) {
      return
    }
    const fallbackModel = draft.model !== null
      && !selectedModel
      && !supportsCustomModels
      && modelOptions.length > 0
      ? defaultModel
      : null
    const nextModelOption = selectedModel
      ?? fallbackModel
      ?? (draft.model === null ? defaultModel : null)
    const nextModel = fallbackModel?.id ?? draft.model
    const allowedEffortLevels = selectedProvider
      ? getModelEffortLevels(selectedProvider.id, nextModelOption)
      : []
    const nextSupportsEffort = selectedProvider?.uiCapabilities.supportsEffort === true
      && allowedEffortLevels.length > 0
    const nextEffort = nextSupportsEffort
      ? draft.effort && allowedEffortLevels.includes(draft.effort)
        ? draft.effort
        : resolveModelEffort(draft.agentType, selectedProvider, nextModelOption)
      : null
    if (draft.model === nextModel && draft.effort === nextEffort) {
      return
    }
    setDraft((current) => current
      && current.agentType === draft.agentType
      && current.model === draft.model
      ? { ...current, model: nextModel, effort: nextEffort }
      : current)
  }, [
    draft,
    defaultModel,
    modelOptions,
    selectedModel,
    selectedProvider,
    supportsCustomModels,
    usesCurrentRuntimeSelection,
  ])

  const changed = Boolean(draft && settings && (
    draft.agentType !== settings.current.agentType
    || draft.model !== settings.current.model
    || shouldSendCredentialPoolId
    || (supportsEffort && draft.effort !== settings.current.effort)
    || (supportsAdaptiveThinking && draft.adaptiveThinking !== settings.current.adaptiveThinking)
    || (supportsMaxThinkingTokens && draft.maxThinkingTokens !== settings.current.maxThinkingTokens)
  ))

  const setAgentType = useCallback((agentType: AgentType) => {
    const provider = providers.find((candidate) => candidate.id === agentType) ?? null
    const models = provider?.availableModels.filter((model) => !model.deprecated) ?? []
    const defaultModel = models.find((model) => model.default)?.id ?? provider?.defaults.model ?? null
    const defaultModelOption = models.find((model) => model.id === defaultModel)
    setDraft({
      agentType,
      model: defaultModel,
      credentialPoolId: null,
      effort: resolveModelEffort(agentType, provider, defaultModelOption),
      adaptiveThinking: provider?.uiCapabilities.supportsAdaptiveThinking
        ? provider.defaults.adaptiveThinking ?? DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE
        : null,
      maxThinkingTokens: provider?.uiCapabilities.supportsMaxThinkingTokens
        ? provider.defaults.maxThinkingTokens ?? DEFAULT_CLAUDE_MAX_THINKING_TOKENS
        : null,
    })
  }, [providers])

  const setModel = useCallback((model: string | null) => {
    setDraft((current) => {
      if (!current) {
        return current
      }
      const option = model === null
        ? defaultModel
        : modelOptions.find((candidate) => candidate.id === model)
      return {
        ...current,
        model,
        effort: resolveModelEffort(current.agentType, selectedProvider, option),
      }
    })
  }, [defaultModel, modelOptions, selectedProvider])

  const setCredentialPoolId = useCallback((credentialPoolId: string | null) => {
    if (!credentialSelectionAllowed) {
      return
    }
    setDraft((current) => current ? { ...current, credentialPoolId } : current)
  }, [credentialSelectionAllowed])

  const shouldSendModel = Boolean(
    draft
    && settings
    && (
      draft.agentType !== settings.current.agentType
      || draft.model !== settings.current.model
    ),
  )
  const payload: Omit<UpdateConversationInput, 'conversationId'> | null = draft
    ? {
      agentType: draft.agentType,
      ...(shouldSendModel ? { model: draft.model } : {}),
      ...(shouldSendCredentialPoolId && effectiveCredentialPoolId
        ? { credentialPoolId: effectiveCredentialPoolId }
        : {}),
      ...(supportsEffort && draft.effort ? { effort: draft.effort } : {}),
      ...(supportsAdaptiveThinking && draft.adaptiveThinking
        ? { adaptiveThinking: draft.adaptiveThinking }
        : {}),
      ...(supportsMaxThinkingTokens && draft.maxThinkingTokens !== null
        ? { maxThinkingTokens: draft.maxThinkingTokens }
        : {}),
    }
    : null

  return {
    settings,
    credentialSelectionMode,
    draft,
    providerOptions,
    selectedProvider,
    selectedModel,
    selectedModelValue: selectedModel?.id ?? draft?.model ?? '',
    currentCredentialPoolId,
    selectedCredentialPoolId,
    modelCredentialPoolId,
    modelDiscovery,
    supportsCustomModels,
    modelOptions,
    effortOptions,
    adaptiveThinkingOptions: supportsAdaptiveThinking
      ? [...CLAUDE_ADAPTIVE_THINKING_MODES]
      : [],
    supportsEffort,
    supportsAdaptiveThinking,
    supportsMaxThinkingTokens,
    maxThinkingTokensRange,
    changed,
    canSave: Boolean(settings?.allowed && changed && payload && !providerModels.isFetching),
    payload,
    setAgentType,
    setModel,
    setCredentialPoolId,
    setEffort: (effort: AgentEffortLevel) =>
      setDraft((current) => current ? { ...current, effort } : current),
    setAdaptiveThinking: (adaptiveThinking: ClaudeAdaptiveThinkingMode) =>
      setDraft((current) => current ? { ...current, adaptiveThinking } : current),
    setMaxThinkingTokens: (maxThinkingTokens: number) =>
      setDraft((current) => current ? { ...current, maxThinkingTokens } : current),
  }
}
