import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

export interface TranscriptEvent {
  type: string
  [key: string]: unknown
}

export type TranscriptMeta = Record<string, unknown>

const SESSION_NAME_PATTERN = /^[\w-]+$/
const DEFAULT_TRANSCRIPT_ROOT = path.resolve(process.cwd(), 'data', 'agents', 'sessions')

let transcriptRoot = DEFAULT_TRANSCRIPT_ROOT
const writeQueues = new Map<string, Promise<void>>()

function assertSessionName(sessionName: string): string {
  const trimmed = sessionName.trim()
  if (!SESSION_NAME_PATTERN.test(trimmed)) {
    throw new Error(`Invalid session name: ${sessionName}`)
  }
  return trimmed
}

function resolveSessionDir(sessionName: string): string {
  return path.join(transcriptRoot, assertSessionName(sessionName))
}

function resolveTranscriptPath(sessionName: string): string {
  return path.join(resolveSessionDir(sessionName), 'transcript.v1.jsonl')
}

function resolveMetaPath(sessionName: string): string {
  return path.join(resolveSessionDir(sessionName), 'meta.json')
}

async function queueWrite(filePath: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve()
  let currentResolve!: () => void
  let currentReject!: (error: unknown) => void
  const current = new Promise<void>((resolve, reject) => {
    currentResolve = resolve
    currentReject = reject
  })

  writeQueues.set(filePath, current)

  void previous
    .catch(() => undefined)
    .then(async () => {
      await write()
      currentResolve()
    })
    .catch((error) => {
      currentReject(error)
    })
    .finally(() => {
      if (writeQueues.get(filePath) === current) {
        writeQueues.delete(filePath)
      }
    })

  return current
}

function parseJsonlLines(raw: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        events.push(parsed as TranscriptEvent)
      }
    } catch {
      continue
    }
  }
  return events
}

function splitCompletedTurns(events: TranscriptEvent[]): { completedTurns: TranscriptEvent[][]; trailingPartial: TranscriptEvent[] } {
  const completedTurns: TranscriptEvent[][] = []
  let currentTurn: TranscriptEvent[] = []

  for (const event of events) {
    currentTurn.push(event)
    if (event.type === 'result') {
      completedTurns.push(currentTurn)
      currentTurn = []
    }
  }

  return { completedTurns, trailingPartial: currentTurn }
}

export function setTranscriptStoreRoot(rootDir: string): void {
  transcriptRoot = path.resolve(rootDir)
}

export function resetTranscriptStoreRoot(): void {
  transcriptRoot = DEFAULT_TRANSCRIPT_ROOT
}

export function getTranscriptStoreRoot(): string {
  return transcriptRoot
}

export async function appendTranscriptEvent(sessionName: string, event: TranscriptEvent): Promise<void> {
  const transcriptPath = resolveTranscriptPath(sessionName)
  const line = `${JSON.stringify(event)}\n`

  await queueWrite(transcriptPath, async () => {
    await mkdir(path.dirname(transcriptPath), { recursive: true })
    await appendFile(transcriptPath, line, 'utf8')
  })
}

export async function readTranscriptTail(sessionName: string, maxTurns: number): Promise<TranscriptEvent[]> {
  const transcriptPath = resolveTranscriptPath(sessionName)
  let raw = ''
  try {
    raw = await readFile(transcriptPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }

  const events = parseJsonlLines(raw)
  const { completedTurns, trailingPartial } = splitCompletedTurns(events)
  const turnsToKeep = Math.max(0, Math.floor(maxTurns))
  const selectedTurns = turnsToKeep === 0 ? [] : completedTurns.slice(-turnsToKeep)
  return [...selectedTurns.flat(), ...trailingPartial]
}

export async function writeSessionMeta(sessionName: string, meta: TranscriptMeta): Promise<void> {
  const metaPath = resolveMetaPath(sessionName)
  const payload = `${JSON.stringify(meta, null, 2)}\n`

  await queueWrite(metaPath, async () => {
    await mkdir(path.dirname(metaPath), { recursive: true })
    await writeFile(metaPath, payload, 'utf8')
  })
}

export async function readSessionMeta(sessionName: string): Promise<TranscriptMeta | null> {
  const metaPath = resolveMetaPath(sessionName)
  let raw = ''
  try {
    raw = await readFile(metaPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as TranscriptMeta
  } catch {
    return null
  }
}
