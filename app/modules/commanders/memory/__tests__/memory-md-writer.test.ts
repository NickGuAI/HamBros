import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryMdWriter } from '../memory-md-writer.js'

describe('MemoryMdWriter.updateFacts()', () => {
  let tmpDir: string
  let memoryRoot: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'memory-writer-test-'))
    memoryRoot = join(tmpDir, '.memory')
    await mkdir(memoryRoot, { recursive: true })
    await writeFile(join(tmpDir, '.memory', 'MEMORY.md'), '# Commander Memory\n\n', 'utf-8')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('deduplicates facts and refreshes last-seen', async () => {
    await writeFile(
      join(memoryRoot, 'MEMORY.md'),
      `# Commander Memory

- Doctrine: Validate audience <!-- last-seen: 2026-01-01 -->
`,
      'utf-8',
    )
    const writer = new MemoryMdWriter(memoryRoot, { now: () => new Date('2026-03-01T02:00:00.000Z') })
    const result = await writer.updateFacts([
      'Doctrine: Validate audience',
      'Avoid: skip startup env validation',
    ])
    expect(result.factsAdded).toBe(1)

    const memory = await readFile(join(memoryRoot, 'MEMORY.md'), 'utf-8')
    expect(memory).toContain('Doctrine: Validate audience <!-- last-seen: 2026-03-01 -->')
    expect(memory).toContain('Avoid: skip startup env validation')
  })

  it('evicts stale entries and writes archive records', async () => {
    await writeFile(
      join(memoryRoot, 'MEMORY.md'),
      `# Commander Memory

- old fact <!-- last-seen: 2025-12-01 -->
- fresh fact <!-- last-seen: 2026-02-25 -->
`,
      'utf-8',
    )

    const writer = new MemoryMdWriter(memoryRoot, { now: () => new Date('2026-03-01T02:00:00.000Z') })
    const result = await writer.updateFacts([])
    expect(result.evicted.some((line) => line.includes('old fact'))).toBe(true)

    const memory = await readFile(join(memoryRoot, 'MEMORY.md'), 'utf-8')
    expect(memory).not.toContain('old fact')
    expect(memory).toContain('fresh fact')

    const archive = await readFile(
      join(memoryRoot, 'archive', 'MEMORY-archive-2026-03-01.md'),
      'utf-8',
    )
    expect(archive).toContain('old fact')
  })

  it('enforces the line cap', async () => {
    const writer = new MemoryMdWriter(memoryRoot, {
      now: () => new Date('2026-03-01T02:00:00.000Z'),
      maxLines: 8,
    })
    const facts = Array.from({ length: 10 }, (_v, idx) => `fact-${idx}`)
    const result = await writer.updateFacts(facts)
    expect(result.lineCount).toBeLessThanOrEqual(8)
  })
})
