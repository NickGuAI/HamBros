const DEFAULT_BASE_URL = process.env.HAMBROS_API_BASE_URL?.trim() || 'http://127.0.0.1:3000'
const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_MAX_POLL_ATTEMPTS = 120

export type AgentSessionTransportMode = 'default' | 'acceptEdits' | 'dangerouslySkipPermissions'
export type AgentSessionKind = 'pty' | 'stream'
export type AgentType = 'claude' | 'codex'

export type SessionCompletionStatus = 'SUCCESS' | 'PARTIAL' | 'BLOCKED'
export type SessionRuntimeState = 'queued' | 'running' | 'completed' | 'failed' | 'unknown'

export interface AgentSessionCreateInput {
  name: string
  task: string
  systemPrompt?: string
  mode?: AgentSessionTransportMode
  sessionType?: AgentSessionKind
  agentType?: AgentType
  cwd?: string
  host?: string
}

export interface CreatedAgentSession {
  sessionId: string
  raw: unknown
}

export interface AgentSessionCompletion {
  sessionId: string
  status: SessionCompletionStatus
  finalComment: string
  filesChanged: number
  durationMin: number
  raw: unknown
}

export interface AgentSessionProgress {
  sessionId: string
  state: SessionRuntimeState
  done: boolean
  completion?: AgentSessionCompletion
  raw: unknown
}

export interface AgentSessionMonitorOptions {
  pollIntervalMs?: number
  maxPollAttempts?: number
}

export interface AgentSessionClientOptions {
  baseUrl?: string
  apiKey?: string
  bearerToken?: string
  internalToken?: string
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  maxPollAttempts?: number
}

interface JsonResponseSuccess {
  ok: true
  status: number
  value: unknown
}

interface JsonResponseFailure {
  ok: false
  status: number
  text: string
}

type JsonResponse = JsonResponseSuccess | JsonResponseFailure

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function findString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key])
    if (value && value.trim().length > 0) return value
  }
  return null
}

function normalizeCompletionStatus(value: unknown): SessionCompletionStatus {
  const normalized = asString(value)?.trim().toUpperCase()
  if (normalized === 'SUCCESS') return 'SUCCESS'
  if (normalized === 'PARTIAL') return 'PARTIAL'
  if (normalized === 'BLOCKED') return 'BLOCKED'

  const state = asString(value)?.trim().toLowerCase()
  if (!state) return 'BLOCKED'
  if (state.includes('success') || state.includes('complete') || state.includes('done')) {
    return 'SUCCESS'
  }
  if (state.includes('partial') || state.includes('warn')) return 'PARTIAL'
  return 'BLOCKED'
}

function normalizeRuntimeState(value: unknown, completedFlag: unknown): SessionRuntimeState {
  if (completedFlag === true) return 'completed'
  if (completedFlag === false) return 'running'

  const state = asString(value)?.trim().toLowerCase()
  if (!state) return 'unknown'
  if (state.includes('queued') || state.includes('pending')) return 'queued'
  if (state.includes('run') || state.includes('progress')) return 'running'
  if (state.includes('success') || state.includes('complete') || state.includes('done')) {
    return 'completed'
  }
  if (state.includes('fail') || state.includes('error') || state.includes('block')) {
    return 'failed'
  }
  return 'unknown'
}

function parseCompletion(
  sessionId: string,
  payload: Record<string, unknown>,
): AgentSessionCompletion {
  const finalComment = findString(payload, [
    'finalComment',
    'final_comment',
    'message',
    'comment',
    'output',
  ]) ?? 'No completion comment provided.'
  const filesChanged = asNumber(payload.filesChanged ?? payload.changedFiles ?? payload.files) ?? 0
  const durationMin = asNumber(
    payload.durationMin ??
      payload.durationMinutes ??
      payload.durationMins ??
      payload.elapsedMinutes,
  )
  const durationSec = asNumber(payload.durationSec ?? payload.durationSeconds)
  const elapsedMs = asNumber(payload.elapsedMs ?? payload.durationMs)
  const normalizedDurationMin = durationMin
    ?? (durationSec !== null ? durationSec / 60 : null)
    ?? (elapsedMs !== null ? elapsedMs / 60000 : null)
    ?? 0

  return {
    sessionId,
    status: normalizeCompletionStatus(payload.status ?? payload.outcome ?? payload.result),
    finalComment: finalComment.trim(),
    filesChanged: Math.max(0, Math.floor(filesChanged)),
    durationMin: Math.max(0, normalizedDurationMin),
    raw: payload,
  }
}

export class AgentSessionClient {
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly bearerToken?: string
  private readonly internalToken?: string
  private readonly fetchImpl: typeof fetch
  private readonly pollIntervalMs: number
  private readonly maxPollAttempts: number

  constructor(options: AgentSessionClientOptions = {}) {
    this.baseUrl = options.baseUrl?.trim() || DEFAULT_BASE_URL
    this.apiKey = options.apiKey
    this.bearerToken = options.bearerToken
    this.internalToken = options.internalToken
    this.fetchImpl = options.fetchImpl ?? fetch
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS
  }

  async createSession(input: AgentSessionCreateInput): Promise<CreatedAgentSession> {
    const payload = await this.requestJson('/api/agents/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        task: input.task,
        systemPrompt: input.systemPrompt,
        mode: input.mode ?? 'acceptEdits',
        sessionType: input.sessionType ?? 'stream',
        agentType: input.agentType ?? 'claude',
        cwd: input.cwd,
        host: input.host,
      }),
    })

    const parsed = asRecord(payload)
    const sessionId = parsed
      ? findString(parsed, ['sessionId', 'sessionName', 'id', 'name'])
      : null

    return {
      sessionId: sessionId ?? input.name,
      raw: payload,
    }
  }

  async getSessionStatus(sessionId: string): Promise<AgentSessionProgress> {
    const encoded = encodeURIComponent(sessionId)
    const direct = await this.requestJsonMaybe(`/api/agents/sessions/${encoded}`)
    if (direct.ok) {
      return this.parseProgress(sessionId, direct.value)
    }

    // Backward-compatible fallback for servers that only expose session listing.
    if (direct.status !== 404) {
      throw new Error(`Failed to fetch session status (${direct.status}): ${direct.text}`)
    }

    const listing = await this.requestJson('/api/agents/sessions')
    if (Array.isArray(listing)) {
      const match = listing.find((entry) => {
        const record = asRecord(entry)
        if (!record) return false
        const id = findString(record, ['sessionId', 'sessionName', 'id', 'name'])
        return id === sessionId
      })
      if (match) {
        return {
          sessionId,
          state: 'running',
          done: false,
          raw: match,
        }
      }
    }

    return {
      sessionId,
      state: 'unknown',
      done: false,
      raw: listing,
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const text = message.trim()
    if (text.length === 0) {
      throw new Error('Message cannot be empty')
    }

    await this.requestJson(`/api/agents/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ message: text }),
    })
  }

  async monitorSession(
    sessionId: string,
    options: AgentSessionMonitorOptions = {},
  ): Promise<AgentSessionCompletion> {
    const pollIntervalMs = options.pollIntervalMs ?? this.pollIntervalMs
    const maxPollAttempts = options.maxPollAttempts ?? this.maxPollAttempts

    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const progress = await this.getSessionStatus(sessionId)
      if (progress.done && progress.completion) {
        return progress.completion
      }

      if (attempt < maxPollAttempts - 1) {
        await this.sleep(pollIntervalMs)
      }
    }

    throw new Error(
      `Session "${sessionId}" did not complete after ${maxPollAttempts} status checks`,
    )
  }

  private parseProgress(sessionId: string, payload: unknown): AgentSessionProgress {
    const root = asRecord(payload)
    if (!root) {
      return {
        sessionId,
        state: 'unknown',
        done: false,
        raw: payload,
      }
    }

    const sessionRecord = asRecord(root.session) ?? root
    const resultRecord = asRecord(root.result)
    const runtimeState = normalizeRuntimeState(
      sessionRecord.status ?? sessionRecord.state ?? root.status ?? root.state,
      sessionRecord.completed ?? root.completed,
    )

    if (runtimeState === 'completed' || runtimeState === 'failed') {
      const completionSource = resultRecord ?? sessionRecord ?? root
      const completion = parseCompletion(sessionId, completionSource)
      return {
        sessionId,
        state: runtimeState,
        done: true,
        completion: runtimeState === 'failed'
          ? { ...completion, status: 'BLOCKED' }
          : completion,
        raw: payload,
      }
    }

    return {
      sessionId,
      state: runtimeState,
      done: false,
      raw: payload,
    }
  }

  private async requestJson(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.requestJsonMaybe(pathname, init)
    if (!response.ok) {
      throw new Error(
        `Request failed (${response.status}) for ${pathname}: ${response.text}`,
      )
    }
    return response.value
  }

  private async requestJsonMaybe(pathname: string, init: RequestInit = {}): Promise<JsonResponse> {
    const response = await this.fetchImpl(this.toUrl(pathname), {
      ...init,
      headers: this.buildHeaders(init.headers),
    })
    const text = await response.text()

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        text,
      }
    }

    if (text.trim().length === 0) {
      return {
        ok: true,
        status: response.status,
        value: null,
      }
    }

    try {
      return {
        ok: true,
        status: response.status,
        value: JSON.parse(text) as unknown,
      }
    } catch {
      return {
        ok: true,
        status: response.status,
        value: text,
      }
    }
  }

  private buildHeaders(initHeaders: RequestInit['headers']): Headers {
    const headers = new Headers(initHeaders)
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    if (this.internalToken) {
      headers.set('x-hammurabi-internal-token', this.internalToken)
    }
    if (this.bearerToken && !headers.has('authorization')) {
      headers.set('authorization', this.bearerToken)
    } else if (this.apiKey && !headers.has('x-hammurabi-api-key')) {
      headers.set('x-hammurabi-api-key', this.apiKey)
    }
    return headers
  }

  private toUrl(pathname: string): string {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl
    return `${base}${pathname}`
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })
  }
}
