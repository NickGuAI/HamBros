import {
  JournalWriter,
  SubagentHandoff,
  type EmergencyFlusher,
  type FlushContext,
  type SubagentResult,
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
} from './tools/agent-session.js'
import { AgentSessionClient } from './tools/agent-session.js'

export interface Commander {
  id: string
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

export interface CommanderManagerOptions {
  agentSessions?: CommanderAgentSessionTool
}

/**
 * CommanderManager owns the lifecycle of a Commander's on-disk state.
 * Calling `init()` ensures the `.memory/` directory scaffold exists before
 * any memory operations are attempted.
 */
export class CommanderManager {
  private readonly journal: JournalWriter
  private readonly handoff: SubagentHandoff
  private readonly agentSessions: CommanderAgentSessionTool

  constructor(
    private readonly commanderId: string,
    basePath?: string,
    options: CommanderManagerOptions = {},
  ) {
    this.journal = new JournalWriter(commanderId, basePath)
    this.handoff = new SubagentHandoff(commanderId, basePath)
    this.agentSessions = options.agentSessions ?? new AgentSessionClient()
  }

  /** Initialize the commander — ensures `.memory/` scaffold exists. */
  async init(): Promise<Commander> {
    await this.journal.scaffold()
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
  }

  /**
   * Create and monitor a Hammurabi sub-agent session with memory handoff context,
   * then persist the read-back into the commander's journal.
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
      sessionType: input.sessionType,
      agentType: input.agentType,
      cwd: input.cwd,
      host: input.host,
    }
    const created = await this.agentSessions.createSession(createInput)
    const completion = await this.agentSessions.monitorSession(
      created.sessionId,
      input.monitorOptions,
    )

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
}
