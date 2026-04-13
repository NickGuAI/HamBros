import { parseEmailSourceConfig } from '../email-config.js'
import { parseMessage, parseSessionId } from '../route-parsers.js'
import type { CommanderRoutesContext } from './types.js'

export function registerEmailRoutes(
  router: import('express').Router,
  context: CommanderRoutesContext,
): void {
  router.get('/:id/email/config', context.requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const config = await context.emailConfigStore.get(commanderId)
    res.json({ config })
  })

  router.put('/:id/email/config', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const parsedConfig = parseEmailSourceConfig(req.body)
    if (!parsedConfig.ok) {
      res.status(400).json({ error: parsedConfig.error })
      return
    }

    const config = await context.emailConfigStore.set(commanderId, parsedConfig.value)
    res.json({ config })
  })

  router.post('/:id/email/reply', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const messageId = parseMessage(req.body?.messageId)
    if (!messageId) {
      res.status(400).json({ error: 'messageId must be a non-empty string' })
      return
    }

    const body = parseMessage(req.body?.body)
    if (!body) {
      res.status(400).json({ error: 'body must be a non-empty string' })
      return
    }
    const threadId = parseMessage(req.body?.threadId) ?? undefined

    const config = await context.emailConfigStore.get(commanderId)
    if (!config) {
      res.status(409).json({ error: 'Commander email config is not set' })
      return
    }

    if (!context.emailReplyService) {
      res.status(500).json({ error: 'Commander email reply service not configured' })
      return
    }

    try {
      const reply = await context.emailReplyService.sendReply(
        commanderId,
        config,
        {
          messageId,
          ...(threadId ? { threadId } : {}),
          body,
        },
      )

      res.json({
        accepted: true,
        account: reply.account,
        threadId: reply.threadId,
        messageId,
      })
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to send email reply',
      })
    }
  })
}
