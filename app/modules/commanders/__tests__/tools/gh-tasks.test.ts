import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GhTasks, type GhCommandRunner } from '../../tools/gh-tasks.js'

describe('GhTasks', () => {
  let exec: ReturnType<typeof vi.fn>
  let runner: GhCommandRunner
  let tasks: GhTasks

  beforeEach(() => {
    exec = vi.fn()
    runner = {
      exec,
    }
    tasks = new GhTasks({
      repo: 'example-user/example-repo',
      label: 'commander',
      runner,
    })
  })

  it('lists assigned tasks with deterministic ordering', async () => {
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 203,
          title: 'Third issue',
          body: 'later',
          labels: [{ name: 'commander' }],
          assignees: [{ login: 'octocat' }],
          url: 'https://github.com/example-user/example-repo/issues/203',
        },
        {
          number: 167,
          title: 'First issue',
          body: 'earlier',
          labels: [{ name: 'commander' }],
          assignees: [{ login: 'octocat' }],
          url: 'https://github.com/example-user/example-repo/issues/167',
        },
      ]),
      stderr: '',
    })

    const issues = await tasks.listAssignedTasks()

    expect(exec).toHaveBeenCalledWith('gh', [
      'issue',
      'list',
      '--repo',
      'example-user/example-repo',
      '--state',
      'open',
      '--label',
      'commander',
      '--json',
      'number,title,body,labels,assignees,url',
      '--assignee',
      '@me',
    ])
    expect(issues.map((issue) => issue.number)).toEqual([167, 203])
  })

  it('auto-discovers the lowest-numbered unassigned task', async () => {
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 220,
          title: 'Already assigned',
          body: '',
          labels: [{ name: 'commander' }],
          assignees: [{ login: 'octocat' }],
          url: 'https://github.com/example-user/example-repo/issues/220',
        },
        {
          number: 201,
          title: 'Unassigned candidate',
          body: '',
          labels: [{ name: 'commander' }],
          assignees: [],
          url: 'https://github.com/example-user/example-repo/issues/201',
        },
        {
          number: 199,
          title: 'Best candidate',
          body: '',
          labels: [{ name: 'commander' }],
          assignees: [],
          url: 'https://github.com/example-user/example-repo/issues/199',
        },
      ]),
      stderr: '',
    })

    const issue = await tasks.discoverNextUnassignedTask()

    expect(issue?.number).toBe(199)
    expect(issue?.title).toBe('Best candidate')
  })

  it('reads full issue context with comments', async () => {
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 167,
        title: 'Commander orchestration',
        body: 'Implement orchestration capabilities.',
        labels: [{ name: 'commander' }, { name: 'phase-5' }],
        assignees: [{ login: 'octocat' }],
        comments: [
          { body: 'Please include tests', author: { login: 'nick' } },
          { body: 'Remember to update manager wiring', author: { login: 'reviewer' } },
        ],
        url: 'https://github.com/example-user/example-repo/issues/167',
      }),
      stderr: '',
    })

    const issue = await tasks.readTask(167)

    expect(exec).toHaveBeenCalledWith('gh', [
      'issue',
      'view',
      '167',
      '--repo',
      'example-user/example-repo',
      '--json',
      'number,title,body,labels,assignees,comments,url',
    ])
    expect(issue.labels).toEqual(['commander', 'phase-5'])
    expect(issue.comments).toEqual([
      { body: 'Please include tests', author: 'nick' },
      { body: 'Remember to update manager wiring', author: 'reviewer' },
    ])
  })

  it('posts lifecycle comments and closes tasks', async () => {
    exec.mockResolvedValue({
      stdout: '',
      stderr: '',
    })

    await tasks.startTask(167, 'Starting issue #167.')
    await tasks.completeTask(167, 'Completed issue #167.')

    expect(exec).toHaveBeenNthCalledWith(1, 'gh', [
      'issue',
      'edit',
      '167',
      '--repo',
      'example-user/example-repo',
      '--add-assignee',
      '@me',
    ])
    expect(exec).toHaveBeenNthCalledWith(2, 'gh', [
      'issue',
      'comment',
      '167',
      '--repo',
      'example-user/example-repo',
      '--body',
      'Starting issue #167.',
    ])
    expect(exec).toHaveBeenNthCalledWith(3, 'gh', [
      'issue',
      'comment',
      '167',
      '--repo',
      'example-user/example-repo',
      '--body',
      'Completed issue #167.',
    ])
    expect(exec).toHaveBeenNthCalledWith(4, 'gh', [
      'issue',
      'close',
      '167',
      '--repo',
      'example-user/example-repo',
    ])
  })
})
