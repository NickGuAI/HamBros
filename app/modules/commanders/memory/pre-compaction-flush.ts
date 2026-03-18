/**
 * Pre-compaction flush: when a session nears the auto-rotate threshold,
 * inject a silent system message prompting the commander to persist
 * durable observations before context is lost.
 */

export interface PreCompactionFlushOptions {
  /** Auto-rotate threshold (total conversation entries). */
  autoRotateThreshold?: number
  /** Fraction of threshold at which flush triggers (0-1). Default 0.8. */
  flushRatio?: number
}

export interface PreCompactionFlushState {
  /** Whether the flush has already been triggered this session. */
  flushed: boolean
}

const DEFAULT_AUTO_ROTATE_THRESHOLD = 1000
const DEFAULT_FLUSH_RATIO = 0.8

export const PRE_COMPACTION_FLUSH_MESSAGE =
  'Session nearing compaction. Write any durable observations to your journal now. Reply NO_REPLY if nothing to store.'

/**
 * Check whether the pre-compaction flush should trigger.
 *
 * Returns the flush message if threshold is crossed and flush has not
 * already fired, or `null` otherwise. Caller is responsible for sending
 * the message and setting `state.flushed = true`.
 */
export function checkPreCompactionFlush(
  conversationEntryCount: number,
  state: PreCompactionFlushState,
  options?: PreCompactionFlushOptions,
): string | null {
  if (state.flushed) return null

  const threshold = options?.autoRotateThreshold ?? DEFAULT_AUTO_ROTATE_THRESHOLD
  const ratio = options?.flushRatio ?? DEFAULT_FLUSH_RATIO
  const triggerAt = Math.floor(threshold * ratio)

  if (conversationEntryCount >= triggerAt) {
    return PRE_COMPACTION_FLUSH_MESSAGE
  }

  return null
}
