import { homedir } from 'node:os'
import type { AutomationScheduler } from './scheduler.js'
import type { AutomationStore, CreateAutomationInput } from './store.js'
import type { Automation } from './types.js'

export const DEFAULT_OPERATOR_AUTOMATION_NAMES = [
  'memory-consolidation',
  'context-hygiene',
] as const

type DefaultOperatorAutomationName = typeof DEFAULT_OPERATOR_AUTOMATION_NAMES[number]

type DefaultOperatorAutomation = Omit<CreateAutomationInput, 'operatorId' | 'workDir'> & {
  name: DefaultOperatorAutomationName
}

export const DEFAULT_OPERATOR_AUTOMATIONS: DefaultOperatorAutomation[] = [
  {
    name: 'memory-consolidation',
    trigger: 'schedule',
    schedule: '0 0 * * *',
    instruction: [
      'Run commander memory consolidation for active commanders.',
      'Use the commander-memory-cleanup skill in observer mode first, then reflector mode only for commanders that need cleanup.',
      'Report per-commander KEEP/PROMOTE/DROP/PROPOSE counts, changed files, and skipped commanders.',
      'Skip stopped or archived commanders.',
    ].join(' '),
    agentType: 'codex',
    permissionMode: 'default',
    skills: ['commander-memory-cleanup'],
    status: 'active',
    description: 'Nightly commander memory cleanup across active commanders.',
    timezone: 'America/New_York',
    sessionType: 'stream',
    seedMemory: 'Default Herd housekeeping automation for commander memory consolidation.',
  },
  {
    name: 'context-hygiene',
    trigger: 'schedule',
    schedule: '0 4 * * *',
    instruction: [
      'Run context hygiene for the Herd runtime and workspace guidance files.',
      'Use the context-rot-cleanup skill in observer mode first, then reflector mode only for crisp, low-risk cleanup.',
      'Preserve identity, operating doctrine, and user-owned files; flag ambiguous cleanup for operator review instead of editing.',
      'Report files inspected, changes made, and any recommendations that require operator discretion.',
    ].join(' '),
    agentType: 'codex',
    permissionMode: 'default',
    skills: ['context-rot-cleanup'],
    status: 'active',
    description: 'Daily context hygiene sweep for durable runtime guidance.',
    timezone: 'America/New_York',
    sessionType: 'stream',
    seedMemory: 'Default Herd housekeeping automation for context hygiene and rot cleanup.',
  },
]

export interface EnsureDefaultOperatorAutomationsOptions {
  operatorId: string
  store: Pick<AutomationStore, 'list' | 'create'>
  scheduler?: Pick<AutomationScheduler, 'createAutomation' | 'ensureAutomationScheduled'>
  workDir?: string
}

function resolveDefaultWorkDir(workDir: string | undefined): string {
  const trimmed = workDir?.trim()
  if (trimmed) {
    return trimmed
  }

  return process.env.HOME || homedir() || process.cwd()
}

export async function ensureDefaultOperatorAutomations(
  options: EnsureDefaultOperatorAutomationsOptions,
): Promise<Automation[]> {
  const operatorId = options.operatorId.trim()
  if (!operatorId) {
    return []
  }

  const existing = await options.store.list({ parentCommanderId: null })
  const existingByName = new Map(existing.map((automation) => [automation.name, automation]))
  const created: Automation[] = []
  const createAutomation = options.scheduler
    ? options.scheduler.createAutomation.bind(options.scheduler)
    : options.store.create.bind(options.store)
  const workDir = resolveDefaultWorkDir(options.workDir)

  for (const automation of DEFAULT_OPERATOR_AUTOMATIONS) {
    const existingAutomation = existingByName.get(automation.name)
    if (existingAutomation) {
      await options.scheduler?.ensureAutomationScheduled(existingAutomation.id)
      continue
    }

    const next = await createAutomation({
      ...automation,
      operatorId,
      parentCommanderId: null,
      workDir,
    })
    created.push(next)
    existingByName.set(next.name, next)
  }

  return created
}
