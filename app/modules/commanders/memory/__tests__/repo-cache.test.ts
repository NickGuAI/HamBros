import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoCacheManager, type JournalEntry } from '../index.js'
import type { ParsedDebrief } from '../repo-cache.js'

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    timestamp: '2026-02-28T14:32:00.000Z',
    issueNumber: 167,
    repo: 'example-user/example-repo',
    outcome: 'Consolidated repo learnings',
    durationMin: 22,
    salience: 'NOTABLE',
    body: '',
    ...overrides,
  }
}

describe('RepoCacheManager', () => {
  let tmpDir: string
  let manager: RepoCacheManager

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'repo-cache-test-'))
    manager = new RepoCacheManager('test-commander', tmpDir)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns empty string when the repo cache does not exist', async () => {
    const content = await manager.read('example-user', 'example-repo')
    expect(content).toBe('')
  })

  it('returns a deterministic path for owner/repo', () => {
    expect(manager.cachePath('example-user', 'example-repo')).toBe(
      join(tmpDir, 'test-commander', '.memory', 'repos', 'example-user_example-repo.md'),
    )
  })

  it('creates a cache file and appends extracted learnings from consolidation inputs', async () => {
    const entries: JournalEntry[] = [
      makeEntry({
        salience: 'SPIKE',
        body: [
          '- API routes live in modules/{name}/routes.ts',
          '- Must run npm run build before tests or type errors appear',
        ].join('\n'),
      }),
      makeEntry({
        salience: 'NOTABLE',
        body: [
          '- Key file: modules/commanders/manager.ts for Commander lifecycle',
          '- Test runner: Vitest via npm test',
        ].join('\n'),
      }),
    ]
    const debriefs: ParsedDebrief[] = [
      {
        doctrineUpdates: ['Filenames use kebab-case'],
        improveRootCauses: ['Method extraction from class instances loses this context'],
      },
    ]

    await manager.updateFromConsolidation('example-user', 'example-repo', entries, debriefs)
    const content = await manager.read('example-user', 'example-repo')

    expect(content).toContain('# example-user/example-repo')
    expect(content).toContain('tasks-completed: 1')
    expect(content).toContain('API routes live in modules/{name}/routes.ts')
    expect(content).toContain('Must run npm run build before tests or type errors appear')
    expect(content).toContain('Key file: modules/commanders/manager.ts for Commander lifecycle')
    expect(content).toContain('Test runner: Vitest via npm test')
    expect(content).toContain('Filenames use kebab-case')
    expect(content).toContain('Method extraction from class instances loses this context')
  })

  it('deduplicates facts across repeated consolidation runs', async () => {
    const entries: JournalEntry[] = [
      makeEntry({
        salience: 'SPIKE',
        body: '- Must run npm run build before tests or type errors appear',
      }),
    ]

    await manager.updateFromConsolidation('example-user', 'example-repo', entries, [])
    await manager.updateFromConsolidation('example-user', 'example-repo', entries, [])
    const content = await manager.read('example-user', 'example-repo')

    const matches = content.match(/Must run npm run build before tests or type errors appear/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('adds stale flag when cache is older than 30 days and no new work is provided', async () => {
    const entries: JournalEntry[] = [
      makeEntry({
        salience: 'NOTABLE',
        body: '- Test runner: Vitest via npm test',
      }),
    ]

    await manager.updateFromConsolidation('example-user', 'example-repo', entries, [])
    const cachePath = manager.cachePath('example-user', 'example-repo')
    const original = await readFile(cachePath, 'utf-8')
    const staleDate = new Date(Date.now() - (45 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10)
    await writeFile(
      cachePath,
      original.replace(/last-updated: \d{4}-\d{2}-\d{2}/, `last-updated: ${staleDate}`),
      'utf-8',
    )

    await manager.updateFromConsolidation('example-user', 'example-repo', [], [])
    const staleContent = await manager.read('example-user', 'example-repo')

    expect(staleContent).toContain('<!-- may be stale -->')
    expect(staleContent).toContain(`last-updated: ${staleDate}`)
  })

  it('lists cached repos in owner/repo format', async () => {
    await manager.updateFromConsolidation(
      'example-user',
      'example-repo',
      [makeEntry({ repo: 'example-user/example-repo', body: '- Test runner: Vitest via npm test' })],
      [],
    )
    await manager.updateFromConsolidation(
      'example-user',
      'legion',
      [makeEntry({ repo: 'example-user/legion', body: '- Key file: apps/legion/main.ts' })],
      [],
    )

    const repos = await manager.listCachedRepos()
    expect(repos).toEqual(['example-user/legion', 'example-user/example-repo'])
  })
})
