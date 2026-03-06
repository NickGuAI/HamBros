import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TelemetryJsonlStore, type TelemetryStoreEntry } from '../store'

const testDirectories: string[] = []

async function createTempStoreFilePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hammurabi-telemetry-store-'))
  testDirectories.push(directory)
  return path.join(directory, 'events.jsonl')
}

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('TelemetryJsonlStore', () => {
  it('returns an empty list when the JSONL file is missing', async () => {
    const filePath = await createTempStoreFilePath()
    const store = new TelemetryJsonlStore(filePath)

    const entries = await store.load()

    expect(entries).toEqual([])
  })

  it('appends and reloads telemetry entries', async () => {
    const filePath = await createTempStoreFilePath()
    const store = new TelemetryJsonlStore(filePath)

    await store.append({
      type: 'ingest',
      recordedAt: '2026-02-10T10:00:00.000Z',
      payload: {
        id: 'call-1',
        sessionId: 'session-1',
        agentName: 'codex',
        model: 'o3',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.0123,
        durationMs: 1200,
        currentTask: 'Testing',
        timestamp: '2026-02-10T10:00:00.000Z',
      },
    })

    await store.append({
      type: 'heartbeat',
      recordedAt: '2026-02-10T10:00:05.000Z',
      payload: {
        sessionId: 'session-1',
        currentTask: 'Still testing',
        completed: false,
        timestamp: '2026-02-10T10:00:05.000Z',
      },
    })

    const entries = await store.load()

    expect(entries).toHaveLength(2)
    expect(entries[0]?.type).toBe('ingest')
    expect(entries[1]?.type).toBe('heartbeat')
  })

  it('ignores malformed JSONL rows and keeps valid entries', async () => {
    const filePath = await createTempStoreFilePath()
    await writeFile(
      filePath,
      [
        '{"type":"ingest","recordedAt":"2026-02-10T10:00:00.000Z","payload":{"id":"call-1","sessionId":"s1","agentName":"codex","model":"o3","provider":"openai","inputTokens":1,"outputTokens":2,"cost":0.1,"durationMs":1000,"currentTask":"run","timestamp":"2026-02-10T10:00:00.000Z"}}',
        'this-is-not-json',
        '{"type":"heartbeat","recordedAt":"2026-02-10T10:01:00.000Z","payload":{"sessionId":"s1","completed":true,"timestamp":"2026-02-10T10:01:00.000Z"}}',
      ].join('\n'),
      'utf8',
    )

    const store = new TelemetryJsonlStore(filePath)
    const entries = await store.load()

    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.type)).toEqual(['ingest', 'heartbeat'])
  })
})

describe('TelemetryJsonlStore.compact()', () => {
  it('removes entries older than retentionDays', async () => {
    const filePath = await createTempStoreFilePath()
    const store = new TelemetryJsonlStore(filePath)

    const old: TelemetryStoreEntry = {
      type: 'ingest',
      recordedAt: '2026-01-01T00:00:00.000Z',
      payload: {
        id: 'old-1',
        sessionId: 's1',
        agentName: 'codex',
        model: 'o3',
        provider: 'openai',
        inputTokens: 1,
        outputTokens: 1,
        cost: 0.01,
        durationMs: 100,
        currentTask: 'old task',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    }
    const recent: TelemetryStoreEntry = {
      type: 'ingest',
      recordedAt: '2026-02-28T00:00:00.000Z',
      payload: {
        id: 'new-1',
        sessionId: 's2',
        agentName: 'claude',
        model: 'claude-sonnet',
        provider: 'anthropic',
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.05,
        durationMs: 200,
        currentTask: 'new task',
        timestamp: '2026-02-28T00:00:00.000Z',
      },
    }

    await store.append(old)
    await store.append(recent)

    // Use a fixed "now" by patching: compact keeps entries where recordedAt >= cutoff.
    // cutoff = now - 14d. We manually compact with retentionDays=14 and rely on
    // the real Date.now() being 2026-03-04 (current date), so 2026-01-01 is ~62 days old.
    await store.compact(14)

    const kept = await store.load()
    expect(kept).toHaveLength(1)
    expect(kept[0]?.payload).toMatchObject({ id: 'new-1' })
  })

  it('no-ops gracefully when the file does not exist', async () => {
    const filePath = await createTempStoreFilePath()
    const store = new TelemetryJsonlStore(filePath)
    await expect(store.compact(14)).resolves.toBeUndefined()
  })

  it('keeps all entries when all are within retention window', async () => {
    const filePath = await createTempStoreFilePath()
    const store = new TelemetryJsonlStore(filePath)

    // Use today's date minus 1 day so everything is within 14-day window
    const yesterday = new Date()
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const recentISO = yesterday.toISOString()

    await store.append({
      type: 'heartbeat',
      recordedAt: recentISO,
      payload: { sessionId: 'x', completed: false, timestamp: recentISO },
    })

    await store.compact(14)

    const kept = await store.load()
    expect(kept).toHaveLength(1)
  })
})

describe('TelemetryJsonlStore.stream()', () => {
  it('yields no entries when the JSONL file is missing', async () => {
    const filePath = await createTempStoreFilePath()
    const store = new TelemetryJsonlStore(filePath)

    const entries: TelemetryStoreEntry[] = []
    for await (const entry of store.stream()) {
      entries.push(entry)
    }

    expect(entries).toEqual([])
  })

  it('streams entries matching load() output', async () => {
    const filePath = await createTempStoreFilePath()
    const store = new TelemetryJsonlStore(filePath)

    await store.append({
      type: 'ingest',
      recordedAt: '2026-02-10T10:00:00.000Z',
      payload: {
        id: 'call-1',
        sessionId: 'session-1',
        agentName: 'codex',
        model: 'o3',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.0123,
        durationMs: 1200,
        currentTask: 'Testing',
        timestamp: '2026-02-10T10:00:00.000Z',
      },
    })

    await store.append({
      type: 'heartbeat',
      recordedAt: '2026-02-10T10:00:05.000Z',
      payload: {
        sessionId: 'session-1',
        currentTask: 'Still testing',
        completed: false,
        timestamp: '2026-02-10T10:00:05.000Z',
      },
    })

    const streamed: TelemetryStoreEntry[] = []
    for await (const entry of store.stream()) {
      streamed.push(entry)
    }

    const loaded = await store.load()

    expect(streamed).toEqual(loaded)
  })

  it('skips malformed lines when streaming', async () => {
    const filePath = await createTempStoreFilePath()
    await writeFile(
      filePath,
      [
        '{"type":"ingest","recordedAt":"2026-02-10T10:00:00.000Z","payload":{"id":"call-1","sessionId":"s1","agentName":"codex","model":"o3","provider":"openai","inputTokens":1,"outputTokens":2,"cost":0.1,"durationMs":1000,"currentTask":"run","timestamp":"2026-02-10T10:00:00.000Z"}}',
        'this-is-not-json',
        '{"type":"heartbeat","recordedAt":"2026-02-10T10:01:00.000Z","payload":{"sessionId":"s1","completed":true,"timestamp":"2026-02-10T10:01:00.000Z"}}',
      ].join('\n'),
      'utf8',
    )

    const store = new TelemetryJsonlStore(filePath)
    const entries: TelemetryStoreEntry[] = []
    for await (const entry of store.stream()) {
      entries.push(entry)
    }

    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.type)).toEqual(['ingest', 'heartbeat'])
  })
})
