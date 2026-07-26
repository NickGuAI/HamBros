import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import {
  HERD_AGENT_RUNTIME_SESSION_COLUMNS_SQL,
  HERD_AGENT_RUNTIME_SESSION_INDEXES_SQL,
  HERD_SQLITE_SCHEMA_VERSION,
  hasHerdSqliteV1SchemaColumns,
  hasCurrentHerdSqliteSchema,
  readAppliedHerdSchemaVersions,
} from './schema.js'

export const HERD_SQLITE_V1_SCHEMA_VERSION = '001_agent_runtime_sessions'

const nodeSqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

type BackupDatabase = (sourceDb: DatabaseSync, backupPath: string) => Promise<unknown>

export interface HerdSqliteMigrationResult {
  fromVersion: string
  toVersion: string
  backupPath: string
}

export interface HerdSqliteMigrationOptions {
  now?: Date
  backupId?: string
  backupDatabase?: BackupDatabase
}

function buildBackupTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '$1Z')
}

export function buildHerdSqliteBackupPath(
  dbPath: string,
  now = new Date(),
  backupId: string = randomUUID(),
): string {
  return `${dbPath}.bak.${buildBackupTimestamp(now)}.${backupId}`
}

export function canMigrateHerdSqliteV1(db: DatabaseSync): boolean {
  const versions = readAppliedHerdSchemaVersions(db)
  return versions.length === 1
    && versions[0] === HERD_SQLITE_V1_SCHEMA_VERSION
    && hasHerdSqliteV1SchemaColumns(db)
    && !hasCurrentHerdSqliteSchema(db)
}

export async function migrateHerdSqliteV1ToCurrent(
  db: DatabaseSync,
  dbPath: string,
  options: HerdSqliteMigrationOptions = {},
): Promise<HerdSqliteMigrationResult> {
  if (!canMigrateHerdSqliteV1(db)) {
    throw new Error(
      `SQLite schema is not the supported ${HERD_SQLITE_V1_SCHEMA_VERSION} migration source.`,
    )
  }

  const now = options.now ?? new Date()
  const backupPath = buildHerdSqliteBackupPath(dbPath, now, options.backupId)
  const backupDatabase = options.backupDatabase
    ?? ((sourceDb, targetPath) => nodeSqlite.backup(sourceDb, targetPath))

  // SQLite's backup API captures the main database and any committed WAL pages
  // consistently. Migration does not begin until this recoverable copy exists.
  await backupDatabase(db, backupPath)

  db.exec('BEGIN IMMEDIATE')
  try {
    // Rebuild instead of appending a single column. The v1 detector accepts
    // historical stores by their durable data columns, so reconstructing the
    // table is what guarantees every upgraded database receives the current
    // defaults, CHECK constraints, and indexes as one atomic schema contract.
    db.exec(`
      CREATE TABLE agent_runtime_sessions_v2 (
        ${HERD_AGENT_RUNTIME_SESSION_COLUMNS_SQL}
      );
      INSERT INTO agent_runtime_sessions_v2 (
        name,
        session_type,
        creator_kind,
        creator_id,
        conversation_id,
        spawned_by,
        transport_type,
        machine_id,
        state,
        provider,
        provider_resume_json,
        runtime_state_json,
        cwd,
        created_at,
        updated_at,
        archived_at
      )
      SELECT
        name,
        session_type,
        creator_kind,
        creator_id,
        conversation_id,
        spawned_by,
        transport_type,
        machine_id,
        state,
        provider,
        provider_resume_json,
        '{}',
        cwd,
        created_at,
        updated_at,
        archived_at
      FROM agent_runtime_sessions;
      DROP TABLE agent_runtime_sessions;
      ALTER TABLE agent_runtime_sessions_v2 RENAME TO agent_runtime_sessions;
      ${HERD_AGENT_RUNTIME_SESSION_INDEXES_SQL}
    `)
    db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    ).run(HERD_SQLITE_SCHEMA_VERSION, now.toISOString())
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }

  return {
    fromVersion: HERD_SQLITE_V1_SCHEMA_VERSION,
    toVersion: HERD_SQLITE_SCHEMA_VERSION,
    backupPath,
  }
}
