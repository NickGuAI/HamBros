import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  normalizeHeartbeatState,
  type CommanderHeartbeatState,
} from './heartbeat.js'

const DEFAULT_SESSION_STORE_PATH = 'data/commanders/sessions.json'

const COMMANDER_STATES = new Set<CommanderSession['state']>([
  'idle',
  'running',
  'paused',
  'stopped',
])

export interface CommanderTaskSource {
  owner: string
  repo: string
  label?: string
  project?: string
}

export interface CommanderCurrentTask {
  issueNumber: number
  issueUrl: string
  startedAt: string
}

export interface CommanderSession {
  id: string
  host: string
  pid: number | null
  state: 'idle' | 'running' | 'paused' | 'stopped'
  created: string
  heartbeat: CommanderHeartbeatState
  lastHeartbeat: string | null
  taskSource: CommanderTaskSource
  currentTask: CommanderCurrentTask | null
  completedTasks: number
  totalCostUsd: number
}

interface PersistedCommanderSessions {
  sessions: CommanderSession[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseTaskSource(raw: unknown): CommanderTaskSource | null {
  if (!isObject(raw)) {
    return null
  }

  const owner = typeof raw.owner === 'string' ? raw.owner.trim() : ''
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : ''
  if (!owner || !repo) {
    return null
  }

  const label = typeof raw.label === 'string' && raw.label.trim().length > 0
    ? raw.label.trim()
    : undefined
  const project = typeof raw.project === 'string' && raw.project.trim().length > 0
    ? raw.project.trim()
    : undefined

  return { owner, repo, label, project }
}

function parseCurrentTask(raw: unknown): CommanderCurrentTask | null {
  if (raw === null || raw === undefined) {
    return null
  }

  if (!isObject(raw)) {
    return null
  }

  const issueNumber = raw.issueNumber
  const issueUrl = raw.issueUrl
  const startedAt = raw.startedAt
  if (
    typeof issueNumber !== 'number' ||
    !Number.isInteger(issueNumber) ||
    issueNumber < 1 ||
    typeof issueUrl !== 'string' ||
    issueUrl.trim().length === 0 ||
    typeof startedAt !== 'string' ||
    startedAt.trim().length === 0
  ) {
    return null
  }

  return {
    issueNumber,
    issueUrl: issueUrl.trim(),
    startedAt: startedAt.trim(),
  }
}

function parseCommanderSession(raw: unknown): CommanderSession | null {
  if (!isObject(raw)) {
    return null
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  const created = typeof raw.created === 'string' ? raw.created.trim() : ''
  const taskSource = parseTaskSource(raw.taskSource)
  const currentTask = parseCurrentTask(raw.currentTask)

  const state = raw.state
  if (
    !id ||
    !host ||
    !created ||
    !taskSource ||
    !COMMANDER_STATES.has(state as CommanderSession['state'])
  ) {
    return null
  }

  const pid = typeof raw.pid === 'number' && Number.isFinite(raw.pid)
    ? Math.max(0, Math.floor(raw.pid))
    : null
  const completedTasks = typeof raw.completedTasks === 'number' && Number.isFinite(raw.completedTasks)
    ? Math.max(0, Math.floor(raw.completedTasks))
    : 0
  const totalCostUsd = typeof raw.totalCostUsd === 'number' && Number.isFinite(raw.totalCostUsd)
    ? Math.max(0, raw.totalCostUsd)
    : 0
  const lastHeartbeat = typeof raw.lastHeartbeat === 'string'
    ? raw.lastHeartbeat.trim()
    : null
  const heartbeat = normalizeHeartbeatState(raw.heartbeat, lastHeartbeat || null)
  const synchronizedLastHeartbeat = heartbeat.lastSentAt ?? null

  return {
    id,
    host,
    pid,
    state: state as CommanderSession['state'],
    created,
    heartbeat,
    lastHeartbeat: synchronizedLastHeartbeat,
    taskSource,
    currentTask,
    completedTasks,
    totalCostUsd,
  }
}

function parsePersistedCommanderSessions(raw: unknown): PersistedCommanderSessions {
  if (Array.isArray(raw)) {
    return {
      sessions: raw
        .map((entry) => parseCommanderSession(entry))
        .filter((entry): entry is CommanderSession => entry !== null),
    }
  }

  if (isObject(raw) && Array.isArray(raw.sessions)) {
    return {
      sessions: raw.sessions
        .map((entry) => parseCommanderSession(entry))
        .filter((entry): entry is CommanderSession => entry !== null),
    }
  }

  return { sessions: [] }
}

function cloneSession(session: CommanderSession): CommanderSession {
  return {
    ...session,
    heartbeat: { ...session.heartbeat },
    taskSource: { ...session.taskSource },
    currentTask: session.currentTask ? { ...session.currentTask } : null,
  }
}

export function defaultCommanderSessionStorePath(): string {
  return path.resolve(process.cwd(), DEFAULT_SESSION_STORE_PATH)
}

export class CommanderSessionStore {
  private readonly filePath: string
  private sessionsById: Map<string, CommanderSession> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string = defaultCommanderSessionStorePath()) {
    this.filePath = path.resolve(filePath)
  }

  async list(): Promise<CommanderSession[]> {
    await this.ensureLoaded()
    return [...this.sessions().values()]
      .map((session) => cloneSession(session))
      .sort((left, right) => left.created.localeCompare(right.created))
  }

  async get(id: string): Promise<CommanderSession | null> {
    await this.ensureLoaded()
    const found = this.sessions().get(id)
    return found ? cloneSession(found) : null
  }

  async create(session: CommanderSession): Promise<CommanderSession> {
    return this.withMutationLock(async () => {
      await this.ensureLoaded()
      const sessions = this.sessions()
      if (sessions.has(session.id)) {
        throw new Error(`Commander session "${session.id}" already exists`)
      }

      sessions.set(session.id, cloneSession(session))
      await this.writeToDisk()
      return cloneSession(session)
    })
  }

  async updateLastHeartbeat(
    id: string,
    timestamp: string,
  ): Promise<CommanderSession | null> {
    return this.update(id, (current) => ({
      ...current,
      lastHeartbeat: timestamp,
      heartbeat: {
        ...current.heartbeat,
        lastSentAt: timestamp,
      },
    }))
  }

  async update(
    id: string,
    mutate: (current: CommanderSession) => CommanderSession,
  ): Promise<CommanderSession | null> {
    return this.withMutationLock(async () => {
      await this.ensureLoaded()
      const sessions = this.sessions()
      const existing = sessions.get(id)
      if (!existing) {
        return null
      }

      const next = mutate(cloneSession(existing))
      sessions.set(id, cloneSession(next))
      await this.writeToDisk()
      return cloneSession(next)
    })
  }

  async delete(id: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      await this.ensureLoaded()
      const sessions = this.sessions()
      if (!sessions.has(id)) {
        return false
      }
      sessions.delete(id)
      await this.writeToDisk()
      return true
    })
  }

  private sessions(): Map<string, CommanderSession> {
    if (!this.sessionsById) {
      throw new Error('CommanderSessionStore not loaded')
    }
    return this.sessionsById
  }

  private async ensureLoaded(): Promise<void> {
    if (this.sessionsById) {
      return
    }

    const persisted = await this.readFromDisk()
    this.sessionsById = new Map(
      persisted.sessions.map((session) => [session.id, cloneSession(session)]),
    )
  }

  private async readFromDisk(): Promise<PersistedCommanderSessions> {
    let rawFile: string
    try {
      rawFile = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { sessions: [] }
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawFile) as unknown
    } catch {
      return { sessions: [] }
    }

    return parsePersistedCommanderSessions(parsed)
  }

  private async writeToDisk(): Promise<void> {
    const sessions = [...this.sessions().values()]
      .map((session) => cloneSession(session))
      .sort((left, right) => left.created.localeCompare(right.created))

    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(
      this.filePath,
      JSON.stringify({ sessions } satisfies PersistedCommanderSessions, null, 2),
      'utf8',
    )
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
