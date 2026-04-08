export type SentinelStatus = 'active' | 'paused' | 'completed' | 'cancelled'

export type SentinelAgentType = 'claude' | 'codex'

export interface SentinelHistoryEntry {
  timestamp: string
  action: string
  result: string
  costUsd: number
  durationSec: number
  sessionId?: string
  runFile?: string
  memoryUpdated?: boolean
  source?: 'cron' | 'manual'
}

export interface Sentinel {
  id: string
  name: string
  instruction: string
  schedule: string
  timezone?: string
  status: SentinelStatus
  agentType: SentinelAgentType
  permissionMode: string
  model?: string
  parentCommanderId: string
  skills: string[]
  seedMemory: string
  memoryPath: string
  outputDir: string
  workDir: string
  maxRuns?: number
  createdAt: string
  lastRun: string | null
  totalRuns: number
  totalCostUsd: number
  history: SentinelHistoryEntry[]
  observations?: string[]
}

export interface CreateSentinelInput {
  parentCommanderId: string
  name: string
  instruction: string
  schedule: string
  timezone?: string
  agentType?: SentinelAgentType
  permissionMode?: string
  model?: string
  skills?: string[]
  seedMemory?: string
  workDir?: string
  maxRuns?: number
  status?: SentinelStatus
  observations?: string[]
}

export interface UpdateSentinelInput {
  name?: string
  instruction?: string
  schedule?: string
  timezone?: string
  status?: SentinelStatus
  agentType?: SentinelAgentType
  permissionMode?: string
  model?: string
  skills?: string[]
  seedMemory?: string
  workDir?: string
  maxRuns?: number
  observations?: string[]
  lastRun?: string | null
  totalRuns?: number
  totalCostUsd?: number
}

export interface SentinelRunMetadata {
  sentinelId: string
  sentinelName: string
  runNumber: number
  timestamp: string
  action: string
  result: string
  costUsd: number
  durationSec: number
  sessionId: string
  memoryUpdated: boolean
  status: 'complete' | 'failed' | 'timeout'
  source: 'cron' | 'manual'
}
