import { useCallback } from 'react'
import { fetchJson } from '@/lib/api'

export function useAuthFetch() {
  return useCallback(
    <T>(path: string, init?: RequestInit): Promise<T> => fetchJson<T>(path, init),
    [],
  )
}
