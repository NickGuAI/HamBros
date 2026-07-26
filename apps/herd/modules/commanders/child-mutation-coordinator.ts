import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

interface CommanderChildMutationState {
  tail: Promise<void>
  version: number
  cleanupState: 'idle' | 'active' | 'deleted'
  activeRuntimeActivities: number
}

interface ActiveCommanderMutationToken {
  active: boolean
}

export interface CommanderCleanupLease {
  runOwned<T>(operation: () => Promise<T>): Promise<T>
  complete(options: { deleted: boolean }): void
}

export interface CommanderProvisioningLease {
  runOwned<T>(operation: () => Promise<T>): Promise<T>
  complete(options: { deleted: boolean }): number
}

export interface CommanderRuntimeActivityLease {
  complete(): Promise<void>
}

async function reserveCommanderForDeletion(
  commanderId: string,
  lifecycleScope: string,
  expectedVersion?: number,
): Promise<CommanderCleanupLease | null> {
  const state = mutationState(commanderId, lifecycleScope)
  const release = await acquireMutationLock(state)
  if (
    state.cleanupState !== 'idle'
    || state.activeRuntimeActivities > 0
    || (expectedVersion !== undefined && state.version !== expectedVersion)
  ) {
    release()
    return null
  }

  state.cleanupState = 'active'
  const key = mutationKey(commanderId, lifecycleScope)
  let completed = false
  return {
    async runOwned(operation) {
      if (completed) {
        throw new Error(`Commander cleanup lease for "${commanderId}" is already complete`)
      }
      const token: ActiveCommanderMutationToken = { active: true }
      const ownedMutations = new Map(activeCommanderMutations.getStore())
      ownedMutations.set(key, token)
      try {
        return await activeCommanderMutations.run(ownedMutations, operation)
      } finally {
        token.active = false
      }
    },
    complete({ deleted }) {
      if (completed) {
        return
      }
      completed = true
      state.cleanupState = deleted ? 'deleted' : 'idle'
      release()
    },
  }
}

export class CommanderCleanupInProgressError extends Error {
  constructor(commanderId: string) {
    super(`Commander "${commanderId}" is being removed and cannot accept new child state`)
    this.name = 'CommanderCleanupInProgressError'
  }
}

const mutationStates = new Map<string, CommanderChildMutationState>()
const activeCommanderMutations = new AsyncLocalStorage<
  ReadonlyMap<string, ActiveCommanderMutationToken>
>()

function mutationKey(commanderId: string, lifecycleScope: string): string {
  return path.join(path.resolve(lifecycleScope), commanderId)
}

function mutationState(commanderId: string, lifecycleScope: string): CommanderChildMutationState {
  const key = mutationKey(commanderId, lifecycleScope)
  const existing = mutationStates.get(key)
  if (existing) {
    return existing
  }
  const created: CommanderChildMutationState = {
    tail: Promise.resolve(),
    version: 0,
    cleanupState: 'idle',
    activeRuntimeActivities: 0,
  }
  mutationStates.set(key, created)
  return created
}

async function acquireMutationLock(state: CommanderChildMutationState): Promise<() => void> {
  const previous = state.tail
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  state.tail = previous.then(() => current)
  await previous
  return release
}

/**
 * Captures the mutation generation before cleanup's final ownership read.
 * A later cleanup lease can commit only if no normal child creation completed
 * between this observation and the destructive parent delete.
 */
export function captureCommanderChildMutationVersion(
  commanderId: string,
  lifecycleScope: string,
): number {
  return mutationState(commanderId, lifecycleScope).version
}

/**
 * Serializes normal commander mutation against cleanup. Successful mutation
 * advances the generation; queued mutation fails after a committed delete
 * instead of recreating state beneath a removed commander.
 */
export async function withCommanderMutation<T>(
  commanderId: string,
  lifecycleScope: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = mutationKey(commanderId, lifecycleScope)
  const activeMutations = activeCommanderMutations.getStore()
  if (activeMutations?.get(key)?.active === true) {
    return operation()
  }

  const state = mutationState(commanderId, lifecycleScope)
  const release = await acquireMutationLock(state)
  let token: ActiveCommanderMutationToken | null = null
  try {
    if (state.cleanupState !== 'idle') {
      throw new CommanderCleanupInProgressError(commanderId)
    }
    token = { active: true }
    const nestedMutations = new Map(activeMutations)
    nestedMutations.set(key, token)
    const result = await activeCommanderMutations.run(nestedMutations, operation)
    token.active = false
    state.version += 1
    return result
  } finally {
    if (token) {
      token.active = false
    }
    release()
  }
}

/** Child stores and commander-root writers share one mutation boundary. */
export function withCommanderChildCreation<T>(
  commanderId: string,
  lifecycleScope: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withCommanderMutation(commanderId, lifecycleScope, operation)
}

/**
 * Admits a provider/runtime attempt without holding the normal mutation mutex
 * for its full (potentially slow) lifetime. Admission advances the generation;
 * cleanup/deletion fail closed while any admitted attempt is active, while
 * unrelated normal commander writes remain concurrent.
 */
export async function beginCommanderRuntimeActivity(
  commanderId: string,
  lifecycleScope: string,
): Promise<CommanderRuntimeActivityLease> {
  const state = mutationState(commanderId, lifecycleScope)
  const release = await acquireMutationLock(state)
  if (state.cleanupState !== 'idle') {
    release()
    throw new CommanderCleanupInProgressError(commanderId)
  }
  state.activeRuntimeActivities += 1
  state.version += 1
  release()

  let completed = false
  return {
    async complete() {
      if (completed) {
        return
      }
      completed = true
      const completeRelease = await acquireMutationLock(state)
      state.activeRuntimeActivities = Math.max(0, state.activeRuntimeActivities - 1)
      completeRelease()
    },
  }
}

/**
 * Runs a raw parent-store operation without lending the cleanup owner's token
 * to callbacks triggered by that operation. The parent delete itself does not
 * need coordinator re-entry; any unawaited child write it triggers must queue
 * behind the lease and fail if the commander is tombstoned.
 */
export function withoutCommanderMutationOwnership<T>(
  commanderId: string,
  lifecycleScope: string,
  operation: () => Promise<T>,
): Promise<T> {
  const activeMutations = activeCommanderMutations.getStore()
  if (!activeMutations) {
    return operation()
  }
  const key = mutationKey(commanderId, lifecycleScope)
  if (!activeMutations.has(key)) {
    return operation()
  }
  const unownedMutations = new Map(activeMutations)
  unownedMutations.delete(key)
  return activeCommanderMutations.run(unownedMutations, operation)
}

/**
 * Acquires more than one commander mutation boundary in stable key order.
 * Reparenting operations use this so the old and new commander generations
 * advance atomically without lock-order deadlocks.
 */
export function withCommanderMutations<T>(
  commanderIds: readonly string[],
  lifecycleScope: string,
  operation: () => Promise<T>,
): Promise<T> {
  const orderedIds = [...new Set(commanderIds.filter((commanderId) => commanderId.trim()))]
    .sort((left, right) => (
      mutationKey(left, lifecycleScope).localeCompare(mutationKey(right, lifecycleScope))
    ))

  const acquire = (index: number): Promise<T> => {
    const commanderId = orderedIds[index]
    if (!commanderId) {
      return operation()
    }
    return withCommanderMutation(
      commanderId,
      lifecycleScope,
      () => acquire(index + 1),
    )
  }
  return acquire(0)
}

/**
 * Atomically validates cleanup's final child-state observation and reserves
 * the commander against subsequent child creation through parent deletion.
 * Returns null when a creation raced the observation; callers must fail closed.
 */
export async function beginCommanderCleanup(
  commanderId: string,
  lifecycleScope: string,
  observedVersion: number,
): Promise<CommanderCleanupLease | null> {
  return reserveCommanderForDeletion(commanderId, lifecycleScope, observedVersion)
}

/**
 * Reserves a commander for an explicit full delete after the route's final
 * child-state observation. A raced writer invalidates that observation and
 * the route must sweep again before retrying.
 */
export async function beginCommanderDeletion(
  commanderId: string,
  lifecycleScope: string,
  observedVersion: number,
): Promise<CommanderCleanupLease | null> {
  return reserveCommanderForDeletion(commanderId, lifecycleScope, observedVersion)
}

/**
 * Publishes a new commander behind an exclusive lifecycle boundary. Only
 * directly awaited provisioning work receives the revocable owner token;
 * deferred callbacks inherit an inactive token and must reacquire normally.
 */
export async function beginCommanderProvisioning(
  commanderId: string,
  lifecycleScope: string,
  parentExists?: () => Promise<boolean>,
): Promise<CommanderProvisioningLease | null> {
  const state = mutationState(commanderId, lifecycleScope)
  const release = await acquireMutationLock(state)
  if (state.cleanupState !== 'idle') {
    release()
    return null
  }
  try {
    if (await parentExists?.()) {
      release()
      return null
    }
  } catch (error) {
    release()
    throw error
  }

  state.cleanupState = 'active'
  const key = mutationKey(commanderId, lifecycleScope)
  let completed = false
  let completedVersion: number | null = null
  return {
    async runOwned(operation) {
      if (completed) {
        throw new Error(`Commander provisioning lease for "${commanderId}" is already complete`)
      }
      const token: ActiveCommanderMutationToken = { active: true }
      const ownedMutations = new Map(activeCommanderMutations.getStore())
      ownedMutations.set(key, token)
      try {
        return await activeCommanderMutations.run(ownedMutations, operation)
      } finally {
        token.active = false
      }
    },
    complete({ deleted }) {
      if (completed) {
        return completedVersion ?? state.version
      }
      completed = true
      if (!deleted) {
        state.version += 1
      }
      completedVersion = state.version
      state.cleanupState = deleted ? 'deleted' : 'idle'
      release()
      return completedVersion
    },
  }
}
