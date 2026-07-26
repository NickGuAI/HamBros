import {
  appendWorkingMemory,
  applyRemoteMemorySnapshot,
  clearWorkingMemory,
  exportRemoteMemorySnapshot,
  readWorkingMemory,
  saveFacts,
} from '../memory/module.js'
import { parseNonNegativeInteger } from '../memory/remote-sync.js'
import {
  isObject,
  parseMessage,
  parseSessionId,
} from '../route-parsers.js'
import type { CommanderRoutesContext } from './types.js'

export function registerMemoryRoutes(
  router: import('express').Router,
  context: CommanderRoutesContext,
): void {
  router.get('/:id/memory/working-memory', context.requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    try {
      const content = await readWorkingMemory(commanderId, context.commanderBasePath, {
        now: context.now,
      })
      res.json({ content })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to read working memory',
      })
    }
  })

  router.post('/:id/memory/working-memory', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const content = parseMessage(req.body?.content)
    if (!content) {
      res.status(400).json({ error: 'content is required' })
      return
    }

    try {
      const nextContent = await appendWorkingMemory(
        commanderId,
        content,
        context.commanderBasePath,
        {
        now: context.now,
        },
        context.commanderDataDir,
      )
      res.status(201).json({ content: nextContent })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to append working memory',
      })
    }
  })

  router.delete('/:id/memory/working-memory', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    try {
      await clearWorkingMemory(commanderId, context.commanderBasePath, {
        now: context.now,
      }, context.commanderDataDir)
      res.status(204).send()
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to clear working memory',
      })
    }
  })

  router.put('/:id/memory/sync', async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const auth = context.authorizeRemoteSync(req, session)
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const baseRevision = parseNonNegativeInteger(body.baseRevision)
    if (baseRevision === null) {
      res.status(400).json({ error: 'baseRevision must be a non-negative integer' })
      return
    }
    const memoryMdRaw = body.memoryMd
    if (memoryMdRaw !== undefined && typeof memoryMdRaw !== 'string') {
      res.status(400).json({ error: 'memoryMd must be a string when provided' })
      return
    }
    const memoryMd = typeof memoryMdRaw === 'string' ? memoryMdRaw : undefined

    try {
      const result = await applyRemoteMemorySnapshot(
        commanderId,
        baseRevision,
        memoryMd,
        context.commanderBasePath,
        context.commanderDataDir,
      )
      if (result.status === 'conflict') {
        res.status(409).json({
          error: `Memory sync conflict: base revision ${baseRevision} is stale; current revision is ${result.currentSyncRevision}. Re-run remote init to rebootstrap before syncing again.`,
          currentSyncRevision: result.currentSyncRevision,
        })
        return
      }

      res.status(200).json({
        appliedRevision: result.appliedRevision,
        memoryUpdated: result.memoryUpdated,
      })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to sync commander memory',
      })
    }
  })

  router.get('/:id/memory/export', async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const auth = context.authorizeRemoteSync(req, session)
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error })
      return
    }

    try {
      res.json(await exportRemoteMemorySnapshot(commanderId, context.commanderBasePath))
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to export commander memory',
      })
    }
  })

  router.post('/:id/memory/facts', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const facts = Array.isArray(body.facts)
      ? body.facts.filter((fact: unknown): fact is string => typeof fact === 'string' && fact.trim().length > 0)
      : []
    if (facts.length === 0) {
      res.status(400).json({ error: 'facts array with at least one non-empty string is required' })
      return
    }

    try {
      res.json(await saveFacts(
        commanderId,
        facts,
        context.commanderBasePath,
        context.commanderDataDir,
      ))
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to save facts',
      })
    }
  })
}
