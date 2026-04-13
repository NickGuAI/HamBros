import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '../../../src/lib/api'

export type WorldAgentStatus = 'active' | 'idle' | 'stale' | 'completed'
export type WorldAgentPhase = 'idle' | 'thinking' | 'tool_use' | 'blocked' | 'completed'
export type SessionType = 'pty' | 'stream'
export type AgentType = 'claude' | 'codex' | 'gemini'

export interface WorldAgent {
  id: string
  sessionType: SessionType
  agentType: AgentType
  role: 'commander' | 'worker'
  status: WorldAgentStatus
  phase: WorldAgentPhase
  usage: {
    inputTokens: number
    outputTokens: number
    costUsd: number
  }
  task: string
  lastToolUse: string | null
  lastUpdatedAt: string
  channelMeta?: {
    provider: 'whatsapp' | 'telegram' | 'discord'
    displayName: string
    chatType: 'direct' | 'group' | 'channel' | 'forum-topic'
  }
}

async function fetchWorldState(): Promise<WorldAgent[]> {
  return fetchJson<WorldAgent[]>('/api/agents/world')
}

export function useWorldState() {
  return useQuery({
    queryKey: ['rpg', 'world'],
    queryFn: fetchWorldState,
    refetchInterval: 1000,
  })
}
