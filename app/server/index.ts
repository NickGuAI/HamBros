import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import { ApiKeyJsonStore } from './api-keys/store.js'
import { OpenAITranscriptionKeyStore } from './api-keys/transcription-store.js'
import { createModules } from './module-registry.js'
import { isCorsOriginAllowed, parseAllowedCorsOrigins } from './cors.js'
import { createApiKeysRouter } from './routes/api-keys.js'

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
const allowedCorsOrigins = parseAllowedCorsOrigins(process.env.HAMBROS_ALLOWED_ORIGINS)
const apiKeyStore = new ApiKeyJsonStore()

// Seed a default master key on first boot when no keys exist.
// HAMBROS_DEFAULT_KEY can be set to any value; defaults to "HAMMURABI!".
// The SOP-15 HamBros sync rewrites this to HAMBROS_DEFAULT_KEY / "HAMBROS!".
const defaultKeyValue = process.env.HAMBROS_DEFAULT_KEY ?? 'HAMBROS!'
apiKeyStore.seedDefaultKey(defaultKeyValue).then((seeded) => {
  if (seeded) {
    logInfo(`[api-keys] Seeded default master key. Use "${seeded}" to authenticate.`)
    logWarn('[api-keys] Change this key in production: Settings -> API Keys -> Revoke & create new.')
  }
}).catch(() => { /* best-effort — server starts regardless */ })

const transcriptionKeyStore = new OpenAITranscriptionKeyStore()
const maxAgentSessions = process.env.HAMBROS_MAX_AGENT_SESSIONS
  ? parseInt(process.env.HAMBROS_MAX_AGENT_SESSIONS, 10)
  : undefined
const { modules, otelRouter } = createModules({
  apiKeyStore,
  transcriptionKeyStore,
  auth0Domain: process.env.AUTH0_DOMAIN,
  auth0Audience: process.env.AUTH0_AUDIENCE,
  auth0ClientId: process.env.AUTH0_CLIENT_ID,
  maxAgentSessions,
})

app.use(
  cors({
    origin(origin, callback) {
      callback(null, isCorsOriginAllowed(origin, allowedCorsOrigins))
    },
  }),
)

// Mount OTEL receiver at /v1 BEFORE the global JSON parser.
// The OTEL router has its own express.json({ limit: '5mb' }) parser;
// the global parser's default 100kb limit would reject large OTEL batches
// before the OTEL router ever sees them.
app.use('/v1', otelRouter)

app.use(express.json())

// Health check
app.get('/api/health', (_req, res) => {
  const memory = process.memoryUsage()
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: buildVersion,
    modules: modules.map((m) => m.name),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
    },
  })
})

app.use(
  '/api/auth',
  createApiKeysRouter({
    store: apiKeyStore,
    transcriptionKeyStore,
  }),
)

// Mount module routes
for (const mod of modules) {
  app.use(mod.routePrefix, mod.router)
}

const distDir = path.resolve(process.cwd(), 'dist')
if (process.env.NODE_ENV === 'production' && existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      next()
      return
    }
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

const server = createServer(app)

server.on('upgrade', (req, socket, head) => {
  for (const mod of modules) {
    if (mod.handleUpgrade && req.url?.startsWith(mod.routePrefix)) {
      mod.handleUpgrade(req, socket, head)
      return
    }
  }
  socket.destroy()
})

let isShuttingDown = false

server.listen(port, () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (isShuttingDown) {
        return
      }
      isShuttingDown = true
      logInfo(`Received ${signal}, shutting down`)
      server.close((error) => {
        if (error) {
          logError(`Error during shutdown\n${formatError(error)}`)
          process.exit(1)
        }
        logInfo(`Shutdown complete (${signal})`)
        process.exit(0)
      })
    })
  }

  const moduleNames = modules.length === 0
    ? 'none (UI-only mode)'
    : modules.map((m) => m.name).join(', ')
  const memory = process.memoryUsage()
  const rssMb = (memory.rss / 1024 / 1024).toFixed(0)
  const heapUsedMb = (memory.heapUsed / 1024 / 1024).toFixed(0)
  const heapTotalMb = (memory.heapTotal / 1024 / 1024).toFixed(0)

  logInfo('Hammurabi server started')
  logInfo(`Node ${process.version} | PID ${process.pid} | Port ${port}`)
  logInfo(`Memory: RSS ${rssMb}MB | Heap ${heapUsedMb}/${heapTotalMb}MB`)
  logInfo(`Build: ${buildVersion} | Modules: ${moduleNames}`)
})
