/** Supported agent providers */
export type AgentProvider = 'claude' | 'codex'

/** MCP server configuration (stdio or remote) */
export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: 'sse' | 'http' | 'sdk'
  url?: string
  headers?: Record<string, string>
  instance?: unknown
}

/** Settings for agentCall */
export interface AgentCallSettings {
  /** Model identifier (provider-specific) */
  model?: string
  /** System prompt for the agent */
  systemPrompt?: string
  /** Passive mode: bypass all permission checks and run fully automated */
  passive?: boolean
  /** Resume a previous session by ID */
  sessionId?: string
  /** Working directory for agent operations */
  cwd?: string
  /** Maximum number of turns before stopping */
  maxTurns?: number
  /** Tool allow-list */
  tools?: string[]
  /** Tool deny-list */
  disallowedTools?: string[]
  /** MCP servers to attach */
  mcpServers?: Record<string, McpServerConfig>
  /** Maximum budget in USD (Claude only) */
  maxBudgetUsd?: number
}

/** Normalized event emitted by agentCall */
export interface AgentEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'usage' | 'session' | 'done' | 'error'
  /** Text content (for type=text, type=error) */
  content?: string
  /** Tool name (for type=tool_use) */
  toolName?: string
  /** Tool input (for type=tool_use) */
  toolInput?: unknown
  /** Tool output (for type=tool_result) */
  toolOutput?: string
  /** Token usage (for type=usage) */
  usage?: AgentUsage
  /** Session ID (for type=session) */
  sessionId?: string
  /** Raw event from the underlying SDK for advanced consumers */
  raw?: unknown
}

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
}
