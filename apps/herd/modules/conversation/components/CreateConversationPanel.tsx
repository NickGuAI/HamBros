import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Plus } from 'lucide-react'
import type { AgentType, ProviderRegistryEntry } from '@/types'
import { getProviderControlDefaults, useProviderModels } from '@/hooks/use-providers'
import {
  getDefaultAgentEffortForModel,
  getAgentEffortLevelsForModel,
  type AgentEffortLevel,
} from '@modules/agents/effort.js'
import {
  CLAUDE_ADAPTIVE_THINKING_MODES,
  type ClaudeAdaptiveThinkingMode,
} from '@modules/claude-adaptive-thinking.js'
import {
  MAX_CLAUDE_MAX_THINKING_TOKENS,
  MIN_CLAUDE_MAX_THINKING_TOKENS,
  type ClaudeMaxThinkingTokens,
} from '@modules/claude-max-thinking-tokens.js'
import {
  CredentialPoolSelect,
} from './CredentialPoolSelect'
import type { ConversationCredentialSelectionModes } from '@modules/commanders/conversation-credential-selection.js'

export interface CreateConversationReasoningConfig {
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
}

function resolveInitialAgentType(
  providers: readonly ProviderRegistryEntry[],
  defaultAgentType?: AgentType,
): AgentType | null {
  if (defaultAgentType && providers.some((provider) => provider.id === defaultAgentType)) {
    return defaultAgentType
  }
  return providers[0]?.id ?? null
}

export function CreateConversationPanel({
  commanderName,
  credentialSelectionModes,
  onCreateChat,
  createChatPending = false,
  defaultAgentType,
  providerOptions = [],
}: {
  commanderName: string
  credentialSelectionModes?: ConversationCredentialSelectionModes
  onCreateChat?: (
    agentType: AgentType,
    model: string | null,
    reasoningConfig: CreateConversationReasoningConfig,
    credentialPoolId?: string,
  ) => void | Promise<void>
  createChatPending?: boolean
  defaultAgentType?: AgentType
  providerOptions?: readonly ProviderRegistryEntry[]
}) {
  // The corrected issue 1362 contract: the empty-state panel must NOT create
  // anything until the user explicitly confirms (with provider choice). The
  // dropdown sits next to the Create button, and the POST only fires on the
  // button click — never on render, never on commander selection.
  const [agentType, setAgentType] = useState<AgentType | null>(
    () => resolveInitialAgentType(providerOptions, defaultAgentType),
  )
  const [model, setModel] = useState<string | null>(null)
  const [credentialPoolId, setCredentialPoolId] = useState<string | null>(null)
  const initialProviderControls = getProviderControlDefaults(null)
  const [effort, setEffort] = useState<AgentEffortLevel | ''>('')
  const [adaptiveThinking, setAdaptiveThinking] = useState<ClaudeAdaptiveThinkingMode>(
    initialProviderControls.adaptiveThinking,
  )
  const [maxThinkingTokens, setMaxThinkingTokens] = useState(String(initialProviderControls.maxThinkingTokens))
  const [reasoningError, setReasoningError] = useState<string | null>(null)
  const userSelectedAgentTypeRef = useRef(false)
  const previousDefaultAgentTypeRef = useRef(defaultAgentType)
  const activeProvider = useMemo(
    () => providerOptions.find((provider) => provider.id === agentType) ?? null,
    [agentType, providerOptions],
  )
  const credentialSelectionMode = agentType
    ? credentialSelectionModes?.[agentType] ?? 'none'
    : 'none'
  const credentialSelectionAllowed = credentialSelectionMode === 'per-conversation'
  const selectedCredentialPoolId = credentialSelectionAllowed ? credentialPoolId : null
  const modelCredentialPoolId = activeProvider?.modelCatalogScope === 'provider'
    ? undefined
    : selectedCredentialPoolId ?? undefined
  const providerModels = useProviderModels(agentType, modelCredentialPoolId)
  const availableModels = providerModels.data?.availableModels ?? activeProvider?.availableModels ?? []
  const modelDiscovery = providerModels.data?.modelDiscovery ?? activeProvider?.modelDiscovery ?? null
  const capabilities = activeProvider?.uiCapabilities
  const activeModel = availableModels.find((option) => option.id === model)
    ?? (model === null
      ? availableModels.find((option) => option.default)
        ?? null
      : null)
  const effortOptions = useMemo(() => {
    return agentType ? getAgentEffortLevelsForModel(agentType, activeModel) : []
  }, [activeModel, agentType])
  const defaultEffort = getDefaultAgentEffortForModel(
    agentType ?? '',
    activeModel,
    activeProvider?.defaults?.effort,
  )
  const supportsEffort = capabilities?.supportsEffort === true && effortOptions.length > 0
  const supportsAdaptiveThinking = capabilities?.supportsAdaptiveThinking === true
    && activeModel?.supportsAdaptiveThinking !== false
  const disabled = !onCreateChat
    || createChatPending
    || !agentType
    || Boolean(selectedCredentialPoolId && providerModels.isFetching)

  useEffect(() => {
    const defaultAgentTypeChanged = previousDefaultAgentTypeRef.current !== defaultAgentType
    previousDefaultAgentTypeRef.current = defaultAgentType

    setAgentType((current) => {
      const currentIsAvailable = Boolean(
        current && providerOptions.some((provider) => provider.id === current),
      )

      if (currentIsAvailable && (!defaultAgentTypeChanged || userSelectedAgentTypeRef.current)) {
        return current
      }

      userSelectedAgentTypeRef.current = false
      return resolveInitialAgentType(providerOptions, defaultAgentType)
    })
  }, [defaultAgentType, providerOptions])

  useEffect(() => {
    if (model && !availableModels.some((option) => option.id === model)) {
      setModel(null)
    }
  }, [availableModels, model])

  useEffect(() => {
    setCredentialPoolId(null)
  }, [agentType])

  useEffect(() => {
    const defaults = getProviderControlDefaults(activeProvider)
    setEffort(defaultEffort ?? '')
    setAdaptiveThinking(defaults.adaptiveThinking)
    setMaxThinkingTokens(String(defaults.maxThinkingTokens))
    setReasoningError(null)
  }, [activeProvider, defaultEffort])

  function buildReasoningConfig(): CreateConversationReasoningConfig | null {
    const submittedEffort = effortOptions.includes(effort)
      ? effort
      : getDefaultAgentEffortForModel(agentType ?? '', activeModel)
    if (!capabilities?.supportsMaxThinkingTokens) {
      setReasoningError(null)
      return {
        ...(supportsEffort && submittedEffort ? { effort: submittedEffort } : {}),
        ...(supportsAdaptiveThinking ? { adaptiveThinking } : {}),
      }
    }

    const parsedMaxThinkingTokens = Number.parseInt(maxThinkingTokens.trim(), 10)
    if (
      !Number.isFinite(parsedMaxThinkingTokens)
      || parsedMaxThinkingTokens < MIN_CLAUDE_MAX_THINKING_TOKENS
      || parsedMaxThinkingTokens > MAX_CLAUDE_MAX_THINKING_TOKENS
    ) {
      setReasoningError(
        `Max tokens must be an integer between ${MIN_CLAUDE_MAX_THINKING_TOKENS} and ${MAX_CLAUDE_MAX_THINKING_TOKENS}.`,
      )
      return null
    }

    setReasoningError(null)
    return {
      ...(supportsEffort && submittedEffort ? { effort: submittedEffort } : {}),
      ...(supportsAdaptiveThinking ? { adaptiveThinking } : {}),
      maxThinkingTokens: parsedMaxThinkingTokens,
    }
  }

  function handleAgentTypeChange(nextAgentType: AgentType): void {
    userSelectedAgentTypeRef.current = true
    setAgentType(nextAgentType)
    setCredentialPoolId(null)
    const nextProvider = providerOptions.find((provider) => provider.id === nextAgentType) ?? null
    const nextModels = nextProvider?.availableModels ?? []
    const nextDefaults = getProviderControlDefaults(nextProvider)
    const nextDefaultModel = nextModels.find((option) => option.default) ?? nextModels[0]
    setEffort(getDefaultAgentEffortForModel(
      nextAgentType,
      nextDefaultModel,
      nextProvider?.defaults?.effort,
    ) ?? '')
    setAdaptiveThinking(nextDefaults.adaptiveThinking)
    setMaxThinkingTokens(String(nextDefaults.maxThinkingTokens))
    if (model && !nextModels.some((option) => option.id === model)) {
      setModel(null)
    }
  }

  function handleAgentTypeSelectEvent(event: ChangeEvent<HTMLSelectElement>): void {
    handleAgentTypeChange(event.currentTarget.value as AgentType)
  }

  function handleModelChange(nextModelId: string | null): void {
    const nextModel = nextModelId
      ? availableModels.find((option) => option.id === nextModelId)
      : availableModels.find((option) => option.default) ?? availableModels[0]
    setModel(nextModelId)
    const nextDefaultEffort = getDefaultAgentEffortForModel(agentType ?? '', nextModel)
    setEffort((current) => {
      const nextLevels = getAgentEffortLevelsForModel(agentType ?? '', nextModel)
      return nextDefaultEffort && current && nextLevels.includes(current)
        ? current
        : nextDefaultEffort ?? ''
    })
  }

  return (
    <div
      data-testid="start-conversation-panel"
      style={{
        minHeight: 360,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 32px 56px',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <p
          style={{
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--hv-fg-faint)',
            margin: 0,
          }}
        >
          New conversation with {commanderName}
        </p>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'stretch',
            justifyContent: 'center',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 12px',
              border: '1px solid var(--hv-border-hair)',
              borderRadius: '2px 10px 2px 10px',
              background: 'var(--hv-bg-raised)',
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--hv-fg-subtle)',
            }}
          >
            <span>Provider</span>
            <select
              className="font-body"
              data-testid="create-chat-provider-select"
              value={agentType ?? ''}
              onChange={handleAgentTypeSelectEvent}
              disabled={disabled}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--hv-fg)',
                fontSize: 13,
                padding: '8px 4px',
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              {providerOptions.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label}</option>
              ))}
            </select>
          </label>
          {credentialSelectionAllowed ? (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 12px',
                border: '1px solid var(--hv-border-hair)',
                borderRadius: '2px 10px 2px 10px',
                background: 'var(--hv-bg-raised)',
                fontSize: 11,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--hv-fg-subtle)',
              }}
            >
              <span>Credential</span>
              <CredentialPoolSelect
                provider={agentType}
                credentialSelectionMode={credentialSelectionMode}
                value={selectedCredentialPoolId}
                onChange={setCredentialPoolId}
                disabled={!onCreateChat || createChatPending}
                dataTestId="create-chat-credential-select"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--hv-fg)',
                  fontSize: 13,
                  padding: '8px 4px',
                  cursor: !onCreateChat || createChatPending ? 'not-allowed' : 'pointer',
                  maxWidth: 280,
                }}
              />
            </label>
          ) : null}
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 12px',
              border: '1px solid var(--hv-border-hair)',
              borderRadius: '2px 10px 2px 10px',
              background: 'var(--hv-bg-raised)',
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--hv-fg-subtle)',
            }}
          >
            <span>Model</span>
            <select
              className="font-body"
              data-testid="create-chat-model-select"
              value={model ?? ''}
              onChange={(event) => handleModelChange(event.target.value || null)}
              disabled={disabled}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--hv-fg)',
                fontSize: 13,
                padding: '8px 4px',
                cursor: disabled ? 'not-allowed' : 'pointer',
                maxWidth: 260,
              }}
            >
              <option value="">Adapter default</option>
              {availableModels.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            className="font-body"
            type="button"
            data-testid="create-chat-panel-button"
            onClick={() => {
              if (agentType) {
                const reasoningConfig = buildReasoningConfig()
                if (reasoningConfig) {
                  void onCreateChat?.(
                    agentType,
                    model,
                    reasoningConfig,
                    credentialSelectionAllowed
                      ? selectedCredentialPoolId
                        ?? (activeProvider?.modelCatalogScope === 'credential'
                          ? modelDiscovery?.credentialPoolId
                          : undefined)
                      : undefined,
                  )
                }
              }
            }}
            disabled={disabled}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              minWidth: 156,
              padding: '12px 18px',
              border: '1px solid var(--hv-border-firm)',
              borderRadius: '2px 10px 2px 10px',
              background: 'var(--sumi-black)',
              color: 'var(--washi-white)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: onCreateChat ? 1 : 0.55,
              fontSize: 13,
              letterSpacing: '0.04em',
            }}
          >
            <Plus size={14} />
            <span>{createChatPending ? 'Creating' : 'Create chat'}</span>
          </button>
        </div>
        {activeProvider && (
          capabilities?.supportsEffort ||
          capabilities?.supportsAdaptiveThinking ||
          capabilities?.supportsMaxThinkingTokens
        ) ? (
          <div
            data-testid="create-chat-reasoning-settings"
            data-test-id="create-chat-reasoning-settings"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: 8,
              maxWidth: 640,
            }}
          >
            {supportsEffort ? (
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '0 10px',
                  border: '1px solid var(--hv-border-hair)',
                  borderRadius: '2px 10px 2px 10px',
                  background: 'var(--hv-bg-raised)',
                  color: 'var(--hv-fg-subtle)',
                  fontSize: 10.5,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                }}
              >
                <span>Effort</span>
                <select
                  className="font-body"
                  data-testid="create-chat-effort-select"
                  value={effort}
                  onChange={(event) => setEffort(event.target.value as AgentEffortLevel | '')}
                  disabled={disabled}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--hv-fg)',
                    fontSize: 12,
                    padding: '8px 2px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {!defaultEffort ? <option value="">Provider default</option> : null}
                  {effortOptions.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {supportsAdaptiveThinking ? (
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '0 10px',
                  border: '1px solid var(--hv-border-hair)',
                  borderRadius: '2px 10px 2px 10px',
                  background: 'var(--hv-bg-raised)',
                  color: 'var(--hv-fg-subtle)',
                  fontSize: 10.5,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                }}
              >
                <span>Adaptive</span>
                <select
                  className="font-body"
                  data-testid="create-chat-adaptive-thinking-select"
                  value={adaptiveThinking}
                  onChange={(event) => setAdaptiveThinking(event.target.value as ClaudeAdaptiveThinkingMode)}
                  disabled={disabled}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--hv-fg)',
                    fontSize: 12,
                    padding: '8px 2px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {CLAUDE_ADAPTIVE_THINKING_MODES.map((mode) => (
                    <option key={mode} value={mode}>{mode}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {capabilities?.supportsMaxThinkingTokens ? (
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '0 10px',
                  border: '1px solid var(--hv-border-hair)',
                  borderRadius: '2px 10px 2px 10px',
                  background: 'var(--hv-bg-raised)',
                  color: 'var(--hv-fg-subtle)',
                  fontSize: 10.5,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                }}
              >
                <span>Max tokens</span>
                <input
                  className="font-body"
                  data-testid="create-chat-max-thinking-tokens-input"
                  type="number"
                  min={MIN_CLAUDE_MAX_THINKING_TOKENS}
                  max={MAX_CLAUDE_MAX_THINKING_TOKENS}
                  step={1}
                  value={maxThinkingTokens}
                  onChange={(event) => setMaxThinkingTokens(event.target.value)}
                  disabled={disabled}
                  style={{
                    width: 88,
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--hv-fg)',
                    fontSize: 12,
                    padding: '8px 2px',
                    cursor: disabled ? 'not-allowed' : 'text',
                  }}
                />
              </label>
            ) : null}
          </div>
        ) : null}
        {reasoningError ? (
          <p
            data-testid="create-chat-reasoning-error"
            data-test-id="create-chat-reasoning-error"
            style={{
              margin: 0,
              maxWidth: 520,
              color: 'var(--hv-danger)',
              fontSize: 11,
              lineHeight: 1.5,
              textAlign: 'center',
            }}
          >
            {reasoningError}
          </p>
        ) : null}
      </div>
    </div>
  )
}
