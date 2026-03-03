import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JournalWriter } from '../journal.js'
import { NightlyConsolidation } from '../consolidation.js'
import type { JournalEntry } from '../types.js'

function block(args: {
  time: string
  outcome: string
  issue?: number
  salience: 'SPIKE' | 'NOTABLE' | 'ROUTINE'
  body?: string
  repo?: string
  duration?: number
}): string {
  const emoji = args.salience === 'SPIKE' ? '🔴' : args.salience === 'NOTABLE' ? '🟡' : '⚪'
  return (
    `## ${args.time} — ${args.outcome}${args.issue != null ? ` (#${args.issue})` : ''} ${emoji} ${args.salience}\n\n` +
    `**Repo:** ${args.repo ?? 'example-user/example-repo'}\n` +
    `**Outcome:** ${args.outcome}\n` +
    `${args.duration != null ? `**Duration:** ${args.duration} min\n` : ''}\n` +
    `${args.body ?? ''}\n\n---\n\n`
  )
}

describe('NightlyConsolidation.run()', () => {
  let tmpDir: string
  let debriefDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nightly-consolidation-test-'))
    debriefDir = join(tmpDir, 'debriefs')
    await writeFile(join(tmpDir, '.keep'), '', 'utf-8')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('updates MEMORY.md, compresses journals, archives originals, and writes report', async () => {
    const now = () => new Date('2026-03-01T02:00:00.000Z')
    const writer = new JournalWriter('cmdr-1', tmpDir)
    await writer.scaffold()
    const memoryRoot = join(tmpDir, 'cmdr-1', '.memory')
    const journalDir = join(memoryRoot, 'journal')

    await writeFile(
      join(journalDir, '2026-03-01.md'),
      block({
        time: '09:00',
        outcome: 'Fix consolidation bug',
        issue: 167,
        salience: 'SPIKE',
        body: 'Parser must read doctrine updates from hotwash sections.',
        duration: 20,
      }),
      'utf-8',
    )

    await writeFile(
      join(journalDir, '2026-02-20.md'),
      [
        block({
          time: '10:00',
          outcome: 'Document new flow',
          issue: 168,
          salience: 'NOTABLE',
          body: 'Documented the new nightly runner behavior.',
          duration: 25,
        }),
        block({
          time: '11:00',
          outcome: 'Routine cleanup',
          issue: 169,
          salience: 'ROUTINE',
          body: 'Minor chores.',
          duration: 8,
        }),
      ].join(''),
      'utf-8',
    )

    await writeFile(
      join(journalDir, '2025-11-20.md'),
      [
        block({
          time: '12:00',
          outcome: 'Historic spike',
          issue: 120,
          salience: 'SPIKE',
          body: 'Deep investigation that should be summarized.',
          duration: 60,
        }),
        block({
          time: '13:00',
          outcome: 'Old routine',
          issue: 121,
          salience: 'ROUTINE',
          body: 'Should be removed after 90 days.',
          duration: 5,
        }),
      ].join(''),
      'utf-8',
    )

    await rm(debriefDir, { recursive: true, force: true })
    await mkdir(debriefDir, { recursive: true })
    await writeFile(
      join(debriefDir, '2026-03-01-session.md'),
      `# HOTWASH: Commander Memory
## DOCTRINE UPDATES
- Keep memory entries short and actionable.
## IMPROVE
- Root cause: No eviction rule for stale entries.
`,
      'utf-8',
    )

    const skillDistiller = { run: vi.fn() }
    skillDistiller.run.mockResolvedValue(undefined)
    const repoCache = { updateFromConsolidation: vi.fn() }
    repoCache.updateFromConsolidation.mockResolvedValue(undefined)
    const issueClient = {
      fetchClosedIssuesForDate: vi.fn(),
      postConsolidationComment: vi.fn(),
    }
    issueClient.fetchClosedIssuesForDate.mockResolvedValue(['#167', '#168'])
    issueClient.postConsolidationComment.mockResolvedValue(undefined)

    const consolidation = new NightlyConsolidation({
      basePath: tmpDir,
      debriefDir,
      now,
      skillDistiller,
      repoCache,
      issueClient,
    })

    const report = await consolidation.run('cmdr-1')

    expect(report.factsExtracted).toBeGreaterThan(0)
    expect(report.debrifsProcessed).toBe(1)
    expect(report.entriesCompressed.routine).toBeGreaterThan(0)

    const memory = await readFile(join(memoryRoot, 'MEMORY.md'), 'utf-8')
    expect(memory).toContain('Doctrine: Keep memory entries short and actionable.')
    expect(memory).toContain('Avoid: No eviction rule for stale entries.')
    expect(memory).toContain('SPIKE: Fix consolidation bug')

    const compressedRecent = await readFile(join(journalDir, '2026-02-20.md'), 'utf-8')
    expect(compressedRecent).toContain('🟡 NOTABLE')
    expect(compressedRecent).not.toContain('Routine cleanup')

    const compressedOld = await readFile(join(journalDir, '2025-11-20.md'), 'utf-8')
    expect(compressedOld).toContain('Historical summary:')
    expect(compressedOld).not.toContain('Old routine')

    await expect(stat(join(memoryRoot, 'archive', 'journal', '2026-02-20.md'))).resolves.toBeTruthy()
    await expect(stat(join(memoryRoot, 'archive', 'journal', '2025-11-20.md'))).resolves.toBeTruthy()

    const weekly = await readFile(join(journalDir, 'weekly-summary-2026-02-16.md'), 'utf-8')
    expect(weekly).toContain('merged 1 routine entries')

    const log = await readFile(join(memoryRoot, 'consolidation-log.md'), 'utf-8')
    expect(log).toContain('## 2026-03-01')

    expect(skillDistiller.run).toHaveBeenCalledTimes(1)
    expect(repoCache.updateFromConsolidation).toHaveBeenCalledTimes(1)
    expect(issueClient.postConsolidationComment).toHaveBeenCalledTimes(1)
  })

  it('registers with cron at 02:00 and runs configured commanders', async () => {
    const consolidation = new NightlyConsolidation({
      commanderIdsForCron: ['cmdr-a', 'cmdr-b'],
      basePath: tmpDir,
    })
    const runSpy = vi.spyOn(consolidation, 'run').mockResolvedValue({
      factsExtracted: 0,
      memoryMdLineCount: 0,
      entriesCompressed: { spike: 0, notable: 0, routine: 0 },
      entriesDeleted: 0,
      debrifsProcessed: 0,
    })
    let job: (() => Promise<void> | void) | null = null
    const cron = {
      schedule: vi.fn((expr: string, task: () => Promise<void> | void) => {
        expect(expr).toBe('0 2 * * *')
        job = task
      }),
    }
    consolidation.register(cron)
    expect(cron.schedule).toHaveBeenCalledTimes(1)
    if (!job) throw new Error('cron job was not registered')
    await job()
    expect(runSpy).toHaveBeenNthCalledWith(1, 'cmdr-a')
    expect(runSpy).toHaveBeenNthCalledWith(2, 'cmdr-b')
  })

  it('re-compresses from archived originals when entries age across policy thresholds', async () => {
    let nowValue = new Date('2026-01-29T02:00:00.000Z')
    const now = () => nowValue

    const writer = new JournalWriter('cmdr-archive', tmpDir)
    await writer.scaffold()
    const memoryRoot = join(tmpDir, 'cmdr-archive', '.memory')
    const journalDir = join(memoryRoot, 'journal')

    await writeFile(
      join(journalDir, '2026-01-20.md'),
      block({
        time: '08:00',
        outcome: 'Investigate retries',
        issue: 170,
        salience: 'NOTABLE',
        body: 'Original diagnostic details from the incident.',
        duration: 30,
      }),
      'utf-8',
    )

    const consolidation = new NightlyConsolidation({
      basePath: tmpDir,
      debriefDir,
      now,
    })

    await consolidation.run('cmdr-archive')
    const sevenDayCompression = await readFile(join(journalDir, '2026-01-20.md'), 'utf-8')
    expect(sevenDayCompression).toContain('- Repo:')

    nowValue = new Date('2026-02-25T02:00:00.000Z')
    await consolidation.run('cmdr-archive')

    const thirtyDayCompression = await readFile(join(journalDir, '2026-01-20.md'), 'utf-8')
    expect(thirtyDayCompression).not.toContain('- Repo:')
    expect(thirtyDayCompression).toContain('- Original diagnostic details from the incident.')
    expect(thirtyDayCompression).not.toContain('- - Original diagnostic details')
  })
})
