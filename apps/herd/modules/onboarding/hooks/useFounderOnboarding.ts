import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'
import { ORG_QUERY_KEY } from '@modules/org/hooks/useOrgTree'
import { FOUNDER_PROFILE_QUERY_KEY } from '@modules/operators/hooks/useFounderProfile'
import type {
  FounderOrgSetupRequest,
  FounderOrgSetupResponse,
  FinishOnboardingResponse,
  OnboardingStatus,
  SeedGaiaOnboardingResponse,
  SeedStarterWorkforceOnboardingResponse,
  SkipStarterWorkforceOnboardingResponse,
} from '../contracts'

export const ONBOARDING_STATUS_QUERY_KEY = ['onboarding', 'status'] as const

async function fetchOnboardingStatus(): Promise<OnboardingStatus> {
  return fetchJson<OnboardingStatus>('/api/onboarding/status')
}

async function createFounderOrgSetup(
  payload: FounderOrgSetupRequest,
): Promise<FounderOrgSetupResponse> {
  return fetchJson<FounderOrgSetupResponse>('/api/org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function seedGaiaCommander(): Promise<SeedGaiaOnboardingResponse> {
  return fetchJson<SeedGaiaOnboardingResponse>('/api/onboarding/actions/seed-gaia', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
}

async function seedStarterWorkforce(): Promise<SeedStarterWorkforceOnboardingResponse> {
  return fetchJson<SeedStarterWorkforceOnboardingResponse>('/api/onboarding/actions/seed-starter-workforce', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
}

async function skipStarterWorkforce(): Promise<SkipStarterWorkforceOnboardingResponse> {
  return fetchJson<SkipStarterWorkforceOnboardingResponse>('/api/onboarding/actions/skip-starter-workforce', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
}

export async function verifyPermanentApiKey(rawKey: string): Promise<OnboardingStatus> {
  const status = await fetchJson<OnboardingStatus>('/api/onboarding/status', {
    headers: { 'x-herd-api-key': rawKey },
  })
  if (status.credentials.authenticatedAs !== 'permanent') {
    throw new Error('The new credential was not verified as a permanent API key.')
  }
  return status
}

async function finishOnboarding(): Promise<FinishOnboardingResponse> {
  return fetchJson<FinishOnboardingResponse>('/api/onboarding/actions/finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
}

export function useOnboardingStatus() {
  return useQuery({
    queryKey: ONBOARDING_STATUS_QUERY_KEY,
    queryFn: fetchOnboardingStatus,
  })
}

export function useCreateFounderOrgSetup() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createFounderOrgSetup,
    onSuccess: async (result) => {
      queryClient.setQueryData(FOUNDER_PROFILE_QUERY_KEY, result.operator)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: FOUNDER_PROFILE_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ORG_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ONBOARDING_STATUS_QUERY_KEY }),
      ])
    },
  })
}

export function useSeedGaiaCommander() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: seedGaiaCommander,
    onSuccess: async (result) => {
      queryClient.setQueryData(ONBOARDING_STATUS_QUERY_KEY, result.status)
      await queryClient.invalidateQueries({ queryKey: ORG_QUERY_KEY })
    },
  })
}

export function useSeedStarterWorkforce() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: seedStarterWorkforce,
    onSuccess: async (result) => {
      queryClient.setQueryData(ONBOARDING_STATUS_QUERY_KEY, result.status)
      await queryClient.invalidateQueries({ queryKey: ORG_QUERY_KEY })
    },
  })
}

export function useSkipStarterWorkforce() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: skipStarterWorkforce,
    onSuccess: async (result) => {
      queryClient.setQueryData(ONBOARDING_STATUS_QUERY_KEY, result.status)
      await queryClient.invalidateQueries({ queryKey: ORG_QUERY_KEY })
    },
  })
}

export function useFinishOnboarding() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: finishOnboarding,
    onSuccess: (result) => {
      queryClient.setQueryData(ONBOARDING_STATUS_QUERY_KEY, result.status)
    },
  })
}
