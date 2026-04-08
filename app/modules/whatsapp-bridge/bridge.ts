/**
 * WhatsApp inbound bridge — transforms incoming WhatsApp webhook events
 * into the channel-message format expected by the commanders module.
 */

// ---------------------------------------------------------------------------
// Webhook payload (from OpenClaw or any WhatsApp gateway)
// ---------------------------------------------------------------------------

export interface WhatsAppWebhookPayload {
  accountId: string
  event: string
  chatType: 'direct' | 'group'
  from: string
  displayName?: string
  text: string
  timestamp?: number
}

// ---------------------------------------------------------------------------
// Channel-message payload (forwarded to POST /api/commanders/channel-message)
// ---------------------------------------------------------------------------

export interface ChannelMessagePayload {
  provider: 'whatsapp'
  accountId: string
  chatType: 'direct' | 'group'
  peerId: string
  displayName: string
  message: string
  mode: 'followup' | 'collect'
  /** Target commander ID, resolved via routing config. */
  commanderId?: string
}

// ---------------------------------------------------------------------------
// Config resolved from environment
// ---------------------------------------------------------------------------

export interface WhatsAppBridgeConfig {
  enabled: boolean
  commanderId?: string
  filterMode: 'none' | 'whitelist' | 'keyword'
  whitelist: string[]
  keywords: string[]
  /** Token used to verify Meta Cloud API webhook subscriptions. */
  verifyToken?: string
  /** Bearer token for outbound Meta Cloud API calls. */
  accessToken?: string
  /** Phone number ID for outbound Meta Cloud API messages. */
  phoneNumberId?: string
  /** JSON map of WhatsApp number/group → commander ID for multi-commander routing. */
  routing?: Record<string, string>
}

export function resolveWhatsAppBridgeConfig(
  env: Record<string, string | undefined> = process.env,
): WhatsAppBridgeConfig {
  const enabled = parseBooleanEnv(env.WHATSAPP_BRIDGE_ENABLED)
  const commanderId = env.WHATSAPP_COMMANDER_ID?.trim() || undefined
  const filterMode = parseFilterMode(env.WHATSAPP_FILTER_MODE)
  const whitelist = parseCommaSeparated(env.WHATSAPP_FILTER_WHITELIST)
  const keywords = parseCommaSeparated(env.WHATSAPP_FILTER_KEYWORDS)
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim() || undefined
  const accessToken = env.WHATSAPP_ACCESS_TOKEN?.trim() || undefined
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim() || undefined
  const routing = parseRoutingConfig(env.WHATSAPP_ROUTING)

  return {
    enabled,
    commanderId,
    filterMode,
    whitelist,
    keywords,
    verifyToken,
    accessToken,
    phoneNumberId,
    routing,
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationSuccess {
  valid: true
  payload: WhatsAppWebhookPayload
}

export interface ValidationFailure {
  valid: false
  error: string
}

export type ValidationResult = ValidationSuccess | ValidationFailure

export function validateWebhookPayload(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Payload must be a JSON object' }
  }

  const body = raw as Record<string, unknown>

  if (typeof body.accountId !== 'string' || body.accountId.trim().length === 0) {
    return { valid: false, error: 'accountId is required' }
  }

  if (typeof body.event !== 'string' || body.event.trim().length === 0) {
    return { valid: false, error: 'event is required' }
  }

  const eventType = (body.event as string).trim()
  if (eventType !== 'message') {
    return { valid: false, error: `Unsupported event type: ${eventType}` }
  }

  if (body.chatType !== 'direct' && body.chatType !== 'group') {
    return { valid: false, error: 'chatType must be "direct" or "group"' }
  }

  if (typeof body.from !== 'string' || body.from.trim().length === 0) {
    return { valid: false, error: 'from is required' }
  }

  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return { valid: false, error: 'text must be a non-empty string' }
  }

  if (body.timestamp !== undefined && typeof body.timestamp !== 'number') {
    return { valid: false, error: 'timestamp must be a number when provided' }
  }

  if (body.displayName !== undefined && typeof body.displayName !== 'string') {
    return { valid: false, error: 'displayName must be a string when provided' }
  }

  return {
    valid: true,
    payload: {
      accountId: body.accountId.trim(),
      event: body.event.trim(),
      chatType: body.chatType,
      from: body.from.trim(),
      displayName: typeof body.displayName === 'string' ? body.displayName.trim() : undefined,
      text: body.text.trim(),
      timestamp: typeof body.timestamp === 'number' ? body.timestamp : undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export function shouldForwardMessage(
  payload: WhatsAppWebhookPayload,
  config: WhatsAppBridgeConfig,
): boolean {
  if (!config.enabled) {
    return false
  }

  switch (config.filterMode) {
    case 'none':
      return true

    case 'whitelist':
      return config.whitelist.includes(payload.from)

    case 'keyword': {
      const lowerText = payload.text.toLowerCase()
      return config.keywords.some((keyword) => lowerText.includes(keyword.toLowerCase()))
    }

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Transform webhook payload into channel-message format
// ---------------------------------------------------------------------------

export function transformToChannelMessage(
  payload: WhatsAppWebhookPayload,
): ChannelMessagePayload {
  return {
    provider: 'whatsapp',
    accountId: payload.accountId,
    chatType: payload.chatType,
    peerId: payload.from,
    displayName: payload.displayName || payload.from,
    message: payload.text,
    mode: 'followup',
  }
}

// ---------------------------------------------------------------------------
// Forward to channel-message endpoint (local HTTP call)
// ---------------------------------------------------------------------------

export interface ForwardResult {
  ok: boolean
  status: number
  body: Record<string, unknown>
}

export async function forwardToChannelMessage(
  channelMessagePayload: ChannelMessagePayload,
  options: {
    baseUrl: string
    apiKey?: string
  },
): Promise<ForwardResult> {
  const url = `${options.baseUrl}/api/commanders/channel-message`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options.apiKey) {
    headers['x-hammurabi-api-key'] = options.apiKey
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(channelMessagePayload),
  })

  let body: Record<string, unknown>
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    body = { error: `Non-JSON response (status ${response.status})` }
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  }
}

// ---------------------------------------------------------------------------
// Meta Cloud API webhook format
// ---------------------------------------------------------------------------

export interface MetaWebhookPayload {
  object: string
  entry: MetaWebhookEntry[]
}

export interface MetaWebhookEntry {
  id?: string
  changes: MetaWebhookChange[]
}

export interface MetaWebhookChange {
  value: MetaWebhookChangeValue
  field?: string
}

export interface MetaWebhookChangeValue {
  messaging_product: string
  metadata?: {
    phone_number_id: string
    display_phone_number: string
  }
  contacts?: Array<{
    profile: { name: string }
    wa_id: string
  }>
  messages?: Array<{
    from: string
    id?: string
    timestamp: string
    text?: { body: string }
    type: string
  }>
  statuses?: unknown[]
}

export interface ParsedMetaMessage {
  from: string
  displayName: string
  text: string
  timestamp: number
  phoneNumberId: string
  displayPhoneNumber: string
  messageId?: string
}

/**
 * Detects whether a raw webhook body is in Meta Cloud API format.
 */
export function isMetaWebhookPayload(body: unknown): body is MetaWebhookPayload {
  if (!body || typeof body !== 'object') return false
  const obj = body as Record<string, unknown>
  return obj.object === 'whatsapp_business_account' && Array.isArray(obj.entry)
}

/**
 * Parses a Meta Cloud API webhook payload and extracts text messages.
 * Non-text messages (images, stickers, etc.) are silently skipped.
 */
export function parseMetaWebhook(payload: MetaWebhookPayload): ParsedMetaMessage[] {
  const messages: ParsedMetaMessage[] = []

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const value = change.value
      if (!value.messages || !Array.isArray(value.messages)) continue

      const phoneNumberId = value.metadata?.phone_number_id ?? ''
      const displayPhoneNumber = value.metadata?.display_phone_number ?? ''

      // Build a lookup of wa_id → profile name from contacts array
      const contactNames = new Map<string, string>()
      if (value.contacts && Array.isArray(value.contacts)) {
        for (const contact of value.contacts) {
          if (contact.wa_id && contact.profile?.name) {
            contactNames.set(contact.wa_id, contact.profile.name)
          }
        }
      }

      for (const msg of value.messages) {
        // Only handle text messages
        if (msg.type !== 'text' || !msg.text?.body) continue

        const text = msg.text.body.trim()
        if (text.length === 0) continue

        messages.push({
          from: msg.from,
          displayName: contactNames.get(msg.from) ?? msg.from,
          text,
          timestamp: parseInt(msg.timestamp, 10) || 0,
          phoneNumberId,
          displayPhoneNumber,
          messageId: msg.id,
        })
      }
    }
  }

  return messages
}

/**
 * Converts a parsed Meta message into the bridge's internal webhook payload format.
 */
export function metaMessageToWebhookPayload(
  msg: ParsedMetaMessage,
  accountId?: string,
): WhatsAppWebhookPayload {
  return {
    accountId: accountId ?? msg.phoneNumberId,
    event: 'message',
    chatType: 'direct',
    from: msg.from,
    displayName: msg.displayName,
    text: msg.text,
    timestamp: msg.timestamp,
  }
}

// ---------------------------------------------------------------------------
// Multi-commander routing
// ---------------------------------------------------------------------------

/**
 * Resolves which commander should handle a message, based on the sender's
 * phone number and the routing config. Falls back to the `default` key in
 * the routing map, then to `config.commanderId`.
 */
export function resolveCommanderForMessage(
  from: string,
  config: WhatsAppBridgeConfig,
): string | undefined {
  if (config.routing) {
    if (config.routing[from]) return config.routing[from]
    if (config.routing['default']) return config.routing['default']
  }
  return config.commanderId
}

// ---------------------------------------------------------------------------
// Outbound reply via Meta Cloud API
// ---------------------------------------------------------------------------

export interface SendWhatsAppReplyOptions {
  accessToken: string
  phoneNumberId: string
  to: string
  text: string
}

export interface SendWhatsAppReplyResult {
  ok: boolean
  status: number
  body: Record<string, unknown>
}

/**
 * Sends a text message via the Meta Cloud API (WhatsApp Business).
 */
export async function sendWhatsAppReply(
  options: SendWhatsAppReplyOptions,
): Promise<SendWhatsAppReplyResult> {
  const url = `https://graph.facebook.com/v21.0/${options.phoneNumberId}/messages`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: options.to,
      text: { body: options.text },
    }),
  })

  let body: Record<string, unknown>
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    body = { error: `Non-JSON response (status ${response.status})` }
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function parseFilterMode(value: string | undefined): 'none' | 'whitelist' | 'keyword' {
  if (!value) {
    return 'none'
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'whitelist' || normalized === 'keyword') {
    return normalized
  }
  return 'none'
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) {
    return []
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function parseRoutingConfig(
  value: string | undefined,
): Record<string, string> | undefined {
  if (!value || value.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(value.trim())
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined
    }
    // Validate all values are strings
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') {
        result[k] = v
      }
    }
    return Object.keys(result).length > 0 ? result : undefined
  } catch {
    return undefined
  }
}
