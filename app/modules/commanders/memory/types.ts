// All shared TypeScript types for the Commander memory system.
// Other memory splits (2-7) import from here.

export type SalienceLevel = 'SPIKE' | 'NOTABLE' | 'ROUTINE'

export const SALIENCE_EMOJI: Record<SalienceLevel, string> = {
  SPIKE: '🔴',
  NOTABLE: '🟡',
  ROUTINE: '⚪',
}

export interface JournalEntry {
  timestamp: string // ISO 8601
  issueNumber: number | null
  repo: string | null
  outcome: string
  durationMin: number | null
  salience: SalienceLevel
  body: string // Full markdown entry body
}

export type SalienceSignalType =
  | 'user-correction'
  | 'novel-failure'
  | 'architecture-decision'
  | 'multi-pivot-investigation'
  | 'subagent-failure'
  | 'new-repo'
  | 'nontrivial-completion'
  | 'pattern-confirmed'
  | 'new-convention'
  | 'standard-completion'

export interface SalienceSignal {
  type: SalienceSignalType
  detail?: string
}

// Signals that trigger SPIKE level (any one is sufficient)
export const SPIKE_SIGNALS: SalienceSignalType[] = [
  'user-correction',
  'novel-failure',
  'architecture-decision',
  'multi-pivot-investigation',
  'subagent-failure',
  'new-repo',
]

// Signals that trigger NOTABLE level when no SPIKE is present
export const NOTABLE_SIGNALS: SalienceSignalType[] = [
  'nontrivial-completion',
  'pattern-confirmed',
  'new-convention',
]

/** Derive the SalienceLevel from a list of observed signals. */
export function deriveSalience(signals: SalienceSignal[]): SalienceLevel {
  const types = signals.map((s) => s.type)
  if (types.some((t) => SPIKE_SIGNALS.includes(t))) return 'SPIKE'
  if (types.some((t) => NOTABLE_SIGNALS.includes(t))) return 'NOTABLE'
  return 'ROUTINE'
}
