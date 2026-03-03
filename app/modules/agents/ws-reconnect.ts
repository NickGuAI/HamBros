const DEFAULT_INITIAL_DELAY_MS = 400
const DEFAULT_MAX_DELAY_MS = 8000
const DEFAULT_MULTIPLIER = 2
const DEFAULT_JITTER_RATIO = 0.25

export interface ReconnectBackoffOptions {
  initialDelayMs?: number
  maxDelayMs?: number
  multiplier?: number
  jitterRatio?: number
  random?: () => number
}

export interface WebSocketCloseLike {
  code: number
  reason?: string
}

export interface ReconnectBackoff {
  nextDelayMs(): number
  reset(): void
  attempts(): number
}

export function createReconnectBackoff(options: ReconnectBackoffOptions = {}): ReconnectBackoff {
  const initialDelayMs = normalizePositiveNumber(options.initialDelayMs, DEFAULT_INITIAL_DELAY_MS)
  const maxDelayMs = normalizePositiveNumber(options.maxDelayMs, DEFAULT_MAX_DELAY_MS)
  const multiplier = normalizePositiveNumber(options.multiplier, DEFAULT_MULTIPLIER)
  const jitterRatio = normalizeNonNegativeNumber(options.jitterRatio, DEFAULT_JITTER_RATIO)
  const random = options.random ?? Math.random

  let attemptCount = 0

  return {
    nextDelayMs() {
      const exponential = initialDelayMs * multiplier ** attemptCount
      const baseDelay = Math.min(maxDelayMs, exponential)
      attemptCount += 1
      return applyJitter(baseDelay, jitterRatio, random)
    },
    reset() {
      attemptCount = 0
    },
    attempts() {
      return attemptCount
    },
  }
}

export function shouldReconnectWebSocketClose(close: WebSocketCloseLike): boolean {
  if (close.code === 4004) {
    return false
  }

  if (close.code === 1000 && (close.reason === 'Session ended' || close.reason === 'Session killed')) {
    return false
  }

  return true
}

function applyJitter(baseDelayMs: number, jitterRatio: number, random: () => number): number {
  if (jitterRatio <= 0) {
    return Math.round(baseDelayMs)
  }

  const clampedRatio = Math.min(jitterRatio, 1)
  const spread = baseDelayMs * clampedRatio
  const min = Math.max(0, baseDelayMs - spread)
  const max = baseDelayMs + spread
  const jittered = min + (max - min) * random()
  return Math.round(jittered)
}

function normalizePositiveNumber(rawValue: number | undefined, fallback: number): number {
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || rawValue <= 0) {
    return fallback
  }
  return rawValue
}

function normalizeNonNegativeNumber(rawValue: number | undefined, fallback: number): number {
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || rawValue < 0) {
    return fallback
  }
  return rawValue
}
