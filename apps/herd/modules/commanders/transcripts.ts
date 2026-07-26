import path from 'node:path'
import { appendFileDurably } from '../durable-file.js'
import type { CommanderTranscriptAppendInput, CommanderTranscriptAppender } from '../agents/types.js'
import { withCommanderMutation } from './child-mutation-coordinator.js'

const COMMANDER_TRANSCRIPT_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/

export function createCommanderTranscriptAppender(dataDir: string): CommanderTranscriptAppender {
  const root = path.resolve(dataDir)
  const queues = new Map<string, Promise<void>>()

  function resolveTranscriptPath(input: CommanderTranscriptAppendInput): string | null {
    const commanderId = input.commanderId.trim()
    const transcriptId = input.transcriptId.trim()
    if (
      !COMMANDER_TRANSCRIPT_PATH_SEGMENT_PATTERN.test(commanderId)
      || !COMMANDER_TRANSCRIPT_PATH_SEGMENT_PATTERN.test(transcriptId)
    ) {
      return null
    }
    return path.join(root, commanderId, 'sessions', `${transcriptId}.jsonl`)
  }

  return {
    appendEvent(input) {
      const transcriptPath = resolveTranscriptPath(input)
      if (!transcriptPath) {
        return
      }

      let line: string
      try {
        line = `${JSON.stringify(input.event)}\n`
      } catch {
        return
      }

      const previous = queues.get(transcriptPath) ?? Promise.resolve()
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          await withCommanderMutation(input.commanderId, root, () => (
            appendFileDurably(transcriptPath, line)
          ))
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[commanders] Failed to append transcript "${transcriptPath}": ${message}`)
        })

      queues.set(transcriptPath, next)
      void next.finally(() => {
        if (queues.get(transcriptPath) === next) {
          queues.delete(transcriptPath)
        }
      })
    },
  }
}
