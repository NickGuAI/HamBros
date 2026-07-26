import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'
import type {
  AgentSession,
  CreateMachineInput,
  CreateSessionInput,
  MachineDaemonPairResponse,
  MachineDaemonRevokeResponse,
  MachineDaemonStatus,
  MachineEnrollmentTokenResponse,
  MachineLaunchVerificationResponse,
  MachineAuthSetupInput,
  MachineAuthStatusReport,
  Machine,
  ProviderAuthSnapshotsResponse,
  SessionTransportType,
  SessionType,
} from '@/types'

const AGENT_SESSIONS_REFETCH_INTERVAL_MS = 5000
const AGENT_SESSIONS_STALE_MS = 30_000
const PROVIDER_AUTH_SNAPSHOTS_REFETCH_INTERVAL_MS = 5000
export const AGENT_SESSIONS_QUERY_KEY = ['agents', 'sessions'] as const

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

export async function createMachine(input: CreateMachineInput): Promise<Machine> {
  return fetchJson<Machine>('/api/agents/machines', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  })
}

export async function verifyMachineLaunch(
  machineId: string,
  input: { agentType?: string } = {},
): Promise<MachineLaunchVerificationResponse> {
  return fetchJson<MachineLaunchVerificationResponse>(
    `/api/agents/machines/${encodeURIComponent(machineId)}/verify-launch`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
}

export async function fetchMachineAuthStatus(machineId: string): Promise<MachineAuthStatusReport> {
  return fetchJson<MachineAuthStatusReport>(
    `/api/agents/machines/${encodeURIComponent(machineId)}/auth-status`,
  )
}

export async function fetchMachineDaemonStatus(machineId: string): Promise<MachineDaemonStatus> {
  return fetchJson<MachineDaemonStatus>(
    `/api/agents/machines/${encodeURIComponent(machineId)}/daemon/status`,
  )
}

export async function pairMachineDaemon(
  machineId: string,
  input: { label?: string; cwd?: string } = {},
): Promise<MachineDaemonPairResponse> {
  return fetchJson<MachineDaemonPairResponse>(
    `/api/agents/machines/${encodeURIComponent(machineId)}/daemon/pair`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
}

export async function mintMachineEnrollmentToken(
  input: { label?: string; cwd?: string } = {},
): Promise<MachineEnrollmentTokenResponse> {
  return fetchJson<MachineEnrollmentTokenResponse>(
    '/api/agents/machines/enrollment-token',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
}

export async function revokeMachineDaemon(machineId: string): Promise<MachineDaemonRevokeResponse> {
  return fetchJson<MachineDaemonRevokeResponse>(
    `/api/agents/machines/${encodeURIComponent(machineId)}/daemon/revoke`,
    { method: 'POST' },
  )
}

export async function setupMachineAuth(
  machineId: string,
  input: MachineAuthSetupInput,
): Promise<MachineAuthStatusReport> {
  return fetchJson<MachineAuthStatusReport>(
    `/api/agents/machines/${encodeURIComponent(machineId)}/auth-setup`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
}

export async function fetchProviderAuthSnapshots(): Promise<ProviderAuthSnapshotsResponse> {
  return fetchJson<ProviderAuthSnapshotsResponse>('/api/agents/provider-auth/snapshots')
}

export async function probeProviderAuthSnapshots(): Promise<ProviderAuthSnapshotsResponse> {
  return fetchJson<ProviderAuthSnapshotsResponse>('/api/agents/provider-auth/probe', {
    method: 'POST',
  })
}

export function useAgentSessions() {
  return useQuery({
    queryKey: AGENT_SESSIONS_QUERY_KEY,
    queryFn: fetchSessions,
    staleTime: AGENT_SESSIONS_STALE_MS,
    refetchInterval: (query) => query.state.error ? AGENT_SESSIONS_REFETCH_INTERVAL_MS : false,
  })
}

export function useMachines() {
  return useQuery({
    queryKey: ['agents', 'machines'],
    queryFn: fetchMachines,
  })
}

function isLikelyConnectionEndpoint(value: string): boolean {
  return value.includes('.') || value.includes(':')
}

function buildCreateSessionPayload(input: CreateSessionInput): Record<string, unknown> {
  const rawMachineId = input.machineId ?? input.host
  let machineId: string | undefined
  if (rawMachineId !== undefined && rawMachineId !== null && rawMachineId !== '') {
    if (typeof rawMachineId !== 'string') {
      throw new Error('Create session requires a registered machine ID string, not a machine object.')
    }
    const trimmed = rawMachineId.trim()
    if (!/^[\w-]+$/u.test(trimmed)) {
      throw new Error(
        isLikelyConnectionEndpoint(trimmed)
          ? 'Create session requires a registered machine ID, not a Tailscale hostname or IP address.'
          : 'Create session requires a registered machine ID string.',
      )
    }
    machineId = trimmed
  }

  const { machineId: _machineId, host: _host, ...rest } = input
  return {
    ...rest,
    ...(machineId ? { machineId } : {}),
    transportType: input.transportType ?? 'stream',
  }
}

export function useMachineAuthStatus(machineId?: string, enabled = true) {
  return useQuery({
    queryKey: ['agents', 'machines', machineId ?? '', 'auth-status'],
    queryFn: () => fetchMachineAuthStatus(machineId ?? ''),
    enabled: enabled && typeof machineId === 'string' && machineId.trim().length > 0,
  })
}

export function useMachineDaemonStatus(machineId?: string, enabled = true) {
  return useQuery({
    queryKey: ['agents', 'machines', machineId ?? '', 'daemon-status'],
    queryFn: () => fetchMachineDaemonStatus(machineId ?? ''),
    enabled: enabled && typeof machineId === 'string' && machineId.trim().length > 0,
    refetchInterval: enabled ? 5000 : false,
  })
}

export function useProviderAuthSnapshots() {
  return useQuery({
    queryKey: ['agents', 'provider-auth', 'snapshots'],
    queryFn: fetchProviderAuthSnapshots,
    refetchInterval: PROVIDER_AUTH_SNAPSHOTS_REFETCH_INTERVAL_MS,
  })
}

export async function createSession(
  input: CreateSessionInput,
): Promise<{
  sessionName: string
  mode: 'default'
  sessionType: SessionType
  transportType: SessionTransportType
  created: boolean
}> {
  return fetchJson('/api/agents/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildCreateSessionPayload(input)),
  })
}

export async function killSession(sessionName: string): Promise<{ killed: boolean }> {
  return fetchJson(`/api/agents/sessions/${encodeURIComponent(sessionName)}`, {
    method: 'DELETE',
  })
}

export async function resumeSession(
  sessionName: string,
): Promise<{ name: string; resumedFrom: string }> {
  return fetchJson(`/api/agents/sessions/${encodeURIComponent(sessionName)}/resume`, {
    method: 'POST',
  })
}

export interface PreKillDebriefResponse {
  debriefStarted?: boolean
  timeoutMs?: number
  debriefed?: boolean
  reason?: string
}

export async function triggerPreKillDebrief(
  sessionName: string,
): Promise<PreKillDebriefResponse> {
  return fetchJson<PreKillDebriefResponse>(
    `/api/agents/sessions/${encodeURIComponent(sessionName)}/pre-kill-debrief`,
    { method: 'POST' },
  )
}

export type DebriefStatus = 'pending' | 'completed' | 'timed-out' | 'none'

export async function getDebriefStatus(
  sessionName: string,
): Promise<{ status: DebriefStatus }> {
  return fetchJson<{ status: DebriefStatus }>(
    `/api/agents/sessions/${encodeURIComponent(sessionName)}/debrief-status`,
  )
}

export function useDirectories(dirPath?: string, enabled = true, host?: string) {
  return useQuery({
    queryKey: ['agents', 'directories', dirPath ?? '~', host ?? ''],
    queryFn: () => fetchDirectories(dirPath, host),
    enabled,
  })
}
