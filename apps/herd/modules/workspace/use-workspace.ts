import { useQuery, useQueryClient } from '@tanstack/react-query'
import { buildRequestHeaders, fetchJson } from '@/lib/api'
import { getFullUrl } from '@/lib/api-base'
import type {
  WorkspaceContextMaterialization,
  WorkspaceContextRequest,
  WorkspaceFileAnnotation,
  WorkspacePendingFileAnnotation,
  WorkspaceFilePreview,
  WorkspaceGitLog,
  WorkspaceGitStatus,
  WorkspaceMutationResult,
  WorkspacePathResolution,
  WorkspaceSourceDescriptor,
  WorkspaceTreeResponse,
} from './types'

export type WorkspaceSource =
  {
    kind: 'target'
    targetId: string
    label?: string
    readOnly?: boolean
  }

export type WorkspaceSourceRecovery = (
  staleSource: WorkspaceSource,
) => Promise<WorkspaceSource | null | undefined>

export function getWorkspaceSourceKey(source: WorkspaceSource): string {
  return `target:${source.targetId}`
}

export function isWorkspaceTargetNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  if (/\bRequest failed \(404\):/u.test(error.message)) {
    return true
  }
  return error.message.trim() === 'Workspace target not found'
}

async function fetchWithWorkspaceTargetRecovery<T>(
  source: WorkspaceSource,
  read: (readSource: WorkspaceSource) => Promise<T>,
  recoverSource?: WorkspaceSourceRecovery,
): Promise<T> {
  try {
    return await read(source)
  } catch (error) {
    if (!recoverSource || !isWorkspaceTargetNotFoundError(error)) {
      throw error
    }
    const recoveredSource = await recoverSource(source)
    if (!recoveredSource) {
      throw error
    }
    return read(recoveredSource)
  }
}

function withPathQuery(basePath: string, relativePath?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams()
  if (extra?.targetId) {
    params.set('targetId', extra.targetId)
  }
  if (relativePath) {
    params.set('path', relativePath)
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (key === 'targetId') {
        continue
      }
      params.set(key, value)
    }
  }
  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}

function targetQuery(source: WorkspaceSource): Record<string, string> {
  return { targetId: source.targetId }
}

function withTargetQuery(basePath: string, source: WorkspaceSource): string {
  return withPathQuery(basePath, undefined, targetQuery(source))
}

type WorkspaceRawSource = WorkspaceSource | WorkspaceSourceDescriptor

function getWorkspaceRawTargetId(source: WorkspaceRawSource): string {
  return 'targetId' in source && typeof source.targetId === 'string'
    ? source.targetId
    : source.id
}

function fallbackDownloadFileName(relativePath: string): string {
  const normalizedPath = relativePath.replace(/\\/g, '/')
  const pathParts = normalizedPath.split('/').filter(Boolean)
  const fileName = pathParts[pathParts.length - 1]?.trim()
  return fileName || 'download'
}

function parseContentDispositionFileName(value: string | null): string | null {
  if (!value) {
    return null
  }

  const utf8Match = /filename\*=UTF-8''([^;]+)/iu.exec(value)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim())
    } catch {
      return utf8Match[1].trim()
    }
  }

  const fileNameMatch = /filename="([^"]+)"|filename=([^;]+)/iu.exec(value)
  const fileName = (fileNameMatch?.[1] ?? fileNameMatch?.[2])?.trim()
  return fileName || null
}

async function readDownloadError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  const trimmedBody = body.trim()
  if (!trimmedBody) {
    return response.statusText || 'Download failed'
  }

  try {
    const parsed = JSON.parse(trimmedBody) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim()
    }
  } catch {
    // Non-JSON error bodies are returned as plain text below.
  }

  return trimmedBody
}

function triggerBrowserDownload(blob: Blob, fileName: string): void {
  if (
    typeof window === 'undefined'
    || typeof document === 'undefined'
    || typeof URL.createObjectURL !== 'function'
  ) {
    throw new Error('Browser downloads are not available in this environment')
  }

  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => {
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(objectUrl)
    }
  }, 0)
}

export function buildWorkspaceRawUrl(
  source: WorkspaceRawSource,
  path: string,
  ticket?: string | null,
  options: { download?: boolean } = {},
): string | null {
  const targetId = getWorkspaceRawTargetId(source).trim()
  if (!targetId) {
    return null
  }
  const query = new URLSearchParams({ path })
  if (ticket) {
    query.set('ticket', ticket)
  }
  query.set('targetId', targetId)
  if (options.download) {
    query.set('download', '1')
  }
  return getFullUrl(`/api/workspace/raw?${query.toString()}`)
}

export async function issueWorkspaceRawTicket(
  source: WorkspaceRawSource,
  path: string,
): Promise<string | null> {
  const targetId = getWorkspaceRawTargetId(source).trim()
  if (!targetId) {
    return null
  }

  const response = await fetchJson<{ ticket?: unknown }>('/api/workspace/raw-ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetId, path }),
  })
  return typeof response.ticket === 'string' && response.ticket.trim().length > 0
    ? response.ticket.trim()
    : null
}

async function downloadWorkspaceFileOnce(
  source: WorkspaceRawSource,
  relativePath: string,
): Promise<void> {
  const downloadUrl = buildWorkspaceRawUrl(source, relativePath, null, { download: true })
  if (!downloadUrl) {
    throw new Error('Workspace target is unavailable')
  }

  const response = await fetch(downloadUrl, {
    headers: await buildRequestHeaders(),
  })
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${await readDownloadError(response)}`)
  }

  const blob = await response.blob()
  const fileName = parseContentDispositionFileName(response.headers.get('content-disposition'))
    ?? fallbackDownloadFileName(relativePath)
  triggerBrowserDownload(blob, fileName)
}

export async function downloadWorkspaceFile(
  source: WorkspaceSource,
  relativePath: string,
  recoverSource?: WorkspaceSourceRecovery,
): Promise<void> {
  return fetchWithWorkspaceTargetRecovery(
    source,
    (readSource) => downloadWorkspaceFileOnce(readSource, relativePath),
    recoverSource,
  )
}

export interface WorkspaceOpenResponse {
  targetId: string
  label: string
  host: string
  readOnly: boolean
}

export async function openWorkspaceTarget(input: {
  conversationId?: string
  sessionName?: string
  commanderId?: string
  hostHint?: string | null
  pathHint?: string | null
}): Promise<WorkspaceOpenResponse> {
  return fetchJson<WorkspaceOpenResponse>('/api/workspace/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function fetchWorkspaceTree(
  source: WorkspaceSource,
  relativePath = '',
): Promise<WorkspaceTreeResponse> {
  return fetchJson<WorkspaceTreeResponse>(
    withPathQuery('/api/workspace/tree', relativePath, targetQuery(source)),
  )
}

export async function fetchWorkspaceExpandedTree(
  source: WorkspaceSource,
  relativePath: string,
): Promise<WorkspaceTreeResponse> {
  return fetchJson<WorkspaceTreeResponse>(
    withPathQuery('/api/workspace/expand', relativePath, targetQuery(source)),
  )
}

export async function fetchWorkspacePathResolution(
  source: WorkspaceSource,
  requestedPath: string,
): Promise<WorkspacePathResolution> {
  return fetchJson<WorkspacePathResolution>(
    withPathQuery('/api/workspace/resolve-path', requestedPath, targetQuery(source)),
  )
}

export async function resolveWorkspaceReference(input: {
  path: string
  commanderId?: string | null
  conversationId?: string | null
  sessionName?: string | null
  hostHint?: string | null
  pathHint?: string | null
}): Promise<WorkspacePathResolution> {
  return fetchJson<WorkspacePathResolution>('/api/workspace/resolve-reference', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

async function fetchWorkspaceFilePreview(
  source: WorkspaceSource,
  relativePath: string,
): Promise<WorkspaceFilePreview> {
  return fetchJson<WorkspaceFilePreview>(
    withPathQuery('/api/workspace/file', relativePath, targetQuery(source)),
  )
}

export async function materializeWorkspaceContext(
  request: WorkspaceContextRequest,
): Promise<WorkspaceContextMaterialization> {
  return fetchJson<WorkspaceContextMaterialization>('/api/workspace/context/materialize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
}

async function fetchWorkspaceGitStatus(source: WorkspaceSource): Promise<WorkspaceGitStatus> {
  return fetchJson<WorkspaceGitStatus>(
    withPathQuery('/api/workspace/git/status', undefined, targetQuery(source)),
  )
}

async function fetchWorkspaceGitLog(
  source: WorkspaceSource,
  limit = 15,
): Promise<WorkspaceGitLog> {
  return fetchJson<WorkspaceGitLog>(
    withPathQuery('/api/workspace/git/log', undefined, {
      ...targetQuery(source),
      limit: String(limit),
    }),
  )
}

async function putWorkspaceFile(
  source: WorkspaceSource,
  relativePath: string,
  content: string,
): Promise<WorkspaceMutationResult> {
  return fetchJson<WorkspaceMutationResult>(withTargetQuery('/api/workspace/file', source), {
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
  return fetchJson<WorkspaceMutationResult>(withTargetQuery(`/api/workspace/${suffix}`, source), {
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
    withPathQuery('/api/workspace/path', relativePath, targetQuery(source)),
    { method: 'DELETE' },
  )
}

async function postWorkspaceGitInit(source: WorkspaceSource): Promise<{ output: string }> {
  return fetchJson<{ output: string }>(withTargetQuery('/api/workspace/git/init', source), {
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
    withPathQuery('/api/workspace/upload', relativePath, targetQuery(source)),
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
  recoverSource?: WorkspaceSourceRecovery,
) {
  return useQuery({
    queryKey: ['workspace', getWorkspaceSourceKey(source), 'file', relativePath ?? 'none'],
    queryFn: () => fetchWithWorkspaceTargetRecovery(
      source,
      (readSource) => fetchWorkspaceFilePreview(readSource, relativePath!),
      recoverSource,
    ),
    enabled: enabled && Boolean(relativePath),
  })
}

export function useWorkspaceGitStatus(
  source: WorkspaceSource,
  enabled = true,
  recoverSource?: WorkspaceSourceRecovery,
) {
  return useQuery({
    queryKey: ['workspace', getWorkspaceSourceKey(source), 'git', 'status'],
    queryFn: () => fetchWithWorkspaceTargetRecovery(source, fetchWorkspaceGitStatus, recoverSource),
    enabled,
  })
}

export function useWorkspaceGitLog(
  source: WorkspaceSource,
  enabled = true,
  limit = 15,
  recoverSource?: WorkspaceSourceRecovery,
) {
  return useQuery({
    queryKey: ['workspace', getWorkspaceSourceKey(source), 'git', 'log', limit],
    queryFn: () => fetchWithWorkspaceTargetRecovery(
      source,
      (readSource) => fetchWorkspaceGitLog(readSource, limit),
      recoverSource,
    ),
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

export type {
  WorkspaceContextMaterialization,
  WorkspaceContextRequest,
  WorkspaceFileAnnotation,
  WorkspacePendingFileAnnotation,
}
