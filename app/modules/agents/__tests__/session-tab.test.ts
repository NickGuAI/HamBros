import { describe, expect, it } from 'vitest'
import { DEFAULT_SESSION_TAB, filterSessionsByTab } from '../session-tab'

type SessionFixture = { name: string }

const FIXTURES: SessionFixture[] = [
  { name: 'commander-alpha' },
  { name: 'factory-beta' },
  { name: 'command-room-gamma' },
  { name: 'session-plain' },
  { name: 'commander' },
]

describe('session tab helpers', () => {
  it('uses commander as the default tab', () => {
    expect(DEFAULT_SESSION_TAB).toBe('commander')
  })

  it('commander filter returns only commander sessions', () => {
    expect(filterSessionsByTab(FIXTURES, 'commander').map((s) => s.name)).toEqual([
      'commander-alpha',
    ])
  })

  it('regular filter excludes factory/command-room/commander prefixes and keeps non-prefixed sessions', () => {
    expect(filterSessionsByTab(FIXTURES, 'regular').map((s) => s.name)).toEqual([
      'session-plain',
      'commander',
    ])
  })

  it('all filter returns all sessions', () => {
    expect(filterSessionsByTab(FIXTURES, 'all')).toEqual(FIXTURES)
  })
})
