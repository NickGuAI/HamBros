import path from 'node:path'
import { resolveModuleDataDir } from '../data-dir.js'
import { withCommanderMutation } from '../commanders/child-mutation-coordinator.js'
import { resolveCommanderDataDir } from '../commanders/paths.js'
import {
  getActiveStandingApprovalEmails,
  normalizeStandingApprovalEntries,
  reconcileStandingApprovalEntries,
  SEND_EMAIL_ACTION_ID,
} from './email-standing-approval.js'
import { getDefaultActionPolicySettings } from './settings-defaults.js'
import {
  BUILT_IN_ACTIONS,
  INTERNAL_EDIT_IN_CWD_ACTION,
  INTERNAL_SAFE_BASH_ACTION,
  INTERNAL_SAFE_MCP_ACTION,
} from './registry.js'
import {
  asTrimmedString,
  isRecord,
  normalizeActionPolicyValue,
  normalizeStringArray,
  readJsonFile,
  writeJsonFile,
} from './shared.js'
import {
  ACTION_POLICY_VALUES,
  FALLBACK_ACTION_POLICY_ID,
  isCommanderActionPolicyScope,
  type ActionCategoryDefinition,
  type ActionPolicyRecord,
  type ActionPolicySettings,
  type ActionPolicyScope,
  type ActionPolicyValue,
  type EffectiveActionPolicyView,
} from './types.js'

function resolveDefaultPolicyStorePath(): string {
  return path.join(resolveModuleDataDir('policies'), 'policies.json')
}

interface StoredPolicyScope {
  fallbackPolicy?: ActionPolicyValue
  records: ActionPolicyRecord[]
}

interface PersistedPolicyStore {
  schemaVersion: 1
  version: 1
  updatedAt: string
  global: StoredPolicyScope
  commanders: Record<string, StoredPolicyScope>
  settings: ActionPolicySettings
}

const ACTION_POLICY_VALUE_SET = new Set<string>(ACTION_POLICY_VALUES)

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStrictStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

function isStandingApprovalEntry(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  return ['email', 'added_at', 'added_by', 'reason'].every((field) => isNonEmptyString(value[field]))
    && (value.expires_at === undefined || isNonEmptyString(value.expires_at))
    && (value.permanent === undefined || typeof value.permanent === 'boolean')
}

function isStoredPolicyRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  return isNonEmptyString(value.actionId)
    && typeof value.policy === 'string'
    && ACTION_POLICY_VALUE_SET.has(value.policy)
    && isStrictStringArray(value.allowlist)
    && isStrictStringArray(value.blocklist)
    && (
      value.standing_approval === undefined
      || (
        Array.isArray(value.standing_approval)
        && value.standing_approval.every(isStandingApprovalEntry)
      )
    )
    && (value.updatedAt === undefined || isNonEmptyString(value.updatedAt))
    && (value.updatedBy === undefined || isNonEmptyString(value.updatedBy))
}

function isStoredPolicyScope(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return false
  }
  if (
    value.fallbackPolicy !== undefined
    && (
      typeof value.fallbackPolicy !== 'string'
      || !ACTION_POLICY_VALUE_SET.has(value.fallbackPolicy)
    )
  ) {
    return false
  }
  const actionIds = value.records
    .filter(isRecord)
    .map((record) => record.actionId)
  return value.records.every(isStoredPolicyRecord)
    && actionIds.length === new Set(actionIds).size
}

function isStoredPolicySettings(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  return typeof value.timeoutMinutes === 'number'
    && Number.isFinite(value.timeoutMinutes)
    && value.timeoutMinutes > 0
    && (value.timeoutAction === 'auto' || value.timeoutAction === 'block')
    && typeof value.standingApprovalExpiryDays === 'number'
    && Number.isFinite(value.standingApprovalExpiryDays)
    && value.standingApprovalExpiryDays > 0
}

export function isPersistedPolicyStoreValid(raw: unknown): boolean {
  if (
    !isRecord(raw)
    || raw.version !== 1
    || !isNonEmptyString(raw.updatedAt)
    || !Number.isFinite(Date.parse(raw.updatedAt))
    || !isStoredPolicyScope(raw.global)
    || !isRecord(raw.commanders)
    || !isStoredPolicySettings(raw.settings)
  ) {
    return false
  }
  return Object.entries(raw.commanders).every(([commanderId, scope]) => (
    isNonEmptyString(commanderId) && isStoredPolicyScope(scope)
  ))
}

export interface PolicyStoreOptions {
  filePath?: string
  commanderDataDir?: string
  builtInActions?: ActionCategoryDefinition[]
  defaultPolicy?: ActionPolicyValue
  now?: () => Date
}

function emptyStoredScope(): StoredPolicyScope {
  return { records: [] }
}

function defaultPersistedStore(now: () => Date): PersistedPolicyStore {
  return {
    schemaVersion: 1,
    version: 1,
    updatedAt: now().toISOString(),
    global: emptyStoredScope(),
    commanders: {},
    settings: getDefaultActionPolicySettings(),
  }
}

function normalizePolicyRecord(
  entry: unknown,
  now: () => Date,
  standingApprovalExpiryDays: number,
): ActionPolicyRecord | null {
  if (!isRecord(entry)) {
    return null
  }

  const actionId = asTrimmedString(entry.actionId)
  if (!actionId) {
    return null
  }

  const updatedAt = asTrimmedString(entry.updatedAt)
  const updatedBy = asTrimmedString(entry.updatedBy)
  const allowlist = normalizeStringArray(entry.allowlist)
  const blocklist = normalizeStringArray(entry.blocklist)
  const normalizedNow = now()

  const standingApproval = actionId === SEND_EMAIL_ACTION_ID
    ? normalizeStandingApprovalEntries(
      entry.standing_approval,
      {
        now: normalizedNow,
        default_added_at: updatedAt ?? normalizedNow.toISOString(),
        default_added_by: updatedBy ?? 'unknown',
        expiry_days: standingApprovalExpiryDays,
      },
    )
    : []

  const record: ActionPolicyRecord = {
    actionId,
    policy: normalizeActionPolicyValue(entry.policy),
    allowlist,
    blocklist,
    ...(actionId === SEND_EMAIL_ACTION_ID
      ? {
        ...(standingApproval.length > 0
          ? { standing_approval: standingApproval }
          : {}),
      }
      : {}),
  }

  if (updatedAt) {
    record.updatedAt = updatedAt
  }

  if (updatedBy) {
    record.updatedBy = updatedBy
  }

  return record
}

function normalizeStoredScope(
  entry: unknown,
  now: () => Date,
  standingApprovalExpiryDays: number,
): StoredPolicyScope {
  if (!isRecord(entry)) {
    return emptyStoredScope()
  }

  const fallbackPolicy = entry.fallbackPolicy === undefined
    ? undefined
    : normalizeActionPolicyValue(entry.fallbackPolicy)
  const records = Array.isArray(entry.records)
    ? entry.records
      .map((record) => normalizePolicyRecord(record, now, standingApprovalExpiryDays))
      .filter((record): record is ActionPolicyRecord => record !== null)
    : []

  return { fallbackPolicy, records }
}

function normalizePersistedStore(raw: unknown, now: () => Date): PersistedPolicyStore {
  if (!isRecord(raw)) {
    return defaultPersistedStore(now)
  }

  const fallback = defaultPersistedStore(now)
  const rawSettings = isRecord(raw.settings) ? raw.settings : undefined
  const standingApprovalExpiryDays = typeof rawSettings?.standingApprovalExpiryDays === 'number'
    && Number.isFinite(rawSettings.standingApprovalExpiryDays)
    && rawSettings.standingApprovalExpiryDays > 0
    ? Math.round(rawSettings.standingApprovalExpiryDays)
    : fallback.settings.standingApprovalExpiryDays
  const commanders: Record<string, StoredPolicyScope> = {}
  if (isRecord(raw.commanders)) {
    for (const [commanderId, entry] of Object.entries(raw.commanders)) {
      const trimmedCommanderId = asTrimmedString(commanderId)
      if (!trimmedCommanderId) {
        continue
      }
      commanders[trimmedCommanderId] = normalizeStoredScope(entry, now, standingApprovalExpiryDays)
    }
  }

  return {
    schemaVersion: 1,
    version: 1,
    updatedAt: asTrimmedString(raw.updatedAt) ?? now().toISOString(),
    global: normalizeStoredScope(raw.global, now, standingApprovalExpiryDays),
    commanders,
    settings: {
      timeoutMinutes: typeof rawSettings?.timeoutMinutes === 'number'
        && Number.isFinite(rawSettings.timeoutMinutes) && rawSettings.timeoutMinutes > 0
        ? Math.round(rawSettings.timeoutMinutes)
        : fallback.settings.timeoutMinutes,
      timeoutAction: rawSettings?.timeoutAction === 'auto' || rawSettings?.timeoutAction === 'block'
        ? rawSettings.timeoutAction
        : fallback.settings.timeoutAction,
      standingApprovalExpiryDays,
    },
  }
}

function sortRecords(
  records: Iterable<ActionPolicyRecord>,
  builtInActions: ActionCategoryDefinition[],
): ActionPolicyRecord[] {
  const builtInOrder = new Map(builtInActions.map((action, index) => [action.id, index]))
  return Array.from(records).sort((left, right) => {
    const leftOrder = builtInOrder.get(left.actionId)
    const rightOrder = builtInOrder.get(right.actionId)
    if (leftOrder !== undefined && rightOrder !== undefined) {
      return leftOrder - rightOrder
    }
    if (leftOrder !== undefined) {
      return -1
    }
    if (rightOrder !== undefined) {
      return 1
    }
    return left.actionId.localeCompare(right.actionId)
  })
}

function createDefaultRecord(actionId: string, policy: ActionPolicyValue): ActionPolicyRecord {
  const defaultPolicy = (
    actionId === INTERNAL_EDIT_IN_CWD_ACTION.id
    || actionId === INTERNAL_SAFE_BASH_ACTION.id
    || actionId === INTERNAL_SAFE_MCP_ACTION.id
  )
    ? 'auto'
    : policy

  return {
    actionId,
    policy: defaultPolicy,
    allowlist: [],
    blocklist: [],
  }
}

function mergeScopeRecords(
  baseRecords: Iterable<ActionPolicyRecord>,
  overrideRecords: Iterable<ActionPolicyRecord>,
): Map<string, ActionPolicyRecord> {
  const merged = new Map<string, ActionPolicyRecord>()
  for (const record of baseRecords) {
    merged.set(record.actionId, {
      actionId: record.actionId,
      policy: record.policy,
      allowlist: [...record.allowlist],
      blocklist: [...record.blocklist],
      ...(record.standing_approval ? { standing_approval: [...record.standing_approval] } : {}),
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    })
  }
  for (const record of overrideRecords) {
    merged.set(record.actionId, {
      actionId: record.actionId,
      policy: record.policy,
      allowlist: [...record.allowlist],
      blocklist: [...record.blocklist],
      ...(record.standing_approval ? { standing_approval: [...record.standing_approval] } : {}),
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    })
  }
  return merged
}

export class PolicyStore {
  private readonly filePath: string

  private readonly commanderDataDir: string

  private readonly builtInActions: ActionCategoryDefinition[]

  private readonly defaultPolicy: ActionPolicyValue

  private readonly now: () => Date

  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: PolicyStoreOptions = {}) {
    this.filePath = options.filePath
      ? path.resolve(options.filePath)
      : resolveDefaultPolicyStorePath()
    this.commanderDataDir = path.resolve(options.commanderDataDir ?? resolveCommanderDataDir())
    this.builtInActions = options.builtInActions ?? BUILT_IN_ACTIONS
    this.defaultPolicy = options.defaultPolicy ?? 'review'
    this.now = options.now ?? (() => new Date())
  }

  async getGlobal(): Promise<EffectiveActionPolicyView> {
    const store = await this.readStore()
    return this.buildView('global', store.global)
  }

  async getCommanderOverrides(
    commanderId: string,
  ): Promise<{ fallbackPolicy?: ActionPolicyValue; records: ActionPolicyRecord[] }> {
    const trimmedCommanderId = commanderId.trim()
    if (!trimmedCommanderId) {
      return { records: [] }
    }

    const store = await this.readStore()
    const scope = store.commanders[trimmedCommanderId] ?? emptyStoredScope()
    return {
      fallbackPolicy: scope.fallbackPolicy,
      records: sortRecords(scope.records, this.builtInActions),
    }
  }

  async getSettings(): Promise<ActionPolicySettings> {
    const store = await this.readStore()
    return {
      timeoutMinutes: store.settings.timeoutMinutes,
      timeoutAction: store.settings.timeoutAction,
      standingApprovalExpiryDays: store.settings.standingApprovalExpiryDays,
    }
  }

  async putSettings(
    settings: Partial<ActionPolicySettings>,
  ): Promise<ActionPolicySettings> {
    return this.serializeMutation(async () => {
      const store = await this.readStore()
      if (
        typeof settings.timeoutMinutes === 'number' &&
        Number.isFinite(settings.timeoutMinutes) &&
        settings.timeoutMinutes > 0
      ) {
        store.settings.timeoutMinutes = Math.round(settings.timeoutMinutes)
      }

      if (settings.timeoutAction === 'auto' || settings.timeoutAction === 'block') {
        store.settings.timeoutAction = settings.timeoutAction
      }

      if (
        typeof settings.standingApprovalExpiryDays === 'number' &&
        Number.isFinite(settings.standingApprovalExpiryDays) &&
        settings.standingApprovalExpiryDays > 0
      ) {
        store.settings.standingApprovalExpiryDays = Math.round(settings.standingApprovalExpiryDays)
      }

      store.updatedAt = this.now().toISOString()
      await this.writeStore(store)

      return {
        timeoutMinutes: store.settings.timeoutMinutes,
        timeoutAction: store.settings.timeoutAction,
        standingApprovalExpiryDays: store.settings.standingApprovalExpiryDays,
      }
    })
  }

  async resolveEffective(commanderId?: string): Promise<EffectiveActionPolicyView> {
    if (!commanderId || commanderId.trim().length === 0) {
      return this.getGlobal()
    }

    const trimmedCommanderId = commanderId.trim()
    const store = await this.readStore()
    const globalView = this.buildView('global', store.global)
    const overrideScope = store.commanders[trimmedCommanderId]
    const mergedRecords = mergeScopeRecords(
      globalView.records,
      overrideScope?.records ?? [],
    )

    return {
      scope: { commanderId: trimmedCommanderId },
      fallbackPolicy: overrideScope?.fallbackPolicy ?? globalView.fallbackPolicy,
      records: sortRecords(mergedRecords.values(), this.builtInActions),
    }
  }

  async putPolicy(
    scope: ActionPolicyScope,
    actionId: string,
    record: Omit<ActionPolicyRecord, 'actionId'> & { actionId?: string },
  ): Promise<ActionPolicyRecord | null> {
    const trimmedActionId = actionId.trim()
    if (!trimmedActionId) {
      throw new Error('actionId is required')
    }

    const normalizedRecord: ActionPolicyRecord = {
      actionId: trimmedActionId,
      policy: normalizeActionPolicyValue(record.policy, this.defaultPolicy),
      allowlist: normalizeStringArray(record.allowlist),
      blocklist: normalizeStringArray(record.blocklist),
      updatedAt: record.updatedAt ?? this.now().toISOString(),
      updatedBy: record.updatedBy,
    }

    const commanderId = isCommanderActionPolicyScope(scope)
      ? scope.commanderId.trim()
      : null
    if (commanderId !== null && !commanderId) {
      throw new Error('commanderId is required for commander policy scope')
    }

    const persistPolicy = () => this.serializeMutation(async () => {
      const store = await this.readStore()
      const targetScope = commanderId !== null
        ? (store.commanders[commanderId] ?? emptyStoredScope())
        : store.global
      const existingRecord = targetScope.records.find((entry) => entry.actionId === trimmedActionId)

      if (trimmedActionId === SEND_EMAIL_ACTION_ID) {
        const standingApproval = Array.isArray(record.standing_approval)
          ? normalizeStandingApprovalEntries(record.standing_approval, {
            now: this.now(),
            default_added_by: record.updatedBy,
            default_reason: 'Added via action policy update.',
            expiry_days: store.settings.standingApprovalExpiryDays,
          })
          : reconcileStandingApprovalEntries({
            existing: existingRecord?.standing_approval ?? [],
            nextEmails: normalizedRecord.allowlist,
            now: this.now(),
            added_by: record.updatedBy,
            reason: 'Added via action policy update.',
            expiry_days: store.settings.standingApprovalExpiryDays,
          })

        normalizedRecord.standing_approval = standingApproval
        normalizedRecord.allowlist = getActiveStandingApprovalEmails(standingApproval, this.now())
      }

      if (trimmedActionId === FALLBACK_ACTION_POLICY_ID) {
        targetScope.fallbackPolicy = normalizedRecord.policy
      } else {
        const nextRecords = targetScope.records.filter((entry) => entry.actionId !== trimmedActionId)
        nextRecords.push(normalizedRecord)
        targetScope.records = sortRecords(nextRecords, this.builtInActions)
      }

      if (commanderId !== null) {
        store.commanders[commanderId] = targetScope
      } else {
        store.global = targetScope
      }

      store.updatedAt = this.now().toISOString()
      await this.writeStore(store)

      return trimmedActionId === FALLBACK_ACTION_POLICY_ID ? null : normalizedRecord
    })

    return commanderId === null
      ? persistPolicy()
      : withCommanderMutation(commanderId, this.commanderDataDir, persistPolicy)
  }

  private buildView(scope: ActionPolicyScope, storedScope: StoredPolicyScope): EffectiveActionPolicyView {
    const merged = new Map<string, ActionPolicyRecord>()
    const synthesizedDefault = storedScope.fallbackPolicy ?? this.defaultPolicy
    for (const action of this.builtInActions) {
      merged.set(action.id, createDefaultRecord(action.id, synthesizedDefault))
    }
    for (const record of storedScope.records) {
      merged.set(record.actionId, {
        actionId: record.actionId,
        policy: normalizeActionPolicyValue(record.policy, this.defaultPolicy),
        allowlist: normalizeStringArray(record.allowlist),
        blocklist: normalizeStringArray(record.blocklist),
        ...(record.standing_approval ? { standing_approval: [...record.standing_approval] } : {}),
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
      })
    }

    return {
      scope,
      fallbackPolicy: storedScope.fallbackPolicy ?? this.defaultPolicy,
      records: sortRecords(merged.values(), this.builtInActions),
    }
  }

  private async readStore(): Promise<PersistedPolicyStore> {
    const raw = await readJsonFile<unknown>(this.filePath, defaultPersistedStore(this.now))
    return normalizePersistedStore(raw, this.now)
  }

  private async writeStore(store: PersistedPolicyStore): Promise<void> {
    await writeJsonFile(this.filePath, store)
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
