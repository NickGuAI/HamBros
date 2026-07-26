import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson, fetchVoid } from '../../../src/lib/api'
import type { AgentType } from '@/types'
import type { ClaudeAdaptiveThinkingMode } from '../../claude-adaptive-thinking.js'
import type { AgentEffortLevel } from '../../agents/effort.js'
import type { ClaudeMaxThinkingTokens } from '../../claude-max-thinking-tokens.js'
import type { CommanderPortraitStyleId } from '../portrait-styles'
import type { ConversationCredentialSelectionModes } from '../conversation-credential-selection.js'

export const COMMANDERS_QUERY_KEY = ['commanders', 'sessions'] as const
export const GLOBAL_COMMANDER_ID = '__global__'

export type CommanderState = 'idle' | 'running' | 'paused' | 'stopped'
export type CommanderAgentType = AgentType
export type CommanderContextMode = 'thin' | 'fat'

export interface CommanderHeartbeatConfig {
  intervalMs: number
  messageTemplate: string
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
  speakingTone?: string
  portraitStyleId?: CommanderPortraitStyleId
}

export interface CommanderSession {
  id: string
  host: string
  executionMachineId?: string
  credentialSelectionModes: ConversationCredentialSelectionModes
  /** Human-readable label set at creation time; falls back to host when absent */
  displayName?: string
  pid: number | null
  state: CommanderState
  created: string
  agentType?: CommanderAgentType
  model?: string | null
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  cwd?: string
  maxTurns?: number
  costCapUsd?: number | null
  contextMode?: CommanderContextMode
  heartbeat: CommanderHeartbeatConfig
  lastHeartbeat: string | null
  taskSource: CommanderTaskSource | null
  currentTask: CommanderCurrentTask | null
  completedTasks: number
  questCount: number
  scheduleCount: number
  totalCostUsd: number
  monthlyCostUsd?: number
  archived?: boolean
  archivedAt?: string
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
  name?: string
  commanderId?: string
  description?: string
  schedule: string
  timezone?: string
  instruction: string
  enabled: boolean
  lastRun: string | null
  lastRunStatus?: 'running' | 'complete' | 'failed' | 'timeout'
  nextRun: string | null
  eventBridgeRuleArn?: string
  agentType?: CommanderAgentType
  sessionType?: 'stream' | 'pty'
  permissionMode?: string
  workDir?: string
  machine?: string
  model?: string
  createdAt?: string
}

export interface CommanderCreateInput {
  host: string
  executionMachineId?: string
  displayName?: string
  agentType?: CommanderAgentType
  model?: string | null
  effort?: AgentEffortLevel
  cwd?: string
  identityOperatingStyle?: string
  avatarSeed?: string
  maxTurns?: number
  contextMode?: CommanderContextMode
  heartbeat?: {
    intervalMs: number
    messageTemplate?: string
  }
  contextConfig?: {
    fatPinInterval?: number
  }
  taskSource?: { owner: string; repo: string; label?: string; project?: string }
}

export interface CommanderProfileUpdateInput {
  commanderId: string
  speakingTone?: string
  effort?: AgentEffortLevel
  portraitStyleId?: CommanderPortraitStyleId
}

export interface CommanderAvatarUploadInput {
  commanderId: string
  file: File
}

export interface CommanderAvatarGenerateInput {
  commanderId: string
  styleId?: CommanderPortraitStyleId
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

export interface CommanderCronCreateInput {
  commanderId?: string
  name?: string
  schedule: string
  instruction: string
  enabled?: boolean
  agentType?: CommanderAgentType
  sessionType?: 'stream' | 'pty'
  permissionMode?: string
  workDir?: string
  machine?: string
}

interface CommanderCronToggleInput {
  commanderId?: string
  cronId: string
  enabled: boolean
}

interface CommanderCronUpdateInput {
  commanderId?: string
  cronId: string
  name?: string
  description?: string
  instruction?: string
  schedule?: string
  timezone?: string
  enabled?: boolean
  agentType?: CommanderAgentType
  sessionType?: 'stream' | 'pty'
  permissionMode?: string
  workDir?: string
  machine?: string
  model?: string
}

interface CommanderCronDeleteInput {
  commanderId?: string
  cronId: string
}

interface AutomationRouteResponse {
  id: string
  name: string
  parentCommanderId?: string | null
  description?: string
  trigger: 'schedule' | 'quest' | 'manual'
  schedule: string
  timezone?: string
  instruction: string
  status: 'active' | 'paused' | 'completed' | 'cancelled'
  createdAt: string
  nextRun?: string | null
  lastRun?: string | null
  lastRunAt?: string | null
  lastRunStatus?: 'running' | 'complete' | 'failed' | 'timeout' | null
  agentType?: CommanderAgentType
  sessionType?: 'stream' | 'pty'
  permissionMode?: string
  workDir?: string
  machine?: string
  model?: string
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
  const searchParams = new URLSearchParams({
    parentCommanderId: commanderId,
    trigger: 'schedule',
  })
  const automations = await fetchJson<AutomationRouteResponse[]>(`/api/automations?${searchParams.toString()}`)
  return automations
    .filter((automation) => automation.trigger === 'schedule')
    .map(toCommanderCronTask)
}

async function fetchGlobalCrons(): Promise<CommanderCronTask[]> {
  const searchParams = new URLSearchParams({
    parentCommanderId: 'null',
    trigger: 'schedule',
  })
  const automations = await fetchJson<AutomationRouteResponse[]>(`/api/automations?${searchParams.toString()}`)
  return automations
    .filter((automation) => automation.trigger === 'schedule')
    .map(toCommanderCronTask)
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
  const created = await fetchJson<AutomationRouteResponse>('/api/automations', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: input.name?.trim() || (input.commanderId ? `commander-${input.commanderId}-cron` : 'global-cron'),
      parentCommanderId: input.commanderId ?? null,
      trigger: 'schedule',
      schedule: input.schedule,
      instruction: input.instruction,
      status: input.enabled === false ? 'paused' : 'active',
      machine: input.machine?.trim() ?? '',
      workDir: input.workDir?.trim() ?? '',
      ...(input.agentType ? { agentType: input.agentType } : {}),
      sessionType: input.sessionType,
      permissionMode: input.permissionMode,
      model: undefined,
    }),
  })
  return toCommanderCronTask(created)
}

async function toggleCommanderCron(input: CommanderCronToggleInput): Promise<CommanderCronTask> {
  const updated = await fetchJson<AutomationRouteResponse>(
    `/api/automations/${encodeURIComponent(input.cronId)}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: input.enabled ? 'active' : 'paused',
      }),
    },
  )
  return toCommanderCronTask(updated)
}

async function updateCommanderCron(input: CommanderCronUpdateInput): Promise<CommanderCronTask> {
  const updated = await fetchJson<AutomationRouteResponse>(
    `/api/automations/${encodeURIComponent(input.cronId)}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        instruction: input.instruction,
        schedule: input.schedule,
        timezone: input.timezone,
        status: input.enabled === undefined ? undefined : (input.enabled ? 'active' : 'paused'),
        agentType: input.agentType,
        sessionType: input.sessionType,
        permissionMode: input.permissionMode,
        workDir: input.workDir,
        machine: input.machine,
        model: input.model,
      }),
    },
  )
  return toCommanderCronTask(updated)
}

async function deleteCommanderCron(input: CommanderCronDeleteInput): Promise<void> {
  return fetchVoid(`/api/automations/${encodeURIComponent(input.cronId)}`, {
    method: 'DELETE',
  })
}

async function triggerCommanderCron(cronId: string) {
  return fetchJson(`/api/automations/${encodeURIComponent(cronId)}/run`, {
    method: 'POST',
  })
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
      speakingTone: input.speakingTone,
      effort: input.effort,
      portraitStyleId: input.portraitStyleId,
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

export async function generateCommanderAvatar(
  input: CommanderAvatarGenerateInput,
): Promise<{ avatarUrl: string }> {
  return fetchJson<{ avatarUrl: string }>(
    `/api/commanders/${encodeURIComponent(input.commanderId)}/avatar/generate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ styleId: input.styleId }),
    },
  )
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

export function isGlobalCommanderId(commanderId: string | null | undefined): boolean {
  return commanderId === GLOBAL_COMMANDER_ID
}

function toCommanderCronTask(task: AutomationRouteResponse): CommanderCronTask {
  return {
    id: task.id,
    name: task.name,
    commanderId: task.parentCommanderId ?? undefined,
    description: task.description,
    schedule: task.schedule,
    timezone: task.timezone,
    instruction: task.instruction,
    enabled: task.status === 'active',
    lastRun: task.lastRun ?? null,
    lastRunStatus: undefined,
    nextRun: task.nextRun ?? null,
    agentType: task.agentType,
    sessionType: task.sessionType,
    permissionMode: task.permissionMode,
    workDir: task.workDir,
    machine: task.machine,
    model: task.model,
    createdAt: task.createdAt,
  }
}

export function useCommander() {
  const queryClient = useQueryClient()
  const [selectedCommanderId, setSelectedCommanderId] = useState<string | null>(null)

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
    enabled: Boolean(selectedCommanderId) && !isGlobalCommanderId(selectedCommanderId),
    refetchInterval: 10_000,
  })

  const cronsQuery = useQuery({
    queryKey: ['commanders', 'crons', selectedCommanderId ?? 'none'],
    queryFn: () => (
      isGlobalCommanderId(selectedCommanderId)
        ? fetchGlobalCrons()
        : fetchCommanderCrons(selectedCommanderId!)
    ),
    enabled: Boolean(selectedCommanderId),
    refetchInterval: 10_000,
  })

  useEffect(() => {
    if (commanders.length === 0) {
      if (!isGlobalCommanderId(selectedCommanderId)) {
        setSelectedCommanderId(null)
      }
      return
    }

    if (!selectedCommanderId) {
      setSelectedCommanderId(commanders[0]?.id ?? null)
      return
    }

    if (isGlobalCommanderId(selectedCommanderId)) {
      return
    }

    const stillExists = commanders.some((session) => session.id === selectedCommanderId)
    if (!stillExists) {
      setSelectedCommanderId(commanders[0]?.id ?? null)
    }
  }, [commanders, selectedCommanderId])

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
    onSuccess: async (createdCommander) => {
      queryClient.setQueryData<CommanderSession[]>(COMMANDERS_QUERY_KEY, (current) => {
        if (!current) {
          return [createdCommander]
        }

        const next = current.filter((commander) => commander.id !== createdCommander.id)
        next.push(createdCommander)
        return next
      })
      await queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY })
    },
  })

  const createCronMutation = useMutation({
    mutationFn: createCommanderCron,
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({
        queryKey: ['commanders', 'crons', input.commanderId ?? GLOBAL_COMMANDER_ID],
      })
    },
  })

  const toggleCronMutation = useMutation({
    mutationFn: toggleCommanderCron,
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({
        queryKey: ['commanders', 'crons', input.commanderId ?? GLOBAL_COMMANDER_ID],
      })
    },
  })

  const updateCronMutation = useMutation({
    mutationFn: updateCommanderCron,
    onSuccess: async (_data, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['commanders', 'crons', input.commanderId ?? GLOBAL_COMMANDER_ID],
        }),
        queryClient.invalidateQueries({ queryKey: ['command-room', 'runs', input.cronId] }),
      ])
    },
  })

  const triggerCronMutation = useMutation({
    mutationFn: triggerCommanderCron,
    onSuccess: async (_data, cronId) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['commanders', 'crons', selectedCommanderId ?? GLOBAL_COMMANDER_ID],
        }),
        queryClient.invalidateQueries({ queryKey: ['command-room', 'runs', cronId] }),
      ])
    },
  })

  const deleteCronMutation = useMutation({
    mutationFn: deleteCommanderCron,
    onSuccess: async (_data, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['commanders', 'crons', input.commanderId ?? GLOBAL_COMMANDER_ID],
        }),
        queryClient.invalidateQueries({ queryKey: ['command-room', 'runs', input.cronId] }),
      ])
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

  const generateAvatarMutation = useMutation({
    mutationFn: generateCommanderAvatar,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: COMMANDERS_QUERY_KEY })
    },
  })

  const createCommander = useCallback(
    async (input: CommanderCreateInput) => {
      return createSessionMutation.mutateAsync(input)
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

  const triggerCron = useCallback(
    async (cronId: string) => {
      await triggerCronMutation.mutateAsync(cronId)
    },
    [triggerCronMutation],
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

  const generateAvatar = useCallback(
    async (input: CommanderAvatarGenerateInput) => {
      return generateAvatarMutation.mutateAsync(input)
    },
    [generateAvatarMutation],
  )

  return {
    commanders,
    selectedCommanderId,
    selectedCommander,
    setSelectedCommanderId,
    commandersLoading: commandersQuery.isLoading,
    commandersError: toErrorMessage(commandersQuery.error),
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
    triggerCron,
    deleteCron,
    deleteCommander,
    updateProfile,
    uploadAvatar,
    generateAvatar,
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
    toggleCronId: toggleCronMutation.isPending ? toggleCronMutation.variables?.cronId ?? null : null,
    updateCronPending: updateCronMutation.isPending,
    updateCronId: updateCronMutation.isPending ? updateCronMutation.variables?.cronId ?? null : null,
    triggerCronPending: triggerCronMutation.isPending,
    triggerCronId: triggerCronMutation.isPending ? triggerCronMutation.variables ?? null : null,
    deleteCronPending: deleteCronMutation.isPending,
    deleteCronId: deleteCronMutation.isPending ? deleteCronMutation.variables?.cronId ?? null : null,
    deleteCommanderPending: deleteSessionMutation.isPending,
    updateProfilePending: updateProfileMutation.isPending,
    uploadAvatarPending: uploadAvatarMutation.isPending,
    generateAvatarPending: generateAvatarMutation.isPending,
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
      toErrorMessage(triggerCronMutation.error) ??
      toErrorMessage(deleteCronMutation.error) ??
      toErrorMessage(deleteSessionMutation.error) ??
      toErrorMessage(generateAvatarMutation.error),
  }
}
