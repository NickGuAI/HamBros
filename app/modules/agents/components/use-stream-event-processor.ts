import { useCallback, useRef, useState } from 'react'
import type { AskQuestion, StreamEvent } from '@/types'
import {
  capMessages,
  extractAgentMessageText,
  extractSubagentDescription,
  extractToolDetails,
  extractToolResultOutput,
  SUBAGENT_WORKING_LABEL,
  type MsgItem,
} from './session-messages'

type CurrentBlock = {
  type: 'text' | 'thinking' | 'tool_use' | 'planning_tool_use'
  msgId: string
  toolName?: string
  toolId?: string
  inputJsonParts?: string[]
}

const FILE_MUTATING_TOOLS = new Set(['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
type PlanningToolName = 'EnterPlanMode' | 'ExitPlanMode'

function normalizeDescription(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function isPlanningToolName(value: string | undefined): value is PlanningToolName {
  return value === 'EnterPlanMode' || value === 'ExitPlanMode'
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function parsePlanningPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    try {
      return asObject(JSON.parse(trimmed))
    } catch {
      return null
    }
  }

  return asObject(value)
}

function extractNestedText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : undefined
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractNestedText(entry))
      .filter((entry): entry is string => Boolean(entry))
    return parts.length > 0 ? parts.join('\n') : undefined
  }

  if (!value || typeof value !== 'object') {
    return undefined
  }

  const record = value as Record<string, unknown>
  if (typeof record.text === 'string' && record.text.trim()) {
    return record.text.trim()
  }
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message.trim()
  }
  if ('content' in record) {
    return extractNestedText(record.content)
  }

  return undefined
}

function toPlanningMessage(id: string, event: Extract<StreamEvent, { type: 'planning' }>): MsgItem {
  return {
    id,
    kind: 'planning',
    text: event.action === 'proposed' ? event.plan ?? '' : event.message ?? '',
    planningAction: event.action,
    planningPlan: event.action === 'proposed' ? event.plan : undefined,
    planningApproved: event.action === 'decision' ? event.approved : undefined,
    planningMessage: event.action === 'decision' ? event.message : undefined,
  }
}

function parsePlanningToolResult(
  content: unknown,
  isError?: boolean,
): Extract<StreamEvent, { type: 'planning' }> | null {
  const parsed = parsePlanningPayload(content)

  if (typeof parsed?.plan === 'string' && parsed.plan.trim()) {
    return {
      type: 'planning',
      action: 'proposed',
      plan: parsed.plan.trim(),
    }
  }

  const approvedValue = parsed?.approved
  const approved =
    approvedValue === null || typeof approvedValue === 'boolean' ? approvedValue : undefined
  const message = extractNestedText(parsed?.message)
  if (approved !== undefined || message) {
    return {
      type: 'planning',
      action: 'decision',
      approved: approved ?? null,
      ...(message ? { message } : {}),
    }
  }

  const fallbackMessage = extractNestedText(content)
  return {
    type: 'planning',
    action: 'decision',
    approved: isError ? false : true,
    ...(fallbackMessage ? { message: fallbackMessage } : {}),
  }
}

export function useStreamEventProcessor(options?: {
  onWorkspaceMutation?: () => void
}) {
  const onWorkspaceMutation = options?.onWorkspaceMutation
  const idCounterRef = useRef(0)
  const currentBlockRef = useRef<CurrentBlock | null>(null)
  const activeAgentMessageIdsRef = useRef<string[]>([])
  const planningToolNamesRef = useRef<Record<string, PlanningToolName>>({})

  const [messages, setMessages] = useState<MsgItem[]>([])
  const [isStreaming, setIsStreaming] = useState(false)

  const nextId = useCallback(() => `msg-${++idCounterRef.current}`, [])

  const resetMessages = useCallback(() => {
    idCounterRef.current = 0
    currentBlockRef.current = null
    activeAgentMessageIdsRef.current = []
    planningToolNamesRef.current = {}
    setMessages([])
    setIsStreaming(false)
  }, [])

  const pushActiveAgentMessageId = useCallback((messageId: string) => {
    if (!messageId) return
    const active = activeAgentMessageIdsRef.current
    if (!active.includes(messageId)) {
      active.push(messageId)
    }
  }, [])

  const removeActiveAgentMessageId = useCallback((messageId: string) => {
    if (!messageId) return
    activeAgentMessageIdsRef.current = activeAgentMessageIdsRef.current.filter(
      (id) => id !== messageId,
    )
  }, [])

  const clearActiveAgentMessageIds = useCallback(() => {
    activeAgentMessageIdsRef.current = []
  }, [])

  const appendSubagentSystemMessage = useCallback(
    (
      text: string,
      {
        toolUseId,
        descriptionHint,
      }: {
        toolUseId?: string
        descriptionHint?: string
      } = {},
    ) => {
      if (!text.trim()) return
      const childMsg: MsgItem = { id: nextId(), kind: 'system', text }
      const normalizedHint = normalizeDescription(descriptionHint)
      const normalizedToolUseId = typeof toolUseId === 'string' ? toolUseId.trim() : ''

      setMessages((prev) => {
        // Keep only active running agent ids in the stack.
        if (activeAgentMessageIdsRef.current.length > 0) {
          const runningAgentIds = new Set(
            prev
              .filter(
                (m) => m.kind === 'tool' && m.toolName === 'Agent' && m.toolStatus === 'running',
              )
              .map((m) => m.id),
          )
          activeAgentMessageIdsRef.current = activeAgentMessageIdsRef.current.filter((id) =>
            runningAgentIds.has(id),
          )
        }

        let parentIndex = -1

        // Deterministic correlation for parallel subagents.
        // task_* system events include tool_use_id that matches Agent tool_use ids.
        if (normalizedToolUseId) {
          for (let i = prev.length - 1; i >= 0; i--) {
            const msg = prev[i]
            if (
              msg.kind === 'tool' &&
              msg.toolName === 'Agent' &&
              msg.toolId === normalizedToolUseId
            ) {
              parentIndex = i
              break
            }
          }
        }

        // Fallback for older payloads without tool_use_id.
        if (parentIndex === -1 && normalizedHint) {
          const activeIds = activeAgentMessageIdsRef.current
          for (let i = activeIds.length - 1; i >= 0; i--) {
            const idx = prev.findIndex((m) => m.id === activeIds[i])
            if (idx === -1) continue
            const parent = prev[idx]
            if (
              parent.kind === 'tool' &&
              parent.toolName === 'Agent' &&
              parent.toolStatus === 'running' &&
              normalizeDescription(parent.subagentDescription) === normalizedHint
            ) {
              parentIndex = idx
              break
            }
          }
        }

        if (parentIndex === -1) {
          const activeIds = activeAgentMessageIdsRef.current
          for (let i = activeIds.length - 1; i >= 0; i--) {
            const idx = prev.findIndex((m) => m.id === activeIds[i])
            if (idx === -1) continue
            const parent = prev[idx]
            if (
              parent.kind === 'tool' &&
              parent.toolName === 'Agent' &&
              parent.toolStatus === 'running'
            ) {
              parentIndex = idx
              break
            }
          }
        }

        if (parentIndex === -1) {
          for (let i = prev.length - 1; i >= 0; i--) {
            const msg = prev[i]
            if (msg.kind === 'tool' && msg.toolName === 'Agent' && msg.toolStatus === 'running') {
              parentIndex = i
              break
            }
          }
        }

        if (parentIndex === -1) {
          return capMessages([...prev, childMsg])
        }

        const updated = [...prev]
        const parent = updated[parentIndex]
        if (parent.kind !== 'tool') {
          return capMessages([...prev, childMsg])
        }
        updated[parentIndex] = {
          ...parent,
          children: [...(parent.children ?? []), childMsg],
        }
        return capMessages(updated)
      })
    },
    [nextId],
  )

  const markAskAnswered = useCallback((toolId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === 'ask' && m.toolId === toolId ? { ...m, askAnswered: true } : m,
      ),
    )
  }, [])

  const appendPlanningMessage = useCallback((event: Extract<StreamEvent, { type: 'planning' }>) => {
    setMessages((prev) =>
      capMessages([...prev, toPlanningMessage(nextId(), event)]),
    )
  }, [nextId])

  const appendPlanningToolUse = useCallback((toolName: PlanningToolName, input: unknown) => {
    if (toolName === 'EnterPlanMode') {
      appendPlanningMessage({ type: 'planning', action: 'enter' })
      return
    }

    const parsed = parsePlanningPayload(input)
    if (typeof parsed?.plan === 'string' && parsed.plan.trim()) {
      appendPlanningMessage({
        type: 'planning',
        action: 'proposed',
        plan: parsed.plan.trim(),
      })
    }
  }, [appendPlanningMessage])

  const processEvent = useCallback(
    (event: StreamEvent, isReplay = false) => {
      if (event.type === 'agent') {
        const text =
          extractAgentMessageText(event.message) ??
          extractAgentMessageText(event.text) ??
          extractAgentMessageText(event)
        if (text) {
          setMessages((prev) => capMessages([...prev, { id: nextId(), kind: 'agent', text }]))
        }
        return
      }

      if (event.type === 'planning') {
        appendPlanningMessage(event)
        return
      }

      switch (event.type) {
        case 'assistant': {
          const blocks = event.message?.content
          if (!Array.isArray(blocks)) break

          for (const block of blocks) {
            if (block.type === 'text') {
              const text = block.text ?? ''
              if (!text) continue
              const id = nextId()
              setMessages((prev) => capMessages([...prev, { id, kind: 'agent', text }]))
            } else if (block.type === 'thinking') {
              const text =
                (typeof block.thinking === 'string' ? block.thinking : undefined) ??
                (typeof block.text === 'string' ? block.text : '')
              const isCodexThinkingEnvelope = event.source?.provider === 'codex'
              if (isCodexThinkingEnvelope) {
                const activeThinkingMessageId =
                  currentBlockRef.current?.type === 'thinking' ? currentBlockRef.current.msgId : undefined
                const hasThinkingText = text.trim().length > 0

                setMessages((prev) => {
                  let targetIndex = -1
                  if (activeThinkingMessageId) {
                    targetIndex = prev.findIndex(
                      (msg) => msg.kind === 'thinking' && msg.id === activeThinkingMessageId,
                    )
                  }
                  if (targetIndex === -1) {
                    for (let i = prev.length - 1; i >= 0; i -= 1) {
                      const msg = prev[i]
                      if (msg.kind === 'thinking' && !msg.text.trim()) {
                        targetIndex = i
                        break
                      }
                    }
                  }

                  if (!hasThinkingText) {
                    if (targetIndex === -1) {
                      return prev
                    }
                    const target = prev[targetIndex]
                    if (target.kind !== 'thinking' || target.text.trim()) {
                      return prev
                    }
                    return prev.filter((msg) => msg.id !== target.id)
                  }

                  if (targetIndex !== -1) {
                    const target = prev[targetIndex]
                    if (target.kind === 'thinking') {
                      if (target.text === text) {
                        return prev
                      }
                      const updated = [...prev]
                      updated[targetIndex] = { ...target, text }
                      return updated
                    }
                  }

                  const id = nextId()
                  return capMessages([...prev, { id, kind: 'thinking', text }])
                })

                // Codex reasoning completion arrives as an assistant envelope.
                if (currentBlockRef.current?.type === 'thinking') {
                  currentBlockRef.current = null
                }
                continue
              }

              if (!text) continue
              const id = nextId()
              setMessages((prev) => capMessages([...prev, { id, kind: 'thinking', text }]))
            } else if ((block as { type?: string }).type === 'agent_message') {
              const text = extractAgentMessageText(block)
              if (!text) continue
              const id = nextId()
              setMessages((prev) => capMessages([...prev, { id, kind: 'agent', text }]))
            } else if (block.type === 'tool_use') {
              if (isPlanningToolName(block.name)) {
                planningToolNamesRef.current[block.id] = block.name
                appendPlanningToolUse(block.name, block.input)
                continue
              }

              const id = nextId()
              if (block.name === 'AskUserQuestion') {
                const input = block.input as { questions?: AskQuestion[] } | undefined
                setMessages((prev) => {
                  const existingIdx = prev.findIndex(
                    (m) => m.kind === 'ask' && m.toolId === block.id,
                  )
                  if (existingIdx !== -1) {
                    const nextQuestions = input?.questions
                    if (!nextQuestions || nextQuestions.length === 0) return prev
                    const existing = prev[existingIdx]
                    if ((existing.askQuestions?.length ?? 0) > 0) return prev
                    const updated = [...prev]
                    updated[existingIdx] = { ...existing, askQuestions: nextQuestions }
                    return updated
                  }
                  return capMessages([
                    ...prev,
                    {
                      id,
                      kind: 'ask',
                      text: '',
                      toolId: block.id,
                      toolName: block.name,
                      askQuestions: input?.questions ?? [],
                      askAnswered: false,
                    },
                  ])
                })
              } else {
                const { toolInput, toolFile, oldString, newString } = extractToolDetails(
                  block.name,
                  block.input,
                )
                const subagentDescription =
                  block.name === 'Agent'
                    ? extractSubagentDescription(block.input) ?? SUBAGENT_WORKING_LABEL
                    : undefined
                setMessages((prev) =>
                  capMessages([
                    ...prev,
                    {
                      id,
                      kind: 'tool',
                      text: '',
                      toolId: block.id,
                      toolName: block.name,
                      toolStatus: 'running',
                      toolInput,
                      toolFile,
                      oldString,
                      newString,
                      subagentDescription,
                    },
                  ]),
                )
                if (block.name === 'Agent') {
                  pushActiveAgentMessageId(id)
                }
              }
            }
          }
          break
        }

        case 'user': {
          const content = event.message?.content
          const hasActiveAgentTool = activeAgentMessageIdsRef.current.length > 0
          if (typeof content === 'string' && content.trim() && isReplay) {
            if (hasActiveAgentTool) break
            setMessages((prev) =>
              capMessages([...prev, { id: nextId(), kind: 'user', text: content.trim() }]),
            )
            break
          }
          if (!Array.isArray(content)) break

          // During replay, reconstruct user messages that contain text+image blocks
          if (isReplay) {
            const hasToolResult = content.some((b) => b.type === 'tool_result')
            const hasTextOrImage = content.some((b) => b.type === 'text' || b.type === 'image')
            if (!hasToolResult && hasTextOrImage) {
              if (hasActiveAgentTool) break
              let text = '[image]'
              const images: { mediaType: string; data: string }[] = []
              for (const b of content) {
                if (b.type === 'text' && 'text' in b) {
                  text = (b.text as string).trim() || text
                } else if (b.type === 'image' && 'source' in b) {
                  const src = b.source as { media_type?: string; data?: string } | undefined
                  images.push({ mediaType: src?.media_type ?? '', data: src?.data ?? '' })
                }
              }
              setMessages((prev) =>
                capMessages([
                  ...prev,
                  {
                    id: nextId(),
                    kind: 'user',
                    text,
                    images: images.length > 0 ? images : undefined,
                  },
                ]),
              )
              break
            }
          }

          const toolResults = content.filter((b) => b.type === 'tool_result')
          if (toolResults.length === 0) break

          let shouldTriggerWorkspaceRefresh = false
          setMessages((prev) => {
            const updated = [...prev]
            for (const result of toolResults) {
              const planningToolName =
                result.tool_use_id ? planningToolNamesRef.current[result.tool_use_id] : undefined
              if (planningToolName) {
                if (planningToolName === 'ExitPlanMode') {
                  updated.push(
                    toPlanningMessage(
                      nextId(),
                      parsePlanningToolResult(result.content ?? event.tool_use_result, result.is_error),
                    ),
                  )
                }
                delete planningToolNamesRef.current[result.tool_use_id!]
                continue
              }
              const status = result.is_error ? ('error' as const) : ('success' as const)
              const toolOutput = extractToolResultOutput(result.content)
              let matched = false
              if (result.tool_use_id) {
                for (let i = updated.length - 1; i >= 0; i--) {
                  const msg = updated[i]
                  if (
                    msg.kind === 'tool' &&
                    msg.toolStatus === 'running' &&
                    msg.toolId === result.tool_use_id
                  ) {
                    updated[i] = toolOutput === undefined
                      ? { ...msg, toolStatus: status }
                      : { ...msg, toolStatus: status, toolOutput }
                    if (FILE_MUTATING_TOOLS.has(msg.toolName ?? '')) {
                      shouldTriggerWorkspaceRefresh = true
                    }
                    if (msg.toolName === 'Agent') {
                      removeActiveAgentMessageId(msg.id)
                    }
                    matched = true
                    break
                  }
                }
              }
              if (!matched) {
                for (let i = updated.length - 1; i >= 0; i--) {
                  const msg = updated[i]
                  if (msg.kind === 'tool' && msg.toolStatus === 'running') {
                    updated[i] = toolOutput === undefined
                      ? { ...msg, toolStatus: status }
                      : { ...msg, toolStatus: status, toolOutput }
                    if (FILE_MUTATING_TOOLS.has(msg.toolName ?? '')) {
                      shouldTriggerWorkspaceRefresh = true
                    }
                    if (msg.toolName === 'Agent') {
                      removeActiveAgentMessageId(msg.id)
                    }
                    break
                  }
                }
              }
            }
            return capMessages(updated)
          })
          if (shouldTriggerWorkspaceRefresh) {
            onWorkspaceMutation?.()
          }
          break
        }

        case 'content_block_start': {
          const block = event.content_block
          if (block.type === 'text') {
            const id = nextId()
            currentBlockRef.current = { type: 'text', msgId: id }
            setMessages((prev) => capMessages([...prev, { id, kind: 'agent', text: '' }]))
            if (!isReplay) setIsStreaming(true)
          } else if (block.type === 'thinking') {
            const id = nextId()
            currentBlockRef.current = { type: 'thinking', msgId: id }
            setMessages((prev) => capMessages([...prev, { id, kind: 'thinking', text: '' }]))
            if (!isReplay) setIsStreaming(true)
          } else if (block.type === 'tool_use') {
            if (isPlanningToolName(block.name)) {
              planningToolNamesRef.current[block.id] = block.name
              if (block.name === 'EnterPlanMode') {
                currentBlockRef.current = null
                appendPlanningMessage({ type: 'planning', action: 'enter' })
              } else {
                currentBlockRef.current = {
                  type: 'planning_tool_use',
                  msgId: nextId(),
                  toolName: block.name,
                  toolId: block.id,
                  inputJsonParts: [],
                }
              }
              if (!isReplay) setIsStreaming(true)
              break
            }

            const id = nextId()
            currentBlockRef.current = {
              type: 'tool_use',
              msgId: id,
              toolName: block.name,
              toolId: block.id,
              inputJsonParts: [],
            }
            if (block.name !== 'AskUserQuestion') {
              setMessages((prev) =>
                capMessages([
                  ...prev,
                  {
                    id,
                    kind: 'tool',
                    text: '',
                    toolId: block.id,
                    toolName: block.name,
                    toolStatus: 'running',
                    toolInput: '',
                    subagentDescription:
                      block.name === 'Agent' ? SUBAGENT_WORKING_LABEL : undefined,
                  },
                ]),
              )
              if (block.name === 'Agent') {
                pushActiveAgentMessageId(id)
              }
            }
            if (!isReplay) setIsStreaming(true)
          }
          break
        }

        case 'content_block_delta': {
          const cur = currentBlockRef.current
          if (!cur) break
          const delta = event.delta
          if (delta.type === 'text_delta' && cur.type === 'text') {
            const appendText = delta.text
            setMessages((prev) => {
              const last = prev.length - 1
              if (last >= 0 && prev[last].id === cur.msgId) {
                const updated = [...prev]
                updated[last] = { ...prev[last], text: prev[last].text + appendText }
                return updated
              }
              return prev.map((m) =>
                m.id === cur.msgId ? { ...m, text: m.text + appendText } : m,
              )
            })
          } else if (delta.type === 'thinking_delta' && cur.type === 'thinking') {
            const appendText = delta.thinking
            setMessages((prev) => {
              const last = prev.length - 1
              if (last >= 0 && prev[last].id === cur.msgId) {
                const updated = [...prev]
                updated[last] = { ...prev[last], text: prev[last].text + appendText }
                return updated
              }
              return prev.map((m) =>
                m.id === cur.msgId ? { ...m, text: m.text + appendText } : m,
              )
            })
          } else if (delta.type === 'input_json_delta' && cur.type === 'tool_use') {
            cur.inputJsonParts!.push(delta.partial_json)
          } else if (delta.type === 'input_json_delta' && cur.type === 'planning_tool_use') {
            cur.inputJsonParts!.push(delta.partial_json)
          }
          break
        }

        case 'content_block_stop': {
          const cur = currentBlockRef.current
          if (cur?.type === 'text') {
            // Remove empty agent messages that received no delta text
            setMessages((prev) => {
              const msg = prev.find((m) => m.id === cur.msgId)
              if (msg && msg.kind === 'agent' && !msg.text.trim()) {
                return prev.filter((m) => m.id !== cur.msgId)
              }
              return prev
            })
          }
          if (cur?.type === 'tool_use') {
            const rawJson = cur.inputJsonParts?.join('') ?? ''
            if (cur.toolName === 'AskUserQuestion') {
              let questions: AskQuestion[] = []
              try {
                const input = JSON.parse(rawJson) as { questions?: AskQuestion[] }
                questions = input.questions ?? []
              } catch {
                // ignore — ask data may already have arrived via envelope event
              }
              setMessages((prev) => {
                const existingIdx = prev.findIndex(
                  (m) => m.kind === 'ask' && m.toolId === cur.toolId,
                )
                if (existingIdx !== -1) {
                  const existing = prev[existingIdx]
                  if (questions.length === 0 || (existing.askQuestions?.length ?? 0) > 0) {
                    return prev
                  }
                  const updated = [...prev]
                  updated[existingIdx] = { ...existing, askQuestions: questions }
                  return updated
                }
                return capMessages([
                  ...prev,
                  {
                    id: cur.msgId,
                    kind: 'ask',
                    text: '',
                    toolId: cur.toolId,
                    toolName: cur.toolName,
                    askQuestions: questions,
                    askAnswered: false,
                  },
                ])
              })
            } else {
              const { toolInput, toolFile, oldString, newString } = extractToolDetails(
                cur.toolName,
                rawJson,
              )
              const subagentDescription =
                cur.toolName === 'Agent'
                  ? extractSubagentDescription(rawJson) ?? SUBAGENT_WORKING_LABEL
                  : undefined
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === cur.msgId
                    ? { ...m, toolInput, toolFile, oldString, newString, subagentDescription }
                    : m,
                ),
              )
            }
          }
          if (cur?.type === 'planning_tool_use') {
            const rawJson = cur.inputJsonParts?.join('') ?? ''
            appendPlanningToolUse(cur.toolName as PlanningToolName, rawJson)
          }
          currentBlockRef.current = null
          break
        }

        case 'message_start': {
          setMessages((prev) =>
            prev.map((m) =>
              m.kind === 'tool' && m.toolStatus === 'running'
                ? { ...m, toolStatus: 'success' }
                : m,
            ),
          )
          clearActiveAgentMessageIds()
          setIsStreaming(false)
          break
        }

        case 'message_stop': {
          setIsStreaming(false)
          break
        }

        case 'result': {
          const resultStatus = event.is_error ? ('error' as const) : ('success' as const)
          // Top-level results always carry duration_ms (session-level timing);
          // sub-agent completions omit it. Use duration_ms as the reliable marker
          // to avoid suppressing "Awaiting input" for costless top-level sessions
          // (e.g. OpenClaw normalized results).
          const isSubagentResult = !event.duration_ms
          setMessages((prev) =>
            capMessages([
              ...prev.map((m) =>
                m.kind === 'tool' && m.toolStatus === 'running'
                  ? { ...m, toolStatus: resultStatus }
                  : m,
              ),
              ...(isSubagentResult
                ? []
                : [{ id: nextId(), kind: 'system' as const, text: 'Awaiting input' }]),
            ]),
          )
          clearActiveAgentMessageIds()
          setIsStreaming(false)
          onWorkspaceMutation?.()
          break
        }

        case 'exit': {
          setMessages((prev) => {
            const hasRunning = prev.some((m) => m.kind === 'tool' && m.toolStatus === 'running')
            if (!hasRunning) {
              return capMessages([
                ...prev,
                { id: nextId(), kind: 'system', text: 'Session ended' },
              ])
            }
            return capMessages([
              ...prev.map((m) =>
                m.kind === 'tool' && m.toolStatus === 'running'
                  ? { ...m, toolStatus: 'error' as const }
                  : m,
              ),
              { id: nextId(), kind: 'system', text: 'Session ended' },
            ])
          })
          clearActiveAgentMessageIds()
          setIsStreaming(false)
          break
        }

        case 'system': {
          // Sub-agent events like init, compact_boundary, status have no text — skip them
          if (!event.text) {
            const subtype = (event as { subtype?: string }).subtype
            const toolUseId = (event as { tool_use_id?: string }).tool_use_id
            if (subtype === 'task_progress') {
              const desc = (event as { description?: string }).description
              const tool = (event as { last_tool_name?: string }).last_tool_name
              const parts = [desc, tool ? `[${tool}]` : ''].filter(Boolean)
              if (parts.length > 0) {
                appendSubagentSystemMessage(parts.join(' '), {
                  toolUseId,
                  descriptionHint: desc,
                })
              }
            }
            if (subtype === 'task_started') {
              const desc = (event as { description?: string }).description
              if (desc) {
                appendSubagentSystemMessage(`Sub-agent: ${desc}`, {
                  toolUseId,
                  descriptionHint: desc,
                })
              }
            }
            if (subtype === 'task_notification') {
              const desc = (event as { description?: string }).description
              const summary = (event as { summary?: string }).summary
              const status = (event as { status?: string }).status
              const text =
                summary ?? desc ?? (typeof status === 'string' ? `Sub-agent ${status}` : undefined)
              if (text) {
                appendSubagentSystemMessage(text, {
                  toolUseId,
                  descriptionHint: summary ?? desc,
                })
              }
            }
            // Silently skip init, compact_boundary, status
            break
          }
          setMessages((prev) =>
            capMessages([...prev, { id: nextId(), kind: 'system', text: event.text ?? '' }]),
          )
          break
        }

        default:
          break
      }
    },
    [
      appendSubagentSystemMessage,
      appendPlanningMessage,
      appendPlanningToolUse,
      clearActiveAgentMessageIds,
      onWorkspaceMutation,
      parsePlanningToolResult,
      pushActiveAgentMessageId,
      removeActiveAgentMessageId,
    ],
  )

  const pushUserMessage = useCallback(
    (text: string) => {
      setMessages((prev) => capMessages([...prev, { id: nextId(), kind: 'user', text }]))
    },
    [nextId],
  )

  return { messages, setMessages, processEvent, resetMessages, isStreaming, markAskAnswered, pushUserMessage }
}
