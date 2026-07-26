import { Router } from 'express'
import {
  API_KEY_SCOPES,
  ApiKeyJsonStore,
  DEFAULT_BOOTSTRAP_MASTER_KEY_SCOPES,
  isApiKeyScope,
  type ApiKeyPurpose,
  type ApiKeyScope,
} from '../api-keys/store.js'
import {
  GEMINI_IMAGE_GENERATION_PROVIDER_ID,
  OPENAI_REALTIME_TRANSCRIPTION_PROVIDER_ID,
  ProviderSecretsStore,
  type ProviderSecretsStoreLike,
} from '../api-keys/provider-secrets-store.js'
import { combinedAuth } from '../middleware/combined-auth.js'
import { type Auth0Options } from '../middleware/auth0.js'

interface ApiKeyView {
  id: string
  name: string
  prefix: string
  purpose: ApiKeyPurpose
  createdBy: string
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  scopes: string[]
}

interface ApiKeyScopeCatalogView {
  scopes: ApiKeyScope[]
  defaultBootstrapScopes: ApiKeyScope[]
  mobilePairingScopes: ApiKeyScope[]
}

interface ApiKeysRouterOptions extends Auth0Options {
  store?: ApiKeyJsonStore
  providerSecretsStore?: ProviderSecretsStoreLike
  now?: () => Date
}

function toApiKeyView(record: Awaited<ReturnType<ApiKeyJsonStore['listKeys']>>[number]): ApiKeyView {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    purpose: record.purpose,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
    lastUsedAt: record.lastUsedAt,
    scopes: record.scopes,
  }
}

const MOBILE_PAIRING_SCOPES: readonly ApiKeyScope[] = [
  'agents:read',
  'agents:write',
  'commanders:read',
  'commanders:write',
  'services:read',
  'services:write',
  'skills:read',
  'telemetry:read',
]

const MOBILE_PAIRING_SCOPE_SET = new Set<string>(MOBILE_PAIRING_SCOPES)
const DEFAULT_MOBILE_PAIRING_TTL_MS = 30 * 24 * 60 * 60 * 1000

function readAuthenticatedScopes(user: Express.Request['user']): string[] {
  const scopes = user?.metadata?.scopes
  if (!Array.isArray(scopes)) {
    return []
  }
  return scopes.filter((scope): scope is string => typeof scope === 'string')
}

function mobileScopesForCredential(user: Express.Request['user']): string[] {
  return readAuthenticatedScopes(user).filter((scope) => MOBILE_PAIRING_SCOPE_SET.has(scope))
}

function parseName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  if (normalized.length === 0) {
    return null
  }

  return normalized
}

function parseScopes(value: unknown): ApiKeyScope[] | null {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return null
  }

  if (!value.every(isApiKeyScope)) {
    return null
  }

  return value
}

function parseMobilePairingScopes(value: unknown): ApiKeyScope[] | null {
  if (value === undefined) {
    return [...MOBILE_PAIRING_SCOPES]
  }

  const scopes = parseScopes(value)
  if (!scopes || scopes.length === 0) {
    return null
  }

  if (!scopes.every((scope) => MOBILE_PAIRING_SCOPE_SET.has(scope))) {
    return null
  }

  return [...new Set(scopes)]
}

function parseExpiresAt(value: unknown, requestNow: Date): Date | null | undefined {
  if (value === undefined || value === null || value === '') {
    return null
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const expiresAt = new Date(value)
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= requestNow.getTime()) {
    return undefined
  }

  return expiresAt
}

function parseExpiresInSeconds(value: unknown, requestNow: Date): Date | null {
  if (value === undefined || value === null || value === '') {
    return new Date(requestNow.getTime() + DEFAULT_MOBILE_PAIRING_TTL_MS)
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }

  const expiresAt = new Date(requestNow.getTime() + Math.floor(value * 1000))
  return Number.isFinite(expiresAt.getTime()) ? expiresAt : null
}

function parseProviderApiKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  if (normalized.length === 0) {
    return null
  }

  return normalized
}

export function createApiKeysRouter(options: ApiKeysRouterOptions = {}): Router {
  const router = Router()
  const store = options.store ?? new ApiKeyJsonStore()
  const providerSecretsStore =
    options.providerSecretsStore ?? new ProviderSecretsStore()
  const now = options.now ?? (() => new Date())

  // Per-route auth: master-API-key management requires `agents:admin` (the
  // elevated tier); operator-level transcription config requires the same
  // `services:read` / `services:write` scopes that sibling service routes use.
  // Both tiers accept Auth0 JWTs and Herd API keys symmetrically via
  // combinedAuth while preserving the narrower scope split between master-key
  // management and transcription service configuration.
  const masterKeyAuth = combinedAuth({
    ...options,
    apiKeyStore: store,
    requiredApiKeyScopes: ['agents:admin'],
  })
  const transcriptionReadAuth = combinedAuth({
    ...options,
    apiKeyStore: store,
    requiredApiKeyScopes: ['services:read'],
  })
  const transcriptionWriteAuth = combinedAuth({
    ...options,
    apiKeyStore: store,
    requiredApiKeyScopes: ['services:write'],
  })
  const mobileCredentialAuth = combinedAuth({
    ...options,
    apiKeyStore: store,
    requiredApiKeyScopes: [],
    requiredAuth0Permissions: MOBILE_PAIRING_SCOPES,
    auth0PermissionMode: 'any',
  })

  router.get('/scopes', masterKeyAuth, (_req, res) => {
    const catalog: ApiKeyScopeCatalogView = {
      scopes: [...API_KEY_SCOPES],
      defaultBootstrapScopes: [...DEFAULT_BOOTSTRAP_MASTER_KEY_SCOPES],
      mobilePairingScopes: [...MOBILE_PAIRING_SCOPES],
    }

    res.json(catalog)
  })

  router.post('/keys', masterKeyAuth, async (req, res) => {
    const name = parseName(req.body?.name)
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }

    const scopes = parseScopes(req.body?.scopes)
    if (!scopes) {
      res.status(400).json({
        error: `scopes must be an array containing only: ${API_KEY_SCOPES.join(', ')}`,
      })
      return
    }

    const requestNow = now()
    const expiresAt = parseExpiresAt(req.body?.expiresAt, requestNow)
    if (expiresAt === undefined) {
      res.status(400).json({ error: 'expiresAt must be a future ISO timestamp when provided' })
      return
    }

    try {
      const created = await store.createKey({
        name,
        scopes,
        purpose: 'permanent',
        createdBy: req.user?.email ?? req.user?.id ?? 'unknown',
        now: requestNow,
        expiresAt,
      })

      res.status(201).json({
        ...toApiKeyView(created.record),
        key: created.key,
      })
    } catch {
      res.status(500).json({ error: 'Failed to create API key' })
    }
  })

  router.post('/mobile/pairing', masterKeyAuth, async (req, res) => {
    const name = req.body?.name === undefined
      ? 'Herd Mobile Pairing'
      : parseName(req.body.name)
    if (!name) {
      res.status(400).json({ error: 'name must be a non-empty string when provided' })
      return
    }

    const scopes = parseMobilePairingScopes(req.body?.scopes)
    if (!scopes) {
      res.status(400).json({
        error: `scopes must be a non-empty subset of mobile pairing scopes: ${MOBILE_PAIRING_SCOPES.join(', ')}`,
      })
      return
    }

    const requestNow = now()
    const expiresAt = parseExpiresInSeconds(req.body?.expiresInSeconds, requestNow)
    if (!expiresAt) {
      res.status(400).json({ error: 'expiresInSeconds must be a positive number when provided' })
      return
    }

    try {
      const created = await store.createKey({
        name,
        scopes,
        purpose: 'permanent',
        createdBy: req.user?.email ?? req.user?.id ?? 'unknown',
        now: requestNow,
        expiresAt,
      })

      res.status(201).json({
        ...toApiKeyView(created.record),
        key: created.key,
      })
    } catch {
      res.status(500).json({ error: 'Failed to create mobile pairing credential' })
    }
  })

  router.get('/mobile/verify', mobileCredentialAuth, (req, res) => {
    const credentialScopes = req.authMode === 'api-key'
      ? mobileScopesForCredential(req.user)
      : [...MOBILE_PAIRING_SCOPES]
    if (credentialScopes.length === 0) {
      res.status(403).json({ error: 'Insufficient API key scope' })
      return
    }
    res.json({
      ok: true,
      requiredScopes: credentialScopes,
    })
  })

  router.get('/keys', masterKeyAuth, async (_req, res) => {
    try {
      const keys = await store.listKeys()
      res.json(keys.map((record) => toApiKeyView(record)))
    } catch {
      res.status(500).json({ error: 'Failed to list API keys' })
    }
  })

  router.delete('/keys/:id', masterKeyAuth, async (req, res) => {
    const id = parseName(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'Invalid key id' })
      return
    }

    try {
      const deleted = await store.revokeKey(id)
      if (!deleted) {
        res.status(404).json({ error: 'API key not found' })
        return
      }

      res.status(204).send()
    } catch {
      res.status(500).json({ error: 'Failed to revoke API key' })
    }
  })

  router.get('/transcription/openai', transcriptionReadAuth, async (_req, res) => {
    try {
      const status = await providerSecretsStore.getSecretStatus(
        OPENAI_REALTIME_TRANSCRIPTION_PROVIDER_ID,
      )
      res.json(status)
    } catch {
      res.status(500).json({ error: 'Failed to read transcription settings' })
    }
  })

  router.put('/transcription/openai', transcriptionWriteAuth, async (req, res) => {
    const rawKey = parseProviderApiKey(req.body?.apiKey)
    if (!rawKey) {
      res.status(400).json({ error: 'apiKey is required' })
      return
    }

    try {
      await providerSecretsStore.setSecret(OPENAI_REALTIME_TRANSCRIPTION_PROVIDER_ID, rawKey, {
        now: now(),
      })
      res.status(204).send()
    } catch {
      res.status(500).json({ error: 'Failed to store transcription settings' })
    }
  })

  router.delete('/transcription/openai', transcriptionWriteAuth, async (_req, res) => {
    try {
      await providerSecretsStore.deleteSecret(OPENAI_REALTIME_TRANSCRIPTION_PROVIDER_ID)
      res.status(204).send()
    } catch {
      res.status(500).json({ error: 'Failed to clear transcription settings' })
    }
  })

  router.get('/image-generation/gemini', transcriptionReadAuth, async (_req, res) => {
    try {
      const status = await providerSecretsStore.getSecretStatus(
        GEMINI_IMAGE_GENERATION_PROVIDER_ID,
      )
      res.json(status)
    } catch {
      res.status(500).json({ error: 'Failed to read image generation settings' })
    }
  })

  router.put('/image-generation/gemini', transcriptionWriteAuth, async (req, res) => {
    const rawKey = parseProviderApiKey(req.body?.apiKey)
    if (!rawKey) {
      res.status(400).json({ error: 'apiKey is required' })
      return
    }

    try {
      await providerSecretsStore.setSecret(GEMINI_IMAGE_GENERATION_PROVIDER_ID, rawKey, {
        now: now(),
      })
      res.status(204).send()
    } catch {
      res.status(500).json({ error: 'Failed to store image generation settings' })
    }
  })

  router.delete('/image-generation/gemini', transcriptionWriteAuth, async (_req, res) => {
    try {
      await providerSecretsStore.deleteSecret(GEMINI_IMAGE_GENERATION_PROVIDER_ID)
      res.status(204).send()
    } catch {
      res.status(500).json({ error: 'Failed to clear image generation settings' })
    }
  })

  return router
}
