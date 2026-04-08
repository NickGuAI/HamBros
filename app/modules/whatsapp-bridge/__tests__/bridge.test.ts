import { describe, expect, it } from 'vitest'
import {
  type WhatsAppBridgeConfig,
  type WhatsAppWebhookPayload,
  type MetaWebhookPayload,
  resolveWhatsAppBridgeConfig,
  validateWebhookPayload,
  shouldForwardMessage,
  transformToChannelMessage,
  isMetaWebhookPayload,
  parseMetaWebhook,
  metaMessageToWebhookPayload,
  resolveCommanderForMessage,
} from '../bridge'

// ---------------------------------------------------------------------------
// resolveWhatsAppBridgeConfig
// ---------------------------------------------------------------------------

describe('resolveWhatsAppBridgeConfig', () => {
  it('defaults to disabled with no filter', () => {
    const config = resolveWhatsAppBridgeConfig({})
    expect(config.enabled).toBe(false)
    expect(config.filterMode).toBe('none')
    expect(config.whitelist).toEqual([])
    expect(config.keywords).toEqual([])
    expect(config.commanderId).toBeUndefined()
  })

  it('parses enabled flag variations', () => {
    expect(resolveWhatsAppBridgeConfig({ WHATSAPP_BRIDGE_ENABLED: '1' }).enabled).toBe(true)
    expect(resolveWhatsAppBridgeConfig({ WHATSAPP_BRIDGE_ENABLED: 'true' }).enabled).toBe(true)
    expect(resolveWhatsAppBridgeConfig({ WHATSAPP_BRIDGE_ENABLED: 'yes' }).enabled).toBe(true)
    expect(resolveWhatsAppBridgeConfig({ WHATSAPP_BRIDGE_ENABLED: 'on' }).enabled).toBe(true)
    expect(resolveWhatsAppBridgeConfig({ WHATSAPP_BRIDGE_ENABLED: '0' }).enabled).toBe(false)
    expect(resolveWhatsAppBridgeConfig({ WHATSAPP_BRIDGE_ENABLED: 'false' }).enabled).toBe(false)
    expect(resolveWhatsAppBridgeConfig({ WHATSAPP_BRIDGE_ENABLED: '' }).enabled).toBe(false)
  })

  it('parses commander id', () => {
    const config = resolveWhatsAppBridgeConfig({
      WHATSAPP_COMMANDER_ID: 'abc-123',
    })
    expect(config.commanderId).toBe('abc-123')
  })

  it('parses whitelist filter mode with comma-separated phones', () => {
    const config = resolveWhatsAppBridgeConfig({
      WHATSAPP_BRIDGE_ENABLED: 'true',
      WHATSAPP_FILTER_MODE: 'whitelist',
      WHATSAPP_FILTER_WHITELIST: '+15551234567, +15559876543',
    })
    expect(config.filterMode).toBe('whitelist')
    expect(config.whitelist).toEqual(['+15551234567', '+15559876543'])
  })

  it('parses keyword filter mode', () => {
    const config = resolveWhatsAppBridgeConfig({
      WHATSAPP_BRIDGE_ENABLED: 'true',
      WHATSAPP_FILTER_MODE: 'keyword',
      WHATSAPP_FILTER_KEYWORDS: 'urgent, alert, deploy',
    })
    expect(config.filterMode).toBe('keyword')
    expect(config.keywords).toEqual(['urgent', 'alert', 'deploy'])
  })

  it('defaults unknown filter mode to none', () => {
    const config = resolveWhatsAppBridgeConfig({
      WHATSAPP_FILTER_MODE: 'invalid',
    })
    expect(config.filterMode).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// validateWebhookPayload
// ---------------------------------------------------------------------------

describe('validateWebhookPayload', () => {
  const validPayload = {
    accountId: 'default',
    event: 'message',
    chatType: 'direct' as const,
    from: '+15551234567',
    displayName: 'Nick',
    text: 'Hello commander',
    timestamp: 1234567890,
  }

  it('accepts a valid complete payload', () => {
    const result = validateWebhookPayload(validPayload)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.payload.accountId).toBe('default')
      expect(result.payload.event).toBe('message')
      expect(result.payload.chatType).toBe('direct')
      expect(result.payload.from).toBe('+15551234567')
      expect(result.payload.displayName).toBe('Nick')
      expect(result.payload.text).toBe('Hello commander')
      expect(result.payload.timestamp).toBe(1234567890)
    }
  })

  it('accepts a payload without optional fields', () => {
    const result = validateWebhookPayload({
      accountId: 'default',
      event: 'message',
      chatType: 'group',
      from: '120363012345@g.us',
      text: 'group message',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.payload.displayName).toBeUndefined()
      expect(result.payload.timestamp).toBeUndefined()
    }
  })

  it('rejects null payload', () => {
    const result = validateWebhookPayload(null)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('Payload must be a JSON object')
    }
  })

  it('rejects missing accountId', () => {
    const result = validateWebhookPayload({ ...validPayload, accountId: '' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('accountId is required')
    }
  })

  it('rejects missing event', () => {
    const result = validateWebhookPayload({ ...validPayload, event: undefined })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('event is required')
    }
  })

  it('rejects non-message event', () => {
    const result = validateWebhookPayload({ ...validPayload, event: 'status' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('Unsupported event type: status')
    }
  })

  it('rejects invalid chatType', () => {
    const result = validateWebhookPayload({ ...validPayload, chatType: 'channel' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('chatType must be "direct" or "group"')
    }
  })

  it('rejects empty from', () => {
    const result = validateWebhookPayload({ ...validPayload, from: '' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('from is required')
    }
  })

  it('rejects empty text', () => {
    const result = validateWebhookPayload({ ...validPayload, text: '' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('text must be a non-empty string')
    }
  })

  it('rejects non-number timestamp', () => {
    const result = validateWebhookPayload({ ...validPayload, timestamp: 'not-a-number' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('timestamp must be a number when provided')
    }
  })

  it('rejects non-string displayName', () => {
    const result = validateWebhookPayload({ ...validPayload, displayName: 42 })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('displayName must be a string when provided')
    }
  })

  it('trims whitespace from string fields', () => {
    const result = validateWebhookPayload({
      accountId: '  default  ',
      event: '  message  ',
      chatType: 'direct',
      from: '  +15551234567  ',
      displayName: '  Nick  ',
      text: '  Hello  ',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.payload.accountId).toBe('default')
      expect(result.payload.from).toBe('+15551234567')
      expect(result.payload.displayName).toBe('Nick')
      expect(result.payload.text).toBe('Hello')
    }
  })
})

// ---------------------------------------------------------------------------
// shouldForwardMessage
// ---------------------------------------------------------------------------

describe('shouldForwardMessage', () => {
  const basePayload: WhatsAppWebhookPayload = {
    accountId: 'default',
    event: 'message',
    chatType: 'direct',
    from: '+15551234567',
    text: 'Hello',
  }

  it('returns false when bridge is disabled', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: false,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    }
    expect(shouldForwardMessage(basePayload, config)).toBe(false)
  })

  it('returns true with filterMode none when enabled', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    }
    expect(shouldForwardMessage(basePayload, config)).toBe(true)
  })

  it('allows whitelisted numbers', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: true,
      filterMode: 'whitelist',
      whitelist: ['+15551234567', '+15559999999'],
      keywords: [],
    }
    expect(shouldForwardMessage(basePayload, config)).toBe(true)
  })

  it('blocks non-whitelisted numbers', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: true,
      filterMode: 'whitelist',
      whitelist: ['+15559999999'],
      keywords: [],
    }
    expect(shouldForwardMessage(basePayload, config)).toBe(false)
  })

  it('allows messages matching keyword', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: true,
      filterMode: 'keyword',
      whitelist: [],
      keywords: ['urgent', 'deploy'],
    }
    const payload = { ...basePayload, text: 'This is URGENT please help' }
    expect(shouldForwardMessage(payload, config)).toBe(true)
  })

  it('blocks messages not matching any keyword', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: true,
      filterMode: 'keyword',
      whitelist: [],
      keywords: ['urgent', 'deploy'],
    }
    const payload = { ...basePayload, text: 'Just saying hello' }
    expect(shouldForwardMessage(payload, config)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// transformToChannelMessage
// ---------------------------------------------------------------------------

describe('transformToChannelMessage', () => {
  it('transforms a direct message payload', () => {
    const payload: WhatsAppWebhookPayload = {
      accountId: 'default',
      event: 'message',
      chatType: 'direct',
      from: '+15551234567',
      displayName: 'Nick',
      text: 'Hello commander',
    }

    const result = transformToChannelMessage(payload)
    expect(result).toEqual({
      provider: 'whatsapp',
      accountId: 'default',
      chatType: 'direct',
      peerId: '+15551234567',
      displayName: 'Nick',
      message: 'Hello commander',
      mode: 'followup',
    })
  })

  it('transforms a group message payload', () => {
    const payload: WhatsAppWebhookPayload = {
      accountId: 'work',
      event: 'message',
      chatType: 'group',
      from: '120363012345@g.us',
      text: 'Group alert',
    }

    const result = transformToChannelMessage(payload)
    expect(result).toEqual({
      provider: 'whatsapp',
      accountId: 'work',
      chatType: 'group',
      peerId: '120363012345@g.us',
      displayName: '120363012345@g.us',
      message: 'Group alert',
      mode: 'followup',
    })
  })

  it('falls back to from as displayName when displayName is absent', () => {
    const payload: WhatsAppWebhookPayload = {
      accountId: 'default',
      event: 'message',
      chatType: 'direct',
      from: '+15551234567',
      text: 'Hi',
    }

    const result = transformToChannelMessage(payload)
    expect(result.displayName).toBe('+15551234567')
  })
})

// ---------------------------------------------------------------------------
// resolveWhatsAppBridgeConfig — new Meta/routing fields
// ---------------------------------------------------------------------------

describe('resolveWhatsAppBridgeConfig — Meta fields', () => {
  it('parses Meta Cloud API env vars', () => {
    const config = resolveWhatsAppBridgeConfig({
      WHATSAPP_BRIDGE_ENABLED: 'true',
      WHATSAPP_VERIFY_TOKEN: 'my-verify-token',
      WHATSAPP_ACCESS_TOKEN: 'EAABx...',
      WHATSAPP_PHONE_NUMBER_ID: '123456789',
    })
    expect(config.verifyToken).toBe('my-verify-token')
    expect(config.accessToken).toBe('EAABx...')
    expect(config.phoneNumberId).toBe('123456789')
  })

  it('leaves Meta fields undefined when not set', () => {
    const config = resolveWhatsAppBridgeConfig({})
    expect(config.verifyToken).toBeUndefined()
    expect(config.accessToken).toBeUndefined()
    expect(config.phoneNumberId).toBeUndefined()
    expect(config.routing).toBeUndefined()
  })

  it('parses WHATSAPP_ROUTING JSON', () => {
    const config = resolveWhatsAppBridgeConfig({
      WHATSAPP_ROUTING: '{"default":"cmd-1","+15551234567":"cmd-2"}',
    })
    expect(config.routing).toEqual({
      default: 'cmd-1',
      '+15551234567': 'cmd-2',
    })
  })

  it('returns undefined routing for invalid JSON', () => {
    const config = resolveWhatsAppBridgeConfig({
      WHATSAPP_ROUTING: 'not-json',
    })
    expect(config.routing).toBeUndefined()
  })

  it('returns undefined routing for array JSON', () => {
    const config = resolveWhatsAppBridgeConfig({
      WHATSAPP_ROUTING: '["a","b"]',
    })
    expect(config.routing).toBeUndefined()
  })

  it('filters non-string values from routing', () => {
    const config = resolveWhatsAppBridgeConfig({
      WHATSAPP_ROUTING: '{"default":"cmd-1","bad":123}',
    })
    expect(config.routing).toEqual({ default: 'cmd-1' })
  })
})

// ---------------------------------------------------------------------------
// isMetaWebhookPayload
// ---------------------------------------------------------------------------

describe('isMetaWebhookPayload', () => {
  it('returns true for valid Meta format', () => {
    expect(
      isMetaWebhookPayload({
        object: 'whatsapp_business_account',
        entry: [],
      }),
    ).toBe(true)
  })

  it('returns false for generic format', () => {
    expect(
      isMetaWebhookPayload({
        accountId: 'default',
        event: 'message',
        chatType: 'direct',
        from: '+15551234567',
        text: 'Hello',
      }),
    ).toBe(false)
  })

  it('returns false for null', () => {
    expect(isMetaWebhookPayload(null)).toBe(false)
  })

  it('returns false for non-object', () => {
    expect(isMetaWebhookPayload('string')).toBe(false)
  })

  it('returns false when entry is not an array', () => {
    expect(
      isMetaWebhookPayload({
        object: 'whatsapp_business_account',
        entry: 'not-array',
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseMetaWebhook
// ---------------------------------------------------------------------------

describe('parseMetaWebhook', () => {
  const validMetaPayload: MetaWebhookPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                phone_number_id: '100200300',
                display_phone_number: '+14155551234',
              },
              contacts: [
                {
                  profile: { name: 'Nick' },
                  wa_id: '15559876543',
                },
              ],
              messages: [
                {
                  from: '15559876543',
                  id: 'wamid.abc123',
                  timestamp: '1712345678',
                  text: { body: 'Hello from WhatsApp' },
                  type: 'text',
                },
              ],
            },
          },
        ],
      },
    ],
  }

  it('extracts a text message with contact name', () => {
    const messages = parseMetaWebhook(validMetaPayload)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({
      from: '15559876543',
      displayName: 'Nick',
      text: 'Hello from WhatsApp',
      timestamp: 1712345678,
      phoneNumberId: '100200300',
      displayPhoneNumber: '+14155551234',
      messageId: 'wamid.abc123',
    })
  })

  it('skips non-text messages', () => {
    const payload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: '100200300',
                  display_phone_number: '+14155551234',
                },
                messages: [
                  {
                    from: '15559876543',
                    timestamp: '1712345678',
                    type: 'image',
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const messages = parseMetaWebhook(payload)
    expect(messages).toHaveLength(0)
  })

  it('skips empty text body', () => {
    const payload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: '100200300',
                  display_phone_number: '+14155551234',
                },
                messages: [
                  {
                    from: '15559876543',
                    timestamp: '1712345678',
                    text: { body: '   ' },
                    type: 'text',
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const messages = parseMetaWebhook(payload)
    expect(messages).toHaveLength(0)
  })

  it('falls back to phone number when contact name is missing', () => {
    const payload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: '100200300',
                  display_phone_number: '+14155551234',
                },
                messages: [
                  {
                    from: '15559876543',
                    timestamp: '1712345678',
                    text: { body: 'No contact info' },
                    type: 'text',
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const messages = parseMetaWebhook(payload)
    expect(messages).toHaveLength(1)
    expect(messages[0].displayName).toBe('15559876543')
  })

  it('handles entries with no messages array (status updates)', () => {
    const payload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                statuses: [{ id: 'wamid.abc', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    }
    const messages = parseMetaWebhook(payload)
    expect(messages).toHaveLength(0)
  })

  it('handles multiple messages in a single entry', () => {
    const payload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: '100200300',
                  display_phone_number: '+14155551234',
                },
                contacts: [
                  { profile: { name: 'Alice' }, wa_id: '11111111' },
                  { profile: { name: 'Bob' }, wa_id: '22222222' },
                ],
                messages: [
                  {
                    from: '11111111',
                    timestamp: '1712345678',
                    text: { body: 'Message from Alice' },
                    type: 'text',
                  },
                  {
                    from: '22222222',
                    timestamp: '1712345679',
                    text: { body: 'Message from Bob' },
                    type: 'text',
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const messages = parseMetaWebhook(payload)
    expect(messages).toHaveLength(2)
    expect(messages[0].displayName).toBe('Alice')
    expect(messages[1].displayName).toBe('Bob')
  })
})

// ---------------------------------------------------------------------------
// metaMessageToWebhookPayload
// ---------------------------------------------------------------------------

describe('metaMessageToWebhookPayload', () => {
  it('converts parsed Meta message to webhook payload', () => {
    const result = metaMessageToWebhookPayload({
      from: '15559876543',
      displayName: 'Nick',
      text: 'Hello',
      timestamp: 1712345678,
      phoneNumberId: '100200300',
      displayPhoneNumber: '+14155551234',
      messageId: 'wamid.abc123',
    })

    expect(result).toEqual({
      accountId: '100200300',
      event: 'message',
      chatType: 'direct',
      from: '15559876543',
      displayName: 'Nick',
      text: 'Hello',
      timestamp: 1712345678,
    })
  })

  it('uses custom accountId when provided', () => {
    const result = metaMessageToWebhookPayload(
      {
        from: '15559876543',
        displayName: 'Nick',
        text: 'Hello',
        timestamp: 1712345678,
        phoneNumberId: '100200300',
        displayPhoneNumber: '+14155551234',
      },
      'custom-account',
    )

    expect(result.accountId).toBe('custom-account')
  })
})

// ---------------------------------------------------------------------------
// resolveCommanderForMessage
// ---------------------------------------------------------------------------

describe('resolveCommanderForMessage', () => {
  it('returns specific commander for matched phone number', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
      commanderId: 'fallback-cmd',
      routing: {
        default: 'default-cmd',
        '+15551234567': 'specific-cmd',
      },
    }
    expect(resolveCommanderForMessage('+15551234567', config)).toBe('specific-cmd')
  })

  it('falls back to default routing key', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
      commanderId: 'fallback-cmd',
      routing: {
        default: 'default-cmd',
        '+15559999999': 'other-cmd',
      },
    }
    expect(resolveCommanderForMessage('+15551234567', config)).toBe('default-cmd')
  })

  it('falls back to commanderId when no routing match', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
      commanderId: 'fallback-cmd',
      routing: {
        '+15559999999': 'other-cmd',
      },
    }
    expect(resolveCommanderForMessage('+15551234567', config)).toBe('fallback-cmd')
  })

  it('falls back to commanderId when routing is undefined', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
      commanderId: 'fallback-cmd',
    }
    expect(resolveCommanderForMessage('+15551234567', config)).toBe('fallback-cmd')
  })

  it('returns undefined when no routing and no commanderId', () => {
    const config: WhatsAppBridgeConfig = {
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    }
    expect(resolveCommanderForMessage('+15551234567', config)).toBeUndefined()
  })
})
