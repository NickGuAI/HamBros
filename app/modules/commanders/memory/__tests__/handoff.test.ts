import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SubagentHandoff,
  type GHIssue,
  type HandoffPackage,
  type SubagentResult,
} from '../handoff.js'
import type { JournalWriter } from '../journal.js'

describe('SubagentHandoff.buildHandoffPackage()', () => {
  let tmpDir: string
  let handoff: SubagentHandoff

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'subagent-handoff-test-'))
    handoff = new SubagentHandoff('test-commander', tmpDir)

    const memoryRoot = join(tmpDir, 'test-commander', '.memory')
    await mkdir(join(memoryRoot, 'repos'), { recursive: true })
    await mkdir(join(memoryRoot, 'skills', 'auth-fix'), { recursive: true })
    await mkdir(join(memoryRoot, 'skills', 'unrelated-skill'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('assembles task context, repo knowledge, skills, and memory excerpts', async () => {
    const memoryRoot = join(tmpDir, 'test-commander', '.memory')
    await writeFile(
      join(memoryRoot, 'repos', 'example-user_example-repo.md'),
      '# Repo Notes\n\nUse pnpm --filter for package-scoped checks.\n',
      'utf-8',
    )
    await writeFile(
      join(memoryRoot, 'skills', 'auth-fix', 'SKILL.md'),
      '# Auth Fix\n\nUse this when fixing auth token refresh issues.\n',
      'utf-8',
    )
    await writeFile(
      join(memoryRoot, 'skills', 'unrelated-skill', 'SKILL.md'),
      '# Deployment\n\nUse this for deployment cutovers.\n',
      'utf-8',
    )
    await writeFile(
      join(memoryRoot, 'MEMORY.md'),
      [
        '# Commander Standing Orders',
        '- Always keep changes surgical.',
        '',
        '## Repo Notes',
        '- example-user/example-repo uses pnpm workspaces.',
        '- auth token refresh touched middleware last month.',
        '- random note from another repo.',
        '',
        '## Other',
        '- unrelated content.',
      ].join('\n'),
      'utf-8',
    )

    const task: GHIssue = {
      number: 247,
      title: 'Fix auth token refresh regression',
      body: 'Sub-agent should patch the failing refresh flow and add tests.',
      repo: 'example-user/example-repo',
      comments: [
        'First comment to ignore',
        { author: 'reviewer', body: 'Please include regression tests' },
        'Watch for middleware side effects',
        'Last comment should be included',
      ],
    }

    const pkg = await handoff.buildHandoffPackage(task)

    expect(pkg.sourceCommanderId).toBe('test-commander')
    expect(pkg.taskContext).toContain('**Issue #247**: Fix auth token refresh regression')
    expect(pkg.taskContext).toContain('reviewer: Please include regression tests')
    expect(pkg.taskContext).toContain('Watch for middleware side effects')
    expect(pkg.taskContext).toContain('Last comment should be included')
    expect(pkg.taskContext).not.toContain('First comment to ignore')
    expect(pkg.repoKnowledge).toContain('Use pnpm --filter for package-scoped checks.')
    expect(pkg.matchedSkills).toHaveLength(1)
    expect(pkg.matchedSkills[0].name).toBe('auth-fix')
    expect(pkg.memoryExcerpts).toContain('# Commander Standing Orders')
    expect(pkg.memoryExcerpts).toContain('example-user/example-repo uses pnpm workspaces.')
    expect(pkg.memoryExcerpts).toContain('auth token refresh touched middleware last month.')
  })

  it('limits memory excerpts to 50 lines', async () => {
    const memoryRoot = join(tmpDir, 'test-commander', '.memory')
    const extraLines = Array.from({ length: 80 }, (_, i) => `- example-repo auth line ${i}`)
    await writeFile(
      join(memoryRoot, 'MEMORY.md'),
      ['# Commander Standing Orders', '- Keep updates concise.', '', '## Repo Notes', ...extraLines].join(
        '\n',
      ),
      'utf-8',
    )

    const task: GHIssue = {
      number: 300,
      title: 'Fix auth token bug in example-repo',
      body: 'Need memory filtering max line check.',
      repoOwner: 'example-user',
      repoName: 'example-repo',
    }

    const pkg = await handoff.buildHandoffPackage(task)
    const lineCount = pkg.memoryExcerpts.split('\n').length
    expect(lineCount).toBeLessThanOrEqual(50)
    expect(pkg.memoryExcerpts).toContain('# Commander Standing Orders')
  })
})

describe('SubagentHandoff.formatAsSystemContext()', () => {
  it('formats markdown sections for sub-agent injection', () => {
    const handoff = new SubagentHandoff('test-commander')
    const pkg: HandoffPackage = {
      taskContext: '**Issue #10**: Fix parser\nIssue body',
      repoKnowledge: 'Repo cache body',
      matchedSkills: [{ name: 'parser-skill', fullContent: '# Parser Skill\n\nSteps...' }],
      memoryExcerpts: '# Memory\n- excerpt',
      sourceCommanderId: 'test-commander',
    }

    const formatted = handoff.formatAsSystemContext(pkg)
    expect(formatted).toContain('## Handoff from Commander test-commander')
    expect(formatted).toContain('### Task')
    expect(formatted).toContain('### What I Know About This Repo')
    expect(formatted).toContain('### Applicable Skills')
    expect(formatted).toContain('#### parser-skill')
    expect(formatted).toContain('### Relevant Memory')
    expect(formatted).toContain('### Standing Instructions')
    expect(formatted).toContain('Tag your final status: SUCCESS | PARTIAL | BLOCKED')
  })
})

describe('SubagentHandoff.processCompletion()', () => {
  const task: GHIssue = {
    number: 501,
    title: 'Investigate telemetry gap',
    body: 'Need a focused sub-agent pass.',
    repo: 'example-user/example-repo',
  }

  const makeResult = (overrides: Partial<SubagentResult> = {}): SubagentResult => ({
    status: 'SUCCESS',
    finalComment: 'Completed as expected',
    filesChanged: 2,
    durationMin: 11,
    subagentSessionId: 'sess-abc',
    ...overrides,
  })

  it('writes ROUTINE salience for standard SUCCESS outcome', async () => {
    const handoff = new SubagentHandoff('test-commander')
    const journal = { append: vi.fn(async () => {}) } as unknown as JournalWriter

    await handoff.processCompletion(task, makeResult(), journal)

    expect(journal.append).toHaveBeenCalledTimes(1)
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 501,
        repo: 'example-user/example-repo',
        salience: 'ROUTINE',
      }),
    )
  })

  it('writes NOTABLE salience for PARTIAL outcome', async () => {
    const handoff = new SubagentHandoff('test-commander')
    const journal = { append: vi.fn(async () => {}) } as unknown as JournalWriter

    await handoff.processCompletion(task, makeResult({ status: 'PARTIAL' }), journal)

    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({ salience: 'NOTABLE' }))
  })

  it('upgrades to SPIKE when final comment contains spike trigger', async () => {
    const handoff = new SubagentHandoff('test-commander')
    const journal = { append: vi.fn(async () => {}) } as unknown as JournalWriter

    await handoff.processCompletion(
      task,
      makeResult({ finalComment: 'Found an unexpected race condition in prod path.' }),
      journal,
    )

    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({ salience: 'SPIKE' }))
  })

  it('upgrades to SPIKE when manual help was needed', async () => {
    const handoff = new SubagentHandoff('test-commander')
    const journal = { append: vi.fn(async () => {}) } as unknown as JournalWriter

    await handoff.processCompletion(
      task,
      makeResult({ finalComment: 'Fix required manual intervention from maintainer.' }),
      journal,
    )

    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({ salience: 'SPIKE' }))
  })
})
