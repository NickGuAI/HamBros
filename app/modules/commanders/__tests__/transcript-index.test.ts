import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  maintainCommanderTranscriptIndex,
  pruneCommanderTranscriptArchives,
  searchCommanderTranscriptIndex,
  syncCommanderTranscriptIndex,
} from '../transcript-index.js'

describe('transcript-index', () => {
  let tmpDir: string
  let originalGeminiApiKey: string | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-transcript-index-test-'))
    originalGeminiApiKey = process.env.GEMINI_API_KEY
    process.env.GEMINI_API_KEY = 'test-gemini-key'
  })

  afterEach(async () => {
    if (originalGeminiApiKey === undefined) {
      delete process.env.GEMINI_API_KEY
    } else {
      process.env.GEMINI_API_KEY = originalGeminiApiKey
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('deletes commander transcript files older than the default retention window', async () => {
    const commanderId = 'cmdr-archive'
    const sessionsDir = join(tmpDir, commanderId, 'sessions')
    await mkdir(sessionsDir, { recursive: true })

    const oldTranscriptPath = join(sessionsDir, 'old-session.jsonl')
    const freshTranscriptPath = join(sessionsDir, 'fresh-session.jsonl')
    await writeFile(oldTranscriptPath, '{"type":"result"}\n', 'utf8')
    await writeFile(freshTranscriptPath, '{"type":"result"}\n', 'utf8')

    const now = new Date('2026-03-30T12:00:00.000Z')
    const oldTimestamp = new Date(now.getTime() - ((DEFAULT_TRANSCRIPT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000))
    const freshTimestamp = new Date(now.getTime() - (5 * 24 * 60 * 60 * 1000))
    await utimes(oldTranscriptPath, oldTimestamp, oldTimestamp)
    await utimes(freshTranscriptPath, freshTimestamp, freshTimestamp)

    const result = await pruneCommanderTranscriptArchives(commanderId, {
      basePath: tmpDir,
      now,
    })

    expect(result.deletedTranscriptIds).toEqual(['old-session'])
    await expect(readdir(sessionsDir)).resolves.toEqual(['fresh-session.jsonl'])
  })

  it('parses transcript search results as full-message hits', async () => {
    const commanderId = 'cmdr-search'
    const sessionsDir = join(tmpDir, commanderId, 'sessions')
    const indexRoot = join(tmpDir, 'index')
    await mkdir(sessionsDir, { recursive: true })
    await mkdir(join(indexRoot, commanderId), { recursive: true })
    await writeFile(join(sessionsDir, '2026-03-28.jsonl'), '{"type":"result"}\n', 'utf8')
    await writeFile(join(indexRoot, commanderId, 'manifest.json'), '{}\n', 'utf8')

    const hits = await searchCommanderTranscriptIndex('rotation reset', 3, {
      commanderId,
      basePath: tmpDir,
      indexRoot,
      scriptRunner: async (args) => {
        expect(args).toContain('search')
        expect(args).toContain('--top-k')
        expect(args).toContain('3')
        return JSON.stringify([
          {
            score: 0.9142,
            text: 'Reset rebuilt the commander identity and system prompt from disk.',
            source_file: join(sessionsDir, '2026-03-28.jsonl'),
            transcript_id: '2026-03-28',
            timestamp: '2026-03-28T11:20:00.000Z',
            role: 'assistant',
            turn_number: 142,
            message_index: 1,
          },
        ])
      },
    })

    expect(hits).toEqual([
      {
        score: 0.9142,
        text: 'Reset rebuilt the commander identity and system prompt from disk.',
        sourceFile: join(sessionsDir, '2026-03-28.jsonl'),
        transcriptId: '2026-03-28',
        timestamp: '2026-03-28T11:20:00.000Z',
        role: 'assistant',
        turnNumber: 142,
        messageIndex: 1,
      },
    ])
  })

  it('skips transcript search when no transcript index exists yet', async () => {
    const commanderId = 'cmdr-no-index'
    const sessionsDir = join(tmpDir, commanderId, 'sessions')
    const scriptRunner = vi.fn(async () => '[]')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(join(sessionsDir, '2026-03-28.jsonl'), '{"type":"result"}\n', 'utf8')

    const hits = await searchCommanderTranscriptIndex('rotation reset', 3, {
      commanderId,
      basePath: tmpDir,
      scriptRunner,
    })

    expect(hits).toEqual([])
    expect(scriptRunner).not.toHaveBeenCalled()
  })

  it('still runs transcript sync when no transcript files remain so stale rows can be removed', async () => {
    const commanderId = 'cmdr-empty-sync'
    const indexRoot = join(tmpDir, 'index')
    const scriptRunner = vi.fn(async (args: string[]) => {
      expect(args).toContain('sync')
      return JSON.stringify({
        indexed_files: 0,
        indexed_messages: 0,
        deleted_sources: 1,
      })
    })
    await mkdir(join(indexRoot, commanderId), { recursive: true })
    await writeFile(join(indexRoot, commanderId, 'manifest.json'), '{}\n', 'utf8')

    const result = await syncCommanderTranscriptIndex({
      commanderId,
      basePath: tmpDir,
      indexRoot,
      scriptRunner,
    })

    expect(result).toEqual({
      indexedFiles: 0,
      indexedMessages: 0,
      deletedSources: 1,
    })
    expect(scriptRunner).toHaveBeenCalledTimes(1)
  })

  it('skips transcript sync when no transcript files or index state exist', async () => {
    const scriptRunner = vi.fn(async () => JSON.stringify({
      indexed_files: 0,
      indexed_messages: 0,
      deleted_sources: 0,
    }))

    const result = await syncCommanderTranscriptIndex({
      commanderId: 'cmdr-empty-no-index',
      basePath: tmpDir,
      scriptRunner,
    })

    expect(result).toEqual({
      indexedFiles: 0,
      indexedMessages: 0,
      deletedSources: 0,
    })
    expect(scriptRunner).not.toHaveBeenCalled()
  })

  it('syncs before any pruning on the first maintenance run', async () => {
    const calls: string[] = []

    await maintainCommanderTranscriptIndex('cmdr-first-run', {
      basePath: tmpDir,
      indexExists: async () => false,
      syncIndex: async () => {
        calls.push('sync')
        return {
          indexedFiles: 1,
          indexedMessages: 2,
          deletedSources: 0,
        }
      },
      pruneArchives: async () => {
        calls.push('prune')
        return { deletedTranscriptIds: ['old-session'] }
      },
    })

    expect(calls).toEqual(['sync'])
  })

  it('prunes before syncing once the transcript index already exists', async () => {
    const calls: string[] = []

    await maintainCommanderTranscriptIndex('cmdr-steady-state', {
      basePath: tmpDir,
      indexExists: async () => true,
      syncIndex: async () => {
        calls.push('sync')
        return {
          indexedFiles: 1,
          indexedMessages: 2,
          deletedSources: 1,
        }
      },
      pruneArchives: async () => {
        calls.push('prune')
        return { deletedTranscriptIds: ['old-session'] }
      },
    })

    expect(calls).toEqual(['prune', 'sync'])
  })
})
