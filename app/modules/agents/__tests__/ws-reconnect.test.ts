import { describe, expect, it } from 'vitest'
import { createReconnectBackoff, shouldReconnectWebSocketClose } from '../ws-reconnect'

describe('createReconnectBackoff', () => {
  it('grows exponentially and caps at max delay', () => {
    const backoff = createReconnectBackoff({
      initialDelayMs: 100,
      maxDelayMs: 450,
      multiplier: 2,
      jitterRatio: 0,
    })

    expect(backoff.nextDelayMs()).toBe(100)
    expect(backoff.nextDelayMs()).toBe(200)
    expect(backoff.nextDelayMs()).toBe(400)
    expect(backoff.nextDelayMs()).toBe(450)
    expect(backoff.nextDelayMs()).toBe(450)
    expect(backoff.attempts()).toBe(5)
  })

  it('resets attempt counter after successful reconnect', () => {
    const backoff = createReconnectBackoff({
      initialDelayMs: 120,
      maxDelayMs: 1000,
      multiplier: 2,
      jitterRatio: 0,
    })

    backoff.nextDelayMs()
    backoff.nextDelayMs()
    expect(backoff.attempts()).toBe(2)

    backoff.reset()

    expect(backoff.attempts()).toBe(0)
    expect(backoff.nextDelayMs()).toBe(120)
  })
})

describe('shouldReconnectWebSocketClose', () => {
  it('does not reconnect when the session is intentionally gone', () => {
    expect(shouldReconnectWebSocketClose({ code: 1000, reason: 'Session ended' })).toBe(false)
    expect(shouldReconnectWebSocketClose({ code: 1000, reason: 'Session killed' })).toBe(false)
    expect(shouldReconnectWebSocketClose({ code: 4004, reason: 'Session not found' })).toBe(false)
  })

  it('reconnects for transient network closures', () => {
    expect(shouldReconnectWebSocketClose({ code: 1006 })).toBe(true)
    expect(shouldReconnectWebSocketClose({ code: 1011, reason: 'upstream failure' })).toBe(true)
  })
})
