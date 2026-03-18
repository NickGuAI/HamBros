import {
  checkPreCompactionFlush,
  type PreCompactionFlushState,
} from './memory/pre-compaction-flush.js'

export interface HeartbeatConfig {
  intervalMs: number
  messageTemplate: string
}

export interface CommanderHeartbeatState extends HeartbeatConfig {
  lastSentAt: string | null
}

export interface HeartbeatConfigPatch {
  intervalMs?: number
  messageTemplate?: string
}

export type HeartbeatPatchParseResult =
  | {
      ok: true
      value: HeartbeatConfigPatch
    }
  | {
      ok: false
      error: string
    }

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000
export const DEFAULT_HEARTBEAT_MESSAGE = `[HEARTBEAT {{timestamp}}]
Check your task list. Current status? What needs to be done next?
If current task is complete, mark it done and pick up the next one.`

const MIN_HEARTBEAT_INTERVAL_MS = 1

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseIntervalMs(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null
  }

  const normalized = Math.floor(raw)
  if (normalized < MIN_HEARTBEAT_INTERVAL_MS) {
    return null
  }

  return normalized
}

function parseMessageTemplate(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  return trimmed
}

function parseLastSentAt(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  return trimmed || null
}

export function createDefaultHeartbeatState(): CommanderHeartbeatState {
  return {
    intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    messageTemplate: DEFAULT_HEARTBEAT_MESSAGE,
    lastSentAt: null,
  }
}

export function normalizeHeartbeatState(
  raw: unknown,
  fallbackLastSentAt: string | null = null,
): CommanderHeartbeatState {
  const defaults = createDefaultHeartbeatState()

  if (!isObject(raw)) {
    return {
      ...defaults,
      lastSentAt: fallbackLastSentAt,
    }
  }

  return {
    intervalMs: parseIntervalMs(raw.intervalMs) ?? defaults.intervalMs,
    messageTemplate: parseMessageTemplate(raw.messageTemplate) ?? defaults.messageTemplate,
    lastSentAt: parseLastSentAt(raw.lastSentAt) ?? fallbackLastSentAt,
  }
}

export function mergeHeartbeatState(
  current: CommanderHeartbeatState,
  patch: HeartbeatConfigPatch,
): CommanderHeartbeatState {
  return {
    intervalMs: patch.intervalMs ?? current.intervalMs,
    messageTemplate: patch.messageTemplate ?? current.messageTemplate,
    lastSentAt: current.lastSentAt,
  }
}

export function parseHeartbeatPatch(raw: unknown): HeartbeatPatchParseResult {
  if (!isObject(raw)) {
    return { ok: false, error: 'Invalid heartbeat payload' }
  }

  let intervalMs: number | undefined
  if (raw.intervalMs !== undefined) {
    const parsedIntervalMs = parseIntervalMs(raw.intervalMs)
    if (parsedIntervalMs === null) {
      return {
        ok: false,
        error: `intervalMs must be an integer >= ${MIN_HEARTBEAT_INTERVAL_MS}`,
      }
    }
    intervalMs = parsedIntervalMs
  }

  let messageTemplate: string | undefined
  if (raw.messageTemplate !== undefined) {
    const parsedMessageTemplate = parseMessageTemplate(raw.messageTemplate)
    if (parsedMessageTemplate === null) {
      return { ok: false, error: 'messageTemplate must be a non-empty string' }
    }
    messageTemplate = parsedMessageTemplate
  }

  if (intervalMs === undefined && messageTemplate === undefined) {
    return { ok: false, error: 'At least one heartbeat field must be provided' }
  }

  return {
    ok: true,
    value: {
      intervalMs,
      messageTemplate,
    },
  }
}

export function renderHeartbeatMessage(
  messageTemplate: string,
  timestamp: string,
): string {
  return messageTemplate.split('{{timestamp}}').join(timestamp)
}

export interface PreCompactionFlushHook {
  /**
   * Return the conversation entry count for this commander's active session.
   * Return `null` if entry count is unavailable (flush will be skipped).
   */
  getConversationEntryCount(commanderId: string): Promise<number | null> | number | null

  /**
   * Called when the flush message should be sent to the session.
   * Return `true` if the message was sent successfully.
   */
  sendFlushMessage(commanderId: string, message: string): Promise<boolean> | boolean
}

export interface CommanderHeartbeatManagerOptions {
  now?: () => Date
  preCompactionFlush?: PreCompactionFlushHook
  sendHeartbeat(input: {
    commanderId: string
    renderedMessage: string
    timestamp: string
    config: HeartbeatConfig
  }): Promise<boolean>
  onHeartbeatSent?(input: {
    commanderId: string
    timestamp: string
    config: HeartbeatConfig
  }): Promise<void> | void
  onHeartbeatError?(input: {
    commanderId: string
    error: unknown
  }): void
}

interface HeartbeatLoop {
  timer: ReturnType<typeof setInterval>
  config: HeartbeatConfig
  inFlight: boolean
  preCompactionFlushed: boolean
}

function normalizeHeartbeatConfig(config: HeartbeatConfig): HeartbeatConfig {
  return {
    intervalMs: parseIntervalMs(config.intervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    messageTemplate: parseMessageTemplate(config.messageTemplate) ?? DEFAULT_HEARTBEAT_MESSAGE,
  }
}

export class CommanderHeartbeatManager {
  private readonly loops = new Map<string, HeartbeatLoop>()
  private readonly now: () => Date

  constructor(private readonly options: CommanderHeartbeatManagerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  start(commanderId: string, config: HeartbeatConfig): void {
    this.stop(commanderId)

    const normalized = normalizeHeartbeatConfig(config)
    const timer = setInterval(() => {
      void this.tick(commanderId)
    }, normalized.intervalMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }

    const loop: HeartbeatLoop = {
      config: normalized,
      inFlight: false,
      timer,
      preCompactionFlushed: false,
    }

    this.loops.set(commanderId, loop)
  }

  updateConfig(commanderId: string, config: HeartbeatConfig): void {
    if (!this.isRunning(commanderId)) {
      return
    }

    this.start(commanderId, config)
  }

  stop(commanderId: string): void {
    const loop = this.loops.get(commanderId)
    if (!loop) {
      return
    }

    clearInterval(loop.timer)
    this.loops.delete(commanderId)
  }

  stopAll(): void {
    for (const commanderId of this.loops.keys()) {
      this.stop(commanderId)
    }
  }

  isRunning(commanderId: string): boolean {
    return this.loops.has(commanderId)
  }

  isInFlight(commanderId: string): boolean {
    return this.loops.get(commanderId)?.inFlight ?? false
  }

  fireManual(commanderId: string, timestamp: string = this.now().toISOString()): boolean {
    const loop = this.loops.get(commanderId)
    if (!loop || loop.inFlight) {
      return false
    }

    this.launchHeartbeat(commanderId, loop, timestamp)
    return true
  }

  private tick(commanderId: string): void {
    const loop = this.loops.get(commanderId)
    if (!loop || loop.inFlight) {
      return
    }

    const timestamp = this.now().toISOString()
    this.launchHeartbeat(commanderId, loop, timestamp)
  }

  private launchHeartbeat(commanderId: string, loop: HeartbeatLoop, timestamp: string): void {
    loop.inFlight = true
    void this.dispatchHeartbeat(commanderId, loop, timestamp).finally(() => {
      const current = this.loops.get(commanderId)
      if (current === loop) {
        current.inFlight = false
      }
    })
  }

  private async dispatchHeartbeat(
    commanderId: string,
    loop: HeartbeatLoop,
    timestamp: string,
  ): Promise<void> {
    // Pre-compaction flush: check if session is nearing context compaction
    if (this.options.preCompactionFlush && !loop.preCompactionFlushed) {
      try {
        const entryCount = await this.options.preCompactionFlush.getConversationEntryCount(commanderId)
        if (entryCount != null) {
          const flushState: PreCompactionFlushState = { flushed: loop.preCompactionFlushed }
          const flushMsg = checkPreCompactionFlush(entryCount, flushState)
          if (flushMsg) {
            const sent = await this.options.preCompactionFlush.sendFlushMessage(commanderId, flushMsg)
            if (sent) loop.preCompactionFlushed = true
          }
        }
      } catch {
        // Non-fatal: pre-compaction flush is best-effort
      }
    }

    const renderedMessage = renderHeartbeatMessage(loop.config.messageTemplate, timestamp)
    try {
      const sent = await this.options.sendHeartbeat({
        commanderId,
        renderedMessage,
        timestamp,
        config: loop.config,
      })

      if (!sent) {
        this.stop(commanderId)
        return
      }

      await this.options.onHeartbeatSent?.({
        commanderId,
        timestamp,
        config: loop.config,
      })
    } catch (error) {
      this.options.onHeartbeatError?.({ commanderId, error })
    }
  }
}
