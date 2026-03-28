import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Zap,
  Settings2,
  Clock,
  Play,
  History,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
  Save,
  RefreshCw,
  Package,
} from 'lucide-react'
import { fetchJson } from '@/lib/api'
import { cn, timeAgo } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillInfo {
  name: string
  dirName: string
  description: string
  userInvocable: boolean
  argumentHint?: string
  allowedTools?: string
  source: string
  hasConfig: boolean
  configPath: string
}

interface SkillConfig {
  fields: Record<string, string>
  configPath: string
  exists: boolean
  templatePath?: string
}

interface RunHistoryEntry {
  id: string
  status: string
  startedAt: string
  finishedAt?: string
  trigger: string
}

// ---------------------------------------------------------------------------
// Cron presets
// ---------------------------------------------------------------------------

const CRON_PRESETS = [
  { label: 'Every day at 8:00 AM', value: '0 13 * * *', description: '13:00 UTC' },
  { label: 'Every day at 11:00 PM', value: '0 4 * * *', description: '04:00 UTC' },
  { label: 'Every 2 hours', value: '0 */2 * * *', description: '' },
  { label: 'Every 4 hours', value: '0 */4 * * *', description: '' },
  { label: 'Weekdays at 9:00 AM', value: '0 14 * * 1-5', description: '14:00 UTC' },
  { label: 'Weekdays at 6:00 PM', value: '0 23 * * 1-5', description: '23:00 UTC' },
  { label: 'Every Monday at 9:00 AM', value: '0 14 * * 1', description: '14:00 UTC' },
  { label: 'Custom', value: '', description: 'Enter a cron expression' },
] as const

// ---------------------------------------------------------------------------
// Field type inference
// ---------------------------------------------------------------------------

type FieldType = 'email-list' | 'path' | 'boolean' | 'multi-select' | 'number' | 'text'

interface FieldMeta {
  type: FieldType
  label: string
  options?: string[]
}

function inferFieldType(key: string, value: string): FieldMeta {
  const label = key
    .replace(/^BRIEFING_|^DAILY_REVIEW_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())

  const lowerKey = key.toLowerCase()
  const lowerVal = value.toLowerCase()

  // Boolean detection
  if (lowerVal === 'true' || lowerVal === 'false') {
    return { type: 'boolean', label }
  }

  // Email list
  if (lowerKey.includes('email') && lowerKey.includes('account')) {
    return { type: 'email-list', label }
  }
  if (lowerKey.includes('email') && value.includes('@')) {
    return { type: 'email-list', label }
  }

  // Path detection
  if (
    lowerKey.includes('dir') ||
    lowerKey.includes('file') ||
    lowerKey.includes('path') ||
    value.startsWith('$HOME') ||
    value.startsWith('/') ||
    value.startsWith('~')
  ) {
    return { type: 'path', label }
  }

  // Multi-select (comma-separated known section names)
  if (lowerKey.includes('section') || lowerKey.includes('source')) {
    return {
      type: 'multi-select',
      label,
      options: value.split(',').map((s) => s.trim()).filter(Boolean),
    }
  }

  // Number
  if (lowerKey.includes('max') || lowerKey.includes('days') || lowerKey.includes('count')) {
    return { type: 'number', label }
  }

  return { type: 'text', label }
}

// ---------------------------------------------------------------------------
// API hooks
// ---------------------------------------------------------------------------

function useSkillsList() {
  return useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => fetchJson<SkillInfo[]>('/api/skills'),
    staleTime: 30_000,
  })
}

function useSkillConfig(dirName: string | null) {
  return useQuery({
    queryKey: ['skills', 'config', dirName],
    queryFn: () => fetchJson<SkillConfig>(`/api/skills/${dirName}/config`),
    enabled: !!dirName,
    staleTime: 10_000,
  })
}

function useSkillHistory(dirName: string | null) {
  return useQuery({
    queryKey: ['skills', 'history', dirName],
    queryFn: () => fetchJson<RunHistoryEntry[]>(`/api/skills/${dirName}/history`),
    enabled: !!dirName,
    staleTime: 15_000,
  })
}

function useSaveConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ dirName, fields }: { dirName: string; fields: Record<string, string> }) => {
      return fetchJson<SkillConfig>(`/api/skills/${dirName}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      })
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['skills', 'config', vars.dirName] })
      queryClient.invalidateQueries({ queryKey: ['skills', 'list'] })
    },
  })
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'completed' || status === 'success'
      ? 'badge-active'
      : status === 'running' || status === 'in_progress'
        ? 'badge-idle'
        : 'badge-stale'
  return <span className={cn('px-2 py-0.5 rounded text-xs font-medium', cls)}>{status}</span>
}

function SkillListTable({
  skills,
  selectedName,
  onSelect,
}: {
  skills: SkillInfo[]
  selectedName: string | null
  onSelect: (dirName: string) => void
}) {
  return (
    <div className="border border-sumi-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-sumi-surface text-sumi-secondary text-left text-xs uppercase tracking-wider">
            <th className="px-4 py-2.5">Skill</th>
            <th className="px-4 py-2.5 hidden sm:table-cell">Source</th>
            <th className="px-4 py-2.5">Config</th>
            <th className="px-4 py-2.5 hidden sm:table-cell">Invocable</th>
          </tr>
        </thead>
        <tbody>
          {skills.map((skill) => (
            <tr
              key={skill.dirName}
              className={cn(
                'border-t border-sumi-border cursor-pointer transition-colors',
                selectedName === skill.dirName
                  ? 'bg-sumi-highlight'
                  : 'hover:bg-sumi-surface/50',
              )}
              onClick={() => onSelect(skill.dirName)}
            >
              <td className="px-4 py-3">
                <div className="font-medium text-sumi-primary">/{skill.name}</div>
                <div className="text-xs text-sumi-secondary mt-0.5 line-clamp-1">
                  {skill.description}
                </div>
              </td>
              <td className="px-4 py-3 hidden sm:table-cell">
                <span className="text-xs text-sumi-muted bg-sumi-surface px-2 py-0.5 rounded">
                  {skill.source}
                </span>
              </td>
              <td className="px-4 py-3">
                {skill.hasConfig ? (
                  <span className="text-emerald-600 text-xs flex items-center gap-1">
                    <CheckCircle size={12} /> configured
                  </span>
                ) : (
                  <span className="text-sumi-muted text-xs">none</span>
                )}
              </td>
              <td className="px-4 py-3 hidden sm:table-cell">
                {skill.userInvocable ? (
                  <Zap size={14} className="text-amber-500" />
                ) : (
                  <span className="text-sumi-muted text-xs">-</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ConfigField({
  fieldKey,
  value,
  meta,
  onChange,
}: {
  fieldKey: string
  value: string
  meta: FieldMeta
  onChange: (key: string, value: string) => void
}) {
  if (meta.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(fieldKey, e.target.checked ? 'true' : 'false')}
          className="w-4 h-4 rounded border-sumi-border"
        />
        <span className="text-sm text-sumi-primary">{meta.label}</span>
      </label>
    )
  }

  if (meta.type === 'multi-select' && meta.options) {
    const selected = new Set(value.split(',').map((s) => s.trim()).filter(Boolean))
    return (
      <div>
        <label className="block text-xs font-medium text-sumi-secondary mb-1.5">{meta.label}</label>
        <div className="flex flex-wrap gap-2">
          {meta.options.map((opt) => (
            <label
              key={opt}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded border text-sm cursor-pointer transition-colors',
                selected.has(opt)
                  ? 'border-sumi-primary bg-sumi-highlight text-sumi-primary'
                  : 'border-sumi-border text-sumi-secondary hover:bg-sumi-surface',
              )}
            >
              <input
                type="checkbox"
                checked={selected.has(opt)}
                onChange={(e) => {
                  const next = new Set(selected)
                  if (e.target.checked) next.add(opt)
                  else next.delete(opt)
                  onChange(fieldKey, Array.from(next).join(','))
                }}
                className="sr-only"
              />
              {opt}
            </label>
          ))}
        </div>
      </div>
    )
  }

  if (meta.type === 'number') {
    return (
      <div>
        <label className="block text-xs font-medium text-sumi-secondary mb-1.5">{meta.label}</label>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          className="w-full px-3 py-2 rounded border border-sumi-border bg-sumi-bg text-sumi-primary text-sm focus:outline-none focus:border-sumi-primary"
        />
      </div>
    )
  }

  return (
    <div>
      <label className="block text-xs font-medium text-sumi-secondary mb-1.5">{meta.label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(fieldKey, e.target.value)}
        placeholder={meta.type === 'path' ? '/path/to/...' : undefined}
        className="w-full px-3 py-2 rounded border border-sumi-border bg-sumi-bg text-sumi-primary text-sm focus:outline-none focus:border-sumi-primary"
      />
    </div>
  )
}

function CronSchedulePicker({
  cronExpr,
  onCronChange,
}: {
  cronExpr: string
  onCronChange: (expr: string) => void
}) {
  const matchedPreset = CRON_PRESETS.find((p) => p.value === cronExpr)
  const isCustom = !matchedPreset || matchedPreset.label === 'Custom'

  return (
    <div className="border border-sumi-border rounded-lg p-4 bg-sumi-surface/30">
      <div className="flex items-center gap-2 mb-3">
        <Clock size={14} className="text-sumi-secondary" />
        <span className="text-sm font-medium text-sumi-primary">Cron Schedule</span>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-sumi-secondary mb-1.5">
            Schedule Preset
          </label>
          <select
            value={isCustom ? '' : cronExpr}
            onChange={(e) => onCronChange(e.target.value)}
            className="w-full px-3 py-2 rounded border border-sumi-border bg-sumi-bg text-sumi-primary text-sm focus:outline-none focus:border-sumi-primary"
          >
            {CRON_PRESETS.map((preset) => (
              <option key={preset.label} value={preset.value}>
                {preset.label}
                {preset.description ? ` (${preset.description})` : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-sumi-secondary mb-1.5">
            Raw Cron Expression
          </label>
          <input
            type="text"
            value={cronExpr}
            onChange={(e) => onCronChange(e.target.value)}
            placeholder="0 13 * * *"
            className="w-full px-3 py-2 rounded border border-sumi-border bg-sumi-bg text-sumi-primary text-sm font-mono focus:outline-none focus:border-sumi-primary"
          />
          {cronExpr && (
            <div className="text-xs text-sumi-muted mt-1">
              Format: minute hour day-of-month month day-of-week
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function RunHistoryPanel({ dirName }: { dirName: string }) {
  const { data: history, isLoading } = useSkillHistory(dirName)
  const [expanded, setExpanded] = useState(false)

  if (isLoading) {
    return <div className="text-sm text-sumi-muted py-2">Loading history...</div>
  }

  if (!history || history.length === 0) {
    return <div className="text-sm text-sumi-muted py-2">No run history found.</div>
  }

  const displayed = expanded ? history : history.slice(0, 5)

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <History size={14} className="text-sumi-secondary" />
        <span className="text-sm font-medium text-sumi-primary">Run History</span>
      </div>
      <div className="border border-sumi-border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-sumi-surface text-sumi-secondary text-left uppercase tracking-wider">
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Started</th>
              <th className="px-3 py-2 hidden sm:table-cell">Trigger</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((run) => (
              <tr key={run.id} className="border-t border-sumi-border">
                <td className="px-3 py-2">
                  <StatusBadge status={run.status} />
                </td>
                <td className="px-3 py-2 text-sumi-secondary">
                  {run.startedAt ? timeAgo(run.startedAt) : '-'}
                </td>
                <td className="px-3 py-2 text-sumi-muted hidden sm:table-cell">{run.trigger}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {history.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-sumi-secondary hover:text-sumi-primary mt-1.5 flex items-center gap-1"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? 'Show less' : `Show all ${history.length} runs`}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SkillsPage() {
  const { data: skills, isLoading, refetch } = useSkillsList()
  const [selectedDirName, setSelectedDirName] = useState<string | null>(null)
  const { data: config, isLoading: configLoading } = useSkillConfig(selectedDirName)
  const saveConfig = useSaveConfig()

  // Local form state
  const [editedFields, setEditedFields] = useState<Record<string, string>>({})
  const [cronExpr, setCronExpr] = useState('')
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Sync config to local state when loaded
  useEffect(() => {
    if (config?.fields) {
      setEditedFields({ ...config.fields })
    }
  }, [config])

  const selectedSkill = useMemo(
    () => skills?.find((s) => s.dirName === selectedDirName) ?? null,
    [skills, selectedDirName],
  )

  const handleFieldChange = useCallback((key: string, value: string) => {
    setEditedFields((prev) => ({ ...prev, [key]: value }))
    setSaveSuccess(false)
  }, [])

  const handleSave = useCallback(() => {
    if (!selectedDirName) return
    saveConfig.mutate(
      { dirName: selectedDirName, fields: editedFields },
      {
        onSuccess: () => {
          setSaveSuccess(true)
          setTimeout(() => setSaveSuccess(false), 3000)
        },
      },
    )
  }, [selectedDirName, editedFields, saveConfig])

  const isDirty = useMemo(() => {
    if (!config?.fields) return false
    return JSON.stringify(config.fields) !== JSON.stringify(editedFields)
  }, [config, editedFields])

  const fieldMetas = useMemo(() => {
    const metas: Record<string, FieldMeta> = {}
    for (const [key, value] of Object.entries(editedFields)) {
      // Skip internal/private keys
      if (key.startsWith('_')) continue
      metas[key] = inferFieldType(key, value)
    }
    return metas
  }, [editedFields])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Package size={20} className="text-sumi-secondary" />
          <div>
            <h1 className="text-lg font-semibold text-sumi-primary">Skills & Cron</h1>
            <p className="text-xs text-sumi-secondary">
              {skills?.length ?? 0} skills installed
            </p>
          </div>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-sumi-secondary border border-sumi-border rounded hover:bg-sumi-surface transition-colors"
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Skill list */}
        <div className="lg:col-span-1">
          <SkillListTable
            skills={skills ?? []}
            selectedName={selectedDirName}
            onSelect={setSelectedDirName}
          />
        </div>

        {/* Config editor + history */}
        <div className="lg:col-span-2 space-y-4">
          {!selectedSkill ? (
            <div className="border border-sumi-border rounded-lg p-8 text-center text-sumi-muted text-sm">
              Select a skill from the list to view its configuration.
            </div>
          ) : (
            <>
              {/* Skill header */}
              <div className="border border-sumi-border rounded-lg p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-sumi-primary flex items-center gap-2">
                      <Settings2 size={16} />
                      /{selectedSkill.name}
                    </h2>
                    <p className="text-sm text-sumi-secondary mt-1">
                      {selectedSkill.description}
                    </p>
                    {selectedSkill.argumentHint && (
                      <p className="text-xs text-sumi-muted mt-1 font-mono">
                        Usage: /{selectedSkill.name} {selectedSkill.argumentHint}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {selectedSkill.userInvocable && (
                      <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-200">
                        user-invocable
                      </span>
                    )}
                    <span className="text-xs bg-sumi-surface text-sumi-secondary px-2 py-0.5 rounded">
                      {selectedSkill.source}
                    </span>
                  </div>
                </div>
              </div>

              {/* Config form */}
              {configLoading ? (
                <div className="border border-sumi-border rounded-lg p-4 text-sm text-sumi-muted">
                  Loading configuration...
                </div>
              ) : Object.keys(editedFields).length === 0 ? (
                <div className="border border-sumi-border rounded-lg p-4 text-sm text-sumi-muted">
                  No configuration fields found for this skill.
                </div>
              ) : (
                <div className="border border-sumi-border rounded-lg p-4 space-y-4">
                  <h3 className="text-sm font-medium text-sumi-primary flex items-center gap-2">
                    <Settings2 size={14} />
                    Configuration
                  </h3>

                  <div className="space-y-4">
                    {Object.entries(fieldMetas).map(([key, meta]) => (
                      <ConfigField
                        key={key}
                        fieldKey={key}
                        value={editedFields[key] ?? ''}
                        meta={meta}
                        onChange={handleFieldChange}
                      />
                    ))}
                  </div>

                  {config?.configPath && (
                    <div className="text-xs text-sumi-muted pt-2 border-t border-sumi-border">
                      Config file: {config.configPath}
                      {!config.exists && ' (will be created on save)'}
                    </div>
                  )}
                </div>
              )}

              {/* Cron schedule */}
              <CronSchedulePicker cronExpr={cronExpr} onCronChange={setCronExpr} />

              {/* Action buttons */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSave}
                  disabled={saveConfig.isPending || (!isDirty && !cronExpr)}
                  className={cn(
                    'flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium transition-colors',
                    isDirty || cronExpr
                      ? 'bg-sumi-primary text-white hover:bg-sumi-primary/90'
                      : 'bg-sumi-surface text-sumi-muted cursor-not-allowed',
                  )}
                >
                  <Save size={14} />
                  {saveConfig.isPending ? 'Saving...' : 'Save Config'}
                </button>

                <button
                  disabled
                  title="Run Now — triggers skill execution via Hammurabi cron"
                  className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium bg-sumi-surface text-sumi-secondary border border-sumi-border hover:bg-sumi-highlight transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play size={14} />
                  Run Now
                </button>

                {saveSuccess && (
                  <span className="text-xs text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={12} /> Saved successfully
                  </span>
                )}
                {saveConfig.isError && (
                  <span className="text-xs text-red-600 flex items-center gap-1">
                    <XCircle size={12} /> {String(saveConfig.error)}
                  </span>
                )}
              </div>

              {/* Run history */}
              <RunHistoryPanel dirName={selectedSkill.dirName} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
