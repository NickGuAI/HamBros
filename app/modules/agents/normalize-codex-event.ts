/**
 * Normalizes Codex app-server JSONRPC notification events into the
 * StreamJsonEvent shape used by the Hammurabi agents session layer.
 *
 * This is a pure function with no closure dependencies, extracted for
 * testability.
 */

interface StreamJsonEvent {
  type: string
  [key: string]: unknown
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  return value as Record<string, unknown>
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

function extractUsageUpdate(params: Record<string, unknown>): {
  usage: { input_tokens?: number; output_tokens?: number }
  totalCostUsd?: number
} | null {
  const usagePayload = asObject(params.tokenUsage) ?? asObject(params.usage) ?? params
  if (!usagePayload) {
    return null
  }

  const inputTokens = readNumber(usagePayload, ['input_tokens', 'inputTokens', 'input'])
  const outputTokens = readNumber(usagePayload, ['output_tokens', 'outputTokens', 'output'])
  const totalCostUsd = readNumber(usagePayload, ['total_cost_usd', 'totalCostUsd', 'cost_usd', 'costUsd'])

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalCostUsd === undefined
  ) {
    return null
  }

  return {
    usage: {
      ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
      ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    },
    totalCostUsd,
  }
}

function extractReasoningTextChunk(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null

  const chunk = value as Record<string, unknown>
  return typeof chunk.text === 'string' ? chunk.text : null
}

function extractReasoningTextParts(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const parts: string[] = []
  for (const chunk of value) {
    const text = extractReasoningTextChunk(chunk)
    if (text) parts.push(text)
  }
  return parts
}

export function normalizeCodexEvent(method: string, params: unknown): StreamJsonEvent | StreamJsonEvent[] | null {
  const p = asObject(params) ?? {}

  switch (method) {
    case 'thread/started':
      return { type: 'system', text: 'Codex session started' }
    case 'thread/tokenUsage/updated': {
      const usageUpdate = extractUsageUpdate(p)
      if (!usageUpdate) {
        return null
      }
      return {
        type: 'message_delta',
        usage: usageUpdate.usage,
        usage_is_total: true,
        ...(usageUpdate.totalCostUsd !== undefined ? { total_cost_usd: usageUpdate.totalCostUsd } : {}),
      }
    }
    case 'turn/started':
      return { type: 'message_start', message: { id: (p.turn as Record<string, unknown>)?.id as string ?? '', role: 'assistant' } }
    case 'turn/completed': {
      const turn = p.turn as Record<string, unknown> | undefined
      const status = turn?.status as string | undefined
      return {
        type: 'result',
        result: status === 'completed' ? 'Turn completed' : `Turn ${status ?? 'ended'}`,
        is_error: status === 'failed',
      }
    }
    case 'item/agentMessage/delta': {
      const text = (p as Record<string, unknown>).text as string | undefined
      if (!text) return null
      return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as unknown as StreamJsonEvent
    }
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const text = extractReasoningTextChunk((p as Record<string, unknown>).delta)
      if (!text) return null
      return { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } } as unknown as StreamJsonEvent
    }
    case 'item/started': {
      const item = p.item as Record<string, unknown>
      if (!item) return null
      const itemType = item.type as string
      if (itemType === 'userMessage') {
        const content = item.content as Array<{ type: string; text?: string }> | undefined
        const text = content?.map(c => c.text ?? '').join('') ?? ''
        return {
          type: 'user',
          message: { role: 'user', content: text },
        } as unknown as StreamJsonEvent
      }
      if (itemType === 'reasoning') {
        return { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } as unknown as StreamJsonEvent
      }
      return null
    }
    case 'item/completed': {
      const item = p.item as Record<string, unknown>
      if (!item) return null
      const itemType = item.type as string
      const itemId = item.id as string ?? ''
      if (itemType === 'agentMessage') {
        return {
          type: 'assistant',
          message: {
            id: itemId,
            role: 'assistant',
            content: [{ type: 'text', text: item.text as string ?? '' }],
          },
        } as unknown as StreamJsonEvent
      }
      if (itemType === 'reasoning') {
        const summaryParts = extractReasoningTextParts(item.summary)
        const contentParts = extractReasoningTextParts(item.content)
        const thinking = [...summaryParts, ...contentParts].join('')
        return {
          type: 'assistant',
          message: {
            id: itemId,
            role: 'assistant',
            content: [{ type: 'thinking', thinking }],
          },
        } as unknown as StreamJsonEvent
      }
      if (itemType === 'commandExecution') {
        const events: StreamJsonEvent[] = []
        events.push({
          type: 'assistant',
          message: {
            id: itemId,
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: itemId,
              name: 'Bash',
              input: { command: (item.command ?? item.input) as string ?? '' },
            }],
          },
        } as unknown as StreamJsonEvent)
        events.push({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: itemId,
              content: (item.output ?? '') as string,
              is_error: (item.exitCode as number | undefined) !== 0,
            }],
          },
        } as unknown as StreamJsonEvent)
        return events
      }
      if (itemType === 'fileChange') {
        const events: StreamJsonEvent[] = []
        events.push({
          type: 'assistant',
          message: {
            id: itemId,
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: itemId,
              name: 'Edit',
              input: { file_path: (item.filePath ?? item.file) as string ?? '', old_string: '', new_string: (item.content ?? item.patch ?? '') as string },
            }],
          },
        } as unknown as StreamJsonEvent)
        events.push({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: itemId, content: 'Applied' }],
          },
        } as unknown as StreamJsonEvent)
        return events
      }
      return null
    }
    default:
      return null
  }
}
