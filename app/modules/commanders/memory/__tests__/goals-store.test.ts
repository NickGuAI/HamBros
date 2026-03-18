import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JournalWriter } from '../journal.js'
import { GoalsStore, parseGoalsMd, serializeGoalsMd } from '../goals-store.js'
import type { GoalEntry } from '../types.js'

describe('GoalsStore', () => {
  let tmpDir: string
  const commanderId = 'test-commander'

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'goals-store-test-'))
    const journal = new JournalWriter(commanderId, tmpDir)
    await journal.scaffold()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when GOALS.md does not exist', async () => {
    const store = new GoalsStore(commanderId, tmpDir)
    const goals = await store.read()
    expect(goals).toEqual([])
  })

  it('round-trips goals through write and read', async () => {
    const store = new GoalsStore(commanderId, tmpDir)
    const goals: GoalEntry[] = [
      {
        id: 'ship-v2',
        title: 'Ship v2 release',
        targetDate: '2026-03-20',
        currentState: 'Feature freeze, 3 bugs remaining',
        intendedState: 'All bugs fixed, deployed to prod',
        reminders: ['Check CI pipeline', 'Notify QA team'],
      },
      {
        id: 'docs',
        title: 'Update API docs',
        targetDate: '2026-03-25',
        currentState: 'Draft started',
        intendedState: 'Published and reviewed',
        reminders: [],
      },
    ]

    await store.write(goals)
    const read = await store.read()

    expect(read).toHaveLength(2)
    expect(read[0]).toEqual(goals[0])
    expect(read[1]).toEqual(goals[1])
  })

  it('buildContextSection returns null when no goals exist', async () => {
    const store = new GoalsStore(commanderId, tmpDir)
    const section = await store.buildContextSection()
    expect(section).toBeNull()
  })

  it('buildContextSection includes goals and flags overdue ones', async () => {
    const store = new GoalsStore(commanderId, tmpDir)
    await store.write([
      {
        id: 'overdue-goal',
        title: 'Past deadline goal',
        targetDate: '2026-01-01',
        currentState: 'Not started',
        intendedState: 'Done',
        reminders: ['Escalate'],
      },
      {
        id: 'future-goal',
        title: 'Future goal',
        targetDate: '2099-12-31',
        currentState: 'In progress',
        intendedState: 'Complete',
        reminders: [],
      },
    ])

    const section = await store.buildContextSection('2026-03-17')
    expect(section).not.toBeNull()
    expect(section).toContain('### Active Goals')
    expect(section).toContain('⚠️ OVERDUE')
    expect(section).toContain('Past deadline goal')
    expect(section).not.toContain('⚠️ OVERDUE — **Future goal**')
    expect(section).toContain('**Future goal**')
    expect(section).toContain('Escalate')
  })
})

describe('parseGoalsMd', () => {
  it('parses well-formed GOALS.md content', () => {
    const content = `# Active Goals

## [alpha] Alpha Release
- **Target:** 2026-04-01
- **Current state:** Development in progress
- **Intended state:** Deployed and stable
- **Reminders:**
  - Run load tests
  - Update changelog

## [beta] Beta Docs
- **Target:** 2026-05-01
- **Current state:** Outline only
- **Intended state:** Full draft
`

    const goals = parseGoalsMd(content)
    expect(goals).toHaveLength(2)
    expect(goals[0].id).toBe('alpha')
    expect(goals[0].title).toBe('Alpha Release')
    expect(goals[0].targetDate).toBe('2026-04-01')
    expect(goals[0].currentState).toBe('Development in progress')
    expect(goals[0].intendedState).toBe('Deployed and stable')
    expect(goals[0].reminders).toEqual(['Run load tests', 'Update changelog'])
    expect(goals[1].id).toBe('beta')
    expect(goals[1].reminders).toEqual([])
  })

  it('returns empty array for empty content', () => {
    expect(parseGoalsMd('')).toEqual([])
    expect(parseGoalsMd('# Active Goals\n\n')).toEqual([])
  })
})

describe('serializeGoalsMd', () => {
  it('produces valid markdown', () => {
    const goals: GoalEntry[] = [
      {
        id: 'test',
        title: 'Test Goal',
        targetDate: '2026-06-01',
        currentState: 'Started',
        intendedState: 'Finished',
        reminders: ['Check daily'],
      },
    ]

    const md = serializeGoalsMd(goals)
    expect(md).toContain('# Active Goals')
    expect(md).toContain('## [test] Test Goal')
    expect(md).toContain('- **Target:** 2026-06-01')
    expect(md).toContain('- **Current state:** Started')
    expect(md).toContain('- **Intended state:** Finished')
    expect(md).toContain('  - Check daily')
  })
})
