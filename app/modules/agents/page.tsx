import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
  X,
  Plus,
  Power,
  AlertTriangle,
  Cpu,
  Warehouse,
  ArrowUp,
  Zap,
  Mic,
  Paperclip,
  RotateCcw,
  MoreVertical,
} from 'lucide-react'
import {
  createSession,
  killSession,
  resumeSession as resumeAgentSession,
  triggerPreKillDebrief,
  getDebriefStatus,
  resetSession,
  useAgentSessions,
  useMachines,
} from '@/hooks/use-agents'
import { timeAgo, formatCost, cn } from '@/lib/utils'
import { fetchJson, getAccessToken } from '@/lib/api'
import { getWsBase } from '@/lib/api-base'
import { useIsMobile } from '@/hooks/use-is-mobile'
import {
  useOpenAITranscription,
  useOpenAITranscriptionConfig,
} from '@/hooks/use-openai-transcription'
import { useSpeechRecognition } from '@/hooks/use-speech-recognition'
import type { AgentSession, AgentType, ClaudePermissionMode, Machine, SessionType, StreamEvent } from '@/types'
import { createReconnectBackoff, shouldReconnectWebSocketClose } from './ws-reconnect'
import { DEFAULT_SESSION_TAB, filterSessionsByTab, SESSION_TABS, type SessionTab } from './session-tab'
import { NewSessionForm } from './components/NewSessionForm'
import { SessionMessageList } from './components/SessionMessageList'
import { SkillsPicker } from './components/SkillsPicker'
import { WorkspaceOverlay } from './components/WorkspaceOverlay'
import { capMessages } from './components/session-messages'
import { useStreamEventProcessor } from './components/use-stream-event-processor'

type WorkerStatus = 'running' | 'down' | 'starting' | 'done'

interface WorkerInfo {
  name: string
  status: WorkerStatus
  phase: 'starting' | 'running' | 'exited'
}

interface WorkerSummary {
  total: number
  running: number
  down: number
  starting: number
  done: number
}

type AgentSessionWithWorkers = AgentSession & {
  processAlive?: boolean
  hadResult?: boolean
  resumedFrom?: string
  parentSession?: string
  spawnedWorkers?: string[]
  workerSummary?: WorkerSummary
}

function summarizeWorkers(workers: WorkerInfo[]): WorkerSummary {
  const summary: WorkerSummary = {
    total: workers.length,
    running: 0,
    down: 0,
    starting: 0,
    done: 0,
  }
  for (const worker of workers) {
    if (worker.status === 'running') summary.running += 1
    if (worker.status === 'down') summary.down += 1
    if (worker.status === 'starting') summary.starting += 1
    if (worker.status === 'done') summary.done += 1
  }
  return summary
}

function fallbackWorkerSummary(workerCount: number): WorkerSummary {
  return {
    total: workerCount,
    running: 0,
    down: 0,
    starting: workerCount,
    done: 0,
  }
}

function isWorkerOrchestrationComplete(summary: WorkerSummary | null): boolean {
  if (!summary) return false
  return (
    summary.total > 0
    && summary.done === summary.total
    && summary.running === 0
    && summary.starting === 0
    && summary.down === 0
  )
}

function workerStatusSymbol(status: WorkerStatus): string {
  if (status === 'running') return '●'
  if (status === 'down') return '⊘'
  if (status === 'done') return '✓'
  return '○'
}

function workerStatusClass(status: WorkerStatus): string {
  if (status === 'running') return 'text-emerald-500'
  if (status === 'down') return 'text-accent-vermillion'
  if (status === 'done') return 'text-sumi-diluted'
  return 'text-sumi-mist'
}

function isGitHubIssueUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/issues\/\d+/i.test(value.trim())
}

function shouldAttemptDebriefOnKill(agentType?: AgentType | null): boolean {
  return agentType !== 'openclaw'
}

function getKillConfirmationMessage(sessionName: string, agentType?: AgentType | null): string {
  if (!shouldAttemptDebriefOnKill(agentType)) {
    return `Kill session "${sessionName}"?`
  }
  return `Kill session "${sessionName}"?\n\nIf available, a debrief will be attempted before termination.`
}

function isNotFoundRequestFailure(caughtError: unknown): boolean {
  return caughtError instanceof Error && caughtError.message.includes('Request failed (404):')
}

function SessionCard({
  session,
  machine,
  selected,
  onSelect,
  onKill,
  onResume,
  onNavigateToSession,
}: {
  session: AgentSessionWithWorkers
  machine?: Machine
  selected: boolean
  onSelect: () => void
  onKill: () => Promise<void> | void
  onResume: () => Promise<void> | void
  onNavigateToSession?: (sessionName: string) => void
}) {
  const isFactory = session.name.startsWith('factory-')
  const isCommander = session.name.startsWith('commander-')
  const Icon = isFactory ? Warehouse : Monitor
  const isRemote = Boolean(session.host)
  const isStream = session.sessionType === 'stream'
  const rawAgentType = typeof session.agentType === 'string' ? session.agentType : null
  const agentBadge = rawAgentType && rawAgentType !== 'claude'
    ? (rawAgentType === 'openclaw' ? 'OC' : rawAgentType)
    : null
  const isOpenclaw = rawAgentType === 'openclaw'
  const workerSummary = isStream
    ? (session.workerSummary ?? fallbackWorkerSummary(session.spawnedWorkers?.length ?? 0))
    : null
  const shouldShowWorkerSummary = Boolean(
    isStream &&
    workerSummary &&
    (workerSummary.total > 0 || (session.spawnedWorkers?.length ?? 0) > 0),
  )
  const processAlive = rawAgentType === 'openclaw' ? true : session.processAlive !== false
  const workerOrchestrationComplete = isWorkerOrchestrationComplete(workerSummary)
  const canResume = isStream && session.resumeAvailable === true

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        onSelect()
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'w-full text-left p-5 card-sumi transition-all duration-300 ease-gentle',
        'cursor-pointer',
        isFactory && 'border-l-2 border-l-accent-indigo',
        session.sessionType === 'pty' && 'border-2 border-sumi-black',
        workerOrchestrationComplete && !isCommander && 'opacity-75',
        selected && 'ring-1 ring-sumi-black/10 shadow-ink-md',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0 flex-wrap">
          <Icon size={18} className={cn('shrink-0', isFactory ? 'text-accent-indigo' : 'text-sumi-diluted')} />
          <span className="font-mono text-sm text-sumi-black truncate">{session.label ?? session.name}</span>
          {isFactory && (
            <span className="badge-sumi bg-accent-indigo/10 text-accent-indigo">factory</span>
          )}
          {session.sessionType === 'pty' && (
            <span className="badge-sumi bg-ink-wash text-sumi-gray text-[10px]">pty</span>
          )}
          {agentBadge && (
            <span className={cn('badge-sumi text-[10px]', isOpenclaw ? 'bg-emerald-500/10 text-emerald-700' : 'bg-accent-indigo/10 text-accent-indigo')}>{agentBadge}</span>
          )}
          {isRemote && (
            <span className="badge-sumi bg-ink-wash text-sumi-gray text-[10px]">
              {machine ? `${machine.label} · ${machine.host}` : session.host}
            </span>
          )}
          {workerOrchestrationComplete && !isCommander && (
            <span className="badge-sumi bg-ink-wash text-sumi-diluted text-[10px]">completed</span>
          )}
          {session.status === 'stale' && (
            <span className="badge-sumi bg-amber-500/10 text-amber-700 text-[10px]">stale</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {canResume && processAlive && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                void Promise.resolve(onResume()).catch(() => {
                  // error handled by page-level state
                })
              }}
              className="badge-sumi px-2 py-1 text-[10px] text-accent-indigo hover:bg-accent-indigo/10 transition-colors"
            >
              Resume
            </button>
          )}
          {processAlive ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                const confirmed = window.confirm(getKillConfirmationMessage(session.name, rawAgentType))
                if (!confirmed) {
                  return
                }
                void Promise.resolve(onKill()).catch(() => {
                  // error handled by page-level session action state
                })
              }}
              className="badge-sumi px-2 py-1 text-[10px] text-accent-vermillion hover:bg-accent-vermillion/10 transition-colors"
            >
              Kill
            </button>
          ) : (
            <>
              {canResume && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    void Promise.resolve(onResume()).catch(() => {
                      // error handled by page-level state
                    })
                  }}
                  className="badge-sumi px-2 py-1 text-[10px] text-accent-indigo hover:bg-accent-indigo/10 transition-colors"
                >
                  Resume
                </button>
              )}
              <span className="badge-sumi px-2 py-1 text-[10px] bg-ink-wash text-sumi-diluted">
                {session.hadResult ? 'completed' : 'exited'}
              </span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  void Promise.resolve(onKill()).catch(() => {})
                }}
                className="badge-sumi px-2 py-1 text-[10px] text-sumi-diluted hover:text-accent-vermillion hover:bg-accent-vermillion/10 transition-colors"
              >
                Dismiss
              </button>
            </>
          )}
          <ChevronRight
            size={16}
            className={cn(
              'text-sumi-mist transition-transform duration-300',
              selected && 'rotate-90 text-sumi-gray',
            )}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-4 text-whisper text-sumi-diluted">
        <span className="flex items-center gap-1.5">
          <Cpu size={12} />
          PID {session.pid}
        </span>
        <span>{timeAgo(session.created)}</span>
      </div>

      {shouldShowWorkerSummary && workerSummary && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-whisper font-mono">
          {workerSummary.running > 0 && (
            <span className="text-emerald-600">● {workerSummary.running} running</span>
          )}
          {workerSummary.starting > 0 && (
            <span className="text-sumi-mist">○ {workerSummary.starting} starting</span>
          )}
          {workerSummary.down > 0 && (
            <span className="text-accent-vermillion">⊘ {workerSummary.down} down</span>
          )}
          {workerSummary.done > 0 &&
            workerSummary.running === 0 &&
            workerSummary.down === 0 &&
            workerSummary.starting === 0 && (
            <span className="text-sumi-diluted">✓ {workerSummary.done} done</span>
          )}
        </div>
      )}

      {isStream && session.parentSession && (
        <div className="mt-2 text-whisper text-sumi-diluted">
          ↖ spawned by: <span className="font-mono">{session.parentSession}</span>
        </div>
      )}

      {isStream && session.resumedFrom && (
        <div className="mt-2 text-whisper text-sumi-diluted">
          ↺ resumed from:{' '}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              if (session.resumedFrom) {
                onNavigateToSession?.(session.resumedFrom)
              }
            }}
            className="font-mono underline decoration-sumi-mist/80 underline-offset-2 hover:text-sumi-gray"
          >
            {session.resumedFrom}
          </button>
        </div>
      )}
    </div>
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
  sessionLabel,
  agentType,
  onClose,
  onKill,
  isMobileOverlay,
}: {
  sessionName: string
  sessionLabel?: string
  agentType?: AgentType
  onClose: () => void
  onKill: (sessionName: string, agentType?: AgentType) => Promise<void>
  isMobileOverlay?: boolean
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

    const confirmed = window.confirm(getKillConfirmationMessage(sessionName, agentType))
    if (!confirmed) {
      return
    }

    setIsKilling(true)
    try {
      await onKill(sessionName, agentType)
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
          <span className="font-mono text-sm text-sumi-black">{sessionLabel ?? sessionName}</span>
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

// ── Stream-JSON Message UI ───────────────────────────────────────

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

// ── MobileSessionView ───────────────────────────────────────────

function MobileSessionView({
  sessionName,
  sessionLabel,
  agentType,
  sessionCwd,
  initialSpawnedWorkers,
  onClose,
  onKill,
  onNavigateToSession,
  onRefreshSessions,
}: {
  sessionName: string
  sessionLabel?: string
  agentType?: AgentType
  sessionCwd?: string
  initialSpawnedWorkers?: string[]
  onClose: () => void
  onKill: (sessionName: string, agentType?: AgentType) => Promise<void>
  onNavigateToSession?: (sessionName: string) => void
  onRefreshSessions?: () => Promise<void>
}) {
  const isMobile = useIsMobile()
  const {
    messages,
    setMessages,
    processEvent,
    resetMessages,
    isStreaming,
    markAskAnswered,
  } = useStreamEventProcessor({})
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [isKilling, setIsKilling] = useState(false)
  const [inputText, setInputText] = useState('')
  const [showSkills, setShowSkills] = useState(false)
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0, costUsd: 0 })
  const [startedAt] = useState(() => Date.now())
  const [elapsedSec, setElapsedSec] = useState(0)
  const [workers, setWorkers] = useState<WorkerInfo[]>([])
  const [knownWorkerNames, setKnownWorkerNames] = useState<string[]>(initialSpawnedWorkers ?? [])
  const [workersOpen, setWorkersOpen] = useState(false)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [dispatchValue, setDispatchValue] = useState('')
  const [dispatchPrefab, setDispatchPrefab] = useState<'none' | 'legion-implement'>('none')
  const [dispatchTask, setDispatchTask] = useState('')
  const [dispatchError, setDispatchError] = useState<string | null>(null)
  const [isDispatching, setIsDispatching] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [pendingImages, setPendingImages] = useState<{ mediaType: string; data: string }[]>([])
  const [dismissedWorkers, setDismissedWorkers] = useState<Set<string>>(new Set())
  const [fileChips, setFileChips] = useState<string[]>([])
  const [showWorkspaceOverlay, setShowWorkspaceOverlay] = useState(false)
  const [showOverflowMenu, setShowOverflowMenu] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesAreaRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const autoScrollRef = useRef(true)
  const workersMenuRef = useRef<HTMLDivElement>(null)
  const initialWorkersRef = useRef<string[]>(initialSpawnedWorkers ?? [])
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

  // Update elapsed time every second so the header stays current
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  useEffect(() => {
    function handleCmdK(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        setShowWorkspaceOverlay((prev) => !prev)
      }
    }

    window.addEventListener('keydown', handleCmdK)
    return () => window.removeEventListener('keydown', handleCmdK)
  }, [])

  // Reset dismissed workers when switching sessions
  useEffect(() => {
    setDismissedWorkers(new Set())
  }, [sessionName])

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

  useEffect(() => {
    initialWorkersRef.current = initialSpawnedWorkers ?? []
  }, [initialSpawnedWorkers])

  useEffect(() => {
    setWorkers([])
    setKnownWorkerNames(initialWorkersRef.current)
    setWorkersOpen(false)
    setDispatchOpen(false)
    setDispatchError(null)
    setDispatchValue('')
    setIsResetting(false)
    setResetError(null)
  }, [sessionName])

  const isCommanderSession = sessionName.startsWith('commander-')
  const commanderIdForUi = useMemo(() => {
    if (!sessionName.startsWith('commander-')) {
      return null
    }
    const id = sessionName.slice('commander-'.length)
    return id.length > 0 ? id : null
  }, [sessionName])

  const { data: commanderUiPayload } = useQuery({
    queryKey: ['commanders', 'detail-ui', commanderIdForUi],
    queryFn: () =>
      fetchJson<{
        avatarUrl?: string | null
        ui?: { accentColor?: string; borderColor?: string; speakingTone?: string } | null
      }>(`/api/commanders/${encodeURIComponent(commanderIdForUi!)}`),
    enabled: Boolean(commanderIdForUi),
    staleTime: 60_000,
  })

  useEffect(() => {
    if (!initialSpawnedWorkers || initialSpawnedWorkers.length === 0) {
      return
    }
    setKnownWorkerNames((prev) => {
      const merged = new Set([...prev, ...initialSpawnedWorkers])
      if (merged.size === prev.length) {
        return prev
      }
      return [...merged]
    })
  }, [initialSpawnedWorkers])

  const refreshWorkers = useCallback(async () => {
    const nextWorkers = await fetchJson<WorkerInfo[]>(
      `/api/agents/sessions/${encodeURIComponent(sessionName)}/workers`,
    )
    setWorkers(nextWorkers)
    setKnownWorkerNames((prev) => {
      const merged = new Set(prev)
      for (const worker of nextWorkers) {
        merged.add(worker.name)
      }
      if (merged.size === prev.length) {
        return prev
      }
      return [...merged]
    })
    return nextWorkers
  }, [sessionName])

  useEffect(() => {
    if (knownWorkerNames.length === 0) {
      return
    }

    let cancelled = false
    const fetchAndStore = async () => {
      try {
        if (cancelled) return
        await refreshWorkers()
      } catch {
        // Keep stale worker state until next poll succeeds.
      }
    }

    void fetchAndStore()
    const interval = window.setInterval(() => {
      void fetchAndStore()
    }, 3000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [knownWorkerNames.length, refreshWorkers])

  useEffect(() => {
    if (isMobile || !workersOpen) {
      return
    }

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (!workersMenuRef.current?.contains(target)) {
        setWorkersOpen(false)
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
    }
  }, [isMobile, workersOpen])

  // WebSocket connection
  useEffect(() => {
    resetMessages()
    setMessages([{ id: `system-${Date.now()}`, kind: 'system', text: 'Session started' }])
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
            resetMessages()
            if (raw.events.length === 0) {
              setMessages([{ id: `system-${Date.now()}`, kind: 'system', text: 'Session started' }])
            }

            // Replay buffered events — pass isReplay=true so individual
            // message_delta/result events skip additive usage accumulation.
            for (const event of raw.events) {
              processEvent(event, true)
            }
            // Set usage from the server's pre-accumulated totals to
            // avoid double-counting on reconnect.
            setUsage(raw.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 })
          } else if (raw.type === 'tool_answer_ack' && raw.toolId) {
            markAskAnswered(raw.toolId)
            setMessages((prev) =>
              prev.map((m) =>
                m.toolId === raw.toolId ? { ...m, askSubmitting: false } : m,
              ),
            )
          } else if (raw.type === 'tool_answer_error' && raw.toolId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.toolId === raw.toolId ? { ...m, askSubmitting: false } : m,
              ),
            )
          } else {
            const streamEvent = raw as StreamEvent
            if (streamEvent.type === 'assistant' && streamEvent.message.usage) {
              setUsage((prev) => ({
                inputTokens: prev.inputTokens + (streamEvent.message.usage?.input_tokens ?? 0),
                outputTokens: prev.outputTokens + (streamEvent.message.usage?.output_tokens ?? 0),
                costUsd: prev.costUsd,
              }))
            }
            if (streamEvent.type === 'message_delta' && streamEvent.usage) {
              const usageIsTotal = (streamEvent as StreamEvent & { usage_is_total?: boolean }).usage_is_total === true
              setUsage((prev) => ({
                inputTokens: usageIsTotal
                  ? (streamEvent.usage?.input_tokens ?? prev.inputTokens)
                  : prev.inputTokens + (streamEvent.usage?.input_tokens ?? 0),
                outputTokens: usageIsTotal
                  ? (streamEvent.usage?.output_tokens ?? prev.outputTokens)
                  : prev.outputTokens + (streamEvent.usage?.output_tokens ?? 0),
                costUsd: prev.costUsd,
              }))
            }
            if (
              streamEvent.type === 'result' &&
              (streamEvent.cost_usd !== undefined ||
                streamEvent.total_cost_usd !== undefined ||
                streamEvent.usage)
            ) {
              setUsage((prev) => ({
                inputTokens: streamEvent.usage?.input_tokens ?? prev.inputTokens,
                outputTokens: streamEvent.usage?.output_tokens ?? prev.outputTokens,
                costUsd: streamEvent.total_cost_usd ?? streamEvent.cost_usd ?? prev.costUsd,
              }))
            }
            processEvent(streamEvent)
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
  }, [markAskAnswered, processEvent, resetMessages, sessionName, setMessages])

  function handleSend() {
    const text = inputText.trim()
    if ((!text && pendingImages.length === 0) || wsRef.current?.readyState !== WebSocket.OPEN) return

    const fileContext = fileChips.map((filePath) => `@${filePath}`).join(' ')
    const fullText = fileContext ? `${fileContext}\n${text}` : text
    const images = pendingImages.slice()
    setMessages((prev) =>
      capMessages([
        ...prev,
        {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'user',
          text: fullText || '[image]',
          images: images.length > 0 ? images : undefined,
        },
      ]),
    )
    wsRef.current.send(JSON.stringify({
      type: 'input',
      text: fullText,
      images: images.length > 0 ? images : undefined,
    }))
    setInputText('')
    setPendingImages([])
    setFileChips([])
    autoScrollRef.current = true
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  function handleImageFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (arr.length === 0) return
    arr.forEach((file) => {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const result = ev.target?.result as string | undefined
        if (!result) return
        const data = result.split(',')[1]
        if (!data) return
        setPendingImages((prev) => {
          if (prev.length >= 5) return prev
          return [...prev, { mediaType: file.type, data }]
        })
      }
      reader.readAsDataURL(file)
    })
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

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData.items
    const imageFiles: File[] = []
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      handleImageFiles(imageFiles)
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
    const confirmed = window.confirm(getKillConfirmationMessage(sessionName, agentType))
    if (!confirmed) return
    setIsKilling(true)
    try {
      await onKill(sessionName, agentType)
    } catch {
      // Error surfaced through parent
    } finally {
      setIsKilling(false)
    }
  }

  async function handleResetSession() {
    if (isResetting) return
    const confirmed = window.confirm(
      "Are you sure? This will clear Claude's current context. Memory, journal, and quests are preserved.",
    )
    if (!confirmed) return

    setIsResetting(true)
    setResetError(null)

    try {
      await resetSession(sessionName)
      setMessages((prev) => capMessages([
        ...prev,
        {
          id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'system',
          text: 'Session rotated — Claude context cleared, memory preserved.',
        },
      ]))
      autoScrollRef.current = true
    } catch (caughtError) {
      setResetError(formatError(caughtError, 'Failed to reset session'))
    } finally {
      setIsResetting(false)
    }
  }

  async function handleDispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isDispatching) return

    const value = dispatchValue.trim()
    if (!value) {
      setDispatchError('Issue URL or branch is required')
      return
    }

    setIsDispatching(true)
    setDispatchError(null)

    try {
      const created = await fetchJson<{ name: string; worktree: string }>(
        '/api/agents/sessions/dispatch-worker',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            parentSession: sessionName,
            issueUrl: isGitHubIssueUrl(value) ? value : undefined,
            branch: isGitHubIssueUrl(value) ? undefined : value,
            cwd: sessionCwd,
            prefab: dispatchPrefab !== 'none' ? dispatchPrefab : undefined,
            task: dispatchTask || undefined,
          }),
        },
      )

      setKnownWorkerNames((prev) => (prev.includes(created.name) ? prev : [...prev, created.name]))
      setWorkers((prev) => (
        prev.some((worker) => worker.name === created.name)
          ? prev
          : [{ name: created.name, status: 'starting', phase: 'starting' }, ...prev]
      ))
      setDispatchValue('')
      setDispatchPrefab('none')
      setDispatchTask('')
      setDispatchOpen(false)
      setWorkersOpen(true)

      if (onRefreshSessions) {
        await onRefreshSessions()
      }
      void refreshWorkers()
    } catch (caughtError) {
      setDispatchError(formatError(caughtError, 'Failed to dispatch worker'))
    } finally {
      setIsDispatching(false)
    }
  }

  function handleOpenWorker(workerSessionName: string) {
    setWorkersOpen(false)
    setDispatchOpen(false)
    onNavigateToSession?.(workerSessionName)
  }

  const allWorkerRows = workers.length > 0
    ? workers
    : knownWorkerNames.map((name) => ({
      name,
      status: 'starting' as const,
      phase: 'starting' as const,
    }))
  const workerRows = allWorkerRows.filter((w) => !dismissedWorkers.has(w.name))
  function handleClearDone() {
    const doneNames = allWorkerRows.filter((w) => w.status === 'done').map((w) => w.name)
    setDismissedWorkers((prev) => {
      const next = new Set(prev)
      for (const n of doneNames) next.add(n)
      return next
    })
  }
  const workerSummary = workerRows.length > 0
    ? summarizeWorkers(workerRows)
    : workers.length > 0
      ? { total: 0, running: 0, starting: 0, done: 0, down: 0 }
      : fallbackWorkerSummary(knownWorkerNames.length)
  const showWorkersPill = true
  const hasDoneWorkers = workerSummary.done > 0
  const workerPillText = (() => {
    if (workerSummary.total === 0) return '+'
    const parts: string[] = []
    if (workerSummary.running > 0) parts.push(`●${workerSummary.running}`)
    if (workerSummary.starting > 0) parts.push(`○${workerSummary.starting}`)
    if (workerSummary.down > 0) parts.push(`⊘${workerSummary.down}`)
    // Show done count only when no active workers exist
    if (parts.length === 0 && workerSummary.done > 0) parts.push(`✓${workerSummary.done}`)
    return parts.join(' ') || '+'
  })()

  const workspaceSource: import('../../workspace/use-workspace').WorkspaceSource | null =
    sessionCwd ? { kind: 'agent-session', sessionName } : null

  function handleAddFileChip(filePath: string) {
    setFileChips((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]))
  }

  function removeFileChip(filePath: string) {
    setFileChips((prev) => prev.filter((entry) => entry !== filePath))
  }

  function basename(filePath: string): string {
    const cleanPath = filePath.endsWith('/') ? filePath.slice(0, -1) : filePath
    const parts = cleanPath.split('/')
    const name = parts[parts.length - 1] || cleanPath
    return filePath.endsWith('/') ? `${name}/` : name
  }

  return (
    <div className="session-view-overlay">
      {/* Thin header — back + centered meta + overflow actions */}
      <div className="session-header">
        <button
          className="session-back"
          onClick={onClose}
          aria-label="Back to sessions"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="session-header-center">
          <p className="session-header-name">{sessionLabel ?? sessionName}</p>
          <p className="session-header-meta">
            <span
              className={cn(
                'inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle',
                wsStatus === 'connected'
                  ? 'bg-emerald-500'
                  : wsStatus === 'connecting'
                    ? 'bg-amber-400'
                    : 'bg-sumi-mist',
              )}
            />
            {wsStatus} &middot; {formatCost(usage.costUsd)} &middot; {getDuration()}
          </p>
        </div>
        <div className="relative shrink-0">
          <button
            className="p-1.5 rounded-lg hover:bg-ink-wash transition-colors"
            onClick={() => setShowOverflowMenu((prev) => !prev)}
            aria-label="Session actions"
          >
            <MoreVertical size={16} className="text-sumi-diluted" />
          </button>
          {showOverflowMenu && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowOverflowMenu(false)}
              />
              <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-xl border border-ink-border bg-washi-white shadow-ink-md">
                {isCommanderSession && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-sumi-black transition-colors hover:bg-ink-wash"
                    onClick={() => {
                      setShowOverflowMenu(false)
                      setInputText('Create a new quest on your quest board: ')
                      textareaRef.current?.focus()
                    }}
                  >
                    <Plus size={13} className="shrink-0 text-sumi-diluted" />
                    New Quest
                  </button>
                )}
                {showWorkersPill && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-sumi-black transition-colors hover:bg-ink-wash"
                    onClick={() => {
                      setShowOverflowMenu(false)
                      setDispatchError(null)
                      if (isMobile) {
                        setWorkersOpen(true)
                        return
                      }
                      setWorkersOpen((prev) => !prev)
                    }}
                  >
                    <Cpu size={13} className="shrink-0 text-sumi-diluted" />
                    Workers {workerPillText !== '+' ? `(${workerPillText})` : ''}
                  </button>
                )}
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-sumi-black transition-colors hover:bg-ink-wash"
                  onClick={() => {
                    setShowOverflowMenu(false)
                    setShowWorkspaceOverlay(true)
                  }}
                >
                  <Warehouse size={13} className="shrink-0 text-sumi-diluted" />
                  <span className="flex-1">Workspace</span>
                  <span className="font-mono text-[10px] text-sumi-mist">
                    {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl+'}K
                  </span>
                </button>
                <div className="border-t border-ink-border" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-accent-vermillion transition-colors hover:bg-accent-vermillion/5"
                  onClick={() => {
                    setShowOverflowMenu(false)
                    void handleKill()
                  }}
                  disabled={isKilling}
                >
                  <Power size={13} className="shrink-0" />
                  {isKilling ? 'Killing...' : 'Kill Session'}
                </button>
                {isCommanderSession && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-amber-600 transition-colors hover:bg-amber-500/5"
                    onClick={() => {
                      setShowOverflowMenu(false)
                      void handleResetSession()
                    }}
                    disabled={isResetting}
                  >
                    <RotateCcw size={13} className="shrink-0" />
                    {isResetting ? 'Resetting...' : 'Reset Session'}
                  </button>
                )}
                <div className="border-t border-ink-border" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-sumi-diluted transition-colors hover:bg-ink-wash"
                  onClick={() => {
                    setShowOverflowMenu(false)
                    onClose()
                  }}
                >
                  <ChevronLeft size={13} className="shrink-0" />
                  Back to Sessions
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {resetError && (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded border border-accent-vermillion/40 bg-accent-vermillion/10 px-3 py-2 text-whisper text-accent-vermillion">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{resetError}</span>
        </div>
      )}

      {/* Messages area — fills remaining height */}
      <div
        className="messages-area"
        ref={messagesAreaRef}
        onScroll={handleScroll}
      >
        <SessionMessageList
          messages={messages}
          onAnswer={handleAnswer}
          emptyLabel="Session started"
          agentAvatarUrl={isCommanderSession ? commanderUiPayload?.avatarUrl : undefined}
          agentAccentColor={isCommanderSession ? commanderUiPayload?.ui?.accentColor : undefined}
        />
        {isStreaming && <StreamingDots />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar — pinned to bottom */}
      <div className="input-bar">
        {fileChips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-1">
            {fileChips.map((filePath) => (
              <span
                key={filePath}
                className="file-chip"
                title={filePath}
              >
                {basename(filePath)}
                <button
                  type="button"
                  onClick={() => removeFileChip(filePath)}
                  className="file-chip-remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2 pb-2">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative inline-block">
                <img
                  src={`data:${img.mediaType};base64,${img.data}`}
                  className="h-16 w-16 rounded border object-cover"
                  alt="attachment"
                />
                <button
                  type="button"
                  className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-sumi-black text-washi-white text-xs leading-none"
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                handleImageFiles(e.target.files)
              }
              e.target.value = ''
            }}
          />
          <textarea
            ref={textareaRef}
            className="input-field"
            rows={1}
            placeholder="Send a message..."
            value={inputText}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
          <button
            type="button"
            className="p-2 text-sumi-diluted hover:text-sumi-black transition-colors"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach image"
            title="Attach image"
            disabled={pendingImages.length >= 5}
          >
            <Paperclip size={18} />
          </button>
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
            disabled={(!inputText.trim() && pendingImages.length === 0) || wsStatus !== 'connected'}
            aria-label="Send"
          >
            <ArrowUp size={18} />
          </button>
        </div>
        <div className="flex justify-end px-3 pb-1 pt-0.5">
          <button
            type="button"
            className="font-mono text-[10px] text-sumi-mist transition-colors hover:text-sumi-diluted"
            onClick={() => setShowWorkspaceOverlay(true)}
          >
            {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl+'}K workspace
          </button>
        </div>
      </div>

      {/* Dispatch worker modal (desktop) */}
      {!isMobile && dispatchOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-sumi-black/50 px-4">
          <div className="w-full max-w-md rounded-xl border border-ink-border bg-washi-white p-4 shadow-ink-md">
            <div className="text-sm font-mono text-sumi-black mb-3">Dispatch Worker</div>
            <form onSubmit={handleDispatch} className="space-y-3">
              <div>
                <label className="block text-whisper text-sumi-diluted mb-1">Prefab</label>
                <select
                  value={dispatchPrefab}
                  onChange={(e) => setDispatchPrefab(e.target.value as 'none' | 'legion-implement')}
                  className="w-full rounded-lg border border-ink-border px-3 py-2 text-sm text-sumi-black"
                >
                  <option value="none">None</option>
                  <option value="legion-implement">legion-implement</option>
                </select>
              </div>
              <div>
                <label className="block text-whisper text-sumi-diluted mb-1">Issue URL or Branch</label>
                <input
                  value={dispatchValue}
                  onChange={(e) => setDispatchValue(e.target.value)}
                  className="w-full rounded-lg border border-ink-border px-3 py-2 text-sm text-sumi-black"
                  placeholder="e.g. .../issues/311 or feat-auth"
                />
              </div>
              {dispatchPrefab !== 'none' && (
                <div>
                  <label className="block text-whisper text-sumi-diluted mb-1">Additional instructions (optional)</label>
                  <textarea
                    value={dispatchTask}
                    onChange={(e) => setDispatchTask(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-ink-border px-3 py-2 text-sm text-sumi-black resize-none"
                    placeholder="Extra instructions appended after the prefab task..."
                  />
                </div>
              )}
              {dispatchError && (
                <div className="text-whisper text-accent-vermillion">{dispatchError}</div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-ink-border px-3 py-1.5 text-sm text-sumi-diluted"
                  onClick={() => setDispatchOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-sumi-black px-3 py-1.5 text-sm text-white disabled:opacity-60"
                  disabled={isDispatching}
                >
                  {isDispatching ? 'Dispatching...' : 'Dispatch'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Workers / Dispatch bottom sheets (mobile) */}
      {isMobile && (
        <>
          <div
            className={cn('sheet-backdrop', (workersOpen || dispatchOpen) && 'visible')}
            onClick={() => {
              setWorkersOpen(false)
              setDispatchOpen(false)
            }}
          />

          <div
            className={cn('sheet', workersOpen && 'visible')}
            style={{ maxHeight: '50vh', height: '50vh' }}
          >
            <div className="sheet-handle">
              <div className="sheet-handle-bar" />
            </div>
            <div className="px-4 pb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-mono text-sumi-black">Workers</div>
                <button
                  type="button"
                  className="p-1 rounded-md hover:bg-ink-wash"
                  onClick={() => setWorkersOpen(false)}
                >
                  <X size={16} className="text-sumi-diluted" />
                </button>
              </div>
              <div className="space-y-2 max-h-[30vh] overflow-y-auto">
                {workerRows.length === 0 ? (
                  <div className="text-sm text-sumi-diluted py-3">No workers yet</div>
                ) : (
                  workerRows.map((worker) => (
                    <button
                      key={worker.name}
                      type="button"
                      className="w-full rounded-lg border border-ink-border px-3 py-2 text-left flex items-center justify-between"
                      onClick={() => handleOpenWorker(worker.name)}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-mono text-sumi-black">
                          <span className={cn('mr-1', workerStatusClass(worker.status))}>
                            {workerStatusSymbol(worker.status)}
                          </span>
                          {worker.name}
                        </div>
                        <div className="text-whisper text-sumi-diluted">{worker.status}</div>
                      </div>
                      <ChevronRight size={16} className="text-sumi-mist" />
                    </button>
                  ))
                )}
              </div>
              {hasDoneWorkers && (
                <button
                  type="button"
                  className="mt-3 w-full rounded-lg border border-ink-border px-3 py-2 text-sm text-sumi-diluted"
                  onClick={handleClearDone}
                >
                  Clear done
                </button>
              )}
              <button
                type="button"
                className={cn('w-full rounded-lg border border-ink-border px-3 py-2 text-sm text-sumi-black', hasDoneWorkers ? 'mt-1.5' : 'mt-3')}
                onClick={() => {
                  setDispatchError(null)
                  setDispatchOpen(true)
                }}
              >
                + Dispatch New
              </button>
            </div>
          </div>

          <div
            className={cn('sheet', dispatchOpen && 'visible')}
            style={{ maxHeight: '42vh', height: '42vh' }}
          >
            <div className="sheet-handle">
              <div className="sheet-handle-bar" />
            </div>
            <div className="px-4 pb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-mono text-sumi-black">Dispatch Worker</div>
                <button
                  type="button"
                  className="p-1 rounded-md hover:bg-ink-wash"
                  onClick={() => setDispatchOpen(false)}
                >
                  <X size={16} className="text-sumi-diluted" />
                </button>
              </div>
              <form onSubmit={handleDispatch} className="space-y-3">
                <div>
                  <label className="block text-whisper text-sumi-diluted mb-1">Prefab</label>
                  <select
                    value={dispatchPrefab}
                    onChange={(e) => setDispatchPrefab(e.target.value as 'none' | 'legion-implement')}
                    className="w-full rounded-lg border border-ink-border px-3 py-2 text-sm text-sumi-black"
                  >
                    <option value="none">None</option>
                    <option value="legion-implement">legion-implement</option>
                  </select>
                </div>
                <div>
                  <label className="block text-whisper text-sumi-diluted mb-1">Issue URL or Branch</label>
                  <input
                    value={dispatchValue}
                    onChange={(e) => setDispatchValue(e.target.value)}
                    className="w-full rounded-lg border border-ink-border px-3 py-2 text-sm text-sumi-black"
                    placeholder=".../issues/311 or feat-auth"
                  />
                </div>
                {dispatchPrefab !== 'none' && (
                  <div>
                    <label className="block text-whisper text-sumi-diluted mb-1">Additional instructions (optional)</label>
                    <textarea
                      value={dispatchTask}
                      onChange={(e) => setDispatchTask(e.target.value)}
                      rows={2}
                      className="w-full rounded-lg border border-ink-border px-3 py-2 text-sm text-sumi-black resize-none"
                      placeholder="Extra instructions..."
                    />
                  </div>
                )}
                <div className="text-whisper text-sumi-diluted">Parent: {sessionName}</div>
                {dispatchError && (
                  <div className="text-whisper text-accent-vermillion">{dispatchError}</div>
                )}
                <button
                  type="submit"
                  className="w-full rounded-lg bg-sumi-black px-3 py-2 text-sm text-white disabled:opacity-60"
                  disabled={isDispatching}
                >
                  {isDispatching ? 'Dispatching...' : 'Dispatch'}
                </button>
              </form>
            </div>
          </div>
        </>
      )}

      {!isMobile && workersOpen && (
        <div ref={workersMenuRef}>
          <div className="fixed inset-0 z-40" onClick={() => setWorkersOpen(false)} />
          <div className="fixed right-4 top-16 z-50 w-72 rounded-xl border border-ink-border bg-washi-white shadow-ink-md">
            <div className="border-b border-ink-border px-3 py-2 text-xs font-mono text-sumi-diluted">Workers</div>
            <div className="max-h-64 overflow-y-auto">
              {workerRows.map((worker) => (
                <button
                  key={worker.name}
                  type="button"
                  className="flex w-full items-center justify-between border-b border-ink-border px-3 py-2 text-left last:border-b-0 hover:bg-washi-shadow/60"
                  onClick={() => handleOpenWorker(worker.name)}
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-mono text-sumi-black">
                      <span className={cn('mr-1', workerStatusClass(worker.status))}>
                        {workerStatusSymbol(worker.status)}
                      </span>
                      {worker.name}
                    </div>
                    <div className="text-[10px] text-sumi-diluted">{worker.status}</div>
                  </div>
                  <ChevronRight size={14} className="text-sumi-mist" />
                </button>
              ))}
            </div>
            <div className="flex gap-2 border-t border-ink-border p-2">
              {hasDoneWorkers && (
                <button
                  type="button"
                  className="flex-1 rounded-lg border border-ink-border px-2 py-1.5 text-xs text-sumi-diluted hover:bg-washi-shadow/60"
                  onClick={handleClearDone}
                >
                  Clear done
                </button>
              )}
              <button
                type="button"
                className="flex-1 rounded-lg border border-ink-border px-2 py-1.5 text-xs text-sumi-black hover:bg-washi-shadow/60"
                onClick={() => {
                  setDispatchError(null)
                  setDispatchOpen(true)
                }}
              >
                + Dispatch
              </button>
            </div>
          </div>
        </div>
      )}

      {workspaceSource && (
        <WorkspaceOverlay
          open={showWorkspaceOverlay}
          onClose={() => setShowWorkspaceOverlay(false)}
          onSelectFile={handleAddFileChip}
          source={workspaceSource}
        />
      )}

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
  const { data: sessions, isLoading, isFetching } = useAgentSessions()
  const { data: machines } = useMachines()
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [showNewSessionForm, setShowNewSessionForm] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<ClaudePermissionMode>('default')
  const [task, setTask] = useState('')
  const [cwd, setCwd] = useState('')
  const [resumeFromSession, setResumeFromSession] = useState('')
  const [agentType, setAgentType] = useState<AgentType>('claude')
  const [openclawAgentId, setOpenclawAgentId] = useState('')
  const [sessionType, setSessionType] = useState<SessionType>('stream')
  const [selectedHost, setSelectedHost] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [sessionActionError, setSessionActionError] = useState<string | null>(null)
  const [sessionTab, setSessionTab] = useState<SessionTab>(DEFAULT_SESSION_TAB)
  const machineList = machines ?? []
  const sessionList = (sessions ?? []) as AgentSessionWithWorkers[]
  const machineMap = new Map(machineList.map((machine) => [machine.id, machine]))
  const resumableSessions = sessionList
    .filter((session) => session.resumeAvailable)
    .sort((left, right) => Date.parse(right.created) - Date.parse(left.created))
  const resumeSource = resumableSessions.find((session) => session.name === resumeFromSession) ?? null

  useEffect(() => {
    const paramCwd = searchParams.get('cwd')
    const paramName = searchParams.get('name')
    const paramSession = searchParams.get('session')
    const paramAgentType = searchParams.get('agentType')
    if (paramCwd || paramName || paramSession || paramAgentType) {
      if (paramCwd) setCwd(paramCwd)
      if (paramName) setName(paramName)
      if (paramSession) setSelectedSession(paramSession)
      if (paramAgentType === 'codex' || paramAgentType === 'claude') {
        setAgentType(paramAgentType)
      }
      if (paramCwd || paramName) setShowNewSessionForm(true)
      if (paramSession) {
        void queryClient.invalidateQueries({ queryKey: ['agents', 'sessions'] })
      }
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams, queryClient])

  useEffect(() => {
    if (!selectedSession) {
      return
    }
    if (isLoading) {
      return
    }

    const stillExists = sessionList.some((session) => session.name === selectedSession)
    if (stillExists) {
      return
    }
    // Commander-backed streams are registered on start; list can lag one refetch behind navigation.
    if (selectedSession.startsWith('commander-') && isFetching) {
      return
    }
    setSelectedSession(null)
  }, [selectedSession, sessionList, isLoading, isFetching])

  useEffect(() => {
    if (!resumeFromSession) {
      return
    }
    if (resumableSessions.some((session) => session.name === resumeFromSession)) {
      return
    }
    setResumeFromSession('')
  }, [resumeFromSession, resumableSessions])

  useEffect(() => {
    if (!resumeSource) {
      return
    }

    if (resumeSource.agentType && resumeSource.agentType !== agentType) {
      setAgentType(resumeSource.agentType)
    }
    if (sessionType !== 'stream') {
      setSessionType('stream')
    }

    const nextCwd = resumeSource.cwd ?? ''
    if (cwd !== nextCwd) {
      setCwd(nextCwd)
    }

    const nextHost = resumeSource.host ?? ''
    if (selectedHost !== nextHost) {
      setSelectedHost(nextHost)
    }
  }, [resumeSource, agentType, sessionType, cwd, selectedHost])

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
        resumeFromSession: resumeFromSession || undefined,
        sessionType,
        agentType,
        host: selectedHost || undefined,
        agentId: agentType === 'openclaw' ? (openclawAgentId.trim() || 'main') : undefined,
      })

      setName('')
      setTask('')
      setCwd('')
      setResumeFromSession('')
      setMode('default')
      setAgentType('claude')
      setOpenclawAgentId('')
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
  }, [isCreating, name, mode, task, cwd, agentType, openclawAgentId, sessionType, selectedHost, isMobile, queryClient])

  async function handleKillSession(
    sessionName: string,
    agentType?: AgentType,
    sessionType?: SessionType,
  ) {
    setSessionActionError(null)

    try {
      const isStream = sessionType === 'stream'
      const shouldDebrief = isStream && shouldAttemptDebriefOnKill(agentType)

      if (shouldDebrief) {
        try {
          const preResp = await triggerPreKillDebrief(sessionName)
          if (preResp.debriefStarted && preResp.timeoutMs) {
            const deadline = Date.now() + preResp.timeoutMs
            const pollIntervalMs = 2000
            while (Date.now() < deadline) {
              const { status } = await getDebriefStatus(sessionName)
              if (status === 'completed' || status === 'timed-out') break
              await new Promise((r) => setTimeout(r, pollIntervalMs))
            }
          }
        } catch (caughtError) {
          if (!isNotFoundRequestFailure(caughtError)) {
            throw caughtError
          }
        }
      }

      await killSession(sessionName)
      setSelectedSession((current) => (current === sessionName ? null : current))
      await refreshSessions()
    } catch (caughtError) {
      const message = formatError(caughtError, 'Failed to kill session')
      setSessionActionError(message)
      throw caughtError
    }
  }

  async function handleResumeSession(sessionName: string) {
    setSessionActionError(null)

    try {
      const resumed = await resumeAgentSession(sessionName)
      setSelectedSession(resumed.name)
      await refreshSessions()
    } catch (caughtError) {
      const message = formatError(caughtError, 'Failed to resume session')
      setSessionActionError(message)
      throw caughtError
    }
  }

  const selectedSessionData = sessionList.find((s) => s.name === selectedSession)

  const filteredSessions = filterSessionsByTab(sessionList, sessionTab)

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
                    resumeOptions={resumableSessions}
                    resumeSource={resumeSource}
                    resumeSourceName={resumeFromSession}
                    setResumeSourceName={setResumeFromSession}
                    mode={mode}
                    setMode={setMode}
                    task={task}
                    setTask={setTask}
                    agentType={agentType}
                    setAgentType={setAgentType}
                    openclawAgentId={openclawAgentId}
                    setOpenclawAgentId={setOpenclawAgentId}
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
                  resumeOptions={resumableSessions}
                  resumeSource={resumeSource}
                  resumeSourceName={resumeFromSession}
                  setResumeSourceName={setResumeFromSession}
                  mode={mode}
                  setMode={setMode}
                  task={task}
                  setTask={setTask}
                  agentType={agentType}
                  setAgentType={setAgentType}
                  openclawAgentId={openclawAgentId}
                  setOpenclawAgentId={setOpenclawAgentId}
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

          {sessionActionError && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
              <AlertTriangle size={15} className="mt-0.5" />
              <span>{sessionActionError}</span>
            </div>
          )}
        </div>

        {/* Session type tabs */}
        {sessionList.length > 0 && (
          <div className="px-4 pb-3 flex gap-1">
            {SESSION_TABS.map((tab) => (
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
                onSelect={() => {
                  setSelectedSession(
                    selectedSession === session.name ? null : session.name,
                  )
                }}
                onKill={() => handleKillSession(session.name, session.agentType, session.sessionType)}
                onResume={() => handleResumeSession(session.name)}
                onNavigateToSession={(sessionName) => setSelectedSession(sessionName)}
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
          <MobileSessionView
            sessionName={selectedSession}
            sessionLabel={selectedSessionData?.label}
            agentType={selectedSessionData?.agentType}
            sessionCwd={selectedSessionData?.cwd}
            initialSpawnedWorkers={selectedSessionData?.spawnedWorkers}
            onClose={() => setSelectedSession(null)}
            onKill={(name, type) => handleKillSession(name, type, selectedSessionData?.sessionType)}
            onNavigateToSession={(nextSessionName) => setSelectedSession(nextSessionName)}
            onRefreshSessions={refreshSessions}
          />
        ) : (
          <TerminalView
            sessionName={selectedSession}
            sessionLabel={selectedSessionData?.label}
            agentType={selectedSessionData?.agentType}
            onClose={() => setSelectedSession(null)}
            onKill={(name, type) => handleKillSession(name, type, selectedSessionData?.sessionType)}
            isMobileOverlay={isMobile}
          />
        )
      )}
    </div>
  )
}
