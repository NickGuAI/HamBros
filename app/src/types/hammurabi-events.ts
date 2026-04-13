export type HammurabiEventProvider = 'claude' | 'codex' | 'gemini' | 'openclaw'

export type HammurabiEventBackend = 'cli' | 'stream-json' | 'acp' | 'rpc' | 'gateway'

export interface HammurabiEventSource {
  provider: HammurabiEventProvider
  backend: HammurabiEventBackend
  normalizedAt?: string
  schemaVersion?: string
}

export interface HammurabiUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface HammurabiToolUseBlock {
  type: 'tool_use'
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export interface HammurabiToolResultBlock {
  type: 'tool_result'
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

export interface HammurabiTextBlock {
  type: 'text'
  text?: string
}

export interface HammurabiThinkingBlock {
  type: 'thinking'
  thinking?: string
  text?: string
}

export interface HammurabiImageBlock {
  type: 'image'
  source?: {
    type?: string
    media_type?: string
    data?: string
  }
}

export type HammurabiAssistantContentBlock =
  | HammurabiTextBlock
  | HammurabiThinkingBlock
  | HammurabiToolUseBlock

export type HammurabiUserContentBlock =
  | HammurabiToolResultBlock
  | HammurabiTextBlock
  | HammurabiImageBlock

interface HammurabiEventBase {
  source?: HammurabiEventSource
  [key: string]: unknown
}

export interface PlanningStreamEvent extends HammurabiEventBase {
  type: 'planning'
  action: 'enter' | 'proposed' | 'decision'
  plan?: string
  approved?: boolean | null
  message?: string
}

export type HammurabiEvent =
  | (PlanningStreamEvent & HammurabiEventBase)
  | ({
      type: 'message_start'
      message: { id: string; role: string }
    } & HammurabiEventBase)
  | ({
      type: 'content_block_start'
      index?: number
      content_block: HammurabiTextBlock | HammurabiThinkingBlock | HammurabiToolUseBlock
    } & HammurabiEventBase)
  | ({
      type: 'content_block_delta'
      index?: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
    } & HammurabiEventBase)
  | ({
      type: 'content_block_stop'
      index?: number
    } & HammurabiEventBase)
  | ({
      type: 'message_delta'
      delta?: { stop_reason?: string }
      usage?: HammurabiUsage
      usage_is_total?: boolean
      cost_usd?: number
      total_cost_usd?: number
    } & HammurabiEventBase)
  | ({
      type: 'message_stop'
    } & HammurabiEventBase)
  | ({
      type: 'assistant'
      message: {
        id: string
        role: 'assistant'
        content: HammurabiAssistantContentBlock[]
        usage?: HammurabiUsage
      }
    } & HammurabiEventBase)
  | ({
      type: 'user'
      message: {
        role: 'user'
        content: string | HammurabiUserContentBlock[]
      }
      tool_use_result?: {
        stdout?: string
        stderr?: string
        interrupted?: boolean
        isImage?: boolean
        noOutputExpected?: boolean
      }
    } & HammurabiEventBase)
  | ({
      type: 'result'
      result: string
      subtype?: string
      is_error?: boolean
      duration_ms?: number
      duration_api_ms?: number
      num_turns?: number
      usage?: HammurabiUsage
      cost_usd?: number
      total_cost_usd?: number
    } & HammurabiEventBase)
  | ({
      type: 'exit'
      exitCode: number
      signal?: string | number
    } & HammurabiEventBase)
  | ({
      type: 'system'
      text?: string
      subtype?: string
      description?: string
      last_tool_name?: string
    } & HammurabiEventBase)
  | ({
      type: 'agent'
      message?: unknown
      text?: unknown
    } & HammurabiEventBase)
  | ({
      type: 'rate_limit_event'
    } & HammurabiEventBase)
  | ({
      type: 'tool_use'
      id?: string
      name?: string
      input?: Record<string, unknown>
    } & HammurabiEventBase)
  | ({
      type: 'tool_result'
      tool_use_id?: string
      content?: string
      is_error?: boolean
    } & HammurabiEventBase)
