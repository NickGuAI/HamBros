import { randomUUID } from 'node:crypto'
import { DEFAULT_CLAUDE_EFFORT_LEVEL } from '../../claude-effort.js'
import { createDefaultHeartbeatState } from '../heartbeat.js'
import { withNamesLock } from '../names-lock.js'
import {
  parseLabel,
  parseMachineId,
  parseMessage,
  parseSessionId,
} from '../route-parsers.js'
import type { CommanderSession } from '../store.js'
import { scaffoldCommanderIdentity } from '../templates/render.js'
import { scaffoldCommanderWorkflow } from '../templates/workflow.js'
import type { CommanderRoutesContext } from './types.js'

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
      pid: null,
      state: 'idle',
      created: context.now().toISOString(),
      agentType: 'claude',
      effort: DEFAULT_CLAUDE_EFFORT_LEVEL,
      heartbeat: createDefaultHeartbeatState(),
      lastHeartbeat: null,
      heartbeatTickCount: 0,
      taskSource: null,
      currentTask: null,
      completedTasks: 0,
      totalCostUsd: 0,
      remoteOrigin: {
        machineId,
        label,
        syncToken,
      },
    }

    try {
      const created = await context.sessionStore.create(session)
      try {
        await scaffoldCommanderIdentity(
          created.id,
          {
            id: created.id,
            host: created.host,
            created: created.created,
          },
          context.commanderBasePath,
        )
        await scaffoldCommanderWorkflow(
          created.id,
          {},
          context.commanderBasePath,
        )
        await context.ensureCommanderMemoryCompactCronTask(created.id)
      } catch (scaffoldError) {
        await context.sessionStore.delete(created.id).catch(() => {})
        throw scaffoldError
      }
      try {
        await withNamesLock(context.commanderDataDir, (names) => { names[created.id] = displayName })
      } catch (error) {
        console.warn(
          `[commanders] Failed to persist display name for "${created.id}":`,
          error,
        )
      }
      res.status(201).json({ commanderId: created.id, syncToken })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to register remote commander',
      })
    }
  })
}
