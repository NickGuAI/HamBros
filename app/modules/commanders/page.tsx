import { type FormEvent, useState } from 'react'
import { Crown, Plus, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useMachines } from '@/hooks/use-agents'
import { cn } from '@/lib/utils'
import type { AgentType, ClaudePermissionMode, SessionType } from '@/types'
import { NewSessionForm } from '../agents/components/NewSessionForm'
import { ModalFormContainer } from '../components/ModalFormContainer'
import { CommanderList } from './components/CommanderList'
import { QuestBoard } from './components/QuestBoard'
import { HeartbeatMonitor } from './components/HeartbeatMonitor'
import { useCommander } from './hooks/useCommander'

declare module './hooks/useCommander' {
  interface CommanderSession {
    channelMeta?: {
      provider: 'whatsapp' | 'telegram' | 'discord'
      displayName: string
      subject?: string
      space?: string
    }
  }
}

const CHANNEL_PROVIDER_LABELS: Record<'whatsapp' | 'telegram' | 'discord', string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return 'pending'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return 'pending'
  }

  return parsed.toLocaleString()
}

export default function CommandersPage() {
  const navigate = useNavigate()
  const commander = useCommander()
  const { data: machines } = useMachines()
  const machineList = machines ?? []
  const selectedCommanderId = commander.selectedCommander?.id ?? null
  const selectedChannelMeta = commander.selectedCommander?.channelMeta

  const [showCronForm, setShowCronForm] = useState(false)
  const [cronSchedule, setCronSchedule] = useState('')
  const [cronInstruction, setCronInstruction] = useState('')
  const [cronWorkDir, setCronWorkDir] = useState('')
  const [cronMode, setCronMode] = useState<ClaudePermissionMode>('acceptEdits')
  const [cronAgentType, setCronAgentType] = useState<AgentType>('claude')
  const [cronSessionType, setCronSessionType] = useState<SessionType>('stream')
  const [cronSelectedHost, setCronSelectedHost] = useState('')
  const [cronFormError, setCronFormError] = useState<string | null>(null)

  const pageError = commander.actionError ?? commander.commandersError

  async function handleOpenChat(
    commanderId: string,
    agentType: 'claude' | 'codex',
  ): Promise<void> {
    const params = new URLSearchParams({
      session: `commander-${commanderId}`,
      agentType,
    })
    navigate(`/agents?${params.toString()}`)
  }

  async function handleAddCron(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!selectedCommanderId) {
      return
    }
    const schedule = cronSchedule.trim()
    const instruction = cronInstruction.trim()
    if (!schedule || !instruction) {
      setCronFormError('Schedule and instruction are required.')
      return
    }
    const workDir = cronWorkDir.trim()
    setCronFormError(null)
    try {
      await commander.addCron({
        commanderId: selectedCommanderId,
        schedule,
        instruction,
        ...(cronAgentType !== 'claude' ? { agentType: cronAgentType as 'claude' | 'codex' } : {}),
        ...(cronSessionType !== 'stream' ? { sessionType: cronSessionType } : {}),
        ...(cronMode !== 'acceptEdits' ? { permissionMode: cronMode } : {}),
        ...(workDir ? { workDir } : {}),
        ...(cronSelectedHost ? { machine: cronSelectedHost } : {}),
      })
      setCronSchedule('')
      setCronInstruction('')
      setCronWorkDir('')
      setCronMode('acceptEdits')
      setCronAgentType('claude')
      setCronSessionType('stream')
      setCronSelectedHost('')
      setShowCronForm(false)
    } catch (error) {
      setCronFormError(error instanceof Error ? error.message : 'Failed to add cron')
    }
  }

  async function handleToggleCron(cronId: string, enabled: boolean): Promise<void> {
    if (!selectedCommanderId) {
      return
    }
    await commander.toggleCron({ commanderId: selectedCommanderId, cronId, enabled: !enabled })
  }

  async function handleDeleteCron(cronId: string): Promise<void> {
    if (!selectedCommanderId) {
      return
    }
    await commander.deleteCron({ commanderId: selectedCommanderId, cronId })
  }

  return (
    <div className="h-full flex flex-col">
      <header className="px-5 md:px-7 py-5 border-b border-ink-border bg-washi-aged/40">
        <div className="flex items-center gap-3">
          <Crown size={20} className="text-sumi-diluted" />
          <div>
            <h2 className="font-display text-display text-sumi-black">Commanders</h2>
            <p className="text-whisper text-sumi-mist mt-1 uppercase tracking-wider">
              Quest board, chat handoff, and scheduled runs
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 p-4 md:p-6">
        {pageError && (
          <p className="text-sm text-accent-vermillion mb-4">{pageError}</p>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] xl:h-full gap-4">
          <CommanderList
            commanders={commander.commanders}
            selectedCommanderId={commander.selectedCommanderId}
            onSelect={commander.setSelectedCommanderId}
            loading={commander.commandersLoading}
            onAddCommander={commander.createCommander}
            isAddingCommander={commander.createCommanderPending}
            onDeleteCommander={commander.deleteCommander}
            isDeletePending={commander.deleteCommanderPending}
            onOpenChat={handleOpenChat}
            onStartCommander={commander.startCommander}
            onStopCommander={commander.stopCommander}
            isStartPending={commander.startPending}
            isStopPending={commander.stopPending}
          />
          <div className="grid grid-cols-1 gap-4 xl:min-h-0 xl:grid-rows-[minmax(0,1fr)_minmax(12rem,16rem)]">
            {selectedChannelMeta && (
              <div className="card-sumi px-4 py-3">
                <p className="section-title">Channel Commander</p>
                <p className="mt-1 font-mono text-sm text-sumi-black truncate">
                  {CHANNEL_PROVIDER_LABELS[selectedChannelMeta.provider]} • {selectedChannelMeta.displayName}
                </p>
                {selectedChannelMeta.subject && (
                  <p className="mt-1 text-whisper text-sumi-diluted truncate">
                    {selectedChannelMeta.subject}
                  </p>
                )}
              </div>
            )}
            <QuestBoard commander={commander.selectedCommander} />

            <div className="min-h-0 grid grid-cols-1 xl:grid-cols-2 gap-4">
              <section className="card-sumi min-h-0 overflow-hidden flex flex-col">
                <header className="px-4 py-3 border-b border-ink-border bg-washi-aged/60 flex items-center justify-between gap-3">
                  <h3 className="section-title">Scheduled Runs</h3>
                  <button
                    type="button"
                    onClick={() => setShowCronForm((v) => !v)}
                    disabled={!commander.selectedCommander}
                    className="btn-ghost !px-3 !py-1.5 text-xs inline-flex min-h-[44px] items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <Plus size={12} />
                    {showCronForm ? 'Close' : 'Add Scheduled Run'}
                  </button>
                </header>

                <ModalFormContainer
                  open={Boolean(commander.selectedCommander && showCronForm)}
                  title="Add Scheduled Run"
                  onClose={() => setShowCronForm(false)}
                >
                  <NewSessionForm
                    cwd={cronWorkDir}
                    setCwd={setCronWorkDir}
                    mode={cronMode}
                    setMode={setCronMode}
                    task={cronInstruction}
                    setTask={setCronInstruction}
                    agentType={cronAgentType}
                    setAgentType={setCronAgentType}
                    sessionType={cronSessionType}
                    setSessionType={setCronSessionType}
                    machines={machineList}
                    selectedHost={cronSelectedHost}
                    setSelectedHost={setCronSelectedHost}
                    isCreating={commander.addCronPending}
                    createError={cronFormError}
                    onSubmit={(e) => void handleAddCron(e)}
                    schedule={cronSchedule}
                    setSchedule={setCronSchedule}
                    submitLabel="Add Scheduled Run"
                    taskLabel="Instruction"
                    taskPlaceholder="Check your quest board and pick up pending quests."
                    taskRequired
                    showNameField={false}
                    agentOptions={['claude', 'codex']}
                  />
                </ModalFormContainer>

                <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                  {!commander.selectedCommander && (
                    <p className="text-sm text-sumi-diluted">Select a commander to view schedules.</p>
                  )}

                  {commander.selectedCommander && commander.cronsLoading && commander.crons.length === 0 && (
                    <div className="flex items-center justify-center h-20">
                      <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
                    </div>
                  )}

                  {commander.selectedCommander && !commander.cronsLoading && commander.crons.length === 0 && !commander.cronsError && !showCronForm && (
                    <p className="text-sm text-sumi-diluted">No scheduled runs for this commander.</p>
                  )}

                  {commander.selectedCommander && commander.crons.map((cron) => (
                    <div
                      key={cron.id}
                      className="rounded-lg border border-ink-border bg-washi-white px-3 py-2.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-mono text-sm text-sumi-black truncate">{cron.schedule}</p>
                          <p className="text-sm text-sumi-gray mt-1 line-clamp-2">{cron.instruction}</p>
                          {(cron.agentType || cron.permissionMode) && (
                            <p className="text-whisper text-sumi-diluted mt-1 truncate">
                              {[cron.agentType, cron.permissionMode].filter(Boolean).join(' · ')}
                            </p>
                          )}
                          <p className="text-whisper text-sumi-mist mt-1">
                            next: {formatDateTime(cron.nextRun)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleToggleCron(cron.id, cron.enabled)}
                            disabled={commander.toggleCronPending}
                            className={cn(
                              'rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
                              cron.enabled
                                ? 'border-accent-moss/40 text-accent-moss hover:bg-accent-moss/10'
                                : 'border-ink-border text-sumi-diluted hover:bg-ink-wash',
                            )}
                          >
                            {cron.enabled ? '■' : '▶'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteCron(cron.id)}
                            disabled={commander.deleteCronPending}
                            title="Delete cron"
                            className="rounded border border-ink-border p-1 text-sumi-diluted hover:text-accent-vermillion hover:border-accent-vermillion/40 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}

                  {commander.cronsError && (
                    <p className="text-sm text-accent-vermillion">{commander.cronsError}</p>
                  )}
                </div>
              </section>

              <HeartbeatMonitor commander={commander.selectedCommander} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
