import { isAbsolute } from 'node:path'
import { formatStoredApiKeyUnauthorizedMessage } from './api-key-recovery.js'
import { type HerdConfig, normalizeEndpoint, readHerdConfig } from './config.js'
import { fetchJson as fetchJsonStrict } from './http-json.js'

interface Writable {
  write(chunk: string): boolean
}

export interface EvalCliDependencies {
  fetchImpl?: typeof fetch
  readConfig?: () => Promise<HerdConfig | null>
  stdout?: Writable
  stderr?: Writable
}

type RunnerMode = 'herd-orchestrated' | 'subscription-host-cli' | 'subscription-sbx' | 'api-key' | 'proxy-experimental'
type EvalProfile = 'smoke' | 'full' | 'release-gate'

interface DoctorOptions {
  bench?: string
  runner?: RunnerMode
}

interface BootstrapOptions {
  host: string
  model: string
  adapterRoot: string
}

interface RunOptions {
  bench: string
  trials: number
  commanderId: string
  profile: EvalProfile
  runner: RunnerMode
  adapterRoot: string
  adapterModule: string
  host?: string
}

const RUNNER_MODES: readonly RunnerMode[] = [
  'herd-orchestrated',
  'subscription-host-cli',
  'subscription-sbx',
  'api-key',
  'proxy-experimental',
]

const EVAL_PROFILES: readonly EvalProfile[] = ['smoke', 'full', 'release-gate']

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  herd eval doctor [--bench <bench>] [--runner herd-orchestrated|subscription-host-cli|subscription-sbx|api-key|proxy-experimental]\n')
  stdout.write('  herd eval commander bootstrap --host <machine-id> --model <model-id> --adapter-root <absolute-path>\n')
  stdout.write('  herd eval list\n')
  stdout.write('  herd eval run <bench> --trials <n> --commander <id> --profile smoke|full|release-gate --runner <runner-mode> --adapter-root <absolute-path> --adapter-module <python.module> [--host <machine-id>]\n')
  stdout.write('  herd eval status <run-id>\n')
  stdout.write('  herd eval report <run-id>\n')
  stdout.write('  herd eval submit <run-id>\n')
  stdout.write('\nBenchmark adapters are external inputs and are not bundled with Herd. Supply their absolute root with `--adapter-root`.\n')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

function parseAbsolutePath(value: string | undefined): string | null {
  const parsed = parseNonEmpty(value)
  // Adapter roots belong to the target machine. Host-platform normalization
  // can rewrite a valid remote path (for example /opt/... on a Windows CLI),
  // so validation must preserve the operator-supplied absolute path verbatim.
  return parsed && isAbsolute(parsed) ? parsed : null
}

function parsePythonModule(value: string | undefined): string | null {
  const parsed = parseNonEmpty(value)
  return parsed && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(parsed)
    ? parsed
    : null
}

function parseRunnerMode(value: string | undefined): RunnerMode | null {
  return RUNNER_MODES.includes(value as RunnerMode) ? (value as RunnerMode) : null
}

function parseProfile(value: string | undefined): EvalProfile | null {
  return EVAL_PROFILES.includes(value as EvalProfile) ? (value as EvalProfile) : null
}

function parsePositiveInteger(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? ''
  if (!/^\d+$/u.test(trimmed)) {
    return null
  }

  const parsed = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function buildApiUrl(endpoint: string, apiPath: string): string {
  return new URL(apiPath, `${normalizeEndpoint(endpoint)}/`).toString()
}

function buildAuthHeaders(config: HerdConfig, includeJsonContentType: boolean): HeadersInit {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
  }

  if (includeJsonContentType) {
    headers['content-type'] = 'application/json'
  }

  return headers
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  return fetchJsonStrict(fetchImpl, url, init)
}

async function readErrorDetail(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.toLowerCase().includes('application/json')

  if (isJson) {
    try {
      const payload = (await response.json()) as unknown
      if (!isObject(payload)) {
        return null
      }

      const message = payload.message
      if (typeof message === 'string' && message.trim().length > 0) {
        return message.trim()
      }

      const error = payload.error
      if (typeof error === 'string' && error.trim().length > 0) {
        return error.trim()
      }
    } catch {
      return null
    }
    return null
  }

  try {
    const text = (await response.text()).trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

async function writeRequestFailure(
  stderr: Writable,
  response: Response,
  config: HerdConfig,
): Promise<void> {
  if (response.status === 401) {
    stderr.write(`${formatStoredApiKeyUnauthorizedMessage({ endpoint: config.endpoint })}\n`)
    return
  }

  const detail = await readErrorDetail(response)
  stderr.write(
    detail
      ? `Request failed (${response.status}): ${detail}\n`
      : `Request failed (${response.status}).\n`,
  )
}

async function resolveConfig(
  dependencies: EvalCliDependencies,
  stderr: Writable,
): Promise<HerdConfig | null> {
  const readConfig = dependencies.readConfig ?? readHerdConfig
  const config = await readConfig()
  if (!config) {
    stderr.write('Herd config not found. Run `herd onboard` first.\n')
    return null
  }

  return config
}

function parseDoctorOptions(args: readonly string[]): DoctorOptions | null {
  const options: DoctorOptions = {}

  for (let index = 0; index < args.length;) {
    const flag = args[index]
    const value = parseNonEmpty(args[index + 1])

    if (flag === '--bench') {
      if (!value) return null
      options.bench = value
      index += 2
      continue
    }

    if (flag === '--runner') {
      const runner = parseRunnerMode(value ?? undefined)
      if (!runner) return null
      options.runner = runner
      index += 2
      continue
    }

    return null
  }

  return options
}

function parseBootstrapOptions(args: readonly string[]): BootstrapOptions | null {
  let host: string | null = null
  let model: string | null = null
  let adapterRoot: string | null = null

  for (let index = 0; index < args.length;) {
    const flag = args[index]
    const value = parseNonEmpty(args[index + 1])

    if (flag === '--host') {
      if (!value) return null
      host = value
      index += 2
      continue
    }

    if (flag === '--model') {
      if (!value) return null
      model = value
      index += 2
      continue
    }

    if (flag === '--adapter-root') {
      adapterRoot = parseAbsolutePath(value ?? undefined)
      if (!adapterRoot) return null
      index += 2
      continue
    }

    return null
  }

  return host && model && adapterRoot ? { host, model, adapterRoot } : null
}

function parseRunOptions(args: readonly string[]): RunOptions | null {
  const bench = parseNonEmpty(args[0])
  if (!bench) {
    return null
  }

  let trials: number | null = null
  let commanderId: string | null = null
  let profile: EvalProfile | null = null
  let runner: RunnerMode | null = null
  let adapterRoot: string | null = null
  let adapterModule: string | null = null
  let host: string | null = null

  for (let index = 1; index < args.length;) {
    const flag = args[index]
    const value = parseNonEmpty(args[index + 1])

    if (flag === '--trials') {
      trials = parsePositiveInteger(value ?? undefined)
      if (trials === null) return null
      index += 2
      continue
    }

    if (flag === '--commander') {
      if (!value) return null
      commanderId = value
      index += 2
      continue
    }

    if (flag === '--profile') {
      profile = parseProfile(value ?? undefined)
      if (!profile) return null
      index += 2
      continue
    }

    if (flag === '--runner') {
      runner = parseRunnerMode(value ?? undefined)
      if (!runner) return null
      index += 2
      continue
    }

    if (flag === '--host') {
      if (!value) return null
      host = value
      index += 2
      continue
    }

    if (flag === '--adapter-root') {
      adapterRoot = parseAbsolutePath(value ?? undefined)
      if (!adapterRoot) return null
      index += 2
      continue
    }

    if (flag === '--adapter-module') {
      adapterModule = parsePythonModule(value ?? undefined)
      if (!adapterModule) return null
      index += 2
      continue
    }

    return null
  }

  if (trials === null || !commanderId || !profile || !runner || !adapterRoot || !adapterModule) {
    return null
  }

  return {
    bench,
    trials,
    commanderId,
    profile,
    runner,
    adapterRoot,
    adapterModule,
    host: host ?? undefined,
  }
}

function buildDoctorUrl(config: HerdConfig, options: DoctorOptions): string {
  const url = new URL(buildApiUrl(config.endpoint, '/api/eval/doctor'))
  if (options.bench) {
    url.searchParams.set('bench', options.bench)
  }
  if (options.runner) {
    url.searchParams.set('runner', options.runner)
  }
  return url.toString()
}

function readStringProperty(payload: unknown, keys: readonly string[]): string | null {
  if (!isObject(payload)) {
    return null
  }

  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

function writeJsonSummary(stdout: Writable, label: string, payload: unknown): void {
  if (payload === null || payload === undefined) {
    stdout.write(`${label} complete.\n`)
    return
  }

  stdout.write(`${label}:\n${JSON.stringify(payload, null, 2)}\n`)
}

function createBenchmarkCommanderPayload(options: BootstrapOptions): Record<string, unknown> {
  return {
    templateId: 'benchmark',
    displayName: 'Benchmark Commander',
    agentType: 'codex',
    host: options.host,
    executionMachineId: options.host,
    model: options.model,
    cwd: options.adapterRoot,
    heartbeat: {
      intervalMs: 1800000,
      messageTemplate: 'Check the benchmark queue, active eval workers, latest run manifests, and auth-doctor status. Report regressions or dispatch the next scheduled benchmark.',
    },
    maxTurns: 300,
    contextMode: 'fat',
    contextConfig: {
      fatPinInterval: 2,
    },
    taskSource: {
      owner: 'NickGuAI',
      repo: 'Herd',
      label: 'benchmark',
    },
  }
}

function sanitizeSessionPart(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return sanitized || 'bench'
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`
}

function buildEvalRunTask(options: RunOptions, sessionName: string): string {
  const smokeFlag = options.profile === 'smoke' ? ' --smoke' : ''
  const adapterCommand = [
    `PYTHONPATH=${shellQuote(options.adapterRoot)}`,
    `HERD_EVAL_COMMANDER_ID=${shellQuote(options.commanderId)}`,
    'python3',
    `-m ${shellQuote(options.adapterModule)}`,
    `--run-id ${shellQuote(sessionName)}`,
    `--bench-id ${shellQuote(options.bench)}`,
    `--profile ${shellQuote(options.profile)}`,
    `--trials ${shellQuote(String(options.trials))}`,
    `--runner-mode ${shellQuote(options.runner)}`,
    `--commander-id ${shellQuote(options.commanderId)}`,
    '--eval-root ~/.herd/eval',
    smokeFlag.trim(),
  ].filter((part) => part.length > 0).join(' ')

  return [
    'Run a Herd benchmark through the stable eval CLI surface.',
    '',
    'Required steps:',
    `1. Run: herd eval doctor --bench ${shellQuote(options.bench)} --runner ${shellQuote(options.runner)}`,
    '2. This dispatched worker session is the first permitted adapter-code execution boundary. If doctor passes, execute the adapter directly exactly once; do not run `herd eval run` inside this worker.',
    `3. Adapter command: ${adapterCommand}`,
    '4. If the adapter command exits non-zero, including an import or dependency failure, stop immediately, report the failure and stderr, and do not record or submit a successful result.',
    '5. Store normalized manifests under the configured Herd eval result root.',
    '6. Report the run ID, score summary, failures, runtime, and artifact paths.',
    options.runner === 'herd-orchestrated'
      ? '7. Orchestrated rule: the supplied adapter must enter through the Herd orchestration boundary; direct Codex/Claude adapters are executor baselines only.'
      : '7. Baseline rule: this direct executor path must not be reported as a Herd-orchestrated score.',
    '',
    'Do not copy, mount, print, or persist raw OAuth credential files or provider credential file paths.',
  ].join('\n')
}

async function runDoctor(
  config: HerdConfig,
  fetchImpl: typeof fetch,
  options: DoctorOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const result = await fetchJson(fetchImpl, buildDoctorUrl(config, options), {
    method: 'GET',
    headers: buildAuthHeaders(config, false),
  })

  if (!result.ok) {
    await writeRequestFailure(stderr, result.response, config)
    return 1
  }

  writeJsonSummary(stdout, 'Eval doctor', result.data)
  return 0
}

async function runBootstrap(
  config: HerdConfig,
  fetchImpl: typeof fetch,
  options: BootstrapOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const result = await fetchJson(fetchImpl, buildApiUrl(config.endpoint, '/api/commanders'), {
    method: 'POST',
    headers: buildAuthHeaders(config, true),
    body: JSON.stringify(createBenchmarkCommanderPayload(options)),
  })

  if (!result.ok) {
    await writeRequestFailure(stderr, result.response, config)
    return 1
  }

  const commanderId = readStringProperty(result.data, ['id', 'commanderId'])
  if (!commanderId) {
    stderr.write('Eval bootstrap response was malformed: expected a commander id.\n')
    return 1
  }

  stdout.write(`Benchmark commander: ${commanderId}\n`)
  return 0
}

async function runList(
  config: HerdConfig,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const result = await fetchJson(fetchImpl, buildApiUrl(config.endpoint, '/api/eval/list'), {
    method: 'GET',
    headers: buildAuthHeaders(config, false),
  })

  if (!result.ok) {
    await writeRequestFailure(stderr, result.response, config)
    return 1
  }

  writeJsonSummary(stdout, 'Eval runs', result.data)
  return 0
}

async function runRun(
  config: HerdConfig,
  fetchImpl: typeof fetch,
  options: RunOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const sessionName = `eval-${sanitizeSessionPart(options.bench)}-${Date.now()}`
  const commanderPath = `/api/commanders/${encodeURIComponent(options.commanderId)}`
  const result = await fetchJson(
    fetchImpl,
    buildApiUrl(config.endpoint, `${commanderPath}/workers`),
    {
      method: 'POST',
      headers: buildAuthHeaders(config, true),
      body: JSON.stringify({
        name: sessionName,
        agentType: 'codex',
        host: options.host,
        cwd: options.adapterRoot,
        evalAdapter: {
          adapterRoot: options.adapterRoot,
          adapterModule: options.adapterModule,
        },
        task: buildEvalRunTask(options, sessionName),
      }),
    },
  )

  if (!result.ok) {
    await writeRequestFailure(stderr, result.response, config)
    return 1
  }

  const returnedSession = readStringProperty(result.data, ['sessionName', 'name'])
  if (!returnedSession) {
    stderr.write('Eval worker dispatch response was malformed: expected a worker session name.\n')
    return 1
  }
  stdout.write(`Eval worker dispatched: ${returnedSession}\n`)
  return 0
}

async function runRunLookup(
  config: HerdConfig,
  fetchImpl: typeof fetch,
  command: 'status' | 'report',
  runId: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const result = await fetchJson(
    fetchImpl,
    buildApiUrl(config.endpoint, `/api/eval/runs/${encodeURIComponent(runId)}/${command}`),
    {
      method: 'GET',
      headers: buildAuthHeaders(config, false),
    },
  )

  if (!result.ok) {
    await writeRequestFailure(stderr, result.response, config)
    return 1
  }

  writeJsonSummary(stdout, `Eval ${command}`, result.data)
  return 0
}

async function runSubmit(
  config: HerdConfig,
  fetchImpl: typeof fetch,
  runId: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const result = await fetchJson(
    fetchImpl,
    buildApiUrl(config.endpoint, `/api/eval/runs/${encodeURIComponent(runId)}/submit`),
    {
      method: 'POST',
      headers: buildAuthHeaders(config, false),
    },
  )

  if (!result.ok) {
    await writeRequestFailure(stderr, result.response, config)
    return 1
  }

  writeJsonSummary(stdout, 'Eval submit', result.data)
  return 0
}

export async function runEvalCli(
  args: readonly string[],
  dependencies: EvalCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  const fetchImpl = dependencies.fetchImpl ?? fetch

  const command = args[0]
  if (!command) {
    printUsage(stdout)
    return 1
  }

  const config = await resolveConfig(dependencies, stderr)
  if (!config) {
    return 1
  }

  if (command === 'doctor') {
    const options = parseDoctorOptions(args.slice(1))
    if (!options) {
      printUsage(stdout)
      return 1
    }
    return runDoctor(config, fetchImpl, options, stdout, stderr)
  }

  if (command === 'commander' && args[1] === 'bootstrap') {
    const options = parseBootstrapOptions(args.slice(2))
    if (!options) {
      printUsage(stdout)
      return 1
    }
    return runBootstrap(config, fetchImpl, options, stdout, stderr)
  }

  if (command === 'list' && args.length === 1) {
    return runList(config, fetchImpl, stdout, stderr)
  }

  if (command === 'run') {
    const options = parseRunOptions(args.slice(1))
    if (!options) {
      printUsage(stdout)
      return 1
    }
    return runRun(config, fetchImpl, options, stdout, stderr)
  }

  if ((command === 'status' || command === 'report') && args.length === 2) {
    const runId = parseNonEmpty(args[1])
    if (!runId) {
      printUsage(stdout)
      return 1
    }
    return runRunLookup(config, fetchImpl, command, runId, stdout, stderr)
  }

  if (command === 'submit' && args.length === 2) {
    const runId = parseNonEmpty(args[1])
    if (!runId) {
      printUsage(stdout)
      return 1
    }
    return runSubmit(config, fetchImpl, runId, stdout, stderr)
  }

  printUsage(stdout)
  return 1
}
