import { rm } from 'node:fs/promises'
import path from 'node:path'
import {
  beginCommanderDeletion,
  withoutCommanderMutationOwnership,
} from './child-mutation-coordinator.js'
import { deleteCommanderDisplayName } from './names-lock.js'
import { resolveCommanderPaths } from './paths.js'
import type { CommanderSessionStore } from './store.js'

export interface CommanderDeletionDependencies {
  commanderId: string
  commanderDataDir: string
  commanderBasePath: string
  observedMutationVersion: number
  sessionStore: Pick<CommanderSessionStore, 'delete'> & Partial<Pick<CommanderSessionStore, 'get'>>
  channelBindingStore?: { deleteForCommander(commanderId: string): Promise<number> }
  questStore?: { deleteForCommander(commanderId: string): Promise<void> }
  heartbeatLog?: { deleteForCommander(commanderId: string): Promise<void> }
  deleteChildren?: () => Promise<void>
  allowMissingSession?: boolean
}

export interface CommanderDeletionResult {
  leaseAcquired: boolean
  deleted: boolean
  error: unknown | null
}

export type CommanderOwnedDeletionDependencies = Omit<
  CommanderDeletionDependencies,
  'observedMutationVersion'
>

export interface CommanderOwnedDeletionResult {
  deleted: boolean
  error: unknown | null
}

/**
 * Removes commander state while the caller already owns the lifecycle lease.
 * This is the rollback primitive for provisioning: it deliberately performs
 * no nested coordinator acquisition and deletes the session last.
 */
export async function deleteCommanderStateOwned(
  options: CommanderOwnedDeletionDependencies,
): Promise<CommanderOwnedDeletionResult> {
  try {
    await options.deleteChildren?.()
    await options.channelBindingStore?.deleteForCommander(options.commanderId)
    await options.questStore?.deleteForCommander(options.commanderId)
    await options.heartbeatLog?.deleteForCommander(options.commanderId)

    const commanderRoots = new Set([
      resolveCommanderPaths(options.commanderId, options.commanderBasePath).commanderRoot,
      resolveCommanderPaths(options.commanderId, options.commanderDataDir).commanderRoot,
    ].map((root) => path.resolve(root)))
    for (const commanderRoot of commanderRoots) {
      await rm(commanderRoot, { recursive: true, force: true })
    }

    await deleteCommanderDisplayName(options.commanderDataDir, options.commanderId)
    const deleted = await withoutCommanderMutationOwnership(
      options.commanderId,
      options.commanderDataDir,
      () => options.sessionStore.delete(options.commanderId),
    )
    if (!deleted) {
      const missingSessionIsVerified = options.allowMissingSession === true
        && options.sessionStore.get !== undefined
        && await options.sessionStore.get(options.commanderId) === null
      if (!missingSessionIsVerified) {
        throw new Error(`Commander session "${options.commanderId}" disappeared during deletion`)
      }
    }
    return { deleted: true, error: null }
  } catch (error) {
    return { deleted: false, error }
  }
}

/**
 * Commits a commander deletion after a caller-owned final-state observation.
 * Every destructive child callback and every physical commander root is
 * removed while the lifecycle lease excludes normal writers. The session is
 * deleted last, so a failed cleanup leaves the durable parent anchor intact.
 */
export async function deleteCommanderStateWithLease(
  options: CommanderDeletionDependencies,
): Promise<CommanderDeletionResult> {
  const lease = await beginCommanderDeletion(
    options.commanderId,
    options.commanderDataDir,
    options.observedMutationVersion,
  )
  if (!lease) {
    return { leaseAcquired: false, deleted: false, error: null }
  }

  let deleted = false
  try {
    const result = await lease.runOwned(() => deleteCommanderStateOwned(options))
    deleted = result.deleted
    return { leaseAcquired: true, ...result }
  } finally {
    lease.complete({ deleted })
  }
}
