import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AutomationScheduler } from '../../automations/scheduler.js'
import type { AutomationStore, CreateAutomationInput } from '../../automations/store.js'
import type { Automation } from '../../automations/types.js'
import { resolveCommanderPaths } from '../paths.js'
import { withCommanderMutation } from '../child-mutation-coordinator.js'
import { COMMANDER_WORKFLOW_FILE } from '../workflow.js'

export const BENCHMARK_COMMANDER_TEMPLATE_ID = 'benchmark'
export const BENCHMARK_COMMANDER_DISPLAY_NAME = 'Benchmark Commander'
export const BENCHMARK_COMMANDER_HEARTBEAT_MINUTES = 30
export const BENCHMARK_COMMANDER_MAX_TURNS = 300
export const BENCHMARK_COMMANDER_FAT_PIN_INTERVAL = 2
export const BENCHMARK_COMMANDER_TASK_SOURCE = {
  owner: 'NickGuAI',
  repo: 'Herd',
  label: 'benchmark',
} as const
export const BENCHMARK_COMMANDER_AUTOMATION_OPERATOR_ID = 'system-benchmark-commander'

export const BENCHMARK_COMMANDER_PERSONA =
  'Benchmark-only commander. Run benchmark tasks exactly as assigned, keep scope limited to benchmark execution and reporting, and avoid taking on unrelated product or operations work.'

export interface BenchmarkCommanderBootstrapResult {
  written: string[]
  skipped: string[]
}

export interface BenchmarkCommanderAutomationSeedOptions {
  commanderId: string
  executionMachineId: string
  cwd: string
  model?: string | null
  automationStore: AutomationStore
  automationScheduler?: AutomationScheduler
  automationSchedulerInitialized?: Promise<void>
}

export interface BenchmarkCommanderAutomationSeedResult {
  created: string[]
  skipped: string[]
}

function buildBenchmarkCommanderFiles(cwd: string): Record<string, string> {
  return {
    [COMMANDER_WORKFLOW_FILE]: [
      'You are Benchmark Commander.',
      `Workspace: ${cwd}`,
      '',
      '## Identity and Operating Style',
      '',
      BENCHMARK_COMMANDER_PERSONA,
      '',
      '## Benchmark Scope',
      '',
      '- Only run benchmark tasks from `NickGuAI/Herd` with the `benchmark` label.',
      '- Keep changes and notes focused on benchmark setup, execution, results, and regressions.',
      '- Do not pick up unrelated implementation, triage, or operations work.',
      '- Never modify product code while running a benchmark.',
      '- Never write benchmark scores into durable commander memory.',
      '- Never copy `~/.codex`, `~/.claude`, ChatGPT OAuth tokens, Claude OAuth tokens, or equivalent credential files into task containers.',
      '',
      '## Run Checklist',
      '',
      '1. Run `herd eval doctor --bench <bench> --runner <runner-mode>` before dispatch.',
      '2. Select `herd-orchestrated`, `subscription-host-cli`, `subscription-sbx`, `api-key`, or `proxy-experimental` explicitly.',
      '3. Pass the commander cwd as the absolute `--adapter-root` and pass the adapter entry point as an explicit dotted `--adapter-module`; never infer either from a benchmark name.',
      '4. Dispatch one worker per benchmark run unless the adapter documents sharding.',
      '5. Store artifacts under `~/.herd/eval/<YYYY-MM-DD>/<bench>/<run-id>/`.',
      '6. Report run ID, score, pass rate, cost or subscription-limit usage, runtime, failures, and artifact paths.',
      '',
      '## Memory',
      '',
      '- Read `.memory/MEMORY.md` before acting on prior benchmark context.',
      '- Use `.memory/working-memory.md` for active scratch notes during a benchmark run.',
      '- Save durable eval facts only: active baselines, leaderboard auth preconditions, and known flaky benches.',
    ].join('\n'),
    'WORKSPACE.md': [
      '# Workspace',
      '',
      `- Cwd: \`${cwd}\``,
      '- Repository: `NickGuAI/Herd`',
      '- Issue label: `benchmark`',
      '- Adapter root: the commander cwd above; it is an external input and is not bundled with Herd.',
      '- Adapter module: supplied explicitly as a dotted Python module for every eval run.',
      '- Eval result root: `~/.herd/eval/`',
      '',
      'Use this workspace only for benchmark-oriented tasks and artifacts.',
      'Benchmark adapters are external inputs and must not sync into public Herd release artifacts.',
    ].join('\n'),
    'SKILLS.md': [
      '# Skills',
      '',
      '- benchmark-runner: Run `herd eval doctor`, dispatch the benchmark worker, and verify normalized artifacts.',
      '- auth-doctor: Keep subscription CLI auth separate from API-key auth and fail unsafe token-in-container paths.',
      '- telemetry-review: Query telemetry by `metadata.source`, `metadata.run_id`, `metadata.bench`, `metadata.task_id`, `metadata.turn`, and `metadata.runner_mode`.',
      '- issue-reporting: Post concise issue/PR updates with run status, top failures, and artifact links.',
      '- regression-triage: Open follow-up issues only when score deltas exceed configured thresholds.',
    ].join('\n'),
    '.memory/MEMORY.md': [
      '# Benchmark Commander Memory',
      '',
      'Durable eval facts only belong here: active baselines, leaderboard auth preconditions, known flaky benches, and human-approved release-gate policy.',
      '',
      'Do not store benchmark scores, raw trajectories, OAuth credential paths, provider tokens, or active run scratch notes here.',
    ].join('\n'),
    '.memory/working-memory.md': [
      '# Working Memory',
      '',
      'Active benchmark scratch notes belong here: current run ID, worker session, profile, runner mode, blockers, and report checklist.',
    ].join('\n'),
  }
}

export function buildBenchmarkCommanderDefaultAutomations(input: {
  commanderId: string
  executionMachineId: string
  cwd: string
  model?: string | null
}): CreateAutomationInput[] {
  const base = {
    operatorId: BENCHMARK_COMMANDER_AUTOMATION_OPERATOR_ID,
    parentCommanderId: input.commanderId,
    agentType: 'codex' as const,
    permissionMode: 'default' as const,
    machine: input.executionMachineId,
    workDir: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    sessionType: 'stream' as const,
    skills: [],
  }

  return [
    {
      ...base,
      name: 'Benchmark smoke benchmark',
      templateId: 'benchmark-smoke',
      trigger: 'schedule',
      schedule: '0 3 * * *',
      timezone: 'America/New_York',
      description: 'Nightly fast subset across configured benchmark adapters.',
      instruction: 'Run `herd eval doctor` for the configured runner mode, dispatch a smoke benchmark worker, write normalized manifests under ~/.herd/eval, and comment only when the run fails or blocks.',
      seedMemory: 'Nightly smoke benchmark automation for the Benchmark Commander. Keep provider auth and raw OAuth credential files outside task containers.',
      status: 'active',
    },
    {
      ...base,
      name: 'Benchmark weekly baseline',
      templateId: 'benchmark-weekly-baseline',
      trigger: 'schedule',
      schedule: '0 4 * * 1',
      timezone: 'America/New_York',
      description: 'Weekly full configured benchmark matrix.',
      instruction: 'Run the configured weekly baseline matrix, store reports under ~/.herd/eval/reports, and summarize score deltas, failures, runtime, and cost or subscription-limit usage.',
      seedMemory: 'Weekly baseline automation for the Benchmark Commander. Preserve reproducibility fields in config.json before reporting success.',
      status: 'active',
    },
    {
      ...base,
      name: 'Benchmark release gate',
      templateId: 'benchmark-release-gate',
      trigger: 'manual',
      description: 'Manual or release-label release gate using approved runner mode.',
      instruction: 'Run smoke plus selected full benchmarks with `herd-orchestrated`, `api-key`, or an explicitly approved subscription runner, then post a pass/fail release comment with run IDs and artifact paths.',
      seedMemory: 'Manual release-gate automation. Use herd-orchestrated for Terminal-Bench 2 submitted-agent runs. Do not use proxy-experimental or unsafe credential mounting for release gates.',
      status: 'active',
    },
    {
      ...base,
      name: 'Benchmark dashboard refresh',
      templateId: 'benchmark-dashboard-refresh',
      trigger: 'manual',
      description: 'Refresh normalized run manifest visibility after eval completion.',
      instruction: 'Inspect the latest ~/.herd/eval manifests, verify /eval can list runs and filter by benchmark/source/runner mode, and report missing manifests or telemetry metadata.',
      seedMemory: 'Dashboard refresh automation for normalized eval manifests and telemetry metadata checks.',
      status: 'active',
    },
  ]
}

async function deleteSeededAutomation(
  automationId: string,
  options: Pick<BenchmarkCommanderAutomationSeedOptions, 'automationScheduler' | 'automationStore'>,
): Promise<void> {
  if (options.automationScheduler) {
    await options.automationScheduler.deleteAutomation(automationId).catch(() => {})
    return
  }
  await options.automationStore.delete(automationId, { removeFiles: true }).catch(() => {})
}

export async function seedBenchmarkCommanderDefaultAutomations(
  options: BenchmarkCommanderAutomationSeedOptions,
): Promise<BenchmarkCommanderAutomationSeedResult> {
  if (options.automationSchedulerInitialized) {
    await options.automationSchedulerInitialized
  }

  const definitions = buildBenchmarkCommanderDefaultAutomations({
    commanderId: options.commanderId,
    executionMachineId: options.executionMachineId,
    cwd: options.cwd,
    model: options.model,
  })
  const existing = await options.automationStore.list({ parentCommanderId: options.commanderId })
  const existingTemplateIds = new Set(existing.map((automation: Automation) => automation.templateId).filter(Boolean))
  const existingNames = new Set(existing.map((automation: Automation) => automation.name))
  const created: string[] = []
  const skipped: string[] = []

  try {
    for (const definition of definitions) {
      if (
        (definition.templateId && existingTemplateIds.has(definition.templateId))
        || existingNames.has(definition.name)
      ) {
        skipped.push(definition.templateId ?? definition.name)
        continue
      }

      const automation = options.automationScheduler
        ? await options.automationScheduler.createAutomation(definition)
        : await options.automationStore.create(definition)
      created.push(automation.id)
      if (automation.templateId) {
        existingTemplateIds.add(automation.templateId)
      }
      existingNames.add(automation.name)
    }
  } catch (error) {
    for (const automationId of created) {
      await deleteSeededAutomation(automationId, options)
    }
    throw error
  }

  return { created, skipped }
}

function ensureTrailingNewline(content: string): string {
  return `${content.trimEnd()}\n`
}

async function writeFileIfMissing(filePath: string, content: string): Promise<boolean> {
  await mkdir(path.dirname(filePath), { recursive: true })
  try {
    await writeFile(filePath, ensureTrailingNewline(content), { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      return false
    }
    throw error
  }
}

export async function bootstrapBenchmarkCommanderFiles(
  commanderId: string,
  cwd: string,
  basePath?: string,
  lifecycleScope = basePath ?? resolveCommanderPaths(commanderId).dataDir,
): Promise<BenchmarkCommanderBootstrapResult> {
  return withCommanderMutation(commanderId, lifecycleScope, async () => {
    const { commanderRoot } = resolveCommanderPaths(commanderId, basePath)
    await mkdir(commanderRoot, { recursive: true })

    const written: string[] = []
    const skipped: string[] = []
    for (const [relativePath, content] of Object.entries(buildBenchmarkCommanderFiles(cwd))) {
      const didWrite = await writeFileIfMissing(path.join(commanderRoot, relativePath), content)
      if (didWrite) {
        written.push(relativePath)
      } else {
        skipped.push(relativePath)
      }
    }

    return { written, skipped }
  })
}

export function isBenchmarkCommanderMarker(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === BENCHMARK_COMMANDER_TEMPLATE_ID
}
