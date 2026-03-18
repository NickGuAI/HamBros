import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useSessionWs } from './use-session-ws'
import { useStreamEventProcessor } from '../agents/components/use-stream-event-processor'
import { SessionMessageList } from '../agents/components/SessionMessageList'

interface DialoguePanelProps {
  agentId: string
  onClose: () => void
}

export function DialoguePanel({ agentId, onClose }: DialoguePanelProps) {
  const messagesRef = useRef<HTMLDivElement | null>(null)

  const [inputValue, setInputValue] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)

  const { messages, processEvent, resetMessages, markAskAnswered, pushUserMessage } = useStreamEventProcessor()

  const handleReplayStart = useCallback(() => {
    resetMessages()
  }, [resetMessages])

  const {
    status,
    sendInput,
    sendToolAnswer,
  } = useSessionWs({
    sessionName: agentId,
    onEvent: processEvent,
    onReplayStart: handleReplayStart,
  })

  // Reset state when switching agents
  useEffect(() => {
    setInputValue('')
    setInputError(null)
    resetMessages()
  }, [agentId, resetMessages])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const container = messagesRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [messages])

  const handleAnswer = useCallback(
    (toolId: string, answers: Record<string, string[]>) => {
      const ok = sendToolAnswer(toolId, answers)
      if (ok) {
        markAskAnswered(toolId)
      }
    },
    [sendToolAnswer, markAskAnswered],
  )

  const submitInput = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = inputValue.trim()
    if (!text) return
    const ok = sendInput(text)
    if (!ok) {
      setInputError('Unable to send input. Confirm websocket connection.')
      return
    }
    pushUserMessage(text)
    setInputValue('')
    setInputError(null)
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

        <div ref={messagesRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <SessionMessageList
            messages={messages}
            onAnswer={handleAnswer}
            emptyLabel="No dialogue yet. Send a command to start."
          />
        </div>

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
