import type { HammurabiEvent } from './hammurabi-events.js'
import type { ClaudeEffortLevel } from '../../modules/claude-effort.js'
export type { HammurabiEvent, HammurabiEventSource } from './hammurabi-events.js'

// Module system types
export interface FrontendModule {
  name: string
  label: string
  icon: string
  path: string
  hideFromNav?: boolean
  component: () => Promise<{ default: React.ComponentType }>
}

// Agents types
export type AgentType = 'claude' | 'codex' | 'gemini' | 'openclaw'

export type AgentSessionStatus = 'active' | 'idle' | 'stale' | 'completed' | 'exited'

export interface AgentWorkerSummary {
  total: number
  starting: number
  running: number
  down: number
  done: number
}

export interface AgentSession {
  name: string
  label?: string
  created: string
  pid: number
  sessionType?: SessionType
  agentType?: AgentType
  effort?: ClaudeEffortLevel
  cwd?: string
  host?: string
  parentSession?: string
  spawnedWorkers?: string[]
  workerSummary?: AgentWorkerSummary
  processAlive?: boolean
  hadResult?: boolean
  resumedFrom?: string
  status?: AgentSessionStatus
  resumeAvailable?: boolean
}

// hamRPG world types
export const AGENT_PHASES = ['FORGE', 'LIBRARY', 'ARMORY', 'DUNGEON', 'THRONE_ROOM', 'GATE'] as const
export type AgentPhase = (typeof AGENT_PHASES)[number]

export type WorldAgentStatus = 'active' | 'idle' | 'stale' | 'completed'
export type WorldAgentRuntimePhase = 'idle' | 'executing' | 'editing' | 'researching' | 'delegating'

export interface WorldAgent {
  id: string
  sessionType: SessionType
  agentType: AgentType
  status: WorldAgentStatus
  phase: WorldAgentRuntimePhase
  zone?: AgentPhase
  usage: {
    inputTokens: number
    outputTokens: number
    costUsd: number
  }
  quest: string
  lastUpdatedAt: string
  spawnPos: {
    x: number
    y: number
  }
}

export interface Machine {
  id: string
  label: string
  host: string | null
  user?: string
  port?: number
  cwd?: string
}

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'dangerouslySkipPermissions'

export type SessionType = 'pty' | 'stream'

export interface CreateSessionInput {
  name: string
  mode: ClaudePermissionMode
  task?: string
  cwd?: string
  sessionType?: SessionType
  agentType?: AgentType
  effort?: ClaudeEffortLevel
  host?: string
  agentId?: string
  resumeFromSession?: string
}

// AskUserQuestion types
export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestion {
  question: string
  header: string
  options: AskOption[]
  multiSelect: boolean
}

// Stream events in the agents UI now use the shared Hammurabi contract.
export type StreamEvent = HammurabiEvent

// Telemetry types
export type SessionStatus = 'active' | 'idle' | 'stale' | 'completed'

export interface TelemetrySession {
  id: string
  agentName: string
  model: string
  currentTask: string
  status: SessionStatus
  startedAt: string
  lastHeartbeat: string
  totalCost: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  callCount: number
}

export interface TelemetryCall {
  id: string
  sessionId: string
  timestamp: string
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
  durationMs: number
}

export interface TelemetrySummary {
  costToday: number
  costWeek: number
  costMonth: number
  costPeriod?: number
  inputTokensToday: number
  inputTokensWeek: number
  inputTokensMonth: number
  inputTokensPeriod?: number
  outputTokensToday: number
  outputTokensWeek: number
  outputTokensMonth: number
  outputTokensPeriod?: number
  totalTokensToday: number
  totalTokensWeek: number
  totalTokensMonth: number
  totalTokensPeriod?: number
  activeSessions: number
  totalSessions: number
  topModels: { model: string; cost: number; calls: number }[]
  topAgents: { agent: string; cost: number; sessions: number }[]
  dailyCosts: { date: string; costUsd: number }[]
  period?: string
  periodStartKey?: string
  periodEndKey?: string
  retentionDays?: number
  periodOutsideRetention?: boolean
}

// Services types
export type ServiceStatus = 'running' | 'degraded' | 'stopped'

export interface ServiceInfo {
  name: string
  port: number
  script: string
  status: ServiceStatus
  healthy: boolean
  listening: boolean
  healthUrl: string
  lastChecked: string
}

export interface SystemMetrics {
  cpuCount: number
  loadAvg: [number, number, number]
  memTotalBytes: number
  memFreeBytes: number
  memUsedPercent: number
}

export type VercelDeploymentStatus =
  | 'READY'
  | 'BUILDING'
  | 'ERROR'
  | 'QUEUED'
  | 'CANCELED'
  | 'INITIALIZING'
  | 'UNKNOWN'

export interface VercelDeploymentInfo {
  id: string
  name: string
  url: string | null
  status: VercelDeploymentStatus
  branch: string | null
  commitSha: string | null
  createdAt: string | null
}

export interface VercelProjectInfo {
  id: string
  name: string
  framework: string | null
  productionBranch: string | null
  latestDeployment: VercelDeploymentInfo | null
}

// Factory types
export interface FactoryRepo {
  owner: string
  repo: string
  path: string
  commitHash: string
}

export interface FactoryWorktree {
  feature: string
  path: string
  branch: string
}
