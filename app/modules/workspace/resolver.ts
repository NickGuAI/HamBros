import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { detectWorkspaceGitRoot, type WorkspaceCommandRunner } from './git.js'
import type { ResolvedWorkspace, WorkspaceSourceDescriptor } from './types.js'

export class WorkspaceError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.statusCode = statusCode
  }
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizeRelativePath(input: string | undefined | null): string {
  if (!input) {
    return ''
  }

  if (path.isAbsolute(input)) {
    throw new WorkspaceError(400, 'Workspace paths must be relative to the workspace root')
  }

  const normalized = path.posix.normalize(input.replaceAll('\\', '/'))
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new WorkspaceError(400, 'Workspace path cannot escape the workspace root')
  }

  return normalized === '.' ? '' : normalized.replace(/^\/+/, '')
}

async function ensureDirectoryExists(targetPath: string, message: string): Promise<void> {
  let targetStat
  try {
    targetStat = await stat(targetPath)
  } catch {
    throw new WorkspaceError(404, message)
  }

  if (!targetStat.isDirectory()) {
    throw new WorkspaceError(400, message)
  }
}

export async function resolveWorkspaceRoot(
  input: {
    rootPath: string | undefined | null
    source: WorkspaceSourceDescriptor
  },
  runner?: WorkspaceCommandRunner,
): Promise<ResolvedWorkspace> {
  const rootPath = typeof input.rootPath === 'string' ? input.rootPath.trim() : ''
  if (!rootPath || !path.isAbsolute(rootPath)) {
    throw new WorkspaceError(400, 'Workspace root must be an absolute path')
  }

  if (typeof input.source.host === 'string' && input.source.host.trim().length > 0) {
    throw new WorkspaceError(501, 'Remote workspace browsing is not supported yet')
  }

  let resolvedRoot: string
  try {
    resolvedRoot = await realpath(rootPath)
  } catch {
    throw new WorkspaceError(404, 'Workspace root does not exist')
  }

  await ensureDirectoryExists(resolvedRoot, 'Workspace root must be a directory')
  const gitRoot = await detectWorkspaceGitRoot(resolvedRoot, runner)

  return {
    source: input.source,
    rootPath: resolvedRoot,
    rootName: path.basename(resolvedRoot) || resolvedRoot,
    gitRoot,
    readOnly: Boolean(input.source.readOnly),
    isRemote: false,
  }
}

async function resolveExistingPath(rootPath: string, candidatePath: string): Promise<string> {
  let resolvedPath: string
  try {
    resolvedPath = await realpath(candidatePath)
  } catch {
    throw new WorkspaceError(404, 'Workspace path not found')
  }

  if (!isWithinRoot(rootPath, resolvedPath)) {
    throw new WorkspaceError(403, 'Workspace path escapes the workspace root')
  }

  return resolvedPath
}

export async function resolveWorkspacePath(
  workspace: ResolvedWorkspace,
  relativePath: string | undefined | null,
  options: {
    allowMissing?: boolean
    expectDirectory?: boolean
    expectFile?: boolean
  } = {},
): Promise<{ absolutePath: string; relativePath: string }> {
  const normalizedRelativePath = normalizeRelativePath(relativePath)
  const candidatePath = path.resolve(workspace.rootPath, normalizedRelativePath)

  let absolutePath: string
  if (options.allowMissing) {
    const parentPath = path.dirname(candidatePath)
    const resolvedParent = await resolveExistingPath(workspace.rootPath, parentPath)
    absolutePath = path.join(resolvedParent, path.basename(candidatePath))
    if (!isWithinRoot(workspace.rootPath, absolutePath)) {
      throw new WorkspaceError(403, 'Workspace path escapes the workspace root')
    }
  } else {
    absolutePath = await resolveExistingPath(workspace.rootPath, candidatePath)
  }

  if (options.expectDirectory || options.expectFile) {
    let targetStat
    try {
      targetStat = await stat(absolutePath)
    } catch {
      throw new WorkspaceError(404, 'Workspace path not found')
    }

    if (options.expectDirectory && !targetStat.isDirectory()) {
      throw new WorkspaceError(400, 'Workspace path must be a directory')
    }
    if (options.expectFile && !targetStat.isFile()) {
      throw new WorkspaceError(400, 'Workspace path must be a file')
    }
  }

  return {
    absolutePath,
    relativePath: normalizedRelativePath,
  }
}

export function requireWritableWorkspace(workspace: ResolvedWorkspace): void {
  if (workspace.readOnly) {
    throw new WorkspaceError(403, 'Workspace is read-only')
  }
}

export function toWorkspaceRelativePath(
  workspace: ResolvedWorkspace,
  absolutePath: string,
): string {
  const relativePath = path.relative(workspace.rootPath, absolutePath)
  if (!isWithinRoot(workspace.rootPath, absolutePath)) {
    throw new WorkspaceError(403, 'Workspace path escapes the workspace root')
  }
  return relativePath === '' ? '' : relativePath.split(path.sep).join('/')
}

export function getWorkspaceParentPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath)
  const parent = path.posix.dirname(normalized)
  return parent === '.' ? '' : parent
}

export function toWorkspaceError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) {
    return error
  }
  const message = error instanceof Error ? error.message : 'Workspace request failed'
  return new WorkspaceError(500, message)
}
