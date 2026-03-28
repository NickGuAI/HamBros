import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  ResolvedWorkspace,
  WorkspaceGitLog,
  WorkspaceGitStatus,
  WorkspaceGitStatusEntry,
} from './types.js'

const execFileAsync = promisify(execFile)

export interface WorkspaceCommandRunner {
  exec(command: string, args: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }>
}

export function defaultWorkspaceCommandRunner(): WorkspaceCommandRunner {
  return {
    exec: (command, args, options) => execFileAsync(command, args, { cwd: options?.cwd }),
  }
}

function parseAheadBehind(branchLine: string): { branch: string | null; ahead: number; behind: number } {
  const trimmed = branchLine.trim().replace(/^##\s+/, '')
  if (!trimmed) {
    return { branch: null, ahead: 0, behind: 0 }
  }

  const [branchPart, trackingPart] = trimmed.split('...', 2)
  const branch = branchPart?.trim() || null
  const trackingMatch = trackingPart?.match(/\[(.*)\]/)
  const trackingState = trackingMatch?.[1] ?? ''
  const aheadMatch = trackingState.match(/ahead (\d+)/)
  const behindMatch = trackingState.match(/behind (\d+)/)

  return {
    branch,
    ahead: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch ? Number.parseInt(behindMatch[1], 10) : 0,
  }
}

function parseGitStatusEntries(lines: string[]): WorkspaceGitStatusEntry[] {
  const entries: WorkspaceGitStatusEntry[] = []
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }

    const code = line.slice(0, 2)
    const filePath = line.slice(3).trim()
    if (!filePath) {
      continue
    }

    entries.push({
      code,
      path: filePath,
    })
  }
  return entries
}

export async function detectWorkspaceGitRoot(
  cwd: string,
  runner: WorkspaceCommandRunner = defaultWorkspaceCommandRunner(),
): Promise<string | null> {
  try {
    const { stdout } = await runner.exec('git', ['rev-parse', '--show-toplevel'], { cwd })
    const gitRoot = stdout.trim()
    return gitRoot || null
  } catch {
    return null
  }
}

function toDisabledStatus(workspace: ResolvedWorkspace): WorkspaceGitStatus {
  return {
    workspace,
    enabled: false,
    branch: null,
    ahead: 0,
    behind: 0,
    entries: [],
  }
}

function toDisabledLog(workspace: ResolvedWorkspace): WorkspaceGitLog {
  return {
    workspace,
    enabled: false,
    commits: [],
  }
}

export async function readWorkspaceGitStatus(
  workspace: ResolvedWorkspace,
  runner: WorkspaceCommandRunner = defaultWorkspaceCommandRunner(),
): Promise<WorkspaceGitStatus> {
  const gitRoot = workspace.gitRoot ?? await detectWorkspaceGitRoot(workspace.rootPath, runner)
  if (!gitRoot) {
    return toDisabledStatus(workspace)
  }

  const { stdout } = await runner.exec(
    'git',
    ['status', '--short', '--branch', '--untracked-files=all'],
    { cwd: gitRoot },
  )

  const lines = stdout.split('\n')
  const branchInfo = parseAheadBehind(lines[0] ?? '')
  const entries = parseGitStatusEntries(lines.slice(1))

  return {
    workspace: {
      ...workspace,
      gitRoot,
    },
    enabled: true,
    branch: branchInfo.branch,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    entries,
  }
}

export async function readWorkspaceGitLog(
  workspace: ResolvedWorkspace,
  limit = 15,
  runner: WorkspaceCommandRunner = defaultWorkspaceCommandRunner(),
): Promise<WorkspaceGitLog> {
  const gitRoot = workspace.gitRoot ?? await detectWorkspaceGitRoot(workspace.rootPath, runner)
  if (!gitRoot) {
    return toDisabledLog(workspace)
  }

  const { stdout } = await runner.exec(
    'git',
    [
      'log',
      `-n${Math.max(1, Math.min(limit, 50))}`,
      '--date=iso-strict',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s',
    ],
    { cwd: gitRoot },
  )

  const commits = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, authoredAt, subject] = line.split('\x1f')
      return {
        hash,
        shortHash,
        author,
        authoredAt,
        subject,
      }
    })

  return {
    workspace: {
      ...workspace,
      gitRoot,
    },
    enabled: true,
    commits,
  }
}

export async function initWorkspaceGit(
  workspace: ResolvedWorkspace,
  runner: WorkspaceCommandRunner = defaultWorkspaceCommandRunner(),
): Promise<string> {
  const { stdout } = await runner.exec('git', ['init'], { cwd: workspace.rootPath })
  return stdout.trim()
}
