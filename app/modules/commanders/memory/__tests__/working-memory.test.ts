import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkingMemory, WorkingMemoryStore } from '../working-memory.js'

describe('WorkingMemoryStore', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'working-memory-store-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates default scratchpad state and markdown representation', async () => {
    let nowValue = new Date('2026-03-10T10:00:00.000Z')
    const store = new WorkingMemoryStore('cmdr-working', tmpDir, {
      now: () => nowValue,
    })

    await store.ensure()
    const state = await store.readState()
    expect(state.version).toBe(1)
    expect(state.activeHypothesis).toBeNull()
    expect(state.filesInFocus).toEqual([])
    expect(state.checkpoints).toEqual([])

    const markdownPath = join(
      tmpDir,
      'cmdr-working',
      '.memory',
      'working-memory.md',
    )
    const markdown = await readFile(markdownPath, 'utf-8')
    expect(markdown).toContain('# Working Memory')
    expect(markdown).toContain('Active hypothesis: _none_')

    nowValue = new Date('2026-03-10T10:10:00.000Z')
    await store.update({
      source: 'message',
      summary: 'Investigate auth refresh path and verify middleware ordering',
      hypothesis: 'Middleware order bug',
      files: ['modules/auth/middleware.ts', './modules/auth/middleware.ts'],
      tags: ['Auth', 'auth', 'hypothesis'],
    })

    const updated = await store.readState()
    expect(updated.activeHypothesis).toBe('Middleware order bug')
    expect(updated.filesInFocus).toContain('modules/auth/middleware.ts')
    expect(updated.checkpoints).toHaveLength(1)
    expect(updated.checkpoints[0]).toMatchObject({
      source: 'message',
      summary: 'Investigate auth refresh path and verify middleware ordering',
      tags: ['auth', 'hypothesis'],
    })
  })

  it('deduplicates duplicate checkpoints within the duplicate window', async () => {
    let nowValue = new Date('2026-03-11T09:00:00.000Z')
    const store = new WorkingMemoryStore('cmdr-working', tmpDir, {
      now: () => nowValue,
    })

    await store.update({
      source: 'heartbeat',
      summary: 'Commander heartbeat summary',
      tags: ['heartbeat'],
    })

    nowValue = new Date('2026-03-11T09:01:00.000Z')
    await store.update({
      source: 'heartbeat',
      summary: 'Commander heartbeat summary',
      tags: ['heartbeat'],
    })

    let state = await store.readState()
    expect(state.checkpoints).toHaveLength(1)

    nowValue = new Date('2026-03-11T09:04:00.000Z')
    await store.update({
      source: 'heartbeat',
      summary: 'Commander heartbeat summary',
      tags: ['heartbeat'],
    })

    state = await store.readState()
    expect(state.checkpoints).toHaveLength(2)
  })

  it('renders checkpoint details for commander context injection', async () => {
    let nowValue = new Date('2026-03-12T07:30:00.000Z')
    const store = new WorkingMemoryStore('cmdr-working', tmpDir, {
      now: () => nowValue,
    })

    await store.update({
      source: 'start',
      summary: 'Commander session started for auth issue',
      issueNumber: 247,
      repo: 'example-user/example-repo',
      hypothesis: 'Token skew mismatch',
      files: ['apps/hammurabi/modules/commanders/routes.ts'],
      tags: ['startup', 'task-linked'],
    })

    nowValue = new Date('2026-03-12T07:45:00.000Z')
    await store.update({
      source: 'message',
      summary: 'Validate refresh middleware tests before patching',
      issueNumber: 247,
      repo: 'example-user/example-repo',
      tags: ['instruction'],
    })

    const rendered = await store.render(8)
    expect(rendered).toContain('### Working Memory Scratchpad')
    expect(rendered).toContain('Active hypothesis: Token skew mismatch')
    expect(rendered).toContain('Files in focus: apps/hammurabi/modules/commanders/routes.ts')
    expect(rendered).toContain('(start) #247 [example-user/example-repo] {startup, task-linked}')
    expect(rendered).toContain('(message) #247 [example-user/example-repo] {instruction}')
  })
})

describe('WorkingMemory', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'working-memory-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('supports append/read/clear lifecycle', async () => {
    let nowValue = new Date('2026-03-13T08:00:00.000Z')
    const workingMemory = new WorkingMemory('cmdr-working', tmpDir, {
      now: () => nowValue,
    })

    await workingMemory.append('Investigating websocket replay ordering.')
    nowValue = new Date('2026-03-13T08:05:00.000Z')
    await workingMemory.append('Noticed race around message listener setup.')

    const content = await workingMemory.read()
    expect(content).toContain('Investigating websocket replay ordering.')
    expect(content).toContain('Noticed race around message listener setup.')

    await workingMemory.clear()
    const cleared = await workingMemory.read()
    expect(cleared).toBe('')

    const statePath = join(tmpDir, 'cmdr-working', '.memory', 'working-memory.json')
    const state = await readFile(statePath, 'utf-8')
    expect(state).toContain('"checkpoints": []')
  })
})
