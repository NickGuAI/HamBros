import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMMANDER_WORKFLOW_TEMPLATE_FILE,
  renderCommanderWorkflow,
  scaffoldCommanderWorkflow,
} from '../workflow.js'

const tempDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('commander workflow template scaffolding', () => {
  it('renders commander-specific memory commands from the template', () => {
    const rendered = renderCommanderWorkflow(
      [
        'Workspace: [WORKSPACE_CWD]',
        'hammurabi memory find --commander [COMMANDER_ID] "<query>"',
      ].join('\n'),
      {
        commanderId: 'cmdr-workflow-1',
        cwd: '/workspace/example-repo',
      },
    )

    expect(rendered).toContain('Workspace: /workspace/example-repo')
    expect(rendered).toContain('hammurabi memory find --commander cmdr-workflow-1 "<query>"')
  })

  it('scaffolds both the shared template and per-commander COMMANDER.md', async () => {
    const dir = await createTempDir('hammurabi-workflow-template-')
    const workflowPath = await scaffoldCommanderWorkflow(
      'cmdr-workflow-2',
      {
        cwd: '/workspace/forge',
      },
      dir,
    )

    expect(workflowPath).toBe(join(dir, 'cmdr-workflow-2', 'COMMANDER.md'))

    const template = await readFile(join(dir, COMMANDER_WORKFLOW_TEMPLATE_FILE), 'utf8')
    expect(template).toContain('[COMMANDER_ID]')
    expect(template).toContain('## Memory')

    const written = await readFile(workflowPath, 'utf8')
    expect(written).toContain('/workspace/forge')
    expect(written).toContain('hammurabi memory save --commander cmdr-workflow-2 "<fact>"')
    expect(written).toContain('.memory/working-memory.md')
  })

  it('uses an existing shared template when present', async () => {
    const dir = await createTempDir('hammurabi-workflow-existing-template-')
    await writeFile(
      join(dir, COMMANDER_WORKFLOW_TEMPLATE_FILE),
      'Commander [COMMANDER_ID] @ [WORKSPACE_CWD]\n',
      'utf8',
    )

    const workflowPath = await scaffoldCommanderWorkflow(
      'cmdr-workflow-3',
      {
        cwd: '/workspace/custom',
      },
      dir,
    )

    const written = await readFile(workflowPath, 'utf8')
    expect(written).toBe('Commander cmdr-workflow-3 @ /workspace/custom\n')
  })
})
