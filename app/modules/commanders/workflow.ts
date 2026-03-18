import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const COMMANDER_WORKFLOW_FILE = 'COMMANDER.md'
const MAX_WORKFLOW_TURNS = 10

export interface CommanderWorkflow {
  heartbeatInterval?: string
  heartbeatMessage?: string
  maxTurns?: number
  systemPromptTemplate?: string
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null
  }
  return parsed
}

function parseQuotedScalar(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function applyKnownKey(
  workflow: CommanderWorkflow,
  key: string,
  rawValue: string,
): void {
  const value = parseQuotedScalar(rawValue)
  if (!value) {
    return
  }

  if (key === 'heartbeat.interval') {
    workflow.heartbeatInterval = value
    return
  }

  if (key === 'heartbeat.message') {
    workflow.heartbeatMessage = value
    return
  }

  if (key === 'maxTurns') {
    const parsedTurns = parsePositiveInt(value)
    if (parsedTurns !== null) {
      workflow.maxTurns = Math.min(parsedTurns, MAX_WORKFLOW_TURNS)
    }
    return
  }

}

function parseFrontMatter(frontMatter: string): CommanderWorkflow {
  const workflow: CommanderWorkflow = {}

  for (const rawLine of frontMatter.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*:\s*(.+)$/)
    if (!match) {
      continue
    }

    const key = match[1]
    const rawValue = match[2] ?? ''
    applyKnownKey(workflow, key, rawValue)
  }

  return workflow
}

function parseCommanderWorkflowContent(content: string): CommanderWorkflow {
  const normalized = content.replace(/\r\n/g, '\n')
  const frontMatterMatch = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/)

  if (!frontMatterMatch) {
    const trimmed = normalized.trim()
    return trimmed.length > 0 ? { systemPromptTemplate: trimmed } : {}
  }

  const [, frontMatter, body] = frontMatterMatch
  const workflow = parseFrontMatter(frontMatter)
  const bodyTemplate = body.trim()
  if (bodyTemplate.length > 0) {
    workflow.systemPromptTemplate = bodyTemplate
  }
  return workflow
}

export async function loadCommanderWorkflow(cwd: string): Promise<CommanderWorkflow | null> {
  const workflowPath = path.join(cwd, COMMANDER_WORKFLOW_FILE)
  let content: string
  try {
    content = await readFile(workflowPath, 'utf-8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  return parseCommanderWorkflowContent(content)
}
