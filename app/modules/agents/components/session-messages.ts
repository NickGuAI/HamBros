import type { AskQuestion } from '@/types'

export const MAX_CLIENT_MESSAGES = 500
export const SUBAGENT_WORKING_LABEL = 'subagent working…'

export interface MsgItem {
  id: string
  kind: 'system' | 'user' | 'thinking' | 'agent' | 'tool' | 'ask'
  text: string
  timestamp?: string
  children?: MsgItem[]
  // user message image attachments
  images?: { mediaType: string; data: string }[]
  // tool-specific
  toolId?: string
  toolName?: string
  toolFile?: string
  toolStatus?: 'running' | 'success' | 'error'
  toolInput?: string
  toolOutput?: string
  subagentDescription?: string
  // diff for Edit tool
  oldString?: string
  newString?: string
  // ask-specific (kind === 'ask')
  askQuestions?: AskQuestion[]
  askAnswered?: boolean
  askSubmitting?: boolean
}

/** Cap an array of messages to prevent unbounded memory growth. */
export function capMessages(msgs: MsgItem[]): MsgItem[] {
  return msgs.length > MAX_CLIENT_MESSAGES ? msgs.slice(-MAX_CLIENT_MESSAGES) : msgs
}

export function extractToolDetails(
  toolName: string | undefined,
  rawInput: unknown,
): {
  toolInput: string
  toolFile?: string
  oldString?: string
  newString?: string
} {
  let rawJson = ''
  if (typeof rawInput === 'string') {
    rawJson = rawInput
  } else if (rawInput !== undefined) {
    try {
      rawJson = JSON.stringify(rawInput)
    } catch {
      rawJson = String(rawInput)
    }
  }

  let parsed: Record<string, unknown> | null = null
  if (typeof rawInput === 'string') {
    if (rawInput.trim().length > 0) {
      try {
        parsed = JSON.parse(rawInput) as Record<string, unknown>
      } catch {
        parsed = null
      }
    }
  } else if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    parsed = rawInput as Record<string, unknown>
  }

  let toolInput = rawJson
  let toolFile: string | undefined
  let oldString: string | undefined
  let newString: string | undefined

  if (parsed) {
    toolFile = (parsed.file_path ?? parsed.path ?? parsed.command ?? parsed.pattern) as
      | string
      | undefined
    if (toolName === 'Edit' || toolName === 'MultiEdit') {
      oldString = parsed.old_string as string | undefined
      newString = parsed.new_string as string | undefined
      toolFile = parsed.file_path as string | undefined
    }
    if (toolName === 'Bash') {
      toolInput = (parsed.command as string | undefined) ?? rawJson
      toolFile = parsed.command as string | undefined
    }
  }

  return { toolInput, toolFile, oldString, newString }
}

export function extractToolResultOutput(rawOutput: unknown): string | undefined {
  if (rawOutput === undefined || rawOutput === null) {
    return undefined
  }
  if (typeof rawOutput === 'string') {
    return rawOutput
  }
  try {
    return JSON.stringify(rawOutput, null, 2)
  } catch {
    return String(rawOutput)
  }
}

export function extractSubagentDescription(rawInput: unknown): string | undefined {
  let parsed: Record<string, unknown> | null = null

  if (typeof rawInput === 'string') {
    if (!rawInput.trim()) return undefined
    try {
      parsed = JSON.parse(rawInput) as Record<string, unknown>
    } catch {
      return undefined
    }
  } else if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    parsed = rawInput as Record<string, unknown>
  }

  if (!parsed) return undefined
  const description = parsed.description
  if (typeof description === 'string' && description.trim()) {
    return description
  }
  const prompt = parsed.prompt
  if (typeof prompt === 'string' && prompt.trim()) {
    return prompt
  }

  return undefined
}

export function extractAgentMessageText(rawInput: unknown): string | undefined {
  if (typeof rawInput === 'string') {
    return rawInput.trim() ? rawInput : undefined
  }

  if (Array.isArray(rawInput)) {
    const parts = rawInput
      .map((value) => extractAgentMessageText(value) ?? '')
      .filter((value) => value.trim().length > 0)
    return parts.length > 0 ? parts.join('\n') : undefined
  }

  if (!rawInput || typeof rawInput !== 'object') {
    return undefined
  }

  const record = rawInput as Record<string, unknown>
  const directText = extractAgentMessageText(record.text)
  if (directText) {
    return directText
  }

  const directContent = extractAgentMessageText(record.content)
  if (directContent) {
    return directContent
  }

  const nestedMessage = extractAgentMessageText(record.message)
  if (nestedMessage) {
    return nestedMessage
  }

  return undefined
}

/**
 * Format an MCP or built-in tool name for display.
 * mcp__tavily__tavily_search → { service: "tavily", displayName: "Tavily Search" }
 * mcp__claude_ai_Notion__notion-search → { service: "claude ai Notion", displayName: "Notion Search" }
 * ToolSearch → { displayName: "ToolSearch" }
 */
export function formatToolDisplayName(name: string): { displayName: string; service?: string } {
  if (!name.startsWith('mcp__')) return { displayName: name }

  const stripped = name.slice(5) // remove "mcp__"
  const lastSep = stripped.lastIndexOf('__')
  if (lastSep === -1) return { displayName: name }

  const server = stripped.slice(0, lastSep)
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → words
    .replace(/_/g, ' ')
    .trim()

  const toolRaw = stripped.slice(lastSep + 2)
  const toolPart = toolRaw
    .replace(/[-_]/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())

  return { displayName: toolPart, service: server }
}

/** A renderable item: either a single message or a group of consecutive tool messages. */
export type RenderItem =
  | { type: 'single'; msg: MsgItem }
  | { type: 'tool-group'; id: string; tools: MsgItem[] }

function isGenericGroupedTool(msg: MsgItem): boolean {
  return msg.kind === 'tool' && msg.toolName !== 'Agent'
}

/**
 * Group consecutive tool messages for collapsed rendering.
 * Runs of 2+ consecutive non-Agent tool blocks are grouped.
 * Agent blocks stay visible so nested subagent activity remains discoverable.
 */
export function groupMessages(messages: MsgItem[]): RenderItem[] {
  const result: RenderItem[] = []
  let toolBuf: MsgItem[] = []

  function flushTools() {
    if (toolBuf.length === 0) return
    if (toolBuf.length === 1) {
      result.push({ type: 'single', msg: toolBuf[0] })
    } else {
      result.push({ type: 'tool-group', id: `tg-${toolBuf[0].id}`, tools: toolBuf })
    }
    toolBuf = []
  }

  for (const msg of messages) {
    if (isGenericGroupedTool(msg)) {
      toolBuf.push(msg)
    } else {
      flushTools()
      result.push({ type: 'single', msg })
    }
  }
  flushTools()
  return result
}
