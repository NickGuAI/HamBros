import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchJson } from '@/lib/api'
import { formatCost } from '@/lib/utils'
import {
  findProviderEntry,
  getProviderControlDefaults,
  getProviderLabel,
  useProviderRegistry,
} from '@/hooks/use-providers'
import {
  CLAUDE_ADAPTIVE_THINKING_MODES,
  type ClaudeAdaptiveThinkingMode,
} from '../../claude-adaptive-thinking.js'
import {
  getDefaultAgentEffortForModel,
  getAgentEffortLevelsForModel,
  type AgentEffortLevel,
} from '../../agents/effort.js'
import {
  MAX_CLAUDE_MAX_THINKING_TOKENS,
  MIN_CLAUDE_MAX_THINKING_TOKENS,
} from '../../claude-max-thinking-tokens.js'
import type { CommanderSession } from '../hooks/useCommander'
import {
  createDefaultCommanderRuntimeConfig,
  type CommanderRuntimeConfig,
} from '../runtime-config.shared.js'
import { HeartbeatMonitor } from './HeartbeatMonitor'

interface CommanderDetailPayload {
  contextMode?: 'thin' | 'fat' | null
  costCapUsd?: number | null
  monthlyCostUsd?: number
  totalCostUsd?: number
  workflowMd?: string | null
  cwd?: string | null
  currentTask?: {
    issueNumber: number
    issueUrl: string
    startedAt: string
    title?: string
  } | null
  contextConfig?: {
    fatPinInterval?: number
  } | null
  runtime?: {
    heartbeatCount?: number
    terminalState?: {
      kind: 'max_turns'
      subtype?: string
      terminalReason?: string
      message: string
      errors?: string[]
    } | null
  } | null
  memoryRoot?: string | null
  commanderRoot?: string | null
  runtimeConfig?: CommanderRuntimeConfig | null
}

const FALLBACK_RUNTIME_CONFIG = createDefaultCommanderRuntimeConfig()
const FIELD_CLASS =
  'w-full rounded-lg border border-[color:var(--hv-field-border)] bg-[var(--hv-field-bg)] px-3 py-2 text-[16px] text-[color:var(--hv-fg)] placeholder:text-[color:var(--hv-field-placeholder)] focus:border-[color:var(--hv-field-focus-border)] focus:outline-none md:text-sm'
const NOTE_CLASS = 'text-whisper text-[color:var(--hv-fg-faint)]'
const SUBTLE_NOTE_CLASS = 'text-whisper text-[color:var(--hv-fg-subtle)]'
const SECTION_HEADER_CLASS = 'border-b border-[color:var(--hv-border-hair)] bg-[var(--hv-bg-raised)] px-4 py-3'

async function fetchCommanderDetail(commanderId: string): Promise<CommanderDetailPayload> {
  return fetchJson<CommanderDetailPayload>(`/api/commanders/${encodeURIComponent(commanderId)}`)
}

async function updateCommanderRuntime(
  commanderId: string,
  input: {
    maxTurns: number
    contextMode: 'thin' | 'fat'
    contextConfig: {
      fatPinInterval?: number
    }
    costCapUsd: number | null
    effort?: AgentEffortLevel
    adaptiveThinking: ClaudeAdaptiveThinkingMode
    maxThinkingTokens: number
  },
): Promise<void> {
  await fetchJson(`/api/commanders/${encodeURIComponent(commanderId)}/runtime`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  })
}

function formatHeartbeatInterval(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return '15 minutes'
  }
  const minutes = Math.max(1, Math.round(intervalMs / 60_000))
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

function formatTaskState(detail: CommanderDetailPayload, commander: CommanderSession): string {
  const currentTask = detail.currentTask ?? commander.currentTask
  if (!currentTask) {
    return 'No task claimed'
  }

  if (currentTask.title?.trim()) {
    return `#${currentTask.issueNumber} · ${currentTask.title.trim()}`
  }

  return `#${currentTask.issueNumber}`
}

function formatContextMode(detail: CommanderDetailPayload, commander: CommanderSession): string {
  const value = detail.contextConfig?.fatPinInterval
  const contextMode = detail.contextMode ?? commander.contextMode ?? 'fat'
  if (!Number.isFinite(value) || !value || value <= 0) {
    return contextMode === 'thin' ? 'Thin' : 'Fat'
  }
  return contextMode === 'thin'
    ? `Thin (fat pin every ${value} heartbeats)`
    : `Fat (pin every ${value} heartbeats)`
}

function resolveMemoryRoot(detail: CommanderDetailPayload, commanderId: string): string {
  if (detail.memoryRoot?.trim()) {
    return detail.memoryRoot.trim()
  }
  return `<COMMANDER_DATA_DIR>/${commanderId}/.memory`
}

function MetadataField({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="rounded-lg border border-[color:var(--hv-border-hair)] bg-[var(--hv-surface-card)] px-3 py-2.5 text-[color:var(--hv-fg)]">
      <p className="text-whisper uppercase tracking-wide text-[color:var(--hv-fg-subtle)]">{label}</p>
      <p className="mt-1 break-words text-sm text-[color:var(--hv-fg)]">{value}</p>
    </div>
  )
}

function IdentitySection({
  title,
  defaultOpen = false,
  testId,
  children,
}: {
  title: string
  defaultOpen?: boolean
  testId: string
  children: ReactNode
}) {
  return (
    <details
      className="card-sumi overflow-hidden"
      open={defaultOpen || undefined}
      data-testid={testId}
    >
      <summary className={`${SECTION_HEADER_CLASS} cursor-pointer list-none`}>
        <h3 className="section-title">{title}</h3>
      </summary>
      {children}
    </details>
  )
}

export function CommanderIdentityTab({
  commander,
}: {
  commander: CommanderSession
}) {
  const queryClient = useQueryClient()
  const { data: providers = [] } = useProviderRegistry()
  const commanderAgentType = commander.agentType ?? null
  const currentProvider = findProviderEntry(providers, commanderAgentType)
  const agentLabel = commanderAgentType
    ? getProviderLabel(providers, commanderAgentType)
    : 'Unavailable'
  const providerDefaults = getProviderControlDefaults(currentProvider)
  const commanderModel = currentProvider?.availableModels.find((option) => option.id === commander.model)
    ?? (commander.model == null
      ? currentProvider?.availableModels.find((option) => option.default)
        ?? currentProvider?.availableModels[0]
      : undefined)
  const effortOptions = useMemo(
    () => getAgentEffortLevelsForModel(commanderAgentType ?? '', commanderModel),
    [commanderAgentType, commanderModel],
  )
  const supportsEffort = currentProvider?.uiCapabilities.supportsEffort === true
    && effortOptions.length > 0
  const commanderDefaultEffort = getDefaultAgentEffortForModel(
    commanderAgentType ?? '',
    commanderModel,
    currentProvider?.defaults?.effort,
  )
  const [effort, setEffort] = useState<AgentEffortLevel | ''>(
    commander.effort ?? commanderDefaultEffort ?? '',
  )
  const [adaptiveThinking, setAdaptiveThinking] = useState<ClaudeAdaptiveThinkingMode>(
    commander.adaptiveThinking ?? providerDefaults.adaptiveThinking,
  )
  const [maxThinkingTokens, setMaxThinkingTokens] = useState(String(
    commander.maxThinkingTokens ?? providerDefaults.maxThinkingTokens,
  ))
  const [maxTurns, setMaxTurns] = useState(String(commander.maxTurns ?? FALLBACK_RUNTIME_CONFIG.defaults.maxTurns))
  const [costCapUsd, setCostCapUsd] = useState(
    commander.costCapUsd != null ? String(commander.costCapUsd) : '',
  )
  const [runtimeContextMode, setRuntimeContextMode] = useState<'thin' | 'fat'>(commander.contextMode ?? 'fat')
  const [fatPinInterval, setFatPinInterval] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const detailQuery = useQuery({
    queryKey: ['commanders', 'detail', commander.id],
    queryFn: () => fetchCommanderDetail(commander.id),
    staleTime: 30_000,
  })

  const updateRuntimeMutation = useMutation({
    mutationFn: async (input: {
      maxTurns: number
      contextMode: 'thin' | 'fat'
      contextConfig: {
        fatPinInterval?: number
      }
      costCapUsd: number | null
      effort?: AgentEffortLevel
      adaptiveThinking: ClaudeAdaptiveThinkingMode
      maxThinkingTokens: number
    }) => updateCommanderRuntime(commander.id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['commanders', 'sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['commanders', 'detail', commander.id] }),
      ])
    },
  })

  useEffect(() => {
    setEffort(
      commander.effort && effortOptions.includes(commander.effort)
        ? commander.effort
        : commanderDefaultEffort ?? '',
    )
    setAdaptiveThinking(commander.adaptiveThinking ?? providerDefaults.adaptiveThinking)
    setMaxThinkingTokens(String(commander.maxThinkingTokens ?? providerDefaults.maxThinkingTokens))
    setMaxTurns(String(
      commander.maxTurns
      ?? detailQuery.data?.runtimeConfig?.defaults.maxTurns
      ?? FALLBACK_RUNTIME_CONFIG.defaults.maxTurns,
    ))
    const effectiveCostCapUsd = detailQuery.data?.costCapUsd !== undefined
      ? detailQuery.data.costCapUsd
      : commander.costCapUsd
    setCostCapUsd(effectiveCostCapUsd != null ? String(effectiveCostCapUsd) : '')
    setRuntimeContextMode(detailQuery.data?.contextMode ?? commander.contextMode ?? 'fat')
    setFatPinInterval(
      detailQuery.data?.contextConfig?.fatPinInterval
        ? String(detailQuery.data.contextConfig.fatPinInterval)
        : '',
    )
    setActionError(null)
  }, [
    commander.contextMode,
    commander.adaptiveThinking,
    commander.effort,
    commander.id,
    commander.maxThinkingTokens,
    commander.maxTurns,
    commander.costCapUsd,
    detailQuery.data?.costCapUsd,
    detailQuery.data?.contextConfig?.fatPinInterval,
    detailQuery.data?.contextMode,
    detailQuery.data?.runtimeConfig?.defaults.maxTurns,
    commanderAgentType,
    commanderModel,
    commanderDefaultEffort,
    effortOptions,
    providerDefaults.adaptiveThinking,
    providerDefaults.maxThinkingTokens,
  ])

  async function handleSaveRuntime(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const runtimeConfig = detailQuery.data?.runtimeConfig ?? FALLBACK_RUNTIME_CONFIG
    const parsedMaxTurns = Number.parseInt(maxTurns.trim(), 10)
    if (
      !Number.isFinite(parsedMaxTurns)
      || parsedMaxTurns < 1
      || parsedMaxTurns > runtimeConfig.limits.maxTurns
    ) {
      setActionError(`Max turns must be an integer between 1 and ${runtimeConfig.limits.maxTurns}.`)
      return
    }

    const parsedFatPinInterval = fatPinInterval.trim()
      ? Number.parseInt(fatPinInterval.trim(), 10)
      : undefined
    if (
      runtimeContextMode === 'fat'
      && parsedFatPinInterval !== undefined
      && (!Number.isFinite(parsedFatPinInterval) || parsedFatPinInterval < 1)
    ) {
      setActionError('Fat context interval must be at least 1 heartbeat when provided.')
      return
    }

    const parsedCostCapUsd = costCapUsd.trim()
      ? Number(costCapUsd.trim())
      : null
    if (
      parsedCostCapUsd !== null
      && (!Number.isFinite(parsedCostCapUsd) || parsedCostCapUsd <= 0)
    ) {
      setActionError('Monthly spend cap must be a positive dollar amount, or blank for unlimited.')
      return
    }

    const parsedMaxThinkingTokens = Number.parseInt(maxThinkingTokens.trim(), 10)
    if (
      !Number.isFinite(parsedMaxThinkingTokens)
      || parsedMaxThinkingTokens < MIN_CLAUDE_MAX_THINKING_TOKENS
      || parsedMaxThinkingTokens > MAX_CLAUDE_MAX_THINKING_TOKENS
    ) {
      setActionError(
        `Max thinking tokens must be an integer between ${MIN_CLAUDE_MAX_THINKING_TOKENS} and ${MAX_CLAUDE_MAX_THINKING_TOKENS}.`,
      )
      return
    }

    setActionError(null)
    try {
      await updateRuntimeMutation.mutateAsync({
        maxTurns: parsedMaxTurns,
        contextMode: runtimeContextMode,
        contextConfig: runtimeContextMode === 'fat' && parsedFatPinInterval !== undefined
          ? { fatPinInterval: parsedFatPinInterval }
          : {},
        costCapUsd: parsedCostCapUsd,
        ...(supportsEffort && effort && effortOptions.includes(effort) ? { effort } : {}),
        adaptiveThinking,
        maxThinkingTokens: parsedMaxThinkingTokens,
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to update commander runtime.')
    }
  }

  const workflowMd = detailQuery.data?.workflowMd ?? null
  const detail = detailQuery.data ?? {}
  const runtimeConfig = detail.runtimeConfig ?? FALLBACK_RUNTIME_CONFIG
  const heartbeatInterval = formatHeartbeatInterval(commander.heartbeat.intervalMs)
  const contextModeLabel = formatContextMode(detail, commander)
  const taskState = formatTaskState(detail, commander)
  const memoryRoot = resolveMemoryRoot(detail, commander.id)
  const workspaceRoot = detail.cwd?.trim() || commander.cwd?.trim() || 'Not configured'
  const heartbeatCount = detail.runtime?.heartbeatCount
  const terminalState = detail.runtime?.terminalState ?? null
  const configuredMaxTurns = commander.maxTurns ?? runtimeConfig.defaults.maxTurns
  const effectiveCostCapUsd = detail.costCapUsd !== undefined
    ? detail.costCapUsd
    : commander.costCapUsd ?? null
  const monthlyCostUsd = Number.isFinite(detail.monthlyCostUsd)
    ? detail.monthlyCostUsd ?? 0
    : commander.monthlyCostUsd ?? 0
  const spendProgressPercent = effectiveCostCapUsd && effectiveCostCapUsd > 0
    ? Math.min(100, (monthlyCostUsd / effectiveCostCapUsd) * 100)
    : 0
  const spendStatus = effectiveCostCapUsd && effectiveCostCapUsd > 0
    ? monthlyCostUsd >= effectiveCostCapUsd
      ? 'Blocked'
      : `${formatCost(Math.max(0, effectiveCostCapUsd - monthlyCostUsd))} remaining`
    : 'Unlimited'

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <IdentitySection title="Runtime Config" testId="identity-section-runtime">
        <div className="p-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <MetadataField
              label="Agent"
              value={agentLabel}
            />
            <MetadataField
              label="Heartbeat Interval"
              value={heartbeatInterval}
            />
            <MetadataField
              label="Context Mode"
              value={contextModeLabel}
            />
            <MetadataField
              label="Max Turns"
              value={String(configuredMaxTurns)}
            />
            <MetadataField
              label="Task State"
              value={taskState}
            />
            <MetadataField
              label="Memory Directory"
              value={memoryRoot}
            />
            <MetadataField
              label="Workspace"
              value={workspaceRoot}
            />
          </div>
          {heartbeatCount != null && (
            <p className={SUBTLE_NOTE_CLASS}>
              Heartbeats observed in this runtime: {heartbeatCount}
            </p>
          )}
          <div
            className="rounded-lg border border-[color:var(--hv-border-hair)] bg-[var(--hv-bg-raised)] px-3 py-3"
            data-testid="commander-monthly-spend"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-whisper uppercase tracking-wide text-[color:var(--hv-fg-subtle)]">Month-to-date spend</p>
                <p className="mt-1 text-lg font-medium text-[color:var(--hv-fg)]">{formatCost(monthlyCostUsd)}</p>
              </div>
              <div className="text-right">
                <p className="text-whisper uppercase tracking-wide text-[color:var(--hv-fg-subtle)]">Cap</p>
                <p className="mt-1 text-sm font-medium text-[color:var(--hv-fg)]">
                  {effectiveCostCapUsd && effectiveCostCapUsd > 0 ? formatCost(effectiveCostCapUsd) : 'Unlimited'}
                </p>
              </div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--hv-border-hair)]">
              <div
                className={`h-full rounded-full ${
                  effectiveCostCapUsd && monthlyCostUsd >= effectiveCostCapUsd
                    ? 'bg-[var(--hv-accent-danger)]'
                    : 'bg-[var(--hv-accent)]'
                }`}
                style={{ width: `${spendProgressPercent}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-[color:var(--hv-fg-subtle)]">
              {spendStatus} · UTC calendar month
            </p>
          </div>
          {terminalState?.kind === 'max_turns' && (
            <div className="rounded-lg border border-[color:var(--hv-accent-danger)] bg-[var(--hv-accent-danger-wash)] px-3 py-2.5">
              <p className="text-sm text-[color:var(--hv-accent-danger)]">
                Claude hit the max-turn cap at {configuredMaxTurns} turns.
              </p>
              <p className="mt-1 text-xs text-[color:var(--hv-fg-subtle)]">
                {terminalState.message}
              </p>
              {terminalState.errors?.length ? (
                <p className="mt-1 text-xs text-[color:var(--hv-fg-subtle)]">
                  {terminalState.errors.join(' · ')}
                </p>
              ) : null}
            </div>
          )}
          <form className="space-y-3" onSubmit={(event) => void handleSaveRuntime(event)}>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="section-title block mb-2">Max turns</span>
                <input
                  type="number"
                  min={1}
                  max={runtimeConfig.limits.maxTurns}
                  step={1}
                  value={maxTurns}
                  onChange={(event) => setMaxTurns(event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
              <label className="block">
                <span className="section-title block mb-2">Context mode</span>
                <select
                  value={runtimeContextMode}
                  onChange={(event) => setRuntimeContextMode(event.target.value as 'thin' | 'fat')}
                  className={FIELD_CLASS}
                >
                  <option value="thin">thin</option>
                  <option value="fat">fat</option>
                </select>
              </label>
            </div>
            <label className="block">
              <span className="section-title block mb-2">Monthly spend cap (USD, blank = unlimited)</span>
              <input
                type="number"
                min={0.01}
                step="0.01"
                value={costCapUsd}
                onChange={(event) => setCostCapUsd(event.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            {runtimeContextMode === 'fat' && (
              <label className="block">
                <span className="section-title block mb-2">Fat context every N heartbeats</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={fatPinInterval}
                  onChange={(event) => setFatPinInterval(event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
            )}
            <div className="grid gap-3 md:grid-cols-3">
              {supportsEffort ? <label className="block">
                <span className="section-title block mb-2">Effort</span>
                <select
                  value={effort}
                  onChange={(event) => setEffort(event.target.value as AgentEffortLevel | '')}
                  className={FIELD_CLASS}
                >
                  {!commander.effort && effort === '' ? <option value="">Provider default</option> : null}
                  {effortOptions.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              </label> : null}
              <label className="block">
                <span className="section-title block mb-2">Adaptive thinking</span>
                <select
                  value={adaptiveThinking}
                  onChange={(event) => setAdaptiveThinking(event.target.value as ClaudeAdaptiveThinkingMode)}
                  className={FIELD_CLASS}
                >
                  {CLAUDE_ADAPTIVE_THINKING_MODES.map((mode) => (
                    <option key={mode} value={mode}>{mode}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="section-title block mb-2">Max thinking tokens</span>
                <input
                  type="number"
                  min={MIN_CLAUDE_MAX_THINKING_TOKENS}
                  max={MAX_CLAUDE_MAX_THINKING_TOKENS}
                  step={1}
                  value={maxThinkingTokens}
                  onChange={(event) => setMaxThinkingTokens(event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
            </div>
            <p className={NOTE_CLASS}>
              Global default {runtimeConfig.defaults.maxTurns} turns · limit {runtimeConfig.limits.maxTurns}.
              Current provider defaults are effort `{commanderDefaultEffort ?? 'provider-managed'}`, adaptive thinking `{providerDefaults.adaptiveThinking}`,
              and {providerDefaults.maxThinkingTokens} thinking tokens. Changes apply to the next compatible provider launch.
            </p>
            {commander.agentType !== 'claude' && (
              <p className={SUBTLE_NOTE_CLASS}>
                Current agent type is `{agentLabel}`. Reasoning settings apply only when that provider supports them.
              </p>
            )}
            <button
              type="submit"
              disabled={updateRuntimeMutation.isPending}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {updateRuntimeMutation.isPending ? 'Saving...' : 'Save runtime'}
            </button>
          </form>
          {actionError && (
            <p className="text-sm text-[color:var(--hv-accent-danger)]">{actionError}</p>
          )}
        </div>
      </IdentitySection>

      <IdentitySection title="COMMANDER.md" testId="identity-section-commander-md" defaultOpen>
        <div className="p-4">
          {detailQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-3 w-3 animate-breathe rounded-full bg-[var(--hv-fg-faint)]" />
            </div>
          ) : workflowMd ? (
            <div className="hervald-prose max-w-none break-words">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{workflowMd}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--hv-fg-subtle)]">
              No per-commander `COMMANDER.md` has been scaffolded yet.
            </p>
          )}
        </div>
      </IdentitySection>

      <HeartbeatMonitor commander={commander} />
    </div>
  )
}
