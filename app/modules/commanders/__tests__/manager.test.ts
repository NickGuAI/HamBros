import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommanderManager } from '../manager.js'
import type { EmergencyFlusher, FlushContext, SubagentResult } from '../memory/index.js'
import type { GHIssue } from '../memory/handoff.js'

describe('CommanderManager.init()', () => {
  let tmpDir: string
  let manager: CommanderManager

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-manager-test-'))
    manager = new CommanderManager('test-cmdr', tmpDir)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns a Commander with the correct id', async () => {
    const commander = await manager.init()
    expect(commander.id).toBe('test-cmdr')
  })

  it('creates the .memory/ scaffold on init', async () => {
    await manager.init()
    const check = (rel: string) => stat(join(tmpDir, 'test-cmdr', '.memory', rel))
    await expect(check('.')).resolves.toBeTruthy()
    await expect(check('journal')).resolves.toBeTruthy()
    await expect(check('MEMORY.md')).resolves.toBeTruthy()
  })

  it('exposes journalWriter after init', async () => {
    await manager.init()
    expect(manager.journalWriter).toBeDefined()
  })

  it('builds formatted subagent system context', async () => {
    await manager.init()
    await writeFile(
      join(tmpDir, 'test-cmdr', '.memory', 'MEMORY.md'),
      [
        '# Commander Standing Orders',
        '- Keep diffs surgical.',
        '',
        '## Repo Notes',
        '- example-repo uses pnpm workspaces.',
      ].join('\n'),
      'utf-8',
    )
    const skillDir = join(tmpDir, 'test-cmdr', 'skills', 'lint-fix')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '# Lint Fix Skill\n\nUse this when fixing lint regressions.\n',
      'utf-8',
    )

    const task: GHIssue = {
      number: 167,
      title: 'Fix lint regression in example-repo',
      body: 'Need to resolve eslint issues in commander memory modules.',
      repo: 'example-user/example-repo',
      comments: ['Please include tests', 'Verify with package lint'],
    }
    const context = await manager.buildSubagentSystemContext(task)

    expect(context).toContain('## Handoff from Commander test-cmdr')
    expect(context).toContain('**Issue #167**: Fix lint regression in example-repo')
    expect(context).toContain('### Suggested Skills (manual invoke only)')
    expect(context).toContain('**lint-fix**')
    expect(context).toContain('### Relevant Memory Recollection')
  })

  it('writes completion read-back through manager API', async () => {
    await manager.init()
    const task: GHIssue = {
      number: 168,
      title: 'Patch websocket reconnect',
      body: 'Investigate intermittent reconnect failures.',
      repo: 'example-user/example-repo',
    }
    const result: SubagentResult = {
      status: 'SUCCESS',
      finalComment: 'Found an unexpected race condition in reconnect path.',
      filesChanged: 3,
      durationMin: 14,
      subagentSessionId: 'sess-123',
    }

    await manager.processSubagentCompletion(task, result)
    const recent = await manager.journalWriter.readRecent()
    const entry = recent.find((e) => e.issueNumber === 168)

    expect(entry).toBeDefined()
    expect(entry?.salience).toBe('SPIKE')
    expect(entry?.outcome).toBe('Sub-agent completion: SUCCESS')
  })

  it('delegates a sub-task through session tool with memory handoff and read-back', async () => {
    const createSession = vi.fn(async () => ({
      sessionId: 'sess-subagent-167',
      raw: { created: true },
    }))
    const monitorSession = vi.fn(async () => ({
      sessionId: 'sess-subagent-167',
      status: 'SUCCESS' as const,
      finalComment: 'Implemented requested orchestration updates.',
      filesChanged: 4,
      durationMin: 18,
      raw: { done: true },
    }))
    manager = new CommanderManager('test-cmdr', tmpDir, {
      agentSessions: {
        createSession,
        monitorSession,
      },
    })
    await manager.init()

    const task: GHIssue = {
      number: 167,
      title: 'Commander: agent orchestration capabilities',
      body: 'Wire sub-agent execution from Commander manager.',
      repo: 'example-user/example-repo',
      comments: ['Include memory handoff context.'],
    }

    const result = await manager.delegateSubagentTask(task, {
      sessionName: 'subagent-167',
      instruction: 'Implement issue #167 and report learnings.',
    })

    expect(createSession).toHaveBeenCalledTimes(1)
    const createInput = createSession.mock.calls[0]?.[0]
    expect(createInput).toMatchObject({
      name: 'subagent-167',
    })
    expect(createInput.systemPrompt).toContain('## Handoff from Commander test-cmdr')
    expect(createInput.task).toContain('### Sub-task Instruction')
    expect(createInput.task).toContain('Implement issue #167 and report learnings.')

    expect(monitorSession).toHaveBeenCalledWith('sess-subagent-167', undefined)
    expect(result).toMatchObject({
      status: 'SUCCESS',
      subagentSessionId: 'sess-subagent-167',
      filesChanged: 4,
      durationMin: 18,
    })

    const recent = await manager.journalWriter.readRecent()
    const entry = recent.find((journalEntry) => journalEntry.issueNumber === 167)
    expect(entry).toBeDefined()
    expect(entry?.outcome).toBe('Sub-agent completion: SUCCESS')
    expect(entry?.body).toContain('sess-subagent-167')

    const workingMemory = await readFile(
      join(tmpDir, 'test-cmdr', '.memory', 'working-memory.md'),
      'utf-8',
    )
    expect(workingMemory).toContain('Task start: issue #167')
    expect(workingMemory).toContain('Task completion: issue #167')
  })

  it('wires pre-compaction flush to Agent SDK context pressure hook', async () => {
    await manager.init()

    let pressureHandler: (() => Promise<void> | void) | null = null
    const agentSdk = {
      onContextPressure: vi.fn((handler: () => Promise<void> | void) => {
        pressureHandler = handler
      }),
    }
    const flusher = {
      preCompactionFlush: vi.fn(async () => {}),
      betweenTaskFlush: vi.fn(async () => {}),
    }
    const buildFlushContext = () =>
      ({
        currentIssue: {
          number: 167,
          repo: 'example-user/example-repo',
          url: 'https://github.com/example-user/example-repo/issues/167',
          title: 'Emergency flush test',
        },
        taskState: 'Investigating memory flush hook',
        pendingSpikeObservations: ['Race condition observed during context compaction.'],
      }) satisfies Omit<FlushContext, 'trigger'>

    manager.wirePreCompactionFlush(
      agentSdk,
      flusher as unknown as EmergencyFlusher,
      buildFlushContext,
    )
    expect(agentSdk.onContextPressure).toHaveBeenCalledTimes(1)
    if (!pressureHandler) throw new Error('expected context pressure handler to be registered')

    await pressureHandler()
    expect(flusher.preCompactionFlush).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'pre-compaction',
        taskState: 'Investigating memory flush hook',
      }),
    )
  })

  it('flushes between tasks before calling next-task pickup', async () => {
    await manager.init()

    const callOrder: string[] = []
    const flusher = {
      preCompactionFlush: vi.fn(async () => {}),
      betweenTaskFlush: vi.fn(async () => {
        callOrder.push('flush')
      }),
    }
    const pickUpNextTask = vi.fn(async () => {
      callOrder.push('next-task')
    })
    const buildFlushContext = () =>
      ({
        currentIssue: {
          number: 168,
          repo: 'example-user/example-repo',
          url: 'https://github.com/example-user/example-repo/issues/168',
          title: 'Task completion flush test',
        },
        taskState: 'Completed issue and waiting for next assignment',
        pendingSpikeObservations: [],
      }) satisfies Omit<FlushContext, 'trigger'>

    await manager.flushBetweenTasksAndPickNext(
      flusher as unknown as EmergencyFlusher,
      buildFlushContext,
      pickUpNextTask,
    )

    expect(flusher.betweenTaskFlush).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'between-task',
      }),
    )
    expect(pickUpNextTask).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['flush', 'next-task'])

    const workingMemory = await readFile(
      join(tmpDir, 'test-cmdr', '.memory', 'working-memory.md'),
      'utf-8',
    )
    expect(workingMemory).toContain('Quest transition: flushing between tasks and requesting next task.')
  })
})
