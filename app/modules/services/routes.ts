import { execFile, spawn as spawnChild } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { cpus, totalmem, freemem, loadavg } from 'node:os'
import path from 'node:path'
import { Router } from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import { createAuth0Verifier } from '../../server/middleware/auth0.js'

const SS_TIMEOUT_MS = 5_000
const SS_MAX_BUFFER = 2 * 1024 * 1024
const HEALTH_TIMEOUT_MS = 1_500
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/i
const DEFAULT_HEALTH_PATHS = ['/health', '/api/health']

export type ServiceStatus = 'running' | 'degraded' | 'stopped'

export interface ServiceView {
  name: string
  port: number
  script: string
  status: ServiceStatus
  healthy: boolean
  listening: boolean
  healthUrl: string
  lastChecked: string
}

export interface SystemMetrics {
  cpuCount: number
  loadAvg: [number, number, number]
  memTotalBytes: number
  memFreeBytes: number
  memUsedPercent: number
}

export interface DiscoveredService {
  name: string
  port: number
  script: string
  healthPaths: string[]
}

type CommandRunner = (command: string, args: string[]) => Promise<string>
type HealthChecker = (url: string, timeoutMs: number) => Promise<boolean>
type ScriptSpawner = (scriptPath: string) => void
type ServiceStopper = (service: DiscoveredService) => Promise<void>

export interface ServicesRouterOptions {
  scriptsDir?: string
  logsDir?: string
  runCommand?: CommandRunner
  checkHealth?: HealthChecker
  spawnScript?: ScriptSpawner
  stopService?: ServiceStopper
  now?: () => Date
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
}

export interface ServicesRouterResult {
  router: Router
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
}

function resolveOperationsPath(relativePath: string): string {
  const direct = path.resolve(process.cwd(), relativePath)
  if (existsSync(direct)) {
    return direct
  }

  const fromApp = path.resolve(process.cwd(), '../../', relativePath)
  if (existsSync(fromApp)) {
    return fromApp
  }

  return direct
}

function defaultScriptsDir(): string {
  return resolveOperationsPath('operations/scripts')
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: SS_TIMEOUT_MS,
        maxBuffer: SS_MAX_BUFFER,
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }

        resolve(stdout)
      },
    )
  })
}

function sanitizeHealthPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed.startsWith('/')) {
    return ''
  }

  return trimmed.split(/[?#]/, 1)[0] ?? ''
}

function deriveServiceName(baseName: string, portVariable: string): string {
  if (portVariable === 'PORT') {
    return baseName
  }

  const suffix = portVariable
    .replace(/_PORT$/, '')
    .toLowerCase()
    .replace(/_/g, '-')
    .trim()

  if (!suffix || suffix === 'main' || suffix === 'app') {
    return baseName
  }

  return `${baseName}-${suffix}`
}

function extractHealthPaths(scriptContents: string, portVariable: string): string[] {
  const escapedVariable = portVariable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const variablePatterns = [
    `\\$\\{${escapedVariable}\\}`,
    `\\$${escapedVariable}\\b`,
  ]
  const pathMatches = new Set<string>()

  for (const variablePattern of variablePatterns) {
    const expression = new RegExp(
      `localhost:${variablePattern}(\\/[^\\s"'$)]*)`,
      'g',
    )

    let match = expression.exec(scriptContents)
    while (match) {
      const candidate = sanitizeHealthPath(match[1] ?? '')
      if (candidate) {
        pathMatches.add(candidate)
      }
      match = expression.exec(scriptContents)
    }
  }

  return [...pathMatches]
}

export function parseLaunchScript(
  scriptFileName: string,
  scriptContents: string,
): DiscoveredService[] {
  const baseName = path
    .basename(scriptFileName, '.sh')
    .replace(/^launch_/, '')
    .toLowerCase()
    .replace(/_/g, '-')

  const portRegex = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*['"]?([0-9]{1,5})['"]?\s*$/gm
  const discovered = new Map<string, DiscoveredService>()

  let match = portRegex.exec(scriptContents)
  while (match) {
    const variableName = match[1] ?? ''
    if (!variableName.endsWith('PORT')) {
      match = portRegex.exec(scriptContents)
      continue
    }

    const port = Number.parseInt(match[2] ?? '', 10)
    if (!Number.isFinite(port) || port < 1 || port > 65_535) {
      match = portRegex.exec(scriptContents)
      continue
    }

    const name = deriveServiceName(baseName, variableName)
    if (!SERVICE_NAME_PATTERN.test(name)) {
      match = portRegex.exec(scriptContents)
      continue
    }

    const key = `${name}:${port}`
    if (!discovered.has(key)) {
      discovered.set(key, {
        name,
        port,
        script: path.basename(scriptFileName),
        healthPaths: extractHealthPaths(scriptContents, variableName),
      })
    }

    match = portRegex.exec(scriptContents)
  }

  return [...discovered.values()]
}

function extractPortFromLocalAddress(localAddress: string): number | null {
  const match = /[:\]](\d{1,5})$/.exec(localAddress)
  if (!match?.[1]) {
    return null
  }

  const port = Number.parseInt(match[1], 10)
  if (!Number.isFinite(port) || port < 1 || port > 65_535) {
    return null
  }

  return port
}

export function parseListeningPorts(ssOutput: string): Set<number> {
  const ports = new Set<number>()

  for (const line of ssOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('Netid')) {
      continue
    }

    const columns = trimmed.split(/\s+/)
    if (columns.length < 4) {
      continue
    }

    const localAddress =
      columns.find(
        (value, index) => index >= 3 && /[:\]]\d{1,5}$/.test(value),
      ) ?? ''
    const port = extractPortFromLocalAddress(localAddress)
    if (port !== null) {
      ports.add(port)
    }
  }

  return ports
}

async function checkHealthWithTimeout(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function discoverServices(scriptsDir: string): Promise<DiscoveredService[]> {
  const entries = await readdir(scriptsDir, { withFileTypes: true })
  const scriptFiles = entries
    .filter((entry) => entry.isFile() && /^launch_[\w-]+\.sh$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  const discovered: DiscoveredService[] = []

  for (const scriptFileName of scriptFiles) {
    const absolutePath = path.join(scriptsDir, scriptFileName)
    const contents = await readFile(absolutePath, 'utf8')
    discovered.push(...parseLaunchScript(scriptFileName, contents))
  }

  return discovered.sort((left, right) => left.name.localeCompare(right.name))
}

function parseServiceName(rawValue: unknown): string | null {
  if (typeof rawValue !== 'string') {
    return null
  }

  const serviceName = rawValue.trim()
  if (!SERVICE_NAME_PATTERN.test(serviceName)) {
    return null
  }

  return serviceName.toLowerCase()
}

async function evaluateServiceHealth(
  service: DiscoveredService,
  listeningPorts: Set<number>,
  healthChecker: HealthChecker,
): Promise<{
  status: ServiceStatus
  healthy: boolean
  listening: boolean
  healthUrl: string
}> {
  const listening = listeningPorts.has(service.port)
  const healthPaths = [...service.healthPaths, ...DEFAULT_HEALTH_PATHS]

  let healthUrl = `http://127.0.0.1:${service.port}${DEFAULT_HEALTH_PATHS[0]}`
  let healthy = false

  if (listening) {
    for (const rawPath of healthPaths) {
      const pathName = sanitizeHealthPath(rawPath)
      if (!pathName) {
        continue
      }

      healthUrl = `http://127.0.0.1:${service.port}${pathName}`
      healthy = await healthChecker(healthUrl, HEALTH_TIMEOUT_MS)
      if (healthy) {
        break
      }
    }
  }

  const status: ServiceStatus = !listening
    ? 'stopped'
    : healthy
      ? 'running'
      : 'degraded'

  return {
    status,
    healthy,
    listening,
    healthUrl,
  }
}

const TAIL_INITIAL_LINES = 500

function defaultLogsDir(): string {
  return resolveOperationsPath('operations/logs/server')
}

export function resolveLogFilePath(logsDir: string, serviceName: string): string | null {
  // Try exact name match: {name}/latest/launch.log
  const exactLog = path.join(logsDir, serviceName, 'latest', 'launch.log')
  if (existsSync(exactLog)) {
    return exactLog
  }

  // For compound names like "legion-dashboard", split on first hyphen
  const hyphenIndex = serviceName.indexOf('-')
  if (hyphenIndex > 0) {
    const base = serviceName.slice(0, hyphenIndex)
    const suffix = serviceName.slice(hyphenIndex + 1)

    // Try {base}/latest/{suffix}.log (e.g., legion/latest/dashboard.log)
    const subLog = path.join(logsDir, base, 'latest', `${suffix}.log`)
    if (existsSync(subLog)) {
      return subLog
    }

    // Fall back to {base}/latest/launch.log
    const baseLog = path.join(logsDir, base, 'latest', 'launch.log')
    if (existsSync(baseLog)) {
      return baseLog
    }
  }

  return null
}

function extractServiceNameFromUrl(url: URL): string | null {
  // Expected path: /api/services/:name/logs
  const match = url.pathname.match(/\/([^/]+)\/logs$/)
  if (!match) {
    return null
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(match[1])
  } catch {
    return null
  }
  return SERVICE_NAME_PATTERN.test(decoded) ? decoded.toLowerCase() : null
}

export function createServicesRouter(options: ServicesRouterOptions = {}): ServicesRouterResult {
  const router = Router()
  const wss = new WebSocketServer({ noServer: true })
  const scriptsDir = options.scriptsDir ?? defaultScriptsDir()
  const logsDir = options.logsDir ?? defaultLogsDir()
  const commandRunner = options.runCommand ?? runCommand
  const healthChecker = options.checkHealth ?? checkHealthWithTimeout
  const scriptSpawner: ScriptSpawner = options.spawnScript ?? ((scriptPath: string) => {
    spawnChild('bash', [scriptPath], {
      stdio: 'ignore',
      detached: true,
    }).unref()
  })
  const serviceStopper: ServiceStopper = options.stopService ?? (async (service: DiscoveredService) => {
    // Launch scripts use tmux session name "server-{baseName}" where baseName
    // is derived from the script filename: launch_{baseName}.sh
    const baseName = path
      .basename(service.script, '.sh')
      .replace(/^launch_/, '')
    const tmuxSession = `server-${baseName}`
    try {
      await commandRunner('tmux', ['kill-session', '-t', tmuxSession])
    } catch {
      // Session may not exist; not fatal
    }
  })
  const now = options.now ?? (() => new Date())
  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['services:read'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })
  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['services:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  router.get('/list', requireReadAccess, async (_req, res) => {
    try {
      const [services, ssOutput] = await Promise.all([
        discoverServices(scriptsDir),
        commandRunner('ss', ['-tlnp']),
      ])
      const listeningPorts = parseListeningPorts(ssOutput)
      const checkedAt = now().toISOString()

      const serviceViews = await Promise.all(
        services.map(async (service) => {
          const evaluated = await evaluateServiceHealth(
            service,
            listeningPorts,
            healthChecker,
          )

          const payload: ServiceView = {
            name: service.name,
            port: service.port,
            script: service.script,
            status: evaluated.status,
            healthy: evaluated.healthy,
            listening: evaluated.listening,
            healthUrl: evaluated.healthUrl,
            lastChecked: checkedAt,
          }

          return payload
        }),
      )

      res.json(serviceViews)
    } catch {
      res.status(500).json({ error: 'Failed to discover services' })
    }
  })

  router.get('/metrics', requireReadAccess, (_req, res) => {
    const total = totalmem()
    const free = freemem()
    const used = total - free
    const load = loadavg() as [number, number, number]

    const metrics: SystemMetrics = {
      cpuCount: cpus().length,
      loadAvg: load,
      memTotalBytes: total,
      memFreeBytes: free,
      memUsedPercent: Math.round((used / total) * 1000) / 10,
    }

    res.json(metrics)
  })

  router.get('/:name/health', requireReadAccess, async (req, res) => {
    const serviceName = parseServiceName(req.params.name)
    if (!serviceName) {
      res.status(400).json({ error: 'Invalid service name' })
      return
    }

    try {
      const services = await discoverServices(scriptsDir)
      const service = services.find((candidate) => candidate.name === serviceName)
      if (!service) {
        res.status(404).json({ error: `Service "${serviceName}" not found` })
        return
      }

      const ssOutput = await commandRunner('ss', ['-tlnp'])
      const listeningPorts = parseListeningPorts(ssOutput)
      const evaluated = await evaluateServiceHealth(service, listeningPorts, healthChecker)

      const payload: ServiceView = {
        name: service.name,
        port: service.port,
        script: service.script,
        status: evaluated.status,
        healthy: evaluated.healthy,
        listening: evaluated.listening,
        healthUrl: evaluated.healthUrl,
        lastChecked: now().toISOString(),
      }

      res.json(payload)
    } catch {
      res.status(500).json({ error: 'Failed to check service health' })
    }
  })

  router.post('/:name/restart', requireWriteAccess, async (req, res) => {
    const serviceName = parseServiceName(req.params.name)
    if (!serviceName) {
      res.status(400).json({ error: 'Invalid service name' })
      return
    }

    try {
      const services = await discoverServices(scriptsDir)
      const service = services.find((candidate) => candidate.name === serviceName)
      if (!service) {
        res.status(404).json({ error: `Service "${serviceName}" not found` })
        return
      }

      const scriptPath = path.join(scriptsDir, service.script)
      if (!existsSync(scriptPath)) {
        res.status(404).json({ error: `Launch script "${service.script}" not found` })
        return
      }

      await serviceStopper(service)
      scriptSpawner(scriptPath)

      res.json({ restarted: true, script: service.script })
    } catch {
      res.status(500).json({ error: 'Failed to restart service' })
    }
  })

  const auth0Verifier = createAuth0Verifier({
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  async function verifyWsAuth(req: IncomingMessage): Promise<boolean> {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
    const accessToken = url.searchParams.get('access_token')
    const apiKeyParam = url.searchParams.get('api_key')
    const apiKeyHeader = req.headers['x-hammurabi-api-key'] as string | undefined
    const token = accessToken ?? apiKeyParam ?? apiKeyHeader

    if (!token) {
      return false
    }

    if (auth0Verifier) {
      try {
        await auth0Verifier(token)
        return true
      } catch {
        // Not a valid Auth0 token, fall through to API key check
      }
    }

    if (options.apiKeyStore) {
      const result = await options.apiKeyStore.verifyKey(token, {
        requiredScopes: ['services:read'],
      })
      return result.ok
    }

    return false
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
    const serviceName = extractServiceNameFromUrl(url)

    if (!serviceName) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    void verifyWsAuth(req).then((authorized) => {
      if (!authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      const logFile = resolveLogFilePath(logsDir, serviceName)
      if (!logFile) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const tail = spawnChild('tail', ['-n', String(TAIL_INITIAL_LINES), '-f', logFile], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        tail.stdout.on('data', (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            // Convert bare \n to \r\n so xterm.js renders lines correctly
            const fixed = chunk.toString().replace(/\r?\n/g, '\r\n')
            ws.send(Buffer.from(fixed))
          }
        })

        tail.stderr.on('data', (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            const fixed = chunk.toString().replace(/\r?\n/g, '\r\n')
            ws.send(Buffer.from(fixed))
          }
        })

        ;(tail as unknown as import('node:events').EventEmitter).on(
          'close',
          (code: number | null, signal: string | null) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'exit', exitCode: code, signal }))
              ws.close(1000, 'Log stream ended')
            }
          },
        )

        ws.on('close', () => {
          tail.kill()
        })
      })
    })
  }

  return { router, handleUpgrade }
}
