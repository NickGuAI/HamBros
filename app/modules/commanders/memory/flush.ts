import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { JournalWriter } from './journal.js'
import type { JournalEntry, SalienceLevel } from './types.js'

export interface FlushContext {
  currentIssue: {
    number: number
    repo: string
    url: string
    title: string
  } | null
  taskState: string
  pendingSpikeObservations: string[]
  trigger: 'pre-compaction' | 'between-task'
}

export interface GitHubClient {
  postIssueComment(input: { repo: string; issueNumber: number; body: string }): Promise<void>
}

export interface RemoteMemorySyncClient {
  appendJournal(input: { date: string; entries: JournalEntry[] }): Promise<void>
  syncMemory(input: { memoryMd: string }): Promise<void>
}

interface EmergencyFlusherOptions {
  now?: () => Date
  remoteMemoryClient?: RemoteMemorySyncClient
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function cleanObservations(values: string[]): string[] {
  return values.map(normalizeText).filter((value) => value.length > 0)
}

export class EmergencyFlusher {
  private readonly now: () => Date
  private readonly remoteMemoryClient?: RemoteMemorySyncClient

  constructor(
    private readonly commanderId: string,
    private readonly journal: JournalWriter,
    private readonly ghClient: GitHubClient,
    options: EmergencyFlusherOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.remoteMemoryClient = options.remoteMemoryClient
  }

  async preCompactionFlush(ctx: FlushContext): Promise<void> {
    await this.flush({
      ...ctx,
      trigger: 'pre-compaction',
    })
  }

  async betweenTaskFlush(ctx: FlushContext): Promise<void> {
    await this.flush({
      ...ctx,
      trigger: 'between-task',
    })
  }

  private async flush(ctx: FlushContext): Promise<void> {
    await Promise.all([
      this.appendCurrentStateToJournal(ctx),
      this.postProgressToGitHub(ctx),
      this.appendSpikesToMemoryMd(ctx),
    ])
  }

  private async appendCurrentStateToJournal(ctx: FlushContext): Promise<void> {
    const nowIso = this.now().toISOString()
    const entry = this.buildJournalEntry(ctx, nowIso)

    if (this.remoteMemoryClient) {
      await this.remoteMemoryClient.appendJournal({
        date: nowIso.slice(0, 10),
        entries: [entry],
      })
      return
    }

    await this.journal.append(entry)
  }

  private async postProgressToGitHub(ctx: FlushContext): Promise<void> {
    if (!ctx.currentIssue) return

    const spikes = cleanObservations(ctx.pendingSpikeObservations)
    const lines: string[] = [
      `Emergency flush (\`${ctx.trigger}\`) for commander \`${this.commanderId}\`.`,
      '',
      `- Issue: #${ctx.currentIssue.number}`,
      `- Repo: ${ctx.currentIssue.repo}`,
      '',
      '### Current State',
      normalizeText(ctx.taskState) || '_No task state provided._',
    ]
    if (spikes.length > 0) {
      lines.push('', '### SPIKE Observations', ...spikes.map((item) => `- ${item}`))
    }

    await this.ghClient.postIssueComment({
      repo: ctx.currentIssue.repo,
      issueNumber: ctx.currentIssue.number,
      body: lines.join('\n'),
    })
  }

  private async appendSpikesToMemoryMd(ctx: FlushContext): Promise<void> {
    const spikes = cleanObservations(ctx.pendingSpikeObservations)
    if (spikes.length === 0) return

    const nowIso = this.now().toISOString()
    const day = nowIso.slice(0, 10)
    const issueSuffix = ctx.currentIssue ? `Issue #${ctx.currentIssue.number}` : 'No linked issue'
    const repoName = ctx.currentIssue?.repo ?? 'unknown'

    const additions = [
      `<!-- Emergency flush: ${nowIso} -->`,
      `## Discoveries (${day})`,
      '',
      ...spikes.map(
        (item) =>
          `- **[${repoName}]** ${item} (${issueSuffix}, SPIKE — ${ctx.trigger})`,
      ),
      '',
    ].join('\n')

    const memoryPath = path.join(this.journal.memoryRootPath, 'MEMORY.md')
    let existing = '# Commander Memory\n\n'
    try {
      existing = await readFile(memoryPath, 'utf-8')
    } catch {
      // Keep default header if missing.
    }

    const nextMemory = `${existing.trimEnd()}\n\n${additions}\n`
    if (this.remoteMemoryClient) {
      await this.remoteMemoryClient.syncMemory({ memoryMd: nextMemory })
      return
    }

    await writeFile(memoryPath, nextMemory, 'utf-8')
  }

  private buildJournalEntry(ctx: FlushContext, nowIso: string): JournalEntry {
    const spikes = cleanObservations(ctx.pendingSpikeObservations)
    const salience: SalienceLevel = spikes.length > 0 ? 'SPIKE' : 'ROUTINE'

    const bodyLines: string[] = [
      `- Trigger: \`${ctx.trigger}\``,
      `- Commander: \`${this.commanderId}\``,
      '',
      '### Task State',
      normalizeText(ctx.taskState) || '_No task state provided._',
    ]
    if (spikes.length > 0) {
      bodyLines.push('', '### SPIKE Observations', ...spikes.map((item) => `- ${item}`))
    }

    return {
      timestamp: nowIso,
      issueNumber: ctx.currentIssue?.number ?? null,
      repo: ctx.currentIssue?.repo ?? null,
      outcome:
        ctx.trigger === 'pre-compaction'
          ? 'Emergency flush before context compaction'
          : 'Emergency flush between tasks',
      durationMin: null,
      salience,
      body: bodyLines.join('\n'),
    }
  }
}
