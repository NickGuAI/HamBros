import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  NightlyConsolidation,
  type CronEngine,
  type NightlyConsolidationOptions,
} from './memory/consolidation.js'
import { JournalWriter } from './memory/journal.js'
import { CommanderSessionStore } from './store.js'

export const NIGHTLY_CONSOLIDATION_CRON = '0 2 * * *'
export const COMMANDER_MEMORY_ONLY_SYNC_CRON = '*/5 * * * *'
export const COMMANDER_FULL_SYNC_CRON = '30 * * * *'
export const MORNING_BRIEFING_CRON = '50 8 * * *'
export const MICRO_RESET_CRON = '15 9 * * *'

type CommanderSyncMode = 'memory' | 'full'
type CommanderMemorySyncRunner = (mode: CommanderSyncMode) => Promise<void>

interface CommanderCronOptions extends NightlyConsolidationOptions {
  commanderSessionStorePath?: string
  enableS3Sync?: boolean
  memoryOnlySyncCron?: string
  fullSyncCron?: string
  memorySyncRunner?: CommanderMemorySyncRunner
}

const execFileAsync = promisify(execFile)

async function defaultCommanderMemorySyncRunner(
  mode: CommanderSyncMode,
): Promise<void> {
  const scriptPath = path.resolve(process.cwd(), 'scripts', 'commander-memory-sync.sh')
  await execFileAsync(scriptPath, [mode], {
    env: process.env,
    maxBuffer: 1024 * 1024,
  })
}

function scheduleCommanderMemorySync(
  cronEngine: CronEngine,
  expression: string,
  mode: CommanderSyncMode,
  runner: CommanderMemorySyncRunner,
): void {
  const jobName = mode === 'memory'
    ? 'commander-memory-sync-memory-only'
    : 'commander-memory-sync-full'

  cronEngine.schedule(
    expression,
    () => {
      void runner(mode).catch((error) => {
        console.error(`[commanders] Failed ${mode} S3 sync:`, error)
      })
    },
    { name: jobName },
  )
}

/**
 * Registers Commander cron jobs:
 * - nightly memory consolidation at 02:00
 * - optional S3 durability syncs (memory-only every 5 min + full hourly)
 */
export function registerCommanderCron(
  cronEngine: CronEngine,
  options: CommanderCronOptions = {},
): NightlyConsolidation {
  const { commanderSessionStorePath, ...consolidationOptions } = options
  const resolvedOptions: NightlyConsolidationOptions = {
    ...consolidationOptions,
  }

  if (!resolvedOptions.commanderIdsForCron && !resolvedOptions.commanderIdsForCronResolver) {
    resolvedOptions.commanderIdsForCronResolver = async () => {
      const sessions = await new CommanderSessionStore(commanderSessionStorePath).list()
      return sessions.map((session) => session.id)
    }
  }

  const consolidation = new NightlyConsolidation(resolvedOptions)
  consolidation.register(cronEngine)

  if (options.enableS3Sync) {
    const syncRunner = options.memorySyncRunner ?? defaultCommanderMemorySyncRunner
    scheduleCommanderMemorySync(
      cronEngine,
      options.memoryOnlySyncCron ?? COMMANDER_MEMORY_ONLY_SYNC_CRON,
      'memory',
      syncRunner,
    )
    scheduleCommanderMemorySync(
      cronEngine,
      options.fullSyncCron ?? COMMANDER_FULL_SYNC_CRON,
      'full',
      syncRunner,
    )
  }

  cronEngine.schedule(
    MORNING_BRIEFING_CRON,
    async () => {
      const commanderIds = await resolvedOptions.commanderIdsForCronResolver!()
      for (const commanderId of commanderIds) {
        const journalWriter = new JournalWriter(commanderId, resolvedOptions.basePath)
        await journalWriter.append({
          timestamp: new Date().toISOString(),
          issueNumber: null,
          repo: null,
          outcome: 'Morning briefing',
          durationMin: null,
          salience: 'NOTABLE',
          body: [
            '### Morning Briefing',
            '- Check open PRs: `gh pr list --repo NickGuAI/monorepo-g`',
            '- Check quests: `hammurabi quests list`',
            '- Review yesterday\'s insights: `~/.ginsights/personal/daily/`',
          ].join('\n'),
        }).catch((err) => {
          console.error(`[commanders] Failed morning briefing journal write for ${commanderId}:`, err)
        })
      }
    },
    { name: 'commander-morning-briefing' },
  )

  cronEngine.schedule(
    MICRO_RESET_CRON,
    async () => {
      const commanderIds = await resolvedOptions.commanderIdsForCronResolver!()
      for (const commanderId of commanderIds) {
        const journalWriter = new JournalWriter(commanderId, resolvedOptions.basePath)
        await journalWriter.append({
          timestamp: new Date().toISOString(),
          issueNumber: null,
          repo: null,
          outcome: 'Micro-reset accountability check-in',
          durationMin: null,
          salience: 'ROUTINE',
          body: [
            '### Micro-Reset',
            '- Review one prescription from `~/App/11-prescriptions.md`',
            '- Surface daily focus: what is the highest-leverage task right now?',
          ].join('\n'),
        }).catch((err) => {
          console.error(`[commanders] Failed micro-reset journal write for ${commanderId}:`, err)
        })
      }
    },
    { name: 'commander-micro-reset' },
  )

  return consolidation
}
