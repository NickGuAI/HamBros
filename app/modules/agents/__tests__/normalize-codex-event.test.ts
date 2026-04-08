import { describe, expect, it } from 'vitest'
import { normalizeCodexEvent } from '../normalize-codex-event'

describe('normalizeCodexEvent', () => {
  describe('reasoning streaming deltas', () => {
    it('reads params.delta for item/reasoning/summaryTextDelta', () => {
      const result = normalizeCodexEvent('item/reasoning/summaryTextDelta', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        summaryIndex: 0,
        delta: 'Thinking about the problem...',
      })
      expect(result).toEqual({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Thinking about the problem...' },
      })
    })

    it('reads params.delta for item/reasoning/textDelta', () => {
      const result = normalizeCodexEvent('item/reasoning/textDelta', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        contentIndex: 0,
        delta: 'Raw chain of thought...',
      })
      expect(result).toEqual({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Raw chain of thought...' },
      })
    })

    it('reads structured delta payloads with text fields', () => {
      const result = normalizeCodexEvent('item/reasoning/summaryTextDelta', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        summaryIndex: 0,
        delta: { type: 'summary_text', text: 'Structured summary chunk' },
      })
      expect(result).toEqual({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Structured summary chunk' },
      })
    })

    it('returns null when delta is empty', () => {
      const result = normalizeCodexEvent('item/reasoning/summaryTextDelta', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        summaryIndex: 0,
        delta: '',
      })
      expect(result).toBeNull()
    })

    it('returns null when delta payload is non-string and missing text', () => {
      const result = normalizeCodexEvent('item/reasoning/textDelta', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        contentIndex: 0,
        delta: { type: 'reasoning_text' },
      })
      expect(result).toBeNull()
    })

    it('returns null when delta field is missing', () => {
      const result = normalizeCodexEvent('item/reasoning/textDelta', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        contentIndex: 0,
      })
      expect(result).toBeNull()
    })

    it('does NOT read params.text for reasoning deltas (old bug)', () => {
      const result = normalizeCodexEvent('item/reasoning/summaryTextDelta', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        summaryIndex: 0,
        text: 'This should be ignored',
      })
      expect(result).toBeNull()
    })
  })

  describe('reasoning item/completed', () => {
    it('extracts thinking from summary and content string arrays', () => {
      const result = normalizeCodexEvent('item/completed', {
        item: {
          id: 'rs_123',
          type: 'reasoning',
          summary: ['Summary part 1', 'Summary part 2'],
          content: ['Raw reasoning'],
        },
      })
      expect(result).toEqual({
        type: 'assistant',
        message: {
          id: 'rs_123',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Summary part 1Summary part 2Raw reasoning' }],
        },
      })
    })

    it('extracts thinking from structured summary/content blocks', () => {
      const result = normalizeCodexEvent('item/completed', {
        item: {
          id: 'rs_structured',
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Summary chunk' }],
          content: [{ type: 'reasoning_text', text: 'Raw chunk' }],
        },
      })
      expect(result).toEqual({
        type: 'assistant',
        message: {
          id: 'rs_structured',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Summary chunkRaw chunk' }],
        },
      })
    })

    it('handles reasoning item with only summary', () => {
      const result = normalizeCodexEvent('item/completed', {
        item: {
          id: 'rs_456',
          type: 'reasoning',
          summary: ['Only summary here'],
          content: [],
        },
      })
      expect(result).toEqual({
        type: 'assistant',
        message: {
          id: 'rs_456',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Only summary here' }],
        },
      })
    })

    it('handles reasoning item with empty arrays', () => {
      const result = normalizeCodexEvent('item/completed', {
        item: {
          id: 'rs_789',
          type: 'reasoning',
          summary: [],
          content: [],
        },
      })
      expect(result).toEqual({
        type: 'assistant',
        message: {
          id: 'rs_789',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '' }],
        },
      })
    })

    it('handles reasoning item with missing arrays (fallback)', () => {
      const result = normalizeCodexEvent('item/completed', {
        item: {
          id: 'rs_000',
          type: 'reasoning',
        },
      })
      expect(result).toEqual({
        type: 'assistant',
        message: {
          id: 'rs_000',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '' }],
        },
      })
    })

    it('does NOT read item.text for reasoning (old bug)', () => {
      const result = normalizeCodexEvent('item/completed', {
        item: {
          id: 'rs_old',
          type: 'reasoning',
          text: 'This should be ignored',
        },
      }) as { message: { content: Array<{ thinking: string }> } }
      expect(result.message.content[0].thinking).toBe('')
    })
  })

  describe('reasoning item/started', () => {
    it('emits content_block_start for reasoning item', () => {
      const result = normalizeCodexEvent('item/started', {
        item: { id: 'rs_start', type: 'reasoning' },
      })
      expect(result).toEqual({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      })
    })
  })

  describe('non-reasoning events still work', () => {
    it('handles item/agentMessage/delta with params.text', () => {
      const result = normalizeCodexEvent('item/agentMessage/delta', {
        text: 'Hello world',
      })
      expect(result).toEqual({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello world' },
      })
    })

    it('handles thread/started', () => {
      const result = normalizeCodexEvent('thread/started', {})
      expect(result).toEqual({ type: 'system', text: 'Codex session started' })
    })

    it('returns null for unknown methods', () => {
      const result = normalizeCodexEvent('unknown/method', {})
      expect(result).toBeNull()
    })
  })

  describe('thread token usage updates', () => {
    it('normalizes thread/tokenUsage/updated tokenUsage payload to total usage event', () => {
      const result = normalizeCodexEvent('thread/tokenUsage/updated', {
        threadId: 'thr_1',
        tokenUsage: {
          inputTokens: 120,
          outputTokens: 45,
          totalCostUsd: 0.18,
        },
      })
      expect(result).toEqual({
        type: 'message_delta',
        usage: {
          input_tokens: 120,
          output_tokens: 45,
        },
        usage_is_total: true,
        total_cost_usd: 0.18,
      })
    })

    it('accepts snake_case usage payloads', () => {
      const result = normalizeCodexEvent('thread/tokenUsage/updated', {
        usage: {
          input_tokens: 21,
          output_tokens: 9,
          total_cost_usd: 0.02,
        },
      })
      expect(result).toEqual({
        type: 'message_delta',
        usage: {
          input_tokens: 21,
          output_tokens: 9,
        },
        usage_is_total: true,
        total_cost_usd: 0.02,
      })
    })

    it('returns null when usage fields are absent', () => {
      const result = normalizeCodexEvent('thread/tokenUsage/updated', {
        threadId: 'thr_1',
        tokenUsage: { limit: 1000 },
      })
      expect(result).toBeNull()
    })
  })
})
