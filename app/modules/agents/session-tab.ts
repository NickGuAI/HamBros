export type SessionTab = 'all' | 'commander' | 'regular' | 'other'

export const DEFAULT_SESSION_TAB: SessionTab = 'commander'

export const SESSION_TABS: SessionTab[] = [
  'all',
  'commander',
  'regular',
  'other',
]

function matchesSessionTabName(sessionName: string, tab: SessionTab): boolean {
  if (tab === 'commander') return sessionName.startsWith('commander-')
  if (tab === 'regular') return (
    !sessionName.startsWith('commander-') &&
    !sessionName.startsWith('factory-') &&
    !sessionName.startsWith('command-room-')
  )
  if (tab === 'other') return (
    sessionName.startsWith('factory-') ||
    sessionName.startsWith('command-room-')
  )
  return true
}

export function filterSessionsByTab<T extends { name: string }>(
  sessions: T[],
  tab: SessionTab,
): T[] {
  return sessions.filter((session) => matchesSessionTabName(session.name, tab))
}
