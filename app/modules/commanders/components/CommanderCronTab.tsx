import { type FormEvent, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CommanderSession, CommanderCronTask } from '../hooks/useCommander'

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'pending'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'pending'
  return parsed.toLocaleString()
}

export function CommanderCronTab({
  commander,
  crons,
  cronsLoading,
  cronsError,
  addCron,
  addCronPending,
  toggleCron,
  toggleCronPending,
  deleteCron,
  deleteCronPending,
}: {
  commander: CommanderSession
  crons: CommanderCronTask[]
  cronsLoading: boolean
  cronsError: string | null
  addCron: (input: { commanderId: string; schedule: string; instruction: string }) => Promise<void>
  addCronPending: boolean
  toggleCron: (input: { commanderId: string; cronId: string; enabled: boolean }) => Promise<void>
  toggleCronPending: boolean
  deleteCron: (input: { commanderId: string; cronId: string }) => Promise<void>
  deleteCronPending: boolean
}) {
  const [showForm, setShowForm] = useState(false)
  const [cronSchedule, setCronSchedule] = useState('')
  const [cronInstruction, setCronInstruction] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  async function handleAddCron(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const schedule = cronSchedule.trim()
    const instruction = cronInstruction.trim()
    if (!schedule || !instruction) {
      setFormError('Schedule and instruction are required.')
      return
    }
    setFormError(null)
    try {
      await addCron({ commanderId: commander.id, schedule, instruction })
      setCronSchedule('')
      setCronInstruction('')
      setShowForm(false)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Failed to add cron')
    }
  }

  async function handleToggle(cronId: string, enabled: boolean): Promise<void> {
    await toggleCron({ commanderId: commander.id, cronId, enabled: !enabled })
  }

  async function handleDelete(cronId: string): Promise<void> {
    await deleteCron({ commanderId: commander.id, cronId })
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 md:px-6 py-3 border-b border-ink-border flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-sumi-diluted">
          {crons.length} scheduled run{crons.length !== 1 ? 's' : ''}
        </span>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="btn-ghost !px-3 !py-1.5 text-xs inline-flex items-center gap-1.5"
        >
          <Plus size={12} />
          {showForm ? 'Close' : 'Add Task'}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {showForm && (
          <form
            onSubmit={(e) => void handleAddCron(e)}
            className="rounded-lg border border-dashed border-ink-border p-3 space-y-2"
          >
            <div>
              <label className="section-title block mb-1">Schedule</label>
              <input
                value={cronSchedule}
                onChange={(e) => setCronSchedule(e.target.value)}
                placeholder="*/15 * * * *"
                className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
              />
            </div>
            <div>
              <label className="section-title block mb-1">Instruction</label>
              <textarea
                value={cronInstruction}
                onChange={(e) => setCronInstruction(e.target.value)}
                placeholder="Check your quest board and pick up pending quests."
                className="w-full min-h-16 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
              />
            </div>
            {formError && (
              <p className="text-xs text-accent-vermillion">{formError}</p>
            )}
            <button
              type="submit"
              disabled={addCronPending}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              <Plus size={14} />
              {addCronPending ? 'Adding...' : 'Add Cron'}
            </button>
          </form>
        )}

        {cronsLoading && crons.length === 0 && (
          <div className="flex items-center justify-center h-20">
            <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
          </div>
        )}

        {!cronsLoading && crons.length === 0 && !cronsError && !showForm && (
          <p className="text-sm text-sumi-diluted">No scheduled runs. Add one to automate this commander.</p>
        )}

        {crons.map((cron) => (
          <div
            key={cron.id}
            className="rounded-lg border border-ink-border bg-washi-white px-3 py-2.5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'inline-block h-1.5 w-1.5 rounded-full shrink-0',
                      cron.enabled ? 'bg-accent-moss' : 'bg-sumi-mist',
                    )}
                  />
                  <p className="font-mono text-sm text-sumi-black truncate">{cron.schedule}</p>
                </div>
                <p className="text-sm text-sumi-gray mt-1 line-clamp-2 pl-3.5">{cron.instruction}</p>
                {(cron.agentType || cron.permissionMode) && (
                  <p className="text-whisper text-sumi-diluted mt-1 truncate pl-3.5">
                    {[cron.agentType, cron.permissionMode].filter(Boolean).join(' · ')}
                  </p>
                )}
                <p className="text-whisper text-sumi-mist mt-1 pl-3.5">
                  next: {formatDateTime(cron.nextRun)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleToggle(cron.id, cron.enabled)}
                  disabled={toggleCronPending}
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
                  onClick={() => void handleDelete(cron.id)}
                  disabled={deleteCronPending}
                  title="Delete cron"
                  className="rounded border border-ink-border p-1 text-sumi-diluted hover:text-accent-vermillion hover:border-accent-vermillion/40 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          </div>
        ))}

        {cronsError && (
          <p className="text-sm text-accent-vermillion">{cronsError}</p>
        )}
      </div>
    </div>
  )
}
