import type { ProviderApprovalAdapter } from '../../policies/provider-approval-adapter.js'
import type { ClaudeAdaptiveThinkingMode } from '../../claude-adaptive-thinking.js'
import type { ClaudeMaxThinkingTokens } from '../../claude-max-thinking-tokens.js'
import type { AgentEffortLevel } from '../effort.js'
import type { ClaudeStreamSessionDeps } from '../adapters/claude/session.js'
import type { CodexSessionDeps } from '../adapters/codex/session.js'
import type { GeminiSessionDeps } from '../adapters/gemini/session.js'
import type { OpenCodeSessionDeps } from '../adapters/opencode/session.js'
import type {
  ActiveSkillInvocation,
  AgentType,
  ClaudePermissionMode,
  MachineConfig,
  PersistedDaemonProcess,
  PersistedStreamSession,
  SessionCreator,
  SessionType,
  SessionTransportType,
  StreamJsonEvent,
  StreamSession,
  StreamSessionAdapter,
  ExitedStreamSessionState,
} from '../types.js'
import type {
  MachineAuthMode,
  MachineProviderAdapter,
} from './machine-provider-adapter-core.js'
import type { ProviderSessionContext } from './provider-session-context.js'
import type { CredentialPoolRuntimeMode, ProviderSpawnAuth } from '../provider-auth.js'

export interface ProviderPermissionModeOption {
  value: ClaudePermissionMode
  label: string
  description: string
}

export interface ProviderInfoBanner {
  variant: 'info' | 'warn'
  text: string
}

export interface ProviderUiCapabilities {
  supportsEffort: boolean
  supportsAdaptiveThinking: boolean
  supportsMaxThinkingTokens: boolean
  supportsSkills: boolean
  supportsLoginMode: boolean
  forcedTransport?: 'stream'
  permissionModes: ProviderPermissionModeOption[]
  infoBanner?: ProviderInfoBanner
}

export interface ProviderCapabilities {
  /** Allowed as Automation entity agentType. */
  supportsAutomation: boolean
  /** Allowed as Commander conversation agentType. */
  supportsCommanderConversation: boolean
  /** Allowed as worker dispatch agentType. */
  supportsWorkerDispatch: boolean
  /** Accepts image attachments as first-class message input. */
  supportsMessageImages: boolean
}

export interface ProviderMachineAuthDescriptor {
  cliBinaryName: string
  installPackageName?: string
  authEnvKeys: string[]
  supportedAuthModes: MachineAuthMode[]
  requiresSecretModes: MachineAuthMode[]
  loginStatusCommand: string | null
}

export interface ProviderModelOption {
  id: string
  label: string
  description?: string
  default?: boolean
  aliases?: string[]
  hidden?: boolean
  deprecated?: boolean
  runtimeCompatible?: boolean
  resolvedModel?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  defaultEffort?: string
  supportsAdaptiveThinking?: boolean
}

export interface ProviderModelDiscoveryContext {
  credentialPoolId?: string
  accountId?: string
  providerAuth?: ProviderSpawnAuth
  signal?: AbortSignal
  /** Internal preflight failure. Never include secrets or credential paths. */
  unavailableReason?: string
}

export interface ProviderModelDiscoveryResult {
  models: ProviderModelOption[]
  accountId?: string
}

export interface ProviderModelDiscoveryAdapter {
  discover(context: ProviderModelDiscoveryContext): Promise<ProviderModelDiscoveryResult>
  /** Whether one catalogue is shared provider-wide or varies by credential/account. */
  catalogScope?: 'provider' | 'credential'
  /** Advanced custom model ids are rejected unless the adapter explicitly opts in. */
  allowCustomModels?: boolean
  /** Keep successful discovery exact; use registry models only on discovery failure. */
  authoritativeDynamicModels?: boolean
  /** Keep visible runtime-compatible curated entries that discovery omits. */
  includeUnmatchedCuratedModels?: boolean
}

export type ProviderModelDiscoverySource = 'dynamic' | 'stale-cache' | 'static-fallback'
export type ProviderModelDiscoveryFreshness = 'fresh' | 'stale' | 'fallback'

export interface ProviderModelDiscoveryMetadata {
  source: ProviderModelDiscoverySource
  freshness: ProviderModelDiscoveryFreshness
  fetchedAt: string | null
  expiresAt: string | null
  refreshAllowedAt: string | null
  error: string | null
  credentialPoolId: string | null
  accountId: string | null
}

export interface ResolvedProviderModels {
  models: ProviderModelOption[]
  discovery: ProviderModelDiscoveryMetadata
  supportsCustomModels: boolean
}

export interface ProviderDefaults {
  transportType: Exclude<SessionTransportType, 'external'>
  permissionMode: ClaudePermissionMode
  model: string | null
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
}

export interface ProviderRegistryEntry {
  id: AgentType
  label: string
  eventProvider: string
  capabilities: ProviderCapabilities
  uiCapabilities: ProviderUiCapabilities
  availableModels: ProviderModelOption[]
  modelCatalogScope: 'provider' | 'credential'
  modelDiscovery: ProviderModelDiscoveryMetadata
  supportsCustomModels: boolean
  supportedTransports: Exclude<SessionTransportType, 'external'>[]
  defaults: ProviderDefaults
  disabledReason: string | null
  machineAuth?: ProviderMachineAuthDescriptor
}

export interface ProviderRegistryResponse {
  providers: ProviderRegistryEntry[]
  defaultProviderId: AgentType
  automationDefaultProviderId: AgentType
}

export interface ProviderModelsResponse {
  providerId: AgentType
  availableModels: ProviderModelOption[]
  modelCatalogScope: 'provider' | 'credential'
  modelDiscovery: ProviderModelDiscoveryMetadata
  supportsCustomModels: boolean
}

export type ProviderAdapterDeps =
  & ClaudeStreamSessionDeps
  & CodexSessionDeps
  & GeminiSessionDeps
  & OpenCodeSessionDeps

export interface ProviderResumeSource {
  providerContext: ProviderSessionContext
  name?: string
}

export interface ProviderCreateOptions {
  sessionName: string
  mode: ClaudePermissionMode
  task: string
  cwd?: string
  machine?: MachineConfig
  resumeSessionId?: string
  systemPrompt?: string
  maxTurns?: number
  model?: string
  effort?: AgentEffortLevel
  omitEffort?: boolean
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  createdAt?: string
  spawnedBy?: string
  spawnedWorkers?: string[]
  resumedFrom?: string
  sessionType?: SessionType
  creator?: SessionCreator
  conversationId?: string
  currentSkillInvocation?: ActiveSkillInvocation
  daemonProcess?: PersistedDaemonProcess
  approvalBridgeNonce?: string
  resumeProviderContext?: ProviderSessionContext
  providerAuth?: ProviderSpawnAuth
  credentialPoolId?: string
  credentialPoolMode?: CredentialPoolRuntimeMode
  env?: NodeJS.ProcessEnv
}

export interface ProviderTeardownOptions {
  archive?: boolean
  preserveForReplacement?: boolean
}

export interface ProviderTeardownResult {
  verified: boolean
  phase: 'not-verified' | 'sigterm' | 'sigkill'
  elapsedMs: number
  pid?: number
  processGroupId?: number
  ownership: NonNullable<StreamSession['processTree']>['ownership'] | 'untracked'
  survivingPids: number[]
}

export interface ProviderAdapter {
  readonly id: AgentType
  readonly label: string
  readonly eventProvider: string
  readonly approvalAdapter: ProviderApprovalAdapter<unknown, unknown>
  readonly capabilities: ProviderCapabilities
  readonly uiCapabilities: ProviderUiCapabilities
  readonly availableModels: readonly ProviderModelOption[]
  readonly modelDiscovery?: ProviderModelDiscoveryAdapter
  readonly defaults?: Partial<ProviderDefaults>
  readonly machineAuth?: MachineProviderAdapter
  /** Provider-specific PTY env overrides. Route-managed env still wins. */
  preparePtyEnv?(args: {
    mode: ClaudePermissionMode
    effort?: AgentEffortLevel
  }): Record<string, string>
  /**
   * Optional runtime watchdog hook for long-lived stream transports.
   * Used by providers such as Codex to detect stale runtime connections.
   */
  runtimeWatchdog?(session: StreamSession): { teardown: () => void } | undefined
  /** Skill scan roots exposed by this provider, if any. */
  readonly skillScanPaths?: readonly string[]
  buildStreamSessionAdapter(deps: ProviderAdapterDeps): StreamSessionAdapter
  create(options: ProviderCreateOptions, deps: ProviderAdapterDeps): Promise<StreamSession> | StreamSession
  restore(
    entry: PersistedStreamSession,
    machine: MachineConfig | undefined,
    deps: ProviderAdapterDeps,
    providerAuth?: ProviderSpawnAuth,
  ): Promise<StreamSession> | StreamSession
  snapshotForPersist(session: StreamSession): PersistedStreamSession | null
  snapshotExited(session: StreamSession): ExitedStreamSessionState
  hasResumeIdentifier(entry: PersistedStreamSession): boolean
  canResumeLiveSession(session: StreamSession): boolean
  getResumeId(session: ProviderResumeSource, event?: StreamJsonEvent): string | undefined
  transcriptId(session: StreamSession, event?: StreamJsonEvent): string | undefined
  teardown(session: StreamSession, reason: string, options?: ProviderTeardownOptions): Promise<void> | void
  shutdownFleet?(sessions: Iterable<StreamSession>, reason?: string): Promise<void> | void
}

export function resolveProviderDefaults(
  provider: ProviderAdapter,
  resolvedModels: readonly ProviderModelOption[] = provider.availableModels,
): ProviderDefaults {
  const availableModels = Array.isArray(resolvedModels) ? resolvedModels : []
  const configured = provider.defaults ?? {}
  const hasConfiguredModel = Object.prototype.hasOwnProperty.call(configured, 'model')

  const defaults: ProviderDefaults = {
    transportType: configured.transportType ?? 'stream',
    permissionMode: configured.permissionMode ?? 'default',
    model: hasConfiguredModel
      ? configured.model ?? null
      : availableModels.find((model) => model.default)?.id ?? null,
  }

  if (provider.uiCapabilities.supportsEffort && configured.effort !== undefined) {
    defaults.effort = configured.effort
  }
  if (
    provider.uiCapabilities.supportsAdaptiveThinking
    && configured.adaptiveThinking !== undefined
  ) {
    defaults.adaptiveThinking = configured.adaptiveThinking
  }
  if (
    provider.uiCapabilities.supportsMaxThinkingTokens
    && configured.maxThinkingTokens !== undefined
  ) {
    defaults.maxThinkingTokens = configured.maxThinkingTokens
  }

  return defaults
}

export function providerSupportsPermissionMode(
  provider: ProviderAdapter,
  mode: ClaudePermissionMode,
): boolean {
  return provider.uiCapabilities.permissionModes.some((option) => option.value === mode)
}

export function unsupportedProviderPermissionModeError(
  provider: ProviderAdapter,
  mode: ClaudePermissionMode,
): string {
  const supportedModes = provider.uiCapabilities.permissionModes
    .map((option) => option.value)
    .join(', ')
  return `permissionMode "${mode}" is not supported by provider ${provider.id}. Expected one of: ${supportedModes}`
}
