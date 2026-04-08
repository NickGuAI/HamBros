/**
 * WhatsApp inbound bridge routes.
 *
 * Exposes `POST /api/whatsapp/webhook` which receives WhatsApp message events
 * (from OpenClaw or any WhatsApp gateway) and forwards them to the local
 * `POST /api/commanders/channel-message` endpoint.
 */

import { Router, type Request, type Response } from 'express'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import {
  type WhatsAppBridgeConfig,
  resolveWhatsAppBridgeConfig,
  validateWebhookPayload,
  shouldForwardMessage,
  transformToChannelMessage,
  forwardToChannelMessage,
  isMetaWebhookPayload,
  parseMetaWebhook,
  metaMessageToWebhookPayload,
  resolveCommanderForMessage,
} from './bridge.js'

// ---------------------------------------------------------------------------
// Route options
// ---------------------------------------------------------------------------

export interface WhatsAppBridgeRouterOptions {
  apiKeyStore?: ApiKeyStoreLike
  /** Override config instead of reading from environment (useful in tests). */
  config?: WhatsAppBridgeConfig
  /**
   * Base URL for internal forwarding to channel-message.
   * Defaults to `http://127.0.0.1:${PORT}` derived from the request.
   */
  internalBaseUrl?: string
  /** API key to use when forwarding to the channel-message endpoint. */
  internalApiKey?: string
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createWhatsAppBridgeRouter(
  options: WhatsAppBridgeRouterOptions = {},
): { router: Router } {
  const router = Router()
  const config = options.config ?? resolveWhatsAppBridgeConfig()

  // ------------------------------------------------------------------
  // GET /webhook — Meta Cloud API verification challenge
  // ------------------------------------------------------------------
  router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'] as string | undefined
    const token = req.query['hub.verify_token'] as string | undefined
    const challenge = req.query['hub.challenge'] as string | undefined

    if (mode === 'subscribe' && token && config.verifyToken && token === config.verifyToken) {
      res.status(200).send(challenge ?? '')
      return
    }

    res.status(403).json({ error: 'Verification failed' })
  })

  // ------------------------------------------------------------------
  // POST /webhook — receive WhatsApp messages (generic or Meta format)
  // ------------------------------------------------------------------
  router.post('/webhook', async (req, res) => {
    // ------------------------------------------------------------------
    // Gate: bridge must be enabled
    // ------------------------------------------------------------------
    if (!config.enabled) {
      res.status(503).json({ error: 'WhatsApp bridge is disabled' })
      return
    }

    // ------------------------------------------------------------------
    // Detect Meta Cloud API format
    // ------------------------------------------------------------------
    if (isMetaWebhookPayload(req.body)) {
      await handleMetaWebhook(req, res, config, options)
      return
    }

    // ------------------------------------------------------------------
    // Generic format: validate incoming webhook payload
    // ------------------------------------------------------------------
    const validation = validateWebhookPayload(req.body)
    if (!validation.valid) {
      res.status(400).json({ error: validation.error })
      return
    }

    const payload = validation.payload

    // ------------------------------------------------------------------
    // Apply message filter
    // ------------------------------------------------------------------
    if (!shouldForwardMessage(payload, config)) {
      res.status(200).json({
        accepted: false,
        reason: 'filtered',
        filterMode: config.filterMode,
      })
      return
    }

    // ------------------------------------------------------------------
    // Transform and forward
    // ------------------------------------------------------------------
    const channelMessage = transformToChannelMessage(payload)

    // Apply routing if available
    const commanderId = resolveCommanderForMessage(payload.from, config)
    if (commanderId) {
      channelMessage.commanderId = commanderId
    }

    const baseUrl =
      options.internalBaseUrl ??
      `${req.protocol}://${req.get('host') ?? '127.0.0.1'}`

    try {
      const result = await forwardToChannelMessage(channelMessage, {
        baseUrl,
        apiKey: options.internalApiKey,
      })

      res.status(result.status).json({
        forwarded: true,
        upstream: result.body,
      })
    } catch (error) {
      console.error('[whatsapp-bridge] Failed to forward message:', error)
      res.status(502).json({
        error: 'Failed to forward message to channel-message endpoint',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  })

  // Health-check / status endpoint
  router.get('/status', (_req, res) => {
    res.json({
      enabled: config.enabled,
      filterMode: config.filterMode,
      whitelistCount: config.whitelist.length,
      keywordCount: config.keywords.length,
    })
  })

  return { router }
}

// ---------------------------------------------------------------------------
// Meta Cloud API POST handler
// ---------------------------------------------------------------------------

async function handleMetaWebhook(
  req: Request,
  res: Response,
  config: WhatsAppBridgeConfig,
  options: WhatsAppBridgeRouterOptions,
): Promise<void> {
  const parsed = parseMetaWebhook(req.body)

  // Meta expects 200 even if there are no text messages (e.g. status updates)
  if (parsed.length === 0) {
    res.status(200).json({ accepted: true, messages: 0 })
    return
  }

  const baseUrl =
    options.internalBaseUrl ??
    `${req.protocol}://${req.get('host') ?? '127.0.0.1'}`

  const results: Array<{ from: string; forwarded: boolean; status?: number }> = []

  for (const msg of parsed) {
    const webhookPayload = metaMessageToWebhookPayload(msg)

    // Apply message filter
    if (!shouldForwardMessage(webhookPayload, config)) {
      results.push({ from: msg.from, forwarded: false })
      continue
    }

    const channelMessage = transformToChannelMessage(webhookPayload)

    // Apply multi-commander routing
    const commanderId = resolveCommanderForMessage(msg.from, config)
    if (commanderId) {
      channelMessage.commanderId = commanderId
    }

    try {
      const result = await forwardToChannelMessage(channelMessage, {
        baseUrl,
        apiKey: options.internalApiKey,
      })
      results.push({ from: msg.from, forwarded: true, status: result.status })
    } catch (error) {
      console.error('[whatsapp-bridge] Failed to forward Meta message:', error)
      results.push({ from: msg.from, forwarded: false })
    }
  }

  res.status(200).json({
    accepted: true,
    messages: parsed.length,
    results,
  })
}
