import { useEffect, useState, type FormEvent } from 'react'
import {
  findProviderEntry,
  resolveDefaultProviderId,
  useProviderRegistry,
} from '@/hooks/use-providers'
import type { AgentType } from '@/types'
import {
  getDefaultAgentEffortForModel,
  getAgentEffortLevelsForModel,
  type AgentEffortLevel,
} from '../../agents/effort.js'
import type { CommanderCreateInput } from '../hooks/useCommander'
import { CommanderMdPreview } from './CommanderMdPreview'
import {
  createDefaultCommanderRuntimeConfig,
  type CommanderRuntimeConfig,
} from '../runtime-config.shared.js'
import { DirectoryPicker } from '../../agents/components/DirectoryPicker'
import { ProviderModelSelect, resolveProviderModelOptions } from './ProviderModelSelect'

const HOST_PATTERN = /^[a-zA-Z0-9_-]+$/
const MIN_HEARTBEAT_MINUTES = 1
const DEFAULT_HEARTBEAT_MINUTES = 15
const MS_PER_MINUTE = 60_000
const FALLBACK_RUNTIME_CONFIG = createDefaultCommanderRuntimeConfig()

const INPUT_CLASS =
  'w-full rounded-lg border border-ink-border px-3 py-2 text-[16px] md:text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20 placeholder:text-sumi-mist'

const LABEL_CLASS = 'text-whisper uppercase tracking-wide text-sumi-diluted'

export function CreateCommanderForm({
  onAdd,
  isPending,
  onClose,
  heading = 'New commander',
  runtimeConfig,
}: {
  onAdd: (input: CommanderCreateInput) => Promise<void>
  isPending: boolean
  onClose?: () => void
  heading?: string
  runtimeConfig?: CommanderRuntimeConfig
}) {
  const effectiveRuntimeConfig = runtimeConfig ?? FALLBACK_RUNTIME_CONFIG
  // Identity
  const [host, setHost] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [agentType, setAgentType] = useState<AgentType>('')
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<AgentEffortLevel | ''>('')
  const { data: providers = [], defaultProviderId } = useProviderRegistry()
  const defaultAgentType = resolveDefaultProviderId(providers, defaultProviderId)
  const currentProvider = findProviderEntry(providers, agentType)
  const availableModels = resolveProviderModelOptions(providers, agentType)
  const activeModel = availableModels.find((option) => option.id === model)
    ?? (model === null ? availableModels.find((option) => option.default) ?? availableModels[0] : undefined)
  const effortOptions = getAgentEffortLevelsForModel(agentType, activeModel)
  const defaultEffort = getDefaultAgentEffortForModel(
    agentType,
    activeModel,
    currentProvider?.defaults?.effort,
  )
  const supportsEffort = currentProvider?.uiCapabilities.supportsEffort === true
    && effortOptions.length > 0

  // Working directory
  const [cwd, setCwd] = useState('')

  // Commander instructions
  const [identityOperatingStyle, setIdentityOperatingStyle] = useState('')

  // Avatar
  const [avatarSeed, setAvatarSeed] = useState('')

  // Heartbeat
  const [heartbeatMinutes, setHeartbeatMinutes] = useState(String(DEFAULT_HEARTBEAT_MINUTES))
  const [messageTemplate, setMessageTemplate] = useState('')
  const [maxTurns, setMaxTurns] = useState(String(effectiveRuntimeConfig.defaults.maxTurns))
  const [maxTurnsDirty, setMaxTurnsDirty] = useState(false)
  const [fatPinInterval, setFatPinInterval] = useState('')

  // Task source
  const [showTaskSource, setShowTaskSource] = useState(false)
  const [taskOwner, setTaskOwner] = useState('')
  const [taskRepo, setTaskRepo] = useState('')
  const [taskLabel, setTaskLabel] = useState('')
  const [taskProject, setTaskProject] = useState('')

  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!maxTurnsDirty) {
      setMaxTurns(String(effectiveRuntimeConfig.defaults.maxTurns))
    }
  }, [effectiveRuntimeConfig.defaults.maxTurns, maxTurnsDirty])

  useEffect(() => {
    if (defaultAgentType && !currentProvider) {
      setAgentType(defaultAgentType)
    }
  }, [currentProvider, defaultAgentType])

  useEffect(() => {
    if (!currentProvider) {
      return
    }
    setEffort(defaultEffort ?? '')
  }, [currentProvider, defaultEffort])

  useEffect(() => {
    if (model && !availableModels.some((option) => option.id === model)) {
      setModel(null)
    }
  }, [availableModels, model])

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    const trimmedHost = host.trim()

    if (!trimmedHost) {
      setActionError('Host is required.')
      return
    }

    if (!HOST_PATTERN.test(trimmedHost)) {
      setActionError('Host must only contain letters, numbers, hyphens, and underscores.')
      return
    }

    const parsedHeartbeatMinutes = Number.parseInt(heartbeatMinutes.trim(), 10)
    if (!Number.isFinite(parsedHeartbeatMinutes) || parsedHeartbeatMinutes < MIN_HEARTBEAT_MINUTES) {
      setActionError('Heartbeat interval must be at least 1 minute.')
      return
    }

    const parsedMaxTurns = Number.parseInt(maxTurns.trim(), 10)
    if (
      !Number.isFinite(parsedMaxTurns)
      || parsedMaxTurns < 1
      || parsedMaxTurns > effectiveRuntimeConfig.limits.maxTurns
    ) {
      setActionError(
        `Max turns must be an integer between 1 and ${effectiveRuntimeConfig.limits.maxTurns}.`,
      )
      return
    }

    const parsedFatPinInterval = fatPinInterval.trim() ? Number.parseInt(fatPinInterval.trim(), 10) : 0
    if (fatPinInterval.trim() && (!Number.isFinite(parsedFatPinInterval) || parsedFatPinInterval < 1)) {
      setActionError('Fat context interval must be at least 1 heartbeat if provided.')
      return
    }

    const trimmedCwd = cwd.trim() || undefined
    const trimmedIdentityOperatingStyle = identityOperatingStyle.trim() || undefined

    setActionError(null)
    try {
      if (!currentProvider) {
        setActionError('Select an available provider.')
        return
      }
      const createInput: CommanderCreateInput = {
        host: trimmedHost,
        displayName: displayName.trim() || undefined,
        agentType,
        model,
        ...(supportsEffort && effort && effortOptions.includes(effort) ? { effort } : {}),
        cwd: trimmedCwd,
        identityOperatingStyle: trimmedIdentityOperatingStyle,
        avatarSeed: avatarSeed.trim() || undefined,
        maxTurns: parsedMaxTurns,
        contextMode: parsedFatPinInterval > 0 ? 'fat' : 'thin',
        heartbeat: {
          intervalMs: parsedHeartbeatMinutes * MS_PER_MINUTE,
          messageTemplate: messageTemplate.trim() || undefined,
        },
        contextConfig: parsedFatPinInterval > 0
          ? { fatPinInterval: parsedFatPinInterval }
          : undefined,
        taskSource: (taskOwner.trim() && taskRepo.trim())
          ? {
              owner: taskOwner.trim(),
              repo: taskRepo.trim(),
              label: taskLabel.trim() || undefined,
              project: taskProject.trim() || undefined,
            }
          : undefined,
      }

      await onAdd(createInput)

      // Reset all fields on success
      setHost('')
      setDisplayName('')
      if (defaultAgentType) {
        setAgentType(defaultAgentType)
      }
      setModel(null)
      setEffort('')
      setCwd('')
      setIdentityOperatingStyle('')
      setAvatarSeed('')
      setHeartbeatMinutes(String(DEFAULT_HEARTBEAT_MINUTES))
      setMessageTemplate('')
      setMaxTurns(String(effectiveRuntimeConfig.defaults.maxTurns))
      setMaxTurnsDirty(false)
      setFatPinInterval('')
      setShowTaskSource(false)
      setTaskOwner('')
      setTaskRepo('')
      setTaskLabel('')
      setTaskProject('')
      onClose?.()
    } catch (caughtError) {
      if (caughtError instanceof Error && caughtError.message.includes('(409)')) {
        setActionError(`Host "${trimmedHost}" already exists.`)
      } else {
        setActionError(caughtError instanceof Error ? caughtError.message : 'Failed to create commander.')
      }
    }
  }

  const parsedHeartbeatMs =
    Number.parseInt(heartbeatMinutes.trim(), 10) * MS_PER_MINUTE

  const parsedFatPin = fatPinInterval.trim()
    ? Number.parseInt(fatPinInterval.trim(), 10)
    : undefined

  const previewTaskSource =
    taskOwner.trim() && taskRepo.trim()
      ? {
          owner: taskOwner.trim(),
          repo: taskRepo.trim(),
          label: taskLabel.trim() || undefined,
          project: taskProject.trim() || undefined,
        }
      : undefined

  function handleAgentTypeChange(nextAgentType: AgentType): void {
    const nextModels = resolveProviderModelOptions(providers, nextAgentType)
    const nextModel = nextModels.find((option) => option.default) ?? nextModels[0]
    setAgentType(nextAgentType)
    setModel(null)
    setEffort(
      getDefaultAgentEffortForModel(nextAgentType, nextModel)
      ?? '',
    )
  }

  function handleModelChange(nextModelId: string | null): void {
    const nextModel = nextModelId
      ? availableModels.find((option) => option.id === nextModelId)
      : availableModels.find((option) => option.default) ?? availableModels[0]
    setModel(nextModelId)
    const nextDefaultEffort = getDefaultAgentEffortForModel(agentType, nextModel)
    setEffort((current) => {
      const nextLevels = getAgentEffortLevelsForModel(agentType, nextModel)
      return nextDefaultEffort && current && nextLevels.includes(current)
        ? current
        : nextDefaultEffort ?? ''
    })
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="rounded-lg border border-dashed border-ink-border p-4"
    >
      <div className="flex flex-col lg:flex-row gap-5">
        {/* Left — form fields */}
        <div className="flex-1 min-w-0 space-y-4">
          <p className="text-sm text-sumi-gray">{heading}</p>

      {/* Identity */}
      <div className="space-y-2">
        <p className={LABEL_CLASS}>Identity</p>

        <input
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="host (e.g. my-agent-1)"
          className={INPUT_CLASS}
        />

        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Display name (defaults to host)"
          className={INPUT_CLASS}
        />

        <label className="block">
          <span className={`${LABEL_CLASS} mb-1 block`}>Agent type</span>
          <select
            data-testid="create-commander-provider-select"
            value={agentType}
            onChange={(event) => handleAgentTypeChange(event.target.value)}
            required
            className={INPUT_CLASS}
          >
            <option value="" disabled>
              — Select provider —
            </option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label.toLowerCase()}
              </option>
            ))}
          </select>
        </label>

        <ProviderModelSelect
          providers={providers}
          agentType={agentType}
          value={model}
          onChange={handleModelChange}
          label="Model"
          labelClassName={`${LABEL_CLASS} mb-1 block`}
          className={INPUT_CLASS}
          dataTestId="create-commander-model-select"
        />

        {supportsEffort ? (
          <label className="block">
            <span className={`${LABEL_CLASS} mb-1 block`}>Effort</span>
            <select
              data-testid="create-commander-effort-select"
              value={effort}
              onChange={(event) => setEffort(event.target.value as AgentEffortLevel | '')}
              className={INPUT_CLASS}
            >
              {!defaultEffort ? <option value="">Provider default</option> : null}
              {effortOptions.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="block">
          <span className={`${LABEL_CLASS} mb-1 block`}>Working directory</span>
          <DirectoryPicker value={cwd} onChange={setCwd} host={host} />
        </label>
      </div>

      {/* COMMANDER.md identity */}
      <label className="block">
        <span className={`${LABEL_CLASS} mb-1 block`}>Identity and operating style</span>
        <textarea
          rows={4}
          value={identityOperatingStyle}
          onChange={(event) => setIdentityOperatingStyle(event.target.value)}
          placeholder="Senior engineer who owns infra"
          style={{ resize: 'vertical' }}
          className={INPUT_CLASS}
        />
      </label>

      {/* Avatar seed */}
      <label className="block">
        <span className={`${LABEL_CLASS} mb-1 block`}>Avatar</span>
        <input
          value={avatarSeed}
          onChange={(event) => setAvatarSeed(event.target.value)}
          placeholder="Avatar seed (optional)"
          className={INPUT_CLASS}
        />
      </label>

      {/* Heartbeat */}
      <div className="space-y-2">
        <p className={LABEL_CLASS}>Heartbeat</p>

        <label className="block">
          <span className="text-whisper text-sumi-diluted mb-1 block">Interval (minutes)</span>
          <input
            type="number"
            min={MIN_HEARTBEAT_MINUTES}
            step={1}
            value={heartbeatMinutes}
            onChange={(event) => setHeartbeatMinutes(event.target.value)}
            className={INPUT_CLASS}
          />
        </label>

        <label className="block">
          <span className="text-whisper text-sumi-diluted mb-1 block">Max turns</span>
          <input
            type="number"
            min={1}
            max={effectiveRuntimeConfig.limits.maxTurns}
            step={1}
            value={maxTurns}
            onChange={(event) => {
              setMaxTurns(event.target.value)
              setMaxTurnsDirty(true)
            }}
            className={INPUT_CLASS}
          />
          <p className="mt-1 text-xs text-sumi-diluted">
            Global default {effectiveRuntimeConfig.defaults.maxTurns} · limit {effectiveRuntimeConfig.limits.maxTurns}
          </p>
        </label>

        <input
          value={messageTemplate}
          onChange={(event) => setMessageTemplate(event.target.value)}
          placeholder="Heartbeat message (optional)"
          className={INPUT_CLASS}
        />

        <input
          type="number"
          min={1}
          step={1}
          value={fatPinInterval}
          onChange={(event) => setFatPinInterval(event.target.value)}
          placeholder="Fat context every N heartbeats (optional)"
          className={INPUT_CLASS}
        />
      </div>

      {/* Task source */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setShowTaskSource((prev) => !prev)}
          className="flex items-center gap-1.5 text-whisper text-sumi-diluted uppercase tracking-wide hover:text-sumi-black transition-colors"
        >
          <span>{showTaskSource ? '▾' : '▸'}</span>
          <span>Task Source (GitHub)</span>
        </button>

        {showTaskSource && (
          <div className="space-y-2 pl-3 border-l border-ink-border">
            <input
              value={taskOwner}
              onChange={(event) => setTaskOwner(event.target.value)}
              placeholder="GitHub owner (e.g. NickGuAI)"
              className={INPUT_CLASS}
            />
            <input
              value={taskRepo}
              onChange={(event) => setTaskRepo(event.target.value)}
              placeholder="GitHub repo (e.g. example-repo)"
              className={INPUT_CLASS}
            />
            <input
              value={taskLabel}
              onChange={(event) => setTaskLabel(event.target.value)}
              placeholder="Label filter (optional)"
              className={INPUT_CLASS}
            />
            <input
              value={taskProject}
              onChange={(event) => setTaskProject(event.target.value)}
              placeholder="Project filter (stored, not yet used in task fetch)"
              className={INPUT_CLASS}
            />
          </div>
        )}
      </div>

        </div>{/* end left column */}

        {/* Right — live COMMANDER.md preview */}
        <div className="lg:w-80 xl:w-96 flex-shrink-0">
          <CommanderMdPreview
            host={host}
            displayName={displayName || undefined}
            cwd={cwd || undefined}
            identityOperatingStyle={identityOperatingStyle || undefined}
            agentType={agentType}
            effort={supportsEffort && effort ? effort : undefined}
            heartbeatIntervalMs={Number.isFinite(parsedHeartbeatMs) ? parsedHeartbeatMs : undefined}
            heartbeatMessage={messageTemplate || undefined}
            fatPinInterval={parsedFatPin && parsedFatPin >= 1 ? parsedFatPin : undefined}
            taskSource={previewTaskSource}
          />
        </div>
      </div>{/* end flex row */}

      {actionError && <p className="text-sm text-accent-vermillion mt-4">{actionError}</p>}

      <div className="flex justify-end gap-2 mt-4">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-ink-border px-3 py-1.5 text-sm min-h-[44px] min-w-[44px] hover:bg-ink-wash transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg border border-ink-border px-3 py-1.5 text-sm min-h-[44px] min-w-[44px] hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? 'Creating...' : '+ Create'}
        </button>
      </div>
    </form>
  )
}
