import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CreateCommanderForm } from '../components/CreateCommanderForm'

describe('CreateCommanderForm', () => {
  it('renders the create commander modal form with key controls', () => {
    const html = renderToStaticMarkup(
      createElement(CreateCommanderForm, {
        onAdd: vi.fn(async () => {}),
        isPending: false,
      }),
    )

    expect(html).toContain('New commander')
    expect(html).toContain('host (e.g. my-agent-1)')
    expect(html).toContain('Agent type')
    expect(html).toContain('Claude effort')
  })
})
