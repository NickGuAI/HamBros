import { randomUUID } from 'node:crypto'
import { DEFAULT_CLAUDE_EFFORT_LEVEL } from '../../claude-effort.js'
import {
  setCommanderDisplayName,
  UnknownCommanderError,
} from '../names-lock.js'
import {
  parseLabel,
  parseMachineId,
  parseMessage,
  parseSessionId,
} from '../route-parsers.js'
import { createDefaultHeartbeatConfig } from '../heartbeat.js'
import {
  DEFAULT_COMMANDER_CONTEXT_MODE,
  type CommanderSession,
} from '../store.js'
import { scaffoldCommanderWorkflow } from '../templates/workflow.js'
import type { CommanderRoutesContext } from './types.js'
import { beginCommanderProvisioning } from '../child-mutation-coordinator.js'
import { deleteCommanderStateOwned } from '../commander-deletion.js'

export function registerRemoteRoutes(
  router: import('express').Router,
  context: CommanderRoutesContext,
): void {
  router.post('/remote/register', context.requireWriteAccess, async (req, res) => {
    const machineId = parseMachineId(req.body?.machineId)
    const label = parseLabel(req.body?.label)
    if (!machineId || !label) {
      res.status(400).json({ error: 'machineId and label are required' })
      return
    }

    const displayName = parseMessage(req.body?.displayName) ?? label
    const requestedCommanderId = req.body?.commanderId
    if (requestedCommanderId !== undefined && requestedCommanderId !== null) {
      const commanderId = parseSessionId(requestedCommanderId)
      if (!commanderId) {
        res.status(400).json({ error: 'commanderId is invalid' })
        return
      }

      const session = await context.sessionStore.get(commanderId)
      if (!session) {
        res.status(404).json({ error: `Commander "${commanderId}" not found` })
        return
      }

      const syncToken = randomUUID()
      const updated = await context.sessionStore.update(commanderId, (current) => ({
        ...current,
        executionMachineId: machineId,
        remoteOrigin: {
          machineId,
          label,
          syncToken,
        },
      }))
      if (!updated) {
        res.status(404).json({ error: `Commander "${commanderId}" not found` })
        return
      }

      res.json({ commanderId: updated.id, syncToken })
      return
    }

    const syncToken = randomUUID()
    const session: CommanderSession = {
      id: randomUUID(),
      host: label,
      executionMachineId: machineId,
      state: 'idle',
      created: context.now().toISOString(),
      agentType: 'claude',
      effort: DEFAULT_CLAUDE_EFFORT_LEVEL,
      heartbeat: createDefaultHeartbeatConfig(),
      maxTurns: context.runtimeConfig.defaults.maxTurns,
      contextMode: DEFAULT_COMMANDER_CONTEXT_MODE,
      taskSource: null,
      remoteOrigin: {
        machineId,
        label,
        syncToken,
      },
    }

    const lease = await beginCommanderProvisioning(
      session.id,
      context.commanderDataDir,
      async () => Boolean(await context.sessionStore.get(session.id)),
    )
    if (!lease) {
      res.status(409).json({ error: `Commander "${session.id}" cannot be provisioned` })
      return
    }

    let deleted = false
    let createdCommanderId: string | null = null
    try {
      const created = await lease.runOwned(async () => {
        const provisioned = await context.sessionStore.create(session)
        await context.ensureDefaultConversation(provisioned, { surface: 'api' })
        await scaffoldCommanderWorkflow(
          provisioned.id,
          { displayName },
          context.commanderBasePath,
          context.commanderDataDir,
        )
        try {
          await setCommanderDisplayName(context.commanderDataDir, provisioned.id, displayName)
        } catch (error) {
          if (!(error instanceof UnknownCommanderError)) {
            console.warn(
              `[commanders] Failed to persist display name for "${provisioned.id}":`,
              error,
            )
          }
        }
        return provisioned
      })
      createdCommanderId = created.id
      lease.complete({ deleted: false })
    } catch (error) {
      let rollback: Awaited<ReturnType<typeof deleteCommanderStateOwned>>
      try {
        rollback = await lease.runOwned(async () => {
          const [conversations, automations] = await Promise.all([
            context.conversationStore.listByCommander(session.id),
            context.automationStore.list({ parentCommanderId: session.id }),
          ])
          return deleteCommanderStateOwned({
            commanderId: session.id,
            commanderDataDir: context.commanderDataDir,
            commanderBasePath: context.commanderBasePath,
            sessionStore: context.sessionStore,
            channelBindingStore: context.channelBindingStore,
            questStore: context.questStore,
            heartbeatLog: context.heartbeatLog,
            allowMissingSession: true,
            deleteChildren: async () => {
              for (const { id } of [...automations].reverse()) {
                if (context.automationScheduler) {
                  await context.automationScheduler.deleteAutomation(id)
                } else {
                  await context.automationStore.delete(id, { removeFiles: true })
                }
              }
              for (const { id } of conversations) {
                await context.conversationStore.delete(id)
              }
            },
          })
        })
      } catch (rollbackError) {
        rollback = { deleted: false, error: rollbackError }
      }
      deleted = rollback.deleted
      lease.complete({ deleted })
      if (!rollback.deleted) {
        console.warn(
          `[commanders] Failed to fully roll back remote commander "${session.id}":`,
          rollback.error,
        )
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to register remote commander',
      })
      return
    } finally {
      lease.complete({ deleted })
    }
    res.status(201).json({ commanderId: createdCommanderId!, syncToken })
  })
}
