import { type FormEvent, useMemo, useState } from 'react'
import { AlertTriangle, Plus } from 'lucide-react'
import { ScheduleExpressionField } from '../../components/ScheduleExpressionField'
import type { CreateSentinelInput } from '../types'
import type { SkillOption } from '../hooks/useSentinels'

type SentinelCreateFormInput = Omit<CreateSentinelInput, 'parentCommanderId'>

interface SentinelCreateFormProps {
  skillOptions: SkillOption[]
  isSubmitting: boolean
  error: string | null
  onSubmit: (input: SentinelCreateFormInput) => Promise<unknown>
  onCancel: () => void
}

export function SentinelCreateForm({
  skillOptions,
  isSubmitting,
  error,
  onSubmit,
  onCancel,
}: SentinelCreateFormProps) {
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('')
  const [instruction, setInstruction] = useState('')
  const [skills, setSkills] = useState<string[]>([])
  const [seedMemory, setSeedMemory] = useState('')
  const [maxRuns, setMaxRuns] = useState('')
  const [agentType, setAgentType] = useState<'claude' | 'codex' | 'gemini'>('claude')
  const [permissionMode, setPermissionMode] = useState<'default' | 'acceptEdits' | 'dangerouslySkipPermissions'>('acceptEdits')
  const [formError, setFormError] = useState<string | null>(null)

  const sortedSkillOptions = useMemo(
    () => [...skillOptions].sort((left, right) => left.label.localeCompare(right.label)),
    [skillOptions],
  )

  const handleSkillSelection = (next: HTMLSelectElement): void => {
    const values = Array.from(next.selectedOptions)
      .map((option) => option.value)
      .filter((value) => value.trim().length > 0)
    setSkills(values)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    const trimmedName = name.trim()
    const trimmedSchedule = schedule.trim()
    const trimmedInstruction = instruction.trim()

    if (!trimmedName || !trimmedSchedule || !trimmedInstruction) {
      setFormError('Name, schedule, and instruction are required.')
      return
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
      setFormError('Name can only contain letters, numbers, underscores, and hyphens.')
      return
    }

    const parsedMaxRuns = maxRuns.trim().length > 0
      ? Number.parseInt(maxRuns.trim(), 10)
      : undefined
    if (parsedMaxRuns !== undefined && (!Number.isInteger(parsedMaxRuns) || parsedMaxRuns <= 0)) {
      setFormError('max-runs must be a positive integer.')
      return
    }

    setFormError(null)

    try {
      await onSubmit({
        name: trimmedName,
        schedule: trimmedSchedule,
        instruction: trimmedInstruction,
        skills,
        seedMemory: seedMemory.trim(),
        ...(parsedMaxRuns ? { maxRuns: parsedMaxRuns } : {}),
        agentType,
        permissionMode,
      })

      setName('')
      setSchedule('')
      setInstruction('')
      setSkills([])
      setSeedMemory('')
      setMaxRuns('')
      setAgentType('claude')
      setPermissionMode('acceptEdits')
      onCancel()
    } catch {
      // Error is surfaced by hook state.
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-3">
      <div>
        <label className="section-title block mb-2">Name</label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          placeholder="dispute-followup"
          required
          pattern="[a-zA-Z0-9_\-]+"
          title="Alphanumeric, underscore, and hyphen only"
        />
      </div>

      <ScheduleExpressionField
        schedule={schedule}
        onScheduleChange={setSchedule}
      />

      <div>
        <label className="section-title block mb-2">Instruction</label>
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          className="w-full min-h-24 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          placeholder="Check thread status, follow up if needed, and summarize updates."
          required
        />
      </div>

      <div>
        <label className="section-title block mb-2">Skills</label>
        <select
          multiple
          value={skills}
          onChange={(event) => handleSkillSelection(event.target)}
          className="w-full min-h-24 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
        >
          {sortedSkillOptions.length === 0 && (
            <option value="" disabled>No skills available</option>
          )}
          {sortedSkillOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-whisper text-sumi-mist">
          Hold Ctrl/Cmd to select multiple skills.
        </p>
      </div>

      <div>
        <label className="section-title block mb-2">Seed Memory</label>
        <textarea
          value={seedMemory}
          onChange={(event) => setSeedMemory(event.target.value)}
          className="w-full min-h-24 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          placeholder="Context this sentinel should remember across runs."
        />
      </div>

      <div>
        <label className="section-title block mb-2">Max Runs (Optional)</label>
        <input
          value={maxRuns}
          onChange={(event) => setMaxRuns(event.target.value)}
          type="number"
          min={1}
          step={1}
          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          placeholder="15"
        />
      </div>

      <div>
        <label className="section-title block mb-2">Agent Type</label>
        <select
          value={agentType}
          onChange={(event) => setAgentType(event.target.value as 'claude' | 'codex' | 'gemini')}
          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          required
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="gemini">Gemini</option>
        </select>
      </div>

      <div>
        <label className="section-title block mb-2">Permission Mode</label>
        <select
          value={permissionMode}
          onChange={(event) => setPermissionMode(event.target.value as 'default' | 'acceptEdits' | 'dangerouslySkipPermissions')}
          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          required
        >
          <option value="default">default</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="dangerouslySkipPermissions">dangerouslySkipPermissions</option>
        </select>
      </div>

      {(formError || error) && (
        <div className="flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
          <AlertTriangle size={15} className="mt-0.5" />
          <span>{formError ?? error}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={isSubmitting}
          className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          <Plus size={14} />
          {isSubmitting ? 'Creating...' : 'Create Sentinel'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn-ghost"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
