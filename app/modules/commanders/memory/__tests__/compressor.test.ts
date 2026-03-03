import { describe, expect, it } from 'vitest'
import { JournalCompressor } from '../compressor.js'
import type { JournalEntry } from '../types.js'

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    timestamp: '2026-02-01T12:00:00.000Z',
    issueNumber: 167,
    repo: 'example-user/example-repo',
    outcome: 'Consolidate memory flow',
    durationMin: 30,
    salience: 'NOTABLE',
    body: 'Detailed body for compression tests.',
    ...overrides,
  }
}

describe('JournalCompressor.compress()', () => {
  const compressor = new JournalCompressor()

  it('keeps SPIKE verbatim for >7 and >30 day windows', async () => {
    const spike = entry({ salience: 'SPIKE' })
    await expect(compressor.compress(spike, 10)).resolves.toContain('🔴 SPIKE')
    await expect(compressor.compress(spike, 45)).resolves.toContain('🔴 SPIKE')
    await expect(compressor.compress(spike, 45)).resolves.toContain('**Outcome:**')
  })

  it('compresses NOTABLE to a short summary after 7 days', async () => {
    const notable = entry({ salience: 'NOTABLE' })
    const result = await compressor.compress(notable, 9)
    expect(result).toContain('🟡 NOTABLE')
    expect(result).toContain('- Repo:')
  })

  it('compresses NOTABLE to one-line mention after 30 days', async () => {
    const notable = entry({ salience: 'NOTABLE' })
    const result = await compressor.compress(notable, 31)
    expect(result).toContain('🟡 NOTABLE')
    expect(result).not.toContain('- Repo:')
  })

  it('deletes non-SPIKE entries after 90 days and summarizes SPIKE', async () => {
    await expect(compressor.compress(entry({ salience: 'ROUTINE' }), 95)).resolves.toBeNull()
    const spike = await compressor.compress(entry({ salience: 'SPIKE' }), 95)
    expect(spike).toContain('Historical summary:')
  })
})

describe('JournalCompressor.buildWeeklySummary()', () => {
  it('builds a single weekly rollup line', async () => {
    const compressor = new JournalCompressor()
    const summary = await compressor.buildWeeklySummary(
      [
        entry({ salience: 'ROUTINE', durationMin: 10, repo: 'repo/a' }),
        entry({ salience: 'ROUTINE', durationMin: 5, repo: 'repo/a' }),
        entry({ salience: 'ROUTINE', durationMin: 15, repo: 'repo/b' }),
      ],
      '2026-02-23',
    )
    expect(summary).toContain('Week of 2026-02-23')
    expect(summary).toContain('merged 3 routine entries')
    expect(summary).toContain('30 min')
  })
})
