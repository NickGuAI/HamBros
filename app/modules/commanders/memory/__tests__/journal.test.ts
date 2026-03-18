import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveSalience,
  JournalWriter,
  NOTABLE_SIGNALS,
  SPIKE_SIGNALS,
  type JournalEntry,
  type SalienceSignal,
} from '../index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    timestamp: '2026-02-28T14:32:00.000Z',
    issueNumber: 247,
    repo: 'example-user/example-repo',
    outcome: 'Fix auth token refresh',
    durationMin: 18,
    salience: 'NOTABLE',
    body: 'Custom certs live in /etc/ssl/custom/ not /etc/ssl/certs/ in this repo.',
    ...overrides,
  }
}

// ── scaffold ─────────────────────────────────────────────────────────────────

describe('JournalWriter.scaffold()', () => {
  let tmpDir: string
  let writer: JournalWriter

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-memory-test-'))
    writer = new JournalWriter('test-commander', tmpDir)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates all required directories', async () => {
    await writer.scaffold()
    const { stat } = await import('node:fs/promises')
    const checkMemory = (rel: string) => stat(join(tmpDir, 'test-commander', '.memory', rel))
    const checkCommanderRoot = (rel: string) => stat(join(tmpDir, 'test-commander', rel))
    await expect(checkMemory('.')).resolves.toBeTruthy()
    await expect(checkMemory('journal')).resolves.toBeTruthy()
    await expect(checkCommanderRoot('skills')).resolves.toBeTruthy()
    await expect(checkMemory('archive')).resolves.toBeTruthy()
    await expect(checkMemory('archive/journal')).resolves.toBeTruthy()
    await expect(checkMemory('LONG_TERM_MEM.md')).resolves.toBeTruthy()
    await expect(checkMemory('working-memory.json')).resolves.toBeTruthy()
    await expect(checkMemory('working-memory.md')).resolves.toBeTruthy()
    await expect(checkMemory('associations.json')).resolves.toBeTruthy()
  })

  it('creates MEMORY.md with default content', async () => {
    await writer.scaffold()
    const content = await readFile(
      join(tmpDir, 'test-commander', '.memory', 'MEMORY.md'),
      'utf-8',
    )
    expect(content).toContain('# Commander Memory')
  })

  it('creates LONG_TERM_MEM.md with default content', async () => {
    await writer.scaffold()
    const content = await readFile(
      join(tmpDir, 'test-commander', '.memory', 'LONG_TERM_MEM.md'),
      'utf-8',
    )
    expect(content).toContain('# Commander Long-Term Memory')
  })

  it('creates consolidation-log.md with default content', async () => {
    await writer.scaffold()
    const content = await readFile(
      join(tmpDir, 'test-commander', '.memory', 'consolidation-log.md'),
      'utf-8',
    )
    expect(content).toContain('# Consolidation Log')
  })

  it('is idempotent — running twice does not throw or overwrite existing files', async () => {
    await writer.scaffold()
    // Write custom content to MEMORY.md
    const { writeFile } = await import('node:fs/promises')
    const memPath = join(tmpDir, 'test-commander', '.memory', 'MEMORY.md')
    await writeFile(memPath, '# My custom memory\n\n- fact 1\n', 'utf-8')
    // Scaffold again — should NOT overwrite
    await writer.scaffold()
    const content = await readFile(memPath, 'utf-8')
    expect(content).toBe('# My custom memory\n\n- fact 1\n')
  })
})

// ── append ────────────────────────────────────────────────────────────────────

describe('JournalWriter.append()', () => {
  let tmpDir: string
  let writer: JournalWriter

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-memory-test-'))
    writer = new JournalWriter('test-commander', tmpDir)
    await writer.scaffold()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes a SPIKE entry in full format', async () => {
    const entry = makeEntry({ salience: 'SPIKE', body: 'Race condition found in WS handler.' })
    await writer.append(entry)
    const today = new Date().toISOString().slice(0, 10)
    const content = await readFile(
      join(tmpDir, 'test-commander', '.memory', 'journal', `${today}.md`),
      'utf-8',
    )
    expect(content).toContain('🔴 SPIKE')
    expect(content).toContain('Fix auth token refresh')
    expect(content).toContain('#247')
    expect(content).toContain('Race condition found in WS handler.')
    expect(content).toContain('**Repo:** example-user/example-repo')
    expect(content).toContain('**Duration:** 18 min')
  })

  it('writes a NOTABLE entry in full format', async () => {
    const entry = makeEntry({
      salience: 'NOTABLE',
      body: 'Custom certs live in /etc/ssl/custom/ not /etc/ssl/certs/',
    })
    await writer.append(entry)
    const today = new Date().toISOString().slice(0, 10)
    const content = await readFile(
      join(tmpDir, 'test-commander', '.memory', 'journal', `${today}.md`),
      'utf-8',
    )
    expect(content).toContain('🟡 NOTABLE')
    expect(content).toContain('/etc/ssl/custom/')
  })

  it('writes a ROUTINE entry with no body in compact format', async () => {
    const entry = makeEntry({ salience: 'ROUTINE', body: '', issueNumber: 251 })
    await writer.append(entry)
    const today = new Date().toISOString().slice(0, 10)
    const content = await readFile(
      join(tmpDir, 'test-commander', '.memory', 'journal', `${today}.md`),
      'utf-8',
    )
    expect(content).toContain('⚪ ROUTINE')
    // Compact format: no **Outcome:** line
    expect(content).not.toContain('**Outcome:**')
    expect(content).toContain('**Repo:**')
  })

  it('writes a ROUTINE entry with body in full format', async () => {
    const entry = makeEntry({
      salience: 'ROUTINE',
      body: 'Note: merged without conflicts.',
    })
    await writer.append(entry)
    const today = new Date().toISOString().slice(0, 10)
    const content = await readFile(
      join(tmpDir, 'test-commander', '.memory', 'journal', `${today}.md`),
      'utf-8',
    )
    expect(content).toContain('⚪ ROUTINE')
    expect(content).toContain('**Outcome:**')
    expect(content).toContain('Note: merged without conflicts.')
  })

  it('accumulates multiple entries in the same journal file', async () => {
    await writer.append(makeEntry({ salience: 'SPIKE', outcome: 'Fix race condition', body: 'Body A' }))
    await writer.append(makeEntry({ salience: 'ROUTINE', outcome: 'Update README', body: '' }))
    await writer.append(makeEntry({ salience: 'NOTABLE', outcome: 'Deploy fix', body: 'Body C' }))
    const today = new Date().toISOString().slice(0, 10)
    const content = await readFile(
      join(tmpDir, 'test-commander', '.memory', 'journal', `${today}.md`),
      'utf-8',
    )
    expect(content).toContain('Fix race condition')
    expect(content).toContain('Update README')
    expect(content).toContain('Deploy fix')
  })

  it('includes no issue number when issueNumber is null', async () => {
    const entry = makeEntry({ salience: 'ROUTINE', issueNumber: null, body: '' })
    await writer.append(entry)
    const today = new Date().toISOString().slice(0, 10)
    const content = await readFile(
      join(tmpDir, 'test-commander', '.memory', 'journal', `${today}.md`),
      'utf-8',
    )
    expect(content).not.toMatch(/#\d+/)
  })
})

// ── readDate ─────────────────────────────────────────────────────────────────

describe('JournalWriter.readDate()', () => {
  let tmpDir: string
  let writer: JournalWriter

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-memory-test-'))
    writer = new JournalWriter('test-commander', tmpDir)
    await writer.scaffold()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array for a date with no journal file', async () => {
    const entries = await writer.readDate('2020-01-01')
    expect(entries).toEqual([])
  })

  it('parses a SPIKE entry correctly', async () => {
    const original = makeEntry({
      salience: 'SPIKE',
      issueNumber: 123,
      repo: 'example-user/example-repo',
      outcome: 'Fix WebSocket race',
      durationMin: 45,
      body: 'Handlers must be registered before first message.',
    })
    await writer.append(original)
    const today = new Date().toISOString().slice(0, 10)
    const entries = await writer.readDate(today)
    expect(entries).toHaveLength(1)
    const e = entries[0]
    expect(e.salience).toBe('SPIKE')
    expect(e.issueNumber).toBe(123)
    expect(e.repo).toBe('example-user/example-repo')
    expect(e.outcome).toBe('Fix WebSocket race')
    expect(e.durationMin).toBe(45)
  })

  it('parses multiple entries in one file', async () => {
    await writer.append(makeEntry({ salience: 'SPIKE', outcome: 'First task', body: 'detail' }))
    await writer.append(makeEntry({ salience: 'ROUTINE', outcome: 'Second task', body: '' }))
    const today = new Date().toISOString().slice(0, 10)
    const entries = await writer.readDate(today)
    expect(entries).toHaveLength(2)
    expect(entries[0].outcome).toBe('First task')
    expect(entries[1].outcome).toBe('Second task')
  })
})

// ── readRecent ────────────────────────────────────────────────────────────────

describe('JournalWriter.readRecent()', () => {
  let tmpDir: string
  let writer: JournalWriter

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-memory-test-'))
    writer = new JournalWriter('test-commander', tmpDir)
    await writer.scaffold()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when no journal files exist', async () => {
    const entries = await writer.readRecent()
    expect(entries).toEqual([])
  })

  it('returns today entries when only today has data', async () => {
    await writer.append(makeEntry({ salience: 'NOTABLE', outcome: 'Deploy v2', body: 'done' }))
    const entries = await writer.readRecent()
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries.some((e) => e.outcome === 'Deploy v2')).toBe(true)
  })

  it('returns yesterday entries before today entries', async () => {
    const { writeFile } = await import('node:fs/promises')
    // Manually write a yesterday journal file
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().slice(0, 10)
    const journalPath = join(
      tmpDir,
      'test-commander',
      '.memory',
      'journal',
      `${yesterdayStr}.md`,
    )
    // Write a parseable entry for yesterday
    await writeFile(
      journalPath,
      `## 09:00 — Old task (#100) 🔴 SPIKE\n\n**Repo:** example-user/example-repo\n**Outcome:** Old task\n**Duration:** 10 min\n\nYesterday spike body.\n\n---\n\n`,
      'utf-8',
    )
    await writer.append(makeEntry({ salience: 'ROUTINE', outcome: 'Today task', body: '' }))
    const entries = await writer.readRecent()
    const outcomes = entries.map((e) => e.outcome)
    const oldIdx = outcomes.indexOf('Old task')
    const todayIdx = outcomes.indexOf('Today task')
    expect(oldIdx).toBeGreaterThanOrEqual(0)
    expect(todayIdx).toBeGreaterThanOrEqual(0)
    expect(oldIdx).toBeLessThan(todayIdx)
  })
})

// ── deriveSalience ────────────────────────────────────────────────────────────

describe('deriveSalience()', () => {
  it('returns ROUTINE for empty signals', () => {
    expect(deriveSalience([])).toBe('ROUTINE')
  })

  it('returns ROUTINE for standard-completion signal', () => {
    const signals: SalienceSignal[] = [{ type: 'standard-completion' }]
    expect(deriveSalience(signals)).toBe('ROUTINE')
  })

  it('returns SPIKE for any SPIKE signal', () => {
    for (const type of SPIKE_SIGNALS) {
      expect(deriveSalience([{ type }])).toBe('SPIKE')
    }
  })

  it('returns NOTABLE for any NOTABLE signal when no SPIKE present', () => {
    for (const type of NOTABLE_SIGNALS) {
      expect(deriveSalience([{ type }])).toBe('NOTABLE')
    }
  })

  it('SPIKE wins over NOTABLE when both present', () => {
    const signals: SalienceSignal[] = [
      { type: 'nontrivial-completion' },
      { type: 'user-correction' },
    ]
    expect(deriveSalience(signals)).toBe('SPIKE')
  })

  it('SPIKE wins over ROUTINE', () => {
    const signals: SalienceSignal[] = [
      { type: 'standard-completion' },
      { type: 'novel-failure' },
    ]
    expect(deriveSalience(signals)).toBe('SPIKE')
  })
})
