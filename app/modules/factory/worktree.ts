import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { MachineConfig } from '../agents/routes.js'

const execFileAsync = promisify(execFile)

const FEATURE_NAME_PATTERN = /^[\w-]+$/
const OWNER_REPO_PATTERN = /^[\w.-]+$/

export interface CommandRunner {
  exec(command: string, args: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }>
}

export interface BootstrapFactoryWorktreeInput {
  owner: string
  repo: string
  feature: string
  baseDir?: string
  machine?: MachineConfig
  commandRunner?: CommandRunner
}

export interface BootstrapFactoryWorktreeResult {
  owner: string
  repo: string
  feature: string
  branch: string
  path: string
}

export function defaultCommandRunner(): CommandRunner {
  return {
    exec: (command, args, options) => execFileAsync(command, args, { cwd: options?.cwd }),
  }
}

function isRemoteMachine(machine: MachineConfig | undefined): machine is MachineConfig & { host: string } {
  return typeof machine?.host === 'string' && machine.host.trim().length > 0
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`
}

function buildSshDestination(machine: MachineConfig & { host: string }): string {
  if (machine.user) {
    return `${machine.user}@${machine.host}`
  }
  return machine.host
}

function buildSshArgs(machine: MachineConfig & { host: string }, remoteCommand: string): string[] {
  const args: string[] = []
  if (machine.port) {
    args.push('-p', String(machine.port))
  }
  args.push(buildSshDestination(machine), remoteCommand)
  return args
}

function getExecErrorMessage(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null) {
    return fallback
  }

  const stderr = (error as { stderr?: unknown }).stderr
  if (typeof stderr === 'string' && stderr.trim().length > 0) {
    return stderr.trim()
  }

  const message = (error as { message?: unknown }).message
  if (typeof message === 'string' && message.trim().length > 0) {
    return message.trim()
  }

  return fallback
}

export function parseFeatureName(feature: unknown): string | null {
  if (typeof feature !== 'string') {
    return null
  }

  const trimmed = feature.trim()
  if (!FEATURE_NAME_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

export function parseOwnerRepo(owner: unknown, repo: unknown): { owner: string; repo: string } | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') {
    return null
  }

  if (!OWNER_REPO_PATTERN.test(owner) || !OWNER_REPO_PATTERN.test(repo)) {
    return null
  }

  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return null
  }

  return { owner, repo }
}

async function detectDefaultBranch(runner: CommandRunner, bareGitDir: string): Promise<string> {
  // Bare clones have HEAD pointing to the default branch (refs/heads/main),
  // not refs/remotes/origin/HEAD which only exists in non-bare clones.
  try {
    const { stdout } = await runner.exec('git', ['symbolic-ref', 'HEAD'], { cwd: bareGitDir })
    // Output looks like: refs/heads/main
    const ref = stdout.trim()
    const branch = ref.replace('refs/heads/', '')
    if (branch && branch !== ref) {
      return branch
    }
  } catch {
    // fallback
  }

  return 'main'
}

export async function bootstrapFactoryWorktree(
  input: BootstrapFactoryWorktreeInput,
): Promise<BootstrapFactoryWorktreeResult> {
  const parsedRepo = parseOwnerRepo(input.owner, input.repo)
  if (!parsedRepo) {
    throw new Error('Invalid owner or repo name')
  }

  const feature = parseFeatureName(input.feature)
  if (!feature) {
    throw new Error('Invalid feature name')
  }

  const baseDir = input.baseDir ?? path.join(process.env.HOME || '/tmp', '.factory')
  const runner = input.commandRunner ?? defaultCommandRunner()

  const { owner, repo } = parsedRepo

  if (isRemoteMachine(input.machine)) {
    const remoteBaseDirAssignment = input.baseDir
      ? `base_dir=${shellEscape(input.baseDir)}`
      : 'base_dir="$HOME/.factory"'
    const cloneUrl = `https://github.com/${owner}/${repo}.git`
    const remoteScript = [
      'set -eu',
      remoteBaseDirAssignment,
      `owner=${shellEscape(owner)}`,
      `repo=${shellEscape(repo)}`,
      `feature=${shellEscape(feature)}`,
      `clone_url=${shellEscape(cloneUrl)}`,
      'repo_dir="$base_dir/$owner/$repo"',
      'bare_git_dir="$repo_dir/bare.git"',
      'worktree_path="$repo_dir/worktrees/$feature"',
      'if [ ! -d "$bare_git_dir" ]; then',
      '  mkdir -p "$repo_dir"',
      '  git clone --bare "$clone_url" "$bare_git_dir"',
      'fi',
      'if [ -e "$worktree_path" ]; then',
      '  echo "Worktree \\"$feature\\" already exists" >&2',
      '  exit 23',
      'fi',
      'git -C "$bare_git_dir" fetch origin',
      'default_branch="$(git -C "$bare_git_dir" symbolic-ref HEAD 2>/dev/null || true)"',
      'default_branch="${default_branch#refs/heads/}"',
      'if [ -z "$default_branch" ]; then default_branch=main; fi',
      'git -C "$bare_git_dir" worktree add -b "$feature" "$worktree_path" "$default_branch"',
      'printf "%s\\n" "$worktree_path"',
    ].join('\n')

    let stdout: string
    try {
      const result = await runner.exec('ssh', buildSshArgs(input.machine, remoteScript))
      stdout = result.stdout
    } catch (error) {
      const message = getExecErrorMessage(error, 'Failed to bootstrap remote worktree')
      throw new Error(message)
    }

    const worktreePath = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1)
    if (!worktreePath) {
      throw new Error('Failed to bootstrap remote worktree: missing worktree path')
    }

    return {
      owner,
      repo,
      feature,
      branch: feature,
      path: worktreePath,
    }
  }

  const repoDir = path.join(baseDir, owner, repo)
  const bareGitDir = path.join(repoDir, 'bare.git')
  const worktreePath = path.join(baseDir, owner, repo, 'worktrees', feature)

  const bareExists = await fs.stat(bareGitDir).catch(() => null)
  if (!bareExists) {
    const cloneUrl = `https://github.com/${owner}/${repo}.git`
    await fs.mkdir(repoDir, { recursive: true })
    await runner.exec('git', ['clone', '--bare', cloneUrl, bareGitDir])
  }

  const worktreeExists = await fs.stat(worktreePath).catch(() => null)
  if (worktreeExists) {
    throw new Error(`Worktree "${feature}" already exists`)
  }

  await runner.exec('git', ['fetch', 'origin'], { cwd: bareGitDir })
  const defaultBranch = await detectDefaultBranch(runner, bareGitDir)
  await runner.exec('git', ['worktree', 'add', '-b', feature, worktreePath, defaultBranch], {
    cwd: bareGitDir,
  })

  return {
    owner,
    repo,
    feature,
    branch: feature,
    path: worktreePath,
  }
}
