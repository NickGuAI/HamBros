import { type HammurabiConfig, normalizeEndpoint, readHammurabiConfig } from './config.js'

interface Writable {
  write(chunk: string): boolean
}

interface CronTaskSummary {
  id: string
  schedule: string
  enabled: boolean
  agentType?: string
  sessionType?: string
  nextRun?: string
}

interface ListOptions {
  commanderId: string
}

interface AddOptions {
  commanderId: string
  schedule: string
  instruction: string
  enabled?: boolean
  name?: string
  agentType?: 'claude' | 'codex'
  sessionType?: 'stream' | 'pty'
  permissionMode?: string
  workDir?: string
  machine?: string
}

interface DeleteOptions {
  commanderId: string
  cronId: string
}

interface CommandContext {
  config: HammurabiConfig
  commanderId: string
}

interface UpdateOptions {
  commanderId?: string
  cronId: string
  schedule?: string
  instruction?: string
  enabled?: boolean
}

interface TriggerOptions {
  commanderId?: string
  instruction?: string
}

export interface CronCliDependencies {
  fetchImpl?: typeof fetch
  readConfig?: () => Promise<HammurabiConfig | null>
  commanderId?: string | null
  stdout?: Writable
  stderr?: Writable
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  hambros cron list --commander <id>\n')
  stdout.write(
    '  hambros cron add --commander <id> --schedule "<cron>" --instruction "<text>" [--name <str>] [--agent claude|codex] [--session-type stream|pty] [--permission-mode <str>] [--work-dir /abs/path] [--machine <id>] [--disabled]\n',
  )
  stdout.write('  hambros cron delete --commander <id> <cron-id>\n')
  stdout.write(
    '  hambros cron update <id> [--commander <id>] [--schedule "<cron>"] [--instruction "<text>"] [--enabled | --disabled | --enabled true|false]\n',
  )
  stdout.write('  hambros cron trigger [--commander <id>] [--instruction "<text>"]\n')
}

function parseNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

function resolveCommanderId(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseListOptions(args: readonly string[]): ListOptions | null {
  if (args.length !== 2 || args[0] !== '--commander') {
    return null
  }

  const commanderId = parseNonEmpty(args[1])
  if (!commanderId) {
    return null
  }

  return { commanderId }
}

function parseAddOptions(args: readonly string[]): AddOptions | null {
  let commanderId: string | undefined
  let schedule: string | undefined
  let instruction: string | undefined
  let name: string | undefined
  let agentType: 'claude' | 'codex' | undefined
  let sessionType: 'stream' | 'pty' | undefined
  let permissionMode: string | undefined
  let workDir: string | undefined
  let machine: string | undefined
  let enabled = true

  for (let index = 0; index < args.length; ) {
    const flag = args[index]
    if (flag === '--disabled') {
      enabled = false
      index += 1
      continue
    }

    const value = parseNonEmpty(args[index + 1])
    if (!value) {
      return null
    }

    if (flag === '--commander') {
      commanderId = value
    } else if (flag === '--schedule') {
      schedule = value
    } else if (flag === '--instruction') {
      instruction = value
    } else if (flag === '--name') {
      name = value
    } else if (flag === '--agent') {
      if (value !== 'claude' && value !== 'codex') {
        return null
      }
      agentType = value
    } else if (flag === '--session-type') {
      if (value !== 'stream' && value !== 'pty') {
        return null
      }
      sessionType = value
    } else if (flag === '--permission-mode') {
      permissionMode = value
    } else if (flag === '--work-dir') {
      workDir = value
    } else if (flag === '--machine') {
      machine = value
    } else {
      return null
    }

    index += 2
  }

  if (!commanderId || !schedule || !instruction) {
    return null
  }

  const options: AddOptions = {
    commanderId,
    schedule,
    instruction,
  }
  if (!enabled) {
    options.enabled = false
  }
  if (name) {
    options.name = name
  }
  if (agentType) {
    options.agentType = agentType
  }
  if (sessionType) {
    options.sessionType = sessionType
  }
  if (permissionMode) {
    options.permissionMode = permissionMode
  }
  if (workDir) {
    options.workDir = workDir
  }
  if (machine) {
    options.machine = machine
  }

  return options
}

function parseDeleteOptions(args: readonly string[]): DeleteOptions | null {
  if (args.length !== 3 || args[0] !== '--commander') {
    return null
  }

  const commanderId = parseNonEmpty(args[1])
  const cronId = parseNonEmpty(args[2])
  if (!commanderId || !cronId) {
    return null
  }

  return {
    commanderId,
    cronId,
  }
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

function parseCronListPayload(payload: unknown): CronTaskSummary[] {
  const rawTasks = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.crons)
      ? payload.crons
      : []

  const tasks: CronTaskSummary[] = []
  for (const entry of rawTasks) {
    if (!isObject(entry)) {
      continue
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const schedule = typeof entry.schedule === 'string' ? entry.schedule.trim() : ''
    if (!id || !schedule) {
      continue
    }

    tasks.push({
      id,
      schedule,
      enabled: entry.enabled === false ? false : true,
      agentType: typeof entry.agentType === 'string' ? entry.agentType.trim() : undefined,
      sessionType: typeof entry.sessionType === 'string' ? entry.sessionType.trim() : undefined,
      nextRun: typeof entry.nextRun === 'string' ? entry.nextRun.trim() : undefined,
    })
  }

  return tasks
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

async function resolveCommandContext(
  dependencies: CronCliDependencies,
  stderr: Writable,
  commanderOverride?: string,
): Promise<CommandContext | null> {
  const readConfig = dependencies.readConfig ?? readHammurabiConfig
  const config = await readConfig()
  if (!config) {
    stderr.write('HamBros config not found. Run `hambros init` first.\n')
    return null
  }

  const commanderId = resolveCommanderId(
    commanderOverride ?? dependencies.commanderId ?? process.env.HAMMURABI_COMMANDER_ID,
  )
  if (!commanderId) {
    stderr.write('--commander or HAMMURABI_COMMANDER_ID is required.\n')
    return null
  }

  return { config, commanderId }
}

function parseUpdateOptions(args: readonly string[]): UpdateOptions | null {
  const cronId = parseNonEmpty(args[0])
  if (!cronId) {
    return null
  }

  let commanderId: string | undefined
  let schedule: string | undefined
  let instruction: string | undefined
  let enabled: boolean | undefined
  let hasField = false

  const flags = args.slice(1)
  for (let index = 0; index < flags.length; ) {
    const flag = flags[index]

    if (flag === '--enabled') {
      const rawValue = flags[index + 1]
      if (rawValue && !rawValue.startsWith('--')) {
        const value = parseNonEmpty(rawValue)
        if (value !== 'true' && value !== 'false') {
          return null
        }
        enabled = value === 'true'
        hasField = true
        index += 2
        continue
      }

      enabled = true
      hasField = true
      index += 1
      continue
    }

    if (flag === '--disabled') {
      enabled = false
      hasField = true
      index += 1
      continue
    }

    const value = parseNonEmpty(flags[index + 1])
    if (!value) {
      return null
    }

    if (flag === '--commander') {
      commanderId = value
    } else if (flag === '--schedule') {
      schedule = value
      hasField = true
    } else if (flag === '--instruction') {
      instruction = value
      hasField = true
    } else {
      return null
    }

    index += 2
  }

  if (!hasField) {
    return null
  }

  return { commanderId, cronId, schedule, instruction, enabled }
}

function parseTriggerOptions(args: readonly string[]): TriggerOptions | null {
  let commanderId: string | undefined
  let instruction: string | undefined

  for (let index = 0; index < args.length; ) {
    const flag = args[index]
    const value = parseNonEmpty(args[index + 1])
    if (!value) {
      return null
    }

    if (flag === '--commander') {
      commanderId = value
    } else if (flag === '--instruction') {
      instruction = value
    } else {
      return null
    }

    index += 2
  }

  return { commanderId, instruction }
}

async function runList(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: ListOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    config.endpoint,
    `/api/commanders/${encodeURIComponent(options.commanderId)}/crons`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'GET',
    headers: buildAuthHeaders(config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Request failed (${result.response.status}): ${detail}\n`
        : `Request failed (${result.response.status}).\n`,
    )
    return 1
  }

  const tasks = parseCronListPayload(result.data)
  if (tasks.length === 0) {
    stdout.write('No cron tasks found.\n')
    return 0
  }

  const headers = ['ID', 'SCHEDULE', 'ENABLED', 'AGENT', 'SESSION', 'NEXT_RUN']
  const rows = tasks.map((task) => [
    task.id,
    task.schedule,
    task.enabled ? 'yes' : 'no',
    task.agentType?.length ? task.agentType : '-',
    task.sessionType?.length ? task.sessionType : '-',
    task.nextRun?.length ? task.nextRun : '-',
  ])
  stdout.write(formatTable(headers, rows))
  return 0
}

async function runAdd(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: AddOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    config.endpoint,
    `/api/commanders/${encodeURIComponent(options.commanderId)}/crons`,
  )
  const body: Record<string, unknown> = {
    schedule: options.schedule,
    instruction: options.instruction,
  }
  if (options.enabled === false) {
    body.enabled = false
  }
  if (options.name) {
    body.name = options.name
  }
  if (options.agentType) {
    body.agentType = options.agentType
  }
  if (options.sessionType) {
    body.sessionType = options.sessionType
  }
  if (options.permissionMode) {
    body.permissionMode = options.permissionMode
  }
  if (options.workDir) {
    body.workDir = options.workDir
  }
  if (options.machine) {
    body.machine = options.machine
  }

  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(config, true),
    body: JSON.stringify(body),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Request failed (${result.response.status}): ${detail}\n`
        : `Request failed (${result.response.status}).\n`,
    )
    return 1
  }

  const payload = isObject(result.data) ? result.data : {}
  const cronId = typeof payload.id === 'string' ? payload.id : '(unknown)'
  stdout.write(`Created cron task ID: ${cronId}\n`)
  return 0
}

async function runDelete(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: DeleteOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    config.endpoint,
    `/api/commanders/${encodeURIComponent(options.commanderId)}/crons/${encodeURIComponent(options.cronId)}`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'DELETE',
    headers: buildAuthHeaders(config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Request failed (${result.response.status}): ${detail}\n`
        : `Request failed (${result.response.status}).\n`,
    )
    return 1
  }

  stdout.write(`Deleted cron task ${options.cronId}.\n`)
  return 0
}

async function runUpdate(
  context: CommandContext,
  fetchImpl: typeof fetch,
  options: UpdateOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    context.config.endpoint,
    `/api/commanders/${encodeURIComponent(context.commanderId)}/crons/${encodeURIComponent(options.cronId)}`,
  )
  const payload: Record<string, unknown> = {}
  if (options.schedule !== undefined) {
    payload.schedule = options.schedule
  }
  if (options.instruction !== undefined) {
    payload.instruction = options.instruction
  }
  if (options.enabled !== undefined) {
    payload.enabled = options.enabled
  }

  const result = await fetchJson(fetchImpl, url, {
    method: 'PATCH',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify(payload),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Request failed (${result.response.status}): ${detail}\n`
        : `Request failed (${result.response.status}).\n`,
    )
    return 1
  }

  stdout.write(`Cron ${options.cronId} updated.\n`)
  return 0
}

async function runTrigger(
  context: CommandContext,
  fetchImpl: typeof fetch,
  instruction: string | undefined,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    context.config.endpoint,
    `/api/commanders/${encodeURIComponent(context.commanderId)}/cron-trigger`,
  )
  const payload: Record<string, unknown> = {}
  if (instruction !== undefined) {
    payload.instruction = instruction
  }
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify(payload),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Request failed (${result.response.status}): ${detail}\n`
        : `Request failed (${result.response.status}).\n`,
    )
    return 1
  }

  const data = isObject(result.data) ? result.data : {}
  const triggered = data.triggered === true
  stdout.write(triggered ? 'Cron instruction triggered.\n' : 'Cron trigger sent (no instruction pending).\n')
  return 0
}

export async function runCronCli(
  args: readonly string[],
  dependencies: CronCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const readConfig = dependencies.readConfig ?? readHammurabiConfig

  const command = args[0]
  if (!command || (command !== 'list' && command !== 'add' && command !== 'delete' && command !== 'update' && command !== 'trigger')) {
    printUsage(stdout)
    return 1
  }

  if (command === 'list') {
    const config = await readConfig()
    if (!config) {
      stderr.write('HamBros config not found. Run `hambros init` first.\n')
      return 1
    }
    const listOptions = parseListOptions(args.slice(1))
    if (!listOptions) {
      printUsage(stdout)
      return 1
    }
    return runList(config, fetchImpl, listOptions, stdout, stderr)
  }

  if (command === 'add') {
    const config = await readConfig()
    if (!config) {
      stderr.write('HamBros config not found. Run `hambros init` first.\n')
      return 1
    }
    const addOptions = parseAddOptions(args.slice(1))
    if (!addOptions) {
      printUsage(stdout)
      return 1
    }
    return runAdd(config, fetchImpl, addOptions, stdout, stderr)
  }

  if (command === 'delete') {
    const config = await readConfig()
    if (!config) {
      stderr.write('HamBros config not found. Run `hambros init` first.\n')
      return 1
    }
    const deleteOptions = parseDeleteOptions(args.slice(1))
    if (!deleteOptions) {
      printUsage(stdout)
      return 1
    }
    return runDelete(config, fetchImpl, deleteOptions, stdout, stderr)
  }

  if (command === 'trigger') {
    const triggerOptions = parseTriggerOptions(args.slice(1))
    if (!triggerOptions) {
      printUsage(stdout)
      return 1
    }

    const context = await resolveCommandContext(dependencies, stderr, triggerOptions.commanderId)
    if (!context) {
      return 1
    }

    return runTrigger(context, fetchImpl, triggerOptions.instruction, stdout, stderr)
  }

  const updateOptions = parseUpdateOptions(args.slice(1))
  if (!updateOptions) {
    printUsage(stdout)
    return 1
  }

  const context = await resolveCommandContext(dependencies, stderr, updateOptions.commanderId)
  if (!context) {
    return 1
  }

  return runUpdate(context, fetchImpl, updateOptions, stdout, stderr)
}
