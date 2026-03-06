import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { AskQuestion, StreamEvent } from '@/types'
import { useSessionWs } from './use-session-ws'

interface DialoguePanelProps {
  agentId: string
  onClose: () => void
}

type DialogueRole = 'assistant' | 'tool' | 'user'

interface DialogueMessage {
  id: string
  role: DialogueRole
  text: string
}

interface LegacyToolUseBlock {
  toolName: string
  inputParts: string[]
}

function buildInitialAnswers(questions: AskQuestion[]): Record<string, string[]> {
  const answers: Record<string, string[]> = {}
  for (const question of questions) {
    answers[question.header] = []
  }
  return answers
}

function roleClass(role: DialogueRole): string {
  switch (role) {
    case 'assistant':
      return 'border-cyan-300/30 bg-cyan-500/10 text-cyan-100'
    case 'tool':
      return 'border-amber-300/30 bg-amber-500/10 text-amber-100'
    default:
      return 'border-emerald-300/30 bg-emerald-500/10 text-emerald-100'
  }
}

export function DialoguePanel({ agentId, onClose }: DialoguePanelProps) {
  const idCounterRef = useRef(0)
  const activeLegacyTextMessageIdRef = useRef<string | null>(null)
  const activeLegacyToolUseRef = useRef<LegacyToolUseBlock | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)

  const [inputValue, setInputValue] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [askError, setAskError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [messages, setMessages] = useState<DialogueMessage[]>([])

  const nextId = useCallback(() => {
    idCounterRef.current += 1
    return `dialog-${idCounterRef.current}`
  }, [])

  const appendMessage = useCallback((role: DialogueRole, text: string) => {
    const normalized = text.trim()
    if (!normalized) {
      return
    }
    setMessages((previous) => [...previous, { id: nextId(), role, text: normalized }])
  }, [nextId])

  const appendToMessage = useCallback((messageId: string, chunk: string) => {
    if (!chunk) {
      return
    }
    setMessages((previous) => previous.map((message) => (
      message.id === messageId
        ? { ...message, text: message.text + chunk }
        : message
    )))
  }, [])

  const handleReplayStart = useCallback(() => {
    activeLegacyTextMessageIdRef.current = null
    activeLegacyToolUseRef.current = null
    setMessages([])
  }, [])

  const handleStreamEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'assistant') {
      const blocks = event.message?.content
      if (!Array.isArray(blocks)) {
        return
      }
      for (const block of blocks) {
        if (block.type === 'text') {
          appendMessage('assistant', block.text ?? '')
          continue
        }
        if (block.type === 'tool_use') {
          appendMessage('tool', `tool ${block.name}`)
        }
      }
      return
    }

    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'text') {
        const messageId = nextId()
        activeLegacyTextMessageIdRef.current = messageId
        setMessages((previous) => [...previous, { id: messageId, role: 'assistant', text: '' }])
        return
      }
      activeLegacyTextMessageIdRef.current = null

      if (event.content_block.type === 'tool_use') {
        activeLegacyToolUseRef.current = {
          toolName: event.content_block.name,
          inputParts: [],
        }
        appendMessage('tool', `tool ${event.content_block.name}`)
      } else {
        activeLegacyToolUseRef.current = null
      }
      return
    }

    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta' && activeLegacyTextMessageIdRef.current) {
        appendToMessage(activeLegacyTextMessageIdRef.current, event.delta.text)
        return
      }
      if (event.delta.type === 'input_json_delta' && activeLegacyToolUseRef.current) {
        activeLegacyToolUseRef.current.inputParts.push(event.delta.partial_json)
      }
      return
    }

    if (event.type === 'content_block_stop') {
      activeLegacyTextMessageIdRef.current = null
      activeLegacyToolUseRef.current = null
      return
    }

    if (event.type === 'user') {
      const content = event.message?.content
      if (!Array.isArray(content)) {
        return
      }
      for (const block of content) {
        if (block.type === 'tool_result') {
          appendMessage('tool', block.is_error ? 'tool result error' : 'tool result ok')
        }
      }
    }
  }, [appendMessage, appendToMessage, nextId])

  const {
    status,
    pendingAsks,
    sendInput,
    sendToolAnswer,
  } = useSessionWs({
    sessionName: agentId,
    onEvent: handleStreamEvent,
    onReplayStart: handleReplayStart,
  })

  const currentAsk = pendingAsks[0] ?? null
  const questions = currentAsk?.questions ?? []

  useEffect(() => {
    setInputValue('')
    setInputError(null)
    setAskError(null)
    setAnswers({})
    setMessages([])
    activeLegacyTextMessageIdRef.current = null
    activeLegacyToolUseRef.current = null
    idCounterRef.current = 0
  }, [agentId])

  useEffect(() => {
    const container = messagesRef.current
    if (!container) {
      return
    }
    container.scrollTop = container.scrollHeight
  }, [messages])

  useEffect(() => {
    if (!currentAsk) {
      setAnswers({})
      setAskError(null)
      return
    }
    setAnswers(buildInitialAnswers(currentAsk.questions))
    setAskError(null)
  }, [currentAsk])

  const askReadyToSubmit = useMemo(() => {
    if (!currentAsk) {
      return false
    }
    if (questions.length === 0) {
      return true
    }
    return questions.every((question) => (answers[question.header] ?? []).length > 0)
  }, [answers, currentAsk, questions])

  const submitInput = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = inputValue.trim()
    if (!text) {
      return
    }
    const ok = sendInput(text)
    if (!ok) {
      setInputError('Unable to send input. Confirm websocket connection.')
      return
    }
    setMessages((previous) => [...previous, { id: nextId(), role: 'user', text }])
    setInputValue('')
    setInputError(null)
  }

  const submitAsk = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!currentAsk) {
      return
    }

    const ok = sendToolAnswer(currentAsk.toolId, answers)
    if (!ok) {
      setAskError('Unable to submit answer. Confirm websocket connection.')
      return
    }

    setAskError(null)
  }

  const setSingleAnswer = (header: string, value: string) => {
    setAnswers((previous) => ({
      ...previous,
      [header]: [value],
    }))
  }

  const toggleMultiAnswer = (header: string, value: string) => {
    setAnswers((previous) => {
      const current = previous[header] ?? []
      return {
        ...previous,
        [header]: current.includes(value)
          ? current.filter((item) => item !== value)
          : [...current, value],
      }
    })
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-end bg-black/45 p-3 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section
        className="relative mx-auto flex h-[58vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/20 bg-zinc-950/95 text-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-white/15 bg-black/45 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-white/90">dialogue {agentId}</span>
            <span className="rounded border border-white/20 bg-black/50 px-1.5 py-0.5 text-[10px] text-white/70">
              ws {status}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-white/25 bg-white/10 px-2 py-1 text-[10px] text-white/85 transition hover:bg-white/20"
          >
            close
          </button>
        </header>

        <div ref={messagesRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
          {messages.length === 0 ? (
            <p className="rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-white/60">
              No dialogue yet. Send a command to start.
            </p>
          ) : messages.map((message) => (
            <article key={message.id} className={`rounded border px-2.5 py-2 ${roleClass(message.role)}`}>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-white/70">{message.role}</div>
              <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
            </article>
          ))}
        </div>

        {currentAsk ? (
          <form onSubmit={submitAsk} className="border-t border-white/15 bg-black/40 px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.08em] text-emerald-100">ask user question</h3>
              <span className="rounded border border-emerald-300/35 bg-emerald-400/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-emerald-100">
                tool {currentAsk.toolId.slice(0, 8)}
              </span>
            </div>

            <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
              {questions.length > 0 ? questions.map((question) => (
                <section key={question.header} className="rounded border border-white/10 bg-black/35 p-2">
                  <p className="text-sm text-white">{question.question}</p>
                  <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-white/55">{question.header}</p>
                  <div className="mt-2 space-y-1.5">
                    {question.options.map((option) => {
                      const selected = (answers[question.header] ?? []).includes(option.label)
                      if (question.multiSelect) {
                        return (
                          <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-sm hover:border-white/25">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleMultiAnswer(question.header, option.label)}
                              className="mt-0.5"
                            />
                            <span>
                              <span className="block">{option.label}</span>
                              {option.description ? <span className="text-xs text-white/60">{option.description}</span> : null}
                            </span>
                          </label>
                        )
                      }
                      return (
                        <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-sm hover:border-white/25">
                          <input
                            type="radio"
                            name={question.header}
                            checked={selected}
                            onChange={() => setSingleAnswer(question.header, option.label)}
                            className="mt-0.5"
                          />
                          <span>
                            <span className="block">{option.label}</span>
                            {option.description ? <span className="text-xs text-white/60">{option.description}</span> : null}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </section>
              )) : (
                <p className="rounded border border-white/10 bg-black/35 px-2 py-1.5 text-sm text-white/80">
                  This tool did not include selectable options. Submit to acknowledge.
                </p>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between gap-2">
              {askError ? <p className="text-xs text-red-300">{askError}</p> : <div />}
              <button
                type="submit"
                disabled={status !== 'connected' || !askReadyToSubmit}
                className="rounded border border-emerald-300/35 bg-emerald-300/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-emerald-100 transition enabled:hover:bg-emerald-300/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                submit answer
              </button>
            </div>
          </form>
        ) : null}

        <form onSubmit={submitInput} className="border-t border-white/15 bg-black/55 px-3 py-2">
          <div className="flex items-center gap-2">
            <input
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder={`Talk to ${agentId}...`}
              disabled={status !== 'connected'}
              className="h-10 flex-1 rounded-md border border-white/20 bg-black/45 px-3 text-sm text-white placeholder:text-white/35 focus:border-emerald-300/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={status !== 'connected' || inputValue.trim().length === 0}
              className="h-10 rounded-md border border-emerald-300/35 bg-emerald-300/15 px-4 font-mono text-xs uppercase tracking-[0.08em] text-emerald-100 transition enabled:hover:bg-emerald-300/25 disabled:cursor-not-allowed disabled:opacity-45"
            >
              send
            </button>
          </div>
          {inputError ? <p className="mt-1 text-xs text-red-300">{inputError}</p> : null}
        </form>
      </section>
    </div>
  )
}
