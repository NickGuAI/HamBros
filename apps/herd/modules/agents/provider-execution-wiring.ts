import type { MachineDaemonRegistry } from './daemon/registry.js'
import { createMachineLaunchRuntime, type MachineLaunchRuntime } from './session/machine-launch.js'
import type { ProviderAuthStore } from './provider-auth.js'
import {
  createProviderExecutionCapability,
  isProviderExecutionAllowed,
  resolveProviderExecutionMode,
  type ProviderExecutionCapability,
  type ProviderExecutionMode,
} from './provider-execution-mode.js'
import { listProviders } from './providers/registry.js'
import type { MachineConfig } from './types.js'

interface ProviderExecutionWiringDeps {
  daemonRegistry: MachineDaemonRegistry
  providerAuthStore: Pick<ProviderAuthStore, 'listPoolCredentials'>
  readMachineRegistry(): Promise<MachineConfig[]>
  env?: NodeJS.ProcessEnv
}

export interface ProviderExecutionWiring {
  providerExecutionMode: ProviderExecutionMode
  machineLaunchRuntime: MachineLaunchRuntime
  providerExecution: ProviderExecutionCapability
  allowsMachine(machine: MachineConfig | undefined): boolean
}

/** Owns the shared mode, launch resolver, and readiness capability as one rail. */
export function createProviderExecutionWiring(
  deps: ProviderExecutionWiringDeps,
): ProviderExecutionWiring {
  const providerExecutionMode = resolveProviderExecutionMode(deps.env)
  const machineLaunchRuntime = createMachineLaunchRuntime({
    daemonRegistry: deps.daemonRegistry,
    providerAuthStore: deps.providerAuthStore,
    providerExecutionMode,
    readMachineRegistry: deps.readMachineRegistry,
  })
  const providerExecution = createProviderExecutionCapability({
    mode: providerExecutionMode,
    daemonRegistry: deps.daemonRegistry,
    providerIds: listProviders().map((provider) => provider.id),
    readMachineRegistry: deps.readMachineRegistry,
    resolveDaemonLaunchReadiness: machineLaunchRuntime.resolveDaemonLaunchReadiness,
  })

  return {
    providerExecutionMode,
    machineLaunchRuntime,
    providerExecution,
    allowsMachine: (machine) => isProviderExecutionAllowed(providerExecutionMode, machine),
  }
}
