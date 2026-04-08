import { execFile } from 'node:child_process'
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveCommanderPaths } from './paths.js'

const TRANSCRIPT_INDEX_SCRIPT_PATH = path.resolve(
  process.cwd(),
  'scripts',
  'commander-transcript-index.py',
)
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 30
const DEFAULT_TRANSCRIPT_INDEX_ROOT = path.join(homedir(), '.ginsights', 'transcript-index')

const execFileAsync = promisify(execFile)

export interface TranscriptSearchHit {
  score: number
  text: string
  sourceFile: string
  transcriptId: string
  timestamp: string | null
  role: 'user' | 'assistant'
  turnNumber: number
  messageIndex: number
}

export interface TranscriptIndexSyncResult {
  indexedFiles: number
  indexedMessages: number
  deletedSources: number
}

export interface TranscriptArchiveSweepResult {
  deletedTranscriptIds: string[]
}

interface TranscriptIndexScriptOptions {
  commanderId: string
  basePath?: string
  indexRoot?: string
  scriptRunner?: TranscriptIndexScriptRunner
}

type TranscriptIndexScriptRunner = (
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>

type TranscriptIndexExistsChecker = (options: {
  commanderId: string
  indexRoot?: string
}) => Promise<boolean>

type TranscriptIndexSyncRunner = (
  options: TranscriptIndexScriptOptions,
) => Promise<TranscriptIndexSyncResult>

type TranscriptArchivePruneRunner = (
  commanderId: string,
  options: {
    basePath?: string
    now?: Date
    retentionDays?: number
  },
) => Promise<TranscriptArchiveSweepResult>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null
}

async function defaultScriptRunner(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync(
    'python3',
    [TRANSCRIPT_INDEX_SCRIPT_PATH, ...args],
    {
      env,
      maxBuffer: 50 * 1024 * 1024,
    },
  )
  return result.stdout
}

function resolveIndexRoot(indexRoot?: string): string {
  return indexRoot ? path.resolve(indexRoot) : DEFAULT_TRANSCRIPT_INDEX_ROOT
}

export async function commanderTranscriptIndexExists(
  options: {
    commanderId: string
    indexRoot?: string
  },
): Promise<boolean> {
  const manifestPath = path.join(
    resolveIndexRoot(options.indexRoot),
    options.commanderId,
    'manifest.json',
  )

  try {
    const manifestStats = await stat(manifestPath)
    return manifestStats.isFile() && manifestStats.size > 0
  } catch {
    return false
  }
}

async function listCommanderTranscriptFiles(commanderId: string, basePath?: string): Promise<string[]> {
  const sessionsRoot = path.join(resolveCommanderPaths(commanderId, basePath).commanderRoot, 'sessions')
  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(sessionsRoot, entry.name))
  } catch {
    return []
  }
}

async function runTranscriptIndexScript(
  args: string[],
  options: TranscriptIndexScriptOptions,
): Promise<string> {
  const apiKey = parseTrimmedString(process.env.GEMINI_API_KEY)
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not found in environment')
  }

  const runner = options.scriptRunner ?? defaultScriptRunner
  return runner(args, {
    ...process.env,
    GEMINI_API_KEY: apiKey,
  })
}

function parseTranscriptSearchResults(stdout: string): TranscriptSearchHit[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch (error) {
    throw new Error(
      `commander-transcript-index.py returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error('commander-transcript-index.py returned an unexpected payload')
  }

  return parsed.flatMap((entry) => {
    if (!isObject(entry)) {
      return []
    }

    const score = typeof entry.score === 'number' ? entry.score : null
    const text = typeof entry.text === 'string' ? entry.text : null
    const sourceFile = typeof entry.source_file === 'string' ? entry.source_file : null
    const transcriptId = typeof entry.transcript_id === 'string' ? entry.transcript_id : null
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null
    const role = entry.role === 'user' || entry.role === 'assistant' ? entry.role : null
    const turnNumber = typeof entry.turn_number === 'number' ? entry.turn_number : null
    const messageIndex = typeof entry.message_index === 'number' ? entry.message_index : 1

    if (
      score === null ||
      text === null ||
      sourceFile === null ||
      transcriptId === null ||
      role === null ||
      turnNumber === null
    ) {
      return []
    }

    return [{
      score,
      text,
      sourceFile,
      transcriptId,
      timestamp,
      role,
      turnNumber,
      messageIndex,
    }]
  })
}

function parseTranscriptSyncResult(stdout: string): TranscriptIndexSyncResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch (error) {
    throw new Error(
      `commander-transcript-index.py returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!isObject(parsed)) {
    throw new Error('commander-transcript-index.py returned an unexpected payload')
  }

  return {
    indexedFiles: typeof parsed.indexed_files === 'number' ? parsed.indexed_files : 0,
    indexedMessages: typeof parsed.indexed_messages === 'number' ? parsed.indexed_messages : 0,
    deletedSources: typeof parsed.deleted_sources === 'number' ? parsed.deleted_sources : 0,
  }
}

export async function searchCommanderTranscriptIndex(
  query: string,
  topK: number,
  options: TranscriptIndexScriptOptions,
): Promise<TranscriptSearchHit[]> {
  const [transcriptFiles, hasIndex] = await Promise.all([
    listCommanderTranscriptFiles(options.commanderId, options.basePath),
    commanderTranscriptIndexExists({
      commanderId: options.commanderId,
      indexRoot: options.indexRoot,
    }),
  ])

  if (transcriptFiles.length === 0 || !hasIndex) {
    return []
  }

  const commanderDataDir = resolveCommanderPaths(options.commanderId, options.basePath).dataDir
  const stdout = await runTranscriptIndexScript(
    [
      'search',
      '--commander-id',
      options.commanderId,
      '--commander-data-dir',
      commanderDataDir,
      '--index-root',
      resolveIndexRoot(options.indexRoot),
      '--top-k',
      String(Math.max(1, topK)),
      '--query',
      query,
      '--json',
    ],
    options,
  )

  return parseTranscriptSearchResults(stdout)
}

export async function syncCommanderTranscriptIndex(
  options: TranscriptIndexScriptOptions,
): Promise<TranscriptIndexSyncResult> {
  const [transcriptFiles, hasIndex] = await Promise.all([
    listCommanderTranscriptFiles(options.commanderId, options.basePath),
    commanderTranscriptIndexExists({
      commanderId: options.commanderId,
      indexRoot: options.indexRoot,
    }),
  ])

  if (transcriptFiles.length === 0 && !hasIndex) {
    return {
      indexedFiles: 0,
      indexedMessages: 0,
      deletedSources: 0,
    }
  }

  const commanderDataDir = resolveCommanderPaths(options.commanderId, options.basePath).dataDir
  const stdout = await runTranscriptIndexScript(
    [
      'sync',
      '--commander-id',
      options.commanderId,
      '--commander-data-dir',
      commanderDataDir,
      '--index-root',
      resolveIndexRoot(options.indexRoot),
      '--json',
    ],
    options,
  )

  return parseTranscriptSyncResult(stdout)
}

export async function maintainCommanderTranscriptIndex(
  commanderId: string,
  options: {
    basePath?: string
    indexRoot?: string
    now?: Date
    retentionDays?: number
    indexExists?: TranscriptIndexExistsChecker
    syncIndex?: TranscriptIndexSyncRunner
    pruneArchives?: TranscriptArchivePruneRunner
  } = {},
): Promise<void> {
  const indexExists = options.indexExists ?? commanderTranscriptIndexExists
  const syncIndex = options.syncIndex ?? syncCommanderTranscriptIndex
  const pruneArchives = options.pruneArchives ?? pruneCommanderTranscriptArchives

  const hasExistingIndex = await indexExists({
    commanderId,
    indexRoot: options.indexRoot,
  })

  if (!hasExistingIndex) {
    await syncIndex({
      commanderId,
      basePath: options.basePath,
      indexRoot: options.indexRoot,
    })
    return
  }

  await pruneArchives(commanderId, {
    basePath: options.basePath,
    now: options.now,
    retentionDays: options.retentionDays,
  })

  await syncIndex({
    commanderId,
    basePath: options.basePath,
    indexRoot: options.indexRoot,
  })
}

export async function pruneCommanderTranscriptArchives(
  commanderId: string,
  options: {
    basePath?: string
    now?: Date
    retentionDays?: number
  } = {},
): Promise<TranscriptArchiveSweepResult> {
  const sessionsRoot = path.join(resolveCommanderPaths(commanderId, options.basePath).commanderRoot, 'sessions')
  const retentionDays = Math.max(1, options.retentionDays ?? DEFAULT_TRANSCRIPT_RETENTION_DAYS)
  const nowMs = (options.now ?? new Date()).getTime()
  const cutoffMs = nowMs - (retentionDays * 24 * 60 * 60 * 1000)

  let entries: import('node:fs').Dirent<string>[]
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true, encoding: 'utf-8' })
  } catch {
    return { deletedTranscriptIds: [] }
  }

  const deletedTranscriptIds: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue
    }

    const transcriptPath = path.join(sessionsRoot, entry.name)
    let fileStat
    try {
      fileStat = await stat(transcriptPath)
    } catch {
      continue
    }

    if (fileStat.mtimeMs >= cutoffMs) {
      continue
    }

    await rm(transcriptPath, { force: true })
    deletedTranscriptIds.push(entry.name.replace(/\.jsonl$/i, ''))
  }

  deletedTranscriptIds.sort((left, right) => left.localeCompare(right))
  return { deletedTranscriptIds }
}
