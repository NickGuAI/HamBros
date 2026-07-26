import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import { bootstrapDefaultMasterKey } from './api-keys/bootstrap.js'
import { ProviderSecretsStore } from './api-keys/provider-secrets-store.js'
import { ApiKeyJsonStore } from './api-keys/store.js'
import { createModules } from './module-registry.js'
import { createModuleReadinessTracker } from './module-runtime.js'
import { mountDeclaredBodyParsers } from './module-http-mount.js'
import { createWebSocketUpgradeResolver } from './websocket-upgrade-resolver.js'
import { HerdModuleLoaderError } from './module-loader.js'
import { isCorsOriginAllowed, parseAllowedCorsOrigins } from './cors.js'
import {
  resetActiveRuntimeStateForLaunch,
  shouldStopActiveSessionsOnBoot,
} from './launch-state-reset.js'
import { createInstallScriptRouter } from './routes/install-script.js'
import { configureHttpServerTimeouts } from './http-server-timeouts.js'
import { acquireHerdStoreProcessLock } from './store-process-lock.js'
import { AppSettingsStore } from '../modules/settings/store.js'
import type { AppTheme } from '../modules/settings/types.js'
import {
  ensureHerdDatabaseReadyForBoot,
  openHerdSqliteDatabase,
  type HerdDatabaseReadiness,
} from './db/index.js'
import {
  ensureHerdJsonStoresReadyForBoot,
  type HerdJsonStoreReadiness,
} from './json-store-readiness.js'

const buildVersion = process.env.LAUNCH_COMMIT ?? 'dev'
const startedAt = Date.now()

const nowIso = (): string => new Date().toISOString()

const logInfo = (message: string): void => {
  console.log(`[INFO] ${nowIso()} ${message}`)
}

const logWarn = (message: string): void => {
  console.warn(`[WARN] ${nowIso()} ${message}`)
}

const logError = (message: string): void => {
  console.error(`[ERROR] ${nowIso()} ${message}`)
}

const formatError = (value: unknown): string => {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`
  }
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const storeProcessLock = await acquireHerdStoreProcessLock().catch((error) => {
  logError(`[store] Refusing to start because the Herd data store lock is unavailable\n${formatError(error)}`)
  process.exit(1)
})

let databaseReadiness: HerdDatabaseReadiness | null = null
let jsonStoreReadiness: HerdJsonStoreReadiness | null = null
let sqliteDb: ReturnType<typeof openHerdSqliteDatabase> | null = null

async function exitStartupFailure(message: string): Promise<never> {
  logError(message)
  sqliteDb?.close()
  await storeProcessLock.release()
  process.exit(1)
}

process.on('exit', () => {
  sqliteDb?.close()
  storeProcessLock.releaseSync()
})

process.on('uncaughtException', (error) => {
  logError(`Uncaught exception\n${formatError(error)}`)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logError(`Unhandled rejection\n${formatError(reason)}`)
  process.exit(1)
})

const app = express()
const port = parseInt(process.env.PORT ?? '20001', 10)
const host = process.env.HERD_HOST?.trim() || undefined
const backgroundRuntimeMode = process.env.HERD_BACKGROUND_RUNTIMES?.trim().toLowerCase()
const backgroundRuntimesEnabled = !['0', 'false', 'no'].includes(backgroundRuntimeMode ?? '')
const allowedCorsOrigins = parseAllowedCorsOrigins(process.env.HERD_ALLOWED_ORIGINS)
const apiKeyStore = new ApiKeyJsonStore()
const appSettingsStore = new AppSettingsStore()

try {
  databaseReadiness = await ensureHerdDatabaseReadyForBoot(process.env)
  sqliteDb = openHerdSqliteDatabase(databaseReadiness.dbPath)
  logInfo(
    `[database] SQLite runtime-session store ready at ${databaseReadiness.dbPath} `
    + `(schema ${databaseReadiness.schemaVersion})`,
  )
} catch (error) {
  await exitStartupFailure(formatError(error))
}

if (!databaseReadiness || !sqliteDb) {
  await exitStartupFailure('[database] SQLite runtime-session store did not initialize before module startup.')
}
const readyDatabaseReadiness = databaseReadiness as HerdDatabaseReadiness
const readySqliteDb = sqliteDb as ReturnType<typeof openHerdSqliteDatabase>

try {
  jsonStoreReadiness = await ensureHerdJsonStoresReadyForBoot(process.env)
  logInfo(
    `[json-stores] JSON data stores ready at ${jsonStoreReadiness.sourceRoot} `
    + `(schema ${jsonStoreReadiness.requiredSchemaVersion}, ${jsonStoreReadiness.migrationStatus})`,
  )
} catch (error) {
  await exitStartupFailure(formatError(error))
}

if (!jsonStoreReadiness) {
  await exitStartupFailure('[json-stores] JSON data stores did not initialize before module startup.')
}
const readyJsonStoreReadiness = jsonStoreReadiness as HerdJsonStoreReadiness

if (shouldStopActiveSessionsOnBoot(process.env.HERD_STOP_ACTIVE_SESSIONS_ON_BOOT)) {
  const resetResult = await resetActiveRuntimeStateForLaunch({ sqliteDb: readySqliteDb })
  if (resetResult.errors.length > 0) {
    await exitStartupFailure(
      `[launch] Refusing to serve after stale active-state reset failed\n` +
      resetResult.errors.map((error) => `- ${error}`).join('\n'),
    )
  }
  logInfo(
    `[launch] Paused ${resetResult.runtimeSessionsPaused} active runtime session(s) and idled `
    + `${resetResult.commanderSessionsIdled} commander record(s) before module init`,
  )
}

try {
  await bootstrapDefaultMasterKey(apiKeyStore, { logWarn })
} catch (error) {
  await exitStartupFailure(`[api-keys] Failed to inspect bootstrap key state\n${formatError(error)}`)
}

const providerSecretsStore = new ProviderSecretsStore()
const maxAgentSessions = process.env.HERD_MAX_AGENT_SESSIONS
  ? parseInt(process.env.HERD_MAX_AGENT_SESSIONS, 10)
  : undefined
const { modules, otelRouter, moduleGraph } = createModules({
  apiKeyStore,
  providerSecretsStore,
  auth0Domain: process.env.AUTH0_DOMAIN,
  auth0Audience: process.env.AUTH0_AUDIENCE,
  auth0ClientId: process.env.AUTH0_CLIENT_ID,
  maxAgentSessions,
  appSettingsStore,
  sqliteDb: readySqliteDb,
  databaseReadiness: readyDatabaseReadiness,
  initializeAgentSessionRuntimes: backgroundRuntimesEnabled,
  initializeAutomationScheduler: backgroundRuntimesEnabled,
  initializeChannelRuntimes: backgroundRuntimesEnabled,
})
const moduleReadiness = createModuleReadinessTracker(modules)
void moduleReadiness.ready.catch((error) => {
  logError(`[modules] Runtime readiness failed\n${formatError(error)}`)
})

app.use(
  cors({
    origin(origin, callback) {
      callback(null, isCorsOriginAllowed(origin, allowedCorsOrigins))
    },
  }),
)

mountDeclaredBodyParsers(app, moduleGraph.mountPlan.parsers)

// Mount OTEL receiver at /v1 BEFORE the global JSON parser.
// The parser limit is declared in the telemetry module manifest and mounted
// through the loader mount plan above.
app.use('/v1', otelRouter)

app.use(express.json())

app.use(createInstallScriptRouter())

// Health check
app.get('/api/health', (_req, res) => {
  const memory = process.memoryUsage()
  const runtimeReady = moduleReadiness.isReady()
  res.status(runtimeReady ? 200 : 503).json({
    status: runtimeReady ? 'ok' : 'starting',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: buildVersion,
    backgroundRuntimes: backgroundRuntimesEnabled ? 'enabled' : 'disabled',
    database: {
      ready: readyDatabaseReadiness.ready,
      schemaVersion: readyDatabaseReadiness.schemaVersion,
      requiredSchemaVersion: readyDatabaseReadiness.requiredSchemaVersion,
      migrationStatus: readyDatabaseReadiness.migrationStatus,
    },
    jsonStores: {
      ready: readyJsonStoreReadiness.ready,
      requiredSchemaVersion: readyJsonStoreReadiness.requiredSchemaVersion,
      migrationStatus: readyJsonStoreReadiness.migrationStatus,
      checked: readyJsonStoreReadiness.stores.length,
      quarantined: readyJsonStoreReadiness.stores
        .filter((store) => store.migrationStatus === 'quarantined')
        .length,
    },
    modules: modules.map((m) => m.name),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
    },
  })
})

// Mount module routes
for (const mod of modules) {
  app.use(mod.routePrefix, mod.router)
}

const distDir = path.resolve(process.cwd(), 'dist')

function applyInitialThemeClass(html: string, theme: AppTheme): string {
  // `system` cannot be resolved server-side; serve the light class and let the
  // inline boot script in index.html resolve `prefers-color-scheme` before
  // first paint. `data-theme` always carries the persisted value so the client
  // ThemeProvider hydrates with the right fallback theme.
  const themeClass = theme === 'dark' ? 'hv-dark' : 'hv-light'
  const withClass = html.replace(/<html\b([^>]*)>/i, (match, attrs: string) => {
    if (/\sclass=/.test(attrs)) {
      return match.replace(
        /\sclass=(["'])(.*?)\1/i,
        (_classMatch, quote: string, classes: string) => {
          const nextClasses = classes
            .split(/\s+/)
            .filter((entry) => entry && entry !== 'hv-light' && entry !== 'hv-dark')
          nextClasses.push(themeClass)
          return ` class=${quote}${nextClasses.join(' ')}${quote}`
        },
      )
    }

    return `<html${attrs} class="${themeClass}">`
  })

  return withClass.replace(/<html\b([^>]*)>/i, (match, attrs: string) => {
    if (/\sdata-theme=/.test(attrs)) {
      return match.replace(/\sdata-theme=(["'])(?:.*?)\1/i, ` data-theme="${theme}"`)
    }
    return `<html${attrs} data-theme="${theme}">`
  })
}

async function sendIndexHtml(res: express.Response, next: express.NextFunction): Promise<void> {
  try {
    const [html, settings] = await Promise.all([
      readFile(path.join(distDir, 'index.html'), 'utf8'),
      appSettingsStore.get(),
    ])
    res.type('html').send(applyInitialThemeClass(html, settings.theme))
  } catch (error) {
    next(error)
  }
}

if (process.env.NODE_ENV === 'production' && existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      next()
      return
    }
    void sendIndexHtml(res, next)
  })
}

const server = createServer(app)
const httpServerTimeouts = configureHttpServerTimeouts(server)
const websocketUpgradeResolver = createWebSocketUpgradeResolver(
  moduleGraph.mountPlan.websockets.map((declaration) => {
    const ownerModule = modules.find((module) => module.name === declaration.ownerModuleId)
    if (!ownerModule?.handleUpgrade) {
      throw new HerdModuleLoaderError(
        `WebSocket "${declaration.id}" is declared by "${declaration.ownerModuleId}" `
        + 'but no upgrade handler is registered',
      )
    }

    return {
      declaration,
      handleUpgrade: ownerModule.handleUpgrade,
    }
  }),
)

server.on('upgrade', (req, socket, head) => {
  const resolved = websocketUpgradeResolver(req)
  if (resolved) {
    resolved.route.handleUpgrade(req, socket, head)
    return
  }
  socket.destroy()
})

let isShuttingDown = false

async function shutdownModules(): Promise<void> {
  const results = await Promise.allSettled(modules.map(async (mod) => {
    await mod.shutdown?.()
  }))
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (rejected) {
    throw rejected.reason
  }
}

async function closeDatabase(): Promise<void> {
  sqliteDb?.close()
  sqliteDb = null
}

server.listen(port, host, () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (isShuttingDown) {
        return
      }
      isShuttingDown = true
      logInfo(`Received ${signal}, shutting down`)
      void (async () => {
        try {
          await shutdownModules()
          await closeDatabase()
          server.close((error) => {
            void (async () => {
              if (error) {
                logError(`Error during shutdown\n${formatError(error)}`)
                await storeProcessLock.release()
                process.exit(1)
              }
              await storeProcessLock.release()
              logInfo(`Shutdown complete (${signal})`)
              process.exit(0)
            })()
          })
        } catch (error) {
          logError(`Error during shutdown\n${formatError(error)}`)
          await closeDatabase()
          await storeProcessLock.release()
          process.exit(1)
        }
      })()
    })
  }

  const moduleNames = modules.length === 0
    ? 'none (UI-only mode)'
    : modules.map((m) => m.name).join(', ')
  const memory = process.memoryUsage()
  const rssMb = (memory.rss / 1024 / 1024).toFixed(0)
  const heapUsedMb = (memory.heapUsed / 1024 / 1024).toFixed(0)
  const heapTotalMb = (memory.heapTotal / 1024 / 1024).toFixed(0)

  logInfo('Herd server started')
  logInfo(`Node ${process.version} | PID ${process.pid} | Host ${host ?? '0.0.0.0'} | Port ${port}`)
  logInfo(`Memory: RSS ${rssMb}MB | Heap ${heapUsedMb}/${heapTotalMb}MB`)
  logInfo(
    `HTTP timeouts: keepAlive=${httpServerTimeouts.keepAliveTimeoutMs}ms | ` +
    `headers=${httpServerTimeouts.headersTimeoutMs}ms`,
  )
  logInfo(`Build: ${buildVersion} | Modules: ${moduleNames}`)
})
