import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import {
  Monitor,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  X,
  Plus,
  Power,
  AlertTriangle,
  Cpu,
  FolderOpen,
  Folder,
  Warehouse,
  Brain,
  Bot,
  FileText,
  Pencil,
  TerminalSquare,
  Search,
  FilePlus,
  Check,
  Coins,
  MessageSquare,
  Clock,
  ArrowUp,
  Loader2,
  Zap,
  Mic,
} from 'lucide-react'
import {
  createSession,
  killSession,
  useAgentSessions,
  useMachines,
} from '@/hooks/use-agents'
import { timeAgo, formatCost, formatTokens, cn } from '@/lib/utils'
import { getAccessToken } from '@/lib/api'
import { getWsBase } from '@/lib/api-base'
import { useIsMobile } from '@/hooks/use-is-mobile'
import {
  useOpenAITranscription,
  useOpenAITranscriptionConfig,
} from '@/hooks/use-openai-transcription'
import { useSpeechRecognition } from '@/hooks/use-speech-recognition'
import type { AgentSession, AskOption, AskQuestion, AgentType, ClaudePermissionMode, Machine, SessionType, StreamEvent } from '@/types'
import { createReconnectBackoff, shouldReconnectWebSocketClose } from './ws-reconnect'
import { NewSessionForm } from './components/NewSessionForm'
import { SkillsPicker } from './components/SkillsPicker'
import { WorkingDirectoryPanel } from './components/WorkingDirectoryPanel'

const FolderPanelIcon = FolderOpen

function SessionCard({
  session,
  machine,
  selected,
  onSelect,
}: {
  session: AgentSession
  machine?: Machine
  selected: boolean
  onSelect: () => void
}) {
  const isFactory = session.name.startsWith('factory-')
  const Icon = isFactory ? Warehouse : Monitor
  const isRemote = Boolean(session.host)

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left p-5 card-sumi transition-all duration-300 ease-gentle',
        isFactory && 'border-l-2 border-l-accent-indigo',
        selected && 'ring-1 ring-sumi-black/10 shadow-ink-md',
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Icon size={18} className={isFactory ? 'text-accent-indigo' : 'text-sumi-diluted'} />
          <span className="font-mono text-sm text-sumi-black">{session.name}</span>
          {isFactory && (
            <span className="badge-sumi bg-accent-indigo/10 text-accent-indigo">factory</span>
          )}
          {session.sessionType === 'pty' && (
            <span className="badge-sumi bg-ink-wash text-sumi-gray text-[10px]">pty</span>
          )}
          {session.agentType === 'codex' && (
            <span className="badge-sumi bg-accent-indigo/10 text-accent-indigo text-[10px]">codex</span>
          )}
          {isRemote && (
            <span className="badge-sumi bg-ink-wash text-sumi-gray text-[10px]">
              {machine ? `${machine.label} · ${machine.host}` : session.host}
            </span>
          )}
        </div>
        <ChevronRight
          size={16}
          className={cn(
            'text-sumi-mist transition-transform duration-300',
            selected && 'rotate-90 text-sumi-gray',
          )}
        />
      </div>

      <div className="mt-3 flex items-center gap-4 text-whisper text-sumi-diluted">
        <span className="flex items-center gap-1.5">
          <Cpu size={12} />
          PID {session.pid}
        </span>
        <span>{timeAgo(session.created)}</span>
      </div>
    </button>
  )
}

function formatError(caughtError: unknown, fallback: string): string {
  if (caughtError instanceof Error && caughtError.message) {
    return caughtError.message
  }

  return fallback
}

function TerminalView({
  sessionName,
  onClose,
  onKill,
  isMobileOverlay,
  onToggleFilePanel,
}: {
  sessionName: string
  onClose: () => void
  onKill: (sessionName: string) => Promise<void>
  isMobileOverlay?: boolean
  onToggleFilePanel?: () => void
}) {
  const termRef = useRef<HTMLDivElement>(null)
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  )
  const [isKilling, setIsKilling] = useState(false)

  useEffect(() => {
    if (!termRef.current) {
      return
    }

    setWsStatus('connecting')

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: !isMobileOverlay,
      fontSize: isMobileOverlay ? 11 : 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      theme: {
        background: '#1a1a1a',
        foreground: '#e0ddd5',
      },
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon())
    terminal.loadAddon(new ClipboardAddon())
    terminal.loadAddon(new SearchAddon())
    const unicode11 = new Unicode11Addon()
    terminal.loadAddon(unicode11)
    terminal.unicode.activeVersion = '11'
    terminal.loadAddon(new SerializeAddon())

    // Let the browser handle paste natively (Ctrl+V / Cmd+V)
    terminal.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'v' && event.type === 'keydown') {
        return false
      }
      return true
    })

    terminal.open(termRef.current)
    fitAddon.fit()

    let ws: WebSocket | null = null
    let resizeObserver: ResizeObserver | null = null
    let disposed = false
    let reconnectTimer: number | null = null
    let hasEstablishedConnection = false

    const reconnectBackoff = createReconnectBackoff()
    const encoder = new TextEncoder()

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) {
        return
      }

      setWsStatus('connecting')
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        void connect()
      }, reconnectBackoff.nextDelayMs())
    }

    const connect = async () => {
      clearReconnectTimer()
      setWsStatus('connecting')

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

      const nextSocket = new WebSocket(url)
      nextSocket.binaryType = 'arraybuffer'
      ws = nextSocket

      nextSocket.onopen = () => {
        if (disposed || ws !== nextSocket) {
          return
        }

        reconnectBackoff.reset()
        if (hasEstablishedConnection) {
          terminal.reset()
        }
        hasEstablishedConnection = true
        setWsStatus('connected')

        if (nextSocket.readyState === WebSocket.OPEN) {
          nextSocket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
        }
      }

      nextSocket.onclose = (event) => {
        if (disposed || ws !== nextSocket) {
          return
        }

        ws = null
        if (shouldReconnectWebSocketClose(event)) {
          scheduleReconnect()
          return
        }

        setWsStatus('disconnected')
      }

      nextSocket.onerror = () => {
        if (disposed || ws !== nextSocket) {
          return
        }

        if (
          nextSocket.readyState === WebSocket.CONNECTING ||
          nextSocket.readyState === WebSocket.OPEN
        ) {
          nextSocket.close()
        }
      }

      nextSocket.onmessage = (event) => {
        if (disposed || ws !== nextSocket) {
          return
        }

        if (event.data instanceof ArrayBuffer) {
          terminal.write(new Uint8Array(event.data))
        } else {
          try {
            const msg = JSON.parse(event.data as string) as {
              type: string
              exitCode?: number
              signal?: number
            }
            if (msg.type === 'exit') {
              terminal.write(
                `\r\n[Process exited with code ${msg.exitCode ?? 'unknown'}]\r\n`,
              )
            }
          } catch {
            // Ignore invalid control messages
          }
        }
      }

    }

    const dataDisposable = terminal.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(encoder.encode(data))
      }
    })

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })

    const container = termRef.current
    if (container) {
      resizeObserver = new ResizeObserver(() => {
        fitAddon.fit()
      })
      resizeObserver.observe(container)
    }

    void connect()

    return () => {
      disposed = true
      clearReconnectTimer()
      ws?.close()
      resizeObserver?.disconnect()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      terminal.dispose()
    }
  }, [sessionName])

  async function handleKill() {
    if (isKilling) {
      return
    }

    const confirmed = window.confirm(`Kill session "${sessionName}"?`)
    if (!confirmed) {
      return
    }

    setIsKilling(true)
    try {
      await onKill(sessionName)
    } catch {
      // Error is surfaced through parent state
    } finally {
      setIsKilling(false)
    }
  }

  return (
    <div className={isMobileOverlay ? 'terminal-overlay' : 'flex flex-col h-full'}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-ink-border bg-washi-aged">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-sumi-black">{sessionName}</span>
          <span
            className={cn(
              'badge-sumi',
              wsStatus === 'connected'
                ? 'badge-active'
                : wsStatus === 'connecting'
                  ? 'badge-idle'
                  : 'badge-stale',
            )}
          >
            {wsStatus}
          </span>
          {isMobileOverlay && (
            <span className="badge-sumi text-[10px]">PTY</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onToggleFilePanel && (
            <button
              className="p-2 rounded-lg hover:bg-ink-wash transition-colors inline-flex items-center gap-1.5"
              onClick={onToggleFilePanel}
              aria-label="Toggle file panel"
            >
              <FolderPanelIcon size={14} className="text-sumi-diluted" />
              <span className="text-xs text-sumi-diluted font-mono">Workspace</span>
            </button>
          )}
          <button
            onClick={handleKill}
            disabled={isKilling}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-accent-vermillion hover:bg-accent-vermillion/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            aria-label="Kill session"
          >
            <Power size={14} />
            {isKilling ? 'Killing...' : 'Kill Session'}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-ink-wash transition-colors"
            aria-label="Close terminal"
          >
            <X size={16} className="text-sumi-diluted" />
          </button>
        </div>
      </div>

      <div
        ref={termRef}
        className={cn('flex-1 bg-sumi-black', isMobileOverlay && 'overflow-auto touch-pan-y')}
      />
    </div>
  )
}

// ── Stream-JSON Message UI Types ─────────────────────────────────
const MAX_CLIENT_MESSAGES = 500

/** Cap an array of messages to prevent unbounded memory growth. */
function capMessages(msgs: MsgItem[]): MsgItem[] {
  return msgs.length > MAX_CLIENT_MESSAGES ? msgs.slice(-MAX_CLIENT_MESSAGES) : msgs
}

interface MsgItem {
  id: string
  kind: 'system' | 'user' | 'thinking' | 'agent' | 'tool' | 'ask'
  text: string
  timestamp?: string
  // tool-specific
  toolId?: string
  toolName?: string
  toolFile?: string
  toolStatus?: 'running' | 'success' | 'error'
  toolInput?: string
  subagentDescription?: string
  // diff for Edit tool
  oldString?: string
  newString?: string
  // ask-specific (kind === 'ask')
  askQuestions?: AskQuestion[]
  askAnswered?: boolean
  askSubmitting?: boolean
}

function extractToolDetails(toolName: string | undefined, rawInput: unknown): {
  toolInput: string
  toolFile?: string
  oldString?: string
  newString?: string
} {
  let rawJson = ''
  if (typeof rawInput === 'string') {
    rawJson = rawInput
  } else if (rawInput !== undefined) {
    try {
      rawJson = JSON.stringify(rawInput)
    } catch {
      rawJson = String(rawInput)
    }
  }

  let parsed: Record<string, unknown> | null = null
  if (typeof rawInput === 'string') {
    if (rawInput.trim().length > 0) {
      try {
        parsed = JSON.parse(rawInput) as Record<string, unknown>
      } catch {
        parsed = null
      }
    }
  } else if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    parsed = rawInput as Record<string, unknown>
  }

  let toolInput = rawJson
  let toolFile: string | undefined
  let oldString: string | undefined
  let newString: string | undefined

  if (parsed) {
    toolFile = (parsed.file_path ?? parsed.path ?? parsed.command ?? parsed.pattern) as
      | string
      | undefined
    if (toolName === 'Edit' || toolName === 'MultiEdit') {
      oldString = parsed.old_string as string | undefined
      newString = parsed.new_string as string | undefined
      toolFile = parsed.file_path as string | undefined
    }
    if (toolName === 'Bash') {
      toolInput = (parsed.command as string | undefined) ?? rawJson
      toolFile = parsed.command as string | undefined
    }
  }

  return { toolInput, toolFile, oldString, newString }
}

function extractSubagentDescription(rawInput: unknown): string | undefined {
  let parsed: Record<string, unknown> | null = null

  if (typeof rawInput === 'string') {
    if (!rawInput.trim()) return undefined
    try {
      parsed = JSON.parse(rawInput) as Record<string, unknown>
    } catch {
      return undefined
    }
  } else if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    parsed = rawInput as Record<string, unknown>
  }

  if (!parsed) return undefined
  const description = parsed.description
  if (typeof description === 'string' && description.trim()) {
    return description
  }
  const prompt = parsed.prompt
  if (typeof prompt === 'string' && prompt.trim()) {
    return prompt
  }

  return undefined
}

// Map tool names to icon/color
const TOOL_META: Record<string, { icon: typeof FileText; colorClass: string }> = {
  Read: { icon: FileText, colorClass: 'read' },
  Glob: { icon: Search, colorClass: 'search' },
  Grep: { icon: Search, colorClass: 'search' },
  Edit: { icon: Pencil, colorClass: 'edit' },
  MultiEdit: { icon: Pencil, colorClass: 'edit' },
  Write: { icon: FilePlus, colorClass: 'write' },
  NotebookEdit: { icon: Pencil, colorClass: 'edit' },
  Bash: { icon: TerminalSquare, colorClass: 'bash' },
  WebFetch: { icon: Search, colorClass: 'search' },
  WebSearch: { icon: Search, colorClass: 'search' },
  LSP: { icon: FileText, colorClass: 'read' },
  TodoWrite: { icon: FilePlus, colorClass: 'write' },
  Agent: { icon: Bot, colorClass: 'agent' },
}

function getToolMeta(name: string) {
  return TOOL_META[name] ?? { icon: TerminalSquare, colorClass: 'bash' }
}

// ── Sub-components ──────────────────────────────────────────────

function SystemDivider({ text }: { text: string }) {
  return (
    <div className="message">
      <div className="msg-system">
        <div className="msg-system-line" />
        <span className="msg-system-text">{text}</span>
        <div className="msg-system-line" />
      </div>
    </div>
  )
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="message">
      <div className="msg-user">{text}</div>
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <div className="message">
      <div className="msg-thinking">
        <div className="msg-thinking-label">
          <Brain size={11} />
          Thinking
        </div>
        {text}
      </div>
    </div>
  )
}

function AgentMessage({ text }: { text: string }) {
  return (
    <div className="message">
      <div className="msg-agent msg-agent-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  )
}

function RunningAgentsPanel({ messages }: { messages: MsgItem[] }) {
  const runningAgents = messages.filter(
    (m) => m.kind === 'tool' && m.toolName === 'Agent' && m.toolStatus === 'running',
  )

  if (runningAgents.length === 0) {
    return null
  }

  return (
    <div className="running-agents-panel">
      <div className="running-agents-label">
        <Bot size={12} />
        Running Sub-agents
      </div>
      {runningAgents.map((msg) => (
        <div key={msg.id} className="running-agent-item">
          <Loader2 size={11} className="animate-spin" />
          <span>{msg.subagentDescription ?? 'Agent'}</span>
        </div>
      ))}
    </div>
  )
}

function ToolBlock({ msg }: { msg: MsgItem }) {
  const [expanded, setExpanded] = useState(false)
  const meta = getToolMeta(msg.toolName ?? '')
  const ToolIcon = meta.icon

  const hasEditDiff = (msg.toolName === 'Edit' || msg.toolName === 'MultiEdit') && (msg.oldString || msg.newString)

  return (
    <div className={cn('message')}>
      <div className={cn('msg-tool', expanded && 'expanded')}>
        <div className="msg-tool-header" onClick={() => setExpanded((p) => !p)}>
          <div className="msg-tool-header-left">
            <div className={cn('msg-tool-icon', meta.colorClass)}>
              <ToolIcon size={14} />
            </div>
            <div>
              <div className="msg-tool-name">{msg.toolName}</div>
              {msg.toolFile && <div className="msg-tool-file">{msg.toolFile}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className={cn('msg-tool-status', msg.toolStatus ?? 'running')}>
              {msg.toolStatus === 'running' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : msg.toolStatus === 'error' ? (
                <AlertTriangle size={11} />
              ) : (
                <Check size={11} />
              )}
              {msg.toolStatus ?? 'running'}
            </div>
            <ChevronRight
              size={14}
              className={cn('msg-tool-chevron', expanded && 'expanded')}
            />
          </div>
        </div>
        <div className="msg-tool-body">
          {hasEditDiff ? (
            <>
              {msg.oldString && (
                <div className="diff-line diff-remove">{msg.oldString}</div>
              )}
              {msg.newString && (
                <div className="diff-line diff-add">{msg.newString}</div>
              )}
            </>
          ) : (
            msg.toolInput ?? ''
          )}
        </div>
      </div>
    </div>
  )
}

function AskUserQuestionBlock({
  msg,
  onAnswer,
}: {
  msg: MsgItem
  onAnswer: (toolId: string, answers: Record<string, string[]>) => void
}) {
  const questions = msg.askQuestions ?? []
  const [selections, setSelections] = useState<Record<number, string[]>>(() =>
    Object.fromEntries(questions.map((_, i) => [i, []]))
  )
  const [customTexts, setCustomTexts] = useState<Record<number, string>>(() =>
    Object.fromEntries(questions.map((_, i) => [i, '']))
  )

  if (msg.askAnswered) {
    return (
      <div className="message">
        <div className="msg-ask msg-ask-done">
          <Check size={12} />
          <span>Response submitted</span>
        </div>
      </div>
    )
  }

  function toggleOption(questionIdx: number, label: string, multiSelect: boolean) {
    setSelections((prev) => {
      const current = prev[questionIdx] ?? []
      if (multiSelect) {
        return {
          ...prev,
          [questionIdx]: current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label],
        }
      }
      return { ...prev, [questionIdx]: [label] }
    })
  }

  function handleSubmit() {
    const answers: Record<string, string[]> = {}
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const selected = selections[i] ?? []
      const custom = customTexts[i]?.trim()
      answers[q.question] = custom ? [...selected, custom] : selected
    }
    onAnswer(msg.toolId ?? '', answers)
  }

  const allAnswered = questions.every((_, i) => {
    const sel = selections[i] ?? []
    const custom = customTexts[i]?.trim()
    return sel.length > 0 || Boolean(custom)
  })

  return (
    <div className="message">
      <div className="msg-ask">
        {questions.map((q, qi) => (
          <div key={qi} className="msg-ask-question">
            <div className="msg-ask-question-text">{q.question}</div>
            <div className="msg-ask-options">
              {q.options.map((opt) => {
                const selected = (selections[qi] ?? []).includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    type="button"
                    className={cn('msg-ask-chip', selected && 'selected')}
                    onClick={() => toggleOption(qi, opt.label, q.multiSelect)}
                    title={opt.description}
                  >
                    {selected && <Check size={10} />}
                    {opt.label}
                  </button>
                )
              })}
            </div>
            <input
              type="text"
              className="msg-ask-other"
              placeholder="Other…"
              value={customTexts[qi] ?? ''}
              onChange={(e) =>
                setCustomTexts((prev) => ({ ...prev, [qi]: e.target.value }))
              }
            />
          </div>
        ))}
        <button
          type="button"
          className="msg-ask-submit"
          onClick={handleSubmit}
          disabled={!allAnswered || !!msg.askSubmitting}
        >
          {msg.askSubmitting ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </div>
  )
}

function StreamingDots() {
  return (
    <div className="message">
      <div className="msg-streaming">
        <div className="streaming-dots">
          <div className="streaming-dot" />
          <div className="streaming-dot" />
          <div className="streaming-dot" />
        </div>
      </div>
    </div>
  )
}

function SessionStatsBar({
  cost,
  tokens,
  duration,
}: {
  cost: number
  tokens: number
  duration: string
}) {
  return (
    <div className="session-stats">
      <div className="session-stat">
        <Coins size={10} />
        <span className="session-stat-value">{formatCost(cost)}</span> cost
      </div>
      <div className="session-stat">
        <MessageSquare size={10} />
        <span className="session-stat-value">{formatTokens(tokens)}</span> tokens
      </div>
      <div className="session-stat">
        <Clock size={10} />
        <span className="session-stat-value">{duration}</span>
      </div>
    </div>
  )
}

// ── MobileSessionView ───────────────────────────────────────────

function MobileSessionView({
  sessionName,
  sessionCwd,
  onClose,
  onKill,
  onToggleFilePanel,
}: {
  sessionName: string
  sessionCwd?: string
  onClose: () => void
  onKill: (sessionName: string) => Promise<void>
  onToggleFilePanel?: () => void
}) {
  const [messages, setMessages] = useState<MsgItem[]>([])
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [isKilling, setIsKilling] = useState(false)
  const [inputText, setInputText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0, costUsd: 0 })
  const [startedAt] = useState(() => Date.now())
  const [elapsedSec, setElapsedSec] = useState(0)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesAreaRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const autoScrollRef = useRef(true)
  const idCounterRef = useRef(0)
  const { data: realtimeTranscriptionConfig } = useOpenAITranscriptionConfig()
  const openAITranscription = useOpenAITranscription({
    enabled: Boolean(realtimeTranscriptionConfig?.openaiConfigured),
  })
  const speechRecognition = useSpeechRecognition()
  const activeTranscription =
    realtimeTranscriptionConfig?.openaiConfigured && openAITranscription.isSupported
      ? openAITranscription
      : speechRecognition
  const {
    isListening: isMicListening,
    transcript: speechTranscript,
    startListening,
    stopListening,
    isSupported: isMicSupported,
  } = activeTranscription
  // Track current blocks being built
  const currentBlockRef = useRef<{
    type: 'text' | 'thinking' | 'tool_use'
    msgId: string
    toolName?: string
    toolId?: string
    inputJsonParts?: string[]
  } | null>(null)

  function nextId() {
    return `msg-${++idCounterRef.current}`
  }

  // Update elapsed time every second so the stats bar stays current
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  useEffect(() => {
    const normalizedTranscript = speechTranscript.trim()
    if (!normalizedTranscript) return

    setInputText((prev) => {
      const currentText = prev.trimEnd()
      return currentText ? `${currentText} ${normalizedTranscript}` : normalizedTranscript
    })

    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
      textarea.focus()
    })
  }, [speechTranscript])

  function getDuration() {
    const m = Math.floor(elapsedSec / 60)
    const s = elapsedSec % 60
    return `${m}m ${s.toString().padStart(2, '0')}s`
  }

  // Auto-scroll logic
  useEffect(() => {
    if (autoScrollRef.current && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isStreaming])

  function handleScroll() {
    const area = messagesAreaRef.current
    if (!area) return
    const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 60
    autoScrollRef.current = atBottom
  }

  // Process a single stream-json event into the messages state.
  // Wrapped in useCallback with empty deps — all captured values are either
  // refs (currentBlockRef, idCounterRef) or React state setters, both of
  // which are stable across renders.  This ensures the WebSocket onmessage
  // handler always calls the same function reference without stale closures.
  const processEvent = useCallback((event: StreamEvent, isReplay = false) => {
    switch (event.type) {
      case 'assistant': {
        const blocks = event.message?.content
        if (!Array.isArray(blocks)) {
          break
        }

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
            if (!text) continue
            const id = nextId()
            setMessages((prev) => capMessages([...prev, { id, kind: 'thinking', text }]))
          } else if (block.type === 'tool_use') {
            const id = nextId()
            if (block.name === 'AskUserQuestion') {
              const input = block.input as { questions?: AskQuestion[] } | undefined
              setMessages((prev) => {
                const existingAskIndex = prev.findIndex(
                  (m) => m.kind === 'ask' && m.toolId === block.id,
                )
                if (existingAskIndex !== -1) {
                  const nextQuestions = input?.questions
                  if (!nextQuestions || nextQuestions.length === 0) {
                    return prev
                  }
                  const existing = prev[existingAskIndex]
                  if ((existing.askQuestions?.length ?? 0) > 0) {
                    return prev
                  }
                  const updated = [...prev]
                  updated[existingAskIndex] = { ...existing, askQuestions: nextQuestions }
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
                block.name === 'Agent' ? extractSubagentDescription(block.input) : undefined
              setMessages((prev) => capMessages([
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
              ]))
            }
          }
        }

        if (event.message.usage && !isReplay) {
          setUsage((prev) => ({
            inputTokens: prev.inputTokens + (event.message.usage?.input_tokens ?? 0),
            outputTokens: prev.outputTokens + (event.message.usage?.output_tokens ?? 0),
            costUsd: prev.costUsd,
          }))
        }
        break
      }
      case 'user': {
        const content = event.message?.content
        // Handle plain text user messages — only during replay to avoid
        // duplicating the optimistic message already added by handleSend
        if (typeof content === 'string' && content.trim() && isReplay) {
          setMessages((prev) => capMessages([...prev, { id: nextId(), kind: 'user', text: content.trim() }]))
          break
        }
        if (!Array.isArray(content)) {
          break
        }
        const toolResults = content.filter((b) => b.type === 'tool_result')
        if (toolResults.length === 0) {
          break
        }

        setMessages((prev) => {
          const updated = [...prev]

          for (const result of toolResults) {
            const status = result.is_error ? ('error' as const) : ('success' as const)
            let matched = false

            if (result.tool_use_id) {
              for (let i = updated.length - 1; i >= 0; i--) {
                const msg = updated[i]
                if (
                  msg.kind === 'tool' &&
                  msg.toolStatus === 'running' &&
                  msg.toolId === result.tool_use_id
                ) {
                  updated[i] = { ...msg, toolStatus: status }
                  matched = true
                  break
                }
              }
            }

            if (!matched) {
              for (let i = updated.length - 1; i >= 0; i--) {
                const msg = updated[i]
                if (msg.kind === 'tool' && msg.toolStatus === 'running') {
                  updated[i] = { ...msg, toolStatus: status }
                  break
                }
              }
            }
          }

          return capMessages(updated)
        })
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
          const id = nextId()
          currentBlockRef.current = {
            type: 'tool_use',
            msgId: id,
            toolName: block.name,
            toolId: block.id,
            inputJsonParts: [],
          }
          if (block.name !== 'AskUserQuestion') {
            setMessages((prev) => capMessages([
              ...prev,
              {
                id,
                kind: 'tool',
                text: '',
                toolId: block.id,
                toolName: block.name,
                toolStatus: 'running',
                toolInput: '',
              },
            ]))
            if (!isReplay) setIsStreaming(true)
          }
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
            // The target message is almost always the last element (streaming
            // appends to the most recently added bubble).  Check the tail
            // first to avoid an O(n) scan on every delta.
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
        }
        break
      }
      case 'content_block_stop': {
        const cur = currentBlockRef.current
        if (cur?.type === 'tool_use') {
          const rawJson = cur.inputJsonParts?.join('') ?? ''
          if (cur.toolName === 'AskUserQuestion') {
            let questions: AskQuestion[] = []
            try {
              const input = JSON.parse(rawJson) as { questions?: AskQuestion[] }
              questions = input.questions ?? []
            } catch {
              // Ignore parse errors — AskUserQuestion data can already come from envelope events.
            }
            setMessages((prev) => {
              const existingAskIndex = prev.findIndex(
                (m) => m.kind === 'ask' && m.toolId === cur.toolId,
              )
              if (existingAskIndex !== -1) {
                const existing = prev[existingAskIndex]
                if (questions.length === 0 || (existing.askQuestions?.length ?? 0) > 0) {
                  return prev
                }
                const updated = [...prev]
                updated[existingAskIndex] = { ...existing, askQuestions: questions }
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
              cur.toolName === 'Agent' ? extractSubagentDescription(rawJson) : undefined
            setMessages((prev) =>
              prev.map((m) =>
                m.id === cur.msgId
                  ? { ...m, toolInput, toolFile, oldString, newString, subagentDescription }
                  : m,
              ),
            )
          }
        }
        currentBlockRef.current = null
        break
      }
      case 'message_start': {
        // Mark any running tool as success (new turn means tool completed)
        setMessages((prev) =>
          prev.map((m) =>
            m.kind === 'tool' && m.toolStatus === 'running'
              ? { ...m, toolStatus: 'success' }
              : m,
          ),
        )
        setIsStreaming(false)
        break
      }
      case 'message_delta': {
        // message_delta.usage contains per-message token counts (cumulative
        // within that single message, not across the session). We accumulate
        // (`+=`) across turns to build session totals. The `result` event
        // carries session-level cumulative totals and overrides directly.
        // Skip during replay — the replay message includes pre-accumulated totals.
        if (event.usage && !isReplay) {
          setUsage((prev) => ({
            inputTokens: prev.inputTokens + (event.usage?.input_tokens ?? 0),
            outputTokens: prev.outputTokens + (event.usage?.output_tokens ?? 0),
            costUsd: prev.costUsd,
          }))
        }
        break
      }
      case 'message_stop': {
        setIsStreaming(false)
        break
      }
      case 'result': {
        // result.usage is session-level cumulative — override accumulated
        // totals from message_delta events. Merge cost and usage into a
        // single setUsage call to avoid React batching issues.
        // Skip during replay — the replay message includes pre-accumulated totals.
        if ((event.cost_usd !== undefined || event.total_cost_usd !== undefined || event.usage) && !isReplay) {
          setUsage((prev) => ({
            inputTokens: event.usage?.input_tokens ?? prev.inputTokens,
            outputTokens: event.usage?.output_tokens ?? prev.outputTokens,
            costUsd: event.total_cost_usd ?? event.cost_usd ?? prev.costUsd,
          }))
        }
        // Mark running tools as error/success AND append "Awaiting input" in
        // a single setMessages call to avoid batching issues where the second
        // call could see stale state.
        const resultToolStatus = event.is_error ? 'error' as const : 'success' as const
        setMessages((prev) => capMessages([
          ...prev.map((m) =>
            m.kind === 'tool' && m.toolStatus === 'running'
              ? { ...m, toolStatus: resultToolStatus }
              : m,
          ),
          { id: nextId(), kind: 'system', text: 'Awaiting input' },
        ]))
        setIsStreaming(false)
        break
      }
      case 'exit': {
        // Mark any still-running tools as error (process exited before completing)
        setMessages((prev) => {
          const hasRunningTools = prev.some((m) => m.kind === 'tool' && m.toolStatus === 'running')
          if (!hasRunningTools) return capMessages([...prev, { id: nextId(), kind: 'system', text: 'Session ended' }])
          return capMessages([
            ...prev.map((m) =>
              m.kind === 'tool' && m.toolStatus === 'running'
                ? { ...m, toolStatus: 'error' as const }
                : m,
            ),
            { id: nextId(), kind: 'system', text: 'Session ended' },
          ])
        })
        setIsStreaming(false)
        break
      }
      case 'system': {
        setMessages((prev) => capMessages([
          ...prev,
          { id: nextId(), kind: 'system', text: event.text },
        ]))
        break
      }
      default:
        break
    }
  }, []) // stable: only uses refs + state setters

  // WebSocket connection
  useEffect(() => {
    // Reset block-tracking state from any previous connection so replay
    // events don't target stale message IDs (P1: ghost running tools).
    currentBlockRef.current = null

    setMessages([{ id: nextId(), kind: 'system', text: 'Session started' }])
    setWsStatus('connecting')
    let disposed = false
    let reconnectTimer: number | null = null

    const reconnectBackoff = createReconnectBackoff()

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) {
        return
      }

      setWsStatus('connecting')
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        void connect()
      }, reconnectBackoff.nextDelayMs())
    }

    const connect = async () => {
      clearReconnectTimer()
      setWsStatus('connecting')

      const token = await getAccessToken()
      if (disposed) return

      const params = new URLSearchParams()
      if (token) params.set('access_token', token)
      const wsBase = getWsBase()
      const url = wsBase
        ? `${wsBase}/api/agents/sessions/${encodeURIComponent(sessionName)}/terminal?${params}`
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/agents/sessions/${encodeURIComponent(sessionName)}/terminal?${params}`

      const nextSocket = new WebSocket(url)
      wsRef.current = nextSocket

      nextSocket.onopen = () => {
        if (disposed || wsRef.current !== nextSocket) return
        reconnectBackoff.reset()
        setWsStatus('connected')
      }

      nextSocket.onclose = (event) => {
        if (disposed || wsRef.current !== nextSocket) return

        wsRef.current = null
        setIsStreaming(false)
        if (shouldReconnectWebSocketClose(event)) {
          scheduleReconnect()
          return
        }

        setWsStatus('disconnected')
      }

      nextSocket.onerror = () => {
        if (disposed || wsRef.current !== nextSocket) return

        if (
          nextSocket.readyState === WebSocket.CONNECTING ||
          nextSocket.readyState === WebSocket.OPEN
        ) {
          nextSocket.close()
        }
      }

      nextSocket.onmessage = (evt) => {
        if (disposed || wsRef.current !== nextSocket) return
        try {
          const raw = JSON.parse(evt.data as string) as {
            type: string
            events?: StreamEvent[]
            usage?: { inputTokens: number; outputTokens: number; costUsd: number }
            toolId?: string
          }
          if (raw.type === 'replay' && Array.isArray(raw.events)) {
            currentBlockRef.current = null
            setMessages(raw.events.length === 0 ? [{ id: nextId(), kind: 'system', text: 'Session started' }] : [])
            setIsStreaming(false)

            // Replay buffered events — pass isReplay=true so individual
            // message_delta/result events skip additive usage accumulation.
            for (const event of raw.events) {
              processEvent(event, true)
            }
            // Set usage from the server's pre-accumulated totals to
            // avoid double-counting on reconnect.
            setUsage(raw.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 })
          } else if (raw.type === 'tool_answer_ack' && raw.toolId) {
            setMessages((prev) => prev.map((m) =>
              m.toolId === raw.toolId ? { ...m, askAnswered: true, askSubmitting: false } : m
            ))
          } else if (raw.type === 'tool_answer_error' && raw.toolId) {
            setMessages((prev) => prev.map((m) =>
              m.toolId === raw.toolId ? { ...m, askSubmitting: false } : m
            ))
          } else {
            processEvent(raw as StreamEvent)
          }
        } catch {
          // Ignore non-JSON messages
        }
      }
    }

    void connect()

    return () => {
      disposed = true
      clearReconnectTimer()
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [sessionName, processEvent])

  function handleSend() {
    const text = inputText.trim()
    if (!text || wsRef.current?.readyState !== WebSocket.OPEN) return

    setMessages((prev) => capMessages([
      ...prev,
      { id: nextId(), kind: 'user', text },
    ]))
    wsRef.current.send(JSON.stringify({ type: 'input', text }))
    setInputText('')
    setIsStreaming(true)
    autoScrollRef.current = true
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  function handleAnswer(toolId: string, answers: Record<string, string[]>) {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    setMessages((prev) => prev.map((m) => m.toolId === toolId ? { ...m, askSubmitting: true } : m))
    wsRef.current.send(JSON.stringify({ type: 'tool_answer', toolId, answers }))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInputText(e.target.value)
    // Auto-resize
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  function handleMicToggle() {
    if (isMicListening) {
      stopListening()
      return
    }
    startListening()
  }

  async function handleKill() {
    if (isKilling) return
    const confirmed = window.confirm(`Kill session "${sessionName}"?`)
    if (!confirmed) return
    setIsKilling(true)
    try {
      await onKill(sessionName)
    } catch {
      // Error surfaced through parent
    } finally {
      setIsKilling(false)
    }
  }

  return (
    <div className="session-view-overlay">
      {/* Header */}
      <div className="session-header">
        <div className="session-header-left">
          <button className="session-back" onClick={onClose} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <span className="session-name">{sessionName}</span>
          <span className={cn('session-badge', wsStatus === 'connected' && 'connected')}>
            {wsStatus}
          </span>
        </div>
        <div className="session-header-actions">
          {onToggleFilePanel && (
            <button
              className="p-2 rounded-lg hover:bg-ink-wash transition-colors inline-flex items-center gap-1.5"
              onClick={onToggleFilePanel}
              aria-label="Toggle file panel"
            >
              <FolderPanelIcon size={14} className="text-sumi-diluted" />
              <span className="text-xs text-sumi-diluted font-mono">Workspace</span>
            </button>
          )}
          <button
            className="session-action-btn"
            onClick={handleKill}
            disabled={isKilling}
          >
            <Power size={14} />
            {isKilling ? '...' : 'Kill'}
          </button>
          <button className="session-close-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <SessionStatsBar
        cost={usage.costUsd}
        tokens={usage.inputTokens + usage.outputTokens}
        duration={getDuration()}
      />

      {sessionCwd && (
        <WorkingDirectoryPanel
          cwd={sessionCwd}
          position="compact"
          variant="dark"
          onInsertPath={(p) => {
            setInputText((prev) => prev + p + ' ')
            textareaRef.current?.focus()
          }}
        />
      )}

      {/* Messages area */}
      <div
        className="messages-area"
        ref={messagesAreaRef}
        onScroll={handleScroll}
      >
        {isStreaming && <RunningAgentsPanel messages={messages} />}
        {messages.map((msg) => {
          switch (msg.kind) {
            case 'system':
              return <SystemDivider key={msg.id} text={msg.text} />
            case 'user':
              return <UserMessage key={msg.id} text={msg.text} />
            case 'thinking':
              return <ThinkingBlock key={msg.id} text={msg.text} />
            case 'agent':
              return <AgentMessage key={msg.id} text={msg.text} />
            case 'tool':
              return <ToolBlock key={msg.id} msg={msg} />
            case 'ask':
              return <AskUserQuestionBlock key={msg.id} msg={msg} onAnswer={handleAnswer} />
            default:
              return null
          }
        })}
        {isStreaming && <StreamingDots />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="input-bar">
        <textarea
          ref={textareaRef}
          className="input-field"
          rows={1}
          placeholder="Send a message..."
          value={inputText}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className={cn(
            'p-2 transition-colors',
            showSkills ? 'text-sumi-black' : 'text-sumi-diluted hover:text-sumi-black',
          )}
          onClick={() => setShowSkills(true)}
          aria-label="Skills"
        >
          <Zap size={18} />
        </button>
        {isMicSupported && (
          <button
            type="button"
            className={cn('mic-btn', isMicListening && 'recording')}
            onClick={handleMicToggle}
            aria-label={isMicListening ? 'Stop voice input' : 'Start voice input'}
            aria-pressed={isMicListening}
            title={isMicListening ? 'Stop listening' : 'Start voice input'}
          >
            <Mic size={18} />
          </button>
        )}
        <button
          className="send-btn"
          onClick={handleSend}
          disabled={!inputText.trim() || wsStatus !== 'connected'}
          aria-label="Send"
        >
          <ArrowUp size={18} />
        </button>
      </div>

      <SkillsPicker
        visible={showSkills}
        onSelectSkill={(cmd) => setInputText(cmd + ' ')}
        onClose={() => setShowSkills(false)}
      />
    </div>
  )
}

export default function AgentsPage() {
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: sessions, isLoading } = useAgentSessions()
  const { data: machines } = useMachines()
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [showNewSessionForm, setShowNewSessionForm] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<ClaudePermissionMode>('default')
  const [task, setTask] = useState('')
  const [cwd, setCwd] = useState('')
  const [agentType, setAgentType] = useState<AgentType>('claude')
  const [sessionType, setSessionType] = useState<SessionType>('stream')
  const [selectedHost, setSelectedHost] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [killError, setKillError] = useState<string | null>(null)
  const [showFilePanel, setShowFilePanel] = useState(false)
  type SessionTab = 'all' | 'regular' | 'factory' | 'command-room'
  const [sessionTab, setSessionTab] = useState<SessionTab>('all')
  const machineList = machines ?? []
  const machineMap = new Map(machineList.map((machine) => [machine.id, machine]))

  useEffect(() => {
    const paramCwd = searchParams.get('cwd')
    const paramName = searchParams.get('name')
    if (paramCwd || paramName) {
      if (paramCwd) setCwd(paramCwd)
      if (paramName) setName(paramName)
      setShowNewSessionForm(true)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (!selectedSession || !sessions) {
      return
    }

    const stillExists = sessions.some((session) => session.name === selectedSession)
    if (!stillExists) {
      setSelectedSession(null)
    }
  }, [selectedSession, sessions])

  async function refreshSessions() {
    await queryClient.invalidateQueries({ queryKey: ['agents', 'sessions'] })
  }

  const handleCreateSession = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isCreating) {
      return
    }

    setIsCreating(true)
    setCreateError(null)

    try {
      const result = await createSession({
        name: name.trim(),
        mode,
        task: task.trim() || undefined,
        cwd: cwd.trim() || undefined,
        sessionType,
        agentType,
        host: selectedHost || undefined,
      })

      setName('')
      setTask('')
      setCwd('')
      setMode('default')
      setAgentType('claude')
      setSessionType('stream')
      setSelectedHost('')
      setShowNewSessionForm(false)
      setSelectedSession(result.sessionName)
      await refreshSessions()
    } catch (caughtError) {
      setCreateError(formatError(caughtError, 'Failed to create session'))
    } finally {
      setIsCreating(false)
    }
  }, [isCreating, name, mode, task, cwd, agentType, sessionType, selectedHost, isMobile, queryClient])

  async function handleKillSession(sessionName: string) {
    try {
      await killSession(sessionName)
      setSelectedSession(null)
      await refreshSessions()
    } catch (caughtError) {
      const message = formatError(caughtError, 'Failed to kill session')
      setKillError(message)
      throw caughtError
    }
  }

  const selectedSessionData = sessions?.find((s) => s.name === selectedSession)

  const filteredSessions = sessions?.filter((s) => {
    if (sessionTab === 'factory') return s.name.startsWith('factory-')
    if (sessionTab === 'command-room') return s.name.startsWith('command-room-')
    if (sessionTab === 'regular') return !s.name.startsWith('factory-') && !s.name.startsWith('command-room-')
    return true
  })

  return (
    <div className="flex h-full">
      {/* Session list — full width on mobile, sidebar on desktop when terminal is open */}
      <div
        className={cn(
          'flex flex-col border-r border-ink-border transition-all duration-500 ease-gentle overflow-y-auto pb-20 md:pb-0',
          selectedSession && !isMobile ? 'w-80' : 'w-full max-w-2xl mx-auto',
        )}
      >
        <div className="px-4 py-6 md:px-6 md:py-8">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-display text-sumi-black">Agents</h2>
              <p className="mt-2 text-sm text-sumi-diluted leading-relaxed">
                Active PTY sessions across the system
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowNewSessionForm((current) => !current)
                setCreateError(null)
              }}
              className="btn-ghost inline-flex items-center gap-1.5"
            >
              <Plus size={14} />
              {showNewSessionForm ? 'Close' : 'New Session'}
            </button>
          </div>

          {/* New session form: bottom sheet on mobile, inline card on desktop */}
          {isMobile ? (
            <>
              <div
                className={cn('sheet-backdrop', showNewSessionForm && 'visible')}
                onClick={() => setShowNewSessionForm(false)}
              />
              <div className={cn('sheet', showNewSessionForm && 'visible')}>
                <div className="sheet-handle">
                  <div className="sheet-handle-bar" />
                </div>
                <div className="px-5 pb-4">
                  <h3 className="font-display text-heading text-sumi-black mb-4">New Session</h3>
                  <NewSessionForm
                    name={name}
                    setName={setName}
                    cwd={cwd}
                    setCwd={setCwd}
                    mode={mode}
                    setMode={setMode}
                    task={task}
                    setTask={setTask}
                    agentType={agentType}
                    setAgentType={setAgentType}
                    sessionType={sessionType}
                    setSessionType={setSessionType}
                    machines={machineList}
                    selectedHost={selectedHost}
                    setSelectedHost={setSelectedHost}
                    isCreating={isCreating}
                    createError={createError}
                    onSubmit={handleCreateSession}
                  />
                </div>
              </div>
            </>
          ) : (
            showNewSessionForm && (
              <div className="mt-5 card-sumi p-4">
                <NewSessionForm
                  name={name}
                  setName={setName}
                  cwd={cwd}
                  setCwd={setCwd}
                  mode={mode}
                  setMode={setMode}
                  task={task}
                  setTask={setTask}
                  agentType={agentType}
                  setAgentType={setAgentType}
                  sessionType={sessionType}
                  setSessionType={setSessionType}
                  machines={machineList}
                  selectedHost={selectedHost}
                  setSelectedHost={setSelectedHost}
                  isCreating={isCreating}
                  createError={createError}
                  onSubmit={handleCreateSession}
                />
              </div>
            )
          )}

          {killError && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
              <AlertTriangle size={15} className="mt-0.5" />
              <span>{killError}</span>
            </div>
          )}
        </div>

        {/* Session type tabs */}
        {sessions && sessions.length > 0 && (
          <div className="px-4 pb-3 flex gap-1">
            {(['all', 'regular', 'factory', 'command-room'] as SessionTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setSessionTab(tab)}
                className={cn(
                  'badge-sumi capitalize transition-colors',
                  sessionTab === tab ? 'bg-sumi-black text-white' : 'hover:bg-washi-shadow',
                )}
              >
                {tab}
              </button>
            ))}
          </div>
        )}

        <div className="px-4 pb-4 space-y-3">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
            </div>
          ) : filteredSessions?.length === 0 ? (
            <div className="text-center py-12 text-sumi-diluted text-sm">
              No {sessionTab === 'all' ? '' : sessionTab + ' '}sessions
            </div>
          ) : (
            filteredSessions?.map((session) => (
              <SessionCard
                key={session.name}
                session={session}
                machine={session.host ? machineMap.get(session.host) : undefined}
                selected={selectedSession === session.name}
                onSelect={() =>
                  setSelectedSession(
                    selectedSession === session.name ? null : session.name,
                  )
                }
              />
            ))
          )}
        </div>

        {filteredSessions && (
          <div className="px-6 py-3 mt-auto border-t border-ink-border">
            <p className="text-whisper text-sumi-mist">
              {filteredSessions.length} session{filteredSessions.length !== 1 ? 's' : ''} &middot; auto-refreshing
            </p>
          </div>
        )}
      </div>

      {/* Session view: stream sessions use MobileSessionView (chat UI), PTY sessions use TerminalView */}
      {selectedSession && (
        selectedSessionData?.sessionType === 'stream' ? (
          isMobile ? (
            <MobileSessionView
              sessionName={selectedSession}
              sessionCwd={selectedSessionData?.cwd}
              onClose={() => setSelectedSession(null)}
              onKill={handleKillSession}
            />
          ) : (
            <div className="flex-1 flex animate-fade-in">
              <div className="flex-1 min-w-0">
                <MobileSessionView
                  sessionName={selectedSession}
                  sessionCwd={selectedSessionData?.cwd}
                  onClose={() => setSelectedSession(null)}
                  onKill={handleKillSession}
                  onToggleFilePanel={() => setShowFilePanel((p) => !p)}
                />
              </div>
              {showFilePanel && selectedSessionData?.cwd && (
                <WorkingDirectoryPanel
                  cwd={selectedSessionData.cwd}
                  position="side"
                  onClose={() => setShowFilePanel(false)}
                />
              )}
            </div>
          )
        ) : (
          isMobile ? (
            <TerminalView
              sessionName={selectedSession}
              onClose={() => setSelectedSession(null)}
              onKill={handleKillSession}
              isMobileOverlay
            />
          ) : (
            <div className="flex-1 flex animate-fade-in">
              <div className="flex-1 min-w-0">
                <TerminalView
                  sessionName={selectedSession}
                  onClose={() => setSelectedSession(null)}
                  onKill={handleKillSession}
                  onToggleFilePanel={() => setShowFilePanel((p) => !p)}
                />
              </div>
              {showFilePanel && selectedSessionData?.cwd && (
                <WorkingDirectoryPanel
                  cwd={selectedSessionData.cwd}
                  position="side"
                  onClose={() => setShowFilePanel(false)}
                />
              )}
            </div>
          )
        )
      )}
    </div>
  )
}
