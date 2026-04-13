import { Router } from 'express'
import { registerChannelRoutes } from './register-channels.js'
import { registerEmailRoutes } from './register-email.js'
import { buildCommandersContext } from './context.js'
import { registerCommandRoomRoutes } from './register-command-room.js'
import { registerCoreRoutes } from './register-core.js'
import { registerMemoryRoutes } from './register-memory.js'
import { registerQuestRoutes } from './register-quests.js'
import { registerRemoteRoutes } from './register-remote.js'
import { registerWorkspaceRoutes } from './register-workspace.js'
import type { CommandersRouterOptions, CommandersRouterResult } from './types.js'

export type { CommandersRouterOptions, CommandersRouterResult } from './types.js'
export type {
  CommanderChannelReplyDispatchInput,
  CommanderChannelReplyDispatcher,
} from './types.js'
export { buildCommanderSessionSeed } from './context.js'

export function createCommandersRouter(
  options: CommandersRouterOptions = {},
): CommandersRouterResult {
  const router = Router()
  const context = buildCommandersContext(options)

  // Static top-level routes are mounted before the broader commander surface.
  registerRemoteRoutes(router, context)
  registerChannelRoutes(router, context)
  registerQuestRoutes(router, context)
  registerCoreRoutes(router, context)
  registerWorkspaceRoutes(router, context)
  registerEmailRoutes(router, context)
  registerCommandRoomRoutes(router, context)
  registerMemoryRoutes(router, context)

  setTimeout(() => {
    void context.reconcileCommanderSessions().catch((error) => {
      console.error('[commanders] Startup reconciliation failed:', error)
    })
  }, 0)

  return { router }
}
