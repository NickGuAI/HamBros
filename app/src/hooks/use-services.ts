import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'
import type {
  ServiceInfo,
  SystemMetrics,
  VercelDeploymentInfo,
  VercelProjectInfo,
} from '@/types'

async function fetchServices(): Promise<ServiceInfo[]> {
  return fetchJson<ServiceInfo[]>('/api/services/list')
}

async function fetchServiceHealth(name: string): Promise<ServiceInfo> {
  return fetchJson<ServiceInfo>(`/api/services/${encodeURIComponent(name)}/health`)
}

export function useServices() {
  return useQuery({
    queryKey: ['services', 'list'],
    queryFn: fetchServices,
    refetchInterval: 10_000,
  })
}

export function useServiceHealth(name: string | null) {
  return useQuery({
    queryKey: ['services', 'health', name],
    queryFn: () => fetchServiceHealth(name!),
    enabled: !!name,
  })
}

export function useRestartService() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) =>
      fetchJson<{ restarted: boolean; script: string }>(
        `/api/services/${encodeURIComponent(name)}/restart`,
        { method: 'POST' },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['services', 'list'] })
    },
  })
}

export function useSystemMetrics() {
  return useQuery({
    queryKey: ['services', 'metrics'],
    queryFn: () => fetchJson<SystemMetrics>('/api/services/metrics'),
    refetchInterval: 10_000,
  })
}

async function fetchVercelProjects(): Promise<VercelProjectInfo[]> {
  return fetchJson<VercelProjectInfo[]>('/api/services/vercel/projects')
}

async function fetchVercelDeployments(projectId: string): Promise<VercelDeploymentInfo[]> {
  return fetchJson<VercelDeploymentInfo[]>(
    `/api/services/vercel/projects/${encodeURIComponent(projectId)}/deployments`,
  )
}

export function useVercelProjects(options?: { enabled?: boolean; autoRefresh?: boolean }) {
  const enabled = options?.enabled ?? true
  const autoRefresh = options?.autoRefresh ?? true

  return useQuery({
    queryKey: ['services', 'vercel', 'projects'],
    queryFn: fetchVercelProjects,
    enabled,
    refetchInterval: enabled && autoRefresh ? 30_000 : false,
  })
}

export function useVercelDeployments(
  projectId: string | null,
  options?: { enabled?: boolean; autoRefresh?: boolean },
) {
  const enabled = (options?.enabled ?? true) && !!projectId
  const autoRefresh = options?.autoRefresh ?? true

  return useQuery({
    queryKey: ['services', 'vercel', 'deployments', projectId],
    queryFn: () => fetchVercelDeployments(projectId!),
    enabled,
    refetchInterval: enabled && autoRefresh ? 30_000 : false,
  })
}

export function useTriggerVercelDeploy() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (projectId: string) =>
      fetchJson<VercelDeploymentInfo>(
        `/api/services/vercel/projects/${encodeURIComponent(projectId)}/deploy`,
        { method: 'POST' },
      ),
    onSuccess: async (_result, projectId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['services', 'vercel', 'projects'] }),
        queryClient.invalidateQueries({ queryKey: ['services', 'vercel', 'deployments', projectId] }),
      ])
    },
  })
}
