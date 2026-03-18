import { readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveCommanderPaths } from '../paths.js'
import type { GoalEntry } from './types.js'

/**
 * Read/write GOALS.md with structured format.
 *
 * GOALS.md format:
 * ```
 * # Active Goals
 *
 * ## [goal-id] Goal Title
 * - **Target:** YYYY-MM-DD
 * - **Current state:** description
 * - **Intended state:** description
 * - **Reminders:**
 *   - reminder 1
 *   - reminder 2
 * ```
 */
export class GoalsStore {
  private readonly goalsPath: string

  constructor(
    commanderId: string,
    basePath?: string,
  ) {
    const { memoryRoot } = resolveCommanderPaths(commanderId, basePath)
    this.goalsPath = path.join(memoryRoot, 'GOALS.md')
  }

  async read(): Promise<GoalEntry[]> {
    let content: string
    try {
      content = await readFile(this.goalsPath, 'utf-8')
    } catch {
      return []
    }
    return parseGoalsMd(content)
  }

  async write(goals: GoalEntry[]): Promise<void> {
    const content = serializeGoalsMd(goals)
    await writeFile(this.goalsPath, content, 'utf-8')
  }

  /**
   * Build the context section for Layer 1.5.
   * Flags goals whose target date is before today with ⚠️ OVERDUE.
   */
  async buildContextSection(today?: string): Promise<string | null> {
    const goals = await this.read()
    if (goals.length === 0) return null

    const todayStr = today ?? new Date().toISOString().slice(0, 10)
    const lines: string[] = ['### Active Goals']

    for (const goal of goals) {
      const overdue = goal.targetDate < todayStr
      const prefix = overdue ? '⚠️ OVERDUE — ' : ''
      lines.push(`- ${prefix}**${goal.title}** (target: ${goal.targetDate})`)
      lines.push(`  Current: ${goal.currentState}`)
      lines.push(`  Intended: ${goal.intendedState}`)
      if (goal.reminders.length > 0) {
        for (const reminder of goal.reminders) {
          lines.push(`  - ${reminder}`)
        }
      }
    }

    return lines.join('\n')
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const GOAL_HEADING_RE = /^## \[([^\]]+)\] (.+)$/

export function parseGoalsMd(content: string): GoalEntry[] {
  const goals: GoalEntry[] = []
  const lines = content.split(/\r?\n/)

  let current: Partial<GoalEntry> | null = null

  for (const line of lines) {
    const headingMatch = line.match(GOAL_HEADING_RE)
    if (headingMatch) {
      if (current && current.id) {
        goals.push(finalizeGoal(current))
      }
      current = {
        id: headingMatch[1],
        title: headingMatch[2],
        reminders: [],
      }
      continue
    }

    if (!current) continue

    const targetMatch = line.match(/^- \*\*Target:\*\* (.+)$/)
    if (targetMatch) {
      current.targetDate = targetMatch[1].trim()
      continue
    }

    const currentStateMatch = line.match(/^- \*\*Current state:\*\* (.+)$/)
    if (currentStateMatch) {
      current.currentState = currentStateMatch[1].trim()
      continue
    }

    const intendedStateMatch = line.match(/^- \*\*Intended state:\*\* (.+)$/)
    if (intendedStateMatch) {
      current.intendedState = intendedStateMatch[1].trim()
      continue
    }

    const reminderMatch = line.match(/^ {2}- (.+)$/)
    if (reminderMatch && current.reminders) {
      current.reminders.push(reminderMatch[1].trim())
    }
  }

  if (current && current.id) {
    goals.push(finalizeGoal(current))
  }

  return goals
}

function finalizeGoal(partial: Partial<GoalEntry>): GoalEntry {
  return {
    id: partial.id ?? '',
    title: partial.title ?? '',
    targetDate: partial.targetDate ?? '',
    currentState: partial.currentState ?? '',
    intendedState: partial.intendedState ?? '',
    reminders: partial.reminders ?? [],
  }
}

// ── Serialization ────────────────────────────────────────────────────────────

export function serializeGoalsMd(goals: GoalEntry[]): string {
  const lines: string[] = ['# Active Goals', '']

  for (const goal of goals) {
    lines.push(`## [${goal.id}] ${goal.title}`)
    lines.push(`- **Target:** ${goal.targetDate}`)
    lines.push(`- **Current state:** ${goal.currentState}`)
    lines.push(`- **Intended state:** ${goal.intendedState}`)
    if (goal.reminders.length > 0) {
      lines.push('- **Reminders:**')
      for (const reminder of goal.reminders) {
        lines.push(`  - ${reminder}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}
