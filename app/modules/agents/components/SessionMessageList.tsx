import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Brain,
  Bot,
  FileText,
  Pencil,
  TerminalSquare,
  Search,
  FilePlus,
  Check,
  Loader2,
  AlertTriangle,
  ChevronRight,
  Plug,
  ChevronsUpDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SUBAGENT_WORKING_LABEL, formatToolDisplayName, groupMessages, type MsgItem } from './session-messages'

// ── Tool icon/color map ─────────────────────────────────────────

type ToolColorClass =
  | 'text-sky-400'
  | 'text-violet-400'
  | 'text-amber-400'
  | 'text-emerald-400'
  | 'text-orange-400'
  | 'text-cyan-400'

const TOOL_META: Record<
  string,
  { icon: typeof FileText; colorClass: ToolColorClass }
> = {
  Read: { icon: FileText, colorClass: 'text-sky-400' },
  Glob: { icon: Search, colorClass: 'text-sky-400' },
  Grep: { icon: Search, colorClass: 'text-sky-400' },
  Edit: { icon: Pencil, colorClass: 'text-amber-400' },
  MultiEdit: { icon: Pencil, colorClass: 'text-amber-400' },
  Write: { icon: FilePlus, colorClass: 'text-emerald-400' },
  NotebookEdit: { icon: Pencil, colorClass: 'text-amber-400' },
  Bash: { icon: TerminalSquare, colorClass: 'text-orange-400' },
  WebFetch: { icon: Search, colorClass: 'text-sky-400' },
  WebSearch: { icon: Search, colorClass: 'text-sky-400' },
  LSP: { icon: FileText, colorClass: 'text-sky-400' },
  TodoWrite: { icon: FilePlus, colorClass: 'text-emerald-400' },
  Agent: { icon: Bot, colorClass: 'text-violet-400' },
}

function getToolMeta(name: string) {
  if (TOOL_META[name]) return TOOL_META[name]
  if (name.startsWith('mcp__')) return { icon: Plug, colorClass: 'text-violet-400' as ToolColorClass }
  return { icon: TerminalSquare, colorClass: 'text-orange-400' as ToolColorClass }
}

// ── Sub-components ──────────────────────────────────────────────

function SystemDivider({ text }: { text: string }) {
  if (!text) {
    return null
  }
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <div className="h-px flex-1 bg-white/10" />
      <span className="font-mono text-[10px] uppercase tracking-widest text-white/40">{text}</span>
      <div className="h-px flex-1 bg-white/10" />
    </div>
  )
}

function UserMessage({
  text,
  images,
}: {
  text: string
  images?: { mediaType: string; data: string }[]
}) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg border border-emerald-300/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
        {images && images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img, index) => (
              <img
                key={`${img.mediaType}-${index}`}
                src={`data:${img.mediaType};base64,${img.data}`}
                className="max-h-48 max-w-xs rounded border border-emerald-300/30"
                alt="attachment"
              />
            ))}
          </div>
        )}
        {text && text !== '[image]' ? text : null}
      </div>
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div className="rounded border border-violet-300/20 bg-violet-500/8">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        <Brain size={11} className="shrink-0 text-violet-400" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-violet-300/80">
          Thinking
        </span>
        <ChevronRight
          size={11}
          className={cn(
            'ml-auto shrink-0 text-violet-300/60 transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-violet-300/15 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-violet-200/70 whitespace-pre-wrap break-words">
          {text}
        </div>
      )}
    </div>
  )
}

function isAgentAccentColor(value: string): boolean {
  const t = value.trim()
  if (t.length > 80) {
    return false
  }
  return /^#[0-9a-f]{3,8}$/i.test(t) || /^rgba?\(/i.test(t) || /^[a-z][a-z0-9-]*$/i.test(t)
}

function AgentMessage({
  text,
  avatarUrl,
  accentColor,
}: {
  text: string
  avatarUrl?: string | null
  accentColor?: string | null
}) {
  if (!text.trim()) return null
  const safeAccent = accentColor && isAgentAccentColor(accentColor) ? accentColor.trim() : null
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-sky-500/15 text-sky-400">
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Bot size={13} />
        )}
      </div>
      <div
        className={cn(
          'min-w-0 flex-1 rounded-r-lg rounded-bl-lg border border-white/[0.12] border-l-[3px] bg-[#242424] p-3.5',
          !safeAccent && 'border-l-sky-400/70',
        )}
        style={safeAccent ? { borderLeftColor: safeAccent } : undefined}
      >
        <div className="msg-agent-md prose prose-invert prose-sm max-w-none break-words text-zinc-100">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}

function RunningAgentsPanel({ messages }: { messages: MsgItem[] }) {
  const running = messages.filter(
    (m) => m.kind === 'tool' && m.toolName === 'Agent' && m.toolStatus === 'running',
  )
  if (running.length === 0) return null

  return (
    <div className="rounded border border-violet-300/20 bg-violet-500/8 px-2.5 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-violet-300/80">
        <Bot size={11} />
        Running Sub-agents
      </div>
      {running.map((msg) => (
        <div key={msg.id} className="flex items-center gap-1.5 text-xs text-violet-200/70">
          <Loader2 size={10} className="animate-spin" />
          <span>{msg.subagentDescription ?? SUBAGENT_WORKING_LABEL}</span>
        </div>
      ))}
    </div>
  )
}

function ToolBlock({ msg, nested = false }: { msg: MsgItem; nested?: boolean }) {
  const isAgentTool = msg.toolName === 'Agent'
  const children = msg.children ?? []
  const hasChildren = children.length > 0
  const [expanded, setExpanded] = useState(
    isAgentTool && hasChildren && msg.toolStatus === 'running',
  )
  const meta = getToolMeta(msg.toolName ?? '')
  const ToolIcon = meta.icon
  const formatted = formatToolDisplayName(msg.toolName ?? '')
  const hasEditDiff =
    (msg.toolName === 'Edit' || msg.toolName === 'MultiEdit') &&
    (msg.oldString || msg.newString)

  useEffect(() => {
    if (isAgentTool && hasChildren) {
      setExpanded(msg.toolStatus === 'running')
      return
    }
    if (isAgentTool) setExpanded(false)
  }, [hasChildren, isAgentTool, msg.toolStatus])

  const statusIcon =
    msg.toolStatus === 'running' ? (
      <Loader2 size={11} className="animate-spin text-amber-400/80" />
    ) : msg.toolStatus === 'error' ? (
      <AlertTriangle size={11} className="text-red-400" />
    ) : (
      <Check size={11} className="text-emerald-400" />
    )

  const statusText =
    msg.toolStatus === 'running'
      ? 'running'
      : msg.toolStatus === 'error'
        ? 'error'
        : 'done'

  const statusColor =
    msg.toolStatus === 'running'
      ? 'text-amber-400/80'
      : msg.toolStatus === 'error'
        ? 'text-red-400'
        : 'text-emerald-400'

  const inner = (
    <div className={cn('rounded border border-white/10 bg-black/25', nested && 'border-white/8')}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => setExpanded((p) => !p)}
      >
        <div className={cn('shrink-0', meta.colorClass)}>
          <ToolIcon size={13} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11px] text-white/85">
            {isAgentTool ? (
              <span>Agent: {msg.subagentDescription ?? SUBAGENT_WORKING_LABEL}</span>
            ) : (
              <>
                {formatted.service && (
                  <span className="mr-1 text-[10px] text-white/45">
                    {formatted.service}
                    <span className="mx-1 opacity-50">/</span>
                  </span>
                )}
                {formatted.displayName}
              </>
            )}
          </div>
          {msg.toolFile && (
            <div className="truncate font-mono text-[10px] text-white/45">{msg.toolFile}</div>
          )}
        </div>
        <div className={cn('flex shrink-0 items-center gap-1 font-mono text-[10px]', statusColor)}>
          {statusIcon}
          <span>{statusText}</span>
        </div>
        <ChevronRight
          size={12}
          className={cn(
            'shrink-0 text-white/40 transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-white/8 px-2.5 py-2 font-mono text-[11px] text-white/60">
          {hasEditDiff ? (
            <div className="space-y-1">
              {msg.oldString && (
                <div className="whitespace-pre-wrap break-words rounded bg-red-500/10 px-2 py-1 text-red-300/80 line-through">
                  {msg.oldString}
                </div>
              )}
              {msg.newString && (
                <div className="whitespace-pre-wrap break-words rounded bg-emerald-500/10 px-2 py-1 text-emerald-300/80">
                  {msg.newString}
                </div>
              )}
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words">{msg.toolInput ?? ''}</div>
          )}
          {msg.toolOutput && (
            <div className="mt-2 border-t border-white/8 pt-2">
              <div className="mb-1 uppercase tracking-widest text-[10px] text-white/40">output</div>
              <div className="whitespace-pre-wrap break-words text-white/70">{msg.toolOutput}</div>
            </div>
          )}
          {hasChildren && (
            <div className="mt-2 border-t border-white/8 pt-2">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-white/40">
                activity
              </div>
              <div className="space-y-1 rounded border border-white/8 bg-black/30 p-1.5">
                {children.map((child) => {
                  if (child.kind === 'system') {
                    return <SystemDivider key={child.id} text={child.text} />
                  }
                  if (child.kind === 'tool') {
                    return <ToolBlock key={child.id} msg={child} nested />
                  }
                  if (child.kind === 'agent') {
                    return <AgentMessage key={child.id} text={child.text} />
                  }
                  if (child.kind === 'thinking') {
                    return <ThinkingBlock key={child.id} text={child.text} />
                  }
                  if (child.kind === 'user') {
                    return <UserMessage key={child.id} text={child.text} images={child.images} />
                  }
                  return null
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )

  return inner
}

function ToolCallGroup({ tools, onAnswer }: { tools: MsgItem[]; onAnswer: (toolId: string, answers: Record<string, string[]>) => void }) {
  const [expanded, setExpanded] = useState(false)
  const running = tools.filter((t) => t.toolStatus === 'running').length
  const errors = tools.filter((t) => t.toolStatus === 'error').length
  const done = tools.filter((t) => t.toolStatus === 'success').length

  const statusLabel = running > 0 ? `${running} running` : errors > 0 ? `${errors} failed` : 'done'
  const statusColor = running > 0 ? 'text-amber-400/80' : errors > 0 ? 'text-red-400' : 'text-emerald-400'

  // Suppress unused onAnswer lint — kept for interface consistency
  void onAnswer

  return (
    <div className="rounded border border-white/10 bg-black/25">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => setExpanded((p) => !p)}
      >
        <ChevronsUpDown size={12} className="shrink-0 text-white/40" />
        <span className="font-mono text-[11px] text-white/85">{tools.length} tool calls</span>
        <div className={cn('flex shrink-0 items-center gap-1 font-mono text-[10px]', statusColor)}>
          {running > 0 ? <Loader2 size={10} className="animate-spin" /> : errors > 0 ? <AlertTriangle size={10} /> : <Check size={10} />}
          <span>{statusLabel}</span>
        </div>
        {done > 0 && running > 0 && (
          <span className="font-mono text-[10px] text-white/40">{done}/{tools.length}</span>
        )}
        <ChevronRight
          size={12}
          className={cn('ml-auto shrink-0 text-white/40 transition-transform', expanded && 'rotate-90')}
        />
      </button>
      {expanded && (
        <div className="border-t border-white/8 space-y-1 p-1.5">
          {tools.map((t) => (
            <ToolBlock key={t.id} msg={t} />
          ))}
        </div>
      )}
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
    Object.fromEntries(questions.map((_, i) => [i, []])),
  )
  const [customTexts, setCustomTexts] = useState<Record<number, string>>(() =>
    Object.fromEntries(questions.map((_, i) => [i, ''])),
  )

  if (msg.askAnswered) {
    return (
      <div className="flex items-center gap-1.5 rounded border border-emerald-300/20 bg-emerald-500/8 px-2.5 py-2 font-mono text-[11px] text-emerald-300/70">
        <Check size={11} />
        <span>Response submitted</span>
      </div>
    )
  }

  function toggleOption(qi: number, label: string, multiSelect: boolean) {
    setSelections((prev) => {
      const current = prev[qi] ?? []
      if (multiSelect) {
        return {
          ...prev,
          [qi]: current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label],
        }
      }
      return { ...prev, [qi]: [label] }
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
    <div className="rounded border border-emerald-300/20 bg-emerald-500/8 px-2.5 py-2">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-emerald-300/70">
        Question
      </div>
      <div className="space-y-3">
        {questions.map((q, qi) => (
          <div key={qi}>
            <p className="mb-1.5 text-sm text-white/90">{q.question}</p>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt) => {
                const selected = (selections[qi] ?? []).includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => toggleOption(qi, opt.label, q.multiSelect)}
                    title={opt.description}
                    className={cn(
                      'flex items-center gap-1 rounded border px-2 py-1 text-xs transition',
                      selected
                        ? 'border-emerald-300/50 bg-emerald-300/20 text-emerald-100'
                        : 'border-white/15 bg-black/30 text-white/70 hover:border-white/30',
                    )}
                  >
                    {selected && <Check size={10} />}
                    {opt.label}
                  </button>
                )
              })}
            </div>
            <input
              type="text"
              className="mt-1.5 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-xs text-white placeholder:text-white/35 focus:border-emerald-300/50 focus:outline-none"
              placeholder="Other..."
              value={customTexts[qi] ?? ''}
              onChange={(e) =>
                setCustomTexts((prev) => ({ ...prev, [qi]: e.target.value }))
              }
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!allAnswered || !!msg.askSubmitting}
        className="mt-3 rounded border border-emerald-300/35 bg-emerald-300/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-emerald-100 transition enabled:hover:bg-emerald-300/25 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {msg.askSubmitting ? 'Submitting...' : 'Submit'}
      </button>
    </div>
  )
}

// ── Main export ─────────────────────────────────────────────────

export interface SessionMessageListProps {
  messages: MsgItem[]
  onAnswer: (toolId: string, answers: Record<string, string[]>) => void
  emptyLabel?: string
  /** Commander (or other) avatar for agent message rail — e.g. `/api/commanders/{id}/avatar` */
  agentAvatarUrl?: string | null
  /** Left accent on agent bubbles (CSS color) */
  agentAccentColor?: string | null
}

export function SessionMessageList({
  messages,
  onAnswer,
  emptyLabel = 'No messages yet.',
  agentAvatarUrl,
  agentAccentColor,
}: SessionMessageListProps) {
  if (messages.length === 0) {
    return (
      <p className="rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-white/60">
        {emptyLabel}
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <RunningAgentsPanel messages={messages} />
      {groupMessages(messages).map((item) => {
        if (item.type === 'tool-group') {
          return <ToolCallGroup key={item.id} tools={item.tools} onAnswer={onAnswer} />
        }
        const msg = item.msg
        switch (msg.kind) {
          case 'system':
            return <SystemDivider key={msg.id} text={msg.text} />
          case 'user':
            return <UserMessage key={msg.id} text={msg.text} images={msg.images} />
          case 'thinking':
            return <ThinkingBlock key={msg.id} text={msg.text} />
          case 'agent':
            return (
              <AgentMessage
                key={msg.id}
                text={msg.text}
                avatarUrl={agentAvatarUrl}
                accentColor={agentAccentColor}
              />
            )
          case 'tool':
            return <ToolBlock key={msg.id} msg={msg} />
          case 'ask':
            return <AskUserQuestionBlock key={msg.id} msg={msg} onAnswer={onAnswer} />
          default:
            return null
        }
      })}
    </div>
  )
}
