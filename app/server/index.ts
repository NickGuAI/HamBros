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

const app = express()
const port = parseInt(process.env.PORT ?? '20001', 10)
const allowedCorsOrigins = parseAllowedCorsOrigins(process.env.HAMBROS_ALLOWED_ORIGINS)
const apiKeyStore = new ApiKeyJsonStore()
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
  res.json({ status: 'ok', modules: modules.map((m) => m.name) })
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

server.listen(port, () => {
  console.log(`HamBros server listening on port ${port}`)
  console.log(
    `Modules loaded: ${modules.length === 0 ? 'none (UI-only mode)' : modules.map((m) => m.name).join(', ')}`,
  )
})
