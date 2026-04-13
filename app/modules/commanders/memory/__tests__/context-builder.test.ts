import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JournalWriter } from '../journal.js'
import { GoalsStore } from '../goals-store.js'
import { MemoryContextBuilder, type Message } from '../context-builder.js'
import type { GHIssue } from '../skill-matcher.js'
import { WorkingMemoryStore } from '../working-memory.js'

vi.setConfig({ testTimeout: 60_000 })

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function makeEntryMarkdown(input: {
  time: string
  salience: 'SPIKE' | 'NOTABLE' | 'ROUTINE'
  outcome: string
  issueNumber?: number
  repo: string
  durationMin?: number
  body?: string
}): string {
  const emoji = input.salience === 'SPIKE'
    ? '🔴'
    : input.salience === 'NOTABLE'
      ? '🟡'
      : '⚪'
  const issue = input.issueNumber != null ? ` (#${input.issueNumber})` : ''
  const body = input.body?.trim() ?? ''
  const durationLine = input.durationMin != null ? `**Duration:** ${input.durationMin} min\n` : ''

  return (
    `## ${input.time} — ${input.outcome}${issue} ${emoji} ${input.salience}\n\n` +
    `**Repo:** ${input.repo}\n` +
    `**Outcome:** ${input.outcome}\n` +
    durationLine +
    (body ? `\n${body}\n` : '\n') +
    `\n---\n\n`
  )
}

describe('MemoryContextBuilder.build()', () => {
  let tmpDir: string
  let commanderId: string
  let memoryRoot: string
  let commanderRoot: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'context-builder-test-'))
    commanderId = 'test-commander'
    commanderRoot = join(tmpDir, commanderId)
    memoryRoot = join(tmpDir, commanderId, '.memory')
    const journal = new JournalWriter(commanderId, tmpDir)
    await journal.scaffold()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('assembles all layers and includes repo-relevant older spikes', async () => {
    await writeFile(
      join(memoryRoot, 'MEMORY.md'),
      '# Long-term\n\n- Keep auth middleware deterministic\n- Certificate chain changes weekly\n',
      'utf-8',
    )
    await writeFile(
      join(memoryRoot, 'LONG_TERM_MEM.md'),
      [
        '# Commander Long-Term Memory',
        '',
        '## 2026-03-01',
        '',
        '### Journal Narrative',
        'We observed token skew mismatches and validated cert fallback behavior.',
      ].join('\n'),
      'utf-8',
    )

    await mkdir(join(memoryRoot, 'backlog'), { recursive: true })
    await writeFile(
      join(memoryRoot, 'backlog', 'thin-index.md'),
      '- #247 Fix auth token refresh\n- #252 Improve cert diagnostics',
      'utf-8',
    )

    await mkdir(join(commanderRoot, 'skills', 'auth-fix'), { recursive: true })
    await writeFile(
      join(commanderRoot, 'skills', 'auth-fix', 'SKILL.md'),
      '# Auth Fix\n\nUse this when fixing auth token refresh and cert rollover issues.\n',
      'utf-8',
    )
    const workingMemory = new WorkingMemoryStore(commanderId, tmpDir)
    await workingMemory.update({
      source: 'message',
      summary: 'Current hypothesis: token skew handling causes refresh failures.',
      hypothesis: 'Token skew in refresh middleware',
      files: ['apps/hammurabi/modules/commanders/memory/context-builder.ts'],
      tags: ['hypothesis'],
    })

    const today = new Date()
    const yesterday = new Date()
    yesterday.setDate(today.getDate() - 1)
    const older = new Date()
    older.setDate(today.getDate() - 4)
    const olderOtherRepo = new Date()
    olderOtherRepo.setDate(today.getDate() - 7)

    await writeFile(
      join(memoryRoot, 'journal', `${dateString(today)}.md`),
      makeEntryMarkdown({
        time: '11:10',
        salience: 'NOTABLE',
        outcome: 'Investigated token refresh failure',
        issueNumber: 247,
        repo: 'example-user/example-repo',
        durationMin: 28,
        body: 'Found mismatch in refresh skew tolerance.',
      }),
      'utf-8',
    )
    await writeFile(
      join(memoryRoot, 'journal', `${dateString(yesterday)}.md`),
      makeEntryMarkdown({
        time: '09:45',
        salience: 'ROUTINE',
        outcome: 'Validated regression tests',
        issueNumber: 247,
        repo: 'example-user/example-repo',
      }),
      'utf-8',
    )
    await writeFile(
      join(memoryRoot, 'journal', `${dateString(older)}.md`),
      makeEntryMarkdown({
        time: '07:20',
        salience: 'SPIKE',
        outcome: 'Solved cert rollover outage',
        issueNumber: 200,
        repo: 'example-user/example-repo',
        body: 'Root cause was stale trust store in one process pool.',
      }),
      'utf-8',
    )
    await writeFile(
      join(memoryRoot, 'journal', `${dateString(olderOtherRepo)}.md`),
      makeEntryMarkdown({
        time: '08:00',
        salience: 'SPIKE',
        outcome: 'Other repo spike',
        issueNumber: 12,
        repo: 'example-user/another-repo',
        body: 'Should not be included for this task.',
      }),
      'utf-8',
    )

    const issue: GHIssue = {
      number: 247,
      title: 'Fix auth token refresh',
      body: 'Refresh fails when cert rotates and token skew is high.',
      labels: [{ name: 'bug' }],
      owner: 'example-user',
      repo: 'example-repo',
      comments: [
        {
          author: 'reviewer-1',
          createdAt: '2026-02-28T10:00:00.000Z',
          body: 'Please include recent comments and cert handling notes.',
        },
      ],
    }
    const recentConversation: Message[] = [
      { role: 'user', content: 'What did we learn from recent cert incidents?' },
      { role: 'assistant', content: 'Use cached key fallback and rotate certs safely.' },
    ]

    const builder = new MemoryContextBuilder(commanderId, tmpDir)
    const built = await builder.build({
      currentTask: issue,
      recentConversation,
    })

    expect(built.layersIncluded).toEqual([1, 2, 3, 4, 5, 6])
    expect(built.skillsMatched).toEqual([])
    expect(built.systemPromptSection).toContain('## Commander Memory')
    expect(built.systemPromptSection).toContain('### Long-term Memory')
    expect(built.systemPromptSection).toContain('#### Facts (MEMORY.md)')
    expect(built.systemPromptSection).toContain('#### Narrative (LONG_TERM_MEM.md)')
    expect(built.systemPromptSection).toContain('token skew mismatches')
    expect(built.systemPromptSection).toContain('### Current Task')
    expect(built.systemPromptSection).toContain('### Backlog Overview')
    expect(built.systemPromptSection).toContain('### Working Memory Scratchpad')
    expect(built.systemPromptSection).toContain('### Cue-based Recollection')
    expect(built.systemPromptSection).toContain('### Recent Journal (last 2 days)')
    expect(built.systemPromptSection).toContain('### Recent Conversation')
    expect(built.systemPromptSection).not.toContain('auth-fix')
    expect(built.systemPromptSection).toContain('Solved cert rollover outage')
    expect(built.systemPromptSection).toContain('Other repo spike')
    expect(built.systemPromptSection).toContain('stale-signal: different repo context')
  })

  it('trims layers by priority and keeps layers 1 and 2', async () => {
    const memoryLines = Array.from({ length: 40 }, (_, idx) => `line ${idx + 1}`).join('\n')
    await writeFile(join(memoryRoot, 'MEMORY.md'), memoryLines, 'utf-8')

    await mkdir(join(memoryRoot, 'backlog'), { recursive: true })
    await writeFile(
      join(memoryRoot, 'backlog', 'thin-index.md'),
      '- #10 Small backlog item',
      'utf-8',
    )

    const today = new Date()
    await writeFile(
      join(memoryRoot, 'journal', `${dateString(today)}.md`),
      makeEntryMarkdown({
        time: '12:00',
        salience: 'NOTABLE',
        outcome: 'Journal entry for trimming test',
        repo: 'example-user/example-repo',
        body: 'Journal content that should be dropped before core layers.',
      }),
      'utf-8',
    )

    const issue: GHIssue = {
      number: 1,
      title: 'Fix token refresh race',
      body: 'Token refresh and certificate rotation issue.',
      labels: [{ name: 'bug' }],
      owner: 'example-user',
      repo: 'example-repo',
    }
    const recentConversation: Message[] = [
      { role: 'user', content: 'a'.repeat(1000) },
      { role: 'assistant', content: 'b'.repeat(1000) },
    ]

    const builder = new MemoryContextBuilder(commanderId, tmpDir)
    const built = await builder.build({
      currentTask: issue,
      recentConversation,
      tokenBudget: 120,
    })

    expect(built.layersIncluded).toContain(1)
    expect(built.layersIncluded).toContain(2)
    expect(built.layersIncluded).not.toContain(3)
    expect(built.layersIncluded).not.toContain(4)
    expect(built.layersIncluded).not.toContain(5)
    expect(built.layersIncluded).not.toContain(6)
    expect(built.skillsMatched).toEqual([])
  })

  it('caps fact memory to 200 lines and narrative memory to last 100 lines', async () => {
    const longMemory = Array.from({ length: 230 }, (_, idx) => `memory line ${idx + 1}`).join('\n')
    const longNarrative = Array.from({ length: 130 }, (_, idx) => `narrative line ${idx + 1}`).join('\n')
    await writeFile(join(memoryRoot, 'MEMORY.md'), longMemory, 'utf-8')
    await writeFile(join(memoryRoot, 'LONG_TERM_MEM.md'), longNarrative, 'utf-8')
    await mkdir(join(memoryRoot, 'backlog'), { recursive: true })
    await writeFile(join(memoryRoot, 'backlog', 'thin-index.md'), '- #1 test', 'utf-8')

    const builder = new MemoryContextBuilder(commanderId, tmpDir)
    const built = await builder.build({
      currentTask: null,
      recentConversation: [],
    })

    expect(built.systemPromptSection).toContain('_...truncated to first 200 lines._')
    expect(built.systemPromptSection).toContain('_...truncated to last 100 lines._')
    expect(built.systemPromptSection).toContain('narrative line 130')
    expect(built.systemPromptSection).not.toMatch(/\bnarrative line 1\b/)
    expect(built.layersIncluded).toContain(1)
    expect(built.layersIncluded).toContain(2)
  })

  it('includes Layer 1.5 (goals) when GOALS.md exists', async () => {
    const goalsStore = new GoalsStore(commanderId, tmpDir)
    await goalsStore.write([
      {
        id: 'ship-v2',
        title: 'Ship v2 release',
        targetDate: '2026-03-20',
        currentState: 'Feature freeze',
        intendedState: 'Deployed to prod',
        reminders: ['Run smoke tests'],
      },
      {
        id: 'old-goal',
        title: 'Past deadline goal',
        targetDate: '2026-01-01',
        currentState: 'Not started',
        intendedState: 'Complete',
        reminders: [],
      },
    ])

    const builder = new MemoryContextBuilder(commanderId, tmpDir)
    const built = await builder.build({
      currentTask: null,
      recentConversation: [],
    })

    expect(built.layersIncluded).toContain(1.5)
    expect(built.systemPromptSection).toContain('### Active Goals')
    expect(built.systemPromptSection).toContain('Ship v2 release')
    expect(built.systemPromptSection).toContain('⚠️ OVERDUE')
    expect(built.systemPromptSection).toContain('Past deadline goal')
  })

  it('omits Layer 1.5 when GOALS.md does not exist', async () => {
    const builder = new MemoryContextBuilder(commanderId, tmpDir)
    const built = await builder.build({
      currentTask: null,
      recentConversation: [],
    })

    expect(built.layersIncluded).not.toContain(1.5)
    expect(built.systemPromptSection).not.toContain('### Active Goals')
  })

  it('Layer 1.5 is never dropped by budget trimming', async () => {
    const goalsStore = new GoalsStore(commanderId, tmpDir)
    await goalsStore.write([
      {
        id: 'critical',
        title: 'Critical goal',
        targetDate: '2026-12-31',
        currentState: 'Active',
        intendedState: 'Done',
        reminders: [],
      },
    ])

    const builder = new MemoryContextBuilder(commanderId, tmpDir)
    const built = await builder.build({
      currentTask: null,
      recentConversation: [
        { role: 'user', content: 'x'.repeat(2000) },
        { role: 'assistant', content: 'y'.repeat(2000) },
      ],
      tokenBudget: 200,
    })

    // Layer 1.5 should remain even when budget is tight
    expect(built.layersIncluded).toContain(1)
    expect(built.layersIncluded).toContain(1.5)
    expect(built.layersIncluded).toContain(2)
    expect(built.systemPromptSection).toContain('### Active Goals')
  })

  it('wires transcript-backed recollection consistently through builder options', async () => {
    const transcriptSearch = vi.fn(async () => [{
      score: 0.812,
      text: 'We validated staged token rollout behavior during the incident review.',
      sourceFile: join(commanderRoot, 'sessions', '2026-03-10.jsonl'),
      transcriptId: '2026-03-10',
      timestamp: '2026-03-10T12:00:00.000Z',
      role: 'assistant' as const,
      turnNumber: 21,
      messageIndex: 1,
    }])

    const builder = new MemoryContextBuilder(commanderId, tmpDir, {
      recollectionOptions: {
        transcriptSearch,
        hybridSearch: async () => new Map(),
      },
    })

    const built = await builder.build({
      currentTask: null,
      recentConversation: [
        { role: 'user', content: 'What did we learn about staged rollout?' },
      ],
    })

    expect(transcriptSearch).toHaveBeenCalledTimes(1)
    expect(built.systemPromptSection).toContain('transcript: 2026-03-10 turn 21')
    expect(built.systemPromptSection).toContain('semantic 0.812')
  })
})
