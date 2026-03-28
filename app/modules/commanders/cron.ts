import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  NightlyConsolidation,
  type CronEngine,
  type NightlyConsolidationOptions,
} from './memory/consolidation.js'
import { JournalWriter } from './memory/journal.js'
import type { JournalEntry } from './memory/types.js'
import type { WorkingMemoryEntry } from './memory/working-memory.js'
import { WorkingMemoryStore } from './memory/working-memory.js'
import { CommanderSessionStore } from './store.js'
import { HeartbeatLog, type HeartbeatLogEntry } from './heartbeat-log.js'
import { QuestStore, type CommanderQuest } from './quest-store.js'

export const NIGHTLY_CONSOLIDATION_CRON = '0 2 * * *'
export const COMMANDER_MEMORY_ONLY_SYNC_CRON = '*/5 * * * *'
export const COMMANDER_FULL_SYNC_CRON = '30 * * * *'
export const MORNING_BRIEFING_CRON = '50 8 * * *'
export const MICRO_RESET_CRON = '15 9 * * *'

const DAILY_OBSERVATIONS_OUTCOME = 'Daily observations'
const WORK_PULSE_OUTCOME = 'Work pulse reflection'
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000
const WORK_PULSE_WINDOW_MS = 6 * 60 * 60 * 1000
const OBSERVATION_KEYWORDS = /(investigat|diagnos|root cause|fix|patched|resolved|blocked|regression|incident|outage|deploy|rollback)/i
const PR_SIGNAL_PATTERN = /(\bpull request\b|\bpr\b|\/pull\/\d+)/i
const TRANSCRIPT_ERROR_PATTERN = /(error|failed|exception|timeout|crash)/i
const MAX_TRANSCRIPT_FILES = 4
const MAX_TRANSCRIPT_SIGNALS = 8

interface ActivityObservation {
  completedQuests: CommanderQuest[]
  failedQuests: CommanderQuest[]
  investigationEntries: JournalEntry[]
  workerCheckpoints: WorkingMemoryEntry[]
  heartbeatErrors: HeartbeatLogEntry[]
  sessionErrors: string[]
  transcriptHighlights: string[]
  prSignals: string[]
}

interface TranscriptActivitySignals {
  highlights: string[]
  prSignals: string[]
  sessionErrors: string[]
}

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

function compactSingleLine(value: string, maxLen = 180): string {
  const compacted = value.replace(/\s+/g, ' ').trim()
  if (compacted.length <= maxLen) {
    return compacted
  }
  return `${compacted.slice(0, Math.max(0, maxLen - 3))}...`
}

function toTime(value: string | null | undefined): number {
  if (!value) {
    return Number.NaN
  }
  return new Date(value).getTime()
}

function occurredSince(isoTimestamp: string | null | undefined, sinceMs: number): boolean {
  const ts = toTime(isoTimestamp)
  return Number.isFinite(ts) && ts >= sinceMs
}

function isSyntheticOutcome(outcome: string): boolean {
  return outcome === DAILY_OBSERVATIONS_OUTCOME || outcome === WORK_PULSE_OUTCOME
}

function deriveObservationSalience(observation: ActivityObservation): JournalEntry['salience'] {
  if (
    observation.failedQuests.length > 0 ||
    observation.heartbeatErrors.length > 0 ||
    observation.sessionErrors.length > 0
  ) {
    return 'SPIKE'
  }
  if (
    observation.completedQuests.length > 0 ||
    observation.investigationEntries.length > 0 ||
    observation.workerCheckpoints.length > 0 ||
    observation.transcriptHighlights.length > 0 ||
    observation.prSignals.length > 0
  ) {
    return 'NOTABLE'
  }
  return 'ROUTINE'
}

function hasActivity(observation: ActivityObservation): boolean {
  return (
    observation.completedQuests.length > 0 ||
    observation.failedQuests.length > 0 ||
    observation.investigationEntries.length > 0 ||
    observation.workerCheckpoints.length > 0 ||
    observation.heartbeatErrors.length > 0 ||
    observation.sessionErrors.length > 0 ||
    observation.transcriptHighlights.length > 0 ||
    observation.prSignals.length > 0
  )
}

function toQuestSnippet(quest: CommanderQuest): string {
  return compactSingleLine(quest.instruction, 140)
}

function pickObservationRepo(observation: ActivityObservation): string | null {
  const counts = new Map<string, number>()
  for (const entry of observation.investigationEntries) {
    if (!entry.repo) continue
    counts.set(entry.repo, (counts.get(entry.repo) ?? 0) + 1)
  }
  for (const quest of [...observation.completedQuests, ...observation.failedQuests]) {
    const firstRepoArtifact = (quest.artifacts ?? [])
      .find((artifact) => artifact.type === 'github_issue' || artifact.type === 'github_pr')
      ?.href
      ?.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1]
    if (!firstRepoArtifact) continue
    counts.set(firstRepoArtifact, (counts.get(firstRepoArtifact) ?? 0) + 1)
  }

  let selected: string | null = null
  let maxCount = -1
  for (const [repo, count] of counts.entries()) {
    if (count > maxCount) {
      selected = repo
      maxCount = count
    }
  }
  return selected
}

function buildObservationBody(observation: ActivityObservation, sinceIso: string): string {
  const lines: string[] = [
    `### Activity Window`,
    `- Since: ${sinceIso}`,
    `- Completed quests: ${observation.completedQuests.length}`,
    `- Failed quests: ${observation.failedQuests.length}`,
    `- Investigation highlights: ${observation.investigationEntries.length}`,
    `- Worker updates: ${observation.workerCheckpoints.length}`,
    `- Heartbeat errors: ${observation.heartbeatErrors.length}`,
    `- Session errors: ${observation.sessionErrors.length}`,
    `- Transcript highlights: ${observation.transcriptHighlights.length}`,
    `- PR signals: ${observation.prSignals.length}`,
  ]

  if (observation.completedQuests.length > 0) {
    lines.push('', '### Completed Quests')
    for (const quest of observation.completedQuests.slice(0, 5)) {
      lines.push(`- ${toQuestSnippet(quest)}`)
    }
  }

  if (observation.failedQuests.length > 0) {
    lines.push('', '### Failed Quests')
    for (const quest of observation.failedQuests.slice(0, 5)) {
      lines.push(`- ${toQuestSnippet(quest)}`)
    }
  }

  if (observation.investigationEntries.length > 0) {
    lines.push('', '### Investigation Highlights')
    for (const entry of observation.investigationEntries.slice(0, 6)) {
      const issue = entry.issueNumber != null ? ` #${entry.issueNumber}` : ''
      const repo = entry.repo ? ` [${entry.repo}]` : ''
      lines.push(`- ${entry.outcome}${issue}${repo}`)
    }
  }

  if (observation.workerCheckpoints.length > 0) {
    lines.push('', '### Worker Dispatch Results')
    for (const checkpoint of observation.workerCheckpoints.slice(-6)) {
      lines.push(`- ${compactSingleLine(checkpoint.summary, 160)}`)
    }
  }

  if (observation.transcriptHighlights.length > 0) {
    lines.push('', '### Transcript Findings')
    for (const highlight of observation.transcriptHighlights.slice(0, 6)) {
      lines.push(`- ${highlight}`)
    }
  }

  if (observation.prSignals.length > 0) {
    lines.push('', '### PR Activity Signals')
    for (const signal of observation.prSignals.slice(0, 6)) {
      lines.push(`- ${signal}`)
    }
  }

  if (observation.heartbeatErrors.length > 0 || observation.sessionErrors.length > 0) {
    lines.push('', '### Error Events')
    for (const error of observation.heartbeatErrors.slice(0, 6)) {
      lines.push(`- ${compactSingleLine(error.errorMessage ?? 'Heartbeat error', 160)}`)
    }
    for (const error of observation.sessionErrors.slice(0, 6)) {
      lines.push(`- ${error}`)
    }
  }

  return lines.join('\n')
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null
}

function extractMessageTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return compactSingleLine(content, 160)
  }
  if (!Array.isArray(content)) {
    return ''
  }

  const textBlocks = content
    .map((block) => {
      const obj = asObject(block)
      if (!obj || obj.type !== 'text' || typeof obj.text !== 'string') {
        return ''
      }
      return compactSingleLine(obj.text, 160)
    })
    .filter((block) => block.length > 0)
  return textBlocks.join(' ').trim()
}

function parseEventTimestampMs(event: Record<string, unknown>): number {
  const timestamp = typeof event.timestamp === 'string' ? event.timestamp : null
  const parsed = toTime(timestamp)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function dedupeSignals(signals: string[], maxSignals = MAX_TRANSCRIPT_SIGNALS): string[] {
  return [...new Set(signals)].slice(0, maxSignals)
}

async function readTranscriptActivitySignals(
  commanderDataPath: string,
  commanderId: string,
  sinceMs: number,
): Promise<TranscriptActivitySignals> {
  const sessionsPath = path.join(commanderDataPath, commanderId, 'sessions')
  let transcriptFiles: string[] = []
  try {
    const dirEntries = await readdir(sessionsPath, { withFileTypes: true })
    transcriptFiles = dirEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
      .slice(0, MAX_TRANSCRIPT_FILES)
  } catch {
    return {
      highlights: [],
      prSignals: [],
      sessionErrors: [],
    }
  }

  const highlights: string[] = []
  const prSignals: string[] = []
  const sessionErrors: string[] = []

  for (const fileName of transcriptFiles) {
    const transcriptPath = path.join(sessionsPath, fileName)
    let content = ''
    try {
      content = await readFile(transcriptPath, 'utf8')
    } catch {
      continue
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      let parsedEvent: unknown
      try {
        parsedEvent = JSON.parse(trimmed)
      } catch {
        continue
      }

      const event = asObject(parsedEvent)
      if (!event) {
        continue
      }

      const eventTimestampMs = parseEventTimestampMs(event)
      if (Number.isFinite(eventTimestampMs) && eventTimestampMs < sinceMs) {
        continue
      }

      const eventType = typeof event.type === 'string' ? event.type.toLowerCase() : ''
      const message = asObject(event.message)
      const messageText = message
        ? extractMessageTextContent(message.content)
        : ''
      const summaryText = typeof event.summary === 'string'
        ? compactSingleLine(event.summary, 160)
        : ''
      const fallbackText = typeof event.error === 'string'
        ? compactSingleLine(event.error, 160)
        : ''
      const signalText = messageText || summaryText || fallbackText
      if (!signalText) {
        continue
      }

      if (OBSERVATION_KEYWORDS.test(signalText)) {
        highlights.push(signalText)
      }
      if (PR_SIGNAL_PATTERN.test(signalText)) {
        prSignals.push(signalText)
      }
      if (
        eventType.includes('error') ||
        eventType.includes('failed') ||
        eventType.includes('exception') ||
        TRANSCRIPT_ERROR_PATTERN.test(signalText)
      ) {
        sessionErrors.push(signalText)
      }
    }
  }

  return {
    highlights: dedupeSignals(highlights),
    prSignals: dedupeSignals(prSignals),
    sessionErrors: dedupeSignals(sessionErrors),
  }
}

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
 * - activity-driven observer/reflector journal synthesis
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

  const commanderDataPath = resolvedOptions.basePath
    ? path.resolve(resolvedOptions.basePath)
    : commanderSessionStorePath
      ? path.dirname(path.resolve(commanderSessionStorePath))
      : undefined

  const consolidation = new NightlyConsolidation(resolvedOptions)
  consolidation.register(cronEngine)

  const questStore = commanderDataPath ? new QuestStore(commanderDataPath) : new QuestStore()
  const heartbeatLog = commanderDataPath
    ? new HeartbeatLog({ dataDir: commanderDataPath })
    : new HeartbeatLog()

  const resolveCommanderIdsForCron = async (): Promise<string[]> => {
    const source = resolvedOptions.commanderIdsForCronResolver
      ? await resolvedOptions.commanderIdsForCronResolver()
      : (resolvedOptions.commanderIdsForCron ?? [])

    const deduped = new Set<string>()
    for (const entry of source) {
      const commanderId = entry.trim()
      if (!commanderId) {
        continue
      }
      deduped.add(commanderId)
    }
    return [...deduped]
  }

  const observeAndWriteActivity = async (
    commanderId: string,
    input: {
      outcome: string
      windowMs: number
    },
  ): Promise<void> => {
    const nowIso = new Date().toISOString()
    const sinceMs = Date.now() - input.windowMs
    const sinceIso = new Date(sinceMs).toISOString()
    const journalWriter = new JournalWriter(commanderId, resolvedOptions.basePath)

    const [quests, recentJournalEntries, workingState, heartbeatEntries, transcriptSignals] = await Promise.all([
      questStore.list(commanderId),
      journalWriter.readRecent(),
      new WorkingMemoryStore(commanderId, resolvedOptions.basePath).readState(),
      heartbeatLog.read(commanderId, 50),
      commanderDataPath
        ? readTranscriptActivitySignals(commanderDataPath, commanderId, sinceMs)
        : Promise.resolve({
            highlights: [],
            prSignals: [],
            sessionErrors: [],
          }),
    ])

    const completedQuests = quests.filter((quest) =>
      quest.status === 'done' && occurredSince(quest.completedAt, sinceMs))
    const failedQuests = quests.filter((quest) =>
      quest.status === 'failed' && occurredSince(quest.completedAt, sinceMs))

    const filteredJournalEntries = recentJournalEntries.filter((entry) => {
      if (!occurredSince(entry.timestamp, sinceMs)) {
        return false
      }
      if (isSyntheticOutcome(entry.outcome)) {
        return false
      }
      if (entry.salience !== 'ROUTINE') {
        return true
      }
      return OBSERVATION_KEYWORDS.test(entry.outcome) || OBSERVATION_KEYWORDS.test(entry.body)
    })

    const workerCheckpoints = (workingState.checkpoints ?? []).filter((entry) => {
      if (!occurredSince(entry.timestamp, sinceMs)) {
        return false
      }
      const summary = entry.summary.toLowerCase()
      return entry.tags.includes('subagent') || summary.includes('sub-agent') || summary.includes('worker')
    })

    const heartbeatErrors = heartbeatEntries.filter((entry) =>
      entry.outcome === 'error' && occurredSince(entry.firedAt, sinceMs))

    const prSignalsFromJournal = filteredJournalEntries
      .filter((entry) => PR_SIGNAL_PATTERN.test(entry.outcome) || PR_SIGNAL_PATTERN.test(entry.body))
      .map((entry) => compactSingleLine(`${entry.outcome}${entry.repo ? ` [${entry.repo}]` : ''}`, 120))

    const prSignalsFromArtifacts = [...completedQuests, ...failedQuests]
      .flatMap((quest) => quest.artifacts ?? [])
      .filter((artifact) => artifact.type === 'github_pr')
      .map((artifact) => compactSingleLine(`${artifact.label} (${artifact.href})`, 120))

    const prSignals = dedupeSignals([
      ...prSignalsFromJournal,
      ...prSignalsFromArtifacts,
      ...transcriptSignals.prSignals,
    ])

    const observation: ActivityObservation = {
      completedQuests,
      failedQuests,
      investigationEntries: filteredJournalEntries,
      workerCheckpoints,
      heartbeatErrors,
      sessionErrors: transcriptSignals.sessionErrors,
      transcriptHighlights: transcriptSignals.highlights,
      prSignals,
    }

    if (!hasActivity(observation)) {
      return
    }

    const todayEntries = await journalWriter.readDate(nowIso.slice(0, 10))
    const alreadyWritten = todayEntries.some((entry) =>
      entry.outcome === input.outcome && occurredSince(entry.timestamp, sinceMs))
    if (alreadyWritten) {
      return
    }

    await journalWriter.append({
      timestamp: nowIso,
      issueNumber: null,
      repo: pickObservationRepo(observation),
      outcome: input.outcome,
      durationMin: null,
      salience: deriveObservationSalience(observation),
      body: buildObservationBody(observation, sinceIso),
    })
  }

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
      const commanderIds = await resolveCommanderIdsForCron()
      for (const commanderId of commanderIds) {
        await observeAndWriteActivity(commanderId, {
          outcome: DAILY_OBSERVATIONS_OUTCOME,
          windowMs: DAILY_WINDOW_MS,
        }).catch((err) => {
          console.error(`[commanders] Failed daily observation write for ${commanderId}:`, err)
        })
      }
    },
    { name: 'commander-daily-observations' },
  )

  cronEngine.schedule(
    MICRO_RESET_CRON,
    async () => {
      const commanderIds = await resolveCommanderIdsForCron()
      for (const commanderId of commanderIds) {
        await observeAndWriteActivity(commanderId, {
          outcome: WORK_PULSE_OUTCOME,
          windowMs: WORK_PULSE_WINDOW_MS,
        }).catch((err) => {
          console.error(`[commanders] Failed work pulse reflection write for ${commanderId}:`, err)
        })
      }
    },
    { name: 'commander-work-pulse-reflection' },
  )

  return consolidation
}
