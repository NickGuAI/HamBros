import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'
import type {
  WorkspaceFilePreview,
  WorkspaceGitLog,
  WorkspaceGitStatus,
  WorkspaceMutationResult,
  WorkspaceTreeResponse,
} from './types'

export type WorkspaceSource =
  | {
      kind: 'agent-session'
      sessionName: string
      readOnly?: boolean
    }
  | {
      kind: 'commander'
      commanderId: string
      readOnly?: boolean
    }
  | {
      kind: 'factory-worktree'
      owner: string
      repo: string
      feature: string
      readOnly?: boolean
    }

export function getWorkspaceSourceKey(source: WorkspaceSource): string {
  switch (source.kind) {
    case 'agent-session':
      return `agent:${source.sessionName}`
    case 'commander':
      return `commander:${source.commanderId}`
    case 'factory-worktree':
      return `factory:${source.owner}/${source.repo}/${source.feature}`
  }
}

export function getWorkspaceBasePath(source: WorkspaceSource): string {
  switch (source.kind) {
    case 'agent-session':
      return `/api/agents/sessions/${encodeURIComponent(source.sessionName)}/workspace`
    case 'commander':
      return `/api/commanders/${encodeURIComponent(source.commanderId)}/workspace`
    case 'factory-worktree':
      return `/api/factory/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/worktrees/${encodeURIComponent(source.feature)}/workspace`
  }
}

function withPathQuery(basePath: string, relativePath?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams()
  if (relativePath) {
    params.set('path', relativePath)
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      params.set(key, value)
    }
  }
  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}

export async function fetchWorkspaceTree(
  source: WorkspaceSource,
  relativePath = '',
): Promise<WorkspaceTreeResponse> {
  return fetchJson<WorkspaceTreeResponse>(
    withPathQuery(`${getWorkspaceBasePath(source)}/tree`, relativePath),
  )
}

export async function fetchWorkspaceExpandedTree(
  source: WorkspaceSource,
  relativePath: string,
): Promise<WorkspaceTreeResponse> {
  return fetchJson<WorkspaceTreeResponse>(
    withPathQuery(`${getWorkspaceBasePath(source)}/expand`, relativePath),
  )
}

async function fetchWorkspaceFilePreview(
  source: WorkspaceSource,
  relativePath: string,
): Promise<WorkspaceFilePreview> {
  return fetchJson<WorkspaceFilePreview>(
    withPathQuery(`${getWorkspaceBasePath(source)}/file`, relativePath),
  )
}

async function fetchWorkspaceGitStatus(source: WorkspaceSource): Promise<WorkspaceGitStatus> {
  return fetchJson<WorkspaceGitStatus>(`${getWorkspaceBasePath(source)}/git/status`)
}

async function fetchWorkspaceGitLog(
  source: WorkspaceSource,
  limit = 15,
): Promise<WorkspaceGitLog> {
  return fetchJson<WorkspaceGitLog>(
    withPathQuery(`${getWorkspaceBasePath(source)}/git/log`, undefined, {
      limit: String(limit),
    }),
  )
}

async function putWorkspaceFile(
  source: WorkspaceSource,
  relativePath: string,
  content: string,
): Promise<WorkspaceMutationResult> {
  return fetchJson<WorkspaceMutationResult>(`${getWorkspaceBasePath(source)}/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: relativePath, content }),
  })
}

async function postWorkspaceMutation(
  source: WorkspaceSource,
  suffix: string,
  body: Record<string, string>,
): Promise<WorkspaceMutationResult> {
  return fetchJson<WorkspaceMutationResult>(`${getWorkspaceBasePath(source)}/${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function deleteWorkspacePath(
  source: WorkspaceSource,
  relativePath: string,
): Promise<WorkspaceMutationResult> {
  return fetchJson<WorkspaceMutationResult>(
    withPathQuery(`${getWorkspaceBasePath(source)}/path`, relativePath),
    { method: 'DELETE' },
  )
}

async function postWorkspaceGitInit(source: WorkspaceSource): Promise<{ output: string }> {
  return fetchJson<{ output: string }>(`${getWorkspaceBasePath(source)}/git/init`, {
    method: 'POST',
  })
}

export async function uploadWorkspaceFiles(
  source: WorkspaceSource,
  relativePath: string,
  files: FileList | File[],
): Promise<{ uploaded: string[]; path: string }> {
  const formData = new FormData()
  Array.from(files).forEach((file) => formData.append('files', file))
  return fetchJson<{ uploaded: string[]; path: string }>(
    withPathQuery(`${getWorkspaceBasePath(source)}/upload`, relativePath),
    {
      method: 'POST',
      body: formData,
    },
  )
}

export function useWorkspaceFilePreview(
  source: WorkspaceSource,
  relativePath: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ['workspace', getWorkspaceSourceKey(source), 'file', relativePath ?? 'none'],
    queryFn: () => fetchWorkspaceFilePreview(source, relativePath!),
    enabled: enabled && Boolean(relativePath),
  })
}

export function useWorkspaceGitStatus(source: WorkspaceSource, enabled = true) {
  return useQuery({
    queryKey: ['workspace', getWorkspaceSourceKey(source), 'git', 'status'],
    queryFn: () => fetchWorkspaceGitStatus(source),
    enabled,
  })
}

export function useWorkspaceGitLog(source: WorkspaceSource, enabled = true, limit = 15) {
  return useQuery({
    queryKey: ['workspace', getWorkspaceSourceKey(source), 'git', 'log', limit],
    queryFn: () => fetchWorkspaceGitLog(source, limit),
    enabled,
  })
}

export function useWorkspaceActions(source: WorkspaceSource) {
  const queryClient = useQueryClient()
  const sourceKey = getWorkspaceSourceKey(source)

  async function invalidateAll(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ['workspace', sourceKey] })
  }

  return {
    invalidateAll,
    saveFile: async (relativePath: string, content: string) => {
      const result = await putWorkspaceFile(source, relativePath, content)
      await invalidateAll()
      return result
    },
    createFile: async (relativePath: string) => {
      const result = await postWorkspaceMutation(source, 'new-file', { path: relativePath })
      await invalidateAll()
      return result
    },
    createFolder: async (relativePath: string) => {
      const result = await postWorkspaceMutation(source, 'new-folder', { path: relativePath })
      await invalidateAll()
      return result
    },
    renamePath: async (fromPath: string, toPath: string) => {
      const result = await postWorkspaceMutation(source, 'rename', { fromPath, toPath })
      await invalidateAll()
      return result
    },
    deletePath: async (relativePath: string) => {
      const result = await deleteWorkspacePath(source, relativePath)
      await invalidateAll()
      return result
    },
    initGit: async () => {
      const result = await postWorkspaceGitInit(source)
      await invalidateAll()
      return result
    },
    uploadFiles: async (relativePath: string, files: FileList | File[]) => {
      const result = await uploadWorkspaceFiles(source, relativePath, files)
      await invalidateAll()
      return result
    },
  }
}
