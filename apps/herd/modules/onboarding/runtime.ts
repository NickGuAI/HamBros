import { createOnboardingRouter } from './route.js'
import type {
  ModuleRouteRegistration,
  ModuleRuntimeContext,
} from '../../server/module-runtime.js'

export function createOnboardingRuntime(context: ModuleRuntimeContext): ModuleRouteRegistration {
  const { capabilities, internalToken, options } = context

  return {
    name: 'onboarding',
    label: 'Onboarding',
    routeIds: ['onboarding.api'],
    router: createOnboardingRouter({
      apiKeyStore: options.apiKeyStore,
      auth0Domain: options.auth0Domain,
      auth0Audience: options.auth0Audience,
      auth0ClientId: options.auth0ClientId,
      internalToken,
      operatorStore: capabilities.consume('operators.store', 'onboarding'),
      sessionStore: capabilities.consume('commanders.store', 'onboarding'),
      conversationStore: capabilities.consume('commanders.conversations', 'onboarding'),
      automationStore: capabilities.consume('automations.store', 'onboarding'),
      automationScheduler: capabilities.consume('automations.scheduler', 'onboarding'),
      automationSchedulerInitialized: capabilities.consume('automations.scheduler-initialized', 'onboarding'),
      commanderDataDir: capabilities.consume('commanders.data-dir', 'onboarding'),
      providerRegistry: capabilities.consume('agents.provider-registry', 'onboarding'),
      providerExecution: capabilities.consume('agents.provider-execution', 'onboarding'),
    }),
  }
}
