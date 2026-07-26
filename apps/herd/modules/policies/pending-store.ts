import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveModuleDataDir } from '../data-dir.js'
import {
  appendJsonLine,
  isRecord,
  readJsonFile,
  readJsonLines,
  toJsonSafe,
  writeJsonFile,
} from './shared.js'
import type {
  ApprovalCoordinatorEvent,
  ApprovalHistoryEntry,
  ApprovalHistoryFilter,
  ApprovalResolutionOutcome,
  PendingApproval,
  PendingApprovalContext,
  PendingApprovalFilter,
  PendingApprovalRecord,
  PendingApprovalResolution,
  PendingApprovalSource,
  PendingApprovalStatus,
} from './types.js'

function resolveDefaultPendingSnapshotPath(): string {
  return path.join(resolveModuleDataDir('policies'), 'pending.json')
}

function resolveDefaultPendingAuditPath(): string {
  return path.join(resolveModuleDataDir('policies'), 'audit.jsonl')
}

export const DEFAULT_APPROVAL_HISTORY_VISIBILITY_CUTOFF_MS = 24 * 60 * 60 * 1000
export const DEFAULT_APPROVAL_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const DEFAULT_APPROVAL_AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

interface PersistedPendingSnapshot {
  schemaVersion: 1
  version: 1
  approvals: PendingApproval[]
}

interface PendingApprovalWaiter {
  resolve: (outcome: ApprovalResolutionOutcome) => void
}

interface WaitRegistration {
  kind: 'waiting'
  promise: Promise<ApprovalResolutionOutcome>
}

interface WaitResolved {
  kind: 'resolved'
  outcome: ApprovalResolutionOutcome
}

interface WaitMissing {
  kind: 'missing'
}

type WaitRegistrationResult = WaitRegistration | WaitResolved | WaitMissing

type ApprovalResolutionHandler = (
  approval: PendingApproval,
  decision: PendingApprovalResolution,
  options?: { timedOut?: boolean },
) => Promise<ApprovalResolutionOutcome | void> | ApprovalResolutionOutcome | void

interface EnqueueApprovalInput extends Omit<PendingApproval, 'id' | 'requestedAt'> {
  id?: string
  requestedAt?: string
}

interface EnqueueApprovalOptions {
  resolutionHandler?: ApprovalResolutionHandler
  timeoutMs?: number
  timeoutAction?: PendingApprovalResolution
}

interface ApprovalCoordinatorOptions {
  snapshotFilePath?: string
  auditFilePath?: string
  auditRetentionMs?: number
  now?: () => Date
}

function parsePositiveInteger(raw: string | undefined): number | null {
  if (!raw) {
    return null
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

function resolveDefaultApprovalAuditRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(env.HERD_APPROVAL_AUDIT_RETENTION_MS?.trim())
    ?? DEFAULT_APPROVAL_AUDIT_RETENTION_MS
}

function parseTimestampMs(timestamp: string): number | null {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizePendingApproval(entry: unknown): PendingApproval | null {
  if (!isRecord(entry)) {
    return null
  }

  const id = typeof entry.id === 'string' && entry.id.trim().length > 0 ? entry.id.trim() : null
  const actionId = typeof entry.actionId === 'string' && entry.actionId.trim().length > 0
    ? entry.actionId.trim()
    : null
  const actionLabel = typeof entry.actionLabel === 'string' && entry.actionLabel.trim().length > 0
    ? entry.actionLabel.trim()
    : null
  const toolName = typeof entry.toolName === 'string' && entry.toolName.trim().length > 0
    ? entry.toolName.trim()
    : null
  const requestedAt = typeof entry.requestedAt === 'string' && entry.requestedAt.trim().length > 0
    ? entry.requestedAt.trim()
    : null
  const source = entry.source === 'claude' || entry.source === 'codex' ? entry.source : null

  if (!id || !actionId || !actionLabel || !toolName || !requestedAt || !source || !isRecord(entry.context)) {
    return null
  }

  const details: Record<string, string> = {}
  if (isRecord(entry.context.details)) {
    for (const [key, value] of Object.entries(entry.context.details)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        details[key] = value.trim()
      }
    }
  }

  const approval: PendingApproval = {
    id,
    actionId,
    actionLabel,
    toolName,
    requestedAt,
    source,
    toolInput: toJsonSafe(entry.toolInput),
    context: {
      summary: typeof entry.context.summary === 'string' ? entry.context.summary : actionLabel,
      details,
    },
  }

  if (typeof entry.commanderId === 'string' && entry.commanderId.trim().length > 0) {
    approval.commanderId = entry.commanderId.trim()
  }
  if (typeof entry.sessionId === 'string' && entry.sessionId.trim().length > 0) {
    approval.sessionId = entry.sessionId.trim()
  }
  if (typeof entry.conversationId === 'string' && entry.conversationId.trim().length > 0) {
    approval.conversationId = entry.conversationId.trim()
  }
  if (typeof entry.currentSkillId === 'string' && entry.currentSkillId.trim().length > 0) {
    approval.currentSkillId = entry.currentSkillId.trim()
  }
  if (typeof entry.currentSkillName === 'string' && entry.currentSkillName.trim().length > 0) {
    approval.currentSkillName = entry.currentSkillName.trim()
  }
  if (typeof entry.context.preview === 'string' && entry.context.preview.trim().length > 0) {
    approval.context.preview = entry.context.preview.trim()
  }
  if (typeof entry.context.command === 'string' && entry.context.command.trim().length > 0) {
    approval.context.command = entry.context.command.trim()
  }
  if (isRecord(entry.context.primaryTarget)) {
    const label = typeof entry.context.primaryTarget.label === 'string'
      ? entry.context.primaryTarget.label.trim()
      : ''
    const value = typeof entry.context.primaryTarget.value === 'string'
      ? entry.context.primaryTarget.value.trim()
      : ''
    if (label && value) {
      approval.context.primaryTarget = { label, value }
    }
  }

  if (isRecord(entry.resolverRef)) {
    if (entry.resolverRef.kind === 'claude') {
      approval.resolverRef = {
        kind: 'claude',
        sessionId: typeof entry.resolverRef.sessionId === 'string'
          ? entry.resolverRef.sessionId.trim()
          : undefined,
      }
    } else if (
      entry.resolverRef.kind === 'codex' &&
      typeof entry.resolverRef.requestId === 'number' &&
      Number.isInteger(entry.resolverRef.requestId)
    ) {
      approval.resolverRef = {
        kind: 'codex',
        requestId: entry.resolverRef.requestId,
        threadId: typeof entry.resolverRef.threadId === 'string'
          ? entry.resolverRef.threadId.trim()
          : undefined,
        itemId: typeof entry.resolverRef.itemId === 'string'
          ? entry.resolverRef.itemId.trim()
          : undefined,
        turnId: typeof entry.resolverRef.turnId === 'string'
          ? entry.resolverRef.turnId.trim()
          : undefined,
      }
    }
  }

  if (typeof entry.expiresAt === 'string' && entry.expiresAt.trim().length > 0) {
    approval.expiresAt = entry.expiresAt.trim()
  }
  if (entry.timeoutAction === 'approve' || entry.timeoutAction === 'reject') {
    approval.timeoutAction = entry.timeoutAction
  }
  if (typeof entry.resolvedAt === 'string' && entry.resolvedAt.trim().length > 0) {
    approval.resolvedAt = entry.resolvedAt.trim()
  }
  if (typeof entry.deliveredAt === 'string' && entry.deliveredAt.trim().length > 0) {
    approval.deliveredAt = entry.deliveredAt.trim()
  }
  if (isRecord(entry.resolution)) {
    const decision = entry.resolution.decision === 'approve' || entry.resolution.decision === 'cancel'
      ? entry.resolution.decision
      : 'reject'
    approval.resolution = {
      decision,
      allowed: entry.resolution.allowed === true,
      reason: typeof entry.resolution.reason === 'string' ? entry.resolution.reason : undefined,
      timedOut: entry.resolution.timedOut === true,
    }
  }

  return approval
}

function normalizeSnapshot(raw: unknown): PersistedPendingSnapshot {
  if (!isRecord(raw)) {
    return { schemaVersion: 1, version: 1, approvals: [] }
  }

  const entries = Array.isArray(raw.approvals)
    ? raw.approvals
    : Array.isArray(raw.pending)
      ? raw.pending
      : []

  return {
    schemaVersion: 1,
    version: 1,
    approvals: entries
      .map(normalizePendingApproval)
      .filter((approval): approval is PendingApproval => approval !== null),
  }
}

export function isPersistedPendingSnapshotValid(raw: unknown): boolean {
  if (!isRecord(raw) || raw.version !== 1) {
    return false
  }
  const entries = Array.isArray(raw.approvals)
    ? raw.approvals
    : Array.isArray(raw.pending)
      ? raw.pending
      : null
  return entries !== null && entries.every((entry) => normalizePendingApproval(entry) !== null)
}

function defaultOutcome(
  decision: PendingApprovalResolution,
  options?: { timedOut?: boolean },
): ApprovalResolutionOutcome {
  return {
    decision,
    allowed: decision === 'approve',
    timedOut: options?.timedOut,
  }
}

function normalizeHistoryEntry(entry: unknown): ApprovalHistoryEntry | null {
  if (!isRecord(entry)) {
    return null
  }

  const timestamp = typeof entry.timestamp === 'string' && entry.timestamp.trim().length > 0
    ? entry.timestamp.trim()
    : null
  const type = entry.type === 'approval.enqueued' || entry.type === 'approval.resolved'
    ? entry.type
    : null
  const approvalId = typeof entry.approvalId === 'string' && entry.approvalId.trim().length > 0
    ? entry.approvalId.trim()
    : null

  if (!timestamp || !type || !approvalId) {
    return null
  }

  const normalized: ApprovalHistoryEntry = {
    timestamp,
    type,
    approvalId,
  }

  if (typeof entry.actionId === 'string' && entry.actionId.trim().length > 0) {
    normalized.actionId = entry.actionId.trim()
  }
  if (typeof entry.actionLabel === 'string' && entry.actionLabel.trim().length > 0) {
    normalized.actionLabel = entry.actionLabel.trim()
  }
  if (typeof entry.commanderId === 'string' && entry.commanderId.trim().length > 0) {
    normalized.commanderId = entry.commanderId.trim()
  }
  if (typeof entry.sessionId === 'string' && entry.sessionId.trim().length > 0) {
    normalized.sessionId = entry.sessionId.trim()
  }
  if (typeof entry.conversationId === 'string' && entry.conversationId.trim().length > 0) {
    normalized.conversationId = entry.conversationId.trim()
  }
  if (entry.source === 'claude' || entry.source === 'codex') {
    normalized.source = entry.source
  }
  if (typeof entry.toolName === 'string' && entry.toolName.trim().length > 0) {
    normalized.toolName = entry.toolName.trim()
  }
  if (typeof entry.summary === 'string' && entry.summary.trim().length > 0) {
    normalized.summary = entry.summary.trim()
  }
  if (entry.decision === 'approve' || entry.decision === 'reject' || entry.decision === 'cancel') {
    normalized.decision = entry.decision
  }
  if (typeof entry.delivered === 'boolean') {
    normalized.delivered = entry.delivered
  }
  if (isRecord(entry.outcome)) {
    const decision = entry.outcome.decision === 'approve' || entry.outcome.decision === 'cancel'
      ? entry.outcome.decision
      : 'reject'
    normalized.outcome = {
      decision,
      allowed: entry.outcome.allowed === true,
      reason: typeof entry.outcome.reason === 'string' ? entry.outcome.reason : undefined,
      timedOut: entry.outcome.timedOut === true,
    }
  }

  return normalized
}

export class ApprovalCoordinator {
  private static readonly MAX_RESOLVED_OUTCOMES = 256

  private readonly snapshotFilePath: string

  private readonly auditFilePath: string

  private readonly auditRetentionMs: number

  private readonly now: () => Date

  private readonly approvals = new Map<string, PendingApproval>()

  private readonly resolutionHandlers = new Map<string, ApprovalResolutionHandler>()

  private readonly waiters = new Map<string, PendingApprovalWaiter[]>()

  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>()

  private readonly resolvedOutcomes = new Map<string, ApprovalResolutionOutcome>()

  private readonly subscribers = new Set<(event: ApprovalCoordinatorEvent) => void>()

  private initialized = false

  private initPromise: Promise<void> | null = null

  private timeoutsInitialized = false

  private mutationQueue: Promise<void> = Promise.resolve()

  private lastAuditPrunedAtMs = 0

  constructor(options: ApprovalCoordinatorOptions = {}) {
    this.snapshotFilePath = options.snapshotFilePath
      ? path.resolve(options.snapshotFilePath)
      : resolveDefaultPendingSnapshotPath()
    this.auditFilePath = options.auditFilePath
      ? path.resolve(options.auditFilePath)
      : resolveDefaultPendingAuditPath()
    this.auditRetentionMs = typeof options.auditRetentionMs === 'number'
      && Number.isFinite(options.auditRetentionMs)
      && options.auditRetentionMs >= 0
      ? Math.floor(options.auditRetentionMs)
      : resolveDefaultApprovalAuditRetentionMs()
    this.now = options.now ?? (() => new Date())
  }

  subscribe(listener: (event: ApprovalCoordinatorEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  shutdown(): void {
    for (const timer of this.timeoutTimers.values()) {
      clearTimeout(timer)
    }
    this.timeoutTimers.clear()
  }

  async enqueue(
    input: EnqueueApprovalInput,
    options?: EnqueueApprovalOptions,
  ): Promise<PendingApproval> {
    return this.serializeMutation(async () => {
      await this.ensureLoaded()

      const requestedAt = input.requestedAt ?? this.now().toISOString()
      const approval: PendingApproval = {
        ...input,
        id: input.id?.trim() || randomUUID(),
        requestedAt,
        toolInput: toJsonSafe(input.toolInput),
      }
      if (!approval.resolution && options?.timeoutMs && options.timeoutMs > 0 && options.timeoutAction) {
        approval.expiresAt = new Date(this.now().getTime() + options.timeoutMs).toISOString()
        approval.timeoutAction = options.timeoutAction
      }

      this.approvals.set(approval.id, approval)
      if (options?.resolutionHandler) {
        this.resolutionHandlers.set(approval.id, options.resolutionHandler)
      }
      this.scheduleTimeout(approval)

      await this.persistSnapshot()
      await this.appendAudit({
        timestamp: requestedAt,
        type: 'approval.enqueued',
        approvalId: approval.id,
        actionId: approval.actionId,
        actionLabel: approval.actionLabel,
        commanderId: approval.commanderId,
        sessionId: approval.sessionId,
        conversationId: approval.conversationId,
        source: approval.source,
        toolName: approval.toolName,
        summary: approval.context.summary,
      })
      this.emit({
        type: 'enqueued',
        approval,
      })

      return approval
    })
  }

  async createPendingApproval(input: {
    source: PendingApprovalSource
    sessionId?: string
    sessionName?: string
    commanderId?: string
    commanderScopeId?: string
    conversationId?: string
    actionId: string
    actionLabel: string
    toolName: string
    toolInput?: unknown
    context: PendingApprovalContext
    currentSkillId?: string
    currentSkillName?: string
    skillId?: string
    resolverRef?: PendingApproval['resolverRef']
  }): Promise<PendingApprovalRecord> {
    return this.enqueue({
      source: input.source,
      sessionId: input.sessionId ?? input.sessionName,
      commanderId: input.commanderId ?? input.commanderScopeId,
      conversationId: input.conversationId,
      actionId: input.actionId,
      actionLabel: input.actionLabel,
      toolName: input.toolName,
      toolInput: input.toolInput,
      context: input.context,
      currentSkillId: input.currentSkillId ?? input.skillId,
      currentSkillName: input.currentSkillName,
      resolverRef: input.resolverRef,
    })
  }

  async list(filter?: PendingApprovalFilter): Promise<PendingApproval[]> {
    await this.ensureLoaded()

    return Array.from(this.approvals.values())
      .filter((approval) => {
        if (approval.resolution) {
          return false
        }
        if (filter?.commanderId && approval.commanderId !== filter.commanderId) {
          return false
        }
        if (filter?.sessionId && approval.sessionId !== filter.sessionId) {
          return false
        }
        if (filter?.conversationId && approval.conversationId !== filter.conversationId) {
          return false
        }
        if (filter?.actionId && approval.actionId !== filter.actionId) {
          return false
        }
        if (filter?.source && approval.source !== filter.source) {
          return false
        }
        return true
      })
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
  }

  async listPending(): Promise<PendingApprovalRecord[]> {
    return this.list()
  }

  async recordHistoryEntry(entry: ApprovalHistoryEntry): Promise<void> {
    await this.serializeMutation(async () => {
      await this.appendAudit(entry)
    })
  }

  async listHistory(
    filter: ApprovalHistoryFilter = {},
    cutoffMs?: number,
  ): Promise<ApprovalHistoryEntry[]> {
    const effectiveCutoffMs = typeof filter.from === 'string'
      ? undefined
      : typeof cutoffMs === 'number' && Number.isFinite(cutoffMs)
        ? cutoffMs
        : this.now().getTime() - DEFAULT_APPROVAL_HISTORY_VISIBILITY_CUTOFF_MS
    const entries = (await readJsonLines<unknown>(this.auditFilePath))
      .map((entry) => normalizeHistoryEntry(entry))
      .filter((entry): entry is ApprovalHistoryEntry => entry !== null)
      .filter((entry) => {
        if (filter.commanderId && entry.commanderId !== filter.commanderId) {
          return false
        }
        if (filter.actionId && entry.actionId !== filter.actionId) {
          return false
        }
        if (filter.source && entry.source !== filter.source) {
          return false
        }
        if (typeof effectiveCutoffMs === 'number') {
          const entryTimestampMs = parseTimestampMs(entry.timestamp)
          if (entryTimestampMs === null || entryTimestampMs < effectiveCutoffMs) {
            return false
          }
        }
        if (filter.from && entry.timestamp < filter.from) {
          return false
        }
        if (filter.to && entry.timestamp > filter.to) {
          return false
        }
        return true
      })
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))

    const limit = typeof filter.limit === 'number' && Number.isFinite(filter.limit)
      ? Math.max(1, Math.min(200, Math.floor(filter.limit)))
      : 50

    return entries.slice(0, limit)
  }

  async pruneAuditLog(retentionMs = this.auditRetentionMs): Promise<void> {
    await this.serializeMutation(async () => {
      await this.pruneAuditLogInternal(this.normalizeRetentionMs(retentionMs))
    })
  }

  async get(id: string): Promise<PendingApproval | null> {
    await this.ensureLoaded()
    return this.approvals.get(id) ?? null
  }

  async getStatus(id: string): Promise<PendingApprovalStatus | null> {
    await this.ensureLoaded()
    const approval = this.approvals.get(id)
    if (!approval) {
      return null
    }

    if (!approval.resolution && this.hasExpired(approval) && approval.timeoutAction) {
      const timedOut = await this.resolve(approval.id, approval.timeoutAction, { timedOut: true })
      if (!timedOut) {
        return null
      }
      return {
        state: 'resolved',
        approval: timedOut.approval,
        outcome: timedOut.outcome,
        delivered: timedOut.delivered,
      }
    }

    if (approval.resolution) {
      return {
        state: 'resolved',
        approval,
        outcome: approval.resolution,
        delivered: typeof approval.deliveredAt === 'string',
      }
    }

    return {
      state: 'pending',
      approval,
    }
  }

  async markDelivered(id: string): Promise<boolean> {
    return this.serializeMutation(async () => {
      await this.ensureLoaded()

      const approval = this.approvals.get(id)
      if (!approval?.resolution) {
        return false
      }

      if (approval.deliveredAt) {
        return true
      }

      approval.deliveredAt = this.now().toISOString()
      this.approvals.delete(id)
      this.resolutionHandlers.delete(id)
      this.clearTimeout(id)
      await this.persistSnapshot()
      await this.updateAuditDelivered(id)
      return true
    })
  }

  async attachResolutionHandler(
    id: string,
    handler: ApprovalResolutionHandler,
  ): Promise<boolean> {
    await this.ensureLoaded()
    if (!this.approvals.has(id)) {
      return false
    }
    this.resolutionHandlers.set(id, handler)
    return true
  }

  async waitForResolution(
    id: string,
    options: { timeoutMs: number; timeoutAction: PendingApprovalResolution },
  ): Promise<ApprovalResolutionOutcome> {
    await this.ensureLoaded()

    const registration = await this.serializeMutation<WaitRegistrationResult>(async () => {
      const resolvedOutcome = this.consumeResolvedOutcome(id)
      if (resolvedOutcome) {
        return {
          kind: 'resolved',
          outcome: resolvedOutcome,
        }
      }

      const approval = this.approvals.get(id)
      if (!approval) {
        return { kind: 'missing' }
      }

      if (approval.resolution) {
        return {
          kind: 'resolved',
          outcome: approval.resolution,
        }
      }

      return {
        kind: 'waiting',
        promise: new Promise((resolve) => {
          const waiters = this.waiters.get(id) ?? []
          waiters.push({ resolve })
          this.waiters.set(id, waiters)
        }),
      }
    })

    if (registration.kind === 'resolved') {
      return registration.outcome
    }

    if (registration.kind === 'missing') {
      return {
        decision: options.timeoutAction,
        allowed: options.timeoutAction === 'approve',
        reason: 'Approval request no longer exists.',
      }
    }

    return registration.promise
  }

  async resolve(
    id: string,
    decision: PendingApprovalResolution,
  options?: { timedOut?: boolean },
  ): Promise<{ approval: PendingApproval; delivered: boolean; outcome: ApprovalResolutionOutcome } | null> {
    return this.serializeMutation(async () => {
      await this.ensureLoaded()

      const approval = this.approvals.get(id)
      if (!approval) {
        return null
      }

      if (approval.resolution) {
        return {
          approval,
          delivered: typeof approval.deliveredAt === 'string',
          outcome: approval.resolution,
        }
      }

      this.clearTimeout(id)
      const handler = this.resolutionHandlers.get(id)
      const waiters = this.waiters.get(id) ?? []
      let delivered = false
      let outcome = defaultOutcome(decision, options)
      if (handler) {
        try {
          const handlerOutcome = await handler(approval, decision, options)
          delivered = true
          if (handlerOutcome) {
            outcome = handlerOutcome
          }
        } catch (error) {
          outcome = {
            decision,
            allowed: false,
            reason: error instanceof Error ? error.message : 'Failed to resolve approval',
            timedOut: options?.timedOut,
          }
        }
      }

      this.waiters.delete(id)
      for (const waiter of waiters) {
        waiter.resolve(outcome)
      }

      if (handler || waiters.length > 0) {
        this.approvals.delete(id)
        this.resolutionHandlers.delete(id)
        this.rememberResolvedOutcome(id, outcome)
      } else {
        approval.resolution = outcome
        approval.resolvedAt = this.now().toISOString()
      }

      await this.persistSnapshot()
      await this.appendAudit({
        timestamp: approval.resolvedAt ?? this.now().toISOString(),
        type: 'approval.resolved',
        approvalId: approval.id,
        actionId: approval.actionId,
        actionLabel: approval.actionLabel,
        commanderId: approval.commanderId,
        sessionId: approval.sessionId,
        conversationId: approval.conversationId,
        source: approval.source,
        toolName: approval.toolName,
        summary: approval.context.summary,
        decision,
        delivered,
        outcome,
      })
      this.emit({
        type: 'resolved',
        approval,
        decision,
        delivered,
      })

      return {
        approval,
        delivered,
        outcome,
      }
    })
  }

  async resolvePendingApproval(
    id: string,
    decision: PendingApprovalResolution,
    options?: { timedOut?: boolean },
  ): Promise<{
    ok: boolean
    approval?: PendingApprovalRecord
    outcome?: ApprovalResolutionOutcome
    delivered?: boolean
    error?: string
  }> {
    const resolved = await this.resolve(id, decision, options)
    if (!resolved) {
      return {
        ok: false,
        error: `Pending approval "${id}" was not found`,
      }
    }

    return {
      ok: true,
      approval: resolved.approval,
      outcome: resolved.outcome,
      delivered: resolved.delivered,
    }
  }

  private emit(event: ApprovalCoordinatorEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event)
      } catch {
        // Subscriber failures must not interrupt approval flow delivery.
      }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.initialized) {
      if (!this.timeoutsInitialized) {
        this.initializeTimeouts()
      }
      return
    }

    if (!this.initPromise) {
      this.initPromise = (async () => {
        const snapshot = normalizeSnapshot(
          await readJsonFile<unknown>(this.snapshotFilePath, { version: 1, approvals: [] }),
        )
        for (const approval of snapshot.approvals) {
          this.approvals.set(approval.id, approval)
        }
        this.initialized = true
      })()
    }

    await this.initPromise
    if (!this.timeoutsInitialized) {
      this.initializeTimeouts()
    }
  }

  private async persistSnapshot(): Promise<void> {
    await writeJsonFile(this.snapshotFilePath, {
      schemaVersion: 1,
      version: 1,
      approvals: Array.from(this.approvals.values()),
    })
  }

  private async appendAudit(entry: Record<string, unknown> | ApprovalHistoryEntry): Promise<void> {
    await this.maybePruneAuditLog()
    await appendJsonLine(this.auditFilePath, entry as Record<string, unknown>)
  }

  private initializeTimeouts(): void {
    this.timeoutsInitialized = true
    for (const approval of this.approvals.values()) {
      this.scheduleTimeout(approval)
    }
  }

  private scheduleTimeout(approval: PendingApproval): void {
    this.clearTimeout(approval.id)
    if (!approval.expiresAt || !approval.timeoutAction || approval.resolution) {
      return
    }

    const delayMs = Date.parse(approval.expiresAt) - this.now().getTime()
    const timer = setTimeout(() => {
      this.timeoutTimers.delete(approval.id)
      void this.resolve(approval.id, approval.timeoutAction!, { timedOut: true })
    }, Math.max(0, delayMs))
    this.timeoutTimers.set(approval.id, timer)
  }

  private clearTimeout(id: string): void {
    const timer = this.timeoutTimers.get(id)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.timeoutTimers.delete(id)
  }

  private hasExpired(approval: PendingApproval): boolean {
    if (!approval.expiresAt) {
      return false
    }
    return Date.parse(approval.expiresAt) <= this.now().getTime()
  }

  private async updateAuditDelivered(approvalId: string): Promise<void> {
    await this.maybePruneAuditLog()

    let raw: string
    try {
      raw = await readFile(this.auditFilePath, 'utf8')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        return
      }
      throw error
    }

    const lines = raw.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim()
      if (!line) {
        continue
      }
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (
          entry.type === 'approval.resolved'
          && entry.approvalId === approvalId
          && entry.delivered !== true
        ) {
          lines[index] = JSON.stringify({
            ...entry,
            delivered: true,
          })
          await writeFile(
            this.auditFilePath,
            `${lines.filter((candidate) => candidate.trim().length > 0).join('\n')}\n`,
            'utf8',
          )
          return
        }
      } catch {
        // Ignore malformed audit rows when rewriting delivered state.
      }
    }
  }

  private rememberResolvedOutcome(id: string, outcome: ApprovalResolutionOutcome): void {
    this.resolvedOutcomes.delete(id)
    this.resolvedOutcomes.set(id, outcome)

    if (this.resolvedOutcomes.size <= ApprovalCoordinator.MAX_RESOLVED_OUTCOMES) {
      return
    }

    const oldestId = this.resolvedOutcomes.keys().next().value
    if (typeof oldestId === 'string') {
      this.resolvedOutcomes.delete(oldestId)
    }
  }

  private consumeResolvedOutcome(id: string): ApprovalResolutionOutcome | null {
    const outcome = this.resolvedOutcomes.get(id) ?? null
    if (outcome) {
      this.resolvedOutcomes.delete(id)
    }
    return outcome
  }

  private normalizeRetentionMs(retentionMs: number): number {
    return Number.isFinite(retentionMs) && retentionMs >= 0
      ? Math.floor(retentionMs)
      : this.auditRetentionMs
  }

  private async maybePruneAuditLog(): Promise<void> {
    const nowMs = this.now().getTime()
    if (nowMs - this.lastAuditPrunedAtMs < DEFAULT_APPROVAL_AUDIT_PRUNE_INTERVAL_MS) {
      return
    }

    await this.pruneAuditLogInternal(this.auditRetentionMs, nowMs)
  }

  private async pruneAuditLogInternal(retentionMs: number, nowMs = this.now().getTime()): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.auditFilePath, 'utf8')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        this.lastAuditPrunedAtMs = nowMs
        return
      }
      throw error
    }

    const cutoffMs = nowMs - retentionMs
    const retainedEntries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as unknown
          if (!isRecord(entry)) {
            return []
          }

          const normalizedEntry = normalizeHistoryEntry(entry)
          if (!normalizedEntry) {
            return []
          }

          const timestampMs = parseTimestampMs(normalizedEntry.timestamp)
          if (timestampMs === null || timestampMs < cutoffMs) {
            return []
          }

          return [entry]
        } catch {
          return []
        }
      })

    await this.rewriteAuditFile(retainedEntries)
    this.lastAuditPrunedAtMs = nowMs
  }

  private async rewriteAuditFile(entries: Record<string, unknown>[]): Promise<void> {
    await mkdir(path.dirname(this.auditFilePath), { recursive: true })
    const nextContents = entries.map((entry) => JSON.stringify(entry)).join('\n')
    await writeFile(this.auditFilePath, nextContents ? `${nextContents}\n` : '', 'utf8')
  }

  private serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation, mutation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
