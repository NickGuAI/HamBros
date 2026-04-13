import { withNamesLock } from '../names-lock.js'
import {
  formatChannelCommanderDisplayName,
  parseChannelMessageInput,
  parseMessage,
  parseSessionId,
} from '../route-parsers.js'
import type { CommanderRoutesContext } from './types.js'

export function registerChannelRoutes(
  router: import('express').Router,
  context: CommanderRoutesContext,
): void {
  router.post('/channel-message', context.requireWriteAccess, async (req, res) => {
    const parsed = parseChannelMessageInput(req.body)
    if (!parsed.valid) {
      res.status(400).json({ error: parsed.error })
      return
    }

    try {
      const upserted = await context.sessionStore.findOrCreateBySessionKey(
        parsed.value.channelMeta.sessionKey,
        {
          channelMeta: parsed.value.channelMeta,
          lastRoute: parsed.value.lastRoute,
          host: parsed.value.host,
        },
      )

      if (upserted.created) {
        await context.ensureCommanderMemoryCompactCronTask(upserted.commander.id)
        try {
          await withNamesLock(context.commanderDataDir, (names) => {
            names[upserted.commander.id] = formatChannelCommanderDisplayName(parsed.value.channelMeta)
          })
        } catch (error) {
          console.warn(
            `[commanders] Failed to persist display name for "${upserted.commander.id}":`,
            error,
          )
        }
      }

      const delivered = await context.dispatchCommanderMessage({
        commanderId: upserted.commander.id,
        message: parsed.value.message,
        mode: parsed.value.mode,
        pendingSpikeObservations: [],
      })

      if (!delivered.ok) {
        if (delivered.status === 409) {
          res.status(upserted.created ? 201 : 200).json({
            accepted: true,
            delivered: false,
            created: upserted.created,
            commanderId: upserted.commander.id,
            sessionKey: parsed.value.channelMeta.sessionKey,
            delivery: {
              status: 'not-delivered',
              message: delivered.error,
            },
          })
          return
        }

        res.status(delivered.status).json({
          accepted: false,
          delivered: false,
          created: upserted.created,
          commanderId: upserted.commander.id,
          sessionKey: parsed.value.channelMeta.sessionKey,
          error: delivered.error,
        })
        return
      }

      res.status(upserted.created ? 201 : 200).json({
        accepted: true,
        delivered: true,
        created: upserted.created,
        commanderId: upserted.commander.id,
        sessionKey: parsed.value.channelMeta.sessionKey,
      })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to route channel message',
      })
    }
  })

  router.post('/:id/channel-reply', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const message = parseMessage(req.body?.message)
    if (!message) {
      res.status(400).json({ error: 'message must be a non-empty string' })
      return
    }

    const delivered = await context.dispatchCommanderChannelReply({
      commanderId,
      message,
    })
    if (!delivered.ok) {
      res.status(delivered.status).json({ error: delivered.error })
      return
    }

    res.json({
      accepted: true,
      delivered: true,
      commanderId,
      provider: delivered.provider,
      sessionKey: delivered.sessionKey,
      lastRoute: delivered.lastRoute,
    })
  })
}
