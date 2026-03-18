import { describe, expect, it } from 'vitest'
import {
  checkPreCompactionFlush,
  PRE_COMPACTION_FLUSH_MESSAGE,
  type PreCompactionFlushState,
} from '../pre-compaction-flush.js'

describe('checkPreCompactionFlush', () => {
  it('returns null when below threshold', () => {
    const state: PreCompactionFlushState = { flushed: false }
    const result = checkPreCompactionFlush(50, state)
    expect(result).toBeNull()
  })

  it('returns flush message when at 80% of default threshold (1000)', () => {
    const state: PreCompactionFlushState = { flushed: false }
    // Default threshold = 1000, 80% = 800
    const result = checkPreCompactionFlush(800, state)
    expect(result).toBe(PRE_COMPACTION_FLUSH_MESSAGE)
  })

  it('returns flush message when above threshold', () => {
    const state: PreCompactionFlushState = { flushed: false }
    const result = checkPreCompactionFlush(900, state)
    expect(result).toBe(PRE_COMPACTION_FLUSH_MESSAGE)
  })

  it('returns null when already flushed', () => {
    const state: PreCompactionFlushState = { flushed: true }
    const result = checkPreCompactionFlush(900, state)
    expect(result).toBeNull()
  })

  it('respects custom threshold and ratio', () => {
    const state: PreCompactionFlushState = { flushed: false }
    // threshold=100, ratio=0.5 → triggers at 50
    const result = checkPreCompactionFlush(50, state, {
      autoRotateThreshold: 100,
      flushRatio: 0.5,
    })
    expect(result).toBe(PRE_COMPACTION_FLUSH_MESSAGE)
  })

  it('returns null just below custom threshold', () => {
    const state: PreCompactionFlushState = { flushed: false }
    const result = checkPreCompactionFlush(49, state, {
      autoRotateThreshold: 100,
      flushRatio: 0.5,
    })
    expect(result).toBeNull()
  })

  it('does not re-trigger after first flush', () => {
    const state: PreCompactionFlushState = { flushed: false }

    // First check triggers
    const first = checkPreCompactionFlush(800, state)
    expect(first).toBe(PRE_COMPACTION_FLUSH_MESSAGE)

    // Simulate caller marking as flushed
    state.flushed = true

    // Second check should not trigger
    const second = checkPreCompactionFlush(999, state)
    expect(second).toBeNull()
  })
})
