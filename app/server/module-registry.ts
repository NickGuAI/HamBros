import type { Router } from 'express'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { createAgentsRouter } from '../modules/agents/routes.js'
import { createCommandRoomRouter } from '../modules/command-room/routes.js'
import { createCommandersRouter } from '../modules/commanders/routes.js'
import { createFactoryRouter } from '../modules/factory/routes.js'
import { createServicesRouter } from '../modules/services/routes.js'
import { createTelemetryRouterWithHub } from '../modules/telemetry/routes.js'
import { createOtelRouter } from '../modules/telemetry/otel-receiver.js'
import type { ApiKeyStoreLike } from './api-keys/store.js'
import type { OpenAITranscriptionKeyStoreLike } from './api-keys/transcription-store.js'
import { createRealtimeProxy } from './realtime/proxy.js'

export interface HammurabiModule {
  name: string
  label: string
  routePrefix: string
  router: Router
  handleUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
}

interface ModuleRegistryOptions {
  apiKeyStore?: ApiKeyStoreLike
  transcriptionKeyStore?: OpenAITranscriptionKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  /** Max concurrent agent sessions (default 10). Set via HAMBROS_MAX_AGENT_SESSIONS. */
  maxAgentSessions?: number
}

export interface ModuleRegistryResult {
  modules: HammurabiModule[]
  /** OTEL receiver router — mount at `/v1` (separate from module prefixes). */
  otelRouter: Router
}

export function createModules(options: ModuleRegistryOptions = {}): ModuleRegistryResult {
  const internalToken = randomBytes(32).toString('hex')

  const agents = createAgentsRouter({
    apiKeyStore: options.apiKeyStore,
    maxSessions: options.maxAgentSessions,
    internalToken,
  })

  const commanders = createCommandersRouter({
    apiKeyStore: options.apiKeyStore,
    auth0Domain: options.auth0Domain,
    auth0Audience: options.auth0Audience,
    auth0ClientId: options.auth0ClientId,
  })

  const commandRoom = createCommandRoomRouter({
    apiKeyStore: options.apiKeyStore,
    internalToken,
  })

  const services = createServicesRouter({
    apiKeyStore: options.apiKeyStore,
  })

  // Telemetry — returns both the legacy router and the shared hub
  const telemetry = createTelemetryRouterWithHub({
    apiKeyStore: options.apiKeyStore,
  })

  // OTEL receiver shares the same TelemetryHub instance
  const otelRouter = createOtelRouter({
    hub: telemetry.hub,
    apiKeyStore: options.apiKeyStore,
  })

  const realtime = createRealtimeProxy({
    apiKeyStore: options.apiKeyStore,
    transcriptionKeyStore: options.transcriptionKeyStore,
  })

  const modules: HammurabiModule[] = [
    {
      name: 'agents',
      label: 'Agents Monitor',
      routePrefix: '/api/agents',
      router: agents.router,
      handleUpgrade: agents.handleUpgrade,
    },
    {
      name: 'commanders',
      label: 'Commanders',
      routePrefix: '/api/commanders',
      router: commanders.router,
      handleUpgrade: commanders.handleUpgrade,
    },
    {
      name: 'command-room',
      label: 'Command Room',
      routePrefix: '/api/command-room',
      router: commandRoom,
    },
    {
      name: 'telemetry',
      label: 'Telemetry Hub',
      routePrefix: '/api/telemetry',
      router: telemetry.router,
    },
    {
      name: 'services',
      label: 'Services Manager',
      routePrefix: '/api/services',
      router: services.router,
      handleUpgrade: services.handleUpgrade,
    },
    {
      name: 'factory',
      label: 'Factory',
      routePrefix: '/api/factory',
      router: createFactoryRouter({
        apiKeyStore: options.apiKeyStore,
      }),
    },
    {
      name: 'realtime',
      label: 'Realtime',
      routePrefix: '/api/realtime',
      router: realtime.router,
      handleUpgrade: realtime.handleUpgrade,
    },
  ]

  return { modules, otelRouter }
}
