import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson, fetchVoid, getAccessToken } from '../../../src/lib/api'
import { getWsBase } from '../../../src/lib/api-base'
import { createReconnectBackoff, shouldReconnectWebSocketClose } from '../../agents/ws-reconnect'
import type { ClaudeEffortLevel } from '../../claude-effort.js'

const COMMANDERS_QUERY_KEY = ['commanders', 'sessions'] as const
const MAX_TERMINAL_LINES = 2000

export type CommanderState = 'idle' | 'running' | 'paused' | 'stopped'
export type CommanderWsStatus = 'connecting' | 'connected' | 'disconnected'
export type CommanderAgentType = 'claude' | 'codex' | 'gemini'

export interface CommanderHeartbeatState {
  intervalMs: number
  messageTemplate: string
  lastSentAt: string | null
}

export interface CommanderTaskSource {
  owner: string
  repo: string
  label?: string
  project?: string
}

export interface CommanderCurrentTask {
  issueNumber: number
  issueUrl: string
  startedAt: string
  title?: string
}

export interface CommanderUiFields {
  borderColor?: string
  accentColor?: string
  speakingTone?: string
}

export interface CommanderSession {
  id: string
  host: string
  /** Human-readable label set at creation time; falls back to host when absent */
  displayName?: string
  pid: number | null
  state: CommanderState
  created: string
  agentType?: CommanderAgentType
  effort?: ClaudeEffortLevel
  cwd?: string
  persona?: string
  heartbeat: CommanderHeartbeatState
  lastHeartbeat: string | null
  taskSource: CommanderTaskSource | null
  currentTask: CommanderCurrentTask | null
  completedTasks: number
  questCount: number
  scheduleCount: number
  totalCostUsd: number
  /** From `.memory/profile.json` — border / chat accent / tone */
  ui?: CommanderUiFields | null
  /** Present when `profile.json` references an on-disk avatar image */
  avatarUrl?: string | null
}

export interface CommanderTask {
  number: number
  title: string
  body: string
  issueUrl: string
  state: string
  labels: string[]
}

export interface CommanderCronTask {
  id: string
  commanderId: string
  schedule: string
  instruction: string
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  eventBridgeRuleArn?: string
  agentType?: 'claude' | 'codex' | 'gemini'
  sessionType?: 'stream' | 'pty'
  permissionMode?: string
  workDir?: string
  machine?: string
}

export interface CommanderCreateInput {
  host: string
  taskSource?: { owner: string; repo: string; label?: string }
  cwd?: string
  effort?: ClaudeEffortLevel
}

export interface CommanderProfileUpdateInput {
  commanderId: string
  persona?: string
  borderColor?: string
  accentColor?: string
  speakingTone?: string
  effort?: ClaudeEffortLevel
}

export interface CommanderAvatarUploadInput {
  commanderId: string
  file: File
}

interface CommanderMessageInput {
  commanderId: string
  message: string
}

interface CommanderTaskAssignInput {
  commanderId: string
  issueNumber: number
}

interface CommanderStartInput {
  commanderId: string
  agentType?: CommanderAgentType
}

interface ManualHeartbeatTriggerResponse {
  runId: string
  timestamp: string
  sessionName: string
  triggered: boolean
}

interface CommanderCronCreateInput {
  commanderId: string
  schedule: string
  instruction: string
  enabled?: boolean
  agentType?: 'claude' | 'codex' | 'gemini'
  sessionType?: 'stream' | 'pty'
  permissionMode?: string
  workDir?: string
  machine?: string
}

interface CommanderCronToggleInput {
  commanderId: string
  cronId: string
  enabled: boolean
}

interface CommanderCronUpdateInput {
  commanderId: string
  cronId: string
  instruction?: string
  schedule?: string
}

interface CommanderCronDeleteInput {
  commanderId: string
  cronId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function splitTerminalLines(raw: string): string[] {
  return raw
    .split('\r')
    .join('')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
}

function extractAssistantLines(payload: Record<string, unknown>): string[] {
  const message = payload.message
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return []
  }

  const lines: string[] = []
  for (const block of message.content) {
    if (!isRecord(block)) {
      continue
    }

    const type = block.type
    if (type === 'text' && typeof block.text === 'string') {
      lines.push(...splitTerminalLines(block.text))
      continue
    }

    if (type === 'thinking') {
      if (typeof block.thinking === 'string') {
        lines.push(...splitTerminalLines(block.thinking))
        continue
      }
      if (typeof block.text === 'string') {
        lines.push(...splitTerminalLines(block.text))
        continue
      }
    }

    if (type === 'tool_use' && typeof block.name === 'string') {
      lines.push(`[tool] ${block.name}`)
    }
  }

  return lines
}

function extractUserLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = []

  const toolUseResult = payload.tool_use_result
  if (isRecord(toolUseResult)) {
    if (typeof toolUseResult.stdout === 'string') {
      lines.push(...splitTerminalLines(toolUseResult.stdout))
    }
    if (typeof toolUseResult.stderr === 'string') {
      lines.push(...splitTerminalLines(toolUseResult.stderr))
    }
  }

  const message = payload.message
  if (isRecord(message) && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) {
        continue
      }
      if (typeof block.content === 'string') {
        lines.push(...splitTerminalLines(block.content))
      }
    }
  }

  return lines
}

function extractDeltaLines(payload: Record<string, unknown>): string[] {
  const delta = payload.delta
  if (!isRecord(delta) || typeof delta.type !== 'string') {
    return []
  }

  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    return splitTerminalLines(delta.text)
  }

  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return splitTerminalLines(delta.thinking)
  }

  return []
}

function extractEventLines(payload: Record<string, unknown>): string[] {
  const eventType = typeof payload.type === 'string' ? payload.type : ''

  if (eventType === 'system' && typeof payload.text === 'string') {
    return splitTerminalLines(payload.text)
  }

  if (eventType === 'assistant') {
    return extractAssistantLines(payload)
  }

  if (eventType === 'user') {
    return extractUserLines(payload)
  }

  if (eventType === 'result') {
    if (typeof payload.result === 'string') {
      return splitTerminalLines(payload.result)
    }
    if (payload.is_error === true) {
      return ['[error] Commander result returned an error']
    }
    return []
  }

  if (eventType === 'exit') {
    const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : 'unknown'
    return [`[exit] ${exitCode}`]
  }

  if (eventType === 'content_block_delta') {
    return extractDeltaLines(payload)
  }

  if (typeof payload.text === 'string') {
    return splitTerminalLines(payload.text)
  }

  return []
}

function parseIncomingMessage(data: unknown): string[] {
  let parsed: unknown = data

  if (data instanceof ArrayBuffer) {
    parsed = new TextDecoder().decode(data)
  }

  if (typeof parsed === 'string') {
    const rawText = parsed
    try {
      parsed = JSON.parse(rawText) as unknown
    } catch {
      return splitTerminalLines(rawText)
    }
  }

  if (!isRecord(parsed)) {
    return []
  }

  if (parsed.type === 'replay' && Array.isArray(parsed.events)) {
    const replayLines: string[] = []
    for (const event of parsed.events) {
      if (isRecord(event)) {
        replayLines.push(...extractEventLines(event))
      }
    }
    return replayLines
  }

  return extractEventLines(parsed)
}

async function fetchCommanders(): Promise<CommanderSession[]> {
  return fetchJson<CommanderSession[]>('/api/commanders')
}

async function createCommanderSession(input: CommanderCreateInput): Promise<CommanderSession> {
  return fetchJson<CommanderSession>('/api/commanders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

async function fetchCommanderTasks(commanderId: string): Promise<CommanderTask[]> {
  return fetchJson<CommanderTask[]>(`/api/commanders/${encodeURIComponent(commanderId)}/tasks`)
}

async function fetchCommanderCrons(commanderId: string): Promise<CommanderCronTask[]> {
  return fetchJson<CommanderCronTask[]>(`/api/commanders/${encodeURIComponent(commanderId)}/crons`)
}

async function startCommanderSession(input: CommanderStartInput): Promise<{ started: boolean }> {
  return fetchJson<{ started: boolean }>(`/api/commanders/${encodeURIComponent(input.commanderId)}/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      agentType: input.agentType,
    }),
  })
}

async function stopCommanderSession(commanderId: string): Promise<{ stopped: boolean }> {
  return fetchJson<{ stopped: boolean }>(`/api/commanders/${encodeURIComponent(commanderId)}/stop`, {
    method: 'POST',
  })
}

async function triggerCommanderHeartbeat(
  commanderId: string,
): Promise<ManualHeartbeatTriggerResponse> {
  return fetchJson<ManualHeartbeatTriggerResponse>(
    `/api/commanders/${encodeURIComponent(commanderId)}/heartbeat/trigger`,
    {
      method: 'POST',
    },
  )
}

async function sendCommanderMessage(input: CommanderMessageInput): Promise<{ accepted: boolean }> {
  return fetchJson<{ accepted: boolean }>(`/api/commanders/${encodeURIComponent(input.commanderId)}/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: input.message,
    }),
  })
}

async function assignCommanderTask(input: CommanderTaskAssignInput): Promise<{ assigned: boolean }> {
  return fetchJson<{ assigned: boolean }>(`/api/commanders/${encodeURIComponent(input.commanderId)}/tasks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      issueNumber: input.issueNumber,
    }),
  })
}

async function createCommanderCron(input: CommanderCronCreateInput): Promise<CommanderCronTask> {
  return fetchJson<CommanderCronTask>(`/api/commanders/${encodeURIComponent(input.commanderId)}/crons`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      schedule: input.schedule,
      instruction: input.instruction,
      enabled: input.enabled ?? true,
      agentType: input.agentType,
      sessionType: input.sessionType,
      permissionMode: input.permissionMode,
      workDir: input.workDir,
      machine: input.machine,
    }),
  })
}

async function toggleCommanderCron(input: CommanderCronToggleInput): Promise<CommanderCronTask> {
  return fetchJson<CommanderCronTask>(
    `/api/commanders/${encodeURIComponent(input.commanderId)}/crons/${encodeURIComponent(input.cronId)}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        enabled: input.enabled,
      }),
    },
  )
}

async function updateCommanderCron(input: CommanderCronUpdateInput): Promise<CommanderCronTask> {
  return fetchJson<CommanderCronTask>(
    `/api/commanders/${encodeURIComponent(input.commanderId)}/crons/${encodeURIComponent(input.cronId)}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        instruction: input.instruction,
        schedule: input.schedule,
      }),
    },
  )
}

async function deleteCommanderCron(input: CommanderCronDeleteInput): Promise<void> {
  return fetchVoid(
    `/api/commanders/${encodeURIComponent(input.commanderId)}/crons/${encodeURIComponent(input.cronId)}`,
    { method: 'DELETE' },
  )
}

async function deleteCommanderSession(commanderId: string): Promise<void> {
  return fetchVoid(`/api/commanders/${encodeURIComponent(commanderId)}`, {
    method: 'DELETE',
  })
}

async function updateCommanderProfile(input: CommanderProfileUpdateInput): Promise<void> {
  return fetchVoid(`/api/commanders/${encodeURIComponent(input.commanderId)}/profile`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      persona: input.persona,
      borderColor: input.borderColor,
      accentColor: input.accentColor,
      speakingTone: input.speakingTone,
      effort: input.effort,
    }),
  })
}

async function uploadCommanderAvatar(input: CommanderAvatarUploadInput): Promise<{ avatarUrl: string }> {
  const formData = new FormData()
  formData.append('avatar', input.file)
  return fetchJson<{ avatarUrl: string }>(
    `/api/commanders/${encodeURIComponent(input.commanderId)}/avatar`,
    { method: 'POST', body: formData },
  )
}

function commanderWsUrl(commanderId: string, token: string | null): string {
  const query = new URLSearchParams()
  if (token) {
    query.set('access_token', token)
  }

  const wsBase = getWsBase()
  const qs = query.toString()
  const sessionPath = `/api/agents/sessions/commander-${encodeURIComponent(commanderId)}/ws`

  if (wsBase) {
    return `${wsBase}${sessionPath}?${qs}`
  }

  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}${sessionPath}?${qs}`
}

function appendLines(current: string[], incoming: string[]): string[] {
  if (incoming.length === 0) {
    return current
  }

  const next = [...current, ...incoming]
  if (next.length <= MAX_TERMINAL_LINES) {
    return next
  }
  return next.slice(-MAX_TERMINAL_LINES)
}

function toErrorMessage(error: unknown): string | null {
  if (!error) {
    return null
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export function useCommander() {
  const queryClient = useQueryClient()
  const [selectedCommanderId, setSelectedCommanderId] = useState<string | null>(null)
  const [terminalConnectionStatus, setTerminalConnectionStatus] =
    useState<CommanderWsStatus>('disconnected')
  const [terminalLines, setTerminalLines] = useState<string[]>([])
  const [terminalResetKey, setTerminalResetKey] = useState(0)
  const [heartbeatPulseAt, setHeartbeatPulseAt] = useState<number | null>(null)

  const selectedCommanderRef = useRef<string | null>(null)
  const previousHeartbeatRef = useRef<string | null>(null)

  const commandersQuery = useQuery({
    queryKey: COMMANDERS_QUERY_KEY,
    queryFn: fetchCommanders,
    refetchInterval: 5000,
  })

  const commanders = commandersQuery.data ?? []

  const selectedCommander = useMemo(
    () => commanders.find((session) => session.id === selectedCommanderId) ?? null,
    [commanders, selectedCommanderId],
  )

  const tasksQuery = useQuery({
    queryKey: ['commanders', 'tasks', selectedCommanderId ?? 'none'],
    queryFn: () => fetchCommanderTasks(selectedCommanderId!),
    enabled: Boolean(selectedCommanderId),
    refetchInterval: 10_000,
  })

  const cronsQuery = useQuery({
    queryKey: ['commanders', 'crons', selectedCommanderId ?? 'none'],
    queryFn: () => fetchCommanderCrons(selectedCommanderId!),
    enabled: Boolean(selectedCommanderId),
    refetchInterval: 10_000,
  })

  useEffect(() => {
    if (commanders.length === 0) {
      setSelectedCommanderId(null)
      return
    }

    if (!selectedCommanderId) {
      setSelectedCommanderId(commanders[0]?.id ?? null)
      return
    }

    const stillExists = commanders.some((session) => session.id === selectedCommanderId)
    if (!stillExists) {
      setSelectedCommanderId(commanders[0]?.id ?? null)
    }
  }, [commanders, selectedCommanderId])

  useEffect(() => {
    if (selectedCommanderRef.current === selectedCommanderId) {
      return
    }

    selectedCommanderRef.current = selectedCommanderId
    previousHeartbeatRef.current = null
    setTerminalLines([])
    setTerminalResetKey((value) => value + 1)
  }, [selectedCommanderId])

  useEffect(() => {
    const latestHeartbeat = selectedCommander?.lastHeartbeat ?? selectedCommander?.heartbeat?.lastSentAt ?? null
    if (!latestHeartbeat) {
      return
    }
    if (latestHeartbeat === previousHeartbeatRef.current) {
      return
    }

    previousHeartbeatRef.current = latestHeartbeat
    setHeartbeatPulseAt(Date.now())
  }, [selectedCommander?.lastHeartbeat, selectedCommander?.heartbeat?.lastSentAt])

  useEffect(() => {
    if (!selectedCommanderId || selectedCommander?.state !== 'running') {
      setTerminalConnectionStatus('disconnected')
      return
    }

    let socket: WebSocket | null = null
    let disposed = false
    let reconnectTimer: number | null = null
    const reconnectBackoff = createReconnectBackoff()

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) {
        return
      }

      setTerminalConnectionStatus('connecting')
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        void connect()
      }, reconnectBackoff.nextDelayMs())
    }

    const connect = async () => {
      clearReconnectTimer()
      setTerminalConnectionStatus('connecting')
      const token = await getAccessToken()
      if (disposed) {
        return
      }

      const nextSocket = new WebSocket(commanderWsUrl(selectedCommanderId, token))
      nextSocket.binaryType = 'arraybuffer'
      socket = nextSocket

      nextSocket.onopen = () => {
        if (disposed || socket !== nextSocket) {
          return
        }
        reconnectBackoff.reset()
        setTerminalConnectionStatus('connected')
      }

      nextSocket.onmessage = (event) => {
        if (disposed || socket !== nextSocket) {
          return
        }
        const lines = parseIncomingMessage(event.data)
        if (lines.length > 0) {
          setTerminalLines((current) => appendLines(current, lines))
        }
      }

      nextSocket.onerror = () => {
        if (disposed || socket !== nextSocket) {
          return
        }

        if (
          nextSocket.readyState === WebSocket.CONNECTING ||
          nextSocket.readyState === WebSocket.OPEN
        ) {
          nextSocket.close()
        }
      }

      nextSocket.onclose = (event) => {
        if (disposed || socket !== nextSocket) {
          return
        }

        socket = null
        if (shouldReconnectWebSocketClose(event)) {
          scheduleReconnect()
          return
        }

        setTerminalConnectionStatus('disconnected')
      }
    }

    void connect()

    return () => {
      disposed = true
      clearReconnectTimer()
      setTerminalConnectionStatus('disconnected')
      const activeSocket = socket
      socket = null
      if (
        activeSocket &&
        (activeSocket.readyState === WebSocket.CONNECTING ||
          activeSocket.readyState === WebSocket.OPEN)
      ) {
        activeSocket.close()
      }
    }
  }, [selectedCommanderId, selectedCommander?.state])

  const startMutation = useMutation({
    mutationFn: startCommanderSession,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY }),
        // Commander stream sessions live in the agents router; refresh so Chat → Agents sees the session.
        queryClient.invalidateQueries({ queryKey: ['agents', 'sessions'] }),
      ])
    },
  })

  const stopMutation = useMutation({
    mutationFn: stopCommanderSession,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY })
    },
  })

  const triggerHeartbeatMutation = useMutation({
    mutationFn: triggerCommanderHeartbeat,
    onSuccess: async (_data, commanderId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['commanders', 'heartbeat-log', commanderId] }),
      ])
    },
  })

  const sendMessageMutation = useMutation({
    mutationFn: sendCommanderMessage,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY })
    },
  })

  const assignTaskMutation = useMutation({
    mutationFn: assignCommanderTask,
    onSuccess: async (_data, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['commanders', 'tasks', input.commanderId] }),
      ])
    },
  })

  const createSessionMutation = useMutation({
    mutationFn: createCommanderSession,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY })
    },
  })

  const createCronMutation = useMutation({
    mutationFn: createCommanderCron,
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({ queryKey: ['commanders', 'crons', input.commanderId] })
    },
  })

  const toggleCronMutation = useMutation({
    mutationFn: toggleCommanderCron,
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({ queryKey: ['commanders', 'crons', input.commanderId] })
    },
  })

  const updateCronMutation = useMutation({
    mutationFn: updateCommanderCron,
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({ queryKey: ['commanders', 'crons', input.commanderId] })
    },
  })

  const deleteCronMutation = useMutation({
    mutationFn: deleteCommanderCron,
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({ queryKey: ['commanders', 'crons', input.commanderId] })
    },
  })

  const deleteSessionMutation = useMutation({
    mutationFn: deleteCommanderSession,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY })
    },
  })

  const updateProfileMutation = useMutation({
    mutationFn: updateCommanderProfile,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY })
    },
  })

  const uploadAvatarMutation = useMutation({
    mutationFn: uploadCommanderAvatar,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY })
    },
  })

  const createCommander = useCallback(
    async (input: CommanderCreateInput) => {
      await createSessionMutation.mutateAsync(input)
    },
    [createSessionMutation],
  )

  const startCommander = useCallback(
    async (commanderId: string, agentType?: CommanderAgentType) => {
      await startMutation.mutateAsync({ commanderId, agentType })
    },
    [startMutation],
  )

  const stopCommander = useCallback(
    async (commanderId: string) => {
      await stopMutation.mutateAsync(commanderId)
    },
    [stopMutation],
  )

  const triggerHeartbeat = useCallback(
    async (commanderId: string) => {
      await triggerHeartbeatMutation.mutateAsync(commanderId)
    },
    [triggerHeartbeatMutation],
  )

  const sendMessage = useCallback(
    async (input: CommanderMessageInput) => {
      await sendMessageMutation.mutateAsync(input)
    },
    [sendMessageMutation],
  )

  const assignTask = useCallback(
    async (input: CommanderTaskAssignInput) => {
      await assignTaskMutation.mutateAsync(input)
    },
    [assignTaskMutation],
  )

  const addCron = useCallback(
    async (input: CommanderCronCreateInput) => {
      await createCronMutation.mutateAsync(input)
    },
    [createCronMutation],
  )

  const toggleCron = useCallback(
    async (input: CommanderCronToggleInput) => {
      await toggleCronMutation.mutateAsync(input)
    },
    [toggleCronMutation],
  )

  const updateCron = useCallback(
    async (input: CommanderCronUpdateInput) => {
      await updateCronMutation.mutateAsync(input)
    },
    [updateCronMutation],
  )

  const deleteCron = useCallback(
    async (input: CommanderCronDeleteInput) => {
      await deleteCronMutation.mutateAsync(input)
    },
    [deleteCronMutation],
  )

  const deleteCommander = useCallback(
    async (commanderId: string) => {
      await deleteSessionMutation.mutateAsync(commanderId)
    },
    [deleteSessionMutation],
  )

  const updateProfile = useCallback(
    async (input: CommanderProfileUpdateInput) => {
      await updateProfileMutation.mutateAsync(input)
    },
    [updateProfileMutation],
  )

  const uploadAvatar = useCallback(
    async (input: CommanderAvatarUploadInput) => {
      await uploadAvatarMutation.mutateAsync(input)
    },
    [uploadAvatarMutation],
  )

  return {
    commanders,
    selectedCommanderId,
    selectedCommander,
    setSelectedCommanderId,
    commandersLoading: commandersQuery.isLoading,
    commandersError: toErrorMessage(commandersQuery.error),
    terminalConnectionStatus,
    terminalLines,
    terminalResetKey,
    heartbeatPulseAt,
    tasks: tasksQuery.data ?? [],
    tasksLoading: tasksQuery.isLoading,
    tasksError: toErrorMessage(tasksQuery.error),
    crons: cronsQuery.data ?? [],
    cronsLoading: cronsQuery.isLoading,
    cronsError: toErrorMessage(cronsQuery.error),
    createCommander,
    startCommander,
    stopCommander,
    triggerHeartbeat,
    sendMessage,
    assignTask,
    addCron,
    toggleCron,
    updateCron,
    deleteCron,
    deleteCommander,
    updateProfile,
    uploadAvatar,
    createCommanderPending: createSessionMutation.isPending,
    startPending: startMutation.isPending,
    stopPending: stopMutation.isPending,
    triggerHeartbeatPendingCommanderId: triggerHeartbeatMutation.isPending
      ? triggerHeartbeatMutation.variables ?? null
      : null,
    sendMessagePending: sendMessageMutation.isPending,
    assignTaskPending: assignTaskMutation.isPending,
    addCronPending: createCronMutation.isPending,
    toggleCronPending: toggleCronMutation.isPending,
    updateCronPending: updateCronMutation.isPending,
    deleteCronPending: deleteCronMutation.isPending,
    deleteCommanderPending: deleteSessionMutation.isPending,
    updateProfilePending: updateProfileMutation.isPending,
    uploadAvatarPending: uploadAvatarMutation.isPending,
    actionError:
      toErrorMessage(createSessionMutation.error) ??
      toErrorMessage(startMutation.error) ??
      toErrorMessage(stopMutation.error) ??
      toErrorMessage(triggerHeartbeatMutation.error) ??
      toErrorMessage(sendMessageMutation.error) ??
      toErrorMessage(assignTaskMutation.error) ??
      toErrorMessage(createCronMutation.error) ??
      toErrorMessage(toggleCronMutation.error) ??
      toErrorMessage(updateCronMutation.error) ??
      toErrorMessage(deleteCronMutation.error) ??
      toErrorMessage(deleteSessionMutation.error),
  }
}
