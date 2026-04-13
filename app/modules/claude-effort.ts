export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number]

export const DEFAULT_CLAUDE_EFFORT_LEVEL: ClaudeEffortLevel = 'max'

export function isClaudeEffortLevel(value: unknown): value is ClaudeEffortLevel {
  return CLAUDE_EFFORT_LEVELS.includes(value as ClaudeEffortLevel)
}

export function parseOptionalClaudeEffort(
  value: unknown,
): ClaudeEffortLevel | undefined | null {
  if (value === undefined || value === null) {
    return undefined
  }
  return isClaudeEffortLevel(value) ? value : null
}

export function normalizeClaudeEffortLevel(
  value: unknown,
  fallback: ClaudeEffortLevel = DEFAULT_CLAUDE_EFFORT_LEVEL,
): ClaudeEffortLevel {
  return isClaudeEffortLevel(value) ? value : fallback
}
