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

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000
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

export interface CommanderHeartbeatManagerOptions {
  now?: () => Date
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

  private async tick(commanderId: string): Promise<void> {
    const loop = this.loops.get(commanderId)
    if (!loop || loop.inFlight) {
      return
    }

    loop.inFlight = true
    const timestamp = this.now().toISOString()
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
    } finally {
      const current = this.loops.get(commanderId)
      if (current) {
        current.inFlight = false
      }
    }
  }
}
