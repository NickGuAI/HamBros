import type { Sentinel, SentinelHistoryEntry } from './types.js'

interface AssemblePromptOptions {
  sentinel: Sentinel
  memoryContent: string
  resolvedSkills: Map<string, string>
  now: Date
  recentHistory?: SentinelHistoryEntry[]
}

function formatRecentHistory(history: SentinelHistoryEntry[]): string {
  if (history.length === 0) {
    return 'This is your first run. No prior history.'
  }

  return history
    .map((entry, index) => {
      const runNumber = history.length - index
      return [
        `### Run #${runNumber} - ${entry.timestamp}`,
        `Action: ${entry.action}`,
        `Result: ${entry.result}`,
      ].join('\n')
    })
    .join('\n\n')
}

function formatSkills(skills: Map<string, string>): string {
  if (skills.size === 0) {
    return 'No special skills configured.'
  }

  return [...skills.entries()]
    .map(([name, content]) => [
      `### Skill: ${name}`,
      content,
    ].join('\n'))
    .join('\n\n')
}

export function assemblePrompt({
  sentinel,
  memoryContent,
  resolvedSkills,
  now,
  recentHistory = sentinel.history.slice(0, 3),
}: AssemblePromptOptions): string {
  const runNumber = sentinel.totalRuns + 1
  const maxRunsLabel = sentinel.maxRuns ?? 'unlimited'
  const lastRunLabel = sentinel.lastRun ?? 'This is your first run.'

  return [
    `# Sentinel: ${sentinel.name}`,
    '',
    'You are a Sentinel - a focused agent that runs periodically to perform a specific recurring task.',
    'Execute the instruction, update memory when needed, write a run report, then exit.',
    '',
    '## Run Context',
    `- Run number: ${runNumber} of ${maxRunsLabel}`,
    `- Schedule: ${sentinel.schedule} (${sentinel.timezone ?? 'server default'})`,
    `- Current time: ${now.toISOString()}`,
    `- Last run: ${lastRunLabel}`,
    `- Parent commander: ${sentinel.parentCommanderId}`,
    `- Output directory: ${sentinel.outputDir}`,
    '',
    '## Memory',
    `Update memory via Write tool at: ${sentinel.memoryPath} whenever you learn durable facts.`,
    '---BEGIN MEMORY---',
    memoryContent.trim() || '(Memory file is empty.)',
    '---END MEMORY---',
    '',
    '## Recent Run History',
    formatRecentHistory(recentHistory),
    '',
    '## Available Skills',
    formatSkills(resolvedSkills),
    '',
    '## Instruction',
    sentinel.instruction,
    '',
    '## Output Requirements',
    '1. If you learned new facts, update memory.',
    `2. Write a markdown run report to ${sentinel.outputDir}/runs/<timestamp>.md.`,
    '3. End with exactly one JSON block:',
    '```json',
    '{',
    '  "action": "Brief description of what you did",',
    '  "result": "Outcome and key details",',
    '  "memoryUpdated": true',
    '}',
    '```',
  ].join('\n')
}
