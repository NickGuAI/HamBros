import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillWriter } from '../skill-writer.js'

describe('SkillWriter', () => {
  let tmpDir: string
  let writer: SkillWriter

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-skill-writer-test-'))
    writer = new SkillWriter('test-commander', tmpDir)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates a new SKILL.md with expected frontmatter fields', async () => {
    await writer.createSkill({
      name: 'auth-token-fix',
      title: 'Auth Token Fix',
      description: 'Diagnose and fix token or cert path issues',
      whenToApply: 'Use when auth errors mention expired token or cert path mismatch.',
      procedure: [
        '1. Read the auth error details.',
        '2. Verify configured cert/token path.',
        '3. Patch config and add startup validation.',
      ].join('\n'),
      sourceEpisodes: [
        'Issue #247: Token refresh using expired cert path (2026-02-25)',
        'Issue #260: Same pattern in a second service (2026-02-26)',
        'Issue #275: Auth failure in staging (2026-02-28)',
      ],
      pitfalls: ['Missing startup cert validation causes repeated regressions.'],
      autoMatch: {
        labels: ['bug', 'auth', 'authentication'],
        keywords: ['token', 'cert', 'certificate', 'ssl', 'refresh', 'expired'],
      },
      frequency: 3,
      lastSeen: '2026-02-28',
      source: 'consolidation',
    })

    const skillPath = join(
      tmpDir,
      'test-commander',
      'skills',
      'auth-token-fix',
      'SKILL.md',
    )
    const content = await readFile(skillPath, 'utf-8')

    expect(content).toContain('name: auth-token-fix')
    expect(content).toContain('user-invocable: false')
    expect(content).toContain('source: consolidation')
    expect(content).toContain('frequency: 3')
    expect(content).toContain('last-seen: 2026-02-28')
    expect(content).toContain('## Procedure')
    expect(content).toContain('## Source Episodes')
    const memoryIndex = await readFile(
      join(tmpDir, 'test-commander', '.memory', 'MEMORY.md'),
      'utf-8',
    )
    expect(memoryIndex).toContain('## Skill Index')
    expect(memoryIndex).toContain('`auth-token-fix` -> `../skills/auth-token-fix/SKILL.md`')

    const manifests = await writer.loadSkillManifests()
    expect(manifests).toHaveLength(1)
    expect(manifests[0]).toMatchObject({
      name: 'auth-token-fix',
      source: 'consolidation',
      frequency: 3,
      lastSeen: '2026-02-28',
    })
  })

  it('updates metadata/episodes/pitfalls while preserving existing Procedure section', async () => {
    await writer.createSkill({
      name: 'auth-token-fix',
      title: 'Auth Token Fix',
      description: 'Initial description',
      whenToApply: 'Initial trigger text',
      procedure: [
        '1. Preserve this custom step A.',
        '2. Preserve this custom step B.',
      ].join('\n'),
      sourceEpisodes: [
        'Issue #247: Token refresh path mismatch (2026-02-25)',
        'Issue #260: Same fix pattern (2026-02-26)',
        'Issue #275: Auth failure in staging (2026-02-28)',
      ],
      pitfalls: ['Initial pitfall'],
      autoMatch: { labels: ['auth'], keywords: ['token'] },
      frequency: 3,
      lastSeen: '2026-02-28',
      source: 'consolidation',
    })

    await writer.updateSkill({
      name: 'auth-token-fix',
      title: 'Auth Token Fix',
      description: 'Updated description',
      whenToApply: 'Updated trigger text',
      procedure: '1. New generated step that should NOT replace custom procedure',
      sourceEpisodes: [
        'Issue #260: Same fix pattern (2026-02-26)',
        'Issue #301: New recurrence in prod (2026-03-01)',
      ],
      pitfalls: ['New pitfall: stale cert symlink'],
      autoMatch: { labels: ['bug'], keywords: ['cert', 'refresh'] },
      lastSeen: '2026-03-01',
    })

    const skillPath = join(
      tmpDir,
      'test-commander',
      'skills',
      'auth-token-fix',
      'SKILL.md',
    )
    const content = await readFile(skillPath, 'utf-8')

    expect(content).toContain('1. Preserve this custom step A.')
    expect(content).toContain('2. Preserve this custom step B.')
    expect(content).not.toContain('New generated step that should NOT replace custom procedure')

    expect(content).toContain('frequency: 4')
    expect(content).toContain('last-seen: 2026-03-01')
    expect(content).toContain('Issue #301: New recurrence in prod (2026-03-01)')
    expect(content).toContain('New pitfall: stale cert symlink')

    const manifests = await writer.loadSkillManifests()
    expect(manifests[0]).toMatchObject({
      name: 'auth-token-fix',
      frequency: 4,
      lastSeen: '2026-03-01',
    })
    expect(manifests[0].autoMatch.labels).toEqual(expect.arrayContaining(['auth', 'bug']))
    expect(manifests[0].autoMatch.keywords).toEqual(
      expect.arrayContaining(['token', 'cert', 'refresh']),
    )
  })
})
