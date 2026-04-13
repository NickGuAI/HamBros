import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveCommanderPaths } from '../paths.js'
import { COMMANDER_WORKFLOW_FILE } from '../workflow.js'

export const COMMANDER_WORKFLOW_TEMPLATE_FILE = 'COMMANDER.template.md'

const DEFAULT_COMMANDER_WORKFLOW_TEMPLATE = `---
# heartbeat fire interval in milliseconds (default: 300000 = 5 min)
# heartbeat.interval: 900000
#
# override the default heartbeat message sent to the agent
# heartbeat.message: "Check your quest board. What is your current task? Post a progress note, then continue or pick up the next quest."
#
# max agent turns per session start (1–10, default: 3)
# maxTurns: 3
#
# context delivery mode: "fat" (full) or "thin" (3000-token budget)
# contextMode: fat
#
# System prompt: add text below the closing --- to replace the default Commander prompt.
---

You are [NAME], engineering commander for Gehirn / Pioneering Minds AI.
Workspace: [WORKSPACE_CWD]

## Quest Board (your primary work queue)

\`\`\`
hammurabi quests list
hammurabi quests claim <quest-id>
hammurabi quests note <quest-id> "<progress text>"
hammurabi quests done <quest-id> --note "<summary>"
\`\`\`

Rules:
- Check the board before doing anything.
- Claim one quest at a time.
- Post a progress note before context compacts or before handing off work.
- Never mark done without a completion note.

## Memory

Your memory lives on disk. When you need context, read it yourself. Do not wait for a heartbeat to inject memory files mechanically.

### Files

- \`.memory/MEMORY.md\` for the main durable memory store
- \`.memory/LONG_TERM_MEM.md\` for distilled long-term context
- \`.memory/working-memory.md\` for the active scratchpad
- \`.memory/journal/\` for timestamped work logs and prior outcomes

### Commands

\`\`\`
cat .memory/MEMORY.md
cat .memory/LONG_TERM_MEM.md
cat .memory/working-memory.md
ls .memory/journal
hammurabi memory find --commander [COMMANDER_ID] "<query>"
hammurabi memory save --commander [COMMANDER_ID] "<fact>"
hammurabi memory compact --commander [COMMANDER_ID]
\`\`\`

### When to read

- Before acting on prior context, file paths, or decisions
- When a quest or heartbeat references earlier work
- When you need exact facts instead of fuzzy recollection

### When to save

- After discovering durable facts, decisions, paths, or commands
- After major progress so future recalls stay high-signal
- After compaction or when the task direction changes materially

Rules:
- Use \`cat\` when you know the file you need; use \`hammurabi memory find\` when you need recall.
- Save durable facts, not transient chatter.
- Compact after major work or context pressure.
`

export interface CommanderWorkflowTemplateInput {
  commanderId: string
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

export async function ensureCommanderWorkflowTemplate(dataDir: string): Promise<string> {
  const templatePath = path.join(dataDir, COMMANDER_WORKFLOW_TEMPLATE_FILE)
  try {
    return await readFile(templatePath, 'utf8')
  } catch {
    await mkdir(dataDir, { recursive: true })
    await writeFile(templatePath, DEFAULT_COMMANDER_WORKFLOW_TEMPLATE, 'utf8')
    return DEFAULT_COMMANDER_WORKFLOW_TEMPLATE
  }
}

export function renderCommanderWorkflow(
  template: string,
  input: CommanderWorkflowTemplateInput,
): string {
  const workspaceCwd = normalizeOptional(input.cwd) ?? '_not provided_'
  const withCommanderId = replaceTemplateToken(template, '[COMMANDER_ID]', input.commanderId)
  const withWorkspace = replaceTemplateToken(withCommanderId, '[WORKSPACE_CWD]', workspaceCwd)
  return `${withWorkspace.trimEnd()}\n`
}

export async function scaffoldCommanderWorkflow(
  commanderId: string,
  input: Omit<CommanderWorkflowTemplateInput, 'commanderId'>,
  basePath?: string,
): Promise<string> {
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
    })
    await writeFile(workflowPath, rendered, 'utf8')
    return workflowPath
  }
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
