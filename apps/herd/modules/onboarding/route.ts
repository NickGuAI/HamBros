import type { AuthUser } from '@gehirn/auth-providers'
import { Router, type Request, type RequestHandler, type Response } from 'express'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import type { ProviderRegistryCapability } from '../../server/module-runtime-capabilities.js'
import type { ProviderExecutionCapability } from '../agents/provider-execution-mode.js'
import type { AutomationScheduler } from '../automations/scheduler.js'
import type { AutomationStore } from '../automations/store.js'
import type { ConversationStore } from '../commanders/conversation-store.js'
import type { CommanderSessionStore } from '../commanders/store.js'
import type { loadCommanderPackage } from '../commanders/packages/registry.js'
import type { OperatorStore } from '../operators/store.js'
import { OrgIdentityStore } from '../org-identity/store.js'
import {
  buildOnboardingStatus,
  gaiaCommanderExists,
  seedGaiaCommander,
  seedStarterWorkforce,
  skipStarterWorkforce,
  StarterWorkforcePreflightError,
  type OnboardingShellRunner,
} from './status.js'
import type { resolveSkill } from '../automations/skills.js'
import type { OnboardingCredentialAuth } from './contracts.js'

export interface OnboardingRouterOptions {
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
  internalToken?: string
  operatorStore: Pick<OperatorStore, 'getFounder'>
  orgIdentityStore?: OrgIdentityStore
  sessionStore: Pick<
    CommanderSessionStore,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'restoreAfterFailedCleanup'
  >
  conversationStore?: Pick<ConversationStore, 'listByCommander' | 'getActiveChatForCommander' | 'ensureDefaultConversation' | 'delete'>
  automationStore?: Pick<AutomationStore, 'create' | 'delete' | 'list'>
  automationScheduler?: Pick<AutomationScheduler, 'createAutomation' | 'deleteAutomation'>
  automationSchedulerInitialized?: Promise<void>
  resolveAutomationSkill?: typeof resolveSkill
  loadStarterPackage?: typeof loadCommanderPackage
  commanderDataDir: string
  providerRegistry: ProviderRegistryCapability
  providerExecution: ProviderExecutionCapability
  shellRunner?: OnboardingShellRunner
  env?: NodeJS.ProcessEnv
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  const first = raw?.split(',')[0]?.trim()
  return first && first.length > 0 ? first : null
}

function normalizeConfiguredBaseUrl(value: string | undefined): string | null {
  const normalized = value?.trim()
  if (!normalized) {
    return null
  }

  try {
    return new URL(normalized).origin
  } catch {
    return null
  }
}

function resolvePublicBaseUrl(req: Request, env: NodeJS.ProcessEnv | undefined): string {
  const runtimeEnv = env ?? process.env
  const configured = normalizeConfiguredBaseUrl(runtimeEnv.HERD_PUBLIC_BASE_URL)
  if (configured) {
    return configured
  }

  const forwardedProto = firstHeaderValue(req.headers['x-forwarded-proto'])
  const forwardedHost = firstHeaderValue(req.headers['x-forwarded-host'])
  const host = forwardedHost ?? firstHeaderValue(req.headers.host) ?? 'localhost:20001'
  const protocol = forwardedProto === 'https' || forwardedProto === 'http'
    ? forwardedProto
    : req.protocol || 'http'

  return `${protocol}://${host}`
}

type OnboardingAsyncHandler = (req: Request, res: Response) => Promise<void>

function controlledOnboardingRoute(
  action: string,
  handler: OnboardingAsyncHandler,
  options: { starterWorkforceInstall?: boolean } = {},
): RequestHandler {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (options.starterWorkforceInstall && error instanceof StarterWorkforcePreflightError) {
        res.status(409).json({
          code: 'STARTER_WORKFORCE_PREFLIGHT_FAILED',
          error: error.message,
          missingPackageIds: error.missingPackageIds,
          missingSkillIds: error.missingSkillIds,
        })
        return
      }

      console.error(`[onboarding] ${action} failed:`, error)
      if (options.starterWorkforceInstall) {
        res.status(500).json({
          code: 'STARTER_WORKFORCE_INSTALL_FAILED',
          error: 'Starter workforce installation failed. Review the server logs, correct the failure, and retry.',
        })
        return
      }
      res.status(500).json({
        code: 'ONBOARDING_REQUEST_FAILED',
        error: 'Onboarding request failed. Review the server logs, correct the failure, and retry.',
      })
    }
  }
}

export function createOnboardingRouter(options: OnboardingRouterOptions): Router {
  const router = Router()
  const orgIdentityStore = options.orgIdentityStore ?? new OrgIdentityStore()

  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['commanders:read'],
    requiredAuth0Permissions: ['commanders:read', 'org:read'],
    auth0PermissionMode: 'any',
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
    internalToken: options.internalToken,
  })
  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['commanders:write'],
    requiredAuth0Permissions: ['commanders:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
    internalToken: options.internalToken,
  })

  function authenticatedCredential(req: Request): OnboardingCredentialAuth {
    if (req.authMode === 'auth0') {
      return 'auth0'
    }
    const purpose = req.user?.metadata?.keyPurpose
    return purpose === 'bootstrap' || purpose === 'permanent' ? purpose : 'unknown'
  }

  function authenticatedCanManageApiKeys(req: Request): boolean {
    if (req.authMode === 'auth0') {
      return true
    }
    const scopes = req.user?.metadata?.scopes
    return Array.isArray(scopes) && scopes.includes('agents:admin')
  }

  async function status(req: Request) {
    return buildOnboardingStatus({
      user: req.user,
      operatorStore: options.operatorStore,
      orgIdentityStore,
      sessionStore: options.sessionStore,
      conversationStore: options.conversationStore,
      automationStore: options.automationStore,
      commanderDataDir: options.commanderDataDir,
      publicBaseUrl: resolvePublicBaseUrl(req, options.env),
      providers: options.providerRegistry.listProviders(),
      providerExecution: options.providerExecution,
      apiKeyStore: options.apiKeyStore,
      authenticatedCredential: authenticatedCredential(req),
      authenticatedCanManageApiKeys: authenticatedCanManageApiKeys(req),
      env: options.env,
      shellRunner: options.shellRunner,
      loadStarterPackage: options.loadStarterPackage,
    })
  }

  router.get('/status', requireReadAccess, controlledOnboardingRoute('Status request', async (req, res) => {
    res.json(await status(req))
  }))

  router.post('/actions/seed-gaia', requireWriteAccess, controlledOnboardingRoute('Gaia install', async (req, res) => {
    const existedBefore = await gaiaCommanderExists({
      sessionStore: options.sessionStore,
      commanderDataDir: options.commanderDataDir,
    })
    const gaia = await seedGaiaCommander({
      user: req.user,
      operatorStore: options.operatorStore,
      orgIdentityStore,
      sessionStore: options.sessionStore,
      conversationStore: options.conversationStore,
      commanderDataDir: options.commanderDataDir,
      providers: options.providerRegistry.listProviders(),
      providerExecution: options.providerExecution,
      env: options.env,
      shellRunner: options.shellRunner,
    })
    res.status(existedBefore ? 200 : 201).json({
      gaia,
      status: await status(req),
    })
  }))

  router.post('/actions/seed-starter-workforce', requireWriteAccess, controlledOnboardingRoute(
    'Starter workforce install',
    async (req, res) => {
      const result = await seedStarterWorkforce({
        user: req.user,
        operatorStore: options.operatorStore,
        orgIdentityStore,
        sessionStore: options.sessionStore,
        conversationStore: options.conversationStore,
        automationStore: options.automationStore,
        automationScheduler: options.automationScheduler,
        automationSchedulerInitialized: options.automationSchedulerInitialized,
        resolveAutomationSkill: options.resolveAutomationSkill,
        loadStarterPackage: options.loadStarterPackage,
        commanderDataDir: options.commanderDataDir,
        providers: options.providerRegistry.listProviders(),
        providerExecution: options.providerExecution,
        env: options.env,
        shellRunner: options.shellRunner,
      })
      res.status(result.createdAny ? 201 : 200).json({
        starterWorkforce: result.starterWorkforce,
        status: await status(req),
      })
    },
    { starterWorkforceInstall: true },
  ))

  router.post('/actions/skip-starter-workforce', requireWriteAccess, controlledOnboardingRoute('Starter workforce skip', async (req, res) => {
    const starterWorkforce = await skipStarterWorkforce({
      user: req.user,
      operatorStore: options.operatorStore,
      orgIdentityStore,
      sessionStore: options.sessionStore,
      conversationStore: options.conversationStore,
      automationStore: options.automationStore,
      commanderDataDir: options.commanderDataDir,
      providers: options.providerRegistry.listProviders(),
      providerExecution: options.providerExecution,
      env: options.env,
      shellRunner: options.shellRunner,
      loadStarterPackage: options.loadStarterPackage,
    })
    res.json({
      starterWorkforce,
      status: await status(req),
    })
  }))

  router.post('/actions/finish', requireWriteAccess, controlledOnboardingRoute('Finish request', async (req, res) => {
    const current = await status(req)
    if (!current.credentials.ready) {
      res.status(409).json({
        code: 'CREDENTIAL_LIFECYCLE_INCOMPLETE',
        error: current.credentials.summary,
        status: current,
      })
      return
    }
    res.json({
      launchTarget: current.launchTarget,
      status: current,
    })
  }))

  return router
}
