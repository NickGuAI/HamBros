import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorkspaceFilePreview } from '../files'
import { readWorkspaceGitLog, readWorkspaceGitStatus } from '../git'
import { resolveWorkspaceRoot, WorkspaceError } from '../resolver'
import { listWorkspaceTree } from '../tree'

let tmpDir: string

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim()
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-service-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('workspace service', () => {
  it('rejects remote workspace roots', async () => {
    await expect(() =>
      resolveWorkspaceRoot({
        rootPath: tmpDir,
        source: {
          kind: 'agent-session',
          id: 'remote-agent',
          label: 'remote-agent',
          host: 'remote-box',
        },
      }),
    ).rejects.toMatchObject<Partial<WorkspaceError>>({
      statusCode: 501,
      message: 'Remote workspace browsing is not supported yet',
    })
  })

  it('lists a lazy tree while hiding ignored directories', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'))
    await fs.mkdir(path.join(tmpDir, 'node_modules'))
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules\n', 'utf8')
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8')

    const workspace = await resolveWorkspaceRoot({
      rootPath: tmpDir,
      source: {
        kind: 'agent-session',
        id: 'local-agent',
        label: 'local-agent',
      },
    })
    const tree = await listWorkspaceTree(workspace)

    expect(tree.nodes.map((node) => node.name)).toEqual([
      'src',
      '.gitignore',
      'README.md',
    ])
  })

  it('returns text and binary previews', async () => {
    await fs.writeFile(path.join(tmpDir, 'notes.md'), '# hello\n', 'utf8')
    await fs.writeFile(path.join(tmpDir, 'data.bin'), Buffer.from([0, 1, 2, 3]))

    const workspace = await resolveWorkspaceRoot({
      rootPath: tmpDir,
      source: {
        kind: 'agent-session',
        id: 'preview-agent',
        label: 'preview-agent',
      },
    })

    const textPreview = await readWorkspaceFilePreview(workspace, 'notes.md')
    expect(textPreview.kind).toBe('text')
    expect(textPreview.content).toContain('# hello')

    const binaryPreview = await readWorkspaceFilePreview(workspace, 'data.bin')
    expect(binaryPreview.kind).toBe('binary')
    expect(binaryPreview.content).toBeUndefined()
  })

  it('reads git status and log for repo-backed workspaces', async () => {
    git(['init'], tmpDir)
    git(['config', 'user.email', 'assistant@example.com'], tmpDir)
    git(['config', 'user.name', 'Assistant'], tmpDir)
    await fs.writeFile(path.join(tmpDir, 'tracked.txt'), 'hello\n', 'utf8')
    git(['add', 'tracked.txt'], tmpDir)
    git(['commit', '-m', 'initial commit'], tmpDir)
    await fs.writeFile(path.join(tmpDir, 'tracked.txt'), 'hello\nworld\n', 'utf8')
    await fs.writeFile(path.join(tmpDir, 'new-file.txt'), 'new\n', 'utf8')

    const workspace = await resolveWorkspaceRoot({
      rootPath: tmpDir,
      source: {
        kind: 'factory-worktree',
        id: 'org/repo/feature-x',
        label: 'org/repo:feature-x',
      },
    })

    const status = await readWorkspaceGitStatus(workspace)
    expect(status.enabled).toBe(true)
    expect(status.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['tracked.txt', 'new-file.txt']),
    )

    const log = await readWorkspaceGitLog(workspace)
    expect(log.enabled).toBe(true)
    expect(log.commits[0]?.subject).toBe('initial commit')
  })
})
