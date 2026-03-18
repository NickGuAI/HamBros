import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillDistiller, type DistilledPattern, type DistillerInput } from '../skill-distiller.js'
import type { JournalEntry } from '../types.js'

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    timestamp: '2026-02-28T14:32:00.000Z',
    issueNumber: 247,
    repo: 'example-user/example-repo',
    outcome: 'Fix auth token refresh',
    durationMin: 18,
    salience: 'NOTABLE',
    body: 'Adjusted cert path and validated token refresh flow.',
    ...overrides,
  }
}

function makeInput(): DistillerInput {
  return {
    journalEntries: [
      makeEntry({ issueNumber: 247, outcome: 'Fix auth token path' }),
      makeEntry({ issueNumber: 260, outcome: 'Fix auth cert mismatch' }),
      makeEntry({ issueNumber: 275, outcome: 'Fix staging auth refresh' }),
    ],
    parsedDebriefs: [
      {
        timestamp: '2026-02-28T18:00:00.000Z',
        issueNumber: 275,
        sustain: ['Validated cert path before deploy.'],
        doctrineUpdates: ['Always add startup cert validation for auth services.'],
      },
    ],
  }
}

describe('SkillDistiller', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-skill-distiller-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates skills only for patterns meeting frequency threshold and reports counts', async () => {
    const patterns: DistilledPattern[] = [
      {
        id: 'auth-token-fix',
        name: 'Auth Token Fix',
        triggers: ['Authentication fails with token/cert path errors'],
        steps: [
          'Read auth error and isolate failing token/cert',
          'Find expected path in service config',
          'Patch path and validate refresh flow',
          'Add startup validation test',
        ],
        sourceEpisodes: [
          { issueNumber: 247, summary: 'Token refresh used stale cert path', date: '2026-02-25' },
          { issueNumber: 260, summary: 'Same fix in another service', date: '2026-02-26' },
          { issueNumber: 275, summary: 'Staging auth failed due to cert path', date: '2026-02-28' },
        ],
        confidence: 0.92,
        pitfalls: ['Forgetting startup validation allows regression.'],
        labels: ['bug', 'auth'],
        keywords: ['token', 'cert', 'refresh'],
        frequency: 3,
      },
      {
        id: 'one-off-not-yet-skill',
        name: 'One Off Not Yet Skill',
        triggers: ['Rare one-off behavior'],
        steps: ['Investigate once'],
        sourceEpisodes: [
          { issueNumber: 300, summary: 'Single occurrence', date: '2026-02-28' },
          { issueNumber: 301, summary: 'Second occurrence', date: '2026-03-01' },
        ],
        confidence: 0.51,
        frequency: 2,
      },
    ]

    const distiller = new SkillDistiller('test-commander', {
      basePath: tmpDir,
      now: () => new Date('2026-03-01T09:00:00.000Z'),
      detectPatterns: async () => patterns,
    })

    const report = await distiller.run(makeInput())

    expect(report).toEqual({
      skillsCreated: ['auth-token-fix'],
      skillsUpdated: [],
      patternsDetected: 2,
      patternsBelowThreshold: 1,
    })

    const skillPath = join(
      tmpDir,
      'test-commander',
      'skills',
      'auth-token-fix',
      'SKILL.md',
    )

    const skillContent = await readFile(skillPath, 'utf-8')
    expect(skillContent).toContain('name: auth-token-fix')
    expect(skillContent).toContain('frequency: 3')
    expect(skillContent).toContain('last-seen: 2026-03-01')
    expect(skillContent).toContain('## Procedure')

    const manifests = await distiller.loadExistingSkills()
    expect(manifests).toHaveLength(1)
    expect(manifests[0]).toMatchObject({
      name: 'auth-token-fix',
      frequency: 3,
      lastSeen: '2026-03-01',
      source: 'consolidation',
    })
  })

  it('updates existing skill metadata while preserving Procedure section', async () => {
    const patternBatches: DistilledPattern[][] = [
      [
        {
          id: 'auth-token-fix',
          name: 'Auth Token Fix',
          triggers: ['Authentication failures with cert path mismatch'],
          steps: ['Initial generated step that will be preserved only for first create'],
          sourceEpisodes: [
            { issueNumber: 247, summary: 'Token refresh used stale cert path', date: '2026-02-25' },
            { issueNumber: 260, summary: 'Same fix in another service', date: '2026-02-26' },
            { issueNumber: 275, summary: 'Staging auth failed', date: '2026-02-28' },
          ],
          confidence: 0.9,
          frequency: 3,
        },
      ],
      [
        {
          id: 'auth-token-fix',
          name: 'Auth Token Fix',
          triggers: ['Authentication failures with cert path mismatch'],
          steps: ['New generated step that should NOT overwrite custom procedure'],
          sourceEpisodes: [
            { issueNumber: 247, summary: 'Token refresh used stale cert path', date: '2026-02-25' },
            { issueNumber: 260, summary: 'Same fix in another service', date: '2026-02-26' },
            { issueNumber: 302, summary: 'Prod auth failure due to cert path', date: '2026-03-02' },
          ],
          confidence: 0.93,
          frequency: 3,
          pitfalls: ['Missing startup check delayed root-cause detection.'],
        },
      ],
    ]

    let currentDate = new Date('2026-03-01T09:00:00.000Z')

    const distiller = new SkillDistiller('test-commander', {
      basePath: tmpDir,
      now: () => currentDate,
      detectPatterns: async () => patternBatches.shift() ?? [],
    })

    await distiller.run(makeInput())

    const skillPath = join(
      tmpDir,
      'test-commander',
      'skills',
      'auth-token-fix',
      'SKILL.md',
    )

    let content = await readFile(skillPath, 'utf-8')
    content = content.replace(
      /## Procedure\n[\s\S]*?(?=\n## Known Pitfalls)/,
      [
        '## Procedure',
        '',
        '1. Custom step retained A.',
        '2. Custom step retained B.',
      ].join('\n'),
    )

    await writeFile(skillPath, content, 'utf-8')

    currentDate = new Date('2026-03-02T09:00:00.000Z')
    const report = await distiller.run(makeInput())

    expect(report.skillsCreated).toEqual([])
    expect(report.skillsUpdated).toEqual(['auth-token-fix'])
    expect(report.patternsDetected).toBe(1)
    expect(report.patternsBelowThreshold).toBe(0)

    const updatedContent = await readFile(skillPath, 'utf-8')
    expect(updatedContent).toContain('1. Custom step retained A.')
    expect(updatedContent).toContain('2. Custom step retained B.')
    expect(updatedContent).not.toContain('New generated step that should NOT overwrite custom procedure')

    expect(updatedContent).toContain('frequency: 4')
    expect(updatedContent).toContain('last-seen: 2026-03-02')
    expect(updatedContent).toContain('Issue #302: Prod auth failure due to cert path (2026-03-02)')
    expect(updatedContent).toContain('Missing startup check delayed root-cause detection.')
  })
})
