import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { NormalizedCall } from './normalizer.js'

export interface TelemetryIngestRecord {
  id: string
  sessionId: string
  agentName: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cost: number
  durationMs: number
  currentTask: string
  timestamp: string
}

export interface TelemetryHeartbeatRecord {
  sessionId: string
  agentName?: string
  model?: string
  currentTask?: string
  completed: boolean
  timestamp: string
}

export interface OtelLogPayload {
  signal: 'logs'
  resource: Record<string, string | number | boolean>
  eventName: string
  attributes: Record<string, string | number | boolean>
  normalized: NormalizedCall
}

export interface OtelMetricPayload {
  signal: 'metrics'
  resource: Record<string, string | number | boolean>
  metricName: string
  attributes: Record<string, string | number | boolean>
  value: number
  normalized: NormalizedCall
}

export type TelemetryStoreEntry =
  | {
      type: 'ingest'
      recordedAt: string
      payload: TelemetryIngestRecord
    }
  | {
      type: 'heartbeat'
      recordedAt: string
      payload: TelemetryHeartbeatRecord
    }
  | {
      type: 'otel_log'
      recordedAt: string
      payload: OtelLogPayload
    }
  | {
      type: 'otel_metric'
      recordedAt: string
      payload: OtelMetricPayload
    }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTelemetryIngestRecord(value: unknown): value is TelemetryIngestRecord {
  if (!isObject(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.model === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.cost === 'number' &&
    typeof value.durationMs === 'number' &&
    typeof value.currentTask === 'string' &&
    typeof value.timestamp === 'string'
  )
}

function isTelemetryHeartbeatRecord(value: unknown): value is TelemetryHeartbeatRecord {
  if (!isObject(value)) {
    return false
  }

  return (
    typeof value.sessionId === 'string' &&
    typeof value.completed === 'boolean' &&
    typeof value.timestamp === 'string' &&
    (value.agentName === undefined || typeof value.agentName === 'string') &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.currentTask === undefined || typeof value.currentTask === 'string')
  )
}

function isNormalizedCall(value: unknown): value is NormalizedCall {
  if (!isObject(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.model === 'string' &&
    typeof value.signal === 'string'
  )
}

function isOtelLogPayload(value: unknown): value is OtelLogPayload {
  if (!isObject(value)) return false
  return (
    value.signal === 'logs' &&
    typeof value.eventName === 'string' &&
    isObject(value.resource) &&
    isObject(value.attributes) &&
    isNormalizedCall(value.normalized)
  )
}

function isOtelMetricPayload(value: unknown): value is OtelMetricPayload {
  if (!isObject(value)) return false
  return (
    value.signal === 'metrics' &&
    typeof value.metricName === 'string' &&
    typeof value.value === 'number' &&
    isObject(value.resource) &&
    isObject(value.attributes) &&
    isNormalizedCall(value.normalized)
  )
}

function parseEntry(line: string): TelemetryStoreEntry | null {
  if (!line.trim()) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return null
  }

  if (!isObject(parsed) || typeof parsed.type !== 'string' || !('payload' in parsed)) {
    return null
  }

  const recordedAt =
    typeof parsed.recordedAt === 'string' ? parsed.recordedAt : new Date(0).toISOString()

  if (parsed.type === 'ingest' && isTelemetryIngestRecord(parsed.payload)) {
    return {
      type: 'ingest',
      recordedAt,
      payload: parsed.payload,
    }
  }

  if (parsed.type === 'heartbeat' && isTelemetryHeartbeatRecord(parsed.payload)) {
    return {
      type: 'heartbeat',
      recordedAt,
      payload: parsed.payload,
    }
  }

  if (parsed.type === 'otel_log' && isOtelLogPayload(parsed.payload)) {
    return {
      type: 'otel_log',
      recordedAt,
      payload: parsed.payload,
    }
  }

  if (parsed.type === 'otel_metric' && isOtelMetricPayload(parsed.payload)) {
    return {
      type: 'otel_metric',
      recordedAt,
      payload: parsed.payload,
    }
  }

  return null
}

export class TelemetryJsonlStore {
  constructor(private readonly filePath: string) {}

  async append(entry: TelemetryStoreEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  /** Max file size to load into memory. V8 string limit ~512MB; use 100MB to avoid RangeError. */
  private static readonly MAX_LOAD_BYTES = 100 * 1024 * 1024

  async load(): Promise<TelemetryStoreEntry[]> {
    try {
      const st = await stat(this.filePath)
      if (st.size > TelemetryJsonlStore.MAX_LOAD_BYTES) {
        console.warn(
          `[TelemetryJsonlStore] Skipping load: ${this.filePath} is ${(st.size / 1024 / 1024).toFixed(1)}MB (max ${TelemetryJsonlStore.MAX_LOAD_BYTES / 1024 / 1024}MB). Consider rotating the file.`,
        )
        return []
      }
    } catch (err) {
      if (isObject(err) && 'code' in err && err.code === 'ENOENT') {
        return []
      }
      throw err
    }

    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isObject(error) && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      throw error
    }

    return contents
      .split('\n')
      .map((line) => parseEntry(line))
      .filter((entry): entry is TelemetryStoreEntry => entry !== null)
  }

  async *stream(): AsyncGenerator<TelemetryStoreEntry> {
    try {
      await stat(this.filePath)
    } catch (err) {
      if (isObject(err) && 'code' in err && err.code === 'ENOENT') {
        return
      }
      throw err
    }

    const fileStream = createReadStream(this.filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        const entry = parseEntry(line)
        if (entry) {
          yield entry
        }
      }
    } finally {
      rl.close()
      fileStream.destroy()
    }
  }

  /**
   * Remove all entries older than `retentionDays` days via an atomic tmp-file swap.
   * No-ops if the file does not exist.
   */
  async compact(retentionDays: number): Promise<void> {
    try {
      await stat(this.filePath)
    } catch (err) {
      if (isObject(err) && 'code' in err && err.code === 'ENOENT') return
      throw err
    }

    const cutoff = new Date()
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)
    const cutoffISO = cutoff.toISOString()

    const tmpPath = `${this.filePath}.tmp`
    const writeStream = createWriteStream(tmpPath, { encoding: 'utf8' })
    const fileStream = createReadStream(this.filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity })

    try {
      for await (const line of rl) {
        if (!line.trim()) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (isObject(parsed) && typeof parsed.recordedAt === 'string' && parsed.recordedAt >= cutoffISO) {
          await new Promise<void>((resolve, reject) => {
            writeStream.write(`${line}\n`, (err) => (err ? reject(err) : resolve()))
          })
        }
      }
    } finally {
      rl.close()
      fileStream.destroy()
      await new Promise<void>((resolve) => writeStream.end(resolve))
    }

    try {
      await rename(tmpPath, this.filePath)
    } catch (err) {
      // Clean up tmp on rename failure
      await unlink(tmpPath).catch(() => undefined)
      throw err
    }
  }
}

export function defaultTelemetryStorePath(): string {
  return path.resolve(process.cwd(), 'data/telemetry/events.jsonl')
}
