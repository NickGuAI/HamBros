import { JournalWriter, WorkingMemoryStore } from '../memory/index.js'
import {
  isObject,
  parseGitHubIssueUrl,
  parseMessage,
  parseQuestArtifacts,
  parseQuestContract,
  parseQuestId,
  parseQuestIssueNumber,
  parseQuestSource,
  parseQuestStatus,
  parseSessionId,
} from '../route-parsers.js'
import type {
  CommanderQuestSource,
  CommanderQuestStatus,
  QuestArtifact,
} from '../quest-store.js'
import {
  buildQuestInstructionFromGitHubIssue,
  summarizeQuestInstruction,
  toSessionRepo,
} from './context.js'
import type { CommanderRoutesContext } from './types.js'

export function registerQuestRoutes(
  router: import('express').Router,
  context: CommanderRoutesContext,
): void {
  router.get('/quests', context.requireReadAccess, async (_req, res) => {
    try {
      const sessions = await context.sessionStore.list()
      const quests = await Promise.all(
        sessions.map(async (session) => {
          const commanderQuests = await context.questStore.list(session.id)
          return commanderQuests.map((quest) => ({
            ...quest,
            commanderId: session.id,
          }))
        }),
      )
      res.json(quests.flat())
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list quests',
      })
    }
  })

  router.get('/:id/quests/next', async (req, res) => {
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
      const quest = await context.questStore.claimNext(commanderId)
      if (quest) {
        const runtime = context.runtimes.get(commanderId)
        const issueNumber = parseQuestIssueNumber(quest)
        const repo = toSessionRepo(session)
        const summary = `Quest claimed: ${summarizeQuestInstruction(quest.instruction)}`
        const workingMemory = runtime?.workingMemory ?? new WorkingMemoryStore(commanderId, context.commanderBasePath)
        const journalWriter = runtime?.manager.journalWriter ?? new JournalWriter(commanderId, context.commanderBasePath)

        try {
          await Promise.all([
            workingMemory.update({
              source: 'system',
              summary,
              issueNumber,
              repo,
              tags: ['quest', 'claimed', quest.source],
            }),
            journalWriter.append({
              timestamp: context.now().toISOString(),
              issueNumber,
              repo,
              outcome: 'Quest claimed',
              durationMin: null,
              salience: 'ROUTINE',
              body: [
                `- Quest ID: \`${quest.id}\``,
                `- Source: ${quest.source}`,
                `- Instruction: ${summarizeQuestInstruction(quest.instruction)}`,
              ].join('\n'),
            }),
          ])
          await context.refreshCommanderMemoryIndex(commanderId)
        } catch (error) {
          console.error(`[commanders] Failed to persist quest claim activity for "${commanderId}":`, error)
        }
      }
      res.json({ quest })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to claim next quest',
      })
    }
  })

  router.get('/:id/quests', context.requireReadAccess, async (req, res) => {
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
      const quests = await context.questStore.list(commanderId)
      res.json(quests)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list quests',
      })
    }
  })

  router.post('/:id/quests', context.requireWriteAccess, async (req, res) => {
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
    const hasSource = Object.prototype.hasOwnProperty.call(body, 'source')
    const hasGitHubIssueUrl = Object.prototype.hasOwnProperty.call(body, 'githubIssueUrl')
    const hasNote = Object.prototype.hasOwnProperty.call(body, 'note')
    const hasArtifacts = Object.prototype.hasOwnProperty.call(body, 'artifacts')

    const githubIssue = hasGitHubIssueUrl ? parseGitHubIssueUrl(body.githubIssueUrl) : null
    if (hasGitHubIssueUrl && !githubIssue) {
      res.status(400).json({ error: 'githubIssueUrl must be a valid GitHub issue URL' })
      return
    }

    let source: CommanderQuestSource
    if (hasSource) {
      const parsedSource = parseQuestSource(body.source)
      if (!parsedSource) {
        res.status(400).json({ error: 'source is invalid' })
        return
      }
      source = parsedSource
    } else {
      source = githubIssue ? 'github-issue' : 'manual'
    }

    const contract = parseQuestContract(body.contract)
    if (!contract) {
      res.status(400).json({ error: 'contract is invalid' })
      return
    }

    let note: string | undefined
    if (hasNote) {
      const parsedNote = parseMessage(body.note)
      if (!parsedNote) {
        res.status(400).json({ error: 'note must be a non-empty string when provided' })
        return
      }
      note = parsedNote
    }

    let artifacts: QuestArtifact[] | undefined
    if (hasArtifacts) {
      const parsedArtifacts = parseQuestArtifacts(body.artifacts)
      if (!parsedArtifacts) {
        res.status(400).json({ error: 'artifacts must be an array of { type, label, href }' })
        return
      }
      artifacts = parsedArtifacts
    }

    let instruction = parseMessage(body.instruction)
    if (githubIssue) {
      try {
        const ghTasks = context.ghTasksFactory(`${githubIssue.owner}/${githubIssue.repo}`)
        const issue = await ghTasks.readTask(githubIssue.issueNumber)
        instruction = buildQuestInstructionFromGitHubIssue({
          title: issue.title,
          body: issue.body,
        })
      } catch (error) {
        res.status(502).json({
          error: error instanceof Error ? error.message : 'Failed to import GitHub issue',
        })
        return
      }
    }

    if (!instruction) {
      res.status(400).json({ error: 'instruction is required when githubIssueUrl is not provided' })
      return
    }

    try {
      const created = await context.questStore.create({
        commanderId,
        status: 'pending',
        source,
        instruction,
        ...(githubIssue ? { githubIssueUrl: githubIssue.normalizedUrl } : {}),
        ...(note ? { note } : {}),
        ...(artifacts !== undefined ? { artifacts } : {}),
        contract,
      })
      res.status(201).json(created)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create quest',
      })
    }
  })

  router.patch('/:id/quests/:questId', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const questId = parseQuestId(req.params.questId)
    if (!questId) {
      res.status(400).json({ error: 'Invalid quest id' })
      return
    }

    const commanderSession = await context.sessionStore.get(commanderId)
    if (!commanderSession) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const existingQuest = await context.questStore.get(commanderId, questId)
    if (!existingQuest) {
      res.status(404).json({ error: `Quest "${questId}" not found` })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status')
    const hasNote = Object.prototype.hasOwnProperty.call(body, 'note')
    const hasArtifacts = Object.prototype.hasOwnProperty.call(body, 'artifacts')
    if (!hasStatus && !hasNote && !hasArtifacts) {
      res.status(400).json({ error: 'At least one of status, note, or artifacts is required' })
      return
    }

    const update: {
      status?: CommanderQuestStatus
      note?: string | null
      artifacts?: QuestArtifact[] | null
    } = {}
    if (hasStatus) {
      const status = parseQuestStatus(body.status)
      if (!status) {
        res.status(400).json({ error: 'status is invalid' })
        return
      }
      update.status = status
    }
    if (hasNote) {
      if (body.note === null) {
        update.note = null
      } else {
        const note = parseMessage(body.note)
        if (!note) {
          res.status(400).json({ error: 'note must be a non-empty string or null' })
          return
        }
        update.note = note
      }
    }
    if (hasArtifacts) {
      if (body.artifacts === null) {
        update.artifacts = null
      } else {
        const artifacts = parseQuestArtifacts(body.artifacts)
        if (!artifacts) {
          res.status(400).json({ error: 'artifacts must be an array of { type, label, href } or null' })
          return
        }
        update.artifacts = artifacts
      }
    }

    try {
      const updated = await context.questStore.update(commanderId, questId, update)
      if (!updated) {
        res.status(404).json({ error: `Quest "${questId}" not found` })
        return
      }

      if (update.status && update.status !== existingQuest.status) {
        const runtime = context.runtimes.get(commanderId)
        const repo = toSessionRepo(commanderSession)
        const issueNumber = parseQuestIssueNumber(updated)
        const summaryPrefix = update.status === 'done'
          ? 'Quest completed'
          : update.status === 'failed'
            ? 'Quest failed'
            : update.status === 'active'
              ? 'Quest activated'
              : 'Quest moved to pending'
        const summary = `${summaryPrefix}: ${summarizeQuestInstruction(updated.instruction)}`
        const workingMemory = runtime?.workingMemory ?? new WorkingMemoryStore(commanderId, context.commanderBasePath)
        const journalWriter = runtime?.manager.journalWriter ?? new JournalWriter(commanderId, context.commanderBasePath)

        try {
          await Promise.all([
            workingMemory.update({
              source: 'system',
              summary,
              issueNumber,
              repo,
              tags: ['quest', update.status, updated.source],
            }),
            journalWriter.append({
              timestamp: context.now().toISOString(),
              issueNumber,
              repo,
              outcome: summaryPrefix,
              durationMin: null,
              salience: update.status === 'failed'
                ? 'SPIKE'
                : update.status === 'done'
                  ? 'NOTABLE'
                  : 'ROUTINE',
              body: [
                `- Quest ID: \`${updated.id}\``,
                `- Status: ${existingQuest.status} -> ${update.status}`,
                `- Instruction: ${summarizeQuestInstruction(updated.instruction)}`,
              ].join('\n'),
            }),
          ])
          await context.refreshCommanderMemoryIndex(commanderId)
        } catch (error) {
          console.error(`[commanders] Failed to persist quest status activity for "${commanderId}":`, error)
        }
      }

      res.json(updated)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to update quest',
      })
    }
  })

  router.post('/:id/quests/:questId/notes', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const questId = parseQuestId(req.params.questId)
    if (!questId) {
      res.status(400).json({ error: 'Invalid quest id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const note = parseMessage(body.note)
    if (!note) {
      res.status(400).json({ error: 'note must be a non-empty string' })
      return
    }

    try {
      const updated = await context.questStore.appendNote(commanderId, questId, note)
      if (!updated) {
        res.status(404).json({ error: `Quest "${questId}" not found` })
        return
      }
      res.json(updated)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to append quest note',
      })
    }
  })

  router.delete('/:id/quests/:questId', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const questId = parseQuestId(req.params.questId)
    if (!questId) {
      res.status(400).json({ error: 'Invalid quest id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    try {
      const deleted = await context.questStore.delete(commanderId, questId)
      if (!deleted) {
        res.status(404).json({ error: `Quest "${questId}" not found` })
        return
      }
      res.status(204).send()
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete quest',
      })
    }
  })
}
