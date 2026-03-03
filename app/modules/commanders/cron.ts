import {
  NightlyConsolidation,
  type CronEngine,
  type NightlyConsolidationOptions,
} from './memory/consolidation.js'

export const NIGHTLY_CONSOLIDATION_CRON = '0 2 * * *'

/**
 * Registers Commander cron jobs. Currently: nightly memory consolidation at 02:00.
 */
export function registerCommanderCron(
  cronEngine: CronEngine,
  options: NightlyConsolidationOptions = {},
): NightlyConsolidation {
  const consolidation = new NightlyConsolidation(options)
  consolidation.register(cronEngine)
  return consolidation
}
