import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { resolveHerdDataDir } from '../modules/data-dir.js'
import { migrateLegacyPersistedSessionSources } from './legacy-session-source-migration.js'
import { parsePersistedStreamSessionEntry } from '../modules/agents/session/state.js'
import { writeSqlitePersistedSessionsState } from '../modules/agents/session/sqlite-runtime-store.js'
import type { PersistedSessionsState, PersistedStreamSession } from '../modules/agents/types.js'
import { getProvider, parseProviderId } from '../modules/agents/providers/registry.js'
import {
  applyHerdSqliteSchema,
  hasCurrentHerdSqliteSchema,
  HERD_SQLITE_SCHEMA_VERSION,
} from '../server/db/schema.js'
import {
  openHerdSqliteDatabase,
  resolveHerdDbPath,
} from '../server/db/connection.js'

export interface SqliteMigrationOptions {
  sourceRoot: string
  dbPath: string
  backup: boolean
  replace?: boolean
  now?: () => Date
  logger?: Pick<Console, 'log' | 'warn'>
}

export interface SqliteMigrationError {
  sourcePath: string
  errorType: string
  errorMessage: string
  sessionName?: string
}

export interface SqliteMigrationStats {
  sourceSessions: number
  importedSessions: number
  activeSessions: number
  pausedSessions: number
  skippedSessions: number
  errors: SqliteMigrationError[]
  backupPath: string | null
  reportPath: string | null
}

export interface SqliteMigrationResult {
  runId: string
  dbPath: string
  sourceRoot: string
  stats: SqliteMigrationStats
}

export class SqliteMigrationRefusedError extends Error {
  constructor(
    message: string,
    readonly result: SqliteMigrationResult,
  ) {
    super(message)
    this.name = 'SqliteMigrationRefusedError'
  }
}

function createInitialStats(): SqliteMigrationStats {
  return {
    sourceSessions: 0,
    importedSessions: 0,
    activeSessions: 0,
    pausedSessions: 0,
    skippedSessions: 0,
    errors: [],
    backupPath: null,
    reportPath: null,
  }
}

function asMigrationRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function inferProviderIdForLegacyContext(record: Record<string, unknown>): string {
  const agentType = parseProviderId(record.agentType)
  if (agentType) {
    return agentType
  }
  if (parseOptionalString(record.codexThreadId)) {
    return 'codex'
  }
  if (parseOptionalString(record.geminiSessionId)) {
    return 'gemini'
  }
  if (parseOptionalString(record.opencodeSessionId)) {
    return 'opencode'
  }
  return 'claude'
}

function migrateLegacyProviderContextRecord(rawEntry: unknown): unknown {
  const record = asMigrationRecord(rawEntry)
  if (!record) {
    return rawEntry
  }

  const rawProviderContext = asMigrationRecord(record.providerContext)
  if (parseProviderId(rawProviderContext?.providerId)) {
    return rawEntry
  }

  const providerId = inferProviderIdForLegacyContext(record)
  const context: Record<string, unknown> = { providerId }

  if (providerId === 'codex') {
    const threadId = parseOptionalString(record.codexThreadId)
      ?? parseOptionalString(rawProviderContext?.threadId)
    if (threadId) {
      context.threadId = threadId
    }
  } else if (providerId === 'gemini') {
    const sessionId = parseOptionalString(record.geminiSessionId)
      ?? parseOptionalString(rawProviderContext?.sessionId)
    if (sessionId) {
      context.sessionId = sessionId
    }
  } else if (providerId === 'opencode') {
    const sessionId = parseOptionalString(record.opencodeSessionId)
      ?? parseOptionalString(rawProviderContext?.sessionId)
    if (sessionId) {
      context.sessionId = sessionId
    }
  } else {
    const sessionId = parseOptionalString(record.claudeSessionId)
      ?? parseOptionalString(rawProviderContext?.sessionId)
    if (sessionId) {
      context.sessionId = sessionId
    }
  }

  const next = {
    ...record,
    agentType: providerId,
    providerContext: context,
  }
  delete next.claudeSessionId
  delete next.codexThreadId
  delete next.geminiSessionId
  delete next.opencodeSessionId
  return next
}

async function removeSqliteFiles(dbPath: string): Promise<void> {
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
  ])
}

async function backupLegacySessionState(
  sessionsPath: string,
  runId: string,
  enabled: boolean,
): Promise<string | null> {
  if (!enabled || !existsSync(sessionsPath)) {
    return null
  }
  const backupPath = `${sessionsPath}.${runId}.bak`
  await copyFile(sessionsPath, backupPath)
  return backupPath
}

function isImportableRuntimeSession(
  entry: PersistedStreamSession,
  sourcePath: string,
  errors: SqliteMigrationError[],
): boolean {
  if (!entry.name || !entry.sessionType || !entry.creator) {
    errors.push({
      sourcePath,
      sessionName: entry.name,
      errorType: 'invalid_runtime_identity',
      errorMessage: 'Runtime session is missing name, sessionType, or creator.',
    })
    return false
  }
  if (!entry.providerContext || typeof entry.providerContext !== 'object') {
    errors.push({
      sourcePath,
      sessionName: entry.name,
      errorType: 'invalid_provider_resume',
      errorMessage: 'Runtime session is missing providerContext.',
    })
    return false
  }
  return true
}

function shouldImportPausedRuntimeSession(entry: PersistedStreamSession): boolean {
  if (entry.sessionState !== 'exited') {
    return true
  }
  return getProvider(entry.agentType)?.hasResumeIdentifier(entry) ?? false
}

async function readMigrationSourceSessions(
  sessionsPath: string,
  stats: SqliteMigrationStats,
): Promise<PersistedSessionsState> {
  let raw: string
  try {
    raw = await readFile(sessionsPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sessions: [] }
    }
    throw error
  }

  if (!raw.trim()) {
    stats.errors.push({
      sourcePath: sessionsPath,
      errorType: 'invalid_legacy_session_store',
      errorMessage: 'Legacy stream session store is empty.',
    })
    return { sessions: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    stats.errors.push({
      sourcePath: sessionsPath,
      errorType: 'invalid_legacy_session_store',
      errorMessage: `Legacy stream session store is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    })
    return { sessions: [] }
  }

  const payload = typeof parsed === 'object' && parsed !== null
    ? parsed as { sessions?: unknown }
    : null
  if (!Array.isArray(payload?.sessions)) {
    stats.errors.push({
      sourcePath: sessionsPath,
      errorType: 'invalid_legacy_session_store',
      errorMessage: 'Legacy stream session store must contain a sessions array.',
    })
    return { sessions: [] }
  }

  stats.sourceSessions = payload.sessions.length
  const sessions: PersistedStreamSession[] = []
  for (const [index, rawEntry] of payload.sessions.entries()) {
    const entry = parsePersistedStreamSessionEntry(migrateLegacyProviderContextRecord(rawEntry))
    if (!entry) {
      const record = typeof rawEntry === 'object' && rawEntry !== null
        ? rawEntry as { name?: unknown }
        : null
      const sessionName = typeof record?.name === 'string' && record.name.trim().length > 0
        ? record.name.trim()
        : undefined
      stats.skippedSessions += 1
      stats.errors.push({
        sourcePath: sessionsPath,
        ...(sessionName ? { sessionName } : {}),
        errorType: 'invalid_legacy_session_entry',
        errorMessage: `Legacy stream session entry at index ${index} could not be parsed.`,
      })
      continue
    }
    sessions.push(entry)
  }

  return { sessions }
}

function recordMissingProviderResume(
  entry: PersistedStreamSession,
  sourcePath: string,
  errors: SqliteMigrationError[],
): void {
  errors.push({
    sourcePath,
    sessionName: entry.name,
    errorType: 'missing_provider_resume',
    errorMessage: 'Exited runtime session is missing a provider resume identifier.',
  })
}

function hasAgentRuntimeSessionsTable(db: DatabaseSync): boolean {
  return Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runtime_sessions'",
  ).get())
}

function countExistingNonArchivedRuntimeSessions(db: DatabaseSync): number {
  if (!hasAgentRuntimeSessionsTable(db)) {
    return 0
  }
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM agent_runtime_sessions WHERE state <> 'archived'",
  ).get() as { count: number }
  return Number(row.count)
}

function assertCanWriteTargetWithoutReplace(dbPath: string): void {
  const db = openHerdSqliteDatabase(dbPath)
  try {
    if (hasAgentRuntimeSessionsTable(db) && !hasCurrentHerdSqliteSchema(db)) {
      throw new Error(
        `[sqlite] Refusing to migrate into existing SQLite database with stale schema: ${dbPath}. `
        + 'Rerun with --replace after confirming the target can be rebuilt.',
      )
    }

    const nonArchivedSessionCount = countExistingNonArchivedRuntimeSessions(db)
    if (nonArchivedSessionCount > 0) {
      throw new Error(
        `[sqlite] Refusing to migrate into existing SQLite database with `
        + `${nonArchivedSessionCount} non-archived runtime session(s): ${dbPath}. `
        + 'Rerun with --replace after confirming the target can be rebuilt.',
      )
    }
  } finally {
    db.close()
  }
}

async function writeMigrationReport(input: {
  runId: string
  dbPath: string
  sourceRoot: string
  schemaVersion: string
  stats: SqliteMigrationStats
}): Promise<string> {
  const reportPath = `${input.dbPath}.migration-${input.runId}.json`
  await writeFile(
    reportPath,
    JSON.stringify({
      runId: input.runId,
      dbPath: input.dbPath,
      sourceRoot: input.sourceRoot,
      schemaVersion: input.schemaVersion,
      stats: input.stats,
    }, null, 2),
    'utf8',
  )
  return reportPath
}

function markSchemaApplied(db: DatabaseSync, appliedAt: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  ).run(HERD_SQLITE_SCHEMA_VERSION, appliedAt)
}

async function refuseMigration(input: {
  message: string
  runId: string
  dbPath: string
  sourceRoot: string
  stats: SqliteMigrationStats
}): Promise<never> {
  input.stats.reportPath = await writeMigrationReport({
    runId: input.runId,
    dbPath: input.dbPath,
    sourceRoot: input.sourceRoot,
    schemaVersion: HERD_SQLITE_SCHEMA_VERSION,
    stats: input.stats,
  })
  throw new SqliteMigrationRefusedError(
    `${input.message} Report: ${input.stats.reportPath}`,
    {
      runId: input.runId,
      dbPath: input.dbPath,
      sourceRoot: input.sourceRoot,
      stats: input.stats,
    },
  )
}

export async function runSqliteMigration(options: SqliteMigrationOptions): Promise<SqliteMigrationResult> {
  const sourceRoot = path.resolve(options.sourceRoot)
  const dbPath = path.resolve(options.dbPath)
  const now = options.now ?? (() => new Date())
  const runId = randomUUID()
  const stats = createInitialStats()
  const sessionsPath = path.join(sourceRoot, 'agents', 'stream-sessions.json')

  await mkdir(path.dirname(dbPath), { recursive: true })
  if (!options.replace && existsSync(dbPath)) {
    assertCanWriteTargetWithoutReplace(dbPath)
  }

  stats.backupPath = await backupLegacySessionState(sessionsPath, runId, options.backup)
  const parsedSourceState = await readMigrationSourceSessions(sessionsPath, stats)
  const { state: sourceState } = await migrateLegacyPersistedSessionSources(sessionsPath, parsedSourceState)

  const importableSessions: PersistedStreamSession[] = []
  for (const entry of sourceState.sessions) {
    if (!isImportableRuntimeSession(entry, sessionsPath, stats.errors)) {
      stats.skippedSessions += 1
      continue
    }
    if (!shouldImportPausedRuntimeSession(entry)) {
      stats.skippedSessions += 1
      recordMissingProviderResume(entry, sessionsPath, stats.errors)
      continue
    }
    importableSessions.push(entry)
    stats.importedSessions += 1
    if (entry.sessionState === 'exited') {
      stats.pausedSessions += 1
    } else {
      stats.activeSessions += 1
    }
  }

  if (stats.skippedSessions > 0 || stats.errors.length > 0) {
    await refuseMigration({
      message: `[sqlite] Refusing to migrate because ${stats.skippedSessions} runtime session(s) could not be imported.`,
      runId,
      dbPath,
      sourceRoot,
      stats,
    })
  }

  let db: DatabaseSync | null = null
  try {
    if (options.replace) {
      await removeSqliteFiles(dbPath)
    }
    db = openHerdSqliteDatabase(dbPath)
    applyHerdSqliteSchema(db, now().toISOString(), { markApplied: false })
    writeSqlitePersistedSessionsState(db, { sessions: importableSessions }, now().toISOString())
    markSchemaApplied(db, now().toISOString())
  } finally {
    db?.close()
  }

  stats.reportPath = await writeMigrationReport({
    runId,
    dbPath,
    sourceRoot,
    schemaVersion: HERD_SQLITE_SCHEMA_VERSION,
    stats,
  })
  options.logger?.log?.(`[sqlite] Migrated ${stats.importedSessions} runtime session(s) to ${dbPath}`)

  return {
    runId,
    dbPath,
    sourceRoot,
    stats,
  }
}

export function defaultSqliteMigrationOptions(
  env: NodeJS.ProcessEnv = process.env,
): Pick<SqliteMigrationOptions, 'sourceRoot' | 'dbPath'> {
  return {
    sourceRoot: resolveHerdDataDir(env),
    dbPath: resolveHerdDbPath(env),
  }
}
