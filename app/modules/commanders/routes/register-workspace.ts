import {
  listWorkspaceTree,
  readWorkspaceFilePreview,
  readWorkspaceGitLog,
  readWorkspaceGitStatus,
  WorkspaceError,
} from '../../workspace/index.js'
import type { CommanderRoutesContext } from './types.js'

export function registerWorkspaceRoutes(
  router: import('express').Router,
  context: CommanderRoutesContext,
): void {
  router.get('/:id/workspace/tree', context.requireReadAccess, async (req, res) => {
    try {
      const workspace = await context.resolveCommanderWorkspace(req.params.id)
      const tree = await listWorkspaceTree(
        workspace,
        typeof req.query.path === 'string' ? req.query.path : '',
      )
      res.json(tree)
    } catch (error) {
      context.sendWorkspaceError(res, error)
    }
  })

  router.get('/:id/workspace/expand', context.requireReadAccess, async (req, res) => {
    try {
      const workspace = await context.resolveCommanderWorkspace(req.params.id)
      const tree = await listWorkspaceTree(
        workspace,
        typeof req.query.path === 'string' ? req.query.path : '',
      )
      res.json(tree)
    } catch (error) {
      context.sendWorkspaceError(res, error)
    }
  })

  router.get('/:id/workspace/file', context.requireReadAccess, async (req, res) => {
    try {
      if (typeof req.query.path !== 'string' || !req.query.path.trim()) {
        throw new WorkspaceError(400, 'path query parameter is required')
      }
      const workspace = await context.resolveCommanderWorkspace(req.params.id)
      const preview = await readWorkspaceFilePreview(workspace, req.query.path)
      res.json(preview)
    } catch (error) {
      context.sendWorkspaceError(res, error)
    }
  })

  router.get('/:id/workspace/git/status', context.requireReadAccess, async (req, res) => {
    try {
      const workspace = await context.resolveCommanderWorkspace(req.params.id)
      const status = await readWorkspaceGitStatus(workspace)
      res.json(status)
    } catch (error) {
      context.sendWorkspaceError(res, error)
    }
  })

  router.get('/:id/workspace/git/log', context.requireReadAccess, async (req, res) => {
    try {
      const workspace = await context.resolveCommanderWorkspace(req.params.id)
      const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 15
      const log = await readWorkspaceGitLog(workspace, Number.isFinite(limit) ? limit : 15)
      res.json(log)
    } catch (error) {
      context.sendWorkspaceError(res, error)
    }
  })
}
