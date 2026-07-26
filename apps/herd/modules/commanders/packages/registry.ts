import { access, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeUiProfile } from '../commander-profile.js'
import {
  DEFAULT_COMMANDER_CONTEXT_MODE,
  type CommanderContextMode,
} from '../store.js'
import type { AgentType } from '../../agents/types.js'
import { DEFAULT_CLAUDE_EFFORT_LEVEL, isClaudeEffortLevel } from '../../claude-effort.js'
import type {
  CommanderPackageAutomation,
  CommanderPackageDefinition,
  CommanderPackageExample,
  CommanderPackageSkill,
} from './types.js'

interface RawPackageManifest {
  schemaVersion?: unknown
  id?: unknown
  version?: unknown
  displayName?: unknown
  host?: unknown
  role?: unknown
  summary?: unknown
  description?: unknown
  agentType?: unknown
  effort?: unknown
  contextMode?: unknown
  uiProfile?: unknown
}

interface RawSkillsManifest {
  required?: unknown
  optional?: unknown
}

interface RawAutomationsManifest {
  automations?: unknown
}

interface RawSkillEntry {
  id?: unknown
  label?: unknown
  purpose?: unknown
}

interface RawAutomationEntry {
  id?: unknown
  label?: unknown
  purpose?: unknown
  trigger?: unknown
  schedule?: unknown
  questTrigger?: unknown
  instruction?: unknown
  agentType?: unknown
  status?: unknown
  description?: unknown
  timezone?: unknown
  skills?: unknown
  machine?: unknown
  workDir?: unknown
  model?: unknown
  sessionType?: unknown
  seedMemory?: unknown
  maxRuns?: unknown
}

const modulePackagesDir = path.dirname(fileURLToPath(import.meta.url))

export class CommanderBundledPackagesRootNotFoundError extends Error {
  constructor(public readonly candidates: readonly string[]) {
    super(`Commander bundled packages root not found: ${candidates.join(', ')}`)
    this.name = 'CommanderBundledPackagesRootNotFoundError'
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)]
}

function bundledPackagesRootCandidates(): string[] {
  const candidates = [
    path.join(modulePackagesDir, 'bundled'),
  ]
  const distServerSegment = `${path.sep}dist-server${path.sep}`
  const distServerIndex = modulePackagesDir.lastIndexOf(distServerSegment)
  if (distServerIndex >= 0) {
    candidates.push(
      path.join(
        modulePackagesDir.slice(0, distServerIndex),
        'modules',
        'commanders',
        'packages',
        'bundled',
      ),
    )
  }
  candidates.push(path.join(process.cwd(), 'modules', 'commanders', 'packages', 'bundled'))
  return uniquePaths(candidates)
}

export async function resolveBundledPackagesRoot(
  candidates: string[] = bundledPackagesRootCandidates(),
): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next known runtime location.
    }
  }
  throw new CommanderBundledPackagesRootNotFoundError(candidates)
}

export const STARTER_COMMANDER_PACKAGE_IDS = [
  'engineering-manager',
  'research-intelligence-analyst',
  'general-assistant',
] as const

export type StarterCommanderPackageId = typeof STARTER_COMMANDER_PACKAGE_IDS[number]

export const STARTER_COMMANDER_PACKAGE_STATUS_DEFAULTS: Readonly<Record<
  StarterCommanderPackageId,
  Pick<CommanderPackageDefinition, 'displayName' | 'role' | 'summary'>
>> = {
  'engineering-manager': {
    displayName: 'Asina',
    role: 'Engineering Manager',
    summary: 'Owns issue triage, code investigation, implementation planning, review follow-through, and release reliability.',
  },
  'research-intelligence-analyst': {
    displayName: 'Einstein',
    role: 'Research Intelligence Analyst',
    summary: 'Runs web research, knowledge search, AI-for-science synthesis, report generation, and domain distillation.',
  },
  'general-assistant': {
    displayName: 'Alfred',
    role: 'General Assistant',
    summary: 'Handles meeting prep, scheduling support, daily assistance, inbox/doc triage, and lightweight follow-through.',
  },
}

function requireString(value: unknown, field: string, packageDir: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  throw new Error(`Commander package ${packageDir} is missing string field ${field}`)
}

function parseAgentType(value: unknown): AgentType {
  return typeof value === 'string' && value.trim() ? value.trim() : 'claude'
}

function parseContextMode(value: unknown): CommanderContextMode {
  return value === 'fat' || value === 'thin' ? value : DEFAULT_COMMANDER_CONTEXT_MODE
}

function parseSkillEntry(raw: unknown, required: boolean): CommanderPackageSkill {
  const entry = raw as RawSkillEntry
  return {
    id: requireString(entry.id, 'skills[].id', 'skills.manifest.json'),
    label: requireString(entry.label, 'skills[].label', 'skills.manifest.json'),
    purpose: requireString(entry.purpose, 'skills[].purpose', 'skills.manifest.json'),
    required,
  }
}

function parseAutomationTrigger(value: unknown, packageDir: string): CommanderPackageAutomation['trigger'] {
  if (value === 'schedule' || value === 'quest' || value === 'manual') {
    return value
  }
  throw new Error(`Commander package ${packageDir} has invalid automations[].trigger`)
}

function parseAutomationStatus(value: unknown): CommanderPackageAutomation['status'] {
  return value === 'active' || value === 'completed' || value === 'cancelled'
    ? value
    : 'paused'
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseAutomationSkills(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => parseOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry))
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

function parseQuestTrigger(value: unknown): CommanderPackageAutomation['questTrigger'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (record.event !== 'completed') {
    return undefined
  }
  const commanderId = parseOptionalString(record.commanderId)
  return {
    event: 'completed',
    ...(commanderId ? { commanderId } : {}),
  }
}

function parseAutomationEntry(raw: unknown, packageDir: string): CommanderPackageAutomation {
  const entry = raw as RawAutomationEntry
  const trigger = parseAutomationTrigger(entry.trigger, packageDir)
  const schedule = parseOptionalString(entry.schedule)
  const questTrigger = parseQuestTrigger(entry.questTrigger)
  if (trigger === 'schedule' && !schedule) {
    throw new Error(`Commander package ${packageDir} schedule automation is missing schedule`)
  }
  if (trigger === 'quest' && !questTrigger) {
    throw new Error(`Commander package ${packageDir} quest automation is missing questTrigger`)
  }

  const sessionType = entry.sessionType === 'pty' || entry.sessionType === 'stream'
    ? entry.sessionType
    : undefined

  return {
    id: requireString(entry.id, 'automations[].id', packageDir),
    label: requireString(entry.label, 'automations[].label', packageDir),
    purpose: requireString(entry.purpose, 'automations[].purpose', packageDir),
    trigger,
    ...(schedule ? { schedule } : {}),
    ...(questTrigger ? { questTrigger } : {}),
    instruction: requireString(entry.instruction, 'automations[].instruction', packageDir),
    ...(entry.agentType ? { agentType: parseAgentType(entry.agentType) } : {}),
    status: parseAutomationStatus(entry.status),
    ...(parseOptionalString(entry.description) ? { description: parseOptionalString(entry.description) } : {}),
    ...(parseOptionalString(entry.timezone) ? { timezone: parseOptionalString(entry.timezone) } : {}),
    skills: parseAutomationSkills(entry.skills),
    ...(parseOptionalString(entry.machine) ? { machine: parseOptionalString(entry.machine) } : {}),
    ...(parseOptionalString(entry.workDir) ? { workDir: parseOptionalString(entry.workDir) } : {}),
    ...(parseOptionalString(entry.model) ? { model: parseOptionalString(entry.model) } : {}),
    ...(sessionType ? { sessionType } : {}),
    ...(typeof entry.seedMemory === 'string' ? { seedMemory: entry.seedMemory } : {}),
    ...(parsePositiveInteger(entry.maxRuns) ? { maxRuns: parsePositiveInteger(entry.maxRuns) } : {}),
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

async function readExamples(packageDir: string): Promise<CommanderPackageExample[]> {
  const examplesDir = path.join(packageDir, 'examples')
  const entries = await readdir(examplesDir, { withFileTypes: true }).catch(() => [])
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()

  return Promise.all(markdownFiles.map(async (fileName) => {
    const body = await readFile(path.join(examplesDir, fileName), 'utf8')
    const firstHeading = body.match(/^#\s+(.+)$/mu)?.[1]?.trim()
    return {
      id: fileName.replace(/\.md$/u, ''),
      title: firstHeading ?? fileName.replace(/[-_]/gu, ' ').replace(/\.md$/u, ''),
      body,
    }
  }))
}

async function readAutomations(packageDir: string): Promise<CommanderPackageAutomation[]> {
  const filePath = path.join(packageDir, 'automations.manifest.json')
  const manifest = await readJson<RawAutomationsManifest>(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { automations: [] }
    }
    throw error
  })
  const automations = Array.isArray(manifest.automations) ? manifest.automations : []
  return automations.map((entry) => parseAutomationEntry(entry, packageDir))
}

export async function loadCommanderPackage(
  packageId: string,
  root?: string,
): Promise<CommanderPackageDefinition | null> {
  const safeId = packageId.trim()
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(safeId)) {
    return null
  }

  const packagesRoot = root ?? await resolveBundledPackagesRoot()
  const packageDir = path.join(packagesRoot, safeId)
  try {
    const manifest = await readJson<RawPackageManifest>(path.join(packageDir, 'package.json'))
    const skillsManifest = await readJson<RawSkillsManifest>(path.join(packageDir, 'skills.manifest.json'))
    const required = Array.isArray(skillsManifest.required) ? skillsManifest.required : []
    const optional = Array.isArray(skillsManifest.optional) ? skillsManifest.optional : []
    const uiProfile = sanitizeUiProfile(manifest.uiProfile)

    return {
      schemaVersion: 1,
      id: requireString(manifest.id, 'id', packageDir),
      version: requireString(manifest.version, 'version', packageDir),
      displayName: requireString(manifest.displayName, 'displayName', packageDir),
      host: requireString(manifest.host, 'host', packageDir),
      role: requireString(manifest.role, 'role', packageDir),
      summary: requireString(manifest.summary, 'summary', packageDir),
      description: requireString(manifest.description, 'description', packageDir),
      agentType: parseAgentType(manifest.agentType),
      effort: isClaudeEffortLevel(manifest.effort)
        ? manifest.effort
        : DEFAULT_CLAUDE_EFFORT_LEVEL,
      contextMode: parseContextMode(manifest.contextMode),
      uiProfile: uiProfile ?? {},
      skills: [
        ...required.map((entry) => parseSkillEntry(entry, true)),
        ...optional.map((entry) => parseSkillEntry(entry, false)),
      ],
      automations: await readAutomations(packageDir),
      examples: await readExamples(packageDir),
      commanderMd: await readFile(path.join(packageDir, 'COMMANDER.md'), 'utf8'),
      onboarding: await readFile(path.join(packageDir, 'onboarding.md'), 'utf8'),
      memorySeed: await readFile(path.join(packageDir, 'memory-seed.md'), 'utf8'),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function listCommanderPackages(
  root?: string,
): Promise<CommanderPackageDefinition[]> {
  const packagesRoot = root ?? await resolveBundledPackagesRoot()
  const entries = await readdir(packagesRoot, { withFileTypes: true })
  const packages = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => loadCommanderPackage(entry.name, packagesRoot)),
  )
  return packages
    .filter((definition): definition is CommanderPackageDefinition => Boolean(definition))
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
}
