import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'
import type { TelemetrySession, TelemetryCall, TelemetrySummary } from '@/types'

async function fetchTelemetrySessions(): Promise<TelemetrySession[]> {
  return fetchJson<TelemetrySession[]>('/api/telemetry/sessions')
}

async function fetchSessionDetail(id: string): Promise<{ session: TelemetrySession; calls: TelemetryCall[] }> {
  return fetchJson<{ session: TelemetrySession; calls: TelemetryCall[] }>(
    `/api/telemetry/sessions/${encodeURIComponent(id)}`,
  )
}

async function fetchSummary(): Promise<TelemetrySummary> {
  return fetchJson<TelemetrySummary>('/api/telemetry/summary')
}

export function useTelemetrySessions() {
  return useQuery({
    queryKey: ['telemetry', 'sessions'],
    queryFn: fetchTelemetrySessions,
    refetchInterval: 5000,
  })
}

export function useTelemetrySessionDetail(id: string | null) {
  return useQuery({
    queryKey: ['telemetry', 'session', id],
    queryFn: () => fetchSessionDetail(id!),
    enabled: !!id,
    refetchInterval: 3000,
  })
}

export function useTelemetrySummary() {
  return useQuery({
    queryKey: ['telemetry', 'summary'],
    queryFn: fetchSummary,
    refetchInterval: 10000,
  })
}
