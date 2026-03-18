import {
  MemoryContextBuilder,
  type BuiltContext,
  type ContextBuildOptions,
} from './memory/context-builder.js'

const HAMBROS_SKILL_SECTION = `# Hammurabi Quest Board

You are a Commander. Your work queue lives in the Hammurabi quest board.
Use the \`hammurabi\` CLI to manage it on every heartbeat.

## Commands

List your quests (check this on every heartbeat):
  hammurabi quests list

Claim a quest before starting work:
  hammurabi quests claim <quest-id>

Post a progress note mid-task:
  hammurabi quests note <quest-id> "what you found / what you're doing"

Mark done when complete:
  hammurabi quests done <quest-id> --note "what was done and where"

Mark failed if blocked:
  hammurabi quests fail <quest-id> --note "why it failed / what's needed"

## Rules
- Always claim before working. Never work an unclaimed quest.
- Post at least one note per quest before marking done.
- One active quest at a time unless explicitly told otherwise.`

function buildCommanderMemoryWorkflowSection(commanderId: string): string {
  const commanderFlag = `--commander ${commanderId}`
  return `# Commander Memory Workflow

Use commander memory actively during every task and heartbeat. Do not rely only on passive memory context.

## Commands

Recall relevant context before acting:
  hammurabi memory find ${commanderFlag} "<query>"

Save durable facts after you discover them:
  hammurabi memory save ${commanderFlag} "<fact>"

Compact memory after major progress or context pressure:
  hammurabi memory compact ${commanderFlag}

## Rules
- Run memory find before answering questions that depend on prior project context.
- Save stable facts (decisions, paths, commands, constraints), not transient chatter.
- Compact after finishing major work chunks so future recalls stay high-signal.`
}

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
      base.includes('Hammurabi Quest Board') ? '' : HAMBROS_SKILL_SECTION,
      base.includes('Commander Memory Workflow') ? '' : buildCommanderMemoryWorkflowSection(this.commanderId),
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
