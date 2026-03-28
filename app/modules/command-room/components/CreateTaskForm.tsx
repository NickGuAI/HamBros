import { type FormEvent, useState } from 'react'
import { useSkills } from '@/hooks/use-skills'
import type { AgentType, ClaudePermissionMode, Machine, SessionType } from '@/types'
import type { CommandRoomAgentType, CreateCronTaskInput } from '../hooks/useCommandRoom'
import { NewSessionForm } from '../../agents/components/NewSessionForm'

function detectBrowserTimezone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return resolved && resolved.trim().length > 0 ? resolved : 'UTC'
}

function listIanaTimezones(): string[] {
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf
  if (typeof supportedValuesOf !== 'function') {
    return []
  }

  try {
    return supportedValuesOf('timeZone')
  } catch {
    return []
  }
}

const TIMEZONE_OPTIONS = listIanaTimezones()

function prependSkillInvocation(instruction: string, skillName: string): string {
  const command = `/${skillName}`
  const trimmed = instruction.trim()
  if (trimmed === command || trimmed.startsWith(`${command} `)) {
    return trimmed
  }
  if (trimmed.length === 0) {
    return `${command} `
  }
  return `${command} ${trimmed}`
}

interface CreateTaskFormProps {
  onCreate: (input: CreateCronTaskInput) => Promise<unknown>
  onClose: () => void
  machines: Machine[]
  createPending: boolean
}

export function CreateTaskForm({ onCreate, onClose, machines, createPending }: CreateTaskFormProps) {
  const { data: skills, isLoading: skillsLoading } = useSkills()
  const skillList = skills ?? []

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [schedule, setSchedule] = useState('')
  const [cwd, setCwd] = useState('')
  const [mode, setMode] = useState<ClaudePermissionMode>('acceptEdits')
  const [task, setTask] = useState('')
  const [timezone, setTimezone] = useState(() => detectBrowserTimezone())
  const [agentType, setAgentType] = useState<AgentType>('claude')
  const [sessionType, setSessionType] = useState<SessionType>('stream')
  const [selectedHost, setSelectedHost] = useState('')
  const [selectedSkill, setSelectedSkill] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const activeSkill = skillList.find((s) => s.name === selectedSkill) ?? null

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreateError(null)
    try {
      const createInput: CreateCronTaskInput & { description?: string } = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        schedule: schedule.trim(),
        timezone: timezone.trim() || undefined,
        machine: selectedHost,
        workDir: cwd.trim(),
        agentType: agentType as CommandRoomAgentType,
        instruction: task.trim(),
        enabled: true,
        permissionMode: mode,
        sessionType,
      }
      await onCreate(createInput)
      setName('')
      setDescription('')
      setSchedule('')
      setTimezone(detectBrowserTimezone())
      setCwd('')
      setMode('acceptEdits')
      setTask('')
      setAgentType('claude')
      setSessionType('stream')
      setSelectedHost('')
      setSelectedSkill('')
      onClose()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create task')
    }
  }

  return (
    <div>
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
        machines={machines}
        selectedHost={selectedHost}
        setSelectedHost={setSelectedHost}
        openclawAgentId=""
        setOpenclawAgentId={() => {}}
        isCreating={createPending}
        createError={createError}
        onSubmit={(e) => void handleSubmit(e)}
        schedule={schedule}
        setSchedule={setSchedule}
        submitLabel="Create Task"
        nameLabel="Task Name"
        namePlaceholder="nightly-deploy"
        namePattern=""
        taskLabel="Instruction"
        taskPlaceholder="Run the nightly test suite and report results"
        taskRequired
        beforeTaskField={
          <div className="space-y-3">
            <div>
              <label className="section-title block mb-2">Description (Optional)</label>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="w-full min-h-20 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                placeholder="Explain what this cron task is for"
              />
            </div>
            {agentType === 'claude' ? (
              <div>
                <label className="section-title block mb-2">Skill (Optional)</label>
                <select
                  value={selectedSkill}
                  onChange={(event) => {
                    const skillName = event.target.value
                    setSelectedSkill(skillName)
                    if (skillName) {
                      setTask((current) => prependSkillInvocation(current, skillName))
                    }
                  }}
                  className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                >
                  <option value="">
                    {skillsLoading
                      ? 'Loading skills...'
                      : skillList.length > 0
                        ? '— Select a skill —'
                        : 'No user-invocable skills installed'}
                  </option>
                  {skillList.map((skill) => (
                    <option key={skill.name} value={skill.name}>
                      /{skill.name}
                    </option>
                  ))}
                </select>
                {activeSkill ? (
                  <div className="mt-2 rounded-lg border border-ink-border bg-washi-aged/60 px-3 py-2.5 space-y-1.5">
                    <p className="text-sm text-sumi-gray">{activeSkill.description}</p>
                    {activeSkill.argumentHint ? (
                      <p className="font-mono text-xs text-sumi-diluted">
                        Usage: /{activeSkill.name} {activeSkill.argumentHint}
                      </p>
                    ) : (
                      <p className="text-xs text-sumi-mist">No parameters required.</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-1 text-whisper text-sumi-mist">
                    Select a skill to see its parameters and prepend it to the instruction.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        }
      />
      <div className="mt-3">
        <label className="section-title block mb-2">Timezone</label>
        {TIMEZONE_OPTIONS.length > 0 ? (
          <select
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          >
            {!TIMEZONE_OPTIONS.includes(timezone) && timezone ? (
              <option value={timezone}>{timezone}</option>
            ) : null}
            <option value="">Server default</option>
            {TIMEZONE_OPTIONS.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
            placeholder="America/Los_Angeles"
          />
        )}
        <p className="mt-1 text-whisper text-sumi-mist">Defaults to your browser timezone</p>
      </div>
    </div>
  )
}
