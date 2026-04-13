/**
 * Canonical Hammurabi transcript/event types.
 *
 * `StreamEvent` in `src/types/index.ts` intentionally remains the legacy,
 * provider-shaped contract for existing consumers. These types define the
 * Hammurabi-owned, transport-agnostic contract that future normalizers and
 * transcript readers should target instead while keeping today's payload
 * shapes close to the legacy stream events for incremental migration.
 */

export type HammurabiProvider = 'claude' | 'codex' | 'gemini' | 'openclaw'

export type HammurabiBackend = 'stream-json' | 'acp' | 'rpc' | 'gateway'

export interface HammurabiEventSource {
  provider: HammurabiProvider
  backend: HammurabiBackend
  normalizedAt?: string
  schemaVersion?: string
}

export interface HammurabiUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface HammurabiMessageRef {
  id: string
  role: string
}

export interface HammurabiToolUse {
  type: 'tool_use'
  id?: string
  name: string
  input?: Record<string, unknown>
}

export interface HammurabiToolResult {
  type: 'tool_result'
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

export interface HammurabiToolExecution {
  stdout?: string
  stderr?: string
  interrupted?: boolean
  isImage?: boolean
  noOutputExpected?: boolean
}

export interface HammurabiImageSource {
  type?: string
  media_type?: string
  data?: string
}

export type HammurabiContentBlock =
  | { type: 'text' }
  | { type: 'thinking' }
  | HammurabiToolUse

export type HammurabiContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'input_json_delta'; partial_json: string }

export type HammurabiAssistantContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking?: string; text?: string }
  | HammurabiToolUse

export type HammurabiUserContent =
  | HammurabiToolResult
  | { type: 'text'; text: string }
  | { type: 'image'; source?: HammurabiImageSource }

export interface HammurabiAssistantMessage {
  id: string
  role: 'assistant'
  content: HammurabiAssistantContent[]
  usage?: HammurabiUsage
}

export interface HammurabiUserMessage {
  role: 'user'
  content: string | HammurabiUserContent[]
}

export interface HammurabiMessageStartEvent {
  type: 'message_start'
  message: HammurabiMessageRef
}

export interface HammurabiContentStartEvent {
  type: 'content_block_start'
  index?: number
  content_block: HammurabiContentBlock
}

export interface HammurabiContentDeltaEvent {
  type: 'content_block_delta'
  index?: number
  delta: HammurabiContentDelta
}

export interface HammurabiContentStopEvent {
  type: 'content_block_stop'
  index?: number
}

export interface HammurabiMessageDeltaEvent {
  type: 'message_delta'
  delta?: { stop_reason?: string }
  usage?: HammurabiUsage
  usage_is_total?: boolean
  cost_usd?: number
  total_cost_usd?: number
}

export interface HammurabiMessageStopEvent {
  type: 'message_stop'
}

export interface HammurabiAssistantMessageEvent {
  type: 'assistant'
  message: HammurabiAssistantMessage
}

export interface HammurabiUserMessageEvent {
  type: 'user'
  message: HammurabiUserMessage
  tool_use_result?: HammurabiToolExecution
}

export interface HammurabiToolUseEvent extends HammurabiToolUse {
  type: 'tool_use'
}

export interface HammurabiToolResultEvent extends HammurabiToolResult {
  type: 'tool_result'
  tool_use_id: string
}

export type PlanningEvent =
  | { type: 'planning.enter' }
  | { type: 'planning.proposed'; plan: string }
  | { type: 'planning.updated'; plan?: string; steps?: unknown[] }
  | { type: 'planning.decision'; approved: boolean | null; message?: string }

export interface HammurabiResultEvent {
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
}

export interface HammurabiExitEvent {
  type: 'exit'
  exitCode: number
  signal?: string | number
}

export interface HammurabiSystemEvent {
  type: 'system'
  text?: string
  subtype?: string
  description?: string
  last_tool_name?: string
}

export interface HammurabiAgentEvent {
  type: 'agent'
  message?: unknown
  text?: unknown
}

export interface HammurabiRateLimitEvent {
  type: 'rate_limit_event'
  [key: string]: unknown
}

export type HammurabiEvent =
  | HammurabiMessageStartEvent
  | HammurabiContentStartEvent
  | HammurabiContentDeltaEvent
  | HammurabiContentStopEvent
  | HammurabiMessageDeltaEvent
  | HammurabiMessageStopEvent
  | HammurabiAssistantMessageEvent
  | HammurabiUserMessageEvent
  | HammurabiToolUseEvent
  | HammurabiToolResultEvent
  | PlanningEvent
  | HammurabiResultEvent
  | HammurabiExitEvent
  | HammurabiSystemEvent
  | HammurabiAgentEvent
  | HammurabiRateLimitEvent

export interface HammurabiTranscriptLine {
  timestamp: string
  source: HammurabiEventSource
  event: HammurabiEvent
}
