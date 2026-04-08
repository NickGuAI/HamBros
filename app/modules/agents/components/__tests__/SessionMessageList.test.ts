// @vitest-environment jsdom

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { describe, expect, it } from 'vitest'
import { SessionMessageList } from '../SessionMessageList'
import type { MsgItem } from '../session-messages'

const THINKING_TEXT = 'Reason through the three git repos and compare status output.'

describe('SessionMessageList thinking blocks', () => {
  it('renders replayed thinking content on mount and supports collapse/re-expand', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const messages: MsgItem[] = [
      {
        id: 'thinking-1',
        kind: 'thinking',
        text: THINKING_TEXT,
      },
    ]

    flushSync(() => {
      root.render(createElement(SessionMessageList, { messages, onAnswer: () => undefined }))
    })

    const toggle = container.querySelector('button')
    if (!toggle) {
      throw new Error('expected thinking toggle button')
    }
    const chevron = toggle.querySelector('svg.lucide-chevron-right')
    if (!chevron) {
      throw new Error('expected thinking chevron icon')
    }

    expect(container.textContent).toContain(THINKING_TEXT)
    expect(chevron.getAttribute('class')).toContain('rotate-90')

    flushSync(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).not.toContain(THINKING_TEXT)
    expect(chevron.getAttribute('class')).not.toContain('rotate-90')

    flushSync(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain(THINKING_TEXT)
    expect(chevron.getAttribute('class')).toContain('rotate-90')

    flushSync(() => {
      root.unmount()
    })
    container.remove()
  })
})
