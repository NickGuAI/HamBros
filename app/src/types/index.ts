// Module system types
export interface FrontendModule {
  name: string
  label: string
  icon: string
  path: string
  component: () => Promise<{ default: React.ComponentType }>
}

// Agents types
export type AgentType = 'claude' | 'codex'

export interface AgentSession {
  name: string
  created: string
  pid: number
  sessionType?: SessionType
  agentType?: AgentType
  cwd?: string
  host?: string
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
  host?: string
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

// Stream-JSON event types emitted by `claude --output-format stream-json`
export type StreamEvent =
  // Legacy fine-grained streaming events
  | { type: 'message_start'; message: { id: string; role: string } }
  | {
      type: 'content_block_start'
      index: number
      content_block: { type: 'text' } | { type: 'thinking' } | { type: 'tool_use'; id: string; name: string }
    }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string }; usage?: { input_tokens?: number; output_tokens?: number } }
  | { type: 'message_stop' }
  // Newer envelope-style events
  | {
      type: 'assistant'
      message: {
        id: string
        role: 'assistant'
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'thinking'; thinking?: string; text?: string }
          | { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
        >
        usage?: { input_tokens?: number; output_tokens?: number }
      }
    }
  | {
      type: 'user'
      message: {
        role: 'user'
        content: Array<{ type: 'tool_result'; tool_use_id?: string; content?: string; is_error?: boolean }>
      }
      tool_use_result?: { stdout?: string; stderr?: string; interrupted?: boolean; isImage?: boolean; noOutputExpected?: boolean }
    }
  | {
      type: 'result'
      result: string
      is_error?: boolean
      duration_ms?: number
      duration_api_ms?: number
      num_turns?: number
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
      cost_usd?: number
      total_cost_usd?: number
    }
  | { type: 'exit'; exitCode: number; signal?: string | number }
  | { type: 'system'; text: string }

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
  activeSessions: number
  totalSessions: number
  topModels: { model: string; cost: number; calls: number }[]
  topAgents: { agent: string; cost: number; sessions: number }[]
  dailyCosts: { date: string; costUsd: number }[]
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
