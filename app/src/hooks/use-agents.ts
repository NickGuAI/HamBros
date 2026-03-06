import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'
import type {
  AgentSession,
  ClaudePermissionMode,
  CreateSessionInput,
  Machine,
  SessionType,
  WorldAgent,
} from '@/types'

export interface DirectoryListing {
  parent: string
  directories: string[]
}

async function fetchDirectories(dirPath?: string, host?: string): Promise<DirectoryListing> {
  const searchParams = new URLSearchParams()
  if (dirPath) { searchParams.set('path', dirPath) }
  if (host) { searchParams.set('host', host) }
  const qs = searchParams.toString()
  return fetchJson<DirectoryListing>(`/api/agents/directories${qs ? `?${qs}` : ''}`)
}

async function fetchSessions(): Promise<AgentSession[]> {
  return fetchJson<AgentSession[]>('/api/agents/sessions')
}

async function fetchMachines(): Promise<Machine[]> {
  return fetchJson<Machine[]>('/api/agents/machines')
}

export async function fetchWorldAgents(): Promise<WorldAgent[]> {
  return fetchJson<WorldAgent[]>('/api/agents/world')
}

export function useAgentSessions() {
  return useQuery({
    queryKey: ['agents', 'sessions'],
    queryFn: fetchSessions,
    refetchInterval: 5000,
  })
}

export function useMachines() {
  return useQuery({
    queryKey: ['agents', 'machines'],
    queryFn: fetchMachines,
  })
}

export function useWorldAgents() {
  return useQuery({
    queryKey: ['agents', 'world'],
    queryFn: fetchWorldAgents,
    refetchInterval: 1000,
  })
}

export async function createSession(
  input: CreateSessionInput,
): Promise<{ sessionName: string; mode: ClaudePermissionMode; sessionType: SessionType; created: boolean }> {
  return fetchJson('/api/agents/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  })
}

export async function killSession(sessionName: string): Promise<{ killed: boolean }> {
  return fetchJson(`/api/agents/sessions/${encodeURIComponent(sessionName)}`, {
    method: 'DELETE',
  })
}

export function useDirectories(dirPath?: string, enabled = true, host?: string) {
  return useQuery({
    queryKey: ['agents', 'directories', dirPath ?? '~', host ?? ''],
    queryFn: () => fetchDirectories(dirPath, host),
    enabled,
  })
}
