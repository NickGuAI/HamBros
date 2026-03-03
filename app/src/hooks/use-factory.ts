import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'
import type { FactoryRepo, FactoryWorktree } from '@/types'

export function useFactoryRepos() {
  return useQuery({
    queryKey: ['factory', 'repos'],
    queryFn: () => fetchJson<FactoryRepo[]>('/api/factory/repos'),
    refetchInterval: 10000,
  })
}

export function useFactoryWorktrees(owner: string, repo: string) {
  return useQuery({
    queryKey: ['factory', 'worktrees', owner, repo],
    queryFn: () =>
      fetchJson<FactoryWorktree[]>(
        `/api/factory/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/worktrees`,
      ),
    enabled: Boolean(owner && repo),
    refetchInterval: 10000,
  })
}

export function useCloneRepo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (url: string) =>
      fetchJson<FactoryRepo>('/api/factory/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['factory', 'repos'] })
    },
  })
}

export function useDeleteRepo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ owner, repo }: { owner: string; repo: string }) =>
      fetchJson(`/api/factory/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['factory', 'repos'] })
    },
  })
}

export function useCreateWorktree(owner: string, repo: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (feature: string) =>
      fetchJson<FactoryWorktree>(
        `/api/factory/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/worktrees`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ feature }),
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['factory', 'worktrees', owner, repo] })
    },
  })
}

export function useDeleteWorktree(owner: string, repo: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (feature: string) =>
      fetchJson(
        `/api/factory/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/worktrees/${encodeURIComponent(feature)}`,
        { method: 'DELETE' },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['factory', 'worktrees', owner, repo] })
    },
  })
}

export function useSyncRepo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ owner, repo }: { owner: string; repo: string }) =>
      fetchJson<{ synced: boolean; commitHash: string }>(
        `/api/factory/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/sync`,
        { method: 'POST' },
      ),
    onSuccess: async (_data, { owner, repo }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['factory', 'repos'] }),
        queryClient.invalidateQueries({ queryKey: ['factory', 'worktrees', owner, repo] }),
      ])
    },
  })
}
