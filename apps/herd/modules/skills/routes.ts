import { Router } from 'express'
import type { AuthUser } from '@gehirn/auth-providers'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import {
  deleteSkillPackage,
  discoverSkills,
  createManualSkillPackage,
  getSkillArchive,
  getSkillExportPreview,
  getSkillPackageDetail,
  ReadOnlySkillPackageError,
  SkillPackageConflictError,
  type SkillInfo,
} from './package-discovery.js'
import { SKILL_CREATION_MODE_PROMPT } from './skill-creation-prompt.js'

export type { SkillInfo } from './package-discovery.js'
export { discoverSkills } from './package-discovery.js'

export interface SkillsRouterOptions {
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
}

function readRouteParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createSkillsRouter(options: SkillsRouterOptions = {}): Router {
  const router = Router()

  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['skills:read'],
    requiredAuth0Permissions: ['skills:read', 'commanders:read'],
    auth0PermissionMode: 'any',
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['skills:write'],
    requiredAuth0Permissions: ['skills:write', 'commanders:write'],
    auth0PermissionMode: 'any',
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  // GET /api/skills — list all installed skills
  router.get('/', requireReadAccess, async (_req, res) => {
    try {
      const skills = await discoverSkills()
      res.json(skills)
    } catch (err) {
      res.status(500).json({ error: 'Failed to discover skills', detail: String(err) })
    }
  })

  router.get('/creation-prompt', requireReadAccess, (_req, res) => {
    res.json({ prompt: SKILL_CREATION_MODE_PROMPT })
  })

  router.post('/export', requireReadAccess, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }

    try {
      const preview = await getSkillExportPreview(name)
      if (!preview) {
        res.status(404).json({ error: `Skill "${name}" not found` })
        return
      }
      res.json(preview)
    } catch (err) {
      res.status(500).json({ error: 'Failed to build skill export preview', detail: String(err) })
    }
  })

  router.post('/manual', requireWriteAccess, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : ''
    const provider = typeof req.body?.provider === 'string' ? req.body.provider.trim() : 'codex'
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }

    try {
      const created = await createManualSkillPackage({ name, description, provider })
      res.status(201).json(created)
    } catch (err) {
      if (err instanceof SkillPackageConflictError) {
        res.status(409).json({ error: err.message })
        return
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create skill package' })
    }
  })

  router.get('/:name/archive', requireReadAccess, async (req, res) => {
    const name = readRouteParam(req.params.name)
    try {
      const archive = await getSkillArchive(name)
      if (!archive) {
        res.status(404).json({ error: `Skill "${name}" not found` })
        return
      }

      const safeArchiveName = archive.archiveName.replace(/["\r\n]/g, '_')
      res.setHeader('content-type', 'application/zip')
      res.setHeader('content-disposition', `attachment; filename="${safeArchiveName}"`)
      res.setHeader('content-length', String(archive.buffer.length))
      res.send(archive.buffer)
    } catch (err) {
      res.status(500).json({ error: 'Failed to build skill archive', detail: String(err) })
    }
  })

  router.get('/:name', requireReadAccess, async (req, res) => {
    const name = readRouteParam(req.params.name)
    try {
      const skill = await getSkillPackageDetail(name)
      if (!skill) {
        res.status(404).json({ error: `Skill "${name}" not found` })
        return
      }
      res.json(skill)
    } catch (err) {
      res.status(500).json({ error: 'Failed to load skill package', detail: String(err) })
    }
  })

  router.delete('/:name', requireWriteAccess, async (req, res) => {
    const name = readRouteParam(req.params.name)
    try {
      const deleted = await deleteSkillPackage(name)
      if (!deleted) {
        res.status(404).json({ error: `Skill "${name}" not found` })
        return
      }
      res.json({ deleted: true, skill: deleted })
    } catch (err) {
      if (err instanceof ReadOnlySkillPackageError) {
        res.status(403).json({ error: err.message })
        return
      }
      res.status(500).json({ error: 'Failed to delete skill package', detail: String(err) })
    }
  })

  return router
}
