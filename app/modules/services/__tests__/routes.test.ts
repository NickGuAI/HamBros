import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { createServicesRouter, parseLaunchScript, parseListeningPorts } from '../routes'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}))

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
}

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

const READ_ONLY_AUTH_HEADERS = {
  'x-hammurabi-api-key': 'read-only-key',
}

const testDirectories: string[] = []

function createTestApiKeyStore(): ApiKeyStoreLike {
  const recordsByRawKey = {
    'test-key': {
      id: 'test-key-id',
      name: 'Test Key',
      keyHash: 'hash',
      prefix: 'hmrb_test',
      createdBy: 'test',
      createdAt: '2026-02-16T00:00:00.000Z',
      lastUsedAt: null,
      scopes: ['services:read', 'services:write'],
    },
    'read-only-key': {
      id: 'test-read-key-id',
      name: 'Read-only Key',
      keyHash: 'hash',
      prefix: 'hmrb_test_read',
      createdBy: 'test',
      createdAt: '2026-02-16T00:00:00.000Z',
      lastUsedAt: null,
      scopes: ['services:read'],
    },
  } satisfies Record<string, import('../../../server/api-keys/store').ApiKeyRecord>

  return {
    hasAnyKeys: async () => true,
    verifyKey: async (rawKey, options) => {
      const record = recordsByRawKey[rawKey as keyof typeof recordsByRawKey]
      if (!record) {
        return { ok: false, reason: 'not_found' as const }
      }

      const requiredScopes = options?.requiredScopes ?? []
      const hasAllScopes = requiredScopes.every((scope) => record.scopes.includes(scope))
      if (!hasAllScopes) {
        return { ok: false, reason: 'insufficient_scope' as const }
      }

      return { ok: true as const, record }
    },
  }
}

async function createScriptsDir(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hammurabi-services-routes-'))
  testDirectories.push(directory)

  for (const [fileName, contents] of Object.entries(files)) {
    await writeFile(path.join(directory, fileName), contents, 'utf8')
  }

  return directory
}

async function startServer(options: {
  scriptsDir: string
  now?: () => Date
  checkHealth?: (url: string, timeoutMs: number) => Promise<boolean>
  spawnScript?: (scriptPath: string) => void
  stopService?: (service: { name: string; port: number; script: string; healthPaths: string[] }) => Promise<void>
}): Promise<RunningServer> {
  const app = express()
  const services = createServicesRouter({
    scriptsDir: options.scriptsDir,
    now: options.now,
    checkHealth: options.checkHealth,
    spawnScript: options.spawnScript,
    stopService: options.stopService,
    apiKeyStore: createTestApiKeyStore(),
  })
  app.use('/api/services', services.router)

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve test server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}

function mockExecFile(
  implementation: (
    command: string,
    args: string[],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void,
) {
  const mockedExecFile = execFile as unknown as ReturnType<typeof vi.fn>
  mockedExecFile.mockImplementation(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      implementation(command, args, callback)
      return {} as never
    },
  )
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('services routes', () => {
  it('requires authentication to list services', async () => {
    const scriptsDir = await createScriptsDir({
      'launch_alpha.sh': 'PORT=3001\n',
    })

    const server = await startServer({ scriptsDir })
    const response = await fetch(`${server.baseUrl}/api/services/list`)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
    })

    await server.close()
  })

  it('discovers services and computes running/degraded/stopped status', async () => {
    const scriptsDir = await createScriptsDir({
      'launch_alpha.sh': 'PORT=3001\ncurl http://localhost:$PORT/health\n',
      'launch_beta.sh': 'PORT=3002\n',
      'launch_gamma.sh': 'PORT=3003\n',
    })
    const now = new Date('2026-02-14T08:00:00.000Z')
    const observedTimeouts: number[] = []

    mockExecFile((_command, args, callback) => {
      expect(args).toEqual(['-tlnp'])
      callback(
        null,
        [
          'Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
          'tcp   LISTEN 0      4096         *:3001            *:*',
          'tcp   LISTEN 0      4096         *:3002            *:*',
        ].join('\n'),
        '',
      )
    })

    const server = await startServer({
      scriptsDir,
      now: () => now,
      checkHealth: async (url, timeoutMs) => {
        observedTimeouts.push(timeoutMs)
        return url.includes(':3001/')
      },
    })

    const response = await fetch(`${server.baseUrl}/api/services/list`, {
      headers: AUTH_HEADERS,
    })
    const payload = (await response.json()) as Array<{
      name: string
      port: number
      status: string
      healthy: boolean
      listening: boolean
      lastChecked: string
    }>

    expect(response.status).toBe(200)
    expect(payload).toEqual([
      expect.objectContaining({
        name: 'alpha',
        port: 3001,
        status: 'running',
        healthy: true,
        listening: true,
        lastChecked: now.toISOString(),
      }),
      expect.objectContaining({
        name: 'beta',
        port: 3002,
        status: 'degraded',
        healthy: false,
        listening: true,
        lastChecked: now.toISOString(),
      }),
      expect.objectContaining({
        name: 'gamma',
        port: 3003,
        status: 'stopped',
        healthy: false,
        listening: false,
        lastChecked: now.toISOString(),
      }),
    ])
    expect(observedTimeouts.length).toBeGreaterThan(0)
    expect(observedTimeouts.every((timeoutMs) => timeoutMs === 1_500)).toBe(true)

    await server.close()
  })

  it('returns service health for a known service', async () => {
    const scriptsDir = await createScriptsDir({
      'launch_alpha.sh': 'PORT=3010\n',
    })

    mockExecFile((_command, _args, callback) => {
      callback(
        null,
        'tcp LISTEN 0 4096 *:3010 *:*',
        '',
      )
    })

    const server = await startServer({
      scriptsDir,
      checkHealth: async () => true,
    })

    const response = await fetch(`${server.baseUrl}/api/services/alpha/health`, {
      headers: AUTH_HEADERS,
    })
    const payload = (await response.json()) as {
      name: string
      status: string
      healthy: boolean
    }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      name: 'alpha',
      status: 'running',
      healthy: true,
    })

    await server.close()
  })

  it('rejects invalid service names for health checks', async () => {
    const scriptsDir = await createScriptsDir({
      'launch_alpha.sh': 'PORT=3010\n',
    })

    const server = await startServer({ scriptsDir })
    const response = await fetch(
      `${server.baseUrl}/api/services/${encodeURIComponent('../../etc/passwd')}/health`,
      {
        headers: AUTH_HEADERS,
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Invalid service name',
    })

    await server.close()
  })

  it('returns 404 when requested service does not exist', async () => {
    const scriptsDir = await createScriptsDir({
      'launch_alpha.sh': 'PORT=3010\n',
    })

    mockExecFile((_command, _args, callback) => {
      callback(null, '', '')
    })

    const server = await startServer({ scriptsDir })
    const response = await fetch(`${server.baseUrl}/api/services/unknown/health`, {
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'Service "unknown" not found',
    })

    await server.close()
  })

  it('returns 500 when ss command fails', async () => {
    const scriptsDir = await createScriptsDir({
      'launch_alpha.sh': 'PORT=3010\n',
    })

    mockExecFile((_command, _args, callback) => {
      callback(new Error('ss failed'), '', '')
    })

    const server = await startServer({ scriptsDir })
    const response = await fetch(`${server.baseUrl}/api/services/list`, {
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'Failed to discover services',
    })

    await server.close()
  })
})

describe('services restart', () => {
  it('restarts a known service by stopping then re-executing its launch script', async () => {
    const scriptsDir = await createScriptsDir({
      'launch_alpha.sh': 'PORT=3001\n',
    })
    const spawnedScripts: string[] = []
    const stoppedServices: string[] = []
    const callOrder: string[] = []

    mockExecFile((_command, _args, callback) => {
      callback(null, '', '')
    })

    const server = await startServer({
      scriptsDir,
      checkHealth: async () => false,
      stopService: async (service) => {
        stoppedServices.push(service.name)
        callOrder.push('stop')
      },
      spawnScript: (scriptPath) => {
        spawnedScripts.push(scriptPath)
        callOrder.push('spawn')
      },
    })

    const response = await fetch(`${server.baseUrl}/api/services/alpha/restart`, {
      method: 'POST',
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toEqual({ restarted: true, script: 'launch_alpha.sh' })
    expect(stoppedServices).toEqual(['alpha'])
    expect(spawnedScripts).toHaveLength(1)
    expect(spawnedScripts[0]).toContain('launch_alpha.sh')
    expect(callOrder).toEqual(['stop', 'spawn'])

    await server.close()
  })

  it('requires write access', async () => {
    const scriptsDir = await createScriptsDir({
      'launch_alpha.sh': 'PORT=3001\n',
    })

    mockExecFile((_command, _args, callback) => {
      callback(null, '', '')
    })

    const server = await startServer({ scriptsDir })
    const response = await fetch(`${server.baseUrl}/api/services/alpha/restart`, {
      method: 'POST',
      headers: READ_ONLY_AUTH_HEADERS,
    })

    expect(response.status).toBe(403)
    await server.close()
  })

  it('returns 404 for unknown service restart', async () => {
    const scriptsDir = await createScriptsDir({
      'launch_alpha.sh': 'PORT=3001\n',
    })

    mockExecFile((_command, _args, callback) => {
      callback(null, '', '')
    })

    const server = await startServer({ scriptsDir })
    const response = await fetch(`${server.baseUrl}/api/services/nonexistent/restart`, {
      method: 'POST',
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(404)
    await server.close()
  })
})

describe('services metrics', () => {
  it('returns system CPU and memory metrics', async () => {
    const scriptsDir = await createScriptsDir({})

    const server = await startServer({ scriptsDir })
    const response = await fetch(`${server.baseUrl}/api/services/metrics`, {
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      cpuCount: number
      loadAvg: number[]
      memTotalBytes: number
      memFreeBytes: number
      memUsedPercent: number
    }

    expect(payload.cpuCount).toBeGreaterThan(0)
    expect(payload.loadAvg).toHaveLength(3)
    expect(payload.memTotalBytes).toBeGreaterThan(0)
    expect(payload.memFreeBytes).toBeGreaterThan(0)
    expect(payload.memUsedPercent).toBeGreaterThanOrEqual(0)
    expect(payload.memUsedPercent).toBeLessThanOrEqual(100)

    await server.close()
  })
})

describe('parseLaunchScript', () => {
  it('parses multiple *_PORT definitions from a launch script', () => {
    const parsed = parseLaunchScript(
      'launch_legion.sh',
      'DASHBOARD_PORT=8080\nFLEET_PORT=8081\n',
    )

    expect(parsed).toEqual([
      expect.objectContaining({
        name: 'legion-dashboard',
        port: 8080,
      }),
      expect.objectContaining({
        name: 'legion-fleet',
        port: 8081,
      }),
    ])
  })
})

describe('parseListeningPorts', () => {
  it('parses IPv4 and IPv6 local addresses from ss output', () => {
    const output = [
      'Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'tcp   LISTEN 0      4096         *:3001            *:*',
      'tcp   LISTEN 0      4096      [::]:3002            [::]:*',
      'tcp   LISTEN 0      4096        :::3003            :::*',
      'tcp   LISTEN 0      4096  127.0.0.1:3004            *:*',
    ].join('\n')

    expect([...parseListeningPorts(output)].sort((left, right) => left - right)).toEqual([
      3001,
      3002,
      3003,
      3004,
    ])
  })
})
