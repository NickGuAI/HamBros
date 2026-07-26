import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { buildRequestHeaders, fetchJson } from '@/lib/api'
import { getFullUrl, getStoredInstanceUrl } from '@/lib/api-base'

export interface ApiKeyView {
  id: string
  name: string
  prefix: string
  purpose: 'bootstrap' | 'permanent'
  createdBy: string
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  scopes: string[]
}

export interface ApiKeyScopeCatalog {
  scopes: string[]
  defaultBootstrapScopes: string[]
  mobilePairingScopes: string[]
}

export interface CreateApiKeyInput {
  name: string
  scopes: string[]
}

export interface CreatedApiKey extends ApiKeyView {
  key: string
}

export interface CreateMobileAccessInviteInput {
  expiresInSeconds: number
  scopes?: string[]
}

interface MobileAccessInviteResponse {
  id?: string
  name?: string
  prefix?: string
  key?: string
  invite?: string
  qrPayload?: string
  payload?: string | Record<string, unknown>
  expiresAt?: string | null
  scopes?: string[]
  instanceUrl?: string
}

export interface MobileAccessInvite {
  invite: string
  qrPayload: string
  expiresAt: string
  scopes: string[]
  instanceUrl?: string
  keyPrefix?: string
}

export interface OpenAITranscriptionSettings {
  configured: boolean
  updatedAt: string | null
}

export interface GeminiImageGenerationSettings {
  configured: boolean
  updatedAt: string | null
}

async function fetchApiKeys(): Promise<ApiKeyView[]> {
  return fetchJson<ApiKeyView[]>('/api/auth/keys')
}

async function fetchApiKeyScopeCatalog(): Promise<ApiKeyScopeCatalog> {
  return fetchJson<ApiKeyScopeCatalog>('/api/auth/scopes')
}

async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  return fetchJson<CreatedApiKey>('/api/auth/keys', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  })
}

function getCurrentInstanceUrl(): string | null {
  const storedInstanceUrl = getStoredInstanceUrl()
  if (storedInstanceUrl) {
    return storedInstanceUrl
  }

  if (typeof window === 'undefined') {
    return null
  }

  const origin = window.location?.origin?.trim()
  if (!origin || origin === 'null' || origin.startsWith('capacitor:')) {
    return null
  }

  return origin.replace(/\/+$/, '')
}

function buildMobileInvitePayload(response: MobileAccessInviteResponse): string | null {
  if (typeof response.invite === 'string' && response.invite.trim().length > 0) {
    return response.invite
  }
  if (typeof response.payload === 'string' && response.payload.trim().length > 0) {
    return response.payload
  }
  if (response.payload) {
    return JSON.stringify(response.payload)
  }
  if (typeof response.key !== 'string' || response.key.trim().length === 0) {
    return null
  }

  const instanceUrl = response.instanceUrl ?? getCurrentInstanceUrl()
  if (!instanceUrl) {
    return response.key
  }

  return JSON.stringify({
    instanceUrl,
    apiKey: response.key,
    expiresAt: response.expiresAt,
    scopes: response.scopes ?? [],
  })
}

function normalizeMobileAccessInvite(response: MobileAccessInviteResponse): MobileAccessInvite {
  const invite = buildMobileInvitePayload(response)

  if (!invite) {
    throw new Error('Mobile access invite response did not include invite payload')
  }

  const expiresAt = typeof response.expiresAt === 'string' ? response.expiresAt : null
  if (!expiresAt) {
    throw new Error('Mobile access invite response did not include expiry')
  }
  const instanceUrl = response.instanceUrl ?? getCurrentInstanceUrl()

  return {
    invite,
    qrPayload:
      typeof response.qrPayload === 'string' && response.qrPayload.trim().length > 0
        ? response.qrPayload
        : invite,
    expiresAt,
    scopes: response.scopes ?? [],
    ...(instanceUrl ? { instanceUrl } : {}),
    ...(response.prefix ? { keyPrefix: response.prefix } : {}),
  }
}

async function createMobileAccessInvite(
  input: CreateMobileAccessInviteInput,
): Promise<MobileAccessInvite> {
  const response = await fetchJson<MobileAccessInviteResponse>('/api/auth/mobile/pairing', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  })
  return normalizeMobileAccessInvite(response)
}

async function revokeApiKey(id: string): Promise<void> {
  const headers = await buildRequestHeaders()
  const response = await fetch(getFullUrl(`/api/auth/keys/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers,
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to revoke API key (${response.status}): ${body}`)
  }
}

async function fetchOpenAITranscriptionSettings(): Promise<OpenAITranscriptionSettings> {
  return fetchJson<OpenAITranscriptionSettings>('/api/auth/transcription/openai')
}

async function setOpenAITranscriptionKey(apiKey: string): Promise<void> {
  const headers = await buildRequestHeaders({
    'content-type': 'application/json',
  })
  const response = await fetch(getFullUrl('/api/auth/transcription/openai'), {
    method: 'PUT',
    headers,
    body: JSON.stringify({ apiKey }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to save OpenAI key (${response.status}): ${body}`)
  }
}

async function clearOpenAITranscriptionKey(): Promise<void> {
  const headers = await buildRequestHeaders()
  const response = await fetch(getFullUrl('/api/auth/transcription/openai'), {
    method: 'DELETE',
    headers,
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to clear OpenAI key (${response.status}): ${body}`)
  }
}

async function fetchGeminiImageGenerationSettings(): Promise<GeminiImageGenerationSettings> {
  return fetchJson<GeminiImageGenerationSettings>('/api/auth/image-generation/gemini')
}

async function setGeminiImageGenerationKey(apiKey: string): Promise<void> {
  const headers = await buildRequestHeaders({
    'content-type': 'application/json',
  })
  const response = await fetch(getFullUrl('/api/auth/image-generation/gemini'), {
    method: 'PUT',
    headers,
    body: JSON.stringify({ apiKey }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to save Gemini key (${response.status}): ${body}`)
  }
}

async function clearGeminiImageGenerationKey(): Promise<void> {
  const headers = await buildRequestHeaders()
  const response = await fetch(getFullUrl('/api/auth/image-generation/gemini'), {
    method: 'DELETE',
    headers,
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to clear Gemini key (${response.status}): ${body}`)
  }
}

export function useApiKeys() {
  return useQuery({
    queryKey: ['auth', 'api-keys'],
    queryFn: fetchApiKeys,
    refetchInterval: 15_000,
  })
}

export function useApiKeyScopeCatalog() {
  return useQuery({
    queryKey: ['auth', 'api-key-scopes'],
    queryFn: fetchApiKeyScopeCatalog,
    staleTime: 5 * 60_000,
  })
}

export function useCreateApiKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createApiKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'api-keys'] })
    },
  })
}

export function useCreateMobileAccessInvite() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createMobileAccessInvite,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'api-keys'] })
    },
  })
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: revokeApiKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'api-keys'] })
    },
  })
}

export function useOpenAITranscriptionSettings() {
  return useQuery({
    queryKey: ['auth', 'openai-transcription-settings'],
    queryFn: fetchOpenAITranscriptionSettings,
    refetchInterval: 15_000,
  })
}

export function useSetOpenAITranscriptionKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: setOpenAITranscriptionKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['auth', 'openai-transcription-settings'],
      })
      await queryClient.invalidateQueries({
        queryKey: ['realtime', 'transcription', 'config'],
      })
    },
  })
}

export function useClearOpenAITranscriptionKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: clearOpenAITranscriptionKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['auth', 'openai-transcription-settings'],
      })
      await queryClient.invalidateQueries({
        queryKey: ['realtime', 'transcription', 'config'],
      })
    },
  })
}

export function useGeminiImageGenerationSettings() {
  return useQuery({
    queryKey: ['auth', 'gemini-image-generation-settings'],
    queryFn: fetchGeminiImageGenerationSettings,
    refetchInterval: 15_000,
  })
}

export function useSetGeminiImageGenerationKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: setGeminiImageGenerationKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['auth', 'gemini-image-generation-settings'],
      })
    },
  })
}

export function useClearGeminiImageGenerationKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: clearGeminiImageGenerationKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['auth', 'gemini-image-generation-settings'],
      })
    },
  })
}
