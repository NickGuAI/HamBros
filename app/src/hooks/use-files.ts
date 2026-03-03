import { useQuery } from '@tanstack/react-query'
import { fetchJson, buildRequestHeaders } from '@/lib/api'
import { getApiBase } from '@/lib/api-base'

export interface FileEntry {
  name: string
  isDirectory: boolean
}

export interface FileListing {
  path: string
  files: FileEntry[]
}

async function fetchFiles(dirPath: string): Promise<FileListing> {
  return fetchJson<FileListing>(`/api/agents/files?path=${encodeURIComponent(dirPath)}`)
}

export function useFiles(dirPath: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['agents', 'files', dirPath ?? ''],
    queryFn: () => fetchFiles(dirPath!),
    enabled: enabled && !!dirPath,
  })
}

export async function uploadFiles(cwd: string, files: FileList | File[]): Promise<{ uploaded: string[] }> {
  const form = new FormData()
  for (const file of Array.from(files)) {
    form.append('files', file)
  }

  const headers = await buildRequestHeaders()
  // Don't set Content-Type -- let browser set multipart boundary
  const base = getApiBase()
  const url = `${base}/api/agents/upload?cwd=${encodeURIComponent(cwd)}`
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Upload failed (${response.status}): ${body}`)
  }

  return response.json() as Promise<{ uploaded: string[] }>
}
