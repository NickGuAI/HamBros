import {
  JournalWriter,
  SubagentHandoff,
  type EmergencyFlusher,
  type FlushContext,
  type SubagentResult,
} from './memory/index.js'
import type { GHIssue } from './memory/handoff.js'
import { WorkingMemory } from './memory/working-memory.js'
import type {
  AgentSessionCompletion,
  AgentSessionCreateInput,
  AgentSessionKind,
  AgentSessionMonitorOptions,
  AgentSessionTransportMode,
  AgentType,
  CreatedAgentSession,
} from './tools/agent-session.js'
import { AgentSessionClient } from './tools/agent-session.js'

export interface Commander {
  id: string
}

export interface CommanderInitOptions {
  skipScaffold?: boolean
}

export interface ContextPressureAgentSdk {
  onContextPressure(handler: () => Promise<void> | void): void
}

export type FlushContextBuilder = () => Omit<FlushContext, 'trigger'>

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
}

/**
 * CommanderManager owns the lifecycle of a Commander's on-disk state.
 * Calling `init()` ensures the `.memory/` directory scaffold exists before
 * any memory operations are attempted.
 */
export class CommanderManager {
  private readonly journal: JournalWriter
  private readonly handoff: SubagentHandoff
  private readonly workingMemory: WorkingMemory
  private readonly agentSessions: CommanderAgentSessionTool
  private readonly onSubagentLifecycleEvent?: (event: CommanderSubagentLifecycleEvent) => void

  constructor(
    private readonly commanderId: string,
    basePath?: string,
    options: CommanderManagerOptions = {},
  ) {
    this.journal = new JournalWriter(commanderId, basePath)
    this.handoff = new SubagentHandoff(commanderId, basePath)
    this.workingMemory = new WorkingMemory(commanderId, basePath)
    this.agentSessions = options.agentSessions ?? new AgentSessionClient()
    this.onSubagentLifecycleEvent = options.onSubagentLifecycleEvent
  }

  /** Initialize the commander — ensures `.memory/` scaffold exists. */
  async init(options: CommanderInitOptions = {}): Promise<Commander> {
    if (!options.skipScaffold) {
      await this.journal.scaffold()
    }
    await this.safeAppendWorkingMemory(`Commander session initialized for ${this.commanderId}.`)
    return { id: this.commanderId }
  }

  /** Expose the journal writer for memory operations. */
  get journalWriter(): JournalWriter {
    return this.journal
  }

  /**
   * Build and format Commander memory for sub-agent system context injection.
   * The caller should pass the returned markdown into the sub-agent session API.
   */
  async buildSubagentSystemContext(task: GHIssue): Promise<string> {
    const pkg = await this.handoff.buildHandoffPackage(task)
    return this.handoff.formatAsSystemContext(pkg)
  }

  /** Process sub-agent completion and persist a salience-tagged journal entry. */
  async processSubagentCompletion(
    task: GHIssue,
    subagentResult: SubagentResult,
  ): Promise<void> {
    await this.handoff.processCompletion(task, subagentResult, this.journal)
    const notable = this.compact(subagentResult.finalComment).slice(0, 180)
    await this.safeAppendWorkingMemory([
      `Task completion: ${this.describeTask(task)} → ${subagentResult.status}.`,
      notable ? `Notable observation: ${notable}.` : '',
    ].filter((line) => line.length > 0).join(' '))
  }

  /**
   * Create and monitor a Hammurabi sub-agent session with memory handoff context,
   * then persist the read-back into the commander's journal.
   */
  async delegateSubagentTask(
    task: GHIssue,
    input: DelegateSubagentTaskInput,
  ): Promise<SubagentResult> {
    await this.safeAppendWorkingMemory(
      `Task start: ${this.describeTask(task)}. ${this.compact(input.instruction).slice(0, 180)}`,
    )
    const handoffContext = await this.buildSubagentSystemContext(task)
    const createInput: AgentSessionCreateInput = {
      name: input.sessionName,
      task: this.composeSubagentTaskInstruction(input.instruction),
      systemPrompt: handoffContext,
      mode: input.mode,
      sessionType: input.sessionType,
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

  /**
   * Hook A: register emergency pre-compaction flush when the SDK reports context pressure.
   */
  wirePreCompactionFlush(
    agentSdk: ContextPressureAgentSdk,
    flusher: EmergencyFlusher,
    buildFlushContext: FlushContextBuilder,
  ): void {
    agentSdk.onContextPressure(async () => {
      await flusher.preCompactionFlush({
        ...buildFlushContext(),
        trigger: 'pre-compaction',
      })
    })
  }

  /**
   * Hook B: persist between-task state before requesting the next task.
   */
  async flushBetweenTasksAndPickNext(
    flusher: EmergencyFlusher,
    buildFlushContext: FlushContextBuilder,
    pickUpNextTask: () => Promise<void>,
  ): Promise<void> {
    await this.safeAppendWorkingMemory(
      'Quest transition: flushing between tasks and requesting next task.',
    )
    await flusher.betweenTaskFlush({
      ...buildFlushContext(),
      trigger: 'between-task',
    })
    await pickUpNextTask()
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

  private describeTask(task: GHIssue): string {
    const repo = task.repo ?? (task.repoOwner && task.repoName ? `${task.repoOwner}/${task.repoName}` : null)
    return `issue #${task.number}${repo ? ` (${repo})` : ''} "${this.compact(task.title)}"`
  }

  private compact(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
  }

  private async safeAppendWorkingMemory(note: string): Promise<void> {
    try {
      await this.workingMemory.append(note)
    } catch {
      // Working memory failures should not block commander execution paths.
    }
  }
}
