import { mkdir } from 'node:fs/promises'
import { resolveCommanderDataDir, resolveCommanderPaths } from './paths.js'
import { withCommanderMutation } from './child-mutation-coordinator.js'
import {
  SubagentHandoff,
  type SubagentResult,
  WorkingMemoryStore,
} from './memory/index.js'
import type { GHIssue } from './memory/handoff.js'
import type {
  AgentSessionCompletion,
  AgentSessionCreateInput,
  AgentSessionKind,
  AgentSessionMonitorOptions,
  AgentSessionTransportMode,
  AgentType,
  CreatedAgentSession,
} from '@gehirn/ai-services'
import { AgentSessionClient } from '@gehirn/ai-services'

export interface Commander {
  id: string
}

export interface CommanderInitOptions {
  skipScaffold?: boolean
}

export interface ContextPressureAgentSdk {
  onContextPressure(handler: () => Promise<void> | void): void
}

export interface CommanderAgentSessionTool {
  createSession(input: AgentSessionCreateInput): Promise<CreatedAgentSession>
  monitorSession(
    sessionId: string,
    options?: AgentSessionMonitorOptions,
  ): Promise<AgentSessionCompletion>
}

export interface DelegateSubagentTaskInput {
  sessionName: string
  instruction: string
  mode?: AgentSessionTransportMode
  sessionType?: AgentSessionKind
  agentType?: AgentType
  cwd?: string
  host?: string
  monitorOptions?: AgentSessionMonitorOptions
}

export type CommanderSubagentState = 'running' | 'completed' | 'failed'

export interface CommanderSubagentLifecycleEvent {
  sessionId: string
  dispatchedAt: string
  state: CommanderSubagentState
  result?: string
}

export interface CommanderManagerOptions {
  agentSessions?: CommanderAgentSessionTool
  onSubagentLifecycleEvent?: (event: CommanderSubagentLifecycleEvent) => void
  lifecycleScope?: string
}

/**
 * CommanderManager owns the lifecycle of a Commander's on-disk state.
 * Calling `init()` ensures the `.memory/` directory scaffold exists before
 * any memory operations are attempted.
 */
export class CommanderManager {
  private readonly handoff: SubagentHandoff
  private readonly workingMemory: WorkingMemoryStore
  private readonly commanderPaths: ReturnType<typeof resolveCommanderPaths>
  private readonly agentSessions: CommanderAgentSessionTool
  private readonly onSubagentLifecycleEvent?: (event: CommanderSubagentLifecycleEvent) => void
  private readonly lifecycleScope: string

  constructor(
    private readonly commanderId: string,
    basePath?: string,
    options: CommanderManagerOptions = {},
  ) {
    this.handoff = new SubagentHandoff(commanderId, basePath)
    this.workingMemory = new WorkingMemoryStore(commanderId, basePath)
    this.commanderPaths = resolveCommanderPaths(commanderId, basePath)
    this.agentSessions = options.agentSessions ?? new AgentSessionClient()
    this.onSubagentLifecycleEvent = options.onSubagentLifecycleEvent
    this.lifecycleScope = options.lifecycleScope ?? basePath ?? resolveCommanderDataDir()
  }

  /** Initialize the commander — ensure the remaining primitive storage roots exist. */
  async init(options: CommanderInitOptions = {}): Promise<Commander> {
    if (!options.skipScaffold) {
      await withCommanderMutation(this.commanderId, this.lifecycleScope, () => (
        Promise.all([
          mkdir(this.commanderPaths.memoryRoot, { recursive: true }),
          mkdir(this.commanderPaths.skillsRoot, { recursive: true }),
          this.workingMemory.ensure(),
        ])
      ))
    }
    return { id: this.commanderId }
  }

  /**
   * Build and format task-only handoff context for sub-agent system prompt injection.
   * Automatic commander memory packaging has been removed from the harness.
   */
  async buildSubagentSystemContext(task: GHIssue): Promise<string> {
    const pkg = await this.handoff.buildHandoffPackage(task)
    return this.handoff.formatAsSystemContext(pkg)
  }

  /** Process sub-agent completion. */
  async processSubagentCompletion(
    task: GHIssue,
    subagentResult: SubagentResult,
  ): Promise<void> {
    await this.handoff.processCompletion(task, subagentResult)
  }

  /**
   * Create and monitor a Herd sub-agent session with task-only handoff context,
   * then return the completion so the caller can decide what to persist externally.
   */
  async delegateSubagentTask(
    task: GHIssue,
    input: DelegateSubagentTaskInput,
  ): Promise<SubagentResult> {
    const handoffContext = await this.buildSubagentSystemContext(task)
    const createInput: AgentSessionCreateInput = {
      name: input.sessionName,
      task: this.composeSubagentTaskInstruction(input.instruction),
      systemPrompt: handoffContext,
      mode: input.mode,
      transportType: input.sessionType,
      agentType: input.agentType,
      cwd: input.cwd,
      host: input.host,
    }
    const created = await this.agentSessions.createSession(createInput)
    const dispatchedAt = new Date().toISOString()
    this.onSubagentLifecycleEvent?.({
      sessionId: created.sessionId,
      dispatchedAt,
      state: 'running',
    })

    let completion: AgentSessionCompletion
    try {
      completion = await this.agentSessions.monitorSession(
        created.sessionId,
        input.monitorOptions,
      )
    } catch (error) {
      this.onSubagentLifecycleEvent?.({
        sessionId: created.sessionId,
        dispatchedAt,
        state: 'failed',
        result: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    this.onSubagentLifecycleEvent?.({
      sessionId: created.sessionId,
      dispatchedAt,
      state: this.toSubagentState(completion),
      result: completion.finalComment.trim() || completion.status,
    })

    const result: SubagentResult = {
      status: completion.status,
      finalComment: completion.finalComment,
      filesChanged: completion.filesChanged,
      durationMin: completion.durationMin,
      subagentSessionId: created.sessionId,
    }

    await this.processSubagentCompletion(task, result)
    return result
  }

  private toSubagentState(completion: AgentSessionCompletion): CommanderSubagentState {
    return completion.status === 'BLOCKED' ? 'failed' : 'completed'
  }
  private composeSubagentTaskInstruction(instruction: string): string {
    const taskInstruction = instruction.trim()
    return [
      '### Sub-task Instruction',
      taskInstruction.length > 0
        ? taskInstruction
        : '_No sub-task instruction provided._',
    ].join('\n\n')
  }
}
