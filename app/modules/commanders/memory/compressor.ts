import { SALIENCE_EMOJI, type JournalEntry } from './types.js'

function excerpt(value: string, maxLen = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  if (compact.length <= maxLen) return compact
  return `${compact.slice(0, maxLen - 1)}...`
}

function formatEntry(entry: JournalEntry): string {
  const emoji = SALIENCE_EMOJI[entry.salience]
  const timeStr = new Date(entry.timestamp).toISOString().slice(11, 16)
  const issueStr = entry.issueNumber != null ? ` (#${entry.issueNumber})` : ''
  const lines: string[] = [`## ${timeStr} — ${entry.outcome}${issueStr} ${emoji} ${entry.salience}`, '']
  if (entry.repo) lines.push(`**Repo:** ${entry.repo}`)
  lines.push(`**Outcome:** ${entry.outcome}`)
  if (entry.durationMin != null) lines.push(`**Duration:** ${entry.durationMin} min`)
  if (entry.body.trim()) {
    lines.push('')
    lines.push(entry.body.trim())
  }
  lines.push('', '---', '')
  return `${lines.join('\n')}\n`
}

function formatNotable(entry: JournalEntry, sentenceCount: 1 | 3): string {
  const emoji = SALIENCE_EMOJI[entry.salience]
  const timeStr = new Date(entry.timestamp).toISOString().slice(11, 16)
  const issueStr = entry.issueNumber != null ? ` (#${entry.issueNumber})` : ''
  const text = excerpt(entry.body || entry.outcome, sentenceCount === 1 ? 120 : 240)
  if (sentenceCount === 1) {
    return `## ${timeStr} — ${entry.outcome}${issueStr} ${emoji} ${entry.salience}\n\n- ${text}\n\n---\n\n`
  }
  return (
    `## ${timeStr} — ${entry.outcome}${issueStr} ${emoji} ${entry.salience}\n\n` +
    `- ${text}\n` +
    `${entry.repo ? `- Repo: ${entry.repo}\n` : ''}` +
    `${entry.durationMin != null ? `- Duration: ${entry.durationMin} min\n` : ''}` +
    '\n---\n\n'
  )
}

function formatSpikeSummary(entry: JournalEntry): string {
  const timeStr = new Date(entry.timestamp).toISOString().slice(11, 16)
  const issueStr = entry.issueNumber != null ? ` (#${entry.issueNumber})` : ''
  const summary = excerpt(entry.body || entry.outcome, 140)
  return (
    `## ${timeStr} — ${entry.outcome}${issueStr} 🔴 SPIKE\n\n` +
    `- Historical summary: ${summary}\n\n---\n\n`
  )
}

export class JournalCompressor {
  async compress(entry: JournalEntry, ageInDays: number): Promise<string | null> {
    if (ageInDays <= 7) return formatEntry(entry)

    if (ageInDays > 90) {
      if (entry.salience === 'SPIKE') return formatSpikeSummary(entry)
      return null
    }

    if (ageInDays > 30) {
      if (entry.salience === 'SPIKE') return formatEntry(entry)
      if (entry.salience === 'NOTABLE') return formatNotable(entry, 1)
      return null
    }

    if (entry.salience === 'SPIKE') return formatEntry(entry)
    if (entry.salience === 'NOTABLE') return formatNotable(entry, 3)
    return null
  }

  async buildWeeklySummary(routineEntries: JournalEntry[], weekOf: string): Promise<string> {
    const totalDuration = routineEntries.reduce((sum, entry) => sum + (entry.durationMin ?? 0), 0)
    const repoCounts = new Map<string, number>()
    for (const entry of routineEntries) {
      const repo = entry.repo ?? 'unknown'
      repoCounts.set(repo, (repoCounts.get(repo) ?? 0) + 1)
    }
    const topRepos = [...repoCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([repo, count]) => `${repo} (${count})`)
      .join(', ')
    const repoLine = topRepos ? ` | repos: ${topRepos}` : ''
    return `- Week of ${weekOf}: merged ${routineEntries.length} routine entries (${totalDuration} min)${repoLine}`
  }
}
