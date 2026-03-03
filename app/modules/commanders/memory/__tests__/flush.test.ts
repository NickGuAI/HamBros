import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmergencyFlusher, JournalWriter, type FlushContext } from '../index.js'

describe('EmergencyFlusher', () => {
  let tmpDir: string
  let journal: JournalWriter

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'emergency-flusher-test-'))
    journal = new JournalWriter('cmdr-flush', tmpDir)
    await journal.scaffold()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('pre-compaction flush writes SPIKE journal entry, posts GH progress, and appends MEMORY.md discoveries', async () => {
    const ghClient = {
      postIssueComment: vi.fn(async () => {}),
    }
    const flusher = new EmergencyFlusher('cmdr-flush', journal, ghClient, {
      now: () => new Date('2026-02-28T16:45:00.000Z'),
    })

    const ctx: FlushContext = {
      currentIssue: {
        number: 253,
        repo: 'example-user/example-repo',
        url: 'https://github.com/example-user/example-repo/issues/253',
        title: 'Fix WebSocket replay race',
      },
      taskState: 'Found replay message arriving before open listener registration.',
      pendingSpikeObservations: [
        'WebSocket race condition: register handlers before emitting events.',
      ],
      trigger: 'pre-compaction',
    }

    await flusher.preCompactionFlush(ctx)

    const recent = await journal.readRecent()
    expect(recent).toHaveLength(1)
    expect(recent[0].salience).toBe('SPIKE')
    expect(recent[0].outcome).toBe('Emergency flush before context compaction')
    expect(recent[0].issueNumber).toBe(253)

    expect(ghClient.postIssueComment).toHaveBeenCalledTimes(1)
    expect(ghClient.postIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'example-user/example-repo',
        issueNumber: 253,
      }),
    )

    const memory = await readFile(join(tmpDir, 'cmdr-flush', '.memory', 'MEMORY.md'), 'utf-8')
    expect(memory).toContain('<!-- Emergency flush: 2026-02-28T16:45:00.000Z -->')
    expect(memory).toContain('## Discoveries (2026-02-28)')
    expect(memory).toContain('**[example-user/example-repo]** WebSocket race condition')
    expect(memory).toContain('Issue #253, SPIKE')
  })

  it('between-task flush writes ROUTINE journal and GH comment but does not append MEMORY.md without spikes', async () => {
    const ghClient = {
      postIssueComment: vi.fn(async () => {}),
    }
    const flusher = new EmergencyFlusher('cmdr-flush', journal, ghClient)

    const ctx: FlushContext = {
      currentIssue: {
        number: 167,
        repo: 'example-user/example-repo',
        url: 'https://github.com/example-user/example-repo/issues/167',
        title: 'Flush between-task lifecycle',
      },
      taskState: 'Task completed and ready for next issue.',
      pendingSpikeObservations: [],
      trigger: 'between-task',
    }

    await flusher.betweenTaskFlush(ctx)

    const recent = await journal.readRecent()
    expect(recent).toHaveLength(1)
    expect(recent[0].salience).toBe('ROUTINE')
    expect(recent[0].outcome).toBe('Emergency flush between tasks')

    expect(ghClient.postIssueComment).toHaveBeenCalledTimes(1)

    const memory = await readFile(join(tmpDir, 'cmdr-flush', '.memory', 'MEMORY.md'), 'utf-8')
    expect(memory.trim()).toBe('# Commander Memory')
  })

  it('skips GitHub comment when there is no active issue', async () => {
    const ghClient = {
      postIssueComment: vi.fn(async () => {}),
    }
    const flusher = new EmergencyFlusher('cmdr-flush', journal, ghClient)

    await flusher.preCompactionFlush({
      currentIssue: null,
      taskState: 'Waiting for issue assignment.',
      pendingSpikeObservations: [],
      trigger: 'pre-compaction',
    })

    const recent = await journal.readRecent()
    expect(recent).toHaveLength(1)
    expect(recent[0].issueNumber).toBeNull()
    expect(recent[0].repo).toBeNull()
    expect(ghClient.postIssueComment).not.toHaveBeenCalled()
  })
})
