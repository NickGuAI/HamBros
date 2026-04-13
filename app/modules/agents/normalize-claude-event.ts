/**
 * Normalizes Claude stream-json events into the StreamJsonEvent shape used by
 * the Hammurabi agents session layer.
 *
 * Planning mode is elevated into a Hammurabi-owned event so the UI can render
 * it distinctly without treating plan-mode tool traffic as generic tool calls.
 */

interface StreamJsonEvent {
  type: string
  [key: string]: unknown
}

interface PlanningEvent extends StreamJsonEvent {
  type: 'planning'
  action: 'enter' | 'proposed' | 'decision'
  plan?: string
  approved?: boolean
  message?: string
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeTextPayload(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  if (!Array.isArray(value)) {
    return undefined
  }

  const parts = value
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry
      }
      const record = asObject(entry)
      return readTrimmedString(record?.text)
    })
    .filter((entry): entry is string => Boolean(entry))

  if (parts.length === 0) {
    return undefined
  }

  return parts.join('\n').trim()
}

function parseToolResultPayload(content: unknown): Record<string, unknown> | null {
  const directRecord = asObject(content)
  if (directRecord) {
    return directRecord
  }

  const text = normalizeTextPayload(content)
  if (!text) {
    return null
  }

  try {
    return asObject(JSON.parse(text))
  } catch {
    return null
  }
}

function buildPlanningToolUseEvent(block: Record<string, unknown>): PlanningEvent | null {
  const name = readTrimmedString(block.name)
  if (name === 'EnterPlanMode') {
    return { type: 'planning', action: 'enter' }
  }

  if (name !== 'ExitPlanMode') {
    return null
  }

  const input = asObject(block.input)
  const plan = readTrimmedString(input?.plan)
  if (!plan) {
    return null
  }

  return {
    type: 'planning',
    action: 'proposed',
    plan,
  }
}

function buildPlanningToolResultEvent(block: Record<string, unknown>): PlanningEvent | null {
  const payload = parseToolResultPayload(block.content)
  const explicitToolName = readTrimmedString(block.name ?? block.tool_name ?? block.toolUseName)

  const plan = readTrimmedString(payload?.plan)
  if (plan) {
    return {
      type: 'planning',
      action: 'proposed',
      plan,
    }
  }

  const approved = typeof payload?.approved === 'boolean' ? payload.approved : undefined
  const message = readTrimmedString(payload?.message)
  if (approved === undefined && !message) {
    return null
  }

  if (approved === undefined && explicitToolName !== 'ExitPlanMode') {
    return null
  }

  return {
    type: 'planning',
    action: 'decision',
    ...(approved !== undefined ? { approved } : {}),
    ...(message ? { message } : {}),
  }
}

function cloneEventWithContent(
  event: StreamJsonEvent,
  message: Record<string, unknown>,
  content: unknown[],
): StreamJsonEvent {
  return {
    ...event,
    message: {
      ...message,
      content,
    },
  }
}

function normalizeAssistantEvent(event: StreamJsonEvent): StreamJsonEvent | StreamJsonEvent[] | null {
  const message: Record<string, unknown> = asObject(event.message) ?? {}
  const content = message?.content
  if (!Array.isArray(content)) {
    return event
  }

  let changed = false
  let passthroughBlocks: unknown[] = []
  const normalized: StreamJsonEvent[] = []

  const flushPassthrough = () => {
    if (passthroughBlocks.length === 0) {
      return
    }
    normalized.push(cloneEventWithContent(event, message, passthroughBlocks))
    passthroughBlocks = []
  }

  for (const rawBlock of content) {
    const block = asObject(rawBlock)
    const planningEvent =
      block && block.type === 'tool_use'
        ? buildPlanningToolUseEvent(block)
        : null

    if (!planningEvent) {
      passthroughBlocks.push(rawBlock)
      continue
    }

    changed = true
    flushPassthrough()
    normalized.push(planningEvent)
  }

  if (!changed) {
    return event
  }

  flushPassthrough()
  if (
    normalized.every((entry) => entry.type !== 'assistant')
    && message?.usage !== undefined
  ) {
    normalized.unshift(cloneEventWithContent(event, message, []))
  }
  if (normalized.length === 0) {
    return null
  }

  return normalized.length === 1 ? normalized[0] : normalized
}

function normalizeUserEvent(event: StreamJsonEvent): StreamJsonEvent | StreamJsonEvent[] | null {
  const message: Record<string, unknown> = asObject(event.message) ?? {}
  const content = message?.content
  if (!Array.isArray(content)) {
    return event
  }

  let changed = false
  let passthroughBlocks: unknown[] = []
  const normalized: StreamJsonEvent[] = []

  const flushPassthrough = () => {
    if (passthroughBlocks.length === 0) {
      return
    }
    normalized.push(cloneEventWithContent(event, message, passthroughBlocks))
    passthroughBlocks = []
  }

  for (const rawBlock of content) {
    const block = asObject(rawBlock)
    const planningEvent =
      block && block.type === 'tool_result'
        ? buildPlanningToolResultEvent(block)
        : null

    if (!planningEvent) {
      passthroughBlocks.push(rawBlock)
      continue
    }

    changed = true
    flushPassthrough()
    normalized.push(planningEvent)
  }

  if (!changed) {
    return event
  }

  flushPassthrough()
  if (normalized.length === 0) {
    return null
  }

  return normalized.length === 1 ? normalized[0] : normalized
}

export function normalizeClaudeEvent(event: StreamJsonEvent): StreamJsonEvent | StreamJsonEvent[] | null {
  switch (event.type) {
    case 'assistant':
      return normalizeAssistantEvent(event)
    case 'user':
      return normalizeUserEvent(event)
    default:
      return event
  }
}
