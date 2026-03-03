import {
  MemoryContextBuilder,
  type BuiltContext,
  type ContextBuildOptions,
} from './memory/context-builder.js'

const TASK_MANAGEMENT_PROMPT = [
  '## Task Management',
  'Your task queue is GitHub Issues. On each heartbeat:',
  '1. Check if you have a current task in progress. If so, continue it.',
  '2. If no current task, run: gh issue list --label commander --repo <owner>/<repo> --state open',
  '3. Pick the lowest-numbered open issue, assign yourself, and begin.',
  '4. Post a comment on the issue when you start and when you finish.',
  '5. When done, close the issue and immediately pick up the next one.',
].join('\n')

export interface CommanderAgentPromptResult extends BuiltContext {
  systemPrompt: string
}

/**
 * Prompt helper for Commander runtime events.
 * Injects assembled memory context into the system prompt at:
 * - task pickup
 * - heartbeat
 */
export class CommanderAgent {
  private readonly contextBuilder: MemoryContextBuilder

  constructor(
    private readonly commanderId: string,
    basePath?: string,
  ) {
    this.contextBuilder = new MemoryContextBuilder(commanderId, basePath)
  }

  async buildTaskPickupSystemPrompt(
    baseSystemPrompt: string,
    options: ContextBuildOptions,
  ): Promise<CommanderAgentPromptResult> {
    return this.buildSystemPrompt(baseSystemPrompt, options)
  }

  async buildHeartbeatSystemPrompt(
    baseSystemPrompt: string,
    options: ContextBuildOptions,
  ): Promise<CommanderAgentPromptResult> {
    return this.buildSystemPrompt(baseSystemPrompt, options)
  }

  private async buildSystemPrompt(
    baseSystemPrompt: string,
    options: ContextBuildOptions,
  ): Promise<CommanderAgentPromptResult> {
    const builtContext = await this.contextBuilder.build(options)
    const base = baseSystemPrompt.trim()
    const promptSections = [
      base,
      base.includes('## Task Management') ? '' : TASK_MANAGEMENT_PROMPT,
      builtContext.systemPromptSection,
    ].filter((section) => section.length > 0)
    const systemPrompt = promptSections.join('\n\n')

    return {
      ...builtContext,
      systemPrompt,
    }
  }

  get id(): string {
    return this.commanderId
  }
}
