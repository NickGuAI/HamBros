import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveCommanderDataDir, resolveCommanderPaths } from './paths.js'
import { beginCommanderRuntimeActivity } from './child-mutation-coordinator.js'

const PACKAGE_INSTALL_STATE_FILE = 'install-state.json'

export class CommanderPackageRemovalPendingError extends Error {
  constructor(commanderId: string) {
    super(
      `Commander "${commanderId}" has an incomplete package removal and cannot launch runtime child state until recovery completes`,
    )
    this.name = 'CommanderPackageRemovalPendingError'
  }
}

export class CommanderPackageLifecycleCorruptError extends Error {
  constructor(commanderId: string) {
    super(
      `Commander "${commanderId}" has an invalid package lifecycle marker and cannot launch runtime child state until recovery completes`,
    )
    this.name = 'CommanderPackageLifecycleCorruptError'
  }
}

export type CommanderPackageLifecycleState = 'absent' | 'complete' | 'removing' | 'corrupt'

function installStatePath(commanderId: string, commanderDataDir: string): string | null {
  try {
    return path.join(
      resolveCommanderPaths(commanderId, commanderDataDir).commanderRoot,
      '.package',
      PACKAGE_INSTALL_STATE_FILE,
    )
  } catch {
    // Historical tests and non-persisted integrations may use synthetic IDs.
    // Package-installed commanders are UUID-backed, so no durable package
    // lifecycle marker can exist for an invalid commander path.
    return null
  }
}

/**
 * Reads the durable package-removal admission gate used after process restart.
 * The in-memory mutation coordinator protects a live process; this marker
 * prevents retained channel/provider records from relaunching while a failed
 * cleanup is waiting to be reconciled.
 */
export async function readCommanderPackageLifecycleState(
  commanderId: string,
  commanderDataDir: string = resolveCommanderDataDir(),
): Promise<CommanderPackageLifecycleState> {
  const markerPath = installStatePath(commanderId, commanderDataDir)
  if (!markerPath) {
    return 'absent'
  }
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'corrupt'
    }
    const marker = parsed as Record<string, unknown>
    const validAutomations = Array.isArray(marker.automations)
      && marker.automations.every((automation) => {
        if (!automation || typeof automation !== 'object' || Array.isArray(automation)) {
          return false
        }
        const record = automation as Record<string, unknown>
        return typeof record.id === 'string'
          && record.id.length > 0
          && typeof record.templateId === 'string'
          && record.templateId.length > 0
      })
    const valid = marker.schemaVersion === 1
      && (marker.state === 'complete' || marker.state === 'removing')
      && typeof marker.installId === 'string'
      && marker.installId.length > 0
      && typeof marker.packageId === 'string'
      && marker.packageId.length > 0
      && typeof marker.packageVersion === 'string'
      && marker.packageVersion.length > 0
      && marker.commanderId === commanderId
      && typeof marker.completedAt === 'string'
      && (marker.conversationId === null || typeof marker.conversationId === 'string')
      && validAutomations
    return valid ? marker.state as 'complete' | 'removing' : 'corrupt'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent'
    }
    if (error instanceof SyntaxError) {
      return 'corrupt'
    }
    throw error
  }
}

export async function isCommanderPackageRemovalPending(
  commanderId: string,
  commanderDataDir: string = resolveCommanderDataDir(),
): Promise<boolean> {
  const state = await readCommanderPackageLifecycleState(commanderId, commanderDataDir)
  return state === 'removing' || state === 'corrupt'
}

export async function assertCommanderRuntimeLaunchAllowed(
  commanderId: string,
  commanderDataDir: string = resolveCommanderDataDir(),
): Promise<void> {
  const state = await readCommanderPackageLifecycleState(commanderId, commanderDataDir)
  if (state === 'removing') {
    throw new CommanderPackageRemovalPendingError(commanderId)
  }
  if (state === 'corrupt') {
    throw new CommanderPackageLifecycleCorruptError(commanderId)
  }
}

/**
 * Canonical source-boundary guard for commander-owned runtime activity.
 * Provider calls can cross a process boundary before rejecting, so an
 * attempted operation always commits the child generation and only rethrows
 * after the mutation lease is released.
 */
export async function withCommanderRuntimeLaunch<T>(
  commanderId: string,
  commanderDataDir: string = resolveCommanderDataDir(),
  operation: () => Promise<T>,
): Promise<T> {
  const activity = await beginCommanderRuntimeActivity(commanderId, commanderDataDir)
  try {
    await assertCommanderRuntimeLaunchAllowed(commanderId, commanderDataDir)
    return await operation()
  } finally {
    await activity.complete()
  }
}
