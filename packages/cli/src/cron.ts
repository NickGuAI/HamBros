import { type HammurabiConfig, normalizeEndpoint, readHammurabiConfig } from './config.js'

interface Writable {
  write(chunk: string): boolean
}

interface CommandContext {
  config: HammurabiConfig
}

interface CronTaskSummary {
  id: string
  name: string
  schedule: string
  taskType?: string
  timezone?: string
  machine?: string
  workDir?: string
  agentType?: string
  instruction?: string
  model?: string
  enabled: boolean
  createdAt?: string
  permissionMode?: string
  sessionType?: string
}

interface WorkflowRunSummary {
  id: string
  status: string
  startedAt: string
  completedAt: string | null
  costUsd: number
  sessionId: string
  report: string
}

export interface CronCliDependencies {
  fetchImpl?: typeof fetch
  readConfig?: () => Promise<HammurabiConfig | null>
  stdout?: Writable
  stderr?: Writable
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

function parseBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'true') {
    return true
  }
  if (normalized === 'false') {
    return false
  }
  return null
}

function parseFlagValues(
  args: readonly string[],
  allowedFlags: readonly string[],
): Map<string, string> | null {
  if (args.length % 2 !== 0) {
    return null
  }

  const allowed = new Set(allowedFlags)
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = parseNonEmpty(args[index + 1])
    if (!flag || !allowed.has(flag) || !value || values.has(flag)) {
      return null
    }
    values.set(flag, value)
  }

  return values
}

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  hammurabi cron list [--commander <id>]\n')
  stdout.write(
    '  hammurabi cron add --name <name> --schedule "<cron>" --instruction "<text>" [--description "<text>"] [--timezone <tz>] [--model <model>] [--agent claude|codex|gemini] [--work-dir <path>] [--machine <id>] [--permission-mode <mode>] [--session-type stream|pty] [--enabled true|false] [--commander <id>]\n',
  )
  stdout.write(
    '  hammurabi cron update <task-id> [--name <name>] [--description "<text>"] [--schedule "<cron>"] [--timezone <tz>] [--instruction "<text>"] [--model <model>] [--agent claude|codex|gemini] [--work-dir <path>] [--machine <id>] [--permission-mode <mode>] [--session-type stream|pty] [--enabled true|false]\n',
  )
  stdout.write('  hammurabi cron delete <task-id>\n')
  stdout.write('  hammurabi cron trigger <task-id>\n')
  stdout.write('  hammurabi cron show <task-id>\n')
}

function buildApiUrl(endpoint: string, apiPath: string): string {
  return new URL(apiPath, `${normalizeEndpoint(endpoint)}/`).toString()
}

function buildAuthHeaders(config: HammurabiConfig, includeJsonContentType: boolean): HeadersInit {
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
  const response = await fetchImpl(url, init)
  if (!response.ok) {
    return { ok: false, response }
  }

  if (response.status === 204) {
    return { ok: true, data: null }
  }

  try {
    return { ok: true, data: (await response.json()) as unknown }
  } catch {
    return { ok: true, data: null }
  }
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

function parseTaskListPayload(payload: unknown): CronTaskSummary[] {
  const rawTasks = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.tasks)
      ? payload.tasks
      : []

  const tasks: CronTaskSummary[] = []
  for (const entry of rawTasks) {
    if (!isObject(entry)) {
      continue
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const schedule = typeof entry.schedule === 'string' ? entry.schedule.trim() : ''
    if (!id || !name || !schedule) {
      continue
    }

    tasks.push({
      id,
      name,
      schedule,
      taskType: typeof entry.taskType === 'string' ? entry.taskType.trim() : undefined,
      timezone: typeof entry.timezone === 'string' ? entry.timezone.trim() : undefined,
      machine: typeof entry.machine === 'string' ? entry.machine.trim() : undefined,
      workDir: typeof entry.workDir === 'string' ? entry.workDir.trim() : undefined,
      agentType: typeof entry.agentType === 'string' ? entry.agentType.trim() : undefined,
      instruction: typeof entry.instruction === 'string' ? entry.instruction.trim() : undefined,
      model: typeof entry.model === 'string' ? entry.model.trim() : undefined,
      enabled: entry.enabled === false ? false : true,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : undefined,
      permissionMode: typeof entry.permissionMode === 'string' ? entry.permissionMode.trim() : undefined,
      sessionType: typeof entry.sessionType === 'string' ? entry.sessionType.trim() : undefined,
    })
  }

  return tasks
}

function parseTaskRunsPayload(payload: unknown): WorkflowRunSummary[] {
  if (!Array.isArray(payload)) {
    return []
  }

  const runs: WorkflowRunSummary[] = []
  for (const entry of payload) {
    if (!isObject(entry)) {
      continue
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const status = typeof entry.status === 'string' ? entry.status.trim() : ''
    const startedAt = typeof entry.startedAt === 'string' ? entry.startedAt : ''
    if (!id || !status || !startedAt) {
      continue
    }

    runs.push({
      id,
      status,
      startedAt,
      completedAt: typeof entry.completedAt === 'string' ? entry.completedAt : null,
      costUsd: typeof entry.costUsd === 'number' ? entry.costUsd : 0,
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
      report: typeof entry.report === 'string' ? entry.report : '',
    })
  }

  return runs
}

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, columnIndex) =>
    Math.max(
      header.length,
      ...rows.map((row) => {
        const value = row[columnIndex] ?? ''
        return value.length
      }),
    ),
  )

  const separator = `+-${widths.map((width) => '-'.repeat(width)).join('-+-')}-+\n`
  const formatRow = (values: readonly string[]) =>
    `| ${values.map((value, columnIndex) => value.padEnd(widths[columnIndex] ?? value.length)).join(' | ')} |\n`

  let output = ''
  output += separator
  output += formatRow(headers)
  output += separator
  for (const row of rows) {
    output += formatRow(row)
  }
  output += separator
  return output
}

async function resolveContext(
  dependencies: CronCliDependencies,
  stderr: Writable,
): Promise<CommandContext | null> {
  const readConfig = dependencies.readConfig ?? readHammurabiConfig
  const config = await readConfig()
  if (!config) {
    stderr.write('Hammurabi config not found. Run `hammurabi onboard` first.\n')
    return null
  }

  return { config }
}

function renderRequestFailure(status: number, detail: string | null): string {
  if (detail) {
    return `Request failed (${status}): ${detail}\n`
  }
  return `Request failed (${status}).\n`
}

async function runList(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  commanderId?: string,
): Promise<number> {
  const query = commanderId ? `?commanderId=${encodeURIComponent(commanderId)}` : ''
  const url = buildApiUrl(context.config.endpoint, `/api/command-room/tasks${query}`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'GET',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  const tasks = parseTaskListPayload(result.data)
  if (tasks.length === 0) {
    stdout.write('No cron tasks found.\n')
    return 0
  }

  const headers = ['ID', 'NAME', 'TYPE', 'SCHEDULE', 'MODEL', 'ENABLED', 'AGENT', 'SESSION']
  const rows = tasks.map((task) => [
    task.id,
    task.name,
    task.taskType?.length ? task.taskType : 'instruction',
    task.schedule,
    task.model?.length ? task.model : 'default',
    task.enabled ? 'true' : 'false',
    task.agentType?.length ? task.agentType : 'claude',
    task.sessionType?.length ? task.sessionType : 'stream',
  ])
  stdout.write(formatTable(headers, rows))
  return 0
}

async function runAdd(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  body: Record<string, unknown>,
): Promise<number> {
  const url = buildApiUrl(context.config.endpoint, '/api/command-room/tasks')
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify(body),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  const payload = isObject(result.data) ? result.data : {}
  const taskId = typeof payload.id === 'string' ? payload.id : '(unknown)'
  stdout.write(`Created cron task ID: ${taskId}\n`)
  return 0
}

async function runUpdate(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<number> {
  const url = buildApiUrl(context.config.endpoint, `/api/command-room/tasks/${encodeURIComponent(taskId)}`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'PATCH',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify(patch),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  stdout.write(`Updated cron task ${taskId}.\n`)
  return 0
}

async function runDelete(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  taskId: string,
): Promise<number> {
  const url = buildApiUrl(context.config.endpoint, `/api/command-room/tasks/${encodeURIComponent(taskId)}`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'DELETE',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  stdout.write(`Deleted cron task ${taskId}.\n`)
  return 0
}

async function runTrigger(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  taskId: string,
): Promise<number> {
  const url = buildApiUrl(
    context.config.endpoint,
    `/api/command-room/tasks/${encodeURIComponent(taskId)}/trigger`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify({}),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  const payload = isObject(result.data) ? result.data : {}
  const runId = typeof payload.id === 'string' ? payload.id : '(unknown)'
  stdout.write(`Triggered cron task ${taskId} (run ${runId}).\n`)
  return 0
}

async function runShow(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  taskId: string,
): Promise<number> {
  const tasksUrl = buildApiUrl(context.config.endpoint, '/api/command-room/tasks')
  const tasksResult = await fetchJson(fetchImpl, tasksUrl, {
    method: 'GET',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!tasksResult.ok) {
    const detail = await readErrorDetail(tasksResult.response)
    stderr.write(renderRequestFailure(tasksResult.response.status, detail))
    return 1
  }

  const task = parseTaskListPayload(tasksResult.data).find((entry) => entry.id === taskId)
  if (!task) {
    stderr.write(`Task not found: ${taskId}\n`)
    return 1
  }

  const runsUrl = buildApiUrl(
    context.config.endpoint,
    `/api/command-room/tasks/${encodeURIComponent(taskId)}/runs`,
  )
  const runsResult = await fetchJson(fetchImpl, runsUrl, {
    method: 'GET',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!runsResult.ok) {
    const detail = await readErrorDetail(runsResult.response)
    stderr.write(renderRequestFailure(runsResult.response.status, detail))
    return 1
  }

  const runs = parseTaskRunsPayload(runsResult.data)

  stdout.write(`ID: ${task.id}\n`)
  stdout.write(`Name: ${task.name}\n`)
  stdout.write(`Task Type: ${task.taskType || 'instruction'}\n`)
  stdout.write(`Schedule: ${task.schedule}\n`)
  stdout.write(`Timezone: ${task.timezone || 'server default'}\n`)
  stdout.write(`Enabled: ${task.enabled ? 'true' : 'false'}\n`)
  stdout.write(`Agent: ${task.agentType || 'claude'}\n`)
  stdout.write(`Session Type: ${task.sessionType || 'stream'}\n`)
  stdout.write(`Model: ${task.model || 'default'}\n`)
  stdout.write(`Machine: ${task.machine || 'local'}\n`)
  stdout.write(`Work Dir: ${task.workDir || '(none)'}\n`)
  if (task.permissionMode) {
    stdout.write(`Permission Mode: ${task.permissionMode}\n`)
  }
  if (task.instruction) {
    stdout.write(`Instruction: ${task.instruction}\n`)
  }
  if (task.createdAt) {
    stdout.write(`Created At: ${task.createdAt}\n`)
  }

  stdout.write('\nRecent Runs:\n')
  if (runs.length === 0) {
    stdout.write('- none\n')
    return 0
  }

  for (const run of runs.slice(0, 10)) {
    stdout.write(
      `- ${run.id} status=${run.status} started=${run.startedAt} completed=${run.completedAt ?? '-'} cost=${run.costUsd.toFixed(4)} session=${run.sessionId || '-'}\n`,
    )
  }

  return 0
}

export async function runCronCli(
  args: readonly string[],
  dependencies: CronCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  const fetchImpl = dependencies.fetchImpl ?? fetch

  const command = args[0]
  if (!command) {
    printUsage(stdout)
    return 1
  }

  const context = await resolveContext(dependencies, stderr)
  if (!context) {
    return 1
  }

  if (command === 'list') {
    const options = parseFlagValues(args.slice(1), ['--commander'])
    if (options === null) {
      printUsage(stdout)
      return 1
    }
    return runList(context, fetchImpl, stdout, stderr, options.get('--commander'))
  }

  if (command === 'add') {
    const options = parseFlagValues(args.slice(1), [
      '--name',
      '--description',
      '--schedule',
      '--timezone',
      '--instruction',
      '--model',
      '--agent',
      '--work-dir',
      '--machine',
      '--permission-mode',
      '--session-type',
      '--enabled',
      '--commander',
    ])
    if (!options) {
      printUsage(stdout)
      return 1
    }

    const name = options.get('--name')
    const schedule = options.get('--schedule')
    const instruction = options.get('--instruction')
    if (!name || !schedule || !instruction) {
      printUsage(stdout)
      return 1
    }

    const agent = options.get('--agent') ?? 'claude'
    if (agent !== 'claude' && agent !== 'codex') {
      printUsage(stdout)
      return 1
    }

    const sessionType = options.get('--session-type')
    if (sessionType && sessionType !== 'stream' && sessionType !== 'pty') {
      printUsage(stdout)
      return 1
    }

    const enabledRaw = options.get('--enabled')
    const enabled = enabledRaw === undefined ? true : parseBoolean(enabledRaw)
    if (enabled === null) {
      printUsage(stdout)
      return 1
    }

    const payload: Record<string, unknown> = {
      name,
      schedule,
      instruction,
      enabled,
      agentType: agent,
      machine: options.get('--machine') ?? '',
      workDir: options.get('--work-dir') ?? '',
    }

    const description = options.get('--description')
    if (description) {
      payload.description = description
    }

    const timezone = options.get('--timezone')
    if (timezone) {
      payload.timezone = timezone
    }

    const model = options.get('--model')
    if (model) {
      payload.model = model
    }

    const permissionMode = options.get('--permission-mode')
    if (permissionMode) {
      payload.permissionMode = permissionMode
    }

    if (sessionType) {
      payload.sessionType = sessionType
    }

    const commanderId = options.get('--commander')
    if (commanderId) {
      payload.commanderId = commanderId
    }

    return runAdd(context, fetchImpl, stdout, stderr, payload)
  }

  if (command === 'update') {
    const taskId = parseNonEmpty(args[1])
    if (!taskId) {
      printUsage(stdout)
      return 1
    }

    const options = parseFlagValues(args.slice(2), [
      '--name',
      '--description',
      '--schedule',
      '--timezone',
      '--instruction',
      '--model',
      '--agent',
      '--work-dir',
      '--machine',
      '--permission-mode',
      '--session-type',
      '--enabled',
      '--commander',
    ])
    if (!options) {
      printUsage(stdout)
      return 1
    }

    const patch: Record<string, unknown> = {}

    const name = options.get('--name')
    if (name) {
      patch.name = name
    }

    const description = options.get('--description')
    if (description) {
      patch.description = description
    }

    const schedule = options.get('--schedule')
    if (schedule) {
      patch.schedule = schedule
    }

    const timezone = options.get('--timezone')
    if (timezone) {
      patch.timezone = timezone
    }

    const instruction = options.get('--instruction')
    if (instruction) {
      patch.instruction = instruction
    }

    const model = options.get('--model')
    if (model) {
      patch.model = model
    }

    const agent = options.get('--agent')
    if (agent) {
      if (agent !== 'claude' && agent !== 'codex') {
        printUsage(stdout)
        return 1
      }
      patch.agentType = agent
    }

    const workDir = options.get('--work-dir')
    if (workDir) {
      patch.workDir = workDir
    }

    const machine = options.get('--machine')
    if (machine) {
      patch.machine = machine
    }

    const permissionMode = options.get('--permission-mode')
    if (permissionMode) {
      patch.permissionMode = permissionMode
    }

    const sessionType = options.get('--session-type')
    if (sessionType) {
      if (sessionType !== 'stream' && sessionType !== 'pty') {
        printUsage(stdout)
        return 1
      }
      patch.sessionType = sessionType
    }

    const enabledRaw = options.get('--enabled')
    if (enabledRaw !== undefined) {
      const enabled = parseBoolean(enabledRaw)
      if (enabled === null) {
        printUsage(stdout)
        return 1
      }
      patch.enabled = enabled
    }

    if (Object.keys(patch).length === 0) {
      printUsage(stdout)
      return 1
    }

    return runUpdate(context, fetchImpl, stdout, stderr, taskId, patch)
  }

  if (command === 'delete') {
    const taskId = parseNonEmpty(args[1])
    if (!taskId || args.length !== 2) {
      printUsage(stdout)
      return 1
    }
    return runDelete(context, fetchImpl, stdout, stderr, taskId)
  }

  if (command === 'trigger') {
    const taskId = parseNonEmpty(args[1])
    if (!taskId || args.length !== 2) {
      printUsage(stdout)
      return 1
    }
    return runTrigger(context, fetchImpl, stdout, stderr, taskId)
  }

  if (command === 'show') {
    const taskId = parseNonEmpty(args[1])
    if (!taskId || args.length !== 2) {
      printUsage(stdout)
      return 1
    }
    return runShow(context, fetchImpl, stdout, stderr, taskId)
  }

  printUsage(stdout)
  return 1
}
