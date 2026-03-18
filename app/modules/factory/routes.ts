import { Router, type Router as RouterType } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import type { CommandRunner } from './worktree.js'
import {
  bootstrapFactoryWorktree,
  defaultCommandRunner,
  parseFeatureName,
  parseOwnerRepo,
} from './worktree.js'

// Re-export for consumers that import from this module (e.g. tests, agents/routes)
export type { CommandRunner, BootstrapFactoryWorktreeInput, BootstrapFactoryWorktreeResult } from './worktree.js'
export { bootstrapFactoryWorktree } from './worktree.js'

const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/

export interface FactoryRouterOptions {
  baseDir?: string
  commandRunner?: CommandRunner
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
}

function parseGitHubUrl(url: unknown): { owner: string; repo: string } | null {
  if (typeof url !== 'string') {
    return null
  }

  const match = url.trim().match(GITHUB_URL_PATTERN)
  if (!match) {
    return null
  }

  return { owner: match[1], repo: match[2] }
}

export function createFactoryRouter(options: FactoryRouterOptions = {}): RouterType {
  const router = Router()
  const baseDir = options.baseDir ?? path.join(process.env.HOME || '/tmp', '.factory')
  const runner = options.commandRunner ?? defaultCommandRunner()

  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['factory:read'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
  })
  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['factory:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
  })

  // GET /repos - List cloned repos
  router.get('/repos', requireReadAccess, async (_req, res) => {
    try {
      const repos: { owner: string; repo: string; path: string; commitHash: string }[] = []

      let owners: string[]
      try {
        owners = await fs.readdir(baseDir)
      } catch {
        res.json(repos)
        return
      }

      for (const owner of owners) {
        const ownerDir = path.join(baseDir, owner)
        const ownerStat = await fs.stat(ownerDir).catch(() => null)
        if (!ownerStat?.isDirectory()) continue

        const repoNames = await fs.readdir(ownerDir).catch(() => [])
        for (const repoName of repoNames) {
          const repoDir = path.join(ownerDir, repoName)
          const bareGit = path.join(repoDir, 'bare.git')
          const bareExists = await fs.stat(bareGit).catch(() => null)
          if (bareExists?.isDirectory()) {
            let commitHash = ''
            try {
              const { stdout } = await runner.exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: bareGit })
              commitHash = stdout.trim()
            } catch {
              // bare repo may have no commits yet
            }
            repos.push({ owner, repo: repoName, path: repoDir, commitHash })
          }
        }
      }

      res.json(repos)
    } catch {
      res.status(500).json({ error: 'Failed to list repos' })
    }
  })

  // POST /repos - Clone a GitHub repo
  router.post('/repos', requireWriteAccess, async (req, res) => {
    const parsed = parseGitHubUrl(req.body?.url)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid GitHub URL' })
      return
    }

    const { owner, repo } = parsed
    const repoDir = path.join(baseDir, owner, repo)
    const bareGitDir = path.join(repoDir, 'bare.git')

    const exists = await fs.stat(bareGitDir).catch(() => null)
    if (exists) {
      res.status(409).json({ error: `Repository ${owner}/${repo} already cloned` })
      return
    }

    try {
      const cloneUrl = `https://github.com/${owner}/${repo}.git`
      await fs.mkdir(repoDir, { recursive: true })
      await runner.exec('git', ['clone', '--bare', cloneUrl, bareGitDir])
      res.status(201).json({ owner, repo, path: repoDir })
    } catch {
      res.status(500).json({ error: 'Failed to clone repository' })
    }
  })

  // DELETE /repos/:owner/:repo - Remove repo + all worktrees
  router.delete('/repos/:owner/:repo', requireWriteAccess, async (req, res) => {
    const parsed = parseOwnerRepo(req.params.owner, req.params.repo)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid owner or repo name' })
      return
    }

    const { owner, repo } = parsed
    const repoDir = path.join(baseDir, owner, repo)

    const exists = await fs.stat(repoDir).catch(() => null)
    if (!exists) {
      res.status(404).json({ error: `Repository ${owner}/${repo} not found` })
      return
    }

    try {
      await fs.rm(repoDir, { recursive: true, force: true })
      res.json({ deleted: true })
    } catch {
      res.status(500).json({ error: 'Failed to delete repository' })
    }
  })

  // POST /repos/:owner/:repo/sync - Fetch latest from origin for bare repo
  router.post('/repos/:owner/:repo/sync', requireWriteAccess, async (req, res) => {
    const parsed = parseOwnerRepo(req.params.owner, req.params.repo)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid owner or repo name' })
      return
    }

    const { owner, repo } = parsed
    const bareGitDir = path.join(baseDir, owner, repo, 'bare.git')

    const bareExists = await fs.stat(bareGitDir).catch(() => null)
    if (!bareExists) {
      res.status(404).json({ error: `Repository ${owner}/${repo} not found` })
      return
    }

    try {
      await runner.exec('git', ['fetch', 'origin'], { cwd: bareGitDir })
      let commitHash = ''
      try {
        const { stdout } = await runner.exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: bareGitDir })
        commitHash = stdout.trim()
      } catch {
        // ignore
      }
      res.json({ synced: true, commitHash })
    } catch {
      res.status(500).json({ error: 'Failed to sync with remote' })
    }
  })

  // GET /repos/:owner/:repo/worktrees - List worktrees
  router.get('/repos/:owner/:repo/worktrees', requireReadAccess, async (req, res) => {
    const parsed = parseOwnerRepo(req.params.owner, req.params.repo)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid owner or repo name' })
      return
    }

    const { owner, repo } = parsed
    const worktreesDir = path.join(baseDir, owner, repo, 'worktrees')

    try {
      const entries = await fs.readdir(worktreesDir).catch(() => [])
      const worktrees: { feature: string; path: string; branch: string }[] = []

      for (const entry of entries) {
        const worktreePath = path.join(worktreesDir, entry)
        const stat = await fs.stat(worktreePath).catch(() => null)
        if (!stat?.isDirectory()) continue

        let branch = 'unknown'
        try {
          const { stdout } = await runner.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath })
          branch = stdout.trim()
        } catch {
          // keep 'unknown'
        }

        worktrees.push({ feature: entry, path: worktreePath, branch })
      }

      res.json(worktrees)
    } catch {
      res.status(500).json({ error: 'Failed to list worktrees' })
    }
  })

  // POST /repos/:owner/:repo/worktrees - Create worktree
  router.post('/repos/:owner/:repo/worktrees', requireWriteAccess, async (req, res) => {
    const parsed = parseOwnerRepo(req.params.owner, req.params.repo)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid owner or repo name' })
      return
    }

    const feature = parseFeatureName(req.body?.feature)
    if (!feature) {
      res.status(400).json({ error: 'Invalid feature name' })
      return
    }

    const { owner, repo } = parsed
    const bareGitDir = path.join(baseDir, owner, repo, 'bare.git')
    const worktreePath = path.join(baseDir, owner, repo, 'worktrees', feature)

    const bareExists = await fs.stat(bareGitDir).catch(() => null)
    if (!bareExists) {
      res.status(404).json({ error: `Repository ${owner}/${repo} not found` })
      return
    }

    const worktreeExists = await fs.stat(worktreePath).catch(() => null)
    if (worktreeExists) {
      res.status(409).json({ error: `Worktree "${feature}" already exists` })
      return
    }

    try {
      const created = await bootstrapFactoryWorktree({
        owner,
        repo,
        feature,
        baseDir,
        commandRunner: runner,
      })
      res.status(201).json({ feature: created.feature, path: created.path, branch: created.branch })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create worktree'
      if (message.includes('already exists')) {
        res.status(409).json({ error: message })
        return
      }
      res.status(500).json({ error: 'Failed to create worktree' })
    }
  })

  // DELETE /repos/:owner/:repo/worktrees/:feature - Remove worktree
  router.delete('/repos/:owner/:repo/worktrees/:feature', requireWriteAccess, async (req, res) => {
    const parsed = parseOwnerRepo(req.params.owner, req.params.repo)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid owner or repo name' })
      return
    }

    const feature = parseFeatureName(req.params.feature)
    if (!feature) {
      res.status(400).json({ error: 'Invalid feature name' })
      return
    }

    const { owner, repo } = parsed
    const bareGitDir = path.join(baseDir, owner, repo, 'bare.git')
    const worktreePath = path.join(baseDir, owner, repo, 'worktrees', feature)

    const worktreeExists = await fs.stat(worktreePath).catch(() => null)
    if (!worktreeExists) {
      res.status(404).json({ error: `Worktree "${feature}" not found` })
      return
    }

    try {
      await runner.exec('git', ['worktree', 'remove', worktreePath], { cwd: bareGitDir })
    } catch {
      // If git worktree remove fails (dirty), try force
      try {
        await runner.exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: bareGitDir })
      } catch {
        res.status(409).json({ error: 'Worktree has uncommitted changes. Use force to remove.' })
        return
      }
    }

    // Clean up the feature branch so the same name can be reused
    try {
      await runner.exec('git', ['branch', '-D', feature], { cwd: bareGitDir })
    } catch {
      // Branch may not exist or may be checked out elsewhere; not fatal
    }

    res.json({ deleted: true })
  })

  return router
}
