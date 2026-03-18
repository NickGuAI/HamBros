import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommanderHeartbeatManager,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_MESSAGE,
  createDefaultHeartbeatState,
  renderHeartbeatMessage,
} from '../heartbeat'

describe('heartbeat defaults', () => {
  it('returns issue defaults for new commander sessions', () => {
    expect(createDefaultHeartbeatState()).toEqual({
      intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      messageTemplate: DEFAULT_HEARTBEAT_MESSAGE,
      lastSentAt: null,
    })
  })

  it('renders heartbeat message with timestamp placeholder', () => {
    const timestamp = '2026-03-01T12:00:00.000Z'
    expect(renderHeartbeatMessage('[HB {{timestamp}}]', timestamp)).toBe(`[HB ${timestamp}]`)
  })
})

describe('CommanderHeartbeatManager', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends heartbeats at the configured interval', async () => {
    vi.useFakeTimers()

    const timestamps = [
      '2026-03-01T12:00:00.000Z',
      '2026-03-01T12:00:01.000Z',
    ]
    let index = 0

    const sendHeartbeat = vi.fn().mockResolvedValue(true)
    const onHeartbeatSent = vi.fn()
    const manager = new CommanderHeartbeatManager({
      now: () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]),
      sendHeartbeat,
      onHeartbeatSent,
    })

    manager.start('cmdr-1', {
      intervalMs: 10,
      messageTemplate: '[HB {{timestamp}}]',
    })

    await vi.advanceTimersByTimeAsync(20)

    expect(sendHeartbeat).toHaveBeenCalledTimes(2)
    expect(sendHeartbeat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        commanderId: 'cmdr-1',
        timestamp: '2026-03-01T12:00:00.000Z',
        renderedMessage: '[HB 2026-03-01T12:00:00.000Z]',
      }),
    )
    expect(onHeartbeatSent).toHaveBeenCalledTimes(2)

    manager.stopAll()
  })

  it('stops when sendHeartbeat reports commander is not running', async () => {
    vi.useFakeTimers()

    const sendHeartbeat = vi.fn().mockResolvedValue(false)
    const manager = new CommanderHeartbeatManager({
      sendHeartbeat,
    })

    manager.start('cmdr-2', {
      intervalMs: 10,
      messageTemplate: '[HB {{timestamp}}]',
    })

    await vi.advanceTimersByTimeAsync(10)
    expect(sendHeartbeat).toHaveBeenCalledTimes(1)
    expect(manager.isRunning('cmdr-2')).toBe(false)

    await vi.advanceTimersByTimeAsync(30)
    expect(sendHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('triggers pre-compaction flush when entry count crosses threshold', async () => {
    vi.useFakeTimers()

    const sendHeartbeat = vi.fn().mockResolvedValue(true)
    const sendFlushMessage = vi.fn().mockResolvedValue(true)
    const getConversationEntryCount = vi.fn().mockResolvedValue(850) // above 80% of 1000

    const manager = new CommanderHeartbeatManager({
      sendHeartbeat,
      preCompactionFlush: {
        getConversationEntryCount,
        sendFlushMessage,
      },
    })

    manager.start('cmdr-flush', {
      intervalMs: 10,
      messageTemplate: '[HB {{timestamp}}]',
    })

    await vi.advanceTimersByTimeAsync(10)

    expect(getConversationEntryCount).toHaveBeenCalledWith('cmdr-flush')
    expect(sendFlushMessage).toHaveBeenCalledTimes(1)
    expect(sendFlushMessage).toHaveBeenCalledWith('cmdr-flush', expect.stringContaining('Session nearing compaction'))

    // Second tick should NOT trigger flush again
    await vi.advanceTimersByTimeAsync(10)
    expect(sendFlushMessage).toHaveBeenCalledTimes(1)

    manager.stopAll()
  })

  it('does not trigger pre-compaction flush when below threshold', async () => {
    vi.useFakeTimers()

    const sendHeartbeat = vi.fn().mockResolvedValue(true)
    const sendFlushMessage = vi.fn().mockResolvedValue(true)
    const getConversationEntryCount = vi.fn().mockResolvedValue(50) // below threshold

    const manager = new CommanderHeartbeatManager({
      sendHeartbeat,
      preCompactionFlush: {
        getConversationEntryCount,
        sendFlushMessage,
      },
    })

    manager.start('cmdr-noflush', {
      intervalMs: 10,
      messageTemplate: '[HB {{timestamp}}]',
    })

    await vi.advanceTimersByTimeAsync(10)

    expect(getConversationEntryCount).toHaveBeenCalled()
    expect(sendFlushMessage).not.toHaveBeenCalled()

    manager.stopAll()
  })
})
