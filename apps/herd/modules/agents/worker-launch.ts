import {
  DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE,
  type ClaudeAdaptiveThinkingMode,
} from '../claude-adaptive-thinking.js'
import {
  DEFAULT_CLAUDE_MAX_THINKING_TOKENS,
  type ClaudeMaxThinkingTokens,
} from '../claude-max-thinking-tokens.js'
import {
  parseActiveSkillInvocation,
  parseClaudeAdaptiveThinking,
  parseClaudeMaxThinkingTokens,
  parseOptionalClaudePermissionMode,
  parseCwd,
  parseMachinePlacement,
  parseOptionalModel,
  parseOptionalTask,
  parseSessionName,
  parseSessionType,
} from './session/input.js'
import { ProviderAuthRequiredError } from './provider-auth.js'
import {
  getAgentEffortLevels,
  getAgentModelEffortCapability,
  getDefaultAgentEffort,
  parseOptionalAgentEffort,
  parseStoredAgentEffort,
  type AgentEffortLevel,
} from './effort.js'
import {
  providerSupportsPermissionMode,
  resolveProviderDefaults,
  unsupportedProviderPermissionModeError,
  type ProviderCreateOptions,
} from './providers/provider-adapter.js'
import { withCommanderRuntimeLaunch } from '../commanders/package-lifecycle-state.js'
import { resolveCommanderDataDir } from '../commanders/paths.js'
import { getProvider, resolveProviderIdForRequest } from './providers/registry.js'
import { getCachedProviderModelsForValidation } from './providers/model-discovery.js'
import {
  findProviderModelOption,
  validateModelForAgentType,
} from './providers/validate-model.js'
import {
  isProviderLaunchError,
  type MachineLaunchResolution,
} from './session/machine-launch.js'
import type {
  ActiveSkillInvocation,
  AgentType,
  AnySession,
  ClaudePermissionMode,
  MachineConfig,
  SessionCreator,
  StreamSession,
} from './types.js'

type WorkerLaunchBody = Record<string, unknown>

export const COMMANDER_WORKER_LAUNCH_BODY_KEYS = new Set([
  'adaptiveThinking',
  'agentType',
  'currentSkillInvocation',
  'cwd',
  'effort',
  'host',
  'machineId',
  'maxThinkingTokens',
  'model',
  'name',
  'permissionMode',
  'sessionType',
  'task',
])

interface WorkerLaunchSourceDefaults {
  agentType?: AgentType
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  currentSkillInvocation?: ActiveSkillInvocation
  cwd?: string
  effort?: AgentEffortLevel
  omitEffort?: boolean
  host?: string
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  mode?: ClaudePermissionMode
  model?: string
}

interface ParseWorkerLaunchRequestOptions {
  allowedBodyKeys: ReadonlySet<string>
  creator: SessionCreator
  currentSkillInvocationNull: 'clear' | 'invalid'
  fallbackCwd?: string
  generatedName?: string
  mode?: ClaudePermissionMode
  preferMachineCwd?: boolean
  rawBody: unknown
  requireName: boolean
  routeLabel: string
  sourceDefaults?: WorkerLaunchSourceDefaults
  spawnedBy?: string
}

export interface ParsedWorkerLaunchRequest {
  agentType: AgentType
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  creator: SessionCreator
  currentSkillInvocation?: ActiveSkillInvocation
  effort?: AgentEffortLevel
  omitEffort?: boolean
  fallbackCwd?: string
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  mode: ClaudePermissionMode
  model?: string
  preferMachineCwd: boolean
  requestedCwd?: string
  requestedHost?: string
  sessionName: string
  spawnedBy?: string
  task: string
}

export type WorkerLaunchParseResult =
  | { ok: true; request: ParsedWorkerLaunchRequest }
  | { ok: false; status: number; body: Record<string, unknown> }

export type WorkerLaunchSessionResult =
  | { ok: true; session: StreamSession }
  | { ok: false; status: number; body: Record<string, unknown> }

export interface WorkerLaunchSessionDeps {
  commanderLifecycleScope?: string
  createProviderStreamSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    task: string,
    cwd: string | undefined,
    machine: MachineConfig | undefined,
    agentType?: AgentType,
    options?: Omit<ProviderCreateOptions, 'sessionName' | 'mode' | 'task' | 'cwd' | 'machine'>,
  ): Promise<StreamSession>
  maxSessions: number
  resolveDaemonLaunchReadiness?(
    machine: MachineConfig | undefined,
    agentType: AgentType,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }>
  resolveMachine(
    requestedHost: string | undefined,
  ): Promise<MachineLaunchResolution>
  schedulePersistedSessionsWrite(): void
  sessions: Map<string, AnySession>
  teardownProviderSession?(session: StreamSession, reason: string): Promise<void>
}

export function asWorkerLaunchBody(rawBody: unknown): WorkerLaunchBody {
  return rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
    ? rawBody as WorkerLaunchBody
    : {}
}

function hasOwn(body: WorkerLaunchBody, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key)
}

function renderUnknownKeys(keys: string[]): string {
  return keys.map((key) => `"${key}"`).join(', ')
}

function unknownBodyPropertiesError(keys: string[]): Record<string, unknown> {
  const noun = keys.length === 1 ? 'property' : 'properties'
  return {
    error: `Unknown request body ${noun}: ${renderUnknownKeys(keys)}`,
  }
}

export function parseWorkerLaunchRequest(
  options: ParseWorkerLaunchRequestOptions,
): WorkerLaunchParseResult {
  const body = asWorkerLaunchBody(options.rawBody)
  if (hasOwn(body, 'creator')) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `creator must not be provided on ${options.routeLabel} - worker creator is supplied by the authenticated route context`,
      },
    }
  }

  if (hasOwn(body, 'parentSession')) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'parentSession is not honored on worker launch routes. Commander attribution is carried by creator, supplied by the route context.',
      },
    }
  }

  const unknownKeys = Object.keys(body).filter((key) => !options.allowedBodyKeys.has(key))
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      status: 400,
      body: unknownBodyPropertiesError(unknownKeys),
    }
  }

  const rawSessionType = body.sessionType
  const parsedSessionType = parseSessionType(rawSessionType)
  if (parsedSessionType === null) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'Invalid sessionType. Expected one of: commander, worker, cron, sentinel, automation',
      },
    }
  }
  if (parsedSessionType !== undefined && parsedSessionType !== 'worker') {
    return {
      ok: false,
      status: 400,
      body: {
        error: `sessionType must be "worker" on ${options.routeLabel} (received "${String(rawSessionType)}")`,
      },
    }
  }

  const bodySessionName = hasOwn(body, 'name') ? parseSessionName(body.name) : undefined
  const sessionName = bodySessionName ?? options.generatedName
  if (!sessionName || (options.requireName && !bodySessionName)) {
    return { ok: false, status: 400, body: { error: 'Invalid session name' } }
  }

  const parsedAdaptiveThinking = parseClaudeAdaptiveThinking(body.adaptiveThinking)
  if (parsedAdaptiveThinking === null) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid adaptiveThinking. Expected one of: enabled, disabled' },
    }
  }

  const parsedMaxThinkingTokens = parseClaudeMaxThinkingTokens(body.maxThinkingTokens)
  if (parsedMaxThinkingTokens === null) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid maxThinkingTokens. Expected integer 1024..256000' },
    }
  }

  const task = parseOptionalTask(body.task)
  if (task === null) {
    return { ok: false, status: 400, body: { error: 'Task must be a string' } }
  }

  const model = parseOptionalModel(body.model)
  if (model === null) {
    return { ok: false, status: 400, body: { error: 'model must be a string when provided' } }
  }

  const parsedPermissionMode = parseOptionalClaudePermissionMode(body.permissionMode)
  if (parsedPermissionMode === null) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid permissionMode. Expected one of: default, acceptEdits, bypassPermissions' },
    }
  }

  const currentSkillInvocationOverrideRequested = hasOwn(body, 'currentSkillInvocation')
  const rawCurrentSkillInvocation = body.currentSkillInvocation
  const parsedCurrentSkillInvocation =
    rawCurrentSkillInvocation === null && options.currentSkillInvocationNull === 'clear'
      ? undefined
      : parseActiveSkillInvocation(rawCurrentSkillInvocation)
  if (currentSkillInvocationOverrideRequested && parsedCurrentSkillInvocation === null) {
    return {
      ok: false,
      status: 400,
      body: {
        error: options.currentSkillInvocationNull === 'clear'
          ? 'Invalid currentSkillInvocation. Expected { skillId, displayName, startedAt, toolUseId? } or null'
          : 'Invalid currentSkillInvocation. Expected { skillId, displayName, startedAt, toolUseId? }',
      },
    }
  }
  const requestedCurrentSkillInvocation = parsedCurrentSkillInvocation ?? undefined

  const requestedCwd = parseCwd(body.cwd)
  if (requestedCwd === null) {
    return { ok: false, status: 400, body: { error: 'Invalid cwd: must be an absolute path' } }
  }

  const placement = parseMachinePlacement(body.machineId, body.host)
  if (!placement.ok) {
    return { ok: false, status: 400, body: { error: placement.error } }
  }
  const requestedHost = placement.machineId

  const providerResolution = resolveProviderIdForRequest(body.agentType, {
    defaultProviderId: options.sourceDefaults?.agentType,
  })
  if (providerResolution.error || !providerResolution.providerId) {
    return {
      ok: false,
      status: 400,
      body: {
        error: providerResolution.error ?? 'agentType must be a registered provider id',
        validIds: providerResolution.validIds,
      },
    }
  }
  const agentType = providerResolution.providerId as AgentType
  const provider = getProvider(agentType)
  if (!provider?.capabilities.supportsWorkerDispatch) {
    return {
      ok: false,
      status: 400,
      body: { error: `Provider ${agentType} cannot dispatch worker sessions` },
    }
  }
  const parsedEffort = parseOptionalAgentEffort(agentType, body.effort)
  if (parsedEffort === null) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Invalid effort for ${agentType}. Expected one of: ${getAgentEffortLevels(agentType).join(', ')}`,
      },
    }
  }
  const mode = parsedPermissionMode ?? options.mode ?? options.sourceDefaults?.mode ?? 'default'
  if (!providerSupportsPermissionMode(provider, mode)) {
    return {
      ok: false,
      status: 400,
      body: { error: unsupportedProviderPermissionModeError(provider, mode) },
    }
  }

  const effectiveModel = model ?? options.sourceDefaults?.model
  const usesTrustedSourceModel = options.sourceDefaults?.agentType === agentType
    && effectiveModel !== undefined
    && effectiveModel === options.sourceDefaults.model
    && (model === undefined || model === options.sourceDefaults.model)
  const modelValidation = usesTrustedSourceModel
    ? { ok: true as const }
    : validateModelForAgentType(agentType, effectiveModel ?? null)
  if (!modelValidation.ok) {
    return {
      ok: false,
      status: 400,
      body: { error: modelValidation.error, validIds: modelValidation.validIds },
    }
  }

  const resolvedModels = getCachedProviderModelsForValidation(provider)
  const modelOption = findProviderModelOption(resolvedModels.models, effectiveModel)
  const modelEffortCapability = getAgentModelEffortCapability(agentType, modelOption)
  const supportedEffortLevels = modelEffortCapability.supportedEffortLevels
  const providerDefaults = resolveProviderDefaults(provider)
  const inheritedEffort = parseStoredAgentEffort(agentType, options.sourceDefaults?.effort)
  const sourceModelOmitsEffort = usesTrustedSourceModel
    && options.sourceDefaults?.omitEffort === true
  const modelOmitsEffort = provider.uiCapabilities.supportsEffort
    && !modelEffortCapability.supportsEffort
  if ((sourceModelOmitsEffort || modelOmitsEffort) && parsedEffort) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Model "${modelOption?.label ?? effectiveModel ?? agentType}" does not support effort`,
      },
    }
  }
  const omitEffort = (sourceModelOmitsEffort || modelOmitsEffort) && parsedEffort === undefined
  const effort = provider.uiCapabilities.supportsEffort && !omitEffort
    ? (
      parsedEffort
      ?? (inheritedEffort ?? undefined)
      ?? providerDefaults.effort
      ?? getDefaultAgentEffort(agentType)
    )
    : undefined
  if (effort && !supportedEffortLevels.includes(effort)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Invalid effort for model "${modelOption?.label ?? effectiveModel ?? agentType}". Expected one of: ${supportedEffortLevels.join(', ')}`,
      },
    }
  }
  const adaptiveThinking = provider.uiCapabilities.supportsAdaptiveThinking
    ? (
      parsedAdaptiveThinking
      ?? options.sourceDefaults?.adaptiveThinking
      ?? providerDefaults.adaptiveThinking
      ?? DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE
    )
    : undefined
  const maxThinkingTokens = provider.uiCapabilities.supportsMaxThinkingTokens
    ? (
      parsedMaxThinkingTokens
      ?? options.sourceDefaults?.maxThinkingTokens
      ?? providerDefaults.maxThinkingTokens
      ?? DEFAULT_CLAUDE_MAX_THINKING_TOKENS
    )
    : undefined

  return {
    ok: true,
    request: {
      agentType,
      creator: options.creator,
      mode,
      preferMachineCwd: options.preferMachineCwd ?? false,
      sessionName,
      task: task ?? '',
      ...(adaptiveThinking !== undefined ? { adaptiveThinking } : {}),
      ...(currentSkillInvocationOverrideRequested
        ? (
          requestedCurrentSkillInvocation !== undefined
            ? { currentSkillInvocation: requestedCurrentSkillInvocation }
            : {}
        )
        : (
          options.sourceDefaults?.currentSkillInvocation !== undefined
            ? { currentSkillInvocation: options.sourceDefaults.currentSkillInvocation }
            : {}
        )),
      ...(effort !== undefined ? { effort } : {}),
      ...(omitEffort ? { omitEffort: true } : {}),
      ...(options.fallbackCwd !== undefined ? { fallbackCwd: options.fallbackCwd } : {}),
      ...(maxThinkingTokens !== undefined ? { maxThinkingTokens } : {}),
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      ...(requestedCwd !== undefined ? { requestedCwd } : {}),
      ...(requestedHost ?? options.sourceDefaults?.host
        ? { requestedHost: requestedHost ?? options.sourceDefaults?.host }
        : {}),
      ...(options.spawnedBy ? { spawnedBy: options.spawnedBy } : {}),
    },
  }
}

export async function launchProviderWorkerSession(
  deps: WorkerLaunchSessionDeps,
  request: ParsedWorkerLaunchRequest,
  options: {
    abortSignal?: AbortSignal
    missingCwdError: string
  },
): Promise<WorkerLaunchSessionResult> {
  if (options.abortSignal?.aborted) {
    return { ok: false, status: 499, body: { error: 'Worker dispatch was cancelled before launch' } }
  }

  if (deps.sessions.has(request.sessionName)) {
    return { ok: false, status: 409, body: { error: `Session "${request.sessionName}" already exists` } }
  }

  if (deps.sessions.size >= deps.maxSessions) {
    return { ok: false, status: 429, body: { error: `Session limit reached (${deps.maxSessions})` } }
  }

  const resolvedMachine = await deps.resolveMachine(request.requestedHost)
  if (!resolvedMachine.ok) {
    return {
      ok: false,
      status: resolvedMachine.status,
      body: {
        ...(resolvedMachine.code ? { code: resolvedMachine.code } : {}),
        error: resolvedMachine.error,
      },
    }
  }
  const machine = resolvedMachine.machine
  const daemonReadiness = await deps.resolveDaemonLaunchReadiness?.(machine, request.agentType)
  if (daemonReadiness && !daemonReadiness.ok) {
    return { ok: false, status: daemonReadiness.status, body: { error: daemonReadiness.error } }
  }

  const workerCwd = request.requestedCwd
    ?? (
      request.preferMachineCwd
        ? (machine?.cwd ?? request.fallbackCwd)
        : (request.fallbackCwd ?? machine?.cwd)
    )
  if (!workerCwd) {
    return { ok: false, status: 400, body: { error: options.missingCwdError } }
  }

  const launch = async (): Promise<WorkerLaunchSessionResult> => {
    try {
    const session = await deps.createProviderStreamSession(
      request.sessionName,
      request.mode,
      request.task,
      workerCwd,
      machine,
      request.agentType,
      {
        sessionType: 'worker',
        creator: request.creator,
        ...(request.adaptiveThinking !== undefined ? { adaptiveThinking: request.adaptiveThinking } : {}),
        ...(request.currentSkillInvocation !== undefined
          ? { currentSkillInvocation: request.currentSkillInvocation }
          : {}),
        ...(request.effort !== undefined ? { effort: request.effort } : {}),
        ...(request.omitEffort ? { omitEffort: true } : {}),
        ...(request.maxThinkingTokens !== undefined ? { maxThinkingTokens: request.maxThinkingTokens } : {}),
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.spawnedBy ? { spawnedBy: request.spawnedBy } : {}),
      },
    )
    session.mode = request.mode
    session.sessionType = 'worker'
    session.creator = request.creator
    session.cwd = workerCwd
    if (request.spawnedBy) {
      session.spawnedBy = request.spawnedBy
    }

    if (options.abortSignal?.aborted) {
      await deps.teardownProviderSession?.(session, 'Worker dispatch was cancelled before registration')
      return {
        ok: false,
        status: 499,
        body: { error: 'Worker dispatch was cancelled before registration' },
      }
    }

    deps.sessions.set(request.sessionName, session)
    deps.schedulePersistedSessionsWrite()
    return { ok: true, session }
    } catch (err) {
      if (err instanceof ProviderAuthRequiredError) {
        return {
          ok: false,
          status: 424,
          body: {
            code: 'AUTH_REQUIRED',
            provider: err.provider,
            status: err.snapshot.status,
            authMethod: err.snapshot.authMethod,
            scopeId: err.snapshot.scopeId,
            host: err.snapshot.host,
            reauthUrl: err.snapshot.reauthUrl,
            error: err.message,
          },
        }
      }
      if (isProviderLaunchError(err)) {
        return {
          ok: false,
          status: err.statusCode,
          body: {
            ...(err.code ? { code: err.code } : {}),
            error: err.message,
          },
        }
      }
      const message = err instanceof Error ? err.message : 'Failed to create stream session'
      return { ok: false, status: 500, body: { error: message } }
    }
  }

  const commanderId = request.creator.kind === 'commander'
    ? request.creator.id?.trim()
    : undefined
  return commanderId
    ? withCommanderRuntimeLaunch(
        commanderId,
        deps.commanderLifecycleScope ?? resolveCommanderDataDir(),
        launch,
      )
    : launch()
}
