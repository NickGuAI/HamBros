import { describe, expect, it } from 'vitest'
import { groupMessages, type MsgItem } from './session-messages'

function makeTool(id: string, toolName: string): MsgItem {
  return {
    id,
    kind: 'tool',
    text: '',
    toolId: `tool-${id}`,
    toolName,
    toolStatus: 'running',
    toolInput: '',
  }
}

describe('groupMessages', () => {
  it('keeps Agent tool blocks visible and splits surrounding generic tool groups', () => {
    const messages: MsgItem[] = [
      makeTool('read', 'Read'),
      makeTool('bash', 'Bash'),
      makeTool('agent', 'Agent'),
      makeTool('edit', 'Edit'),
      makeTool('grep', 'Grep'),
    ]

    expect(groupMessages(messages)).toEqual([
      {
        type: 'tool-group',
        id: 'tg-read',
        tools: [messages[0], messages[1]],
      },
      {
        type: 'single',
        msg: messages[2],
      },
      {
        type: 'tool-group',
        id: 'tg-edit',
        tools: [messages[3], messages[4]],
      },
    ])
  })
})
