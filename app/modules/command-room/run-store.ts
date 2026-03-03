import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_RUN_STORE_PATH = 'data/command-room/runs.json'

export type WorkflowRunStatus = 'running' | 'complete' | 'failed' | 'timeout'

export interface WorkflowRun {
  id: string
  cronTaskId: string
  startedAt: string
  completedAt: string | null
  status: WorkflowRunStatus
  report: string
  costUsd: number
  sessionId: string
}

interface PersistedRunCollection {
  runs: WorkflowRun[]
}

export interface CreateWorkflowRunInput {
  cronTaskId: string
  startedAt: string
  completedAt: string | null
  status: WorkflowRunStatus
  report: string
  costUsd: number
  sessionId: string
}

export interface UpdateWorkflowRunInput {
  completedAt?: string | null
  status?: WorkflowRunStatus
  report?: string
  costUsd?: number
  sessionId?: string
}

const WORKFLOW_STATUSES = new Set<WorkflowRunStatus>([
  'running',
  'complete',
  'failed',
  'timeout',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return typeof value === 'string' && WORKFLOW_STATUSES.has(value as WorkflowRunStatus)
}

function isWorkflowRun(value: unknown): value is WorkflowRun {
  if (!isObject(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.cronTaskId === 'string' &&
    typeof value.startedAt === 'string' &&
    (value.completedAt === null || typeof value.completedAt === 'string') &&
    isWorkflowRunStatus(value.status) &&
    typeof value.report === 'string' &&
    typeof value.costUsd === 'number' &&
    Number.isFinite(value.costUsd) &&
    value.costUsd >= 0 &&
    typeof value.sessionId === 'string'
  )
}

function parseRunCollection(raw: unknown): PersistedRunCollection {
  if (Array.isArray(raw)) {
    return {
      runs: raw.filter((entry): entry is WorkflowRun => isWorkflowRun(entry)),
    }
  }

  if (isObject(raw) && Array.isArray(raw.runs)) {
    return {
      runs: raw.runs.filter((entry): entry is WorkflowRun => isWorkflowRun(entry)),
    }
  }

  return { runs: [] }
}

export function defaultCommandRoomRunStorePath(): string {
  return path.resolve(process.cwd(), DEFAULT_RUN_STORE_PATH)
}

export class CommandRoomRunStore {
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly filePath: string

  constructor(filePath: string = defaultCommandRoomRunStorePath()) {
    this.filePath = path.resolve(filePath)
  }

  async listRuns(): Promise<WorkflowRun[]> {
    await this.mutationQueue
    const runs = await this.readRuns()
    return this.sortRuns(runs)
  }

  async listRunsForTask(cronTaskId: string): Promise<WorkflowRun[]> {
    const runs = await this.listRuns()
    return runs.filter((run) => run.cronTaskId === cronTaskId)
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const runs = await this.listRuns()
    return runs.find((run) => run.id === runId) ?? null
  }

  async createRun(input: CreateWorkflowRunInput): Promise<WorkflowRun> {
    const nextRun: WorkflowRun = {
      id: randomUUID(),
      cronTaskId: input.cronTaskId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status: input.status,
      report: input.report,
      costUsd: Math.max(0, input.costUsd),
      sessionId: input.sessionId,
    }

    return this.withMutationLock(async () => {
      const runs = await this.readRuns()
      runs.push(nextRun)
      await this.writeRuns(runs)
      return nextRun
    })
  }

  async updateRun(runId: string, update: UpdateWorkflowRunInput): Promise<WorkflowRun | null> {
    return this.withMutationLock(async () => {
      const runs = await this.readRuns()
      const index = runs.findIndex((run) => run.id === runId)
      if (index < 0) {
        return null
      }

      const current = runs[index]
      if (!current) {
        return null
      }

      const nextRun: WorkflowRun = { ...current }
      if (update.completedAt !== undefined) {
        nextRun.completedAt = update.completedAt
      }
      if (update.status && isWorkflowRunStatus(update.status)) {
        nextRun.status = update.status
      }
      if (typeof update.report === 'string') {
        nextRun.report = update.report
      }
      if (typeof update.costUsd === 'number' && Number.isFinite(update.costUsd)) {
        nextRun.costUsd = Math.max(0, update.costUsd)
      }
      if (typeof update.sessionId === 'string') {
        nextRun.sessionId = update.sessionId
      }

      runs[index] = nextRun
      await this.writeRuns(runs)
      return nextRun
    })
  }

  async deleteRunsForTask(cronTaskId: string): Promise<void> {
    await this.withMutationLock(async () => {
      const runs = await this.readRuns()
      const nextRuns = runs.filter((run) => run.cronTaskId !== cronTaskId)
      if (nextRuns.length === runs.length) {
        return
      }
      await this.writeRuns(nextRuns)
    })
  }

  async listLatestRunsByTaskIds(taskIds: readonly string[]): Promise<Map<string, WorkflowRun>> {
    if (taskIds.length === 0) {
      return new Map()
    }

    const taskIdSet = new Set(taskIds)
    const runs = await this.listRuns()
    const latest = new Map<string, WorkflowRun>()
    for (const run of runs) {
      if (!taskIdSet.has(run.cronTaskId)) {
        continue
      }
      if (!latest.has(run.cronTaskId)) {
        latest.set(run.cronTaskId, run)
      }
    }
    return latest
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private sortRuns(runs: WorkflowRun[]): WorkflowRun[] {
    return [...runs].sort(
      (left, right) => right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id),
    )
  }

  private async readRuns(): Promise<WorkflowRun[]> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (
        isObject(error) &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code === 'ENOENT'
      ) {
        return []
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents) as unknown
    } catch {
      return []
    }

    return parseRunCollection(parsed).runs
  }

  private async writeRuns(runs: WorkflowRun[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const payload: PersistedRunCollection = { runs }
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
}
