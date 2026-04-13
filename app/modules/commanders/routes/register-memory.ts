import path from 'node:path'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createCommanderMemoryRecollection } from '../memory/recollection.js'
import {
  JournalWriter,
  MemoryMdWriter,
  NightlyConsolidation,
} from '../memory/index.js'
import { resolveCommanderPaths } from '../paths.js'
import {
  COMMANDER_MEMORY_COMPACT_TASK_TYPE,
  isObject,
  parseIsoDateKey,
  parseJournalEntries,
  parseMessage,
  parseSessionId,
  parseStringMap,
} from '../route-parsers.js'
import { DEFAULT_SEMANTIC_SEARCH_TOP_K } from '../semantic-search-runner.js'
import { isCommanderSessionRunning } from '../store.js'
import type { CommanderRoutesContext } from './types.js'

function resolveSafeRelativePath(root: string, relativePath: string): string | null {
  const trimmed = relativePath.trim().replace(/\\/g, '/')
  if (!trimmed || trimmed.startsWith('/')) {
    return null
  }

  const normalized = path.posix.normalize(trimmed)
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null
  }

  const resolved = path.resolve(root, normalized)
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  if (!resolved.startsWith(rootPrefix)) {
    return null
  }

  return resolved
}

function extractLatestIsoTimestamp(content: string): string | null {
  const matches = content.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g)
  if (!matches || matches.length === 0) {
    return null
  }
  return matches[matches.length - 1] ?? null
}

function estimateTokenCount(content: string): number {
  const normalized = content.trim()
  if (!normalized) {
    return 0
  }
  return normalized.split(/\s+/).length
}

function shouldReplaceMemoryMd(current: string, incoming: string): boolean {
  const incomingTrimmed = incoming.trim()
  if (!incomingTrimmed) {
    return false
  }

  const currentTs = extractLatestIsoTimestamp(current)
  const incomingTs = extractLatestIsoTimestamp(incomingTrimmed)
  if (incomingTs && currentTs) {
    return incomingTs > currentTs
  }
  if (incomingTs && !currentTs) {
    return true
  }

  return estimateTokenCount(incomingTrimmed) > estimateTokenCount(current)
}

async function readSnapshotFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}

  const walk = async (relativeDir: string): Promise<void> => {
    const absoluteDir = relativeDir.length > 0
      ? path.join(root, relativeDir)
      : root

    let entries: Dirent[]
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }

    for (const entry of entries) {
      const nextRelative = relativeDir.length > 0
        ? path.join(relativeDir, entry.name)
        : entry.name
      if (entry.isDirectory()) {
        await walk(nextRelative)
        continue
      }
      if (!entry.isFile()) {
        continue
      }

      const absoluteFilePath = path.join(root, nextRelative)
      const fileContent = await readFile(absoluteFilePath, 'utf8')
      files[nextRelative.split(path.sep).join('/')] = fileContent
    }
  }

  await walk('')
  return files
}

export function registerMemoryRoutes(
  router: import('express').Router,
  context: CommanderRoutesContext,
): void {
  router.post('/:id/memory/journal', async (req, res) => {
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

    const date = parseIsoDateKey(req.body?.date)
    const entries = parseJournalEntries(req.body?.entries)
    if (!date || entries === null) {
      res.status(400).json({ error: 'date and entries are required' })
      return
    }

    try {
      const writer = new JournalWriter(commanderId, context.commanderBasePath)
      await writer.scaffold()
      const result = await writer.appendBatch(date, entries)
      await context.refreshCommanderMemoryIndex(commanderId)
      res.json(result)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to append journal entries',
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
    const memoryMdRaw = body.memoryMd
    if (memoryMdRaw !== undefined && typeof memoryMdRaw !== 'string') {
      res.status(400).json({ error: 'memoryMd must be a string when provided' })
      return
    }
    const memoryMd = typeof memoryMdRaw === 'string' ? memoryMdRaw : undefined

    const repos = parseStringMap(body.repos)
    if (repos === null) {
      res.status(400).json({ error: 'repos must be an object of string values' })
      return
    }

    const skills = parseStringMap(body.skills)
    if (skills === null) {
      res.status(400).json({ error: 'skills must be an object of string values' })
      return
    }

    const commanderPaths = resolveCommanderPaths(commanderId, context.commanderBasePath)
    const memoryRoot = commanderPaths.memoryRoot
    const reposRoot = path.join(memoryRoot, 'repos')
    const skillsRoot = commanderPaths.skillsRoot

    const repoTargets: Array<{ filePath: string; content: string }> = []
    for (const [relativePath, content] of Object.entries(repos)) {
      const filePath = resolveSafeRelativePath(reposRoot, relativePath)
      if (!filePath) {
        res.status(400).json({ error: `Invalid repo path "${relativePath}"` })
        return
      }
      repoTargets.push({ filePath, content })
    }

    const skillTargets: Array<{ filePath: string; content: string }> = []
    for (const [relativePath, content] of Object.entries(skills)) {
      const filePath = resolveSafeRelativePath(skillsRoot, relativePath)
      if (!filePath) {
        res.status(400).json({ error: `Invalid skill path "${relativePath}"` })
        return
      }
      skillTargets.push({ filePath, content })
    }

    try {
      await Promise.all([
        mkdir(memoryRoot, { recursive: true }),
        mkdir(reposRoot, { recursive: true }),
        mkdir(skillsRoot, { recursive: true }),
      ])

      let memoryUpdated = false
      if (memoryMd !== undefined) {
        const memoryPath = path.join(memoryRoot, 'MEMORY.md')
        let currentMemory = ''
        try {
          currentMemory = await readFile(memoryPath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }

        if (shouldReplaceMemoryMd(currentMemory, memoryMd)) {
          await writeFile(memoryPath, memoryMd, 'utf8')
          memoryUpdated = true
        }
      }

      let reposUpdated = 0
      let reposSkipped = 0
      for (const target of repoTargets) {
        let current = ''
        let exists = true
        try {
          current = await readFile(target.filePath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            exists = false
          } else {
            throw error
          }
        }

        if (!exists || target.content.length > current.length) {
          await mkdir(path.dirname(target.filePath), { recursive: true })
          await writeFile(target.filePath, target.content, 'utf8')
          reposUpdated += 1
        } else {
          reposSkipped += 1
        }
      }

      let skillsUpdated = 0
      let skillsSkipped = 0
      for (const target of skillTargets) {
        let current = ''
        let exists = true
        try {
          current = await readFile(target.filePath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            exists = false
          } else {
            throw error
          }
        }

        if (!exists || target.content.length > current.length) {
          await mkdir(path.dirname(target.filePath), { recursive: true })
          await writeFile(target.filePath, target.content, 'utf8')
          skillsUpdated += 1
        } else {
          skillsSkipped += 1
        }
      }

      if (memoryUpdated) {
        await context.refreshCommanderMemoryIndex(commanderId)
      }

      res.json({
        memoryUpdated,
        repos: { updated: reposUpdated, skipped: reposSkipped },
        skills: { updated: skillsUpdated, skipped: skillsSkipped },
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
      const commanderPaths = resolveCommanderPaths(commanderId, context.commanderBasePath)
      const memoryRoot = commanderPaths.memoryRoot
      const memoryPath = path.join(memoryRoot, 'MEMORY.md')
      const journalRoot = path.join(memoryRoot, 'journal')
      const reposRoot = path.join(memoryRoot, 'repos')

      let memoryMd = '# Commander Memory\n\n'
      try {
        memoryMd = await readFile(memoryPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }

      const journalFiles = await readSnapshotFiles(journalRoot)
      const journal: Record<string, string> = {}
      for (const [relativePath, content] of Object.entries(journalFiles)) {
        const normalized = relativePath.replace(/\.md$/i, '')
        journal[normalized] = content
      }

      const repos = await readSnapshotFiles(reposRoot)
      const skills = await readSnapshotFiles(commanderPaths.skillsRoot)

      res.json({
        memoryMd,
        journal,
        repos,
        skills,
      })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to export commander memory',
      })
    }
  })

  router.post('/:id/memory/compact', context.requireWriteAccess, async (req, res) => {
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

    const body = isObject(req.body) ? req.body : {}
    const source = body.source === 'cron' ? 'cron' : 'manual'
    const rawTargetDate = typeof body.targetDate === 'string' ? body.targetDate.trim() : ''
    if (
      Object.prototype.hasOwnProperty.call(body, 'targetDate') &&
      (
        typeof body.targetDate !== 'string' ||
        (rawTargetDate.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(rawTargetDate))
      )
    ) {
      res.status(400).json({ error: 'targetDate must be YYYY-MM-DD when provided' })
      return
    }
    const targetDate = rawTargetDate.length > 0 ? rawTargetDate : undefined

    let lookbackDays: number | undefined
    if (Object.prototype.hasOwnProperty.call(body, 'lookbackDays')) {
      if (
        typeof body.lookbackDays !== 'number' ||
        !Number.isFinite(body.lookbackDays) ||
        body.lookbackDays < 0
      ) {
        res.status(400).json({ error: 'lookbackDays must be a non-negative number when provided' })
        return
      }
      lookbackDays = Math.floor(body.lookbackDays)
    }

    if (isCommanderSessionRunning(session)) {
      if (source === 'cron') {
        res.status(200).json({
          skipped: true,
          reason: 'commander_running',
          commanderId,
          ...(targetDate ? { targetDate } : {}),
        })
        return
      }

      res.status(409).json({
        error: 'Commander is running. Pause or stop the session before compacting memory.',
      })
      return
    }

    try {
      const consolidation = new NightlyConsolidation({
        basePath: context.commanderBasePath,
        now: context.now,
      })
      const report = await consolidation.run(commanderId, {
        targetDate,
        lookbackDays,
      })
      await context.refreshCommanderMemoryIndex(commanderId)
      res.json(report)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to run memory consolidation',
      })
    }
  })

  router.post('/:id/memory/recall', context.requireWriteAccess, async (req, res) => {
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
    const cue = typeof body.cue === 'string' ? body.cue.trim() : ''
    if (!cue) {
      res.status(400).json({ error: 'cue is required' })
      return
    }

    const topK = typeof body.topK === 'number' && body.topK > 0 ? body.topK : undefined

    try {
      const recollection = createCommanderMemoryRecollection(commanderId, context.commanderBasePath)
      const result = await recollection.recall({ cue, topK })
      res.json(result)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to recall memory',
      })
    }
  })

  router.post('/:id/memory/semantic-search', context.requireWriteAccess, async (req, res) => {
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
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) {
      res.status(400).json({ error: 'query is required' })
      return
    }

    const topK = typeof body.topK === 'number' && body.topK > 0
      ? body.topK
      : DEFAULT_SEMANTIC_SEARCH_TOP_K

    try {
      const results = await context.runSemanticSearch(query, topK)
      res.json(results)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to run semantic search',
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
      const commanderPaths = resolveCommanderPaths(commanderId, context.commanderBasePath)
      await mkdir(commanderPaths.memoryRoot, { recursive: true })
      const writer = new MemoryMdWriter(commanderPaths.memoryRoot)
      const result = await writer.updateFacts(facts)
      await context.refreshCommanderMemoryIndex(commanderId)
      res.json(result)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to save facts',
      })
    }
  })
}
