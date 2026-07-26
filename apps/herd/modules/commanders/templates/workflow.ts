import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCommanderPaths } from '../paths.js'
import { resolveCommanderDataDir } from '../paths.js'
import { withCommanderMutation } from '../child-mutation-coordinator.js'
import {
  COMMANDER_WORKFLOW_FILE,
  REMOVED_COMMANDER_FRONTMATTER_KEYS,
} from '../workflow.js'

export const COMMANDER_WORKFLOW_TEMPLATE_FILE = 'COMMANDER.template.md'
export const COMMANDER_WORKFLOW_SOURCE_TEMPLATE_FILE = 'workflow.md.template'
export const COMMANDER_IDENTITY_OPERATING_STYLE_HEADING = '## Identity and Operating Style'

const MODULE_TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  COMMANDER_WORKFLOW_SOURCE_TEMPLATE_FILE,
)
const SOURCE_TEMPLATE_PATH = path.join(
  process.cwd(),
  'modules/commanders/templates',
  COMMANDER_WORKFLOW_SOURCE_TEMPLATE_FILE,
)

export interface CommanderWorkflowTemplateInput {
  commanderId: string
  displayName?: string
  cwd?: string
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function replaceTemplateToken(template: string, token: string, value: string): string {
  return template.split(token).join(value)
}

async function loadCommanderWorkflowTemplate(): Promise<string> {
  const candidates = [MODULE_TEMPLATE_PATH, SOURCE_TEMPLATE_PATH]
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8')
    } catch {
      // Try the next known location. Built JS may run from dist-server while templates
      // remain in the source tree.
    }
  }
  throw new Error(`Commander workflow template not found: ${candidates.join(', ')}`)
}

function cachedTemplateContainsRemovedRuntimeConfig(template: string): boolean {
  const normalized = template.replace(/\r\n/g, '\n')
  const frontMatterMatch = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!frontMatterMatch) {
    return false
  }

  const [, frontMatter] = frontMatterMatch
  for (const rawLine of frontMatter.split('\n')) {
    const uncommented = rawLine.trim().replace(/^#\s*/, '').trim()
    const match = uncommented.match(/^([a-zA-Z0-9_.-]+)\s*:/)
    if (match && REMOVED_COMMANDER_FRONTMATTER_KEYS.has(match[1])) {
      return true
    }
  }
  return false
}

export async function ensureCommanderWorkflowTemplate(dataDir: string): Promise<string> {
  const templatePath = path.join(dataDir, COMMANDER_WORKFLOW_TEMPLATE_FILE)
  try {
    const cachedTemplate = await readFile(templatePath, 'utf8')
    if (!cachedTemplateContainsRemovedRuntimeConfig(cachedTemplate)) {
      return cachedTemplate
    }

    const template = await loadCommanderWorkflowTemplate()
    await writeFile(templatePath, template, 'utf8')
    return template
  } catch {
    const template = await loadCommanderWorkflowTemplate()
    await mkdir(dataDir, { recursive: true })
    await writeFile(templatePath, template, 'utf8')
    return template
  }
}

export function renderCommanderWorkflow(
  template: string,
  input: CommanderWorkflowTemplateInput,
): string {
  const commanderName = normalizeOptional(input.displayName) ?? 'Commander'
  const workspaceCwd = normalizeOptional(input.cwd) ?? '_not provided_'
  const withCommanderName = replaceTemplateToken(template, '[NAME]', commanderName)
  const withCommanderId = replaceTemplateToken(withCommanderName, '[COMMANDER_ID]', input.commanderId)
  const withWorkspace = replaceTemplateToken(withCommanderId, '[WORKSPACE_CWD]', workspaceCwd)
  return `${withWorkspace.trimEnd()}\n`
}

export function mergeIdentityOperatingStyleIntoCommanderWorkflowContent(
  content: string,
  identityOperatingStyle: string | undefined,
): string {
  const operatingStyle = normalizeOptional(identityOperatingStyle)
  const normalized = content.replace(/\r\n/g, '\n').trimEnd()
  if (!operatingStyle) {
    return `${normalized}\n`
  }
  if (normalized.includes(operatingStyle)) {
    return `${normalized}\n`
  }

  const section = [
    COMMANDER_IDENTITY_OPERATING_STYLE_HEADING,
    '',
    operatingStyle,
  ].join('\n')
  const sharedKnowledgeMarker = '\n## Shared Knowledge Bootstrap'
  const markerIndex = normalized.indexOf(sharedKnowledgeMarker)
  if (markerIndex >= 0) {
    const before = normalized.slice(0, markerIndex).trimEnd()
    const after = normalized.slice(markerIndex).trimStart()
    return `${before}\n\n${section}\n\n${after}\n`
  }

  return `${normalized}\n\n${section}\n`
}

export async function scaffoldCommanderWorkflow(
  commanderId: string,
  input: Omit<CommanderWorkflowTemplateInput, 'commanderId'>,
  basePath?: string,
  lifecycleScope = basePath ?? resolveCommanderDataDir(),
): Promise<string> {
  return withCommanderMutation(commanderId, lifecycleScope, async () => {
    const { commanderRoot, dataDir } = resolveCommanderPaths(commanderId, basePath)
    await mkdir(commanderRoot, { recursive: true })

    const workflowPath = path.join(commanderRoot, COMMANDER_WORKFLOW_FILE)
    try {
      await access(workflowPath)
      return workflowPath
    } catch {
      const template = await ensureCommanderWorkflowTemplate(dataDir)
      const rendered = renderCommanderWorkflow(template, {
        commanderId,
        cwd: input.cwd,
        displayName: input.displayName,
      })
      await writeFile(workflowPath, rendered, 'utf8')
      return workflowPath
    }
  })
}

export async function mergeIdentityOperatingStyleIntoCommanderWorkflow(
  commanderId: string,
  identityOperatingStyle: string | undefined,
  options: {
    cwd?: string
    displayName?: string
    basePath?: string
    lifecycleScope?: string
  } = {},
): Promise<{ workflowPath: string; updated: boolean }> {
  const lifecycleScope = options.lifecycleScope ?? options.basePath ?? resolveCommanderDataDir()
  return withCommanderMutation(commanderId, lifecycleScope, async () => {
    const workflowPath = await scaffoldCommanderWorkflow(
      commanderId,
      {
        cwd: options.cwd,
        displayName: options.displayName,
      },
      options.basePath,
      lifecycleScope,
    )
    const current = await readFile(workflowPath, 'utf8')
    const rendered = renderCommanderWorkflow(current, {
      commanderId,
      cwd: options.cwd,
      displayName: options.displayName,
    })
    const next = mergeIdentityOperatingStyleIntoCommanderWorkflowContent(rendered, identityOperatingStyle)
    if (next === current) {
      return { workflowPath, updated: false }
    }

    await writeFile(workflowPath, next, 'utf8')
    return { workflowPath, updated: true }
  })
}

export async function readCommanderWorkflowMarkdown(
  commanderId: string,
  basePath?: string,
): Promise<string | null> {
  const { commanderRoot } = resolveCommanderPaths(commanderId, basePath)
  const workflowPath = path.join(commanderRoot, COMMANDER_WORKFLOW_FILE)
  try {
    return await readFile(workflowPath, 'utf8')
  } catch {
    return null
  }
}

export async function writeCommanderWorkflowMarkdown(
  commanderId: string,
  markdown: string,
  basePath?: string,
  lifecycleScope = basePath ?? resolveCommanderDataDir(),
): Promise<void> {
  await withCommanderMutation(commanderId, lifecycleScope, async () => {
    const { commanderRoot } = resolveCommanderPaths(commanderId, basePath)
    await mkdir(commanderRoot, { recursive: true })
    await writeFile(
      path.join(commanderRoot, COMMANDER_WORKFLOW_FILE),
      `${markdown.trimEnd()}\n`,
      'utf8',
    )
  })
}
