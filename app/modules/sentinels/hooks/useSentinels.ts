import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson, fetchVoid } from '@/lib/api'
import type {
  CreateSentinelInput,
  Sentinel,
  SentinelHistoryEntry,
  UpdateSentinelInput,
} from '../types'

const SENTINELS_QUERY_KEY = (commanderId: string | null) => ['sentinels', 'list', commanderId ?? 'none'] as const
const SENTINEL_HISTORY_QUERY_KEY = (sentinelId: string | null) =>
  ['sentinels', 'history', sentinelId ?? 'none'] as const
const SKILL_OPTIONS_QUERY_KEY = ['sentinels', 'skill-options'] as const

export interface SkillOption {
  value: string
  label: string
  description?: string
}

interface TriggerSentinelResult {
  sentinel: Sentinel
  historyEntry: SentinelHistoryEntry
}

interface SentinelHistoryResponse {
  entries?: SentinelHistoryEntry[]
}

interface SkillDiscoveryItem {
  name?: string
  dirName?: string
  description?: string
}

async function fetchSentinels(commanderId: string): Promise<Sentinel[]> {
  const query = new URLSearchParams({ commander: commanderId })
  return fetchJson<Sentinel[]>(`/api/sentinels?${query.toString()}`)
}

async function fetchSentinelHistory(sentinelId: string): Promise<SentinelHistoryEntry[]> {
  const payload = await fetchJson<SentinelHistoryResponse | SentinelHistoryEntry[]>(
    `/api/sentinels/${encodeURIComponent(sentinelId)}/history?limit=50`,
  )

  if (Array.isArray(payload)) {
    return payload
  }
  if (Array.isArray(payload.entries)) {
    return payload.entries
  }
  return []
}

async function fetchSkillOptions(): Promise<SkillOption[]> {
  const payload = await fetchJson<SkillDiscoveryItem[] | { skills?: SkillDiscoveryItem[] }>('/api/skills')
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.skills)
      ? payload.skills
      : []

  const options: SkillOption[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const value = typeof item.dirName === 'string' && item.dirName.trim().length > 0
      ? item.dirName.trim()
      : null
    const label = typeof item.name === 'string' && item.name.trim().length > 0
      ? item.name.trim()
      : value

    if (!value || !label) {
      continue
    }

    options.push({
      value,
      label,
      description: typeof item.description === 'string' ? item.description.trim() : undefined,
    })
  }

  return options.sort((left, right) => left.label.localeCompare(right.label))
}

function toErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return null
}

export function useSentinels(commanderId: string | null | undefined) {
  const queryClient = useQueryClient()
  const effectiveCommanderId = commanderId ?? null

  const sentinelsQuery = useQuery({
    queryKey: SENTINELS_QUERY_KEY(effectiveCommanderId),
    queryFn: () => fetchSentinels(effectiveCommanderId!),
    enabled: Boolean(effectiveCommanderId),
    refetchInterval: 10_000,
  })

  const skillOptionsQuery = useQuery({
    queryKey: SKILL_OPTIONS_QUERY_KEY,
    queryFn: fetchSkillOptions,
    refetchInterval: 60_000,
  })

  const createMutation = useMutation({
    mutationFn: (input: CreateSentinelInput) =>
      fetchJson<Sentinel>('/api/sentinels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: async (created) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SENTINELS_QUERY_KEY(created.parentCommanderId) }),
        queryClient.invalidateQueries({ queryKey: SENTINEL_HISTORY_QUERY_KEY(created.id) }),
      ])
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ sentinelId, patch }: { sentinelId: string; patch: UpdateSentinelInput }) =>
      fetchJson<Sentinel>(`/api/sentinels/${encodeURIComponent(sentinelId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SENTINELS_QUERY_KEY(updated.parentCommanderId) }),
        queryClient.invalidateQueries({ queryKey: SENTINEL_HISTORY_QUERY_KEY(updated.id) }),
      ])
    },
  })

  const deleteMutation = useMutation({
    mutationFn: ({ sentinelId }: { sentinelId: string }) =>
      fetchVoid(`/api/sentinels/${encodeURIComponent(sentinelId)}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      if (effectiveCommanderId) {
        await queryClient.invalidateQueries({ queryKey: SENTINELS_QUERY_KEY(effectiveCommanderId) })
      }
    },
  })

  const triggerMutation = useMutation({
    mutationFn: ({ sentinelId }: { sentinelId: string }) =>
      fetchJson<TriggerSentinelResult>(`/api/sentinels/${encodeURIComponent(sentinelId)}/trigger`, {
        method: 'POST',
      }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SENTINELS_QUERY_KEY(result.sentinel.parentCommanderId) }),
        queryClient.invalidateQueries({ queryKey: SENTINEL_HISTORY_QUERY_KEY(result.sentinel.id) }),
      ])
    },
  })

  const createSentinel = useCallback(
    async (input: Omit<CreateSentinelInput, 'parentCommanderId'>) => {
      if (!effectiveCommanderId) {
        throw new Error('Select a commander before creating a sentinel')
      }
      return createMutation.mutateAsync({
        ...input,
        parentCommanderId: effectiveCommanderId,
      })
    },
    [createMutation, effectiveCommanderId],
  )

  const updateSentinel = useCallback(
    async (sentinelId: string, patch: UpdateSentinelInput) =>
      updateMutation.mutateAsync({ sentinelId, patch }),
    [updateMutation],
  )

  const deleteSentinel = useCallback(
    async (sentinelId: string) =>
      deleteMutation.mutateAsync({ sentinelId }),
    [deleteMutation],
  )

  const triggerSentinel = useCallback(
    async (sentinelId: string) =>
      triggerMutation.mutateAsync({ sentinelId }),
    [triggerMutation],
  )

  const pauseSentinel = useCallback(
    async (sentinelId: string) => updateMutation.mutateAsync({ sentinelId, patch: { status: 'paused' } }),
    [updateMutation],
  )

  const resumeSentinel = useCallback(
    async (sentinelId: string) => updateMutation.mutateAsync({ sentinelId, patch: { status: 'active' } }),
    [updateMutation],
  )

  return {
    sentinels: sentinelsQuery.data ?? [],
    sentinelsLoading: Boolean(effectiveCommanderId) && sentinelsQuery.isLoading,
    sentinelsError: toErrorMessage(sentinelsQuery.error),
    skillOptions: skillOptionsQuery.data ?? [],
    skillOptionsLoading: skillOptionsQuery.isLoading,
    skillOptionsError: toErrorMessage(skillOptionsQuery.error),
    createSentinel,
    updateSentinel,
    deleteSentinel,
    triggerSentinel,
    pauseSentinel,
    resumeSentinel,
    createPending: createMutation.isPending,
    updatePending: updateMutation.isPending,
    deletePending: deleteMutation.isPending,
    triggerPending: triggerMutation.isPending,
    actionError:
      toErrorMessage(createMutation.error)
      ?? toErrorMessage(updateMutation.error)
      ?? toErrorMessage(deleteMutation.error)
      ?? toErrorMessage(triggerMutation.error),
  }
}

export function useSentinelHistory(sentinelId: string | null | undefined) {
  const effectiveSentinelId = sentinelId ?? null

  const historyQuery = useQuery({
    queryKey: SENTINEL_HISTORY_QUERY_KEY(effectiveSentinelId),
    queryFn: () => fetchSentinelHistory(effectiveSentinelId!),
    enabled: Boolean(effectiveSentinelId),
    refetchInterval: 10_000,
  })

  return {
    history: historyQuery.data ?? [],
    historyLoading: Boolean(effectiveSentinelId) && historyQuery.isLoading,
    historyError: toErrorMessage(historyQuery.error),
  }
}
