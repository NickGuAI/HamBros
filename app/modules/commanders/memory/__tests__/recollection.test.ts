import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AssociationStore,
  toJournalNodeId,
  toSkillNodeId,
} from '../associations.js'
import { MemoryRecollection } from '../recollection.js'
import type { JournalEntry } from '../types.js'

function journalBlock(input: {
  time: string
  salience: 'SPIKE' | 'NOTABLE' | 'ROUTINE'
  outcome: string
  issueNumber?: number
  repo: string
  body?: string
}): string {
  const emoji = input.salience === 'SPIKE'
    ? '🔴'
    : input.salience === 'NOTABLE'
      ? '🟡'
      : '⚪'
  const issue = input.issueNumber != null ? ` (#${input.issueNumber})` : ''
  const body = input.body?.trim() ?? ''

  return (
    `## ${input.time} — ${input.outcome}${issue} ${emoji} ${input.salience}\n\n` +
    `**Repo:** ${input.repo}\n` +
    `**Outcome:** ${input.outcome}\n` +
    (body ? `\n${body}\n` : '\n') +
    `\n---\n\n`
  )
}

describe('MemoryRecollection', () => {
  let tmpDir: string
  let nowValue: Date
  let commanderId: string
  let commanderRoot: string
  let memoryRoot: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'memory-recollection-test-'))
    commanderId = 'cmdr-recollect'
    commanderRoot = join(tmpDir, commanderId)
    memoryRoot = join(commanderRoot, '.memory')
    nowValue = new Date('2026-03-10T10:00:00.000Z')
    await mkdir(join(memoryRoot, 'journal'), { recursive: true })
    await mkdir(join(commanderRoot, 'skills', 'auth-fix'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns skill and memory hits, then increments skill rehearsal metadata', async () => {
    await writeFile(
      join(memoryRoot, 'MEMORY.md'),
      [
        '# Commander Memory',
        '- Prior auth incidents involved refresh middleware ordering.',
        '- Keep token skew tolerance explicit.',
      ].join('\n'),
      'utf-8',
    )
    await writeFile(
      join(commanderRoot, 'skills', 'auth-fix', 'SKILL.md'),
      [
        '---',
        'name: auth-fix',
        'auto-match:',
        '  labels: [bug, auth]',
        '  keywords: [auth, refresh, token]',
        '---',
        '# Auth Fix',
        '',
        'Use this when auth token refresh middleware regresses.',
      ].join('\n'),
      'utf-8',
    )

    const recollection = new MemoryRecollection(commanderId, tmpDir, {
      now: () => nowValue,
    })
    const result = await recollection.recall({
      cue: 'Investigate auth token refresh middleware regression',
      task: {
        number: 247,
        title: 'Fix auth token refresh regression',
        body: 'Auth token refresh fails intermittently',
        owner: 'example-user',
        repo: 'example-repo',
      },
      topK: 8,
    })

    expect(result.queryTerms).toContain('auth')
    expect(result.hits.some((hit) => hit.type === 'skill' && hit.title === 'auth-fix')).toBe(true)
    expect(result.hits.some((hit) => hit.type === 'memory')).toBe(true)

    const associations = new AssociationStore(commanderId, tmpDir, {
      now: () => nowValue,
    })
    let skillNode = await associations.getNode(toSkillNodeId('auth-fix'))
    expect(skillNode).toBeTruthy()
    expect(skillNode?.seenCount).toBe(0)

    nowValue = new Date('2026-03-10T10:02:00.000Z')
    await recollection.recall({
      cue: 'Need auth refresh fix details again',
      task: {
        number: 247,
        title: 'Fix auth token refresh regression',
        body: 'Auth token refresh fails intermittently',
        owner: 'example-user',
        repo: 'example-repo',
      },
      topK: 8,
    })

    skillNode = await associations.getNode(toSkillNodeId('auth-fix'))
    expect(skillNode?.seenCount).toBeGreaterThan(0)
    expect(skillNode?.lastSeen).toBe('2026-03-10')
  })

  it('flags stale spikes by age and repo mismatch', async () => {
    const oldEntry: JournalEntry = {
      timestamp: '2025-12-01T09:00:00.000Z',
      issueNumber: 88,
      repo: 'example-user/another-repo',
      outcome: 'Auth spike in other repo',
      durationMin: 45,
      salience: 'SPIKE',
      body: 'Unexpected auth middleware race condition during token refresh.',
    }

    await writeFile(
      join(memoryRoot, 'journal', '2025-12-01.md'),
      journalBlock({
        time: '09:00',
        salience: 'SPIKE',
        outcome: oldEntry.outcome,
        issueNumber: oldEntry.issueNumber ?? undefined,
        repo: oldEntry.repo ?? 'example-user/another-repo',
        body: oldEntry.body,
      }),
      'utf-8',
    )

    const associations = new AssociationStore(commanderId, tmpDir, {
      now: () => nowValue,
    })
    await associations.upsertJournalEntry(oldEntry)
    expect(await associations.getNode(toJournalNodeId(oldEntry))).toBeTruthy()

    const recollection = new MemoryRecollection(commanderId, tmpDir, {
      now: () => nowValue,
    })
    const result = await recollection.recall({
      cue: 'Investigate auth middleware refresh race',
      task: {
        number: 247,
        title: 'Fix auth token refresh regression',
        body: 'Scope is monorepo auth middleware',
        owner: 'example-user',
        repo: 'example-repo',
      },
      topK: 5,
    })

    const spikeHit = result.hits.find((hit) => hit.title.includes('Auth spike in other repo'))
    expect(spikeHit).toBeDefined()
    expect(spikeHit?.stale).toBe(true)
    expect(spikeHit?.staleReason).toContain('aged')
    expect(spikeHit?.staleReason).toContain('different repo context')
  })

  it('retrieves entries via associative issue links even with weak lexical overlap', async () => {
    const issueLinkedEntry: JournalEntry = {
      timestamp: '2026-03-09T14:30:00.000Z',
      issueNumber: 900,
      repo: 'example-user/example-repo',
      outcome: 'Resolved opaque websocket timeout',
      durationMin: 18,
      salience: 'NOTABLE',
      body: 'Root cause was in websocket retry scheduling.',
    }

    await writeFile(
      join(memoryRoot, 'journal', '2026-03-09.md'),
      journalBlock({
        time: '14:30',
        salience: 'NOTABLE',
        outcome: issueLinkedEntry.outcome,
        issueNumber: issueLinkedEntry.issueNumber ?? undefined,
        repo: issueLinkedEntry.repo ?? 'example-user/example-repo',
        body: issueLinkedEntry.body,
      }),
      'utf-8',
    )

    const associations = new AssociationStore(commanderId, tmpDir, {
      now: () => nowValue,
    })
    await associations.upsertJournalEntry(issueLinkedEntry)

    const recollection = new MemoryRecollection(commanderId, tmpDir, {
      now: () => nowValue,
    })
    const result = await recollection.recall({
      cue: 'Need incident history for this task',
      task: {
        number: 900,
        title: 'Follow-up on websocket resilience',
        body: 'Use prior linked incidents',
        owner: 'example-user',
        repo: 'example-repo',
      },
      topK: 6,
    })

    const associativeHit = result.hits.find((hit) => hit.issueNumber === 900)
    expect(associativeHit).toBeDefined()
    expect(associativeHit?.reason).toContain('associative')
  })
})
