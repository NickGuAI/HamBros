import { describe, expect, it } from 'vitest'
import { resolveCommandRoomMonitorOptions } from '../module-registry.js'

describe('resolveCommandRoomMonitorOptions', () => {
  it('defaults command-room monitoring to a 30 minute stale-session window', () => {
    expect(resolveCommandRoomMonitorOptions({})).toEqual({
      pollIntervalMs: 5_000,
      maxPollAttempts: 360,
    })
  })

  it('derives max poll attempts from env overrides and ignores invalid values', () => {
    expect(resolveCommandRoomMonitorOptions({
      HAMBROS_COMMAND_ROOM_POLL_INTERVAL_MS: '2000',
      HAMBROS_COMMAND_ROOM_STALE_SESSION_TTL_MINUTES: '45',
    })).toEqual({
      pollIntervalMs: 2_000,
      maxPollAttempts: 1_350,
    })

    expect(resolveCommandRoomMonitorOptions({
      HAMBROS_COMMAND_ROOM_POLL_INTERVAL_MS: '0',
      HAMBROS_COMMAND_ROOM_STALE_SESSION_TTL_MINUTES: '-1',
    })).toEqual({
      pollIntervalMs: 5_000,
      maxPollAttempts: 360,
    })
  })
})
