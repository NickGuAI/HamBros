import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TelemetryHub } from '../hub'
import { LocalTelemetryScanner } from '../local-scanner'
import { TelemetryJsonlStore } from '../store'

const testDirectories: string[] = []
const FIXED_NOW = new Date('2026-02-21T12:00:00.000Z')

interface ScannerHarness {
  scanner: LocalTelemetryScanner
  hub: TelemetryHub
  claudeDir: string
  codexDir: string
  summaryCachePath: string
}

async function createScannerHarness(now: Date = FIXED_NOW): Promise<ScannerHarness> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hammurabi-telemetry-local-scanner-'))
  testDirectories.push(directory)

  const telemetryDir = path.join(directory, 'data')
  const claudeDir = path.join(directory, 'claude')
  const codexDir = path.join(directory, 'codex')
  await mkdir(telemetryDir, { recursive: true })
  await mkdir(claudeDir, { recursive: true })
  await mkdir(codexDir, { recursive: true })

  const store = new TelemetryJsonlStore(path.join(telemetryDir, 'events.jsonl'))
  const hub = new TelemetryHub({ store, now: () => now })
  const scanner = new LocalTelemetryScanner({
    hub,
    now: () => now,
    claudeProjectsDir: claudeDir,
    codexSessionsDir: codexDir,
    stateFilePath: path.join(telemetryDir, 'scan-state.json'),
    summaryCachePath: path.join(telemetryDir, 'cost-summary-cache.json'),
  })

  return {
    scanner,
    hub,
    claudeDir,
    codexDir,
    summaryCachePath: path.join(telemetryDir, 'cost-summary-cache.json'),
  }
}

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('LocalTelemetryScanner', () => {
  it('ingests Claude local sessions and deduplicates repeated assistant message usage', async () => {
    const { scanner, hub, claudeDir, summaryCachePath } = await createScannerHarness()

    const claudeFilePath = path.join(claudeDir, 'claude-session-1.jsonl')
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'claude-session-1',
        timestamp: '2026-02-20T10:00:00.000Z',
        message: {
          id: 'msg-1',
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'claude-session-1',
        timestamp: '2026-02-20T10:00:01.000Z',
        message: {
          id: 'msg-1',
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
          },
        },
      }),
      JSON.stringify({
        type: 'progress',
        sessionId: 'claude-session-1',
        timestamp: '2026-02-20T10:05:00.000Z',
        data: {
          message: {
            type: 'assistant',
            timestamp: '2026-02-20T10:05:00.000Z',
            message: {
              id: 'msg-2',
              role: 'assistant',
              model: 'claude-haiku-4-5-20251001',
              usage: {
                input_tokens: 200,
                output_tokens: 10,
                cache_read_input_tokens: 40,
                cache_creation_input_tokens: 0,
              },
            },
          },
        },
      }),
    ]
    await writeFile(claudeFilePath, `${lines.join('\n')}\n`, 'utf8')

    const scanResult = await scanner.scan()
    expect(scanResult).toMatchObject({
      scanned: 1,
      ingested: 2,
    })

    const detail = hub.getSessionDetail('claude-session-1')
    expect(detail).not.toBeNull()
    expect(detail?.session.agentName).toBe('claude-local')
    expect(detail?.session.callCount).toBe(2)
    expect(detail?.session.inputTokens).toBe(370)
    expect(detail?.session.outputTokens).toBe(60)
    expect(detail?.session.totalCost).toBeCloseTo(0.0020257, 6)

    const summaryCacheRaw = await readFile(summaryCachePath, 'utf8')
    const summaryCache = JSON.parse(summaryCacheRaw) as {
      daily: Record<string, number>
    }
    expect(summaryCache.daily['2026-02-20']).toBeCloseTo(0.0020257, 6)
  })

  it('converts Codex cumulative token counts into per-event deltas', async () => {
    const { scanner, hub, codexDir } = await createScannerHarness()
    const codexDayDir = path.join(codexDir, '2026', '02', '21')
    await mkdir(codexDayDir, { recursive: true })

    const codexFilePath = path.join(
      codexDayDir,
      'rollout-2026-02-21T10-00-00-11111111-2222-3333-4444-555555555555.jsonl',
    )
    const lines = [
      JSON.stringify({
        timestamp: '2026-02-21T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-session-1' },
      }),
      JSON.stringify({
        timestamp: '2026-02-21T10:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.2' },
      }),
      JSON.stringify({
        timestamp: '2026-02-21T10:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: null },
      }),
      JSON.stringify({
        timestamp: '2026-02-21T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 50,
              reasoning_output_tokens: 10,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-02-21T10:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 160,
              cached_input_tokens: 30,
              output_tokens: 90,
              reasoning_output_tokens: 30,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-02-21T10:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 160,
              cached_input_tokens: 30,
              output_tokens: 90,
              reasoning_output_tokens: 30,
            },
          },
        },
      }),
    ]
    await writeFile(codexFilePath, `${lines.join('\n')}\n`, 'utf8')

    const scanResult = await scanner.scan()
    expect(scanResult).toMatchObject({
      scanned: 1,
      ingested: 2,
    })

    const detail = hub.getSessionDetail('codex-session-1')
    expect(detail).not.toBeNull()
    expect(detail?.session.agentName).toBe('codex-local')
    expect(detail?.session.callCount).toBe(2)
    expect(detail?.session.inputTokens).toBe(160)
    expect(detail?.session.outputTokens).toBe(120)
    expect(detail?.session.totalCost).toBeCloseTo(0.001913, 6)
  })

  it('skips unchanged files and ingests only newly appended usage', async () => {
    const { scanner, hub, codexDir } = await createScannerHarness()
    const codexDayDir = path.join(codexDir, '2026', '02', '22')
    await mkdir(codexDayDir, { recursive: true })

    const codexFilePath = path.join(
      codexDayDir,
      'rollout-2026-02-22T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl',
    )
    await writeFile(
      codexFilePath,
      [
        JSON.stringify({
          timestamp: '2026-02-22T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'codex-session-2' },
        }),
        JSON.stringify({
          timestamp: '2026-02-22T10:00:01.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.2' },
        }),
        JSON.stringify({
          timestamp: '2026-02-22T10:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 50,
                reasoning_output_tokens: 10,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-02-22T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 160,
                cached_input_tokens: 30,
                output_tokens: 90,
                reasoning_output_tokens: 30,
              },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const firstScan = await scanner.scan()
    expect(firstScan.ingested).toBe(2)

    const secondScan = await scanner.scan()
    expect(secondScan).toMatchObject({
      scanned: 1,
      ingested: 0,
      skipped: 1,
    })

    await appendFile(
      codexFilePath,
      `${JSON.stringify({
        timestamp: '2026-02-22T10:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 200,
              cached_input_tokens: 40,
              output_tokens: 120,
              reasoning_output_tokens: 40,
            },
          },
        },
      })}\n`,
      'utf8',
    )

    const thirdScan = await scanner.scan()
    expect(thirdScan.ingested).toBe(1)

    const detail = hub.getSessionDetail('codex-session-2')
    expect(detail?.session.callCount).toBe(3)
  })

  it('does not ingest local records when a non-local session already exists', async () => {
    const { scanner, hub, codexDir } = await createScannerHarness()
    await hub.ingest({
      sessionId: 'otel-session-1',
      agentName: 'codex-cli',
      model: 'gpt-5.2',
      provider: 'openai',
      inputTokens: 50,
      outputTokens: 25,
      cost: 0.5,
      durationMs: 1000,
      currentTask: 'From OTEL',
      timestamp: new Date('2026-02-23T10:00:00.000Z'),
    })

    const codexDayDir = path.join(codexDir, '2026', '02', '23')
    await mkdir(codexDayDir, { recursive: true })
    await writeFile(
      path.join(
        codexDayDir,
        'rollout-2026-02-23T10-00-00-ffffffff-1111-2222-3333-444444444444.jsonl',
      ),
      [
        JSON.stringify({
          timestamp: '2026-02-23T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'otel-session-1' },
        }),
        JSON.stringify({
          timestamp: '2026-02-23T10:00:01.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.2' },
        }),
        JSON.stringify({
          timestamp: '2026-02-23T10:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 50,
                reasoning_output_tokens: 10,
              },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const scanResult = await scanner.scan()
    expect(scanResult.ingested).toBe(0)

    const detail = hub.getSessionDetail('otel-session-1')
    expect(detail?.session.agentName).toBe('codex-cli')
    expect(detail?.session.callCount).toBe(1)
  })
})
