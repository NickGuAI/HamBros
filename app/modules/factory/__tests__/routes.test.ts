import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { createFactoryRouter, type CommandRunner } from '../routes'

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
  httpServer: Server
}

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

const READ_ONLY_AUTH_HEADERS = {
  'x-hammurabi-api-key': 'read-only-key',
}

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
      scopes: ['factory:read', 'factory:write'],
    },
    'read-only-key': {
      id: 'test-read-key-id',
      name: 'Read-only Key',
      keyHash: 'hash',
      prefix: 'hmrb_test_read',
      createdBy: 'test',
      createdAt: '2026-02-16T00:00:00.000Z',
      lastUsedAt: null,
      scopes: ['factory:read'],
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

function createMockCommandRunner(): CommandRunner {
  return {
    exec: vi.fn(async (command: string, args: string[]) => {
      // Mock git symbolic-ref HEAD (bare clone has HEAD, not refs/remotes/origin/HEAD)
      if (command === 'git' && args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/main\n', stderr: '' }
      }
      // Mock git fetch
      if (command === 'git' && args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      // Mock git clone --bare
      if (command === 'git' && args[0] === 'clone' && args[1] === '--bare') {
        // Create the bare.git directory to simulate clone
        await fs.mkdir(args[2], { recursive: true })
        return { stdout: '', stderr: '' }
      }
      // Mock git worktree add -b <feature> <path> <branch>
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        // With -b flag: args = ['worktree', 'add', '-b', feature, path, branch]
        const worktreeDir = args[2] === '-b' ? args[4] : args[2]
        await fs.mkdir(worktreeDir, { recursive: true })
        return { stdout: '', stderr: '' }
      }
      // Mock git worktree remove
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        const targetPath = args[2] === '--force' ? args[3] : args[2]
        await fs.rm(targetPath, { recursive: true, force: true })
        return { stdout: '', stderr: '' }
      }
      // Mock git rev-parse
      if (command === 'git' && args[0] === 'rev-parse') {
        if (args.includes('--short') && args.includes('HEAD')) {
          return { stdout: 'abc1234\n', stderr: '' }
        }
        return { stdout: 'main\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }),
  }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-test-'))
})

afterEach(async () => {
  vi.clearAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function startServer(overrides: {
  commandRunner?: CommandRunner
  baseDir?: string
} = {}): Promise<RunningServer> {
  const app = express()
  app.use(express.json())

  const router = createFactoryRouter({
    apiKeyStore: createTestApiKeyStore(),
    baseDir: overrides.baseDir ?? tmpDir,
    commandRunner: overrides.commandRunner ?? createMockCommandRunner(),
  })
  app.use('/api/factory', router)

  const httpServer = createServer(app)

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve())
  })

  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve test server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    httpServer,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
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

describe('factory routes', () => {
  describe('GET /repos', () => {
    it('requires authentication', async () => {
      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos`)

      expect(response.status).toBe(401)
      await server.close()
    })

    it('returns empty list when no repos exist', async () => {
      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos`, {
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
      await server.close()
    })

    it('lists cloned repos', async () => {
      // Pre-populate a repo directory
      await fs.mkdir(path.join(tmpDir, 'test-owner', 'test-repo', 'bare.git'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos`, {
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      const repos = await response.json()
      expect(repos).toHaveLength(1)
      expect(repos[0]).toEqual({
        owner: 'test-owner',
        repo: 'test-repo',
        path: path.join(tmpDir, 'test-owner', 'test-repo'),
        commitHash: 'abc1234',
      })

      await server.close()
    })
  })

  describe('POST /repos', () => {
    it('requires authentication', async () => {
      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://github.com/owner/repo' }),
      })

      expect(response.status).toBe(401)
      await server.close()
    })

    it('rejects invalid GitHub URLs', async () => {
      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://gitlab.com/owner/repo' }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid GitHub URL' })
      await server.close()
    })

    it('clones a GitHub repo', async () => {
      const mockRunner = createMockCommandRunner()
      const server = await startServer({ commandRunner: mockRunner })

      const response = await fetch(`${server.baseUrl}/api/factory/repos`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://github.com/example-user/example-repo' }),
      })

      expect(response.status).toBe(201)
      const body = await response.json()
      expect(body.owner).toBe('example-user')
      expect(body.repo).toBe('example-repo')
      expect(mockRunner.exec).toHaveBeenCalledWith(
        'git',
        ['clone', '--bare', 'https://github.com/example-user/example-repo.git', expect.stringContaining('bare.git')],
      )

      await server.close()
    })

    it('returns 409 if repo already cloned', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://github.com/owner/repo' }),
      })

      expect(response.status).toBe(409)
      await server.close()
    })

    it('returns 403 for write when key lacks write scope', async () => {
      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos`, {
        method: 'POST',
        headers: { ...READ_ONLY_AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://github.com/owner/repo' }),
      })

      expect(response.status).toBe(403)
      await server.close()
    })

    it('strips .git suffix from URL', async () => {
      const mockRunner = createMockCommandRunner()
      const server = await startServer({ commandRunner: mockRunner })

      const response = await fetch(`${server.baseUrl}/api/factory/repos`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://github.com/owner/repo.git' }),
      })

      expect(response.status).toBe(201)
      const body = await response.json()
      expect(body.repo).toBe('repo')

      await server.close()
    })
  })

  describe('DELETE /repos/:owner/:repo', () => {
    it('deletes a cloned repo', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ deleted: true })

      await server.close()
    })

    it('returns 404 when repo does not exist', async () => {
      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/nonexistent`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(404)
      await server.close()
    })

    it('rejects .. traversal in path params', async () => {
      // Express/Node normalize ".." out of URL paths before routing, so the
      // route handler never receives ".." as a param value. The parseOwnerRepo
      // rejection of "." and ".." is defense-in-depth. Here we verify that
      // traversal attempts are blocked regardless (Express returns 404 because
      // path normalization collapses the segments and the route doesn't match).
      const server = await startServer()

      const ownerTraversal = await fetch(`${server.baseUrl}/api/factory/repos/../repo`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(ownerTraversal.ok).toBe(false)

      const repoTraversal = await fetch(`${server.baseUrl}/api/factory/repos/owner/..`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(repoTraversal.ok).toBe(false)

      await server.close()
    })

    it('accepts dotted repo names', async () => {
      await fs.mkdir(path.join(tmpDir, 'org', 'my.repo', 'bare.git'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/org/my.repo`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ deleted: true })
      await server.close()
    })
  })

  describe('GET /repos/:owner/:repo/worktrees', () => {
    it('returns empty list when no worktrees exist', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/worktrees`, {
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
      await server.close()
    })

    it('lists existing worktrees', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'worktrees', 'fix-auth'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/worktrees`, {
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      const worktrees = await response.json()
      expect(worktrees).toHaveLength(1)
      expect(worktrees[0].feature).toBe('fix-auth')
      expect(worktrees[0].branch).toBe('main')

      await server.close()
    })
  })

  describe('POST /repos/:owner/:repo/worktrees', () => {
    it('creates a worktree', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })

      const mockRunner = createMockCommandRunner()
      const server = await startServer({ commandRunner: mockRunner })

      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/worktrees`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'fix-auth-bug' }),
      })

      expect(response.status).toBe(201)
      const body = await response.json()
      expect(body.feature).toBe('fix-auth-bug')
      expect(body.branch).toBe('fix-auth-bug')

      await server.close()
    })

    it('rejects invalid feature names', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/worktrees`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ feature: '../escape' }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid feature name' })
      await server.close()
    })

    it('returns 404 when repo does not exist', async () => {
      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/nonexistent/worktrees`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'fix-auth' }),
      })

      expect(response.status).toBe(404)
      await server.close()
    })

    it('returns 409 when worktree already exists', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'worktrees', 'fix-auth'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/worktrees`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'fix-auth' }),
      })

      expect(response.status).toBe(409)
      await server.close()
    })
  })

  describe('DELETE /repos/:owner/:repo/worktrees/:feature', () => {
    it('removes a worktree', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'worktrees', 'fix-auth'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/worktrees/fix-auth`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ deleted: true })
      await server.close()
    })

    it('returns 404 for nonexistent worktree', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/worktrees/nonexistent`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(404)
      await server.close()
    })

    it('cleans up branch so worktree name can be reused', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })

      const mockRunner = createMockCommandRunner()
      const server = await startServer({ commandRunner: mockRunner })

      // Create worktree
      const createRes = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/worktrees`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'reuse-me' }),
      })
      expect(createRes.status).toBe(201)

      // Delete worktree
      const deleteRes = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/worktrees/reuse-me`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(deleteRes.status).toBe(200)

      // Verify git branch -D was called to clean up the branch
      expect(mockRunner.exec).toHaveBeenCalledWith(
        'git',
        ['branch', '-D', 'reuse-me'],
        expect.objectContaining({ cwd: expect.stringContaining('bare.git') }),
      )

      // Re-create worktree with the same name should succeed
      const recreateRes = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/worktrees`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'reuse-me' }),
      })
      expect(recreateRes.status).toBe(201)

      await server.close()
    })
  })

  describe('POST /repos/:owner/:repo/sync', () => {
    it('fetches from origin for a bare repo', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })

      const mockRunner = createMockCommandRunner()
      const server = await startServer({ commandRunner: mockRunner })

      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/sync`, {
        method: 'POST',
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ synced: true, commitHash: 'abc1234' })
      expect(mockRunner.exec).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin'],
        expect.objectContaining({ cwd: expect.stringContaining('bare.git') }),
      )

      await server.close()
    })

    it('returns 404 when repo does not exist', async () => {
      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/nonexistent/sync`, {
        method: 'POST',
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(404)
      await server.close()
    })

    it('requires write access', async () => {
      await fs.mkdir(path.join(tmpDir, 'owner', 'repo', 'bare.git'), { recursive: true })

      const server = await startServer()
      const response = await fetch(`${server.baseUrl}/api/factory/repos/owner/repo/sync`, {
        method: 'POST',
        headers: READ_ONLY_AUTH_HEADERS,
      })

      expect(response.status).toBe(403)
      await server.close()
    })
  })
})
