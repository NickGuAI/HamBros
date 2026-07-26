import { AutomationExecutor } from './executor.js'
import { AutomationQuestEventBus } from './quest-event-bus.js'
import { AutomationScheduler } from './scheduler.js'
import { AutomationStore } from './store.js'
import {
  COMMANDER_TRANSCRIPT_MAINTENANCE_CRON,
} from '../commanders/cron.js'
import { maintainCommanderTranscriptIndex } from '../commanders/transcript-index.js'
import { createAutomationsRouter } from './routes.js'
import type {
  ModuleRouteRegistration,
  ModuleRuntimeContext,
} from '../../server/module-runtime.js'

export function createAutomationsEventBusFoundation(context: ModuleRuntimeContext): null {
  context.capabilities.provide('automations.quest-event-bus', 'automations', new AutomationQuestEventBus())
  return null
}

export function createAutomationsFoundation(context: ModuleRuntimeContext): null {
  const { capabilities, internalToken, options } = context
  const commanderDataDir = capabilities.consume('commanders.data-dir', 'automations')
  const automationStore = new AutomationStore({ commanderDataDir })
  const automationExecutor = new AutomationExecutor({
    store: automationStore,
    commanderDataDir,
    internalToken,
  })
  const automationScheduler = new AutomationScheduler({
    store: automationStore,
    executor: automationExecutor,
    commanderStore: capabilities.consume('commanders.store', 'automations'),
    questEventBus: capabilities.consume('automations.quest-event-bus', 'automations'),
  })
  const automationSchedulerInitialized = options.initializeAutomationScheduler === false
    ? Promise.resolve()
    : automationScheduler.initialize()

  if (options.initializeAutomationScheduler !== false) {
    void automationSchedulerInitialized.catch((error) => {
      console.error('[automations] Failed to initialize shared scheduler:', error)
    })
  }

  capabilities.provide('automations.store', 'automations', automationStore)
  capabilities.provide('automations.executor', 'automations', automationExecutor)
  capabilities.provide('automations.scheduler', 'automations', automationScheduler)
  capabilities.provide('automations.scheduler-initialized', 'automations', automationSchedulerInitialized)

  return null
}

export function createAutomationsRuntime(context: ModuleRuntimeContext): ModuleRouteRegistration {
  const { capabilities, commandRoomMonitorOptions, internalToken, options } = context
  const automationScheduler = capabilities.consume('automations.scheduler', 'automations')
  const automationSchedulerInitialized = capabilities.consume('automations.scheduler-initialized', 'automations')
  const commanderDataDir = capabilities.consume('commanders.data-dir', 'automations')
  const commanderStore = capabilities.consume('commanders.store', 'automations')

  if (options.initializeAutomationScheduler !== false) {
    automationScheduler.registerInternalSchedule(
      'commander-transcript-maintenance',
      process.env.COMMANDER_TRANSCRIPT_MAINTENANCE_CRON?.trim() || COMMANDER_TRANSCRIPT_MAINTENANCE_CRON,
      async () => {
        const commanderIds = (await commanderStore.list()).map((session) => session.id)
        for (const commanderId of commanderIds) {
          await maintainCommanderTranscriptIndex(commanderId, { basePath: commanderDataDir }).catch((error) => {
            console.error(`[commanders] Failed transcript maintenance for ${commanderId}:`, error)
          })
        }
      },
    )
  }

  const automations = createAutomationsRouter({
    apiKeyStore: options.apiKeyStore,
    auth0Domain: options.auth0Domain,
    auth0Audience: options.auth0Audience,
    auth0ClientId: options.auth0ClientId,
    store: capabilities.consume('automations.store', 'automations'),
    executor: capabilities.consume('automations.executor', 'automations'),
    scheduler: automationScheduler,
    schedulerInitialized: automationSchedulerInitialized,
    commanderStore,
    internalToken,
    monitorOptions: commandRoomMonitorOptions,
  })

  return {
    name: 'automations',
    routeIds: ['automations.api'],
    router: automations.router,
    shutdown: () => automationScheduler.shutdown(),
  }
}
