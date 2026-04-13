import { describe, expect, it } from 'vitest'
import { normalizeClaudeEvent } from '../normalize-claude-event'

describe('normalizeClaudeEvent', () => {
  it('maps EnterPlanMode to a planning.enter event', () => {
    const result = normalizeClaudeEvent({
      type: 'assistant',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'plan-enter', name: 'EnterPlanMode' }],
      },
    })

    expect(result).toEqual({
      type: 'planning',
      action: 'enter',
    })
  })

  it('maps ExitPlanMode input plans to planning.proposed', () => {
    const result = normalizeClaudeEvent({
      type: 'assistant',
      message: {
        id: 'assistant-2',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'plan-exit',
            name: 'ExitPlanMode',
            input: { plan: '1. Inspect the stream path\n2. Patch the normalizer' },
          },
        ],
      },
    })

    expect(result).toEqual({
      type: 'planning',
      action: 'proposed',
      plan: '1. Inspect the stream path\n2. Patch the normalizer',
    })
  })

  it('filters plan-mode tool traffic while preserving other assistant content', () => {
    const result = normalizeClaudeEvent({
      type: 'assistant',
      message: {
        id: 'assistant-3',
        role: 'assistant',
        content: [
          { type: 'text', text: 'I investigated the issue.' },
          { type: 'tool_use', id: 'plan-enter', name: 'EnterPlanMode' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } },
        ],
      },
    })

    expect(result).toEqual([
      {
        type: 'assistant',
        message: {
          id: 'assistant-3',
          role: 'assistant',
          content: [{ type: 'text', text: 'I investigated the issue.' }],
        },
      },
      {
        type: 'planning',
        action: 'enter',
      },
      {
        type: 'assistant',
        message: {
          id: 'assistant-3',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } }],
        },
      },
    ])
  })

  it('maps ExitPlanMode approval payloads to planning.decision', () => {
    const result = normalizeClaudeEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'plan-exit',
            content: '{"approved":true,"message":"Proceeding with the approved plan."}',
          },
        ],
      },
    })

    expect(result).toEqual({
      type: 'planning',
      action: 'decision',
      approved: true,
      message: 'Proceeding with the approved plan.',
    })
  })

  it('keeps AskUserQuestion events unchanged', () => {
    const event = {
      type: 'assistant',
      message: {
        id: 'assistant-4',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'ask-1',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Proceed?', header: 'Confirm', options: [], multiSelect: false }] },
          },
        ],
      },
    }

    expect(normalizeClaudeEvent(event)).toEqual(event)
  })
})
