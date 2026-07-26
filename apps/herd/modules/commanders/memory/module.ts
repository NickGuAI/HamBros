import { mkdir } from 'node:fs/promises'
import { resolveCommanderDataDir, resolveCommanderPaths } from '../paths.js'
import { withCommanderMutation } from '../child-mutation-coordinator.js'
import { MemoryMdWriter } from './memory-md-writer.js'
import { withCommanderMemoryMutationLock } from './mutation-lock.js'
import {
  applyRemoteMemorySnapshot as applySnapshot,
  exportRemoteMemorySnapshot as exportSnapshot,
  advanceRemoteSyncRevision,
  type RemoteMemorySnapshot,
  type RemoteMemorySnapshotApplyResult,
} from './remote-sync.js'
import {
  buildCommanderSessionSeed,
  buildCommanderSessionSeedFromResolvedWorkflow,
  type CommanderSessionSeedParams,
} from './session-seed.js'
import { WorkingMemory } from './working-memory.js'
import type { ResolvedCommanderWorkflow } from '../workflow-resolution.js'

interface WorkingMemoryOperationOptions {
  now?: () => Date
}

function createWorkingMemory(
  commanderId: string,
  basePath?: string,
  options: WorkingMemoryOperationOptions = {},
): WorkingMemory {
  return new WorkingMemory(commanderId, basePath, options)
}

export {
  buildCommanderSessionSeed,
  buildCommanderSessionSeedFromResolvedWorkflow,
}
export type { CommanderSessionSeedParams, ResolvedCommanderWorkflow }
export type { RemoteMemorySnapshot, RemoteMemorySnapshotApplyResult }

export async function readWorkingMemory(
  commanderId: string,
  basePath?: string,
  options: WorkingMemoryOperationOptions = {},
): Promise<string> {
  return createWorkingMemory(commanderId, basePath, options).read()
}

export async function appendWorkingMemory(
  commanderId: string,
  content: string,
  basePath?: string,
  options: WorkingMemoryOperationOptions = {},
  lifecycleScope = basePath ?? resolveCommanderDataDir(),
): Promise<string> {
  return withCommanderMutation(commanderId, lifecycleScope, async () => {
    const workingMemory = createWorkingMemory(commanderId, basePath, options)
    await workingMemory.append(content)
    return workingMemory.read()
  })
}

export async function clearWorkingMemory(
  commanderId: string,
  basePath?: string,
  options: WorkingMemoryOperationOptions = {},
  lifecycleScope = basePath ?? resolveCommanderDataDir(),
): Promise<void> {
  await withCommanderMutation(commanderId, lifecycleScope, () => (
    createWorkingMemory(commanderId, basePath, options).clear()
  ))
}

export async function saveFacts(
  commanderId: string,
  facts: string[],
  basePath?: string,
  lifecycleScope = basePath ?? resolveCommanderDataDir(),
): Promise<{ factsAdded: number; lineCount: number }> {
  const memoryRoot = resolveCommanderPaths(commanderId, basePath).memoryRoot
  return withCommanderMutation(commanderId, lifecycleScope, () => (
    withCommanderMemoryMutationLock(commanderId, async () => {
      await mkdir(memoryRoot, { recursive: true })
      const writer = new MemoryMdWriter(memoryRoot)
      const next = await writer.updateFacts(facts)
      if (next.factsAdded > 0) {
        await advanceRemoteSyncRevision(memoryRoot)
      }
      return next
    })
  ))
}

export async function exportRemoteMemorySnapshot(
  commanderId: string,
  basePath?: string,
): Promise<RemoteMemorySnapshot> {
  const memoryRoot = resolveCommanderPaths(commanderId, basePath).memoryRoot
  return exportSnapshot(memoryRoot)
}

export async function applyRemoteMemorySnapshot(
  commanderId: string,
  baseRevision: number,
  memoryMd: string | undefined,
  basePath?: string,
  lifecycleScope = basePath ?? resolveCommanderDataDir(),
): Promise<RemoteMemorySnapshotApplyResult> {
  const memoryRoot = resolveCommanderPaths(commanderId, basePath).memoryRoot
  return withCommanderMutation(commanderId, lifecycleScope, () => (
    withCommanderMemoryMutationLock(commanderId, async () =>
      applySnapshot(memoryRoot, baseRevision, memoryMd))
  ))
}
