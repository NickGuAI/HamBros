import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import {
  ArrowLeft,
  CalendarClock,
  Clock3,
  FileText,
  MessageSquarePlus,
  MoreHorizontal,
  Newspaper,
  Play,
  Plus,
  Search,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import { cn, formatCost, timeAgo } from '@/lib/utils'
import { useMachines } from '@/hooks/use-agents'
import { useProviderRegistry } from '@/hooks/use-providers'
import type { AgentType, ProviderModelOption, ProviderRegistryEntry } from '@/types'
import { ModalFormContainer } from '../../components/ModalFormContainer'
import { buildGaiaCreateAutomationPrompt } from '@modules/command-room/gaia-entry-prompts'
import { openGaiaConversationWithDraft } from '@modules/command-room/gaia-launch'
import { describeAutomationSchedule } from './automation-schedule'
import {
  useAutomationHistory,
  useAutomationRunDetail,
  useAutomations,
  type CreateAutomationPresetInput,
  type AutomationListItem,
  type AutomationScope,
  type AutomationTriggerFilter,
} from '../../automations/hooks/useAutomations'
import type { AutomationHistoryEntry } from '../../automations/types'
import { SentinelCreateForm } from '../../automations/components/SentinelCreateForm'
import {
  isAutomationCronExpressionComplete,
  splitAutomationCronExpressionFields,
} from '../../automations/cron-validation'
import { TIMEZONE_OPTIONS } from '../../automations/timezones'
import { CreateAutomationTaskForm } from './CreateAutomationTaskForm'

type CreateMode = null | 'chooser' | 'task' | 'monitor'
type AutomationStatusFilter = 'all' | 'active' | 'paused'

export type AutomationPanelScope =
  | {
      kind: 'global'
    }
  | {
      kind: 'commander'
      commander: {
        id: string
        displayName?: string | null
        host?: string | null
      }
    }

interface AutomationPanelProps {
  scope: AutomationPanelScope
  filter?: AutomationTriggerFilter
  onFilterChange?: (filter: AutomationTriggerFilter) => void
  preselectedSkillName?: string | null
  onPreselectedSkillConsumed?: () => void
  presentation?: 'default' | 'mobile-list' | 'single-pane'
  mobileControls?: ReactNode
}

const FILTER_OPTIONS: Array<{ value: AutomationTriggerFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'quest', label: 'Quest' },
  { value: 'manual', label: 'Manual' },
]

const STATUS_FILTER_OPTIONS: Array<{ value: AutomationStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
]

const AUTOMATION_DETAIL_MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-sumi-gray transition-colors hover:bg-ink-wash hover:text-sumi-black disabled:cursor-not-allowed disabled:opacity-60'

const AUTOMATION_PRESETS: Array<{
  id: string
  label: string
  description: string
  icon: typeof FileText
  seed: CreateAutomationPresetInput
}> = [
  {
    id: 'research-report',
    label: 'Research Report',
    description: 'Weekly research brief with findings, sources, and recommended next steps.',
    icon: FileText,
    seed: {
      templateId: 'automation-catalog:research-report',
      name: 'Weekly research report',
      trigger: 'schedule',
      schedule: '0 9 * * 1',
      timezone: 'America/New_York',
      description: 'Generate a weekly research report with source-backed findings.',
      instruction: [
        'Create a concise weekly research report for the configured topic.',
        'Search current sources, summarize the most important findings, cite source URLs, and write the markdown report to the run report path.',
        'End with the required JSON summary block.',
      ].join('\n'),
      seedMemory: 'Topic: replace this with the research area to monitor.\nAudience: operator.',
    },
  },
  {
    id: 'journal-pubmed-watch',
    label: 'Journal / PubMed Watch',
    description: 'Daily literature watch that tracks new papers and summarizes relevance.',
    icon: Newspaper,
    seed: {
      templateId: 'automation-catalog:journal-pubmed-watch',
      name: 'Journal and PubMed watch',
      trigger: 'schedule',
      schedule: '0 8 * * *',
      timezone: 'America/New_York',
      description: 'Watch PubMed and journal feeds for new relevant papers.',
      instruction: [
        'Check PubMed and relevant journal feeds for new papers matching the configured query.',
        'Summarize new papers, explain why each matters, note methods or limitations, and write the markdown report to the run report path.',
        'End with the required JSON summary block.',
      ].join('\n'),
      seedMemory: 'PubMed query: artificial intelligence OR machine learning.\nJournals: Nature, Science, NEJM, arXiv cs.AI.',
    },
  },
  {
    id: 'portfolio-tracking',
    label: 'Portfolio Tracking',
    description: 'Weekday market close snapshot with notable moves and risks.',
    icon: TrendingUp,
    seed: {
      templateId: 'automation-catalog:portfolio-tracking',
      name: 'Portfolio tracking',
      trigger: 'schedule',
      schedule: '0 16 * * 1-5',
      timezone: 'America/New_York',
      description: 'Track portfolio and market movement after each weekday close.',
      instruction: [
        'Review market movement for the configured tickers and major benchmarks.',
        'Summarize notable moves, relevant news, risk flags, and suggested follow-up checks, then write the markdown report to the run report path.',
        'End with the required JSON summary block.',
      ].join('\n'),
      seedMemory: 'Tickers: SPY, QQQ, BTC-USD, ETH-USD.\nBenchmarks: S&P 500, Nasdaq 100, 10Y Treasury.',
    },
  },
]

interface AutomationProviderOption {
  id: AgentType
  label: string
  availableModels: ProviderModelOption[]
  defaults: ProviderRegistryEntry['defaults']
}

function toAutomationScope(scope: AutomationPanelScope): AutomationScope {
  if (scope.kind === 'global') {
    return { kind: 'global' }
  }

  return {
    kind: 'commander',
    commanderId: scope.commander.id,
  }
}

function statusBadgeClass(status: AutomationListItem['status']): string {
  if (status === 'active') {
    return 'badge-active'
  }
  if (status === 'paused') {
    return 'badge-idle'
  }
  if (status === 'cancelled') {
    return 'badge-error'
  }
  return 'badge-completed'
}

function statusSymbol(status: AutomationListItem['status']): string {
  if (status === 'active') {
    return '●'
  }
  if (status === 'paused') {
    return '◐'
  }
  if (status === 'cancelled') {
    return '✗'
  }
  return '✓'
}

function describeTrigger(automation: AutomationListItem): string {
  if (automation.trigger === 'schedule') {
    return [
      automation.schedule ?? 'No schedule configured',
      automation.timezone ? `(${automation.timezone})` : null,
    ].filter(Boolean).join(' ')
  }

  if (automation.trigger === 'quest') {
    const commanderScope = automation.questTrigger?.commanderId
      ? `commander ${automation.questTrigger.commanderId}`
      : 'any commander'
    return `Quest completed by ${commanderScope}`
  }

  return 'Manual trigger only'
}

function describeScheduleForList(automation: AutomationListItem): string {
  if (automation.trigger === 'quest') {
    return 'On quest completion'
  }
  if (automation.trigger === 'manual') {
    return 'Manual'
  }

  const expression = automation.schedule?.trim()
  if (!expression) {
    return 'No schedule configured'
  }

  return describeAutomationSchedule(expression)
}

function statusListLabel(status: AutomationListItem['status']): string | null {
  if (status === 'paused') {
    return 'Paused'
  }
  if (status === 'completed') {
    return 'Completed'
  }
  if (status === 'cancelled') {
    return 'Cancelled'
  }
  return null
}

function nextRunListLabel(automation: AutomationListItem): string | null {
  const statusLabel = statusListLabel(automation.status)
  if (statusLabel) {
    return statusLabel
  }
  if (!automation.nextRun) {
    if (automation.trigger !== 'schedule') {
      return null
    }
    return 'No next run scheduled'
  }

  const nextRunMs = new Date(automation.nextRun).getTime()
  if (!Number.isFinite(nextRunMs)) {
    return automation.trigger === 'schedule' ? 'No next run scheduled' : null
  }

  const diffMs = nextRunMs - Date.now()
  if (diffMs <= 0) {
    return 'Next run due'
  }

  const minutes = Math.max(1, Math.round(diffMs / 60_000))
  if (minutes < 60) {
    return `Next run in ${minutes}m`
  }

  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `Next run in ${hours}h`
  }

  const days = Math.round(hours / 24)
  return `Next run in ${days}d`
}

function mobileToggleAriaLabel(automation: AutomationListItem): string {
  if (automation.status === 'active') {
    return `Pause ${automation.name}`
  }
  if (automation.status === 'paused') {
    return `Resume ${automation.name}`
  }
  return `${statusListLabel(automation.status) ?? automation.status} ${automation.name}`
}

function classifyAutomation(automation: AutomationListItem): 'run' | 'monitor' {
  if (automation.trigger !== 'schedule') {
    return 'monitor'
  }
  if ((automation.skills?.length ?? 0) > 0) {
    return 'monitor'
  }
  if ((automation.observations?.length ?? 0) > 0) {
    return 'monitor'
  }
  if ((automation.seedMemory ?? '').trim().length > 0) {
    return 'monitor'
  }
  if (automation.maxRuns) {
    return 'monitor'
  }
  return 'run'
}

function runsLabel(automation: AutomationListItem): string {
  const totalRuns = automation.totalRuns ?? 0
  if (automation.maxRuns) {
    return `${totalRuns}/${automation.maxRuns} runs`
  }
  if (totalRuns === 1) {
    return '1 run'
  }
  return `${totalRuns} runs`
}

function lastRunSummary(automation: AutomationListItem): string {
  const latest = automation.history?.[0]
  if (!latest || !automation.lastRun) {
    return 'Last: no runs yet'
  }

  const action = latest.action.trim().length > 0 ? latest.action.trim() : 'run finished'
  return `Last: "${action}" - ${timeAgo(automation.lastRun)} - ${formatCost(latest.costUsd)}`
}

function filterItems(items: AutomationListItem[], filter: AutomationTriggerFilter): AutomationListItem[] {
  if (filter === 'all') {
    return items
  }

  return items.filter((item) => item.trigger === filter)
}

function filterByStatus(items: AutomationListItem[], filter: AutomationStatusFilter): AutomationListItem[] {
  if (filter === 'all') {
    return items
  }

  return items.filter((item) => item.status === filter)
}

function filterBySearch(items: AutomationListItem[], query: string): AutomationListItem[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return items
  }

  return items.filter((item) => {
    const haystack = [
      item.name,
      item.description ?? '',
      item.instruction,
      item.schedule ?? '',
      item.skills?.join(' ') ?? '',
      item.observations?.join(' ') ?? '',
    ].join(' ').toLowerCase()
    return haystack.includes(normalizedQuery)
  })
}

function parseEditableSchedule(expression: string | null | undefined): {
  mode: 'preset' | 'raw'
  cadence: 'every-15-minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly'
  minute: string
  time: string
  weekday: string
  raw: string
} {
  const raw = expression?.trim() ?? ''
  const parts = splitAutomationCronExpressionFields(raw)
  const fallback = {
    mode: 'raw' as const,
    cadence: 'daily' as const,
    minute: '0',
    time: '09:00',
    weekday: '1',
    raw,
  }

  if (raw === '*/15 * * * *') {
    return { ...fallback, mode: 'preset', cadence: 'every-15-minutes' }
  }

  if (parts.length !== 5) {
    return fallback
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return fallback
  }

  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && ['0', '15', '30', '45'].includes(minute)) {
    return { ...fallback, mode: 'preset', cadence: 'hourly', minute }
  }

  if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute) || dayOfMonth !== '*' || month !== '*') {
    return fallback
  }

  const hourNumber = Number(hour)
  const minuteNumber = Number(minute)
  if (hourNumber < 0 || hourNumber > 23 || minuteNumber < 0 || minuteNumber > 59) {
    return fallback
  }

  const time = `${String(hourNumber).padStart(2, '0')}:${String(minuteNumber).padStart(2, '0')}`
  if (dayOfWeek === '*') {
    return { ...fallback, mode: 'preset', cadence: 'daily', minute, time }
  }
  if (dayOfWeek === '1-5') {
    return { ...fallback, mode: 'preset', cadence: 'weekdays', minute, time }
  }
  if (/^[0-7]$/.test(dayOfWeek)) {
    return {
      ...fallback,
      mode: 'preset',
      cadence: 'weekly',
      minute,
      time,
      weekday: dayOfWeek === '7' ? '0' : dayOfWeek,
    }
  }

  return fallback
}

function buildEditableSchedule(state: ReturnType<typeof parseEditableSchedule>): string {
  if (state.mode === 'raw') {
    return state.raw.trim()
  }

  if (state.cadence === 'every-15-minutes') {
    return '*/15 * * * *'
  }
  if (state.cadence === 'hourly') {
    return `${state.minute} * * * *`
  }

  const [hour = '09', minute = '00'] = state.time.split(':')
  if (state.cadence === 'daily') {
    return `${minute} ${hour} * * *`
  }
  if (state.cadence === 'weekdays') {
    return `${minute} ${hour} * * 1-5`
  }
  return `${minute} ${hour} * * ${state.weekday}`
}

function buildRawScheduleSeed(state: ReturnType<typeof parseEditableSchedule>): string {
  if (state.mode === 'raw') {
    return state.raw
  }

  if (state.cadence === 'every-15-minutes') {
    return '*/15 * * * *'
  }
  if (state.cadence === 'hourly') {
    return `${Number(state.minute)} * * * *`
  }

  const [hour = '09', minute = '00'] = state.time.split(':')
  const minuteField = String(Number(minute))
  const hourField = String(Number(hour))
  if (state.cadence === 'daily') {
    return `${minuteField} ${hourField} * * *`
  }
  if (state.cadence === 'weekdays') {
    return `${minuteField} ${hourField} * * 1-5`
  }
  return `${minuteField} ${hourField} * * ${state.weekday}`
}

function resolveHistoryRunKey(entry: AutomationHistoryEntry): string | null {
  if (entry.runKey?.trim()) {
    return entry.runKey.trim()
  }
  if (entry.runFile?.trim()) {
    const fileName = entry.runFile.trim().split(/[\\/]/).pop()
    const runKey = fileName?.replace(/\.(md|json)$/i, '').trim()
    return runKey || null
  }
  return entry.timestamp.trim() ? entry.timestamp.replace(/[:.]/g, '-') : null
}

function isEmptyOutputFallback(entry: AutomationHistoryEntry): boolean {
  return entry.action === 'Run completed without final output' || entry.action === 'No summary generated'
}

function resolveDefaultModel(provider: AutomationProviderOption | null | undefined): string | null {
  return provider?.defaults.model
    ?? provider?.availableModels.find((model) => model.default)?.id
    ?? null
}

function providerLabel(provider: AutomationProviderOption | null | undefined, providerId: string): string {
  return provider?.label ?? providerId
}

function listAutomationProviders(
  providers: readonly ProviderRegistryEntry[],
  currentProviderId: AgentType,
): AutomationProviderOption[] {
  const options = providers
    .filter((provider) => provider.capabilities.supportsAutomation)
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      availableModels: provider.availableModels,
      defaults: provider.defaults,
    }))

  if (!options.some((provider) => provider.id === currentProviderId)) {
    options.push({
      id: currentProviderId,
      label: currentProviderId,
      availableModels: [],
      defaults: {
        transportType: 'stream',
        permissionMode: 'default',
        model: null,
      },
    })
  }

  return options
}

function emptyMessage(scope: AutomationPanelScope, filter: AutomationTriggerFilter): string {
  if (filter === 'quest') {
    return 'No quest-triggered automations yet.'
  }
  if (filter === 'manual') {
    return 'No manual-trigger automations yet.'
  }
  if (scope.kind === 'global') {
    return 'No global automations yet. Add one to automate unattached workflows.'
  }
  return 'No automations configured for this commander yet.'
}

function filteredEmptyMessage(
  scope: AutomationPanelScope,
  triggerFilter: AutomationTriggerFilter,
  statusFilter: AutomationStatusFilter,
  searchQuery: string,
): string {
  if (searchQuery.trim()) {
    return 'No automations match your search.'
  }
  if (statusFilter !== 'all') {
    return `No ${statusFilter} automations match this view.`
  }
  return emptyMessage(scope, triggerFilter)
}

type AutomationState = ReturnType<typeof useAutomations>

type EditableScheduleState = ReturnType<typeof parseEditableSchedule>

interface AutomationDetailDraft {
  automationId: string
  workDir: string
  maxRuns: string
  seedMemory: string
  timezone: string
  schedule: EditableScheduleState
}

function createAutomationDetailDraft(automation: AutomationListItem): AutomationDetailDraft {
  return {
    automationId: automation.id,
    workDir: automation.workDir ?? '',
    maxRuns: automation.maxRuns === undefined || automation.maxRuns === null ? '' : String(automation.maxRuns),
    seedMemory: automation.seedMemory ?? '',
    timezone: automation.timezone ?? 'UTC',
    schedule: parseEditableSchedule(automation.schedule),
  }
}

function isCompleteTimeValue(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) {
    return false
  }

  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
}

function RuntimeField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="text-whisper uppercase tracking-wide text-sumi-diluted">{label}</span>
      {children}
    </label>
  )
}

function AutomationDetailPanel({
  automation,
  automationState,
  machines,
  onBack,
  onClose,
  compact = false,
  responsiveNavigation = false,
}: {
  automation: AutomationListItem | null
  automationState: AutomationState
  machines: NonNullable<ReturnType<typeof useMachines>['data']>
  onBack?: () => void
  onClose?: () => void
  compact?: boolean
  responsiveNavigation?: boolean
}) {
  const [newObservation, setNewObservation] = useState('')
  const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null)
  const [detailDraft, setDetailDraft] = useState<AutomationDetailDraft | null>(() =>
    automation ? createAutomationDetailDraft(automation) : null,
  )
  const [scheduleLocalError, setScheduleLocalError] = useState<string | null>(null)
  const [maxRunsLocalError, setMaxRunsLocalError] = useState<string | null>(null)
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  const actionsMenuRef = useRef<HTMLDivElement | null>(null)
  const actionsMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const triggerMenuItemRef = useRef<HTMLButtonElement | null>(null)
  const deleteMenuItemRef = useRef<HTMLButtonElement | null>(null)
  const { data: providers = [] } = useProviderRegistry()

  useEffect(() => {
    setSelectedRunKey(null)
    setNewObservation('')
    setDetailDraft(automation ? createAutomationDetailDraft(automation) : null)
    setScheduleLocalError(null)
    setMaxRunsLocalError(null)
    setActionsMenuOpen(false)
  }, [automation?.id])

  useEffect(() => {
    if (!actionsMenuOpen) {
      return
    }

    triggerMenuItemRef.current?.focus()

    function handlePointerDown(event: globalThis.MouseEvent): void {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }
      if (!actionsMenuRef.current?.contains(target)) {
        setActionsMenuOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        setActionsMenuOpen(false)
        actionsMenuButtonRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [actionsMenuOpen])

  const historyState = useAutomationHistory(automation?.id ?? null)
  const runDetailState = useAutomationRunDetail(automation?.id ?? null, selectedRunKey)
  const providerOptions = useMemo(
    () => listAutomationProviders(providers, automation?.agentType ?? 'codex'),
    [automation?.agentType, providers],
  )
  const detailSkillOptions = useMemo(() => {
    const optionMap = new Map(automationState.skillOptions.map((skill) => [skill.value, skill]))
    for (const skill of automation?.skills ?? []) {
      const value = skill.trim()
      if (value && !optionMap.has(value)) {
        optionMap.set(value, { value, label: value })
      }
    }
    return Array.from(optionMap.values())
  }, [automation?.skills, automationState.skillOptions])

  if (!automation) {
    return (
      <div
        data-testid="automation-detail-empty"
        className="flex h-full min-h-0 flex-1 items-center justify-center bg-washi-white p-6"
      >
        <div className="max-w-sm rounded-lg border border-dashed border-ink-border bg-washi-aged/20 px-5 py-6 text-center">
          <CalendarClock size={22} className="mx-auto text-sumi-diluted" />
          <p className="mt-3 font-mono text-sm text-sumi-black">Select an automation</p>
          <p className="mt-1 text-sm text-sumi-diluted">
            Pick a card to view instructions, runtime settings, frequency, observations, and runs.
          </p>
        </div>
      </div>
    )
  }

  const observations = automation.observations ?? []
  const currentProvider = providerOptions.find((provider) => provider.id === automation.agentType) ?? null
  const modelOptions = currentProvider?.availableModels ?? []
  const selectedHistoryEntry = selectedRunKey
    ? historyState.history.find((entry) => resolveHistoryRunKey(entry) === selectedRunKey) ?? null
    : null
  const selectedRun = runDetailState.runDetail?.run ?? null
  const selectedCompletionOutput = (selectedRun?.completionOutput ?? selectedHistoryEntry?.completionOutput ?? '').trim()
  const selectedEmptyOutputReason =
    runDetailState.runDetail?.emptyOutputReason
    ?? selectedRun?.emptyOutputReason
    ?? selectedHistoryEntry?.emptyOutputReason
    ?? (selectedHistoryEntry && isEmptyOutputFallback(selectedHistoryEntry) ? selectedHistoryEntry.result : null)
  const selectedReport = runDetailState.runDetail?.report.trim() ?? ''
  const selectedTranscriptSessionId =
    selectedRun?.transcriptRef?.sessionId
    ?? selectedHistoryEntry?.transcriptRef?.sessionId
    ?? selectedHistoryEntry?.sessionId
    ?? selectedRun?.sessionId
    ?? null
  const draft = detailDraft?.automationId === automation.id ? detailDraft : createAutomationDetailDraft(automation)
  const scheduleState = draft.schedule
  const actionsDisabled =
    (automationState.updateAutomationPending && automationState.updateAutomationId === automation.id)
    || (automationState.deleteAutomationPending && automationState.deleteAutomationId === automation.id)
    || (automationState.triggerAutomationPending && automationState.triggerAutomationId === automation.id)
  const draftFieldsDisabled =
    (automationState.deleteAutomationPending && automationState.deleteAutomationId === automation.id)
    || (automationState.triggerAutomationPending && automationState.triggerAutomationId === automation.id)

  async function updateAutomation(patch: Parameters<AutomationState['updateAutomation']>[1]): Promise<void> {
    await automationState.updateAutomation(automation.id, patch)
  }

  function updateDraft(patch: Partial<Omit<AutomationDetailDraft, 'automationId'>>): void {
    setDetailDraft((current) => {
      const base = current?.automationId === automation.id ? current : createAutomationDetailDraft(automation)
      return { ...base, ...patch }
    })
  }

  async function runAutomationAction(action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch {
      // React Query keeps the mutation error in automationState.actionError.
    }
  }

  function handleMenuAction(action: () => Promise<void>): void {
    setActionsMenuOpen(false)
    void runAutomationAction(action)
  }

  function focusMenuItem(index: number): void {
    const items = [triggerMenuItemRef.current, deleteMenuItemRef.current].filter(
      (item): item is HTMLButtonElement => Boolean(item),
    )
    items[index]?.focus()
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const items = [triggerMenuItemRef.current, deleteMenuItemRef.current].filter(
      (item): item is HTMLButtonElement => Boolean(item),
    )
    if (items.length === 0) {
      return
    }

    const currentIndex = items.findIndex((item) => item === document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusMenuItem(currentIndex >= 0 ? (currentIndex + 1) % items.length : 0)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusMenuItem(currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : items.length - 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      focusMenuItem(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      focusMenuItem(items.length - 1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setActionsMenuOpen(false)
      actionsMenuButtonRef.current?.focus()
    }
  }

  async function handleProviderChange(providerId: AgentType): Promise<void> {
    const nextProvider = providerOptions.find((provider) => provider.id === providerId) ?? null
    await updateAutomation({
      agentType: providerId,
      model: resolveDefaultModel(nextProvider),
    })
  }

  async function handleScheduleChange(nextSchedule: EditableScheduleState): Promise<void> {
    await updateAutomation({ schedule: buildEditableSchedule(nextSchedule) })
  }

  async function commitRawScheduleDraft(reportIncomplete: boolean): Promise<void> {
    const nextSchedule = scheduleState.raw.trim()
    const currentSchedule = (automation.schedule ?? '').trim()

    if (!isAutomationCronExpressionComplete(nextSchedule)) {
      if (reportIncomplete) {
        setScheduleLocalError('Enter a complete cron expression before applying.')
      }
      return
    }
    setScheduleLocalError(null)
    if (nextSchedule === currentSchedule) {
      return
    }

    try {
      await updateAutomation({ schedule: nextSchedule })
    } catch {
      // React Query keeps the server error in automationState.actionError.
    }
  }

  async function commitWorkDirDraft(): Promise<void> {
    if (draft.workDir === (automation.workDir ?? '')) {
      return
    }

    try {
      await updateAutomation({ workDir: draft.workDir })
    } catch {
      // React Query keeps the server error in automationState.actionError.
    }
  }

  async function commitSeedMemoryDraft(): Promise<void> {
    if (draft.seedMemory === (automation.seedMemory ?? '')) {
      return
    }

    try {
      await updateAutomation({ seedMemory: draft.seedMemory })
    } catch {
      // React Query keeps the server error in automationState.actionError.
    }
  }

  async function commitTimezoneDraft(): Promise<void> {
    const nextTimezone = draft.timezone.trim()
    if (nextTimezone === (automation.timezone ?? 'UTC')) {
      return
    }

    try {
      await updateAutomation({ timezone: nextTimezone })
    } catch {
      // React Query keeps the server error in automationState.actionError.
    }
  }

  async function commitMaxRunsDraft(): Promise<void> {
    const trimmed = draft.maxRuns.trim()
    const currentValue = automation.maxRuns === undefined || automation.maxRuns === null
      ? ''
      : String(automation.maxRuns)

    if (trimmed === currentValue) {
      setMaxRunsLocalError(null)
      return
    }

    if (trimmed && !/^\d+$/.test(trimmed)) {
      setMaxRunsLocalError('Enter a positive whole number before applying.')
      return
    }

    const nextValue = trimmed ? Number(trimmed) : null
    if (nextValue !== null && nextValue < 1) {
      setMaxRunsLocalError('Enter a positive whole number before applying.')
      return
    }

    setMaxRunsLocalError(null)
    try {
      await updateAutomation({ maxRuns: nextValue })
    } catch {
      // React Query keeps the server error in automationState.actionError.
    }
  }

  async function commitTimeDraft(reportIncomplete: boolean): Promise<void> {
    if (!isCompleteTimeValue(scheduleState.time)) {
      if (reportIncomplete) {
        setScheduleLocalError('Enter a valid time before applying.')
      }
      return
    }

    setScheduleLocalError(null)
    try {
      await handleScheduleChange(scheduleState)
    } catch {
      // React Query keeps the server error in automationState.actionError.
    }
  }

  async function handleAddObservation(): Promise<void> {
    const trimmed = newObservation.trim()
    if (!trimmed) {
      return
    }
    await updateAutomation({ observations: [...observations, trimmed] })
    setNewObservation('')
  }

  async function handleRemoveObservation(index: number): Promise<void> {
    await updateAutomation({
      observations: observations.filter((_, observationIndex) => observationIndex !== index),
    })
  }

  return (
    <article
      data-testid="automation-detail-panel"
      className="flex h-full min-h-0 w-full flex-col bg-washi-white"
      aria-labelledby={`automation-detail-title-${automation.id}`}
    >
      <header className="shrink-0 border-b border-ink-border bg-washi-aged/20 px-4 py-4">
        <div className={cn('flex gap-3', compact ? 'flex-col' : 'items-start justify-between')}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {onBack ? (
                <button
                  type="button"
                  onClick={onBack}
                  className={cn(
                    'h-8 w-8 items-center justify-center rounded-lg border border-ink-border text-sumi-diluted hover:bg-ink-wash hover:text-sumi-black',
                    responsiveNavigation ? 'inline-flex md:hidden' : 'inline-flex',
                  )}
                  aria-label="Back to automations"
                  data-testid="automation-detail-back"
                >
                  <ArrowLeft size={14} />
                </button>
              ) : null}
              <span className={cn('badge-sumi shrink-0', statusBadgeClass(automation.status))}>
                {statusSymbol(automation.status)} {automation.status}
              </span>
              <span className="badge-sumi badge-completed shrink-0">{automation.trigger}</span>
              <span className="badge-sumi badge-idle shrink-0">{classifyAutomation(automation)}</span>
            </div>
            <h3
              id={`automation-detail-title-${automation.id}`}
              className="mt-3 truncate font-display text-xl text-sumi-black"
            >
              {automation.name}
            </h3>
            <p className="mt-1 text-sm text-sumi-diluted">
              {runsLabel(automation)}
              {' · '}
              {formatCost(automation.totalCostUsd ?? 0)} total
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {automation.status === 'active' ? (
              <button
                type="button"
                disabled={actionsDisabled}
                onClick={() => void runAutomationAction(() => automationState.pauseAutomation(automation.id))}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-border text-sumi-diluted hover:bg-ink-wash hover:text-sumi-black disabled:opacity-60"
                aria-label={`Pause ${automation.name}`}
              >
                <Clock3 size={14} />
              </button>
            ) : automation.status === 'paused' ? (
              <button
                type="button"
                disabled={actionsDisabled}
                onClick={() => void runAutomationAction(() => automationState.resumeAutomation(automation.id))}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-border text-sumi-diluted hover:bg-ink-wash hover:text-sumi-black disabled:opacity-60"
                aria-label={`Resume ${automation.name}`}
              >
                <Play size={14} />
              </button>
            ) : null}
            <div ref={actionsMenuRef} className="relative">
              <button
                ref={actionsMenuButtonRef}
                type="button"
                disabled={actionsDisabled}
                onClick={() => setActionsMenuOpen((current) => !current)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-border text-sumi-diluted hover:bg-ink-wash hover:text-sumi-black disabled:opacity-60"
                aria-label={`More actions for ${automation.name}`}
                aria-haspopup="menu"
                aria-expanded={actionsMenuOpen}
                aria-controls={`automation-detail-menu-${automation.id}`}
                title="More actions"
              >
                <MoreHorizontal size={14} aria-hidden="true" />
              </button>
              {actionsMenuOpen ? (
                <div
                  id={`automation-detail-menu-${automation.id}`}
                  role="menu"
                  aria-label={`Actions for ${automation.name}`}
                  className="absolute right-0 top-[calc(100%+0.5rem)] z-20 flex min-w-48 flex-col rounded-2xl border border-ink-border bg-washi-white p-2 shadow-lg"
                  onKeyDown={handleMenuKeyDown}
                >
                  <button
                    ref={triggerMenuItemRef}
                    type="button"
                    role="menuitem"
                    disabled={actionsDisabled}
                    onClick={() => handleMenuAction(() => automationState.triggerAutomation(automation.id))}
                    className={AUTOMATION_DETAIL_MENU_ITEM_CLASS}
                  >
                    <Play size={14} aria-hidden="true" />
                    Trigger now
                  </button>
                  <button
                    ref={deleteMenuItemRef}
                    type="button"
                    role="menuitem"
                    disabled={actionsDisabled}
                    onClick={() => handleMenuAction(() => automationState.deleteAutomation(automation.id))}
                    className={`${AUTOMATION_DETAIL_MENU_ITEM_CLASS} text-accent-vermillion hover:bg-accent-vermillion/10 hover:text-accent-vermillion`}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete
                  </button>
                </div>
              ) : null}
            </div>
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                className={cn(
                  'h-8 w-8 items-center justify-center rounded-lg border border-ink-border text-sumi-diluted hover:bg-ink-wash hover:text-sumi-black',
                  responsiveNavigation ? 'hidden md:inline-flex' : 'inline-flex',
                )}
                aria-label="Clear automation selection"
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {automationState.actionError ? (
        <div className="shrink-0 border-b border-ink-border bg-accent-vermillion/10 px-4 py-2 text-sm text-accent-vermillion">
          {automationState.actionError}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl space-y-5">
          {automation.description ? (
            <section>
              <p className="section-title">Description</p>
              <p className="mt-2 text-sm leading-relaxed text-sumi-gray">{automation.description}</p>
            </section>
          ) : null}

          <section>
            <p className="section-title">Instruction</p>
            <blockquote className="mt-2 rounded-lg border border-ink-border bg-washi-aged/30 px-3 py-3 text-sm leading-relaxed text-sumi-gray whitespace-pre-wrap">
              {automation.instruction}
            </blockquote>
          </section>

          <section>
            <p className="section-title">Details</p>
            <div className={cn('mt-2 grid gap-3', !compact && 'sm:grid-cols-2')}>
              <RuntimeField label="Agent">
                <select
                  value={automation.agentType}
                  disabled={actionsDisabled || providerOptions.length === 0}
                  onChange={(event) => void handleProviderChange(event.target.value as AgentType)}
                  className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                >
                  {providerOptions.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {providerLabel(provider, provider.id)}
                    </option>
                  ))}
                </select>
              </RuntimeField>
              <RuntimeField label="Model">
                <select
                  value={automation.model ?? ''}
                  disabled={actionsDisabled}
                  onChange={(event) => void updateAutomation({ model: event.target.value.trim() || null })}
                  className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                >
                  <option value="">Adapter default</option>
                  {modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </RuntimeField>
              <RuntimeField label="Machine">
                <select
                  value={automation.machine ?? ''}
                  disabled={actionsDisabled}
                  onChange={(event) => void updateAutomation({ machine: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                >
                  <option value="">- None -</option>
                  {automation.machine && !machines.some((machine) => machine.id === automation.machine) ? (
                    <option value={automation.machine}>{automation.machine}</option>
                  ) : null}
                  {machines.map((machine) => (
                    <option key={machine.id} value={machine.id}>
                      {machine.label || machine.id}
                    </option>
                  ))}
                </select>
              </RuntimeField>
              <RuntimeField label="Workdir">
                <input
                  value={draft.workDir}
                  disabled={draftFieldsDisabled}
                  onChange={(event) => updateDraft({ workDir: event.target.value })}
                  onBlur={() => void commitWorkDirDraft()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void commitWorkDirDraft()
                    }
                  }}
                  className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                  placeholder="/workspace/project"
                />
              </RuntimeField>
              <RuntimeField label="Permission">
                <select
                  value={automation.permissionMode}
                  disabled={actionsDisabled}
                  onChange={(event) => void updateAutomation({ permissionMode: event.target.value as 'default' })}
                  className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                >
                  <option value="default">default</option>
                </select>
              </RuntimeField>
              <RuntimeField label="Session">
                <select
                  value={automation.sessionType ?? ''}
                  disabled={actionsDisabled}
                  onChange={(event) => void updateAutomation({
                    sessionType: event.target.value === '' ? null : event.target.value as 'stream' | 'pty',
                  })}
                  className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                >
                  <option value="">Adapter default</option>
                  <option value="stream">stream</option>
                  <option value="pty">pty</option>
                </select>
              </RuntimeField>
              <RuntimeField label="Skills">
                <select
                  multiple
                  value={automation.skills ?? []}
                  disabled={actionsDisabled}
                  onChange={(event) => void updateAutomation({
                    skills: Array.from(event.currentTarget.selectedOptions).map((option) => option.value),
                  })}
                  className="mt-1 min-h-24 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                >
                  {detailSkillOptions.map((skill) => (
                    <option key={skill.value} value={skill.value}>
                      {skill.label}
                    </option>
                  ))}
                </select>
              </RuntimeField>
              <RuntimeField label="Max runs">
                <input
                  type="number"
                  min="1"
                  value={draft.maxRuns}
                  disabled={draftFieldsDisabled}
                  onChange={(event) => {
                    updateDraft({ maxRuns: event.target.value })
                    if (maxRunsLocalError) {
                      setMaxRunsLocalError(null)
                    }
                  }}
                  onBlur={() => void commitMaxRunsDraft()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void commitMaxRunsDraft()
                    }
                  }}
                  className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                  placeholder="Unlimited"
                />
                {maxRunsLocalError ? (
                  <p className="mt-1 text-xs text-accent-vermillion">{maxRunsLocalError}</p>
                ) : null}
              </RuntimeField>
            </div>
            <RuntimeField label="Seed memory">
              <textarea
                value={draft.seedMemory}
                disabled={draftFieldsDisabled}
                onChange={(event) => updateDraft({ seedMemory: event.target.value })}
                onBlur={() => void commitSeedMemoryDraft()}
                className="mt-1 min-h-24 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                placeholder="Context this automation should remember across runs."
              />
            </RuntimeField>
          </section>

          <section>
            <p className="section-title">Frequency</p>
            <div className={cn('mt-2 grid gap-3', !compact && 'sm:grid-cols-2')}>
              <RuntimeField label="Repeat">
                <select
                  value={scheduleState.mode === 'raw' ? 'raw' : scheduleState.cadence}
                  disabled={actionsDisabled || automation.trigger !== 'schedule'}
                  onChange={(event) => {
                    const value = event.target.value
                    if (value === 'raw') {
                      const raw = buildRawScheduleSeed(scheduleState).trim()
                      updateDraft({
                        schedule: { ...scheduleState, mode: 'raw', raw },
                      })
                      setScheduleLocalError(null)
                      return
                    }

                    const next = {
                      ...scheduleState,
                      mode: 'preset' as const,
                      cadence: value as EditableScheduleState['cadence'],
                    }
                    updateDraft({ schedule: next })
                    void handleScheduleChange(next)
                  }}
                  className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                >
                  <option value="every-15-minutes">Every 15 minutes</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekly">Weekly</option>
                  <option value="raw">Raw cron</option>
                </select>
              </RuntimeField>
              {scheduleState.mode === 'preset' && scheduleState.cadence === 'hourly' ? (
                <RuntimeField label="Minute">
                  <select
                    value={scheduleState.minute}
                    disabled={actionsDisabled || automation.trigger !== 'schedule'}
                    onChange={(event) => {
                      const next = { ...scheduleState, minute: event.target.value }
                      updateDraft({ schedule: next })
                      void handleScheduleChange(next)
                    }}
                    className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                  >
                    {['0', '15', '30', '45'].map((minute) => (
                      <option key={minute} value={minute}>
                        :{minute.padStart(2, '0')}
                      </option>
                    ))}
                  </select>
                </RuntimeField>
              ) : null}
              {scheduleState.mode === 'preset' && !['every-15-minutes', 'hourly'].includes(scheduleState.cadence) ? (
                <RuntimeField label="At">
                  <input
                    type="time"
                    value={scheduleState.time}
                    disabled={draftFieldsDisabled || automation.trigger !== 'schedule'}
                    onChange={(event) => {
                      updateDraft({ schedule: { ...scheduleState, time: event.target.value } })
                      if (scheduleLocalError) {
                        setScheduleLocalError(null)
                      }
                    }}
                    onBlur={() => void commitTimeDraft(false)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void commitTimeDraft(true)
                      }
                    }}
                    className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                  />
                  {scheduleLocalError ? (
                    <p className="mt-1 text-xs text-accent-vermillion">{scheduleLocalError}</p>
                  ) : null}
                </RuntimeField>
              ) : null}
              {scheduleState.mode === 'preset' && scheduleState.cadence === 'weekly' ? (
                <RuntimeField label="Day">
                  <select
                    value={scheduleState.weekday}
                    disabled={actionsDisabled || automation.trigger !== 'schedule'}
                    onChange={(event) => {
                      const next = { ...scheduleState, weekday: event.target.value }
                      updateDraft({ schedule: next })
                      void handleScheduleChange(next)
                    }}
                    className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                  >
                    <option value="0">Sunday</option>
                    <option value="1">Monday</option>
                    <option value="2">Tuesday</option>
                    <option value="3">Wednesday</option>
                    <option value="4">Thursday</option>
                    <option value="5">Friday</option>
                    <option value="6">Saturday</option>
                  </select>
                </RuntimeField>
              ) : null}
              {scheduleState.mode === 'raw' ? (
                <RuntimeField label="Cron">
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      value={scheduleState.raw}
                      disabled={draftFieldsDisabled || automation.trigger !== 'schedule'}
                      onChange={(event) => {
                        updateDraft({ schedule: { ...scheduleState, raw: event.target.value } })
                        if (scheduleLocalError) {
                          setScheduleLocalError(null)
                        }
                      }}
                      onBlur={() => void commitRawScheduleDraft(false)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void commitRawScheduleDraft(true)
                        }
                      }}
                      className="min-w-0 flex-1 rounded-lg border border-ink-border bg-washi-white px-3 py-2 font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                      placeholder="0 9 * * *"
                    />
                    <button
                      type="button"
                      disabled={draftFieldsDisabled || automation.trigger !== 'schedule'}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void commitRawScheduleDraft(true)}
                      className="btn-ghost !px-3 !py-2 text-xs disabled:opacity-60"
                    >
                      Apply
                    </button>
                  </div>
                  {scheduleLocalError ? (
                    <p className="mt-1 text-xs text-accent-vermillion">{scheduleLocalError}</p>
                  ) : null}
                </RuntimeField>
              ) : null}
              <RuntimeField label="Timezone">
                {TIMEZONE_OPTIONS.length > 0 ? (
                  <select
                    value={automation.timezone ?? 'UTC'}
                    disabled={actionsDisabled || automation.trigger !== 'schedule'}
                    onChange={(event) => void updateAutomation({ timezone: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                  >
                    {automation.timezone && !TIMEZONE_OPTIONS.includes(automation.timezone) ? (
                      <option value={automation.timezone}>{automation.timezone}</option>
                    ) : null}
                    <option value="UTC">UTC</option>
                    {TIMEZONE_OPTIONS.map((timezone) => (
                      <option key={timezone} value={timezone}>
                        {timezone}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={draft.timezone}
                    disabled={draftFieldsDisabled || automation.trigger !== 'schedule'}
                    onChange={(event) => updateDraft({ timezone: event.target.value })}
                    onBlur={() => void commitTimezoneDraft()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void commitTimezoneDraft()
                      }
                    }}
                    className="mt-1 w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover disabled:opacity-60"
                    placeholder="America/Los_Angeles"
                  />
                )}
              </RuntimeField>
            </div>
            <p className="mt-2 text-xs text-sumi-diluted">
              {automation.trigger === 'schedule' ? describeScheduleForList(automation) : describeTrigger(automation)}
            </p>
          </section>

          <section>
            <p className="section-title">Observations</p>
            <div className="mt-2 space-y-2">
              {observations.length === 0 ? (
                <p className="text-sm text-sumi-diluted">No observations yet.</p>
              ) : (
                observations.map((observation, index) => (
                  <div
                    key={`${observation}-${index}`}
                    className="flex items-start justify-between gap-2 rounded-lg border border-ink-border bg-washi-aged/20 px-3 py-2"
                  >
                    <p className="text-sm text-sumi-gray">{observation}</p>
                    <button
                      type="button"
                      disabled={actionsDisabled}
                      onClick={() => void handleRemoveObservation(index)}
                      className="text-whisper text-accent-vermillion disabled:opacity-60"
                    >
                      remove
                    </button>
                  </div>
                ))
              )}
              <div className="flex items-center gap-2">
                <input
                  value={newObservation}
                  onChange={(event) => setNewObservation(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                  placeholder="Add observation"
                />
                <button
                  type="button"
                  disabled={actionsDisabled || newObservation.trim().length === 0}
                  onClick={() => void handleAddObservation()}
                  className="btn-ghost !px-3 !py-2 text-xs disabled:opacity-60"
                >
                  Add
                </button>
              </div>
            </div>
          </section>

          <section>
            <p className="section-title">Previous Runs</p>
            <div className="mt-2 space-y-2">
              {historyState.historyLoading ? (
                <p className="text-sm text-sumi-mist">Loading run history...</p>
              ) : null}
              {historyState.historyError ? (
                <p className="text-sm text-accent-vermillion">{historyState.historyError}</p>
              ) : null}
              {!historyState.historyLoading && historyState.history.length === 0 ? (
                <p className="text-sm text-sumi-diluted">No runs yet.</p>
              ) : null}
              {historyState.history.map((entry, index) => {
                const runKey = resolveHistoryRunKey(entry)
                const selected = Boolean(runKey && runKey === selectedRunKey)
                return (
                  <button
                    key={`${entry.timestamp}-${index}`}
                    type="button"
                    onClick={() => setSelectedRunKey(runKey)}
                    disabled={!runKey}
                    className={cn(
                      'w-full rounded-lg border bg-washi-aged/20 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                      selected ? 'border-sumi-black bg-washi-white' : 'border-ink-border hover:border-ink-border-hover',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-mono text-sumi-diluted">{timeAgo(entry.timestamp)}</p>
                      <span className="text-xs text-sumi-diluted">{formatCost(entry.costUsd)}</span>
                    </div>
                    <p className="mt-1 text-sm text-sumi-black">{entry.action}</p>
                    <p className="mt-0.5 text-xs text-sumi-gray">{entry.result}</p>
                    <p className="mt-1 text-whisper text-sumi-mist">
                      duration {entry.durationSec}s
                      {entry.source ? ` - ${entry.source}` : ''}
                      {runKey ? ' - View detail' : ''}
                    </p>
                  </button>
                )
              })}
            </div>

            {selectedRunKey ? (
              <div className="mt-3 rounded-lg border border-ink-border bg-washi-aged/20 px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="section-title">Run Detail</p>
                  <span className="text-whisper font-mono text-sumi-mist">{selectedRunKey}</span>
                </div>
                {runDetailState.runDetailLoading ? (
                  <p className="mt-2 text-sm text-sumi-mist">Loading run detail...</p>
                ) : null}
                {runDetailState.runDetailError ? (
                  <p className="mt-2 text-sm text-accent-vermillion">{runDetailState.runDetailError}</p>
                ) : null}
                {!runDetailState.runDetailLoading && !runDetailState.runDetailError ? (
                  <div className="mt-3 space-y-3">
                    <div>
                      <p className="text-whisper uppercase tracking-wide text-sumi-diluted">Completion Output</p>
                      {selectedCompletionOutput ? (
                        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-ink-border bg-washi-white p-2 text-xs text-sumi-gray">
                          {selectedCompletionOutput}
                        </pre>
                      ) : (
                        <p className="mt-1 text-sm text-sumi-gray">
                          {selectedEmptyOutputReason ?? 'No completion output was recorded for this run.'}
                        </p>
                      )}
                    </div>
                    <div>
                      <p className="text-whisper uppercase tracking-wide text-sumi-diluted">Run Report</p>
                      {selectedReport ? (
                        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-ink-border bg-washi-white p-2 text-xs text-sumi-gray">
                          {selectedReport}
                        </pre>
                      ) : (
                        <p className="mt-1 text-sm text-sumi-gray">No markdown run report was written for this run.</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-whisper text-sumi-diluted">
                      {selectedRun?.status ? <span>{selectedRun.status}</span> : null}
                      {selectedHistoryEntry?.source ? <span>{selectedHistoryEntry.source}</span> : null}
                      {selectedHistoryEntry ? <span>{selectedHistoryEntry.durationSec}s</span> : null}
                      {selectedHistoryEntry?.memoryUpdated ? <span>memory updated</span> : null}
                      {selectedTranscriptSessionId ? <span>transcript {selectedTranscriptSessionId}</span> : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </article>
  )
}

function AutomationCard({
  automation,
  selected,
  automationState,
  onSelect,
  mobile = false,
}: {
  automation: AutomationListItem
  selected: boolean
  automationState: AutomationState
  onSelect: () => void
  mobile?: boolean
}) {
  const isActive = automation.status === 'active'
  const isToggleable = automation.status === 'active' || automation.status === 'paused'
  const nextRunLabel = nextRunListLabel(automation)
  const actionsDisabled =
    (automationState.updateAutomationPending && automationState.updateAutomationId === automation.id)
    || (automationState.deleteAutomationPending && automationState.deleteAutomationId === automation.id)
    || (automationState.triggerAutomationPending && automationState.triggerAutomationId === automation.id)

  async function handleStatusToggle(event: MouseEvent<HTMLButtonElement>): Promise<void> {
    event.preventDefault()
    event.stopPropagation()

    if (automation.status === 'active') {
      await automationState.pauseAutomation(automation.id)
      return
    }
    if (automation.status === 'paused') {
      await automationState.resumeAutomation(automation.id)
    }
  }

  return (
    <div
      className={cn(
        'rounded-lg border bg-washi-white p-3 transition-colors',
        selected ? 'border-sumi-black shadow-sm' : 'border-ink-border hover:border-ink-border-hover',
      )}
      data-testid={mobile ? 'mobile-automation-card' : 'automation-card'}
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? 'true' : undefined}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xs text-sumi-diluted" aria-hidden="true">
              {selected ? '◉' : '○'}
            </span>
            <p className="truncate font-mono text-sm text-sumi-black">{automation.name}</p>
          </div>
          <p className="mt-2 truncate text-xs text-sumi-diluted">{describeScheduleForList(automation)}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-sumi-gray">
            <span className={cn('badge-sumi shrink-0', statusBadgeClass(automation.status))}>
              {automation.status}
            </span>
            {nextRunLabel ? <span>{nextRunLabel}</span> : null}
          </div>
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={isActive}
          aria-label={mobileToggleAriaLabel(automation)}
          disabled={actionsDisabled || !isToggleable}
          onClick={(event) => void handleStatusToggle(event)}
          className={cn(
            "relative mt-0.5 h-7 w-12 shrink-0 rounded-full border transition-colors before:absolute before:-inset-2 before:rounded-full before:content-[''] disabled:cursor-not-allowed disabled:opacity-60",
            isActive ? 'border-sumi-black bg-sumi-black' : 'border-ink-border bg-washi-aged',
          )}
          data-testid={`mobile-automation-toggle-${automation.id}`}
        >
          <span
            className={cn(
              'absolute left-1 top-1 h-5 w-5 rounded-full bg-washi-white shadow-sm transition-transform',
              isActive ? 'translate-x-5' : 'translate-x-0',
            )}
          />
        </button>
      </div>
    </div>
  )
}

export function AutomationPanel({
  scope,
  filter,
  onFilterChange,
  preselectedSkillName = null,
  onPreselectedSkillConsumed,
  presentation = 'default',
  mobileControls,
}: AutomationPanelProps) {
  const [internalFilter, setInternalFilter] = useState<AutomationTriggerFilter>('all')
  const [createMode, setCreateMode] = useState<CreateMode>(null)
  const [skillSeed, setSkillSeed] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<AutomationStatusFilter>('all')
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null)
  const [isOpeningWithGaia, setIsOpeningWithGaia] = useState(false)
  const [gaiaError, setGaiaError] = useState<string | null>(null)
  const automationState = useAutomations(toAutomationScope(scope))
  const { data: machines } = useMachines()

  const machineList = machines ?? []
  const isMobileList = presentation === 'mobile-list'
  const isSinglePane = presentation === 'single-pane'
  const isFullSwap = isMobileList || isSinglePane
  const currentFilter = filter ?? internalFilter
  const triggerFilteredItems = useMemo(
    () => filterItems(automationState.items, currentFilter),
    [automationState.items, currentFilter],
  )
  const visibleItems = useMemo(
    () => filterBySearch(filterByStatus(triggerFilteredItems, statusFilter), searchQuery),
    [searchQuery, statusFilter, triggerFilteredItems],
  )
  const selectedAutomation = selectedAutomationId
    ? visibleItems.find((automation) => automation.id === selectedAutomationId) ?? null
    : null
  const triggerTypeCount = (['schedule', 'quest', 'manual'] as const)
    .filter((trigger) => automationState.counts.triggerCounts[trigger] > 0)
    .length
  const hasRecoverableMobileFilter =
    isMobileList
    && currentFilter !== 'all'
    && triggerFilteredItems.length === 0
    && automationState.items.length > 0
  const filterOptions = isMobileList
    ? FILTER_OPTIONS.filter((option) => (
      option.value === 'all'
      || option.value === currentFilter
      || automationState.counts.triggerCounts[option.value] > 0
    ))
    : FILTER_OPTIONS
  const showFilterBar = !isMobileList || triggerTypeCount > 1 || hasRecoverableMobileFilter
  const showDetailInFullSwap = isFullSwap && selectedAutomation !== null

  useEffect(() => {
    if (selectedAutomationId && !visibleItems.some((automation) => automation.id === selectedAutomationId)) {
      setSelectedAutomationId(null)
    }
  }, [selectedAutomationId, visibleItems])

  useEffect(() => {
    const normalizedSkillName = preselectedSkillName?.trim()
    if (!normalizedSkillName) {
      return
    }

    setSkillSeed(normalizedSkillName)
    setGaiaError(null)
    setCreateMode('monitor')
    onPreselectedSkillConsumed?.()
  }, [onPreselectedSkillConsumed, preselectedSkillName])

  function closeCreateMode() {
    setCreateMode(null)
    setSkillSeed(null)
  }

  function handleFilterChange(nextFilter: AutomationTriggerFilter) {
    if (onFilterChange) {
      onFilterChange(nextFilter)
      return
    }

    setInternalFilter(nextFilter)
  }

  async function handleOpenCreateAutomationWithGaia(): Promise<void> {
    setIsOpeningWithGaia(true)
    setGaiaError(null)
    try {
      await openGaiaConversationWithDraft(buildGaiaCreateAutomationPrompt(scope))
    } catch (error) {
      setGaiaError(error instanceof Error ? error.message : 'Failed to open Gaia.')
    } finally {
      setIsOpeningWithGaia(false)
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div
        className={cn(
          'border-b border-ink-border flex items-center justify-between gap-3',
          isMobileList ? 'px-5 pb-3 pt-4' : 'px-4 md:px-6 py-3',
        )}
      >
        {isMobileList ? (
          <h1 className="min-w-0 font-display text-3xl text-sumi-black">Automations</h1>
        ) : (
          <div className="min-w-0">
            <span className="text-xs uppercase tracking-wide text-sumi-diluted">Automations</span>
            <p className="text-sm text-sumi-gray mt-1">
              {automationState.counts.active} active
              {' · '}
              {automationState.counts.paused} paused
            </p>
          </div>
        )}

        <button
          type="button"
          aria-label={isMobileList ? 'New automation' : undefined}
          onClick={() => {
            setGaiaError(null)
            setSkillSeed(null)
            setCreateMode('chooser')
          }}
          className={cn(
            'inline-flex shrink-0 items-center justify-center gap-1.5',
            isMobileList
              ? 'h-10 w-10 rounded-full border border-ink-border bg-washi-white text-sumi-black transition-colors hover:border-ink-border-hover'
              : 'btn-ghost !px-3 !py-1.5 text-xs',
          )}
        >
          <Plus size={isMobileList ? 20 : 12} />
          {isMobileList ? null : 'Create'}
        </button>
      </div>

      {isMobileList && !showDetailInFullSwap ? mobileControls : null}

      {showFilterBar && !showDetailInFullSwap ? (
        <div className="border-b border-ink-border px-4 md:px-6 py-3 overflow-x-auto">
          <div className="flex gap-2 min-w-max">
            {filterOptions.map((option) => {
              const isActive = currentFilter === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleFilterChange(option.value)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    isActive
                      ? 'border-sumi-black bg-sumi-black text-washi-aged'
                      : 'border-ink-border text-sumi-gray hover:border-ink-border-hover hover:text-sumi-black',
                  )}
                >
                  {option.label}
                  <span className="ml-1.5 text-[10px] opacity-80">
                    {automationState.counts.triggerCounts[option.value]}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      <ModalFormContainer
        open={createMode !== null}
        title={createMode === 'chooser' ? 'New Automation' : 'Create Automation'}
        onClose={closeCreateMode}
      >
        {createMode === 'chooser' ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => void handleOpenCreateAutomationWithGaia()}
              disabled={isOpeningWithGaia}
              className="w-full rounded-lg border border-ink-border bg-washi-aged/50 px-4 py-3 text-left hover:border-ink-border-hover transition-colors disabled:opacity-60"
            >
              <p className="font-mono text-sm text-sumi-black">
                <MessageSquarePlus size={15} className="mr-2 inline" />
                {isOpeningWithGaia ? 'Opening Gaia...' : 'Do it with Gaia'}
              </p>
              <p className="mt-1 text-sm text-sumi-gray">
                Opens Gaia with this automation scope and a setup prompt already drafted.
              </p>
            </button>

            {gaiaError ? <p className="text-sm text-accent-vermillion">{gaiaError}</p> : null}

            <div>
              <p className="section-title">Preset Catalog</p>
              <div className="mt-2 space-y-2">
                {AUTOMATION_PRESETS.map((preset) => {
                  const Icon = preset.icon
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      disabled={automationState.createPresetPending}
                      onClick={() => {
                        setGaiaError(null)
                        void automationState.createPreset(preset.seed)
                          .then(() => setCreateMode(null))
                          .catch(() => undefined)
                      }}
                      className="w-full rounded-lg border border-ink-border bg-washi-aged/50 px-4 py-3 text-left hover:border-ink-border-hover transition-colors disabled:opacity-60"
                    >
                      <p className="font-mono text-sm text-sumi-black">
                        <Icon size={15} className="mr-2 inline" />
                        {automationState.createPresetPending ? 'Creating preset...' : preset.label}
                      </p>
                      <p className="mt-1 text-sm text-sumi-gray">{preset.description}</p>
                    </button>
                  )
                })}
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setGaiaError(null)
                setSkillSeed(null)
                setCreateMode('task')
              }}
              className="w-full rounded-lg border border-ink-border bg-washi-aged/50 px-4 py-3 text-left hover:border-ink-border-hover transition-colors"
            >
              <p className="font-mono text-sm text-sumi-black">Instruction Run</p>
              <p className="mt-1 text-sm text-sumi-gray">
                Runs a scheduled instruction in a workspace on a machine you choose. Use Persistent Automation for scheduled runs that persist skills.
              </p>
            </button>

            <button
              type="button"
              onClick={() => {
                setGaiaError(null)
                setSkillSeed(null)
                setCreateMode('monitor')
              }}
              className="w-full rounded-lg border border-ink-border bg-washi-aged/50 px-4 py-3 text-left hover:border-ink-border-hover transition-colors"
            >
              <p className="font-mono text-sm text-sumi-black">Persistent Automation</p>
              <p className="mt-1 text-sm text-sumi-gray">
                Keeps memory, skills, and observations across repeated or event-based runs.
              </p>
            </button>
          </div>
        ) : null}

        {createMode === 'task' ? (
          <CreateAutomationTaskForm
            onCreate={async (input) => {
              await automationState.createTask(input)
              closeCreateMode()
            }}
            onClose={closeCreateMode}
            machines={machineList}
            createPending={automationState.createTaskPending}
          />
        ) : null}

        {createMode === 'monitor' ? (
          <SentinelCreateForm
            skillOptions={automationState.skillOptions}
            isSubmitting={automationState.createSentinelPending}
            error={automationState.actionError}
            onSubmit={automationState.createSentinel}
            onCancel={closeCreateMode}
            initialSkill={skillSeed}
            submitLabel="Create Automation"
            seedMemoryPlaceholder="Context this automation should remember across runs."
          />
        ) : null}
      </ModalFormContainer>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            'h-full min-h-0 flex-col overflow-hidden border-r border-ink-border bg-washi-aged/10',
            showDetailInFullSwap
              ? 'hidden'
              : (!isFullSwap && selectedAutomation ? 'hidden md:flex' : 'flex'),
            isFullSwap ? 'w-full' : 'w-full md:w-80 lg:w-96',
          )}
          data-testid="automation-list-pane"
        >
          <div className="shrink-0 border-b border-ink-border bg-washi-aged/20 px-4 py-3">
            <label className="relative block">
              <span className="sr-only">Search automations</span>
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sumi-diluted" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="w-full rounded-lg border border-ink-border bg-washi-white py-2 pl-9 pr-3 text-[16px] text-sumi-black placeholder:text-sumi-diluted focus:border-ink-border-hover focus:outline-none md:text-sm"
                placeholder="Search automations"
              />
            </label>

            <div className="mt-3 flex gap-2 overflow-x-auto" role="tablist" aria-label="Automation status">
              {STATUS_FILTER_OPTIONS.map((option) => {
                const isActive = statusFilter === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setStatusFilter(option.value)}
                    className={cn(
                      'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                      isActive
                        ? 'border-sumi-black bg-sumi-black text-washi-aged'
                        : 'border-ink-border text-sumi-gray hover:border-ink-border-hover hover:text-sumi-black',
                    )}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className={cn('min-h-0 flex-1 overflow-y-auto space-y-3', isMobileList ? 'p-5 pt-3' : 'p-4')}>
            {automationState.loading && automationState.items.length === 0 ? (
              <div className="flex h-20 items-center justify-center">
                <div className="h-3 w-3 animate-breathe rounded-full bg-sumi-mist" />
              </div>
            ) : null}

            {!automationState.loading && visibleItems.length === 0 && !automationState.dataError ? (
              <div className="rounded-lg border border-dashed border-ink-border p-4 text-sm text-sumi-diluted">
                <div className="flex items-center gap-2 text-sumi-gray">
                  <CalendarClock size={14} />
                  <span>{filteredEmptyMessage(scope, currentFilter, statusFilter, searchQuery)}</span>
                </div>
              </div>
            ) : null}

            {visibleItems.map((automation) => (
              <AutomationCard
                key={automation.id}
                automation={automation}
                automationState={automationState}
                selected={selectedAutomationId === automation.id}
                onSelect={() => setSelectedAutomationId(automation.id)}
                mobile={isMobileList}
              />
            ))}

            {automationState.dataError ? (
              <p className="text-sm text-accent-vermillion">{automationState.dataError}</p>
            ) : null}

            {!automationState.dataError && automationState.actionError ? (
              <p className="text-sm text-accent-vermillion">{automationState.actionError}</p>
            ) : null}
          </div>
        </div>

        <div
          className={cn(
            'h-full min-w-0 flex-1',
            isFullSwap
              ? (showDetailInFullSwap ? 'flex' : 'hidden')
              : (selectedAutomation ? 'flex' : 'hidden md:flex'),
          )}
          data-testid="automation-detail-shell"
        >
          <AutomationDetailPanel
            automation={selectedAutomation}
            automationState={automationState}
            machines={machineList}
            compact={isSinglePane}
            onBack={() => setSelectedAutomationId(null)}
            onClose={!isFullSwap ? () => setSelectedAutomationId(null) : undefined}
            responsiveNavigation={!isFullSwap}
          />
        </div>
      </div>
    </div>
  )
}
