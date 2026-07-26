import { loadCommanderRuntimeConfig } from '../../commanders/runtime-config.js'
import {
  DEFAULT_AGENT_PRUNER_ENABLED,
  DEFAULT_AGENT_PRUNER_EXITED_SESSION_TTL_MS,
  DEFAULT_AGENT_PRUNER_STALE_SESSION_TTL_MS,
  DEFAULT_AGENT_PRUNER_SWEEP_INTERVAL_MS,
} from '../constants.js'
import type { SessionPrunerConfig } from '../persistence-helpers.js'

export interface SessionPrunerRuntimeConfig extends SessionPrunerConfig {
  sweepIntervalMs: number
}

export function resolveSessionPrunerRuntimeConfig(
  enabledOverride?: boolean,
): SessionPrunerRuntimeConfig {
  const configured = loadCommanderRuntimeConfig().agents?.pruner
  return {
    enabled: enabledOverride ?? configured?.enabled ?? DEFAULT_AGENT_PRUNER_ENABLED,
    sweepIntervalMs: configured?.sweepIntervalMs ?? DEFAULT_AGENT_PRUNER_SWEEP_INTERVAL_MS,
    staleSessionTtlMs: configured?.staleSessionTtlMs ?? DEFAULT_AGENT_PRUNER_STALE_SESSION_TTL_MS,
    exitedSessionTtlMs: configured?.exitedSessionTtlMs ?? DEFAULT_AGENT_PRUNER_EXITED_SESSION_TTL_MS,
  }
}
