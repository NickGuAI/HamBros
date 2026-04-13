import { describe, expect, it } from 'vitest'
import { normalizeCodexEvent } from '../normalize-codex-event'

const CODEX_SOURCE = {
  source: { provider: 'codex', backend: 'rpc' },
} as const

function withCodexSource<T extends object>(event: T): T & typeof CODEX_SOURCE {
  return {
    ...event,
    ...CODEX_SOURCE,
  }
}

describe('normalizeCodexEvent', () => {
  it('attaches the codex source envelope to replay-safe turn events', () => {
    expect(normalizeCodexEvent('thread/started', {})).toEqual(
      withCodexSource({ type: 'system', text: 'Codex session started' }),
    )

    expect(normalizeCodexEvent('turn/started', { turn: { id: 'turn_1' } })).toEqual(
      withCodexSource({
        type: 'message_start',
        message: { id: 'turn_1', role: 'assistant' },
      }),
    )

    expect(normalizeCodexEvent('turn/completed', { turn: { status: 'failed' } })).toEqual(
      withCodexSource({
        type: 'result',
        result: 'Turn failed',
        is_error: true,
      }),
    )
  })

  describe('reasoning streaming deltas', () => {
    it('reads params.delta for item/reasoning/summaryTextDelta', () => {
      const result = normalizeCodexEvent('item/reasoning/summaryTextDelta', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        summaryIndex: 0,
        delta: 'Thinking about the problem...',
      })
      expect(result).toEqual(
        withCodexSource({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Thinking about the problem...' },
        }),
      )
    })

    it('reads params.delta for item/reasoning/textDelta', () => {
      const result = normalizeCodexEvent('item/reasoning/textDelta', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        contentIndex: 0,
        delta: 'Raw chain of thought...',
      })
      expect(result).toEqual(
        withCodexSource({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Raw chain of thought...' },
        }),
      )
    })

    it('reads structured delta payloads with text fields', () => {
      const result = normalizeCodexEvent('item/reasoning/summaryTextDelta', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        summaryIndex: 0,
        delta: { type: 'summary_text', text: 'Structured summary chunk' },
      })
      expect(result).toEqual(
        withCodexSource({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Structured summary chunk' },
        }),
      )
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

    it('does not read params.text for reasoning deltas', () => {
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
      expect(result).toEqual(
        withCodexSource({
          type: 'assistant',
          message: {
            id: 'rs_123',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'Summary part 1Summary part 2Raw reasoning' }],
          },
        }),
      )
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
      expect(result).toEqual(
        withCodexSource({
          type: 'assistant',
          message: {
            id: 'rs_structured',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'Summary chunkRaw chunk' }],
          },
        }),
      )
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
      expect(result).toEqual(
        withCodexSource({
          type: 'assistant',
          message: {
            id: 'rs_456',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'Only summary here' }],
          },
        }),
      )
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
      expect(result).toEqual(
        withCodexSource({
          type: 'assistant',
          message: {
            id: 'rs_789',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '' }],
          },
        }),
      )
    })

    it('handles reasoning item with missing arrays', () => {
      const result = normalizeCodexEvent('item/completed', {
        item: {
          id: 'rs_000',
          type: 'reasoning',
        },
      })
      expect(result).toEqual(
        withCodexSource({
          type: 'assistant',
          message: {
            id: 'rs_000',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '' }],
          },
        }),
      )
    })

    it('does not read item.text for reasoning', () => {
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
      expect(result).toEqual(
        withCodexSource({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
      )
    })
  })

  describe('user item/started', () => {
    it('ignores Codex userMessage echoes to avoid duplicate local user events', () => {
      const result = normalizeCodexEvent('item/started', {
        item: {
          id: 'usr_1',
          type: 'userMessage',
          content: [{ type: 'input_text', text: 'status?' }],
        },
      })
      expect(result).toBeNull()
    })
  })

  describe('non-reasoning events still work', () => {
    it('handles item/agentMessage/delta with params.text', () => {
      const result = normalizeCodexEvent('item/agentMessage/delta', {
        text: 'Hello world',
      })
      expect(result).toEqual(
        withCodexSource({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello world' },
        }),
      )
    })

    it('returns null for unknown methods', () => {
      const result = normalizeCodexEvent('unknown/method', {})
      expect(result).toBeNull()
    })
  })

  describe('command execution and file changes', () => {
    it('normalizes command execution into assistant/user replay pairs', () => {
      expect(normalizeCodexEvent('item/completed', {
        item: {
          id: 'exec_1',
          type: 'commandExecution',
          command: 'ls -la',
          output: 'ok',
          exitCode: 0,
        },
      })).toEqual([
        withCodexSource({
          type: 'assistant',
          message: {
            id: 'exec_1',
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'exec_1',
              name: 'Bash',
              input: { command: 'ls -la' },
            }],
          },
        }),
        withCodexSource({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'exec_1',
              content: 'ok',
              is_error: false,
            }],
          },
        }),
      ])
    })

    it('normalizes file changes into assistant/user replay pairs', () => {
      expect(normalizeCodexEvent('item/completed', {
        item: {
          id: 'edit_1',
          type: 'fileChange',
          filePath: '/tmp/demo.txt',
          patch: 'patched',
        },
      })).toEqual([
        withCodexSource({
          type: 'assistant',
          message: {
            id: 'edit_1',
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'edit_1',
              name: 'Edit',
              input: {
                file_path: '/tmp/demo.txt',
                old_string: '',
                new_string: 'patched',
              },
            }],
          },
        }),
        withCodexSource({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'edit_1',
              content: 'Applied',
            }],
          },
        }),
      ])
    })
  })

  describe('thread token usage updates', () => {
    it('normalizes tokenUsage payloads to total usage events', () => {
      const result = normalizeCodexEvent('thread/tokenUsage/updated', {
        threadId: 'thr_1',
        tokenUsage: {
          inputTokens: 120,
          outputTokens: 45,
          totalCostUsd: 0.18,
        },
      })
      expect(result).toEqual(
        withCodexSource({
          type: 'message_delta',
          usage: {
            input_tokens: 120,
            output_tokens: 45,
          },
          usage_is_total: true,
          total_cost_usd: 0.18,
        }),
      )
    })

    it('accepts snake_case usage payloads', () => {
      const result = normalizeCodexEvent('thread/tokenUsage/updated', {
        usage: {
          input_tokens: 21,
          output_tokens: 9,
          total_cost_usd: 0.02,
        },
      })
      expect(result).toEqual(
        withCodexSource({
          type: 'message_delta',
          usage: {
            input_tokens: 21,
            output_tokens: 9,
          },
          usage_is_total: true,
          total_cost_usd: 0.02,
        }),
      )
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
