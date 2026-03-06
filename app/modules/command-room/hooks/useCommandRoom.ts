import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'

const TASKS_QUERY_KEY = ['command-room', 'tasks'] as const
const RUNS_QUERY_KEY = (taskId: string | null) => ['command-room', 'runs', taskId] as const

export type CommandRoomAgentType = 'claude' | 'codex'
export type WorkflowRunStatus = 'running' | 'complete' | 'failed' | 'timeout'

export interface CronTask {
  id: string
  name: string
  schedule: string
  timezone?: string
  machine: string
  workDir: string
  agentType: CommandRoomAgentType
  instruction: string
  enabled: boolean
  createdAt: string
  nextRun?: string | null
  lastRunStatus: WorkflowRunStatus | null
  lastRunAt: string | null
  permissionMode?: string
  sessionType?: 'stream' | 'pty'
}

export interface WorkflowRun {
  id: string
  cronTaskId: string
  startedAt: string
  completedAt: string | null
  status: WorkflowRunStatus
  report: string
  costUsd: number
  sessionId: string
}

export interface CreateCronTaskInput {
  name: string
  schedule: string
  timezone?: string
  machine: string
  workDir: string
  agentType: CommandRoomAgentType
  instruction: string
  enabled: boolean
  permissionMode?: string
  sessionType?: 'stream' | 'pty'
}

export interface UpdateCronTaskInput {
  taskId: string
  patch: Partial<Omit<CreateCronTaskInput, 'enabled'> & { enabled: boolean }>
}

async function fetchTasks(): Promise<CronTask[]> {
  return fetchJson<CronTask[]>('/api/command-room/tasks')
}

async function fetchRuns(taskId: string): Promise<WorkflowRun[]> {
  return fetchJson<WorkflowRun[]>(`/api/command-room/tasks/${encodeURIComponent(taskId)}/runs`)
}

export function useCommandRoom() {
  const queryClient = useQueryClient()
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  const tasksQuery = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: fetchTasks,
    refetchInterval: 10_000,
  })

  const runsQuery = useQuery({
    queryKey: RUNS_QUERY_KEY(selectedTaskId),
    queryFn: () => fetchRuns(selectedTaskId!),
    enabled: Boolean(selectedTaskId),
    refetchInterval: (query) => {
      const runs = query.state.data as WorkflowRun[] | undefined
      return runs?.some((run) => run.status === 'running') ? 2_000 : 10_000
    },
  })

  useEffect(() => {
    const tasks = tasksQuery.data ?? []
    if (tasks.length === 0) {
      if (selectedTaskId !== null) {
        setSelectedTaskId(null)
      }
      return
    }

    if (!selectedTaskId) {
      setSelectedTaskId(tasks[0]?.id ?? null)
      return
    }

    if (!tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(tasks[0]?.id ?? null)
    }
  }, [tasksQuery.data, selectedTaskId])

  const createTaskMutation = useMutation({
    mutationFn: (input: CreateCronTaskInput) =>
      fetchJson<CronTask>('/api/command-room/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: async (created) => {
      setSelectedTaskId(created.id)
      await queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY })
    },
  })

  const updateTaskMutation = useMutation({
    mutationFn: (input: UpdateCronTaskInput) =>
      fetchJson<CronTask>(`/api/command-room/tasks/${encodeURIComponent(input.taskId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input.patch),
      }),
    onSuccess: async (_updated, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: RUNS_QUERY_KEY(input.taskId) }),
      ])
    },
  })

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) =>
      fetchJson(`/api/command-room/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
      }),
    onSuccess: async (_result, taskId) => {
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null)
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: RUNS_QUERY_KEY(taskId) }),
      ])
    },
  })

  const triggerTaskMutation = useMutation({
    mutationFn: (taskId: string) =>
      fetchJson<WorkflowRun>(`/api/command-room/tasks/${encodeURIComponent(taskId)}/trigger`, {
        method: 'POST',
      }),
    onSuccess: async (_run, taskId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: RUNS_QUERY_KEY(taskId) }),
      ])
    },
  })

  const selectedTask = useMemo(
    () => (tasksQuery.data ?? []).find((task) => task.id === selectedTaskId) ?? null,
    [tasksQuery.data, selectedTaskId],
  )

  const tasksError = tasksQuery.error instanceof Error ? tasksQuery.error.message : null
  const runsError = runsQuery.error instanceof Error ? runsQuery.error.message : null
  const actionError = createTaskMutation.error instanceof Error
    ? createTaskMutation.error.message
    : updateTaskMutation.error instanceof Error
      ? updateTaskMutation.error.message
      : deleteTaskMutation.error instanceof Error
        ? deleteTaskMutation.error.message
        : triggerTaskMutation.error instanceof Error
          ? triggerTaskMutation.error.message
          : null

  return {
    tasks: tasksQuery.data ?? [],
    tasksLoading: tasksQuery.isLoading,
    tasksError,
    selectedTaskId,
    selectedTask,
    setSelectedTaskId,
    runs: runsQuery.data ?? [],
    runsLoading: Boolean(selectedTaskId) && runsQuery.isLoading,
    runsError,
    actionError,
    createTask: createTaskMutation.mutateAsync,
    updateTask: updateTaskMutation.mutateAsync,
    deleteTask: deleteTaskMutation.mutateAsync,
    triggerTask: triggerTaskMutation.mutateAsync,
    createTaskPending: createTaskMutation.isPending,
    updateTaskPending: updateTaskMutation.isPending,
    updateTaskId: updateTaskMutation.variables?.taskId ?? null,
    deleteTaskPending: deleteTaskMutation.isPending,
    deleteTaskId: deleteTaskMutation.variables ?? null,
    triggerTaskPending: triggerTaskMutation.isPending,
    triggerTaskId: triggerTaskMutation.variables ?? null,
  }
}
