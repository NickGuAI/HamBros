import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveWorkspacePath } from './resolver.js'
import type { ResolvedWorkspace, WorkspaceTreeNode, WorkspaceTreeResponse } from './types.js'

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
])

const MAX_TREE_ENTRIES = 200

function shouldSkipEntry(name: string, isDirectory: boolean): boolean {
  if (name === '.git') {
    return true
  }
  return isDirectory && IGNORED_DIRECTORY_NAMES.has(name)
}

function compareTreeNodes(left: WorkspaceTreeNode, right: WorkspaceTreeNode): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1
  }
  return left.name.localeCompare(right.name)
}

export async function listWorkspaceTree(
  workspace: ResolvedWorkspace,
  parentPath = '',
): Promise<WorkspaceTreeResponse> {
  const { absolutePath, relativePath } = await resolveWorkspacePath(workspace, parentPath, {
    expectDirectory: true,
  })

  const entries = await readdir(absolutePath, { withFileTypes: true })
  const nodes: WorkspaceTreeNode[] = []

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue
    }

    const isDirectory = entry.isDirectory()
    if (shouldSkipEntry(entry.name, isDirectory)) {
      continue
    }

    const entryPath = path.join(absolutePath, entry.name)
    const entryRelativePath = relativePath
      ? `${relativePath}/${entry.name}`
      : entry.name

    const node: WorkspaceTreeNode = {
      name: entry.name,
      path: entryRelativePath.split(path.sep).join('/'),
      type: isDirectory ? 'directory' : 'file',
      extension: isDirectory ? undefined : path.extname(entry.name).replace(/^\./, '') || undefined,
    }

    if (!isDirectory) {
      try {
        node.size = (await stat(entryPath)).size
      } catch {
        // Ignore per-entry stat failures and keep the tree usable.
      }
    }

    nodes.push(node)
  }

  nodes.sort(compareTreeNodes)

  return {
    workspace,
    parentPath: relativePath,
    nodes: nodes.slice(0, MAX_TREE_ENTRIES),
  }
}
