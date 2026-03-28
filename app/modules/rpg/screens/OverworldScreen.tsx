import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AskDialog } from '../AskDialog'
import { CommandPrompt } from '../CommandPrompt'
import { DialoguePanel } from '../DialoguePanel'
import { PartyHud } from '../PartyHud'
import { RpgScene, type RpgSceneHandle, type ObjectInteraction } from '../RpgScene'
import { useSessionWs } from '../use-session-ws'
import type { WorldAgent } from '../use-world-state'
import { fetchJson, fetchVoid } from '../../../src/lib/api'

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface CommanderSession {
  id: string
  host: string
  state: 'idle' | 'running' | 'paused' | 'stopped'
  agentType: 'claude' | 'codex'
  currentTask: { issueNumber: number; issueUrl: string; startedAt: string } | null
  completedTasks: number
  totalCostUsd: number
  persona?: string
}

interface AgentSession {
  name: string
  label?: string
  sessionType: 'stream' | 'pty'
  agentType: string
  cwd: string
  host?: string
  pid: number
}

// Browser-safe quest types (mirrors quest-store.ts without node imports)
type QuestStatus = 'pending' | 'active' | 'done' | 'failed'
type QuestSource = 'manual' | 'github-issue' | 'idea' | 'voice-log'

interface QuestArtifact {
  type: string
  label: string
  href: string
}

interface Quest {
  id: string
  commanderId: string
  createdAt: string
  status: QuestStatus
  source: QuestSource
  instruction: string
  githubIssueUrl?: string
  note?: string
  artifacts?: QuestArtifact[]
}

const STATUS_STYLE: Record<QuestStatus, { dot: string; text: string; label: string }> = {
  pending:  { dot: 'border-amber-500/60 bg-amber-500/20', text: 'text-amber-400', label: 'Pending' },
  active:   { dot: 'border-emerald-500/60 bg-emerald-500/20', text: 'text-emerald-300', label: 'Active' },
  done:     { dot: 'border-amber-600/40 bg-amber-600/30', text: 'text-amber-600', label: 'Done' },
  failed:   { dot: 'border-red-500/40 bg-red-500/20', text: 'text-red-400', label: 'Failed' },
}

// ---------------------------------------------------------------------------
// BG3-style Quest Board (overlay)
// ---------------------------------------------------------------------------

function QuestBoard({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()

  const { data: commanders = [] } = useQuery({
    queryKey: ['rpg', 'commanders'],
    queryFn: () => fetchJson<CommanderSession[]>('/api/commanders/'),
    refetchInterval: 3000,
  })

  const [selectedCmdId, setSelectedCmdId] = useState<string | null>(null)
  const [selectedQuestId, setSelectedQuestId] = useState<string | null>(null)
  const [showNewQuest, setShowNewQuest] = useState(false)
  const selectedCmd = commanders.find((c) => c.id === selectedCmdId)

  // Fetch quests for selected commander
  const { data: quests = [] } = useQuery({
    queryKey: ['rpg', 'quests', selectedCmdId],
    queryFn: () => fetchJson<Quest[]>(`/api/commanders/${selectedCmdId}/quests`),
    enabled: Boolean(selectedCmdId),
    refetchInterval: 3000,
  })

  const selectedQuest = quests.find((q) => q.id === selectedQuestId)

  // Quest mutations
  const createQuest = useMutation({
    mutationFn: (body: { instruction: string; source: QuestSource; githubIssueUrl?: string }) =>
      fetchJson(`/api/commanders/${selectedCmdId}/quests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          status: 'pending',
          contract: { cwd: '/home/ec2-user/App', permissionMode: 'default', agentType: 'claude', skillsToUse: [] },
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rpg', 'quests', selectedCmdId] })
      setShowNewQuest(false)
    },
  })

  const updateQuestStatus = useMutation({
    mutationFn: ({ questId, status }: { questId: string; status: QuestStatus }) =>
      fetchJson(`/api/commanders/${selectedCmdId}/quests/${questId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rpg', 'quests', selectedCmdId] })
    },
  })

  const deleteQuest = useMutation({
    mutationFn: (questId: string) =>
      fetchVoid(`/api/commanders/${selectedCmdId}/quests/${questId}`, { method: 'DELETE' }),
    onSuccess: (_, questId) => {
      queryClient.invalidateQueries({ queryKey: ['rpg', 'quests', selectedCmdId] })
      if (selectedQuestId === questId) setSelectedQuestId(null)
    },
  })

  const handleNewQuestSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    const instruction = (fd.get('instruction') as string).trim()
    const source = (fd.get('source') as QuestSource) || 'manual'
    const githubIssueUrl = (fd.get('githubIssueUrl') as string).trim() || undefined
    if (!instruction) return
    createQuest.mutate({ instruction, source, githubIssueUrl })
  }

  // Group quests by status for display
  const questsByStatus = useMemo(() => {
    const groups: Record<QuestStatus, Quest[]> = { active: [], pending: [], done: [], failed: [] }
    for (const q of quests) {
      groups[q.status].push(q)
    }
    return groups
  }, [quests])

  return (
    <div className="absolute inset-x-6 bottom-6 top-12 z-40 flex overflow-hidden rounded border border-amber-700/50 bg-[#1a1108]/95 shadow-2xl shadow-black/60 backdrop-blur-sm">
      {/* Left pane — commander + quest list */}
      <div className="flex w-[320px] shrink-0 flex-col border-r border-amber-900/40">
        {/* Header */}
        <div className="border-b border-amber-900/40 px-5 py-3">
          <h2 className="font-serif text-lg font-bold tracking-wide text-amber-100">Quest Board</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-amber-600">{commanders.length} commander{commanders.length !== 1 ? 's' : ''}</p>
        </div>
        {/* Commander + quest tree */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {commanders.length === 0 ? (
            <p className="px-2 py-4 font-serif text-sm italic text-amber-800">No commanders registered...</p>
          ) : (
            commanders.map((cmd) => {
              const isSel = selectedCmdId === cmd.id
              return (
                <div key={cmd.id} className="mb-1">
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition ${
                      isSel ? 'bg-amber-800/30 text-amber-100' : 'text-amber-300/80 hover:bg-amber-900/15 hover:text-amber-200'
                    }`}
                    onClick={() => { setSelectedCmdId(cmd.id); setSelectedQuestId(null); setShowNewQuest(false) }}
                  >
                    <span className={`shrink-0 h-2 w-2 rounded-full ${cmd.state === 'running' ? 'bg-emerald-400' : 'bg-amber-700'}`} />
                    <span className="min-w-0 truncate font-serif text-[12px]">
                      {cmd.host}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-amber-600">{cmd.state}</span>
                  </button>
                  {/* Show quests under selected commander */}
                  {isSel && quests.length > 0 ? (
                    <div className="ml-5 border-l border-amber-900/30 pl-3 py-1">
                      {(['active', 'pending', 'done', 'failed'] as QuestStatus[]).map((status) => {
                        const group = questsByStatus[status]
                        if (group.length === 0) return null
                        const style = STATUS_STYLE[status]
                        return (
                          <div key={status} className="mb-1">
                            <p className={`text-[9px] uppercase tracking-wider ${style.text} px-1 py-0.5`}>
                              {style.label} ({group.length})
                            </p>
                            {group.map((q) => (
                              <button
                                key={q.id}
                                type="button"
                                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left transition ${
                                  selectedQuestId === q.id
                                    ? 'bg-amber-800/25 text-amber-100'
                                    : 'text-amber-400/70 hover:bg-amber-900/15 hover:text-amber-200'
                                }`}
                                onClick={() => { setSelectedQuestId(q.id); setShowNewQuest(false) }}
                              >
                                <span className={`shrink-0 h-2.5 w-2.5 rounded-full border ${style.dot}`} />
                                <span className="min-w-0 truncate text-[11px]">
                                  {q.instruction.slice(0, 50)}{q.instruction.length > 50 ? '...' : ''}
                                </span>
                              </button>
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Right pane — quest details or new quest form */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-amber-900/40 px-5 py-3">
          <h3 className="font-serif text-base font-bold text-amber-100">
            {showNewQuest ? 'New Quest' : selectedQuest ? 'Quest Details' : selectedCmd ? selectedCmd.host : 'Select a Commander'}
          </h3>
          <div className="flex gap-2">
            {selectedCmdId && !showNewQuest ? (
              <button
                type="button"
                className="rounded border border-emerald-700/40 bg-emerald-900/20 px-3 py-1 font-serif text-[11px] text-emerald-300 hover:bg-emerald-900/40"
                onClick={() => { setShowNewQuest(true); setSelectedQuestId(null) }}
              >
                + New Quest
              </button>
            ) : null}
            <button
              type="button"
              className="rounded border border-amber-700/40 bg-amber-900/20 px-3 py-1 font-serif text-[11px] text-amber-300 hover:bg-amber-900/40"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {showNewQuest && selectedCmdId ? (
            /* New quest form */
            <form onSubmit={handleNewQuestSubmit} className="space-y-4">
              <div>
                <label className="mb-1 block font-serif text-[12px] font-semibold text-amber-200">Instruction</label>
                <textarea
                  name="instruction"
                  required
                  rows={4}
                  className="w-full rounded border border-amber-800/50 bg-amber-950/40 px-3 py-2 font-mono text-[12px] text-amber-100 placeholder-amber-700 focus:border-amber-500/60 focus:outline-none"
                  placeholder="Describe the quest objective..."
                />
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="mb-1 block font-serif text-[12px] font-semibold text-amber-200">Source</label>
                  <select
                    name="source"
                    className="w-full rounded border border-amber-800/50 bg-amber-950/40 px-3 py-1.5 font-serif text-[12px] text-amber-100 focus:border-amber-500/60 focus:outline-none"
                  >
                    <option value="manual">Manual</option>
                    <option value="github-issue">GitHub Issue</option>
                    <option value="idea">Idea</option>
                    <option value="voice-log">Voice Log</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="mb-1 block font-serif text-[12px] font-semibold text-amber-200">GitHub Issue URL</label>
                  <input
                    name="githubIssueUrl"
                    type="text"
                    className="w-full rounded border border-amber-800/50 bg-amber-950/40 px-3 py-1.5 font-mono text-[12px] text-amber-100 placeholder-amber-700 focus:border-amber-500/60 focus:outline-none"
                    placeholder="Optional..."
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  disabled={createQuest.isPending}
                  className="rounded border border-emerald-700/50 bg-emerald-900/30 px-4 py-1.5 font-serif text-[12px] text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-40"
                >
                  {createQuest.isPending ? 'Creating...' : 'Create Quest'}
                </button>
                <button
                  type="button"
                  className="rounded border border-amber-700/40 bg-amber-900/20 px-4 py-1.5 font-serif text-[12px] text-amber-300 hover:bg-amber-900/40"
                  onClick={() => setShowNewQuest(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : selectedQuest ? (
            /* Quest detail view */
            <div className="space-y-5">
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`inline-block h-3 w-3 rounded-full border ${STATUS_STYLE[selectedQuest.status].dot}`} />
                  <span className={`font-serif text-[13px] font-semibold ${STATUS_STYLE[selectedQuest.status].text}`}>
                    {STATUS_STYLE[selectedQuest.status].label}
                  </span>
                  <span className="text-[10px] text-amber-700">
                    {selectedQuest.source} &middot; {new Date(selectedQuest.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <h4 className="mb-2 font-serif text-[13px] font-semibold text-amber-200">Instruction:</h4>
                <p className="rounded border border-amber-900/30 bg-amber-950/30 px-3 py-2 font-mono text-[12px] leading-relaxed text-amber-100/90 whitespace-pre-wrap">
                  {selectedQuest.instruction}
                </p>
              </div>

              {selectedQuest.githubIssueUrl ? (
                <div>
                  <h4 className="mb-1 font-serif text-[12px] font-semibold text-amber-200">GitHub Issue:</h4>
                  <a
                    href={selectedQuest.githubIssueUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-amber-400 underline hover:text-amber-200"
                  >
                    {selectedQuest.githubIssueUrl}
                  </a>
                </div>
              ) : null}

              {selectedQuest.note ? (
                <div>
                  <h4 className="mb-1 font-serif text-[12px] font-semibold text-amber-200">Notes:</h4>
                  <p className="rounded border border-amber-900/30 bg-amber-950/30 px-3 py-2 text-[11px] leading-relaxed text-amber-300/80 whitespace-pre-wrap">
                    {selectedQuest.note}
                  </p>
                </div>
              ) : null}

              {selectedQuest.artifacts && selectedQuest.artifacts.length > 0 ? (
                <div>
                  <h4 className="mb-1 font-serif text-[12px] font-semibold text-amber-200">Artifacts:</h4>
                  <div className="space-y-1">
                    {selectedQuest.artifacts.map((a, i) => (
                      <a
                        key={i}
                        href={a.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-[11px] text-amber-400 hover:text-amber-200"
                      >
                        <span className="shrink-0 text-[9px] uppercase text-amber-600">[{a.type}]</span>
                        {a.label}
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Status actions */}
              <div className="flex flex-wrap gap-2 border-t border-amber-900/30 pt-4">
                {selectedQuest.status !== 'done' ? (
                  <button
                    type="button"
                    disabled={updateQuestStatus.isPending}
                    className="rounded border border-emerald-700/50 bg-emerald-900/30 px-3 py-1 font-serif text-[11px] text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-40"
                    onClick={() => updateQuestStatus.mutate({ questId: selectedQuest.id, status: 'done' })}
                  >
                    Mark Done
                  </button>
                ) : null}
                {selectedQuest.status === 'pending' ? (
                  <button
                    type="button"
                    disabled={updateQuestStatus.isPending}
                    className="rounded border border-cyan-700/50 bg-cyan-900/30 px-3 py-1 font-serif text-[11px] text-cyan-300 hover:bg-cyan-900/50 disabled:opacity-40"
                    onClick={() => updateQuestStatus.mutate({ questId: selectedQuest.id, status: 'active' })}
                  >
                    Activate
                  </button>
                ) : null}
                {selectedQuest.status === 'active' ? (
                  <button
                    type="button"
                    disabled={updateQuestStatus.isPending}
                    className="rounded border border-amber-700/50 bg-amber-900/30 px-3 py-1 font-serif text-[11px] text-amber-300 hover:bg-amber-900/50 disabled:opacity-40"
                    onClick={() => updateQuestStatus.mutate({ questId: selectedQuest.id, status: 'pending' })}
                  >
                    Back to Pending
                  </button>
                ) : null}
                {selectedQuest.status !== 'failed' ? (
                  <button
                    type="button"
                    disabled={updateQuestStatus.isPending}
                    className="rounded border border-red-700/50 bg-red-900/30 px-3 py-1 font-serif text-[11px] text-red-300 hover:bg-red-900/50 disabled:opacity-40"
                    onClick={() => updateQuestStatus.mutate({ questId: selectedQuest.id, status: 'failed' })}
                  >
                    Mark Failed
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={deleteQuest.isPending}
                  className="ml-auto rounded border border-red-800/40 bg-red-950/30 px-3 py-1 font-serif text-[11px] text-red-400/80 hover:bg-red-900/40 disabled:opacity-40"
                  onClick={() => deleteQuest.mutate(selectedQuest.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ) : selectedCmd ? (
            /* Commander overview (no quest selected) */
            <div className="space-y-5">
              <div>
                <h4 className="mb-2 font-serif text-[13px] font-semibold text-amber-200">Commander Overview</h4>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
                  <dt className="text-amber-600">Host</dt>
                  <dd className="text-amber-200">{selectedCmd.host}</dd>
                  <dt className="text-amber-600">State</dt>
                  <dd className={selectedCmd.state === 'running' ? 'text-emerald-300' : 'text-amber-200'}>{selectedCmd.state}</dd>
                  <dt className="text-amber-600">Agent</dt>
                  <dd className="text-amber-200">{selectedCmd.agentType}</dd>
                  <dt className="text-amber-600">Total Cost</dt>
                  <dd className="text-amber-200">${selectedCmd.totalCostUsd.toFixed(4)}</dd>
                  <dt className="text-amber-600">Completed Tasks</dt>
                  <dd className="text-amber-200">{selectedCmd.completedTasks}</dd>
                </dl>
              </div>
              <div className="border-t border-amber-900/30 pt-4">
                <p className="font-serif text-[12px] text-amber-500">
                  {quests.length} quest{quests.length !== 1 ? 's' : ''} total &middot;{' '}
                  {questsByStatus.active.length} active &middot;{' '}
                  {questsByStatus.pending.length} pending
                </p>
                {quests.length === 0 ? (
                  <p className="mt-2 font-serif text-[12px] italic text-amber-700">
                    No quests yet. Click "+ New Quest" to create one.
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="py-8 text-center font-serif text-sm italic text-amber-800">
              Choose a commander to view their quest board.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RPG-style Agent Control (overlay)
// ---------------------------------------------------------------------------

function AgentControl({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()

  const { data: commanders = [] } = useQuery({
    queryKey: ['rpg', 'commanders'],
    queryFn: () => fetchJson<CommanderSession[]>('/api/commanders/'),
    refetchInterval: 3000,
  })

  const { data: sessions = [] } = useQuery({
    queryKey: ['rpg', 'agent-sessions'],
    queryFn: () => fetchJson<AgentSession[]>('/api/agents/sessions'),
    refetchInterval: 3000,
  })

  const startCommander = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/commanders/${id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['rpg', 'commanders'] }) },
  })

  const stopCommander = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/commanders/${id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['rpg', 'commanders'] }) },
  })

  const killSession = useMutation({
    mutationFn: (name: string) => fetchVoid(`/api/agents/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['rpg', 'agent-sessions'] }) },
  })

  const [tab, setTab] = useState<'commanders' | 'sessions'>('commanders')
  const [showRecruit, setShowRecruit] = useState(false)

  const createSession = useMutation({
    mutationFn: (body: { name: string; systemPrompt: string; agentType: string; cwd: string }) =>
      fetchJson('/api/agents/sessions/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rpg', 'agent-sessions'] })
      setShowRecruit(false)
    },
  })

  return (
    <div className="absolute inset-x-6 bottom-6 top-12 z-40 flex flex-col overflow-hidden rounded border border-cyan-800/50 bg-[#0a1118]/95 shadow-2xl shadow-black/60 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-cyan-800/40 px-5 py-3">
        <h2 className="font-serif text-lg font-bold tracking-wide text-cyan-100">Agent Control</h2>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border border-emerald-700/40 bg-emerald-900/20 px-3 py-1 font-serif text-[11px] text-emerald-300 hover:bg-emerald-900/40"
            onClick={() => setShowRecruit(true)}
          >
            + Recruit
          </button>
          <button
            type="button"
            className="rounded border border-cyan-700/40 bg-cyan-900/20 px-3 py-1 font-serif text-[11px] text-cyan-300 hover:bg-cyan-900/40"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-cyan-900/40">
        <button
          type="button"
          className={`px-5 py-2 font-serif text-[12px] uppercase tracking-wider transition ${
            tab === 'commanders'
              ? 'border-b-2 border-cyan-400 text-cyan-200'
              : 'text-cyan-600 hover:text-cyan-400'
          }`}
          onClick={() => setTab('commanders')}
        >
          Commanders
        </button>
        <button
          type="button"
          className={`px-5 py-2 font-serif text-[12px] uppercase tracking-wider transition ${
            tab === 'sessions'
              ? 'border-b-2 border-cyan-400 text-cyan-200'
              : 'text-cyan-600 hover:text-cyan-400'
          }`}
          onClick={() => setTab('sessions')}
        >
          Sessions
        </button>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'commanders' ? (
          <div className="space-y-2">
            {commanders.length === 0 ? (
              <p className="py-4 text-center font-serif text-sm italic text-cyan-800">No commanders registered.</p>
            ) : (
              commanders.map((cmd) => {
                const isRunning = cmd.state === 'running'
                const isBusy = startCommander.isPending || stopCommander.isPending
                return (
                  <div key={cmd.id} className="flex items-center gap-3 rounded border border-cyan-900/40 bg-cyan-950/30 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-serif text-[13px] font-medium text-cyan-100">{cmd.host}</span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${
                          isRunning ? 'bg-emerald-900/50 text-emerald-300' :
                          cmd.state === 'stopped' ? 'bg-red-900/40 text-red-300' :
                          'bg-cyan-900/40 text-cyan-400'
                        }`}>
                          {cmd.state}
                        </span>
                      </div>
                      {cmd.persona ? (
                        <p className="mt-0.5 truncate text-[10px] italic text-cyan-600">{cmd.persona}</p>
                      ) : null}
                      <p className="mt-1 text-[10px] text-cyan-700">
                        {cmd.agentType} &middot; ${cmd.totalCostUsd.toFixed(2)} &middot; {cmd.completedTasks} done
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {isRunning ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          className="rounded border border-red-700/50 bg-red-900/30 px-3 py-1.5 font-serif text-[11px] text-red-300 hover:bg-red-900/50 disabled:opacity-40"
                          onClick={() => stopCommander.mutate(cmd.id)}
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isBusy || cmd.state === 'stopped'}
                          className="rounded border border-emerald-700/50 bg-emerald-900/30 px-3 py-1.5 font-serif text-[11px] text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-40"
                          onClick={() => startCommander.mutate(cmd.id)}
                        >
                          Start
                        </button>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.length === 0 ? (
              <p className="py-4 text-center font-serif text-sm italic text-cyan-800">No active sessions.</p>
            ) : (
              sessions.map((session) => (
                <div key={session.name} className="flex items-center gap-3 rounded border border-cyan-900/40 bg-cyan-950/30 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-serif text-[13px] font-medium text-cyan-100">{session.label || session.name}</span>
                      <span className="shrink-0 rounded bg-cyan-900/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-cyan-400">
                        {session.agentType}
                      </span>
                      <span className="shrink-0 rounded bg-cyan-900/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-cyan-500">
                        {session.sessionType}
                      </span>
                    </div>
                    {session.host ? (
                      <p className="mt-0.5 text-[10px] text-cyan-700">host: {session.host}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={killSession.isPending}
                    className="shrink-0 rounded border border-red-700/50 bg-red-900/30 px-3 py-1.5 font-serif text-[11px] text-red-300 hover:bg-red-900/50 disabled:opacity-40"
                    onClick={() => killSession.mutate(session.name)}
                  >
                    Kill
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {showRecruit ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <form
            className="w-[400px] rounded border border-cyan-700/50 bg-[#0a1118] p-5 shadow-xl"
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              const name = (fd.get('name') as string).trim()
              const systemPrompt = (fd.get('systemPrompt') as string).trim()
              const agentType = (fd.get('agentType') as string) || 'claude'
              if (!name) return
              createSession.mutate({ name, systemPrompt: systemPrompt || 'You are a helpful assistant.', agentType, cwd: '/home/ec2-user/App' })
            }}
          >
            <h3 className="mb-4 font-serif text-base font-bold text-cyan-100">Recruit New Worker</h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block font-serif text-[12px] font-semibold text-cyan-200">Session Name</label>
                <input
                  name="name"
                  required
                  className="w-full rounded border border-cyan-800/50 bg-cyan-950/40 px-3 py-1.5 font-mono text-[12px] text-cyan-100 placeholder-cyan-700 focus:border-cyan-500/60 focus:outline-none"
                  placeholder="e.g. bugfix-auth"
                />
              </div>
              <div>
                <label className="mb-1 block font-serif text-[12px] font-semibold text-cyan-200">Agent Type</label>
                <select
                  name="agentType"
                  className="w-full rounded border border-cyan-800/50 bg-cyan-950/40 px-3 py-1.5 font-serif text-[12px] text-cyan-100 focus:border-cyan-500/60 focus:outline-none"
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block font-serif text-[12px] font-semibold text-cyan-200">System Prompt</label>
                <textarea
                  name="systemPrompt"
                  rows={3}
                  className="w-full rounded border border-cyan-800/50 bg-cyan-950/40 px-3 py-2 font-mono text-[12px] text-cyan-100 placeholder-cyan-700 focus:border-cyan-500/60 focus:outline-none"
                  placeholder="Optional system prompt..."
                />
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="submit"
                disabled={createSession.isPending}
                className="rounded border border-emerald-700/50 bg-emerald-900/30 px-4 py-1.5 font-serif text-[12px] text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-40"
              >
                {createSession.isPending ? 'Recruiting...' : 'Recruit'}
              </button>
              <button
                type="button"
                className="rounded border border-cyan-700/40 bg-cyan-900/20 px-4 py-1.5 font-serif text-[12px] text-cyan-300 hover:bg-cyan-900/40"
                onClick={() => setShowRecruit(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OverworldScreen
// ---------------------------------------------------------------------------

interface OverworldScreenProps {
  agents: WorldAgent[]
  worldStatus: 'live' | 'syncing' | 'offline'
  worldError?: string
}

export function OverworldScreen({ agents, worldStatus, worldError }: OverworldScreenProps) {
  const sceneRef = useRef<RpgSceneHandle | null>(null)

  const streamAgents = useMemo(
    () => agents.filter((agent) => agent.sessionType === 'stream'),
    [agents],
  )
  const streamAgentIds = useMemo(
    () => new Set(streamAgents.map((agent) => agent.id)),
    [streamAgents],
  )

  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined)
  const [nearestAgentId, setNearestAgentId] = useState<string | null>(null)
  const [dialogueAgentId, setDialogueAgentId] = useState<string | null>(null)
  const [objectPanel, setObjectPanel] = useState<ObjectInteraction | null>(null)

  useEffect(() => {
    setSelectedAgentId((previous) => {
      if (previous && streamAgents.some((agent) => agent.id === previous)) {
        return previous
      }
      return streamAgents[0]?.id
    })
  }, [streamAgents])

  useEffect(() => {
    if (!nearestAgentId || streamAgentIds.has(nearestAgentId)) {
      return
    }
    setNearestAgentId(null)
  }, [nearestAgentId, streamAgentIds])

  useEffect(() => {
    if (!dialogueAgentId || streamAgentIds.has(dialogueAgentId)) {
      return
    }
    setDialogueAgentId(null)
  }, [dialogueAgentId, streamAgentIds])

  useEffect(() => {
    if (!dialogueAgentId && !objectPanel) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      event.preventDefault()
      setDialogueAgentId(null)
      setObjectPanel(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [dialogueAgentId, objectPanel])

  const handleInteract = useCallback(() => {
    if (!nearestAgentId || dialogueAgentId || objectPanel) {
      return
    }
    setSelectedAgentId(nearestAgentId)
    setDialogueAgentId(nearestAgentId)
  }, [dialogueAgentId, nearestAgentId, objectPanel])

  const handleObjectInteract = useCallback((obj: ObjectInteraction) => {
    if (dialogueAgentId || objectPanel) {
      return
    }
    setObjectPanel(obj)
  }, [dialogueAgentId, objectPanel])

  const handleToolUse = useCallback((toolName: string) => {
    if (!selectedAgentId) {
      return
    }
    sceneRef.current?.emitToolFx(selectedAgentId, toolName)
  }, [selectedAgentId])

  const {
    status: wsStatus,
    pendingAsk,
    sendInput,
    sendToolAnswer,
  } = useSessionWs({
    sessionName: selectedAgentId,
    onToolUse: handleToolUse,
  })

  return (
    <section className="relative h-[100dvh] w-full overflow-hidden bg-black">
      <RpgScene
        ref={sceneRef}
        agents={agents}
        className="absolute inset-0"
        streamAgentIds={streamAgentIds}
        onNearestStreamAgentChange={setNearestAgentId}
        onInteract={handleInteract}
        onObjectInteract={handleObjectInteract}
        playerFrozen={Boolean(dialogueAgentId || objectPanel)}
      />

      <PartyHud
        worldStatus={worldStatus}
        wsStatus={wsStatus}
      />

      <button
        type="button"
        className="pointer-events-auto absolute left-3 top-3 z-20 rounded-md border border-white/20 bg-black/45 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-white/70 backdrop-blur-[2px] hover:bg-black/60 hover:text-white/90 active:bg-black/75"
        onClick={() => sceneRef.current?.resetPositions()}
        title="Reset all agent positions to their default spots"
      >
        reset pos
      </button>

      {worldError ? (
        <div className="pointer-events-none absolute inset-x-0 top-12 z-20 px-3 text-center text-[10px] font-mono text-red-200/95">
          {worldError}
        </div>
      ) : null}

      {streamAgents.length === 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-30 px-3 text-center text-[11px] font-mono uppercase tracking-[0.08em] text-amber-100/90">
          create a stream agent session to enable command + dialog input
        </div>
      ) : null}

      {!dialogueAgentId && !objectPanel ? (
        <AskDialog
          pendingAsk={pendingAsk}
          disabled={wsStatus !== 'connected'}
          onSubmit={sendToolAnswer}
        />
      ) : null}

      {!dialogueAgentId && !objectPanel ? (
        <CommandPrompt
          selectedAgentId={selectedAgentId}
          disabled={wsStatus !== 'connected'}
          onSubmit={sendInput}
        />
      ) : null}

      {dialogueAgentId ? (
        <DialoguePanel
          agentId={dialogueAgentId}
          onClose={() => setDialogueAgentId(null)}
        />
      ) : null}

      {objectPanel === 'quest-board' ? (
        <QuestBoard onClose={() => setObjectPanel(null)} />
      ) : null}

      {objectPanel === 'agent-control' ? (
        <AgentControl onClose={() => setObjectPanel(null)} />
      ) : null}
    </section>
  )
}
