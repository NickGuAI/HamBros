import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DebriefParser, type ParsedDebrief } from './debrief-parser.js'
import { JournalCompressor } from './compressor.js'
import { JournalWriter } from './journal.js'
import { MemoryMdWriter } from './memory-md-writer.js'
import { WorkingMemory } from './working-memory.js'
import type { JournalEntry } from './types.js'

const HIGH_ACTIVITY_ENTRY_THRESHOLD = 20
const HIGH_ACTIVITY_SPIKE_THRESHOLD = 4
const MAX_LONG_TERM_JOURNAL_ENTRIES = 6
const MAX_LONG_TERM_WORKING_NOTES = 8

export interface CronEngine {
  schedule(expression: string, task: () => Promise<void> | void, options?: { name?: string }): void
}

export interface ConsolidationReport {
  factsExtracted: number
  memoryMdLineCount: number
  entriesCompressed: { spike: number; notable: number; routine: number }
  entriesDeleted: number
  debrifsProcessed: number
  idleDay?: boolean
  incrementalRefreshTriggered?: boolean
}

export interface ConsolidationIssueClient {
  fetchClosedIssuesForDate?(commanderId: string, date: string): Promise<string[]>
  postConsolidationComment?(commanderId: string, commentBody: string): Promise<void>
}

export interface SkillDistillerLike {
  run(input: { journalEntries: JournalEntry[]; parsedDebriefs: ParsedDebrief[] }): Promise<void>
}

export interface NightlyConsolidationOptions {
  basePath?: string
  commanderIdsForCron?: string[]
  commanderIdsForCronResolver?: () => string[] | Promise<string[]>
  debriefDir?: string
  now?: () => Date
  issueClient?: ConsolidationIssueClient
  skillDistiller?: SkillDistillerLike
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function daysBetween(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00.000Z`).getTime()
  const to = new Date(`${toDate}T00:00:00.000Z`).getTime()
  return Math.floor((to - from) / (24 * 60 * 60 * 1000))
}

function weekOf(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`)
  const day = date.getUTCDay()
  const offset = day === 0 ? -6 : 1 - day // Monday
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function summarizeSpike(entry: JournalEntry): string {
  const detail = (entry.body || entry.outcome).replace(/\s+/g, ' ').trim()
  return `SPIKE: ${entry.outcome}${detail ? ` — ${detail.slice(0, 160)}` : ''}`
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function cleanSentence(value: string, maxLen: number): string {
  const compacted = compactText(value).slice(0, maxLen)
  if (!compacted) return ''
  return /[.!?]$/.test(compacted) ? compacted : `${compacted}.`
}

function buildJournalNarrative(entries: JournalEntry[]): string {
  const selected = entries.slice(-MAX_LONG_TERM_JOURNAL_ENTRIES)
  if (selected.length === 0) return ''
  const sentences = selected
    .map((entry) => {
      const time = entry.timestamp.slice(11, 16)
      const repo = entry.repo ? ` in ${entry.repo}` : ''
      const issue = entry.issueNumber != null ? ` (issue #${entry.issueNumber})` : ''
      const detail = entry.body.trim()
      const detailPart = detail
        ? ` ${cleanSentence(detail, 200)}`
        : ''
      return cleanSentence(`${time}${repo}: ${entry.outcome}${issue}${detailPart}`, 280)
    })
    .filter((sentence) => sentence.length > 0)

  if (sentences.length === 0) return ''
  return sentences.join(' ')
}

function buildWorkingMemoryNarrative(workingMemory: string): string {
  const lines = workingMemory.split(/\r?\n/)
  const hypothesisLine = lines
    .find((line) => line.startsWith('Active hypothesis:'))
    ?.replace('Active hypothesis:', '')
    .trim()
  const hypothesis = hypothesisLine && hypothesisLine !== '_none_'
    ? cleanSentence(`Active hypothesis was ${hypothesisLine}`, 220)
    : ''

  const checkpoints = lines
    .map((line) => line.trim())
    .map((line) => line.match(/^- [0-9T:.\-Z]+ \([^)]+\)(?: #[0-9]+)?(?: \[[^\]]+\])?(?: \{[^}]+\})? (.+)$/))
    .filter((match): match is RegExpMatchArray => match != null)
    .map((match) => compactText(match[1]))
    .filter((note) => note.length > 0)
    .slice(-MAX_LONG_TERM_WORKING_NOTES)

  const observations = checkpoints.length > 0
    ? cleanSentence(`Scratchpad observations: ${checkpoints.join('; ')}`, 420)
    : ''

  return [hypothesis, observations].filter((segment) => segment.length > 0).join(' ')
}

function buildCommentBody(
  commanderId: string,
  today: string,
  report: ConsolidationReport,
  closedIssues: string[],
): string {
  const lines = [
    `Nightly consolidation completed for \`${commanderId}\` on ${today}.`,
    '',
    `- facts extracted: ${report.factsExtracted}`,
    `- MEMORY.md lines: ${report.memoryMdLineCount}`,
    `- compressed: spike=${report.entriesCompressed.spike}, notable=${report.entriesCompressed.notable}, routine=${report.entriesCompressed.routine}`,
    `- deleted entries: ${report.entriesDeleted}`,
    `- debriefs processed: ${report.debrifsProcessed}`,
  ]
  if (closedIssues.length > 0) {
    lines.push(`- closed issues reviewed: ${closedIssues.length}`)
  }
  lines.push(`- idle day: ${(report.idleDay ?? false) ? 'yes' : 'no'}`)
  lines.push(`- incremental refresh: ${(report.incrementalRefreshTriggered ?? false) ? 'triggered' : 'not triggered'}`)
  return lines.join('\n')
}

export class NightlyConsolidation {
  private readonly parser: DebriefParser
  private readonly compressor: JournalCompressor
  private readonly now: () => Date
  private readonly commanderIdsForCron: string[]
  private readonly debriefDir: string

  constructor(private readonly options: NightlyConsolidationOptions = {}) {
    this.parser = new DebriefParser()
    this.compressor = new JournalCompressor()
    this.now = options.now ?? (() => new Date())
    this.commanderIdsForCron = options.commanderIdsForCron ?? []
    this.debriefDir = options.debriefDir ?? path.join(os.homedir(), '.ai-debrief')
  }

  // Register the 2 AM cron job with Commander's cron engine
  register(cronEngine: CronEngine): void {
    cronEngine.schedule(
      '0 2 * * *',
      async () => {
        const commanderIds = await this.resolveCommanderIdsForCron()
        for (const commanderId of commanderIds) {
          await this.run(commanderId)
        }
      },
      { name: 'commander-nightly-consolidation' },
    )
  }

  private async resolveCommanderIdsForCron(): Promise<string[]> {
    const source = this.options.commanderIdsForCronResolver
      ? await this.options.commanderIdsForCronResolver()
      : this.commanderIdsForCron

    const deduped = new Set<string>()
    for (const entry of source) {
      const commanderId = entry.trim()
      if (commanderId.length === 0) {
        continue
      }
      deduped.add(commanderId)
    }
    return [...deduped]
  }

  // Run consolidation for a given commander (callable manually for testing)
  async run(commanderId: string): Promise<ConsolidationReport> {
    const today = dateKey(this.now())
    const writer = new JournalWriter(commanderId, this.options.basePath)
    await writer.scaffold()
    const memoryRoot = writer.memoryRootPath
    const journalDir = path.join(memoryRoot, 'journal')
    const archiveJournalDir = path.join(memoryRoot, 'archive', 'journal')
    await mkdir(archiveJournalDir, { recursive: true })

    // Phase 1: Gather inputs
    const [todayEntries, debriefs, closedIssues] = await Promise.all([
      writer.readDate(today),
      this.parser.parseForDate(today, this.debriefDir),
      this.options.issueClient?.fetchClosedIssuesForDate?.(commanderId, today) ?? Promise.resolve([]),
    ])
    const idleDay = todayEntries.length === 0 && debriefs.length === 0
    const spikeCount = todayEntries.filter((entry) => entry.salience === 'SPIKE').length
    const incrementalRefreshTriggered =
      todayEntries.length >= HIGH_ACTIVITY_ENTRY_THRESHOLD || spikeCount >= HIGH_ACTIVITY_SPIKE_THRESHOLD

    // Phase 2: Extract durable facts -> MEMORY.md
    const factCandidates: string[] = []
    for (const debrief of debriefs) {
      for (const item of debrief.doctrineUpdates) {
        factCandidates.push(`Doctrine: ${item}`)
      }
      for (const cause of debrief.improveRootCauses) {
        factCandidates.push(`Avoid: ${cause}`)
      }
    }
    for (const entry of todayEntries) {
      if (entry.salience !== 'SPIKE') continue
      factCandidates.push(summarizeSpike(entry))
    }

    const memoryWriter = new MemoryMdWriter(memoryRoot, { now: this.now })
    const memoryResult = await memoryWriter.updateFacts(factCandidates)
    await this.distillLongTermMemory(commanderId, memoryRoot, today, todayEntries)

    // Phase 3: Compress episodic traces
    const files = await readdir(journalDir)
    const dailyJournalFiles = files
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
    const weeklyRoutineBuckets = new Map<string, JournalEntry[]>()
    const entriesCompressed = { spike: 0, notable: 0, routine: 0 }
    let entriesDeleted = 0

    for (const fileName of dailyJournalFiles) {
      const date = fileName.replace(/\.md$/, '')
      const ageInDays = daysBetween(date, today)
      if (ageInDays <= 7) continue

      const filePath = path.join(journalDir, fileName)
      const archivePath = path.join(archiveJournalDir, fileName)
      let sourceContent = ''
      try {
        // Re-compress from archived originals to avoid cumulative summary drift.
        sourceContent = await readFile(archivePath, 'utf-8')
      } catch {
        sourceContent = await readFile(filePath, 'utf-8')
        await writeFile(archivePath, sourceContent, 'utf-8')
      }

      const entries = writer.parseMarkdown(sourceContent, date)
      const kept: string[] = []
      for (const entry of entries) {
        if (entry.salience === 'ROUTINE' && ageInDays > 7 && ageInDays <= 30) {
          const key = weekOf(date)
          const bucket = weeklyRoutineBuckets.get(key) ?? []
          bucket.push(entry)
          weeklyRoutineBuckets.set(key, bucket)
          entriesCompressed.routine += 1
          continue
        }
        const compressed = await this.compressor.compress(entry, ageInDays)
        if (compressed == null) {
          entriesDeleted += 1
          continue
        }
        if (entry.salience === 'SPIKE' && ageInDays > 90) entriesCompressed.spike += 1
        if (entry.salience === 'NOTABLE' && ageInDays > 7) entriesCompressed.notable += 1
        kept.push(compressed)
      }

      if (kept.length === 0) {
        await rm(filePath, { force: true })
      } else {
        await writeFile(filePath, kept.join(''), 'utf-8')
      }
    }

    for (const [week, routineEntries] of weeklyRoutineBuckets.entries()) {
      const summary = await this.compressor.buildWeeklySummary(routineEntries, week)
      const weeklyPath = path.join(journalDir, `weekly-summary-${week}.md`)
      let existing = ''
      try {
        existing = await readFile(weeklyPath, 'utf-8')
      } catch {
        existing = ''
      }
      if (!existing.includes(summary)) {
        await writeFile(weeklyPath, `${existing.trimEnd()}\n${summary}\n`, 'utf-8')
      }
    }

    // Phase 4: Downstream hooks (interfaces only).
    if (this.options.skillDistiller && !idleDay) {
      const distillerJournalEntries = incrementalRefreshTriggered
        ? await this.readJournalWindow(writer, today, 1, todayEntries)
        : todayEntries
      await this.options.skillDistiller.run({
        journalEntries: distillerJournalEntries,
        parsedDebriefs: debriefs,
      })
    }

    // Phase 5: report + log.
    const report: ConsolidationReport = {
      factsExtracted: memoryResult.factsAdded,
      memoryMdLineCount: memoryResult.lineCount,
      entriesCompressed,
      entriesDeleted,
      debrifsProcessed: debriefs.length,
      idleDay,
      incrementalRefreshTriggered,
    }
    const commentBody = buildCommentBody(commanderId, today, report, closedIssues)
    const logPath = path.join(memoryRoot, 'consolidation-log.md')
    let log = '# Consolidation Log\n\n'
    try {
      log = await readFile(logPath, 'utf-8')
    } catch {
      // Keep default header.
    }
    const logBlock = [`## ${today}`, '', commentBody, ''].join('\n')
    await writeFile(logPath, `${log.trimEnd()}\n\n${logBlock}`, 'utf-8')
    await this.options.issueClient?.postConsolidationComment?.(commanderId, commentBody)

    return report
  }

  private async readJournalWindow(
    writer: JournalWriter,
    endDate: string,
    lookbackDays: number,
    todayEntries: JournalEntry[],
  ): Promise<JournalEntry[]> {
    const entries: JournalEntry[] = [...todayEntries]
    for (let offset = 1; offset <= lookbackDays; offset++) {
      const day = new Date(`${endDate}T00:00:00.000Z`)
      day.setUTCDate(day.getUTCDate() - offset)
      const date = day.toISOString().slice(0, 10)
      const dayEntries = await writer.readDate(date)
      entries.unshift(...dayEntries)
    }
    return entries
  }

  private async distillLongTermMemory(
    commanderId: string,
    memoryRoot: string,
    today: string,
    todayEntries: JournalEntry[],
  ): Promise<void> {
    const workingMemory = new WorkingMemory(commanderId, this.options.basePath, { now: this.now })
    const workingMemoryContent = await workingMemory.read()
    const journalNarrative = buildJournalNarrative(todayEntries)
    const workingNarrative = buildWorkingMemoryNarrative(workingMemoryContent)

    if (!journalNarrative && !workingNarrative) {
      return
    }

    const sectionLines = [`## ${today}`, '']
    if (journalNarrative) {
      sectionLines.push('### Journal Narrative', journalNarrative, '')
    }
    if (workingNarrative) {
      sectionLines.push('### Working Memory Narrative', workingNarrative, '')
    }

    const longTermPath = path.join(memoryRoot, 'LONG_TERM_MEM.md')
    await this.appendLongTermSection(longTermPath, today, sectionLines.join('\n').trim())
    await workingMemory.clear()
  }

  private async appendLongTermSection(
    longTermPath: string,
    date: string,
    section: string,
  ): Promise<void> {
    let existing = '# Commander Long-Term Memory\n\n'
    try {
      existing = await readFile(longTermPath, 'utf-8')
    } catch {
      // Keep default header.
    }

    if (new RegExp(`^## ${date}$`, 'm').test(existing)) {
      return
    }

    await writeFile(longTermPath, `${existing.trimEnd()}\n\n${section}\n`, 'utf-8')
  }
}
