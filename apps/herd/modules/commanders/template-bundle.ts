import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validateModelForAgentType } from '../agents/providers/validate-model.js'
import type { AgentType } from '../agents/types.js'
import {
  parseOptionalAutomationAgentType,
  resolveDefaultAutomationAgentType,
} from '../automations/agent-type.js'
import type { Automation, AutomationQuestTrigger, AutomationStatus, AutomationTrigger } from '../automations/types.js'
import type { CreateAutomationInput } from '../automations/store.js'
import {
  getSkillPackageDetail,
  parseFrontmatter,
  type SkillPackageDetail,
} from '../skills/package-discovery.js'
import { resolveCommanderPaths } from './paths.js'
import { withCommanderMutation } from './child-mutation-coordinator.js'
import type {
  CommanderPackageAutomation,
  CommanderPackageSkill,
} from './packages/types.js'

export const COMMANDER_TEMPLATE_SCHEMA_VERSION = 2

const SKILL_DIR_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u
const SKIPPED_BUNDLE_DIRS = new Set(['.git', 'node_modules', 'dist', '.turbo'])

export interface CommanderTemplateSkillFile {
  path: string
  contentBase64: string
}

type CommanderTemplateSkillReferenceReason = 'not-found' | 'not-bundleable'

export interface CommanderTemplateSkillBinding {
  skillId: string
  label?: string
  purpose?: string
  required?: boolean
  source: 'commander-local' | 'installed-skill' | 'reference'
  bundle?: {
    dirName: string
    files: CommanderTemplateSkillFile[]
  }
  reference?: {
    reason: CommanderTemplateSkillReferenceReason
    source?: string
    displayDirectory?: string
  }
}

export interface CommanderBundleAutomation extends CommanderPackageAutomation {
  sourceAutomationId?: string
  sourceTemplateId?: string
  sourceConversationId?: string
}

interface BundleCommanderSkillsInput {
  commanderId: string
  commanderBasePath: string
  automations: readonly Automation[]
}

interface BundledSkillMetadata {
  label: string
  purpose: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function parseOptionalString(value: unknown): string | undefined {
  return parseNonEmptyString(value) ?? undefined
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

function isSafeSkillDirName(value: string): boolean {
  return SKILL_DIR_NAME_PATTERN.test(value)
}

function isSafeBundleFilePath(value: string): boolean {
  const normalized = path.posix.normalize(value)
  return value.length > 0 &&
    normalized === value &&
    !value.startsWith('/') &&
    !value.split('/').includes('..')
}

function trimInstructionForPurpose(instruction: string): string {
  const normalized = instruction.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= 160) {
    return normalized
  }
  return `${normalized.slice(0, 157).trimEnd()}...`
}

function skillMetadataFromSkillMd(skillId: string, skillMd: string): BundledSkillMetadata {
  const frontmatter = parseFrontmatter(skillMd)
  const label = typeof frontmatter.name === 'string' && frontmatter.name.trim()
    ? frontmatter.name.trim()
    : skillId
  const purpose = typeof frontmatter.description === 'string' && frontmatter.description.trim()
    ? frontmatter.description.trim()
    : `Bundled skill package ${skillId}.`
  return { label, purpose }
}

async function listSkillDirectoryFiles(root: string): Promise<CommanderTemplateSkillFile[]> {
  const files: CommanderTemplateSkillFile[] = []

  async function walk(current: string, relativeDir = ''): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && SKIPPED_BUNDLE_DIRS.has(entry.name)) {
        continue
      }

      const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name
      const absolutePath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      if (!isSafeBundleFilePath(relativePath)) {
        throw new Error(`Unsafe skill bundle file path: ${relativePath}`)
      }
      const content = await readFile(absolutePath)
      files.push({
        path: relativePath,
        contentBase64: content.toString('base64'),
      })
    }
  }

  await walk(root)
  return files
}

async function tryBundleSkillDirectory(args: {
  skillId: string
  directory: string
  source: CommanderTemplateSkillBinding['source']
  required: boolean
  detail?: SkillPackageDetail
}): Promise<{
  skill: CommanderPackageSkill
  binding: CommanderTemplateSkillBinding
}> {
  if (!isSafeSkillDirName(args.skillId)) {
    throw new Error(`Unsafe skill id: ${args.skillId}`)
  }

  const skillMd = await readFile(path.join(args.directory, 'SKILL.md'), 'utf8')
  const metadata = args.detail
    ? {
      label: args.detail.name,
      purpose: args.detail.description || `Bundled skill package ${args.skillId}.`,
    }
    : skillMetadataFromSkillMd(args.skillId, skillMd)
  const files = await listSkillDirectoryFiles(args.directory)
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new Error(`Skill ${args.skillId} has no SKILL.md`)
  }

  return {
    skill: {
      id: args.skillId,
      label: metadata.label,
      purpose: metadata.purpose,
      required: args.required,
    },
    binding: {
      skillId: args.skillId,
      label: metadata.label,
      purpose: metadata.purpose,
      required: args.required,
      source: args.source,
      bundle: {
        dirName: args.skillId,
        files,
      },
    },
  }
}

function buildReferenceSkill(
  skillId: string,
  required: boolean,
  reason: CommanderTemplateSkillReferenceReason,
  detail?: SkillPackageDetail,
): {
  skill: CommanderPackageSkill
  binding: CommanderTemplateSkillBinding
} {
  const label = detail?.name ?? skillId
  const purpose = detail?.description || 'Referenced skill was not available to bundle.'
  return {
    skill: {
      id: skillId,
      label,
      purpose,
      required,
    },
    binding: {
      skillId,
      label,
      purpose,
      required,
      source: 'reference',
      reference: {
        reason,
        ...(detail ? { source: detail.source, displayDirectory: detail.displayDirectory } : {}),
      },
    },
  }
}

async function readCommanderLocalSkillNames(skillsRoot: string): Promise<string[]> {
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => [])
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSkillDirName(entry.name)) {
      continue
    }
    try {
      const skillMd = path.join(skillsRoot, entry.name, 'SKILL.md')
      if ((await stat(skillMd)).isFile()) {
        names.push(entry.name)
      }
    } catch {
      // Ignore malformed commander-local skill directories.
    }
  }
  return names.sort((left, right) => left.localeCompare(right))
}

export async function collectCommanderBundleSkills(
  input: BundleCommanderSkillsInput,
): Promise<{
  skills: CommanderPackageSkill[]
  skillBindings: CommanderTemplateSkillBinding[]
}> {
  const { skillsRoot } = resolveCommanderPaths(input.commanderId, input.commanderBasePath)
  const localSkillNames = await readCommanderLocalSkillNames(skillsRoot)
  const automationSkillNames = input.automations.flatMap((automation) => automation.skills)
  const requiredSkillNames = new Set(
    automationSkillNames.map((entry) => entry.trim()).filter(Boolean),
  )
  const orderedSkillNames = [
    ...localSkillNames,
    ...automationSkillNames,
  ].map((entry) => entry.trim()).filter(Boolean)
  const uniqueSkillNames = [...new Set(orderedSkillNames)]

  const skills: CommanderPackageSkill[] = []
  const skillBindings: CommanderTemplateSkillBinding[] = []
  for (const skillId of uniqueSkillNames) {
    const required = requiredSkillNames.has(skillId)
    if (!isSafeSkillDirName(skillId)) {
      const fallback = buildReferenceSkill(skillId, required, 'not-bundleable')
      skills.push(fallback.skill)
      skillBindings.push(fallback.binding)
      continue
    }

    const localDirectory = path.join(skillsRoot, skillId)
    try {
      const localSkillMd = path.join(localDirectory, 'SKILL.md')
      if ((await stat(localSkillMd)).isFile()) {
        const bundled = await tryBundleSkillDirectory({
          skillId,
          directory: localDirectory,
          source: 'commander-local',
          required,
        })
        skills.push(bundled.skill)
        skillBindings.push(bundled.binding)
        continue
      }
    } catch {
      // Fall back to globally discovered installed skills below.
    }

    const detail = await getSkillPackageDetail(skillId)
    if (detail) {
      try {
        const bundled = await tryBundleSkillDirectory({
          skillId,
          directory: detail.directory,
          source: 'installed-skill',
          required,
          detail,
        })
        skills.push(bundled.skill)
        skillBindings.push(bundled.binding)
        continue
      } catch {
        const fallback = buildReferenceSkill(skillId, required, 'not-bundleable', detail)
        skills.push(fallback.skill)
        skillBindings.push(fallback.binding)
        continue
      }
    }

    const fallback = buildReferenceSkill(skillId, required, 'not-found')
    skills.push(fallback.skill)
    skillBindings.push(fallback.binding)
  }

  return { skills, skillBindings }
}

export function toCommanderBundleAutomation(automation: Automation): CommanderBundleAutomation {
  return {
    id: automation.name,
    label: automation.name,
    purpose: automation.description?.trim() || trimInstructionForPurpose(automation.instruction),
    trigger: automation.trigger,
    ...(automation.schedule ? { schedule: automation.schedule } : {}),
    ...(automation.questTrigger ? { questTrigger: { ...automation.questTrigger } } : {}),
    instruction: automation.instruction,
    agentType: automation.agentType,
    status: automation.status,
    ...(automation.description ? { description: automation.description } : {}),
    ...(automation.timezone ? { timezone: automation.timezone } : {}),
    skills: [...automation.skills],
    ...(automation.machine ? { machine: automation.machine } : {}),
    ...(automation.workDir ? { workDir: automation.workDir } : {}),
    ...(automation.model ? { model: automation.model } : {}),
    ...(automation.sessionType ? { sessionType: automation.sessionType } : {}),
    ...(automation.seedMemory !== undefined ? { seedMemory: automation.seedMemory } : {}),
    ...(automation.maxRuns !== undefined ? { maxRuns: automation.maxRuns } : {}),
    sourceAutomationId: automation.id,
    ...(automation.templateId ? { sourceTemplateId: automation.templateId } : {}),
    ...(automation.sourceConversationId ? { sourceConversationId: automation.sourceConversationId } : {}),
  }
}

function parseAutomationTrigger(value: unknown): AutomationTrigger | null {
  return value === 'schedule' || value === 'quest' || value === 'manual' ? value : null
}

function parseAutomationStatus(value: unknown): AutomationStatus {
  return value === 'active' || value === 'paused' || value === 'completed' || value === 'cancelled'
    ? value
    : 'paused'
}

function parseQuestTrigger(value: unknown): AutomationQuestTrigger | undefined {
  if (!isRecord(value) || value.event !== 'completed') {
    return undefined
  }
  const commanderId = parseOptionalString(value.commanderId)
  return {
    event: 'completed',
    ...(commanderId ? { commanderId } : {}),
  }
}

function parseSkills(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => parseNonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry))
}

function parseCommanderBundleAutomation(
  raw: unknown,
  index: number,
): { ok: true; value: CommanderBundleAutomation } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: `automations[${index}] must be an object` }
  }

  const id = parseNonEmptyString(raw.id)
  const instruction = parseNonEmptyString(raw.instruction)
  const trigger = parseAutomationTrigger(raw.trigger)
  if (!id) {
    return { ok: false, error: `automations[${index}].id is required` }
  }
  if (!trigger) {
    return { ok: false, error: `automations[${index}].trigger must be schedule, quest, or manual` }
  }
  if (!instruction) {
    return { ok: false, error: `automations[${index}].instruction is required` }
  }

  const schedule = parseOptionalString(raw.schedule)
  const questTrigger = parseQuestTrigger(raw.questTrigger)
  if (trigger === 'schedule' && !schedule) {
    return { ok: false, error: `automations[${index}].schedule is required for schedule triggers` }
  }
  if (trigger === 'quest' && !questTrigger) {
    return { ok: false, error: `automations[${index}].questTrigger is required for quest triggers` }
  }

  const sessionType = raw.sessionType === 'pty' || raw.sessionType === 'stream'
    ? raw.sessionType
    : undefined
  const purpose = parseOptionalString(raw.purpose) ?? trimInstructionForPurpose(instruction)
  const label = parseOptionalString(raw.label) ?? id
  // Bundled provider/model pairs must satisfy the same invariant as the
  // /api/automations route: a declared agentType has to be a registered
  // provider that supports automations, and a model paired with it has to be
  // valid for that provider. Rejecting here surfaces a 400 to the importer
  // instead of creating an automation that fails when scheduled or run.
  const agentType = parseOptionalAutomationAgentType(parseOptionalString(raw.agentType))
  if (agentType === null) {
    return { ok: false, error: `automations[${index}].agentType must be a supported automation provider` }
  }
  const model = parseOptionalString(raw.model)
  if (agentType && model) {
    const modelValidation = validateModelForAgentType(agentType, model)
    if (!modelValidation.ok) {
      return { ok: false, error: `automations[${index}].model is invalid: ${modelValidation.error}` }
    }
  }

  return {
    ok: true,
    value: {
      id,
      label,
      purpose,
      trigger,
      ...(schedule ? { schedule } : {}),
      ...(questTrigger ? { questTrigger } : {}),
      instruction,
      ...(agentType ? { agentType } : {}),
      status: parseAutomationStatus(raw.status),
      ...(parseOptionalString(raw.description) ? { description: parseOptionalString(raw.description) } : {}),
      ...(parseOptionalString(raw.timezone) ? { timezone: parseOptionalString(raw.timezone) } : {}),
      skills: parseSkills(raw.skills),
      ...(parseOptionalString(raw.machine) ? { machine: parseOptionalString(raw.machine) } : {}),
      ...(parseOptionalString(raw.workDir) ? { workDir: parseOptionalString(raw.workDir) } : {}),
      ...(model ? { model } : {}),
      ...(sessionType ? { sessionType } : {}),
      ...(typeof raw.seedMemory === 'string' ? { seedMemory: raw.seedMemory } : {}),
      ...(parsePositiveInteger(raw.maxRuns) ? { maxRuns: parsePositiveInteger(raw.maxRuns) } : {}),
      ...(parseOptionalString(raw.sourceAutomationId) ? { sourceAutomationId: parseOptionalString(raw.sourceAutomationId) } : {}),
      ...(parseOptionalString(raw.sourceTemplateId) ? { sourceTemplateId: parseOptionalString(raw.sourceTemplateId) } : {}),
      ...(parseOptionalString(raw.sourceConversationId) ? { sourceConversationId: parseOptionalString(raw.sourceConversationId) } : {}),
    },
  }
}

export function parseCommanderBundleAutomations(
  raw: unknown,
): { ok: true; value: CommanderBundleAutomation[] } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: [] }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'automations must be an array when provided' }
  }
  const automations: CommanderBundleAutomation[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseCommanderBundleAutomation(raw[index], index)
    if (!parsed.ok) {
      return parsed
    }
    automations.push(parsed.value)
  }
  return { ok: true, value: automations }
}

function parseSkillBundleFiles(
  raw: unknown,
  context: string,
): { ok: true; value: CommanderTemplateSkillFile[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${context}.files must be an array` }
  }

  const files: CommanderTemplateSkillFile[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index]
    if (!isRecord(entry)) {
      return { ok: false, error: `${context}.files[${index}] must be an object` }
    }
    const filePath = parseNonEmptyString(entry.path)
    const contentBase64 = parseNonEmptyString(entry.contentBase64)
    if (!filePath || !isSafeBundleFilePath(filePath)) {
      return { ok: false, error: `${context}.files[${index}].path is invalid` }
    }
    if (!contentBase64) {
      return { ok: false, error: `${context}.files[${index}].contentBase64 is required` }
    }
    files.push({ path: filePath, contentBase64 })
  }

  return { ok: true, value: files }
}

function parseSkillBinding(
  raw: unknown,
  index: number,
): { ok: true; value: CommanderTemplateSkillBinding } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: `skillBindings[${index}] must be an object` }
  }

  const skillId = parseNonEmptyString(raw.skillId)
  if (!skillId || !isSafeSkillDirName(skillId)) {
    return { ok: false, error: `skillBindings[${index}].skillId is invalid` }
  }

  const source = raw.source === 'commander-local' || raw.source === 'installed-skill' || raw.source === 'reference'
    ? raw.source
    : 'reference'
  const bundle = isRecord(raw.bundle) ? raw.bundle : null
  let parsedBundle: CommanderTemplateSkillBinding['bundle']
  if (bundle) {
    const dirName = parseNonEmptyString(bundle.dirName)
    if (!dirName || !isSafeSkillDirName(dirName)) {
      return { ok: false, error: `skillBindings[${index}].bundle.dirName is invalid` }
    }
    const files = parseSkillBundleFiles(bundle.files, `skillBindings[${index}].bundle`)
    if (!files.ok) {
      return files
    }
    if (!files.value.some((file) => file.path === 'SKILL.md')) {
      return { ok: false, error: `skillBindings[${index}].bundle.files must include SKILL.md` }
    }
    parsedBundle = { dirName, files: files.value }
  }

  return {
    ok: true,
    value: {
      skillId,
      ...(parseOptionalString(raw.label) ? { label: parseOptionalString(raw.label) } : {}),
      ...(parseOptionalString(raw.purpose) ? { purpose: parseOptionalString(raw.purpose) } : {}),
      ...(typeof raw.required === 'boolean' ? { required: raw.required } : {}),
      source: parsedBundle ? source : 'reference',
      ...(parsedBundle ? { bundle: parsedBundle } : {}),
      ...(!parsedBundle ? {
        reference: {
          reason: 'not-found',
        },
      } : {}),
    },
  }
}

export function parseCommanderBundleSkillBindings(
  raw: unknown,
): { ok: true; value: CommanderTemplateSkillBinding[] } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: [] }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'skillBindings must be an array when provided' }
  }

  const bindings: CommanderTemplateSkillBinding[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseSkillBinding(raw[index], index)
    if (!parsed.ok) {
      return parsed
    }
    bindings.push(parsed.value)
  }
  return { ok: true, value: bindings }
}

export async function installCommanderBundleSkills(
  commanderId: string,
  commanderBasePath: string,
  skillBindings: readonly CommanderTemplateSkillBinding[],
  lifecycleScope = commanderBasePath,
): Promise<void> {
  await withCommanderMutation(commanderId, lifecycleScope, async () => {
    const { skillsRoot } = resolveCommanderPaths(commanderId, commanderBasePath)
    await mkdir(skillsRoot, { recursive: true })

    for (const binding of skillBindings) {
      if (!binding.bundle) {
        continue
      }

      const targetRoot = path.join(skillsRoot, binding.bundle.dirName)
      for (const file of binding.bundle.files) {
        const target = path.join(targetRoot, file.path)
        const relative = path.relative(targetRoot, target)
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`Unsafe skill bundle file path: ${file.path}`)
        }
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, Buffer.from(file.contentBase64, 'base64'))
      }
    }
  })
}

export function buildImportedCommanderBundleAutomationInput(args: {
  sourceCommanderId?: string
  commanderId: string
  defaultAgentType: AgentType
  automation: CommanderBundleAutomation
}): CreateAutomationInput {
  const templateId = args.automation.sourceTemplateId
    ?? (args.sourceCommanderId ? `${args.sourceCommanderId}:${args.automation.id}` : undefined)

  // Created automations must always reference an automation-capable provider
  // and a model that provider actually supports. Bundles that declared a
  // valid pair keep it; anything else falls back to the imported commander's
  // default (or the install's automation default when that commander's
  // provider cannot run automations), dropping a model the effective
  // provider does not know.
  const fallbackAgentType = parseOptionalAutomationAgentType(args.defaultAgentType)
    ?? resolveDefaultAutomationAgentType()
    ?? args.defaultAgentType
  const agentType = (
    args.automation.agentType !== undefined
      ? parseOptionalAutomationAgentType(args.automation.agentType)
      : undefined
  ) ?? fallbackAgentType
  const model = args.automation.model && validateModelForAgentType(agentType, args.automation.model).ok
    ? args.automation.model
    : undefined

  return {
    parentCommanderId: args.commanderId,
    name: args.automation.id,
    trigger: args.automation.trigger,
    ...(args.automation.schedule ? { schedule: args.automation.schedule } : {}),
    ...(args.automation.questTrigger ? { questTrigger: { ...args.automation.questTrigger } } : {}),
    instruction: args.automation.instruction,
    agentType,
    permissionMode: 'default',
    skills: [...args.automation.skills],
    ...(templateId ? { templateId } : {}),
    ...(args.automation.sourceConversationId ? { sourceConversationId: args.automation.sourceConversationId } : {}),
    status: args.automation.status,
    description: args.automation.description ?? args.automation.purpose,
    timezone: args.automation.timezone,
    machine: args.automation.machine ?? '',
    workDir: args.automation.workDir,
    model,
    sessionType: args.automation.sessionType,
    seedMemory: args.automation.seedMemory,
    maxRuns: args.automation.maxRuns,
  }
}
