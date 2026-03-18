import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TelemetryHub } from '../hub'
import { TelemetryJsonlStore } from '../store'

const tempDirectories: string[] = []

async function createHub(now: () => Date): Promise<TelemetryHub> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hammurabi-telemetry-hub-'))
  tempDirectories.push(directory)
  const storeFilePath = path.join(directory, 'events.jsonl')
  const store = new TelemetryJsonlStore(storeFilePath)
  return new TelemetryHub({ store, now })
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('TelemetryHub summary token aggregates', () => {
  it('computes today/week/month token aggregates using UTC windows', async () => {
    const now = new Date('2026-02-10T10:00:00.000Z')
    const hub = await createHub(() => now)

    await hub.ingest({
      sessionId: 's-old',
      agentName: 'codex',
      model: 'o3',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      cost: 1,
      durationMs: 1000,
      currentTask: 'prior day',
      timestamp: new Date('2026-02-08T23:30:00.000Z'),
    })

    await hub.ingest({
      sessionId: 's-new',
      agentName: 'codex',
      model: 'o3',
      provider: 'openai',
      inputTokens: 200,
      outputTokens: 100,
      cost: 2,
      durationMs: 1000,
      currentTask: 'current week',
      timestamp: new Date('2026-02-10T09:00:00.000Z'),
    })

    const summary = await hub.getSummary(now)

    expect(summary.costToday).toBe(2)
    expect(summary.costWeek).toBe(2)
    expect(summary.costMonth).toBe(3)
    expect(summary.inputTokensToday).toBe(200)
    expect(summary.inputTokensWeek).toBe(200)
    expect(summary.inputTokensMonth).toBe(300)
    expect(summary.outputTokensToday).toBe(100)
    expect(summary.outputTokensWeek).toBe(100)
    expect(summary.outputTokensMonth).toBe(150)
    expect(summary.totalTokensToday).toBe(300)
    expect(summary.totalTokensWeek).toBe(300)
    expect(summary.totalTokensMonth).toBe(450)
  })
})
