import { useCallback, useEffect, useRef, useState } from 'react'
import { getAccessToken } from '@/lib/api'
import { getWsBase } from '@/lib/api-base'
import type { AskQuestion, StreamEvent } from '@/types'

export interface PendingAsk {
  toolId: string
  questions: AskQuestion[]
}

interface UseSessionWsOptions {
  sessionName?: string
  onToolUse?: (toolName: string) => void
  onEvent?: (event: StreamEvent, isReplay: boolean) => void
  onReplayStart?: () => void
}

type WsStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'

interface LegacyAskBlock {
  toolId: string
  parts: string[]
}

function parseAskQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== 'object') {
    return []
  }

  const maybeQuestions = (input as { questions?: unknown }).questions
  if (!Array.isArray(maybeQuestions)) {
    return []
  }

  const parsed: AskQuestion[] = []
  for (const question of maybeQuestions) {
    if (!question || typeof question !== 'object') {
      continue
    }

    const entry = question as {
      question?: unknown
      header?: unknown
      options?: unknown
      multiSelect?: unknown
    }

    if (typeof entry.question !== 'string' || typeof entry.header !== 'string') {
      continue
    }

    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((option) => {
          if (!option || typeof option !== 'object') {
            return []
          }
          const cast = option as { label?: unknown; description?: unknown }
          if (typeof cast.label !== 'string') {
            return []
          }
          return [{
            label: cast.label,
            description: typeof cast.description === 'string' ? cast.description : undefined,
          }]
        })
      : []

    parsed.push({
      question: entry.question,
      header: entry.header,
      options,
      multiSelect: Boolean(entry.multiSelect),
    })
  }

  return parsed
}

export function useSessionWs({
  sessionName,
  onToolUse,
  onEvent,
  onReplayStart,
}: UseSessionWsOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const legacyAskRef = useRef<LegacyAskBlock | null>(null)

  const [status, setStatus] = useState<WsStatus>('idle')
  const [pendingAsks, setPendingAsks] = useState<PendingAsk[]>([])

  const upsertPendingAsk = useCallback((toolId: string, questions: AskQuestion[]) => {
    setPendingAsks((previous) => {
      const existingIndex = previous.findIndex((ask) => ask.toolId === toolId)
      if (existingIndex !== -1) {
        if (questions.length === 0 || previous[existingIndex].questions.length > 0) {
          return previous
        }
        const next = [...previous]
        next[existingIndex] = { ...next[existingIndex], questions }
        return next
      }

      return [...previous, { toolId, questions }]
    })
  }, [])

  const removePendingAsk = useCallback((toolId: string) => {
    setPendingAsks((previous) => previous.filter((ask) => ask.toolId !== toolId))
  }, [])

  const processEvent = useCallback((event: StreamEvent, isReplay: boolean) => {
    onEvent?.(event, isReplay)

    if (event.type === 'assistant') {
      const blocks = event.message?.content
      if (!Array.isArray(blocks)) {
        return
      }

      for (const block of blocks) {
        if (block.type !== 'tool_use') {
          continue
        }

        if (!isReplay) {
          onToolUse?.(block.name)
        }

        if (block.name === 'AskUserQuestion') {
          upsertPendingAsk(block.id, parseAskQuestions(block.input))
        }
      }
      return
    }

    if (event.type === 'content_block_start') {
      if (event.content_block.type !== 'tool_use') {
        legacyAskRef.current = null
        return
      }

      if (!isReplay) {
        onToolUse?.(event.content_block.name)
      }

      if (event.content_block.name !== 'AskUserQuestion') {
        legacyAskRef.current = null
        return
      }

      legacyAskRef.current = {
        toolId: event.content_block.id,
        parts: [],
      }
      return
    }

    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'input_json_delta' &&
      legacyAskRef.current
    ) {
      legacyAskRef.current.parts.push(event.delta.partial_json)
      return
    }

    if (event.type === 'content_block_stop' && legacyAskRef.current) {
      const pending = legacyAskRef.current
      legacyAskRef.current = null

      try {
        const parsed = JSON.parse(pending.parts.join('')) as { questions?: unknown }
        upsertPendingAsk(pending.toolId, parseAskQuestions(parsed))
      } catch {
        upsertPendingAsk(pending.toolId, [])
      }
      return
    }

    if (event.type === 'user') {
      const content = event.message?.content
      if (!Array.isArray(content)) {
        return
      }
      for (const item of content) {
        if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          removePendingAsk(item.tool_use_id)
        }
      }
    }
  }, [onEvent, onToolUse, removePendingAsk, upsertPendingAsk])

  useEffect(() => {
    if (!sessionName) {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      legacyAskRef.current = null
      setStatus('idle')
      setPendingAsks([])
      return
    }

    let disposed = false
    let socket: WebSocket | null = null

    setStatus('connecting')
    setPendingAsks([])

    const connect = async () => {
      const token = await getAccessToken()
      if (disposed) {
        return
      }

      const params = new URLSearchParams()
      if (token) {
        params.set('access_token', token)
      }

      const wsBase = getWsBase()
      const url = wsBase
        ? `${wsBase}/api/agents/sessions/${encodeURIComponent(sessionName)}/terminal?${params}`
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/agents/sessions/${encodeURIComponent(sessionName)}/terminal?${params}`

      socket = new WebSocket(url)
      wsRef.current = socket

      socket.onopen = () => {
        if (disposed || wsRef.current !== socket) {
          return
        }
        setStatus('connected')
      }

      socket.onclose = () => {
        if (disposed || wsRef.current !== socket) {
          return
        }
        wsRef.current = null
        setStatus('disconnected')
      }

      socket.onerror = () => {
        if (disposed || wsRef.current !== socket) {
          return
        }
        setStatus('disconnected')
      }

      socket.onmessage = (incoming) => {
        if (disposed || wsRef.current !== socket) {
          return
        }

        try {
          const raw = JSON.parse(incoming.data as string) as {
            type: string
            events?: StreamEvent[]
            toolId?: string
          }

          if (raw.type === 'replay' && Array.isArray(raw.events)) {
            legacyAskRef.current = null
            setPendingAsks([])
            onReplayStart?.()
            for (const event of raw.events) {
              processEvent(event, true)
            }
            return
          }

          if (raw.type === 'tool_answer_ack' && typeof raw.toolId === 'string') {
            removePendingAsk(raw.toolId)
            return
          }

          if (raw.type === 'tool_answer_error') {
            return
          }

          processEvent(raw as StreamEvent, false)
        } catch {
          // Ignore malformed/non-JSON websocket messages.
        }
      }
    }

    void connect()

    return () => {
      disposed = true
      legacyAskRef.current = null
      if (wsRef.current === socket) {
        wsRef.current = null
      }
      socket?.close()
    }
  }, [onReplayStart, processEvent, removePendingAsk, sessionName])

  const sendInput = useCallback((text: string): boolean => {
    const socket = wsRef.current
    const trimmed = text.trim()
    if (!socket || socket.readyState !== WebSocket.OPEN || !trimmed) {
      return false
    }

    socket.send(JSON.stringify({ type: 'input', text: trimmed }))
    return true
  }, [])

  const sendToolAnswer = useCallback((toolId: string, answers: Record<string, string[]>): boolean => {
    const socket = wsRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN || !toolId) {
      return false
    }

    socket.send(JSON.stringify({ type: 'tool_answer', toolId, answers }))
    return true
  }, [])

  return {
    status,
    pendingAsk: pendingAsks[0] ?? null,
    pendingAsks,
    sendInput,
    sendToolAnswer,
  }
}
