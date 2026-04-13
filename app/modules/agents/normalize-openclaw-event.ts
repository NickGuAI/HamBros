import type { HammurabiEvent, HammurabiEventSource } from '../../src/types/hammurabi-events.js'

const OPENCLAW_EVENT_SOURCE: HammurabiEventSource = {
  provider: 'openclaw',
  backend: 'gateway',
}

function withOpenClawSource<T extends HammurabiEvent>(event: T): T {
  return {
    ...event,
    source: OPENCLAW_EVENT_SOURCE,
  } as T
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function normalizeOpenClawEvent(rawEvent: unknown): HammurabiEvent | null {
  const event = asObject(rawEvent)
  if (!event) return null

  const type = typeof event.type === 'string' ? event.type : ''
  if (!type) return null

  const passthrough = new Set(['content_block_start', 'content_block_stop', 'tool_use', 'result'])
  if (passthrough.has(type)) {
    return {
      ...event,
      source: OPENCLAW_EVENT_SOURCE,
    } as HammurabiEvent
  }

  switch (type) {
    case 'content_block_delta': {
      const delta = asObject(event.delta)
      if (!delta) {
        return null
      }
      return {
        ...event,
        source: OPENCLAW_EVENT_SOURCE,
      } as HammurabiEvent
    }
    case 'thinking_delta': {
      const delta = asObject(event.delta)
      const thinking = typeof event.thinking === 'string'
        ? event.thinking
        : (typeof delta?.thinking === 'string' ? delta.thinking : '')
      if (!thinking) return null
      return withOpenClawSource({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking },
      })
    }
    case 'thinking_start': {
      const thinking = typeof event.thinking === 'string' ? event.thinking : ''
      if (!thinking) return null
      return withOpenClawSource({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking },
      })
    }
    case 'done': {
      const result = typeof event.result === 'string' ? event.result : ''
      return withOpenClawSource({ type: 'result', result })
    }
    default:
      return null
  }
}
