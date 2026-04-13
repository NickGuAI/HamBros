import type { HammurabiEvent, HammurabiEventSource } from '../../src/types/hammurabi-events.js'

const CODEX_EVENT_SOURCE: HammurabiEventSource = {
  provider: 'codex',
  backend: 'rpc',
}

function withCodexSource<T extends HammurabiEvent>(event: T): T {
  return {
    ...event,
    source: CODEX_EVENT_SOURCE,
  } as T
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

export function normalizeCodexEvent(method: string, params: unknown): HammurabiEvent | HammurabiEvent[] | null {
  const p = asObject(params) ?? {}

  switch (method) {
    case 'thread/started':
      return withCodexSource({ type: 'system', text: 'Codex session started' })
    case 'thread/tokenUsage/updated': {
      const usageUpdate = extractUsageUpdate(p)
      if (!usageUpdate) {
        return null
      }
      return withCodexSource({
        type: 'message_delta',
        usage: usageUpdate.usage,
        usage_is_total: true,
        ...(usageUpdate.totalCostUsd !== undefined ? { total_cost_usd: usageUpdate.totalCostUsd } : {}),
      })
    }
    case 'turn/started':
      return withCodexSource({
        type: 'message_start',
        message: {
          id: (asObject(p.turn)?.id as string | undefined) ?? '',
          role: 'assistant',
        },
      })
    case 'turn/completed': {
      const turn = asObject(p.turn)
      const status = turn?.status as string | undefined
      return withCodexSource({
        type: 'result',
        result: status === 'completed' ? 'Turn completed' : `Turn ${status ?? 'ended'}`,
        is_error: status === 'failed',
      })
    }
    case 'item/agentMessage/delta': {
      const text = typeof p.text === 'string' ? p.text : undefined
      if (!text) return null
      return withCodexSource({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })
    }
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const text = extractReasoningTextChunk(p.delta)
      if (!text) return null
      return withCodexSource({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: text },
      })
    }
    case 'item/started': {
      const item = asObject(p.item)
      if (!item) return null
      const itemType = item.type as string | undefined
      if (itemType === 'userMessage') {
        // Hammurabi already appends a local user echo immediately after turn/start.
        // Re-emitting Codex userMessage item/started duplicates transcript entries.
        return null
      }
      if (itemType === 'reasoning') {
        return withCodexSource({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        })
      }
      return null
    }
    case 'item/completed': {
      const item = asObject(p.item)
      if (!item) return null
      const itemType = item.type as string | undefined
      const itemId = (item.id as string | undefined) ?? ''

      if (itemType === 'agentMessage') {
        return withCodexSource({
          type: 'assistant',
          message: {
            id: itemId,
            role: 'assistant',
            content: [{ type: 'text', text: (item.text as string | undefined) ?? '' }],
          },
        })
      }

      if (itemType === 'reasoning') {
        const summaryParts = extractReasoningTextParts(item.summary)
        const contentParts = extractReasoningTextParts(item.content)
        const thinking = [...summaryParts, ...contentParts].join('')
        return withCodexSource({
          type: 'assistant',
          message: {
            id: itemId,
            role: 'assistant',
            content: [{ type: 'thinking', thinking }],
          },
        })
      }

      if (itemType === 'commandExecution') {
        const command = typeof item.command === 'string'
          ? item.command
          : (typeof item.input === 'string' ? item.input : '')
        return [
          withCodexSource({
            type: 'assistant',
            message: {
              id: itemId,
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: itemId,
                name: 'Bash',
                input: { command },
              }],
            },
          }),
          withCodexSource({
            type: 'user',
            message: {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: itemId,
                content: (item.output as string | undefined) ?? '',
                is_error: (item.exitCode as number | undefined) !== 0,
              }],
            },
          }),
        ]
      }

      if (itemType === 'fileChange') {
        const filePath = typeof item.filePath === 'string'
          ? item.filePath
          : (typeof item.file === 'string' ? item.file : '')
        const nextContent = typeof item.content === 'string'
          ? item.content
          : (typeof item.patch === 'string' ? item.patch : '')
        return [
          withCodexSource({
            type: 'assistant',
            message: {
              id: itemId,
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: itemId,
                name: 'Edit',
                input: {
                  file_path: filePath,
                  old_string: '',
                  new_string: nextContent,
                },
              }],
            },
          }),
          withCodexSource({
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: itemId, content: 'Applied' }],
            },
          }),
        ]
      }

      return null
    }
    default:
      return null
  }
}
