import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuestStore } from '../quest-store.js'

describe('QuestStore', () => {
  let tmpDir = ''
  let store: QuestStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hammurabi-quest-store-'))
    store = new QuestStore(tmpDir)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates, lists, updates, and deletes quests', async () => {
    const created = await store.create({
      commanderId: 'cmdr-1',
      status: 'pending',
      source: 'manual',
      instruction: 'Investigate issue queue drift',
      contract: {
        cwd: '/tmp/example-repo',
        permissionMode: 'bypassPermissions',
        agentType: 'claude',
        skillsToUse: ['issue-finder'],
      },
    })

    expect(created.id).toBeTruthy()
    expect(created.commanderId).toBe('cmdr-1')
    expect(created.status).toBe('pending')

    const listed = await store.list('cmdr-1')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(created.id)

    const updated = await store.update('cmdr-1', created.id, {
      status: 'done',
      note: 'Implemented and verified with tests',
    })
    expect(updated).not.toBeNull()
    expect(updated?.status).toBe('done')
    expect(updated?.note).toBe('Implemented and verified with tests')

    const noted = await store.appendNote('cmdr-1', created.id, 'Posted handoff in issue thread')
    expect(noted).not.toBeNull()
    expect(noted?.note).toBe('Implemented and verified with tests\nPosted handoff in issue thread')

    const deleted = await store.delete('cmdr-1', created.id)
    expect(deleted).toBe(true)
    expect(await store.list('cmdr-1')).toEqual([])
  })

  it('resets active quests back to pending', async () => {
    const active = await store.create({
      commanderId: 'cmdr-2',
      status: 'active',
      source: 'idea',
      instruction: 'Prototype quest picker',
      contract: {
        cwd: '/tmp/example-repo',
        permissionMode: 'bypassPermissions',
        agentType: 'claude',
        skillsToUse: [],
      },
    })
    await store.create({
      commanderId: 'cmdr-2',
      status: 'done',
      source: 'manual',
      instruction: 'Ship API baseline',
      contract: {
        cwd: '/tmp/example-repo',
        permissionMode: 'bypassPermissions',
        agentType: 'claude',
        skillsToUse: [],
      },
    })

    const changedCount = await store.resetActiveToPending('cmdr-2')
    expect(changedCount).toBe(1)

    const refreshed = await store.get('cmdr-2', active.id)
    expect(refreshed?.status).toBe('pending')
  })

  it('sets completedAt on completion and clears it when reopened', async () => {
    const created = await store.create({
      commanderId: 'cmdr-4',
      status: 'pending',
      source: 'manual',
      instruction: 'Implement commander board grouping',
      contract: {
        cwd: '/tmp/example-repo',
        permissionMode: 'bypassPermissions',
        agentType: 'claude',
        skillsToUse: [],
      },
    })

    expect(created.completedAt).toBeUndefined()

    const completed = await store.update('cmdr-4', created.id, { status: 'done' })
    expect(completed).not.toBeNull()
    expect(completed?.completedAt).toBeTruthy()
    const completedAt = completed?.completedAt
    expect(completedAt).toBeTruthy()

    const reloadedStore = new QuestStore(tmpDir)
    const persistedCompleted = await reloadedStore.get('cmdr-4', created.id)
    expect(persistedCompleted?.completedAt).toBe(completedAt)

    const reopened = await store.update('cmdr-4', created.id, { status: 'pending' })
    expect(reopened).not.toBeNull()
    expect(reopened?.completedAt).toBeUndefined()

    const persistedReopened = await reloadedStore.get('cmdr-4', created.id)
    expect(persistedReopened?.completedAt).toBeUndefined()
  })

  it('persists and updates quest artifacts', async () => {
    const created = await store.create({
      commanderId: 'cmdr-3',
      status: 'pending',
      source: 'manual',
      instruction: 'Link implementation outputs',
      artifacts: [
        {
          type: 'github_issue',
          label: 'Issue #101',
          href: 'https://github.com/example-user/example-repo/issues/101',
        },
        {
          type: 'file',
          label: 'Quest notes',
          href: 'apps/hammurabi/modules/commanders/quest-store.ts',
        },
      ],
      contract: {
        cwd: '/tmp/example-repo',
        permissionMode: 'bypassPermissions',
        agentType: 'claude',
        skillsToUse: [],
      },
    })

    expect(created.artifacts).toEqual([
      {
        type: 'github_issue',
        label: 'Issue #101',
        href: 'https://github.com/example-user/example-repo/issues/101',
      },
      {
        type: 'file',
        label: 'Quest notes',
        href: 'apps/hammurabi/modules/commanders/quest-store.ts',
      },
    ])

    const updated = await store.update('cmdr-3', created.id, {
      artifacts: [
        {
          type: 'github_pr',
          label: 'PR #202',
          href: 'https://github.com/example-user/example-repo/pull/202',
        },
      ],
    })
    expect(updated?.artifacts).toEqual([
      {
        type: 'github_pr',
        label: 'PR #202',
        href: 'https://github.com/example-user/example-repo/pull/202',
      },
    ])

    const cleared = await store.update('cmdr-3', created.id, { artifacts: null })
    expect(cleared?.artifacts).toEqual([])
  })
})
