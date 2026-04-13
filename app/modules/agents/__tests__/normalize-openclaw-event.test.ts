import { describe, expect, it } from 'vitest'
import { normalizeOpenClawEvent } from '../normalize-openclaw-event'

describe('normalizeOpenClawEvent', () => {
  it('attaches the openclaw source envelope to passthrough events', () => {
    expect(normalizeOpenClawEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
      sessionKey: 'hammurabi-demo',
    })).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
      sessionKey: 'hammurabi-demo',
      source: { provider: 'openclaw', backend: 'gateway' },
    })

    expect(normalizeOpenClawEvent({
      type: 'result',
      result: 'done',
    })).toEqual({
      type: 'result',
      result: 'done',
      source: { provider: 'openclaw', backend: 'gateway' },
    })
  })

  it('maps thinking events into replay-safe content deltas with source metadata', () => {
    expect(normalizeOpenClawEvent({
      type: 'thinking_delta',
      delta: { thinking: 'pondering' },
    })).toEqual({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'pondering' },
      source: { provider: 'openclaw', backend: 'gateway' },
    })

    expect(normalizeOpenClawEvent({
      type: 'thinking_start',
      thinking: 'opening thought',
    })).toEqual({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'opening thought' },
      source: { provider: 'openclaw', backend: 'gateway' },
    })
  })

  it('keeps result-family events replay-compatible and drops malformed deltas', () => {
    expect(normalizeOpenClawEvent({
      type: 'done',
      result: 'all set',
    })).toEqual({
      type: 'result',
      result: 'all set',
      source: { provider: 'openclaw', backend: 'gateway' },
    })

    expect(normalizeOpenClawEvent({
      type: 'content_block_delta',
    })).toBeNull()
  })
})
