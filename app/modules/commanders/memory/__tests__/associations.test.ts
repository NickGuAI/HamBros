import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AssociationStore,
  toJournalNodeId,
  toSkillNodeId,
} from '../associations.js'
import type { JournalEntry } from '../types.js'

describe('AssociationStore', () => {
  let tmpDir: string
  let nowValue: Date

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'associations-store-test-'))
    nowValue = new Date('2026-03-10T00:00:00.000Z')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('indexes journal entries and scores them against cue concepts', async () => {
    const store = new AssociationStore('cmdr-assoc', tmpDir, {
      now: () => nowValue,
    })
    const entry: JournalEntry = {
      timestamp: '2026-03-09T11:20:00.000Z',
      issueNumber: 167,
      repo: 'example-user/example-repo',
      outcome: 'Fix auth refresh race',
      durationMin: 26,
      salience: 'SPIKE',
      body: 'Investigated token skew and middleware ordering regressions.',
    }

    const nodeId = await store.upsertJournalEntry(entry)
    expect(nodeId).toBe(toJournalNodeId(entry))

    const score = await store.scoreNodeForCue(nodeId, {
      text: 'auth token refresh middleware skew',
      repo: 'example-user/example-repo',
      issueNumber: 167,
    })
    expect(score).toBeGreaterThan(0)

    const related = await store.relatedNodeIdsForCue({
      text: 'auth token refresh middleware',
      repo: 'example-user/example-repo',
      issueNumber: 167,
    })
    expect(related).toContain(nodeId)

    const graph = await store.getGraphSnapshot()
    expect(graph.nodes[nodeId]).toBeDefined()
    expect(graph.nodes[nodeId]?.kind).toBe('journal')
    expect(
      graph.edges.some((edge) => edge.from === nodeId && edge.kind === 'issue'),
    ).toBe(true)
  })

  it('indexes skills and tracks rehearsal counts through touch()', async () => {
    const store = new AssociationStore('cmdr-assoc', tmpDir, {
      now: () => nowValue,
    })

    const skillNodeId = await store.upsertSkill({
      name: 'auth-fix',
      path: '/tmp/cmdr-assoc/skills/auth-fix/SKILL.md',
      description: 'Use for auth token refresh bugs in example-user/example-repo middleware.',
      labels: ['auth', 'bug'],
      keywords: ['token', 'refresh'],
    })
    expect(skillNodeId).toBe(toSkillNodeId('auth-fix'))

    const cueScore = await store.scoreNodeForCue(skillNodeId, {
      text: 'auth token refresh bug',
      repo: 'example-user/example-repo',
      issueNumber: 247,
    })
    expect(cueScore).toBeGreaterThan(0)

    nowValue = new Date('2026-03-10T01:00:00.000Z')
    await store.touch([skillNodeId, skillNodeId])
    let skillNode = await store.getNode(skillNodeId)
    expect(skillNode?.seenCount).toBe(1)
    expect(skillNode?.lastSeen).toBe(nowValue.toISOString())

    nowValue = new Date('2026-03-10T02:00:00.000Z')
    await store.touch([skillNodeId])
    skillNode = await store.getNode(skillNodeId)
    expect(skillNode?.seenCount).toBe(2)
    expect(skillNode?.lastSeen).toBe(nowValue.toISOString())
  })
})
