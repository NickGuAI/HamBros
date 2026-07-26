import type { ProviderCreateOptions, ProviderTeardownOptions } from '../providers/provider-adapter.js'
import type { MachineLaunchRuntime } from './machine-launch.js'
import { withCommanderRuntimeLaunch } from '../../commanders/package-lifecycle-state.js'
import { resolveCommanderDataDir } from '../../commanders/paths.js'
import {
  COMMANDER_WORKER_LAUNCH_BODY_KEYS,
  launchProviderWorkerSession,
  parseWorkerLaunchRequest,
  type WorkerLaunchSessionResult,
} from '../worker-launch.js'
import type {
  AgentType,
  AnySession,
  ClaudePermissionMode,
  MachineConfig,
  StreamSession,
  TrustedWorkerLaunchSourceDefaults,
} from '../types.js'

type ProviderStreamSessionOptions = Omit<
  ProviderCreateOptions,
  'sessionName' | 'mode' | 'task' | 'cwd' | 'machine'
>

interface CommanderWorkerDispatcherDeps {
  commanderLifecycleScope?: string
  maxSessions: number
  sessions: Map<string, AnySession>
  resolveProviderLaunchMachine: MachineLaunchRuntime['resolveProviderLaunchMachine']
  createProviderStreamSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    task: string,
    cwd: string | undefined,
    machine: MachineConfig | undefined,
    agentType?: AgentType,
    options?: ProviderStreamSessionOptions,
  ): Promise<StreamSession>
  teardownProviderSession(session: StreamSession, reason: string, options?: ProviderTeardownOptions): Promise<void>
  schedulePersistedSessionsWrite(): void
}

export function createCommanderWorkerDispatcher(deps: CommanderWorkerDispatcherDeps) {
  const commanderLifecycleScope = deps.commanderLifecycleScope ?? resolveCommanderDataDir()
  return async function dispatchWorkerForCommander({
    commanderId,
    abortSignal,
    rawBody,
    trustedSourceDefaults,
  }: {
    commanderId: string
    abortSignal?: AbortSignal
    rawBody: unknown
    trustedSourceDefaults?: TrustedWorkerLaunchSourceDefaults
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    const parsed = parseWorkerLaunchRequest({
      allowedBodyKeys: COMMANDER_WORKER_LAUNCH_BODY_KEYS,
      creator: { kind: 'commander', id: commanderId },
      currentSkillInvocationNull: 'invalid',
      fallbackCwd: process.env.HOME ?? '/tmp',
      rawBody,
      requireName: true,
      routeLabel: '/api/commanders/:id/workers',
      sourceDefaults: trustedSourceDefaults,
    })
    if (!parsed.ok) {
      return { status: parsed.status, body: parsed.body }
    }

    const launched: WorkerLaunchSessionResult = await withCommanderRuntimeLaunch(
      commanderId,
      commanderLifecycleScope,
      () => launchProviderWorkerSession(
        {
          commanderLifecycleScope,
          createProviderStreamSession: deps.createProviderStreamSession,
          maxSessions: deps.maxSessions,
          resolveMachine: (requestedMachineId) => (
            deps.resolveProviderLaunchMachine(requestedMachineId, parsed.request.agentType)
          ),
          schedulePersistedSessionsWrite: deps.schedulePersistedSessionsWrite,
          sessions: deps.sessions,
          teardownProviderSession: deps.teardownProviderSession,
        },
        parsed.request,
        {
          abortSignal,
          missingCwdError: 'Provide cwd or machineId when dispatching a commander worker',
        },
      ),
    )
    if (!launched.ok) {
      return { status: launched.status, body: launched.body }
    }

    return {
      status: 201,
      body: {
        sessionName: parsed.request.sessionName,
        mode: parsed.request.mode,
        sessionType: launched.session.sessionType,
        creator: launched.session.creator,
        transportType: 'stream',
        agentType: parsed.request.agentType,
        host: launched.session.host,
        created: true,
      },
    }
  }
}
