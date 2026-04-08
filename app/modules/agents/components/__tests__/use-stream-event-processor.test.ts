// @vitest-environment jsdom

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { StreamEvent } from '@/types'
import type { MsgItem } from '../session-messages'
import { useStreamEventProcessor } from '../use-stream-event-processor'

type Harness = {
  cleanup: () => void
  dispatchReplayEvent: (event: StreamEvent) => void
  getMessages: () => MsgItem[]
}

function createHarness(): Harness {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const root: Root = createRoot(container)
  let processEventRef: ((event: StreamEvent, isReplay?: boolean) => void) | undefined
  let messagesRef: MsgItem[] = []

  function HarnessComponent() {
    const { processEvent, messages } = useStreamEventProcessor()
    processEventRef = processEvent
    messagesRef = messages
    return null
  }

  flushSync(() => {
    root.render(createElement(HarnessComponent))
  })

  if (!processEventRef) {
    throw new Error('expected stream event processor hook to initialize')
  }

  return {
    dispatchReplayEvent(event: StreamEvent) {
      flushSync(() => {
        processEventRef!(event, true)
      })
    },
    getMessages() {
      return messagesRef
    },
    cleanup() {
      flushSync(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

function replayUserText(text: string): StreamEvent {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
  }
}

describe('useStreamEventProcessor replay user handling', () => {
  it('suppresses internal Agent replay prompts while preserving human user messages', () => {
    const harness = createHarness()

    harness.dispatchReplayEvent(replayUserText('human message before tool'))

    harness.dispatchReplayEvent({
      type: 'assistant',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-agent-1',
            name: 'Agent',
            input: { description: 'Very thorough exploration of the Gehirn site app.' },
          },
        ],
      },
    })

    harness.dispatchReplayEvent(replayUserText('Very thorough exploration of the Gehirn site app.'))

    harness.dispatchReplayEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-agent-1', content: 'done' }],
      },
    })

    harness.dispatchReplayEvent(replayUserText('human message after tool'))

    const allMessages = harness.getMessages()
    const userTexts = allMessages
      .filter((msg) => msg.kind === 'user')
      .map((msg) => msg.text)

    expect(userTexts).toEqual(['human message before tool', 'human message after tool'])

    const agentTool = allMessages.find(
      (msg) => msg.kind === 'tool' && msg.toolName === 'Agent' && msg.toolId === 'tool-agent-1',
    )
    expect(agentTool?.subagentDescription).toBe('Very thorough exploration of the Gehirn site app.')
    expect(agentTool?.toolStatus).toBe('success')

    harness.cleanup()
  })

  it('keeps replayed text/image user envelopes once Agent tool result clears active state', () => {
    const harness = createHarness()

    harness.dispatchReplayEvent({
      type: 'assistant',
      message: {
        id: 'assistant-2',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-agent-2',
            name: 'Agent',
            input: { description: 'Analyze screenshot' },
          },
        ],
      },
    })

    harness.dispatchReplayEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'internal subagent prompt' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'internal-image' },
          },
        ],
      },
    })

    harness.dispatchReplayEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-agent-2', content: 'complete' }],
      },
    })

    harness.dispatchReplayEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'human message with screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ],
      },
    })

    const userMessages = harness.getMessages().filter((msg) => msg.kind === 'user')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]).toMatchObject({
      text: 'human message with screenshot',
      images: [{ mediaType: 'image/png', data: 'abc123' }],
    })

    harness.cleanup()
  })
})
