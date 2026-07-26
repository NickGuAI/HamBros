import type { DaemonConnectionSnapshot, MachineDaemonRegistry } from './daemon/registry.js'
import { isDaemonMachine } from './machines.js'
import type { AgentType, MachineConfig } from './types.js'

export const PROVIDER_EXECUTION_MODES = ['host-or-daemon', 'daemon-only'] as const
export type ProviderExecutionMode = typeof PROVIDER_EXECUTION_MODES[number]

export const DEFAULT_PROVIDER_EXECUTION_MODE: ProviderExecutionMode = 'host-or-daemon'
export const PROVIDER_EXECUTION_MODE_ENV = 'HERD_PROVIDER_EXECUTION_MODE'
export const HERD_PROVIDER_EXECUTION_MODE_ENV = 'HERD_PROVIDER_EXECUTION_MODE'

export interface ProviderExecutionDaemonReadiness {
  machineId: string
  connected: boolean
  installedProviderIds: AgentType[]
  readyProviderIds: AgentType[]
}

export interface ProviderExecutionReadiness {
  mode: ProviderExecutionMode
  hostExecutionAllowed: boolean
  daemonRequired: boolean
  ready: boolean
  registeredDaemonCount: number
  connectedDaemonCount: number
  providerReadyDaemonCount: number
  readyProviderIds: AgentType[]
  daemons: ProviderExecutionDaemonReadiness[]
  summary: string
}

export interface ProviderExecutionCapability {
  readonly mode: ProviderExecutionMode
  getReadiness(): Promise<ProviderExecutionReadiness>
}

export class ProviderExecutionModeError extends Error {
  readonly code = 'DAEMON_REQUIRED'
  readonly statusCode = 409

  constructor(target: string, message?: string) {
    super(message ?? (
      `Provider execution mode is "daemon-only"; target "${target}" cannot launch provider processes on the Herd server or over SSH. `
      + 'Open Settings → Machines, mint an enrollment token, run '
      + '`herd connect https://<herd-host> --token <enrollment-token>` on the execution machine, '
      + 'wait for its provider to report ready, then retry with that daemon machine ID as `machineId` '
      + '(or persist it as the commander\'s `executionMachineId`).'
    ))
    this.name = 'ProviderExecutionModeError'
  }
}

export function resolveProviderExecutionMode(
  env: NodeJS.ProcessEnv = process.env,
): ProviderExecutionMode {
  const configured = env[PROVIDER_EXECUTION_MODE_ENV]?.trim()
    || env[HERD_PROVIDER_EXECUTION_MODE_ENV]?.trim()
  if (!configured) {
    return DEFAULT_PROVIDER_EXECUTION_MODE
  }
  if ((PROVIDER_EXECUTION_MODES as readonly string[]).includes(configured)) {
    return configured as ProviderExecutionMode
  }
  throw new Error(
    `Invalid ${PROVIDER_EXECUTION_MODE_ENV} value "${configured}"; expected ${PROVIDER_EXECUTION_MODES.join(' or ')}`,
  )
}

export function isProviderExecutionAllowed(
  mode: ProviderExecutionMode,
  machine: MachineConfig | undefined,
): boolean {
  return mode === 'host-or-daemon' || isDaemonMachine(machine)
}

export function assertProviderExecutionAllowed(
  mode: ProviderExecutionMode,
  machine: MachineConfig | undefined,
): void {
  if (isProviderExecutionAllowed(mode, machine)) {
    return
  }
  throw new ProviderExecutionModeError(machine?.id ?? 'local')
}

interface ProviderExecutionCapabilityDeps {
  mode: ProviderExecutionMode
  daemonRegistry: Pick<MachineDaemonRegistry, 'getConnection'>
  providerIds: readonly AgentType[]
  readMachineRegistry(): Promise<MachineConfig[]>
  resolveDaemonLaunchReadiness(
    machine: MachineConfig | undefined,
    agentType: AgentType,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }>
}

function connectionReportsInstalledProvider(
  providerId: AgentType,
  providerHealth: DaemonConnectionSnapshot['providerHealth'],
): boolean {
  return Object.entries(providerHealth ?? {}).some(([key, status]) => (
    (key === providerId || status.provider === providerId) && status.installed === true
  ))
}

export function createProviderExecutionCapability(
  deps: ProviderExecutionCapabilityDeps,
): ProviderExecutionCapability {
  return {
    mode: deps.mode,
    async getReadiness(): Promise<ProviderExecutionReadiness> {
      const machines = await deps.readMachineRegistry()
      const daemonMachines = machines.filter(isDaemonMachine)
      const daemons = await Promise.all(daemonMachines.map(async (machine) => {
        const connection = deps.daemonRegistry.getConnection(machine.id)
        const installedProviderIds = connection
          ? deps.providerIds.filter((providerId) => (
              connectionReportsInstalledProvider(providerId, connection.providerHealth)
            ))
          : []
        const readiness = connection
          ? await Promise.all(deps.providerIds.map(async (providerId) => ({
              providerId,
              readiness: await deps.resolveDaemonLaunchReadiness(machine, providerId),
            })))
          : []
        const readyProviderIds = readiness
          .filter((entry) => entry.readiness.ok)
          .map((entry) => entry.providerId)
        return {
          machineId: machine.id,
          connected: Boolean(connection),
          installedProviderIds,
          readyProviderIds,
        }
      }))
      const readyProviderIds = [...new Set(daemons.flatMap((daemon) => daemon.readyProviderIds))]
      const connectedDaemonCount = daemons.filter((daemon) => daemon.connected).length
      const providerReadyDaemonCount = daemons.filter((daemon) => daemon.readyProviderIds.length > 0).length
      const hostExecutionAllowed = deps.mode === 'host-or-daemon'
      const ready = hostExecutionAllowed || providerReadyDaemonCount > 0

      return {
        mode: deps.mode,
        hostExecutionAllowed,
        daemonRequired: !hostExecutionAllowed,
        ready,
        registeredDaemonCount: daemons.length,
        connectedDaemonCount,
        providerReadyDaemonCount,
        readyProviderIds,
        daemons,
        summary: hostExecutionAllowed
          ? 'Provider processes may run on the Herd server, over SSH, or on a connected daemon.'
          : ready
            ? `${providerReadyDaemonCount} connected daemon${providerReadyDaemonCount === 1 ? '' : 's'} can launch at least one provider.`
            : 'Connect a provider-ready daemon before launching commanders, conversations, automations, or workers.',
      }
    },
  }
}
