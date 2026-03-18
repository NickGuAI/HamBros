import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { SALIENCE_EMOJI, type JournalEntry, type SalienceLevel } from './types.js'
import { AssociationStore } from './associations.js'
import { WorkingMemoryStore } from './working-memory.js'
import { resolveCommanderPaths } from '../paths.js'

export class JournalWriter {
  private readonly memoryRoot: string
  private readonly skillsRoot: string
  private readonly associations: AssociationStore
  private readonly workingMemory: WorkingMemoryStore

  constructor(commanderId: string, basePath?: string) {
    const resolved = resolveCommanderPaths(commanderId, basePath)
    this.memoryRoot = resolved.memoryRoot
    this.skillsRoot = resolved.skillsRoot
    this.associations = new AssociationStore(commanderId, basePath)
    this.workingMemory = new WorkingMemoryStore(commanderId, basePath)
  }

  /** Ensure the full .memory/ directory scaffold exists. Idempotent. */
  async scaffold(): Promise<void> {
    const dirs = [
      this.memoryRoot,
      path.join(this.memoryRoot, 'journal'),
      this.skillsRoot,
      path.join(this.memoryRoot, 'archive'),
      path.join(this.memoryRoot, 'archive', 'journal'),
    ]
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true })
    }
    // Touch long-term memory surfaces and consolidation log if absent.
    await this._touchIfAbsent(path.join(this.memoryRoot, 'MEMORY.md'), '# Commander Memory\n\n')
    await this._touchIfAbsent(
      path.join(this.memoryRoot, 'LONG_TERM_MEM.md'),
      '# Commander Long-Term Memory\n\n',
    )
    await this._touchIfAbsent(
      path.join(this.memoryRoot, 'consolidation-log.md'),
      '# Consolidation Log\n\n',
    )
    await Promise.all([
      this.workingMemory.ensure(),
      this.associations.ensure(),
    ])
  }

  /** Absolute path to this commander's `.memory` directory. */
  get memoryRootPath(): string {
    return this.memoryRoot
  }

  /** Append an entry to today's journal file. */
  async append(entry: JournalEntry): Promise<void> {
    const journalPath = this._journalPath(this._todayDateString())
    await mkdir(path.dirname(journalPath), { recursive: true })
    const formatted = this._formatEntry(entry)
    let existing = ''
    try {
      existing = await readFile(journalPath, 'utf-8')
    } catch {
      // File doesn't exist yet — start fresh
    }
    await writeFile(journalPath, existing + formatted, 'utf-8')
    try {
      await this.associations.upsertJournalEntry(entry)
    } catch {
      // Journal durability should not fail due to association index maintenance.
    }
  }

  /**
   * Append a batch of entries to a specific date file, deduplicating by
   * timestamp + content hash.
   */
  async appendBatch(
    date: string,
    entries: JournalEntry[],
  ): Promise<{ appended: number; skipped: number }> {
    const journalPath = this._journalPath(date)
    await mkdir(path.dirname(journalPath), { recursive: true })

    let existing = ''
    try {
      existing = await readFile(journalPath, 'utf-8')
    } catch {
      // File may not exist yet.
    }

    const existingEntries = this._parseEntries(existing, date)
    const dedupeKeys = new Set(existingEntries.map((entry) => this._dedupeKey(entry)))
    const newEntries: JournalEntry[] = []
    let skipped = 0

    for (const entry of entries) {
      const dedupeKey = this._dedupeKey(entry)
      if (dedupeKeys.has(dedupeKey)) {
        skipped += 1
        continue
      }

      dedupeKeys.add(dedupeKey)
      newEntries.push(entry)
    }

    if (newEntries.length > 0) {
      const formatted = newEntries.map((entry) => this._formatEntry(entry)).join('')
      await writeFile(journalPath, existing + formatted, 'utf-8')
      for (const entry of newEntries) {
        try {
          await this.associations.upsertJournalEntry(entry)
        } catch {
          // Journal durability should not fail due to association index maintenance.
        }
      }
    }

    return {
      appended: newEntries.length,
      skipped,
    }
  }

  /** Return entries from today and yesterday. */
  async readRecent(): Promise<JournalEntry[]> {
    const today = this._todayDateString()
    const yesterday = this._yesterdayDateString()
    const [todayEntries, yesterdayEntries] = await Promise.all([
      this.readDate(today),
      this.readDate(yesterday),
    ])
    return [...yesterdayEntries, ...todayEntries]
  }

  /** Return all parsed entries for the given YYYY-MM-DD date string. */
  async readDate(date: string): Promise<JournalEntry[]> {
    const journalPath = this._journalPath(date)
    let content: string
    try {
      content = await readFile(journalPath, 'utf-8')
    } catch {
      return []
    }
    return this._parseEntries(content, date)
  }

  /** Parse journal markdown content into entries for a given date key. */
  parseMarkdown(content: string, date: string): JournalEntry[] {
    return this._parseEntries(content, date)
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _journalPath(date: string): string {
    return path.join(this.memoryRoot, 'journal', `${date}.md`)
  }

  private _todayDateString(): string {
    return new Date().toISOString().slice(0, 10)
  }

  private _yesterdayDateString(): string {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10)
  }

  private async _touchIfAbsent(filePath: string, defaultContent: string): Promise<void> {
    try {
      await readFile(filePath, 'utf-8')
    } catch {
      await writeFile(filePath, defaultContent, 'utf-8')
    }
  }

  private _formatEntry(entry: JournalEntry): string {
    const emoji = SALIENCE_EMOJI[entry.salience]
    const timeStr = new Date(entry.timestamp).toISOString().slice(11, 16) // HH:MM
    const issueStr = entry.issueNumber != null ? ` (#${entry.issueNumber})` : ''
    const isCompact =
      entry.salience === 'ROUTINE' && (!entry.body || entry.body.trim() === '')

    if (isCompact) {
      const parts = [`**Repo:** ${entry.repo ?? 'unknown'}`]
      if (entry.durationMin != null) parts.push(`${entry.durationMin} min`)
      return (
        `## ${timeStr} — ${entry.outcome}${issueStr} ${emoji} ${entry.salience}\n\n` +
        `${parts.join(' | ')}\n\n---\n\n`
      )
    }

    const lines: string[] = [
      `## ${timeStr} — ${entry.outcome}${issueStr} ${emoji} ${entry.salience}`,
      '',
    ]
    if (entry.repo) lines.push(`**Repo:** ${entry.repo}`)
    lines.push(`**Outcome:** ${entry.outcome}`)
    if (entry.durationMin != null) lines.push(`**Duration:** ${entry.durationMin} min`)
    if (entry.body && entry.body.trim()) {
      lines.push('')
      lines.push(entry.body.trim())
    }
    lines.push('', '---', '')
    return lines.join('\n') + '\n'
  }

  private _contentHash(entry: JournalEntry): string {
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()
    const normalized = JSON.stringify({
      issueNumber: entry.issueNumber,
      repo: entry.repo ? normalize(entry.repo) : null,
      outcome: normalize(entry.outcome),
      durationMin: entry.durationMin,
      salience: entry.salience,
      body: normalize(entry.body),
    })
    return createHash('sha256').update(normalized).digest('hex')
  }

  private _dedupeKey(entry: JournalEntry): string {
    return `${entry.timestamp}|${this._contentHash(entry)}`
  }

  /**
   * Parse journal entries from raw markdown content.
   * Returns a best-effort array — unparseable blocks are skipped.
   */
  private _parseEntries(content: string, date: string): JournalEntry[] {
    const entries: JournalEntry[] = []
    // Split on the "---" separator between entries
    const blocks = content.split(/\n---\n/)
    for (const block of blocks) {
      const trimmed = block.trim()
      if (!trimmed) continue
      // Match heading: ## HH:MM — outcome text [(#N)] EMOJI SALIENCE
      // The issue number is written as "(#N)" with parentheses, optionally present.
      const headingMatch = trimmed.match(
        /^## (\d{2}:\d{2}) — (.+?)(?:\s+\(#(\d+)\))? [🔴🟡⚪] (SPIKE|NOTABLE|ROUTINE)/mu,
      )
      if (!headingMatch) continue
      const [, timeStr, outcomeRaw, issueStr, salience] = headingMatch
      const timestamp = `${date}T${timeStr}:00.000Z`
      const issueNumber = issueStr ? parseInt(issueStr, 10) : null
      // Extract repo from **Repo:** line (stop at newline or pipe)
      const repoMatch = trimmed.match(/\*\*Repo:\*\* ([^\n|]+)/)
      const repo = repoMatch ? repoMatch[1].trim() : null
      // Extract duration from explicit **Duration:** line only (not compact pipe format)
      const durationMatch = trimmed.match(/\*\*Duration:\*\* (\d+) min/)
      const durationMin = durationMatch ? parseInt(durationMatch[1], 10) : null
      // Body = non-empty lines after heading that aren't metadata lines
      const metaPattern = /^\*\*(Repo|Outcome|Duration):\*\*/
      const bodyLines = trimmed
        .split('\n')
        .slice(1) // skip heading
        .filter((line) => line.trim().length > 0 && !metaPattern.test(line.trim()))
      const body = bodyLines.join('\n').trim()

      entries.push({
        timestamp,
        issueNumber,
        repo,
        outcome: outcomeRaw.trim(),
        durationMin,
        salience: salience as SalienceLevel,
        body,
      })
    }
    return entries
  }
}
