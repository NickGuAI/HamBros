/**
 * Choose between fat and thin heartbeat modes.
 *
 * - **Thin heartbeat**: rendered configured heartbeat message.
 * - **Fat heartbeat**: includes HEARTBEAT.md checklist appended after
 *   the rendered message.
 *
 * Mode selection is sync; message enrichment is async.
 */

import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveCommanderPaths } from './paths.js'

const DEFAULT_FAT_PIN_INTERVAL = 4

export type HeartbeatMode = 'fat' | 'thin'

export interface HeartbeatModeRuntime {
  heartbeatCount: number
  forceNextFatHeartbeat: boolean
}

export interface HeartbeatModeSession {
  contextConfig?: {
    fatPinInterval?: number
  }
}

export function resolveFatPinInterval(rawInterval: unknown): number {
  if (
    typeof rawInterval !== 'number' ||
    !Number.isInteger(rawInterval) ||
    rawInterval < 1
  ) {
    return DEFAULT_FAT_PIN_INTERVAL
  }

  return rawInterval
}

/**
 * Choose heartbeat mode (fat vs thin) based on runtime and session.
 * Caller uses this to decide mode; for fat mode, also call buildFatHeartbeatMessage
 * to append HEARTBEAT.md checklist.
 */
export function chooseHeartbeatMode(
  runtime: HeartbeatModeRuntime,
  session: HeartbeatModeSession,
  _agentSession?: unknown,
): HeartbeatMode {
  const fatPinInterval = resolveFatPinInterval(session.contextConfig?.fatPinInterval)

  if (runtime.heartbeatCount === 0) {
    return 'fat'
  }

  if (runtime.forceNextFatHeartbeat) {
    return 'fat'
  }

  if (runtime.heartbeatCount % fatPinInterval === 0) {
    return 'fat'
  }

  return 'thin'
}

/**
 * Build the fat heartbeat message by appending HEARTBEAT.md contents
 * to the base message. Returns `null` if HEARTBEAT.md does not exist.
 */
export async function buildFatHeartbeatMessage(
  baseMessage: string,
  commanderId: string,
  basePath?: string,
): Promise<string | null> {
  const { memoryRoot } = resolveCommanderPaths(commanderId, basePath)
  const heartbeatMdPath = path.join(memoryRoot, 'HEARTBEAT.md')

  let content: string
  try {
    content = await readFile(heartbeatMdPath, 'utf-8')
  } catch {
    return null
  }

  const trimmed = content.trim()
  if (!trimmed) return null

  return `${baseMessage}\n\nRead and follow the checklist below:\n\n${trimmed}`
}
