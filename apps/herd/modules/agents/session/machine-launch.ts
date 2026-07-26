import { getProvider } from '../providers/registry.js'
import {
  isDaemonMachine,
  LOCAL_MACHINE_ID,
} from '../machines.js'
import { isDaemonPairingTokenExpired, type MachineDaemonRegistry } from '../daemon/registry.js'
import type { AgentType, MachineConfig } from '../types.js'
import {
  resolveReadyHostManagedPoolCredential,
  type ProviderAuthStore,
} from '../provider-auth.js'
import {
  assertProviderExecutionAllowed,
  DEFAULT_PROVIDER_EXECUTION_MODE,
  ProviderExecutionModeError,
  type ProviderExecutionMode,
} from '../provider-execution-mode.js'

interface MachineLaunchRuntimeDeps {
  daemonRegistry: MachineDaemonRegistry
  providerAuthStore: Pick<ProviderAuthStore, 'listPoolCredentials'>
  providerExecutionMode?: ProviderExecutionMode
  readMachineRegistry(): Promise<MachineConfig[]>
}

type DaemonLaunchReadiness =
  | { ok: true }
  | { ok: false; status: number; error: string }

export class ProviderMachineLaunchError extends Error {
  readonly statusCode: number
  readonly code?: string

  constructor(statusCode: number, message: string, code?: string) {
    super(message)
    this.name = 'ProviderMachineLaunchError'
    this.statusCode = statusCode
    this.code = code
  }
}

export class ProviderMachineSelectionError extends ProviderMachineLaunchError {
  constructor(agentType: AgentType, machineIds: readonly string[]) {
    super(
      409,
      `Multiple provider-ready daemon machines are available for ${agentType}: ${machineIds.join(', ')}. `
      + 'Choose one explicitly with `machineId`, or persist the choice on the commander as `executionMachineId`.',
      'MACHINE_SELECTION_REQUIRED',
    )
    this.name = 'ProviderMachineSelectionError'
  }
}

export type MachineLaunchResolution =
  | { ok: true; machine: MachineConfig | undefined }
  | {
      ok: false
      status: number
      error: string
      code?: string
      cause: ProviderExecutionModeError | ProviderMachineLaunchError
    }

export function isProviderLaunchError(
  error: unknown,
): error is ProviderExecutionModeError | ProviderMachineLaunchError {
  return error instanceof ProviderExecutionModeError
    || error instanceof ProviderMachineLaunchError
}

export interface MachineLaunchRuntime {
  resolveLaunchMachine(
    requestedMachineId: string | undefined,
  ): Promise<MachineLaunchResolution>
  resolveProviderLaunchMachine(
    requestedMachineId: string | undefined,
    agentType: AgentType,
  ): Promise<MachineLaunchResolution>
  resolveDaemonLaunchReadiness(
    machine: MachineConfig | undefined,
    agentType: AgentType,
  ): Promise<DaemonLaunchReadiness>
}

export function createMachineLaunchRuntime(
  deps: MachineLaunchRuntimeDeps,
): MachineLaunchRuntime {
  async function resolveLaunchMachine(
    requestedMachineId: string | undefined,
  ): Promise<MachineLaunchResolution> {
    const machineId = requestedMachineId ?? LOCAL_MACHINE_ID
    let machines: MachineConfig[]
    try {
      machines = await deps.readMachineRegistry()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read machines registry'
      const cause = new ProviderMachineLaunchError(500, message, 'MACHINE_REGISTRY_UNAVAILABLE')
      return { ok: false, status: cause.statusCode, error: cause.message, code: cause.code, cause }
    }

    const machine = machines.find((entry) => entry.id === machineId)
    if (!machine && requestedMachineId !== undefined) {
      const cause = new ProviderMachineLaunchError(
        400,
        `Unknown machine "${requestedMachineId}"`,
        'MACHINE_NOT_FOUND',
      )
      return { ok: false, status: cause.statusCode, error: cause.message, code: cause.code, cause }
    }
    try {
      assertProviderExecutionAllowed(
        deps.providerExecutionMode ?? DEFAULT_PROVIDER_EXECUTION_MODE,
        machine,
      )
    } catch (error) {
      if (error instanceof ProviderExecutionModeError) {
        return {
          ok: false,
          status: error.statusCode,
          error: error.message,
          code: error.code,
          cause: error,
        }
      }
      throw error
    }
    return { ok: true, machine }
  }

  async function resolveDaemonLaunchReadiness(
    machine: MachineConfig | undefined,
    agentType: AgentType,
  ): Promise<DaemonLaunchReadiness> {
    if (!isDaemonMachine(machine)) {
      return { ok: true }
    }
    // A daemon whose pairing token expired must not accept new sessions, even
    // while its WebSocket from before the expiry is still connected. This
    // keeps the launch gate in agreement with resolveMachineTransportStatus.
    if (isDaemonPairingTokenExpired(machine.daemon?.expiresAt)) {
      return {
        ok: false,
        status: 409,
        error: `Daemon machine "${machine.id}" pairing token expired; rotate pairing or mint a new enrollment token`,
      }
    }
    const connection = deps.daemonRegistry.getConnection(machine.id)
    if (!connection) {
      return {
        ok: false,
        status: 409,
        error: `Daemon machine "${machine.id}" is not connected`,
      }
    }
    const provider = getProvider(agentType)
    const providerKeys = [
      agentType,
      provider?.machineAuth?.cliBinaryName,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    const installed = providerKeys.some((key) => {
      const status = connection.providerHealth[key]
      return status?.installed === true
    })
    const nativeReady = providerKeys.some((key) => {
      const status = connection.providerHealth[key]
      return status?.installed === true && status.authenticated === true
    })
    if (installed && nativeReady) {
      return { ok: true }
    }

    let hostManagedReady = false
    if (installed) {
      try {
        hostManagedReady = (await resolveReadyHostManagedPoolCredential({
          provider: agentType,
          host: machine.id,
          store: deps.providerAuthStore,
        })).ready
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to read provider credential pool'
        return {
          ok: false,
          status: 500,
          error: message,
        }
      }
    }
    if (!installed || !hostManagedReady) {
      return {
        ok: false,
        status: 409,
        error: `Daemon machine "${machine.id}" is not ready for ${agentType}: provider auth is missing`,
      }
    }
    return { ok: true }
  }

  async function resolveProviderLaunchMachine(
    requestedMachineId: string | undefined,
    agentType: AgentType,
  ): Promise<MachineLaunchResolution> {
    const mode = deps.providerExecutionMode ?? DEFAULT_PROVIDER_EXECUTION_MODE
    if (requestedMachineId !== undefined || mode === 'host-or-daemon') {
      const resolved = await resolveLaunchMachine(requestedMachineId)
      if (!resolved.ok) {
        return resolved
      }
      const readiness = await resolveDaemonLaunchReadiness(resolved.machine, agentType)
      if (!readiness.ok) {
        const cause = new ProviderMachineLaunchError(
          readiness.status,
          readiness.error,
          'MACHINE_NOT_READY',
        )
        return { ok: false, status: cause.statusCode, error: cause.message, code: cause.code, cause }
      }
      return resolved
    }

    let machines: MachineConfig[]
    try {
      machines = await deps.readMachineRegistry()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read machines registry'
      const cause = new ProviderMachineLaunchError(500, message, 'MACHINE_REGISTRY_UNAVAILABLE')
      return { ok: false, status: cause.statusCode, error: cause.message, code: cause.code, cause }
    }

    const daemonMachines = machines.filter(isDaemonMachine)
    const readiness = await Promise.all(daemonMachines.map(async (machine) => ({
      machine,
      result: await resolveDaemonLaunchReadiness(machine, agentType),
    })))
    const readyMachines = readiness
      .filter((entry) => entry.result.ok)
      .map((entry) => entry.machine)

    if (readyMachines.length === 1) {
      return { ok: true, machine: readyMachines[0] }
    }
    if (readyMachines.length > 1) {
      const cause = new ProviderMachineSelectionError(
        agentType,
        readyMachines.map((machine) => machine.id),
      )
      return { ok: false, status: cause.statusCode, error: cause.message, code: cause.code, cause }
    }

    const readinessSummary = readiness.length === 0
      ? 'No daemon machines are registered.'
      : readiness.map(({ machine, result }) => (
          result.ok ? `${machine.id}: ready` : `${machine.id}: ${result.error}`
        )).join(' ')
    const cause = new ProviderExecutionModeError(
      'automatic daemon selection',
      `Provider execution mode is "daemon-only", but no provider-ready daemon can launch ${agentType}. `
      + `${readinessSummary} Open Settings → Machines, connect a daemon, wait for ${agentType} to report ready, `
      + 'then retry. You may choose a ready daemon with `machineId` or persist it as the commander\'s `executionMachineId`.',
    )
    return { ok: false, status: cause.statusCode, error: cause.message, code: cause.code, cause }
  }

  return {
    resolveLaunchMachine,
    resolveProviderLaunchMachine,
    resolveDaemonLaunchReadiness,
  }
}
