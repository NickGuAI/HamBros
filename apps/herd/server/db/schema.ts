import type { DatabaseSync } from 'node:sqlite'

export const HERD_SQLITE_SCHEMA_VERSION = '002_agent_runtime_session_payload'

const AGENT_RUNTIME_SESSION_V1_REQUIRED_COLUMNS = new Set([
  'name',
  'session_type',
  'creator_kind',
  'creator_id',
  'conversation_id',
  'spawned_by',
  'transport_type',
  'machine_id',
  'state',
  'provider',
  'provider_resume_json',
  'cwd',
  'created_at',
  'updated_at',
  'archived_at',
])

interface SqliteColumnContract {
  type: string
  notNull: boolean
  primaryKey?: boolean
  defaultValue?: string | null
}

const SCHEMA_MIGRATION_COLUMNS: Readonly<Record<string, SqliteColumnContract>> = {
  version: { type: 'TEXT', notNull: false, primaryKey: true, defaultValue: null },
  applied_at: { type: 'TEXT', notNull: true, defaultValue: null },
}

const AGENT_RUNTIME_SESSION_COLUMNS: Readonly<Record<string, SqliteColumnContract>> = {
  name: { type: 'TEXT', notNull: false, primaryKey: true, defaultValue: null },
  session_type: { type: 'TEXT', notNull: true, defaultValue: null },
  creator_kind: { type: 'TEXT', notNull: true, defaultValue: null },
  creator_id: { type: 'TEXT', notNull: false, defaultValue: null },
  conversation_id: { type: 'TEXT', notNull: false, defaultValue: null },
  spawned_by: { type: 'TEXT', notNull: false, defaultValue: null },
  transport_type: { type: 'TEXT', notNull: true, defaultValue: "'stream'" },
  machine_id: { type: 'TEXT', notNull: true, defaultValue: "'local'" },
  state: { type: 'TEXT', notNull: true, defaultValue: null },
  provider: { type: 'TEXT', notNull: true, defaultValue: null },
  provider_resume_json: { type: 'TEXT', notNull: true, defaultValue: null },
  runtime_state_json: { type: 'TEXT', notNull: true, defaultValue: "'{}'" },
  cwd: { type: 'TEXT', notNull: true, defaultValue: null },
  created_at: { type: 'TEXT', notNull: true, defaultValue: null },
  updated_at: { type: 'TEXT', notNull: true, defaultValue: null },
  archived_at: { type: 'TEXT', notNull: false, defaultValue: null },
}

interface SqliteIndexContract {
  columns: readonly string[]
  partial: boolean
  whereClause?: string
}

const AGENT_RUNTIME_SESSION_INDEXES: Readonly<Record<string, SqliteIndexContract>> = {
  agent_runtime_sessions_state_idx: {
    columns: ['state'],
    partial: false,
  },
  agent_runtime_sessions_owner_idx: {
    columns: ['session_type', 'creator_kind', 'creator_id'],
    partial: false,
  },
  agent_runtime_sessions_conversation_idx: {
    columns: ['conversation_id'],
    partial: true,
    whereClause: 'where conversation_id is not null',
  },
  agent_runtime_sessions_machine_idx: {
    columns: ['machine_id'],
    partial: false,
  },
}

const AGENT_RUNTIME_SESSION_CHECKS = [
  "check (session_type in ('commander', 'worker', 'cron', 'sentinel', 'automation'))",
  "check (creator_kind in ('human', 'commander', 'cron', 'sentinel', 'automation'))",
  "check (transport_type in ('stream', 'pty', 'external'))",
  "check (state in ('active', 'paused', 'archived'))",
] as const

export const HERD_AGENT_RUNTIME_SESSION_COLUMNS_SQL = `
  name TEXT PRIMARY KEY,
  session_type TEXT NOT NULL CHECK (session_type IN ('commander', 'worker', 'cron', 'sentinel', 'automation')),
  creator_kind TEXT NOT NULL CHECK (creator_kind IN ('human', 'commander', 'cron', 'sentinel', 'automation')),
  creator_id TEXT,
  conversation_id TEXT,
  spawned_by TEXT,
  transport_type TEXT NOT NULL DEFAULT 'stream' CHECK (transport_type IN ('stream', 'pty', 'external')),
  machine_id TEXT NOT NULL DEFAULT 'local',
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'archived')),
  provider TEXT NOT NULL,
  provider_resume_json TEXT NOT NULL,
  runtime_state_json TEXT NOT NULL DEFAULT '{}',
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
`

export const HERD_AGENT_RUNTIME_SESSION_INDEXES_SQL = `
CREATE INDEX agent_runtime_sessions_state_idx
  ON agent_runtime_sessions(state);

CREATE INDEX agent_runtime_sessions_owner_idx
  ON agent_runtime_sessions(session_type, creator_kind, creator_id);

CREATE INDEX agent_runtime_sessions_conversation_idx
  ON agent_runtime_sessions(conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX agent_runtime_sessions_machine_idx
  ON agent_runtime_sessions(machine_id);
`

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runtime_sessions (
${HERD_AGENT_RUNTIME_SESSION_COLUMNS_SQL}
);

${HERD_AGENT_RUNTIME_SESSION_INDEXES_SQL.replaceAll('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS ')}
`

interface SqliteColumnInfo {
  name: unknown
  type: unknown
  notnull: unknown
  dflt_value: unknown
  pk: unknown
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName)
  return Boolean(table)
}

function readTableColumns(db: DatabaseSync, tableName: string): SqliteColumnInfo[] {
  if (!tableExists(db, tableName)) {
    return []
  }

  return db.prepare(`PRAGMA table_info(${tableName})`).all() as unknown as SqliteColumnInfo[]
}

function hasTableColumnContracts(
  db: DatabaseSync,
  tableName: string,
  contracts: Readonly<Record<string, SqliteColumnContract>>,
): boolean {
  const columns = new Map(
    readTableColumns(db, tableName)
      .filter((row): row is SqliteColumnInfo & { name: string } => typeof row.name === 'string')
      .map((row) => [row.name, row]),
  )
  if (columns.size === 0) {
    return false
  }

  for (const [name, contract] of Object.entries(contracts)) {
    const column = columns.get(name)
    if (
      !column
      || String(column.type).toUpperCase() !== contract.type
      || (Number(column.notnull) === 1) !== contract.notNull
      || (Number(column.pk) === 1) !== (contract.primaryKey === true)
      || (contract.defaultValue !== undefined && column.dflt_value !== contract.defaultValue)
    ) {
      return false
    }
  }
  return true
}

function normalizeSql(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/\s+/gu, ' ').trim()
    : ''
}

function hasCurrentAgentRuntimeSessionChecks(db: DatabaseSync): boolean {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_runtime_sessions'",
  ).get() as { sql?: unknown } | undefined
  const sql = normalizeSql(row?.sql)
  return AGENT_RUNTIME_SESSION_CHECKS.every((check) => sql.includes(check))
}

function hasCurrentAgentRuntimeSessionIndexes(db: DatabaseSync): boolean {
  if (!tableExists(db, 'agent_runtime_sessions')) {
    return false
  }
  const indexRows = db.prepare('PRAGMA index_list(agent_runtime_sessions)').all() as unknown as Array<{
    name?: unknown
    unique?: unknown
    partial?: unknown
  }>
  const indexes = new Map(
    indexRows
      .filter((row): row is typeof row & { name: string } => typeof row.name === 'string')
      .map((row) => [row.name, row]),
  )

  for (const [name, contract] of Object.entries(AGENT_RUNTIME_SESSION_INDEXES)) {
    const index = indexes.get(name)
    if (
      !index
      || Number(index.unique) !== 0
      || (Number(index.partial) === 1) !== contract.partial
    ) {
      return false
    }
    const columns = (db.prepare(`PRAGMA index_info(${name})`).all() as unknown as Array<{ name?: unknown }>)
      .map((row) => row.name)
    if (
      columns.length !== contract.columns.length
      || columns.some((column, indexPosition) => column !== contract.columns[indexPosition])
    ) {
      return false
    }
    if (contract.whereClause) {
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).get(name) as { sql?: unknown } | undefined
      if (!normalizeSql(row?.sql).includes(contract.whereClause)) {
        return false
      }
    }
  }
  return true
}

export function hasCurrentHerdSqliteSchema(db: DatabaseSync): boolean {
  return hasTableColumnContracts(db, 'schema_migrations', SCHEMA_MIGRATION_COLUMNS)
    && hasTableColumnContracts(db, 'agent_runtime_sessions', AGENT_RUNTIME_SESSION_COLUMNS)
    && hasCurrentAgentRuntimeSessionChecks(db)
    && hasCurrentAgentRuntimeSessionIndexes(db)
}

export function hasHerdSqliteV1SchemaColumns(db: DatabaseSync): boolean {
  const columns = new Set(
    readTableColumns(db, 'agent_runtime_sessions')
      .map((row) => typeof row.name === 'string' ? row.name : null)
      .filter((name): name is string => name !== null),
  )
  for (const column of AGENT_RUNTIME_SESSION_V1_REQUIRED_COLUMNS) {
    if (!columns.has(column)) {
      return false
    }
  }
  return true
}

export function applyHerdSqliteSchema(
  db: DatabaseSync,
  appliedAt: string = new Date().toISOString(),
  options: { markApplied?: boolean } = {},
): void {
  db.exec(SCHEMA_SQL)
  if (options.markApplied === false) {
    return
  }
  db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  ).run(HERD_SQLITE_SCHEMA_VERSION, appliedAt)
}

export function readAppliedHerdSchemaVersions(db: DatabaseSync): string[] {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get()
  if (!table) {
    return []
  }

  const rows = db.prepare(
    'SELECT version FROM schema_migrations ORDER BY applied_at ASC, version ASC',
  ).all() as Array<{ version: unknown }>
  return rows
    .map((row) => typeof row.version === 'string' ? row.version : null)
    .filter((version): version is string => version !== null)
}

export function isHerdSqliteSchemaCurrent(db: DatabaseSync): boolean {
  return readAppliedHerdSchemaVersions(db).includes(HERD_SQLITE_SCHEMA_VERSION)
    && hasCurrentHerdSqliteSchema(db)
}
