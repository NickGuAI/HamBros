import { type HammurabiConfig, normalizeEndpoint, readHammurabiConfig } from './config.js'

interface Writable {
  write(chunk: string): boolean
}

interface CommandContext {
  config: HammurabiConfig
}

interface SentinelSummary {
  id: string
  name: string
  status: string
  schedule: string
  parentCommanderId: string
  totalRuns: number
  maxRuns?: number
  totalCostUsd: number
  lastRun: string | null
}

interface SentinelHistoryEntry {
  timestamp: string
  action: string
  result: string
  costUsd: number
  durationSec: number
  source?: string
  sessionId?: string
}

interface SentinelMemoryResponse {
  memory?: string
}

export interface SentinelCliDependencies {
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

function parseOptionalPositiveInt(value: string | undefined): number | null | undefined {
  if (value === undefined) {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null
  }
  return parsed
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

function renderRequestFailure(status: number, detail: string | null): string {
  if (detail) {
    return `Request failed (${status}): ${detail}\n`
  }
  return `Request failed (${status}).\n`
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

function parseSentinelListPayload(payload: unknown): SentinelSummary[] {
  if (!Array.isArray(payload)) {
    return []
  }

  const sentinels: SentinelSummary[] = []
  for (const entry of payload) {
    if (!isObject(entry)) {
      continue
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const status = typeof entry.status === 'string' ? entry.status.trim() : ''
    const schedule = typeof entry.schedule === 'string' ? entry.schedule.trim() : ''
    const parentCommanderId = typeof entry.parentCommanderId === 'string'
      ? entry.parentCommanderId.trim()
      : ''

    if (!id || !name || !status || !schedule || !parentCommanderId) {
      continue
    }

    sentinels.push({
      id,
      name,
      status,
      schedule,
      parentCommanderId,
      totalRuns: typeof entry.totalRuns === 'number' && Number.isFinite(entry.totalRuns)
        ? entry.totalRuns
        : 0,
      maxRuns: typeof entry.maxRuns === 'number' && Number.isFinite(entry.maxRuns)
        ? entry.maxRuns
        : undefined,
      totalCostUsd: typeof entry.totalCostUsd === 'number' && Number.isFinite(entry.totalCostUsd)
        ? entry.totalCostUsd
        : 0,
      lastRun: typeof entry.lastRun === 'string' ? entry.lastRun : null,
    })
  }

  return sentinels
}

function parseHistoryPayload(payload: unknown): SentinelHistoryEntry[] {
  const rawEntries = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.entries)
      ? payload.entries
      : []

  const entries: SentinelHistoryEntry[] = []
  for (const item of rawEntries) {
    if (!isObject(item)) {
      continue
    }

    const timestamp = typeof item.timestamp === 'string' ? item.timestamp : ''
    const action = typeof item.action === 'string' ? item.action : ''
    const result = typeof item.result === 'string' ? item.result : ''
    if (!timestamp || !action || !result) {
      continue
    }

    entries.push({
      timestamp,
      action,
      result,
      costUsd: typeof item.costUsd === 'number' && Number.isFinite(item.costUsd) ? item.costUsd : 0,
      durationSec: typeof item.durationSec === 'number' && Number.isFinite(item.durationSec)
        ? item.durationSec
        : 0,
      source: typeof item.source === 'string' ? item.source : undefined,
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : undefined,
    })
  }

  return entries
}

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  hammurabi sentinel list [--parent <commander-id>]\n')
  stdout.write(
    '  hammurabi sentinel create --parent <commander-id> --name <name> --schedule "<cron>" --instruction "<text>" [--skills "a,b"] [--seed-memory "<text>"] [--max-runs <n>] [--timezone <tz>] [--agent claude|codex|gemini] [--permission-mode <mode>] [--model <model>] [--work-dir <path>]\n',
  )
  stdout.write('  hammurabi sentinel show <sentinel-id>\n')
  stdout.write('  hammurabi sentinel pause <sentinel-id>\n')
  stdout.write('  hammurabi sentinel resume <sentinel-id>\n')
  stdout.write('  hammurabi sentinel complete <sentinel-id>\n')
  stdout.write('  hammurabi sentinel cancel <sentinel-id>\n')
  stdout.write('  hammurabi sentinel trigger <sentinel-id>\n')
  stdout.write('  hammurabi sentinel delete <sentinel-id>\n')
  stdout.write('  hammurabi sentinel history <sentinel-id> [--limit <n>]\n')
  stdout.write('  hammurabi sentinel report <sentinel-id> [--at <iso-timestamp>]\n')
  stdout.write('  hammurabi sentinel memory <sentinel-id>\n')
}

async function resolveContext(
  dependencies: SentinelCliDependencies,
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

async function runList(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  args: readonly string[],
): Promise<number> {
  let parentCommanderId: string | undefined
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '--parent') {
      printUsage(stderr)
      return 1
    }

    parentCommanderId = parseNonEmpty(args[1]) ?? undefined
    if (!parentCommanderId) {
      stderr.write('--parent requires a non-empty commander id\n')
      return 1
    }
  }

  const query = parentCommanderId
    ? `?parent=${encodeURIComponent(parentCommanderId)}`
    : ''
  const url = buildApiUrl(context.config.endpoint, `/api/sentinels${query}`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'GET',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  const sentinels = parseSentinelListPayload(result.data)
  if (sentinels.length === 0) {
    stdout.write('No sentinels found.\n')
    return 0
  }

  const headers = ['ID', 'NAME', 'STATUS', 'SCHEDULE', 'RUNS', 'COST', 'PARENT']
  const rows = sentinels.map((sentinel) => [
    sentinel.id,
    sentinel.name,
    sentinel.status,
    sentinel.schedule,
    sentinel.maxRuns ? `${sentinel.totalRuns}/${sentinel.maxRuns}` : String(sentinel.totalRuns),
    `$${sentinel.totalCostUsd.toFixed(2)}`,
    sentinel.parentCommanderId,
  ])

  stdout.write(formatTable(headers, rows))
  return 0
}

function parseCreateArgs(args: readonly string[]): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const values = new Map<string, string>()
  const supported = new Set([
    '--parent',
    '--name',
    '--schedule',
    '--instruction',
    '--skills',
    '--seed-memory',
    '--max-runs',
    '--timezone',
    '--agent',
    '--permission-mode',
    '--model',
    '--work-dir',
  ])

  if (args.length % 2 !== 0) {
    return { ok: false, error: 'create expects flag/value pairs' }
  }

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = parseNonEmpty(args[index + 1])
    if (!flag || !supported.has(flag) || !value || values.has(flag)) {
      return { ok: false, error: `Invalid create flag pair: ${flag ?? '(missing flag)'}` }
    }
    values.set(flag, value)
  }

  const parentCommanderId = values.get('--parent')
  const name = values.get('--name')
  const schedule = values.get('--schedule')
  const instruction = values.get('--instruction')

  if (!parentCommanderId || !name || !schedule || !instruction) {
    return {
      ok: false,
      error: 'create requires --parent, --name, --schedule, and --instruction',
    }
  }

  const maxRuns = parseOptionalPositiveInt(values.get('--max-runs'))
  if (maxRuns === null) {
    return { ok: false, error: '--max-runs must be a positive integer' }
  }

  const skillsValue = values.get('--skills')
  const skills = skillsValue
    ? skillsValue
      .split(',')
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 0)
    : undefined

  const agentType = values.get('--agent')
  if (agentType && agentType !== 'claude' && agentType !== 'codex' && agentType !== 'gemini') {
    return { ok: false, error: '--agent must be claude, codex, or gemini' }
  }

  const body: Record<string, unknown> = {
    parentCommanderId,
    name,
    schedule,
    instruction,
  }

  const seedMemory = values.get('--seed-memory')
  if (seedMemory) {
    body.seedMemory = seedMemory
  }
  if (skills && skills.length > 0) {
    body.skills = skills
  }
  if (maxRuns !== undefined) {
    body.maxRuns = maxRuns
  }

  const timezone = values.get('--timezone')
  if (timezone) {
    body.timezone = timezone
  }

  if (agentType) {
    body.agentType = agentType
  }

  const permissionMode = values.get('--permission-mode')
  if (permissionMode) {
    body.permissionMode = permissionMode
  }

  const model = values.get('--model')
  if (model) {
    body.model = model
  }

  const workDir = values.get('--work-dir')
  if (workDir) {
    body.workDir = workDir
  }

  return { ok: true, body }
}

async function runCreate(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  args: readonly string[],
): Promise<number> {
  const parsed = parseCreateArgs(args)
  if (!parsed.ok) {
    stderr.write(`${parsed.error}\n`)
    return 1
  }

  const url = buildApiUrl(context.config.endpoint, '/api/sentinels')
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify(parsed.body),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  const payload = isObject(result.data) ? result.data : {}
  const sentinelId = typeof payload.id === 'string' ? payload.id : '(unknown)'
  stdout.write(`Created sentinel ID: ${sentinelId}\n`)
  return 0
}

async function runShow(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  sentinelId: string,
): Promise<number> {
  const url = buildApiUrl(context.config.endpoint, `/api/sentinels/${encodeURIComponent(sentinelId)}`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'GET',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
  return 0
}

async function runStatusUpdate(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  sentinelId: string,
  status: 'paused' | 'active' | 'completed' | 'cancelled',
  label: string,
): Promise<number> {
  const url = buildApiUrl(context.config.endpoint, `/api/sentinels/${encodeURIComponent(sentinelId)}`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'PATCH',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify({ status }),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  stdout.write(`${label} sentinel: ${sentinelId}\n`)
  return 0
}

async function runTrigger(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  sentinelId: string,
): Promise<number> {
  const url = buildApiUrl(context.config.endpoint, `/api/sentinels/${encodeURIComponent(sentinelId)}/trigger`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  stdout.write(`Triggered sentinel: ${sentinelId}\n`)
  return 0
}

async function runDelete(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  sentinelId: string,
): Promise<number> {
  const url = buildApiUrl(context.config.endpoint, `/api/sentinels/${encodeURIComponent(sentinelId)}`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'DELETE',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  stdout.write(`Deleted sentinel: ${sentinelId}\n`)
  return 0
}

async function runHistory(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  sentinelId: string,
  args: readonly string[],
): Promise<number> {
  let limit = 10
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '--limit') {
      printUsage(stderr)
      return 1
    }

    const parsedLimit = parseOptionalPositiveInt(args[1])
    if (!parsedLimit) {
      stderr.write('--limit must be a positive integer\n')
      return 1
    }

    limit = parsedLimit
  }

  const url = buildApiUrl(
    context.config.endpoint,
    `/api/sentinels/${encodeURIComponent(sentinelId)}/history?limit=${limit}`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'GET',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  const entries = parseHistoryPayload(result.data)
  if (entries.length === 0) {
    stdout.write('No history entries found.\n')
    return 0
  }

  const headers = ['TIMESTAMP', 'ACTION', 'COST', 'DURATION', 'SOURCE']
  const rows = entries.map((entry) => [
    entry.timestamp,
    entry.action,
    `$${entry.costUsd.toFixed(2)}`,
    `${entry.durationSec}s`,
    entry.source ?? '-',
  ])

  stdout.write(formatTable(headers, rows))
  return 0
}

async function runReport(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  sentinelId: string,
  args: readonly string[],
): Promise<number> {
  let targetTimestamp: string | undefined
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '--at') {
      printUsage(stderr)
      return 1
    }

    targetTimestamp = parseNonEmpty(args[1]) ?? undefined
    if (!targetTimestamp) {
      stderr.write('--at requires a non-empty timestamp\n')
      return 1
    }
  }

  const url = buildApiUrl(
    context.config.endpoint,
    `/api/sentinels/${encodeURIComponent(sentinelId)}/history?limit=200`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'GET',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  const entries = parseHistoryPayload(result.data)
  if (entries.length === 0) {
    stdout.write('No runs available.\n')
    return 0
  }

  const selected = targetTimestamp
    ? entries.find((entry) => entry.timestamp === targetTimestamp)
    : entries[0]

  if (!selected) {
    stderr.write(`No run found at timestamp: ${targetTimestamp}\n`)
    return 1
  }

  stdout.write(`# Sentinel Run Report\n`)
  stdout.write(`sentinel: ${sentinelId}\n`)
  stdout.write(`timestamp: ${selected.timestamp}\n`)
  stdout.write(`action: ${selected.action}\n`)
  stdout.write(`result: ${selected.result}\n`)
  stdout.write(`cost: $${selected.costUsd.toFixed(2)}\n`)
  stdout.write(`duration: ${selected.durationSec}s\n`)
  if (selected.source) {
    stdout.write(`source: ${selected.source}\n`)
  }
  if (selected.sessionId) {
    stdout.write(`session: ${selected.sessionId}\n`)
  }
  return 0
}

async function runMemory(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
  sentinelId: string,
): Promise<number> {
  const url = buildApiUrl(context.config.endpoint, `/api/sentinels/${encodeURIComponent(sentinelId)}/memory`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'GET',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(renderRequestFailure(result.response.status, detail))
    return 1
  }

  const payload = isObject(result.data) ? result.data as SentinelMemoryResponse : {}
  stdout.write(`${payload.memory ?? ''}\n`)
  return 0
}

export async function runSentinelCli(
  args: readonly string[],
  dependencies: SentinelCliDependencies = {},
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
    return runList(context, fetchImpl, stdout, stderr, args.slice(1))
  }

  if (command === 'create') {
    return runCreate(context, fetchImpl, stdout, stderr, args.slice(1))
  }

  if (command === 'show') {
    const sentinelId = parseNonEmpty(args[1])
    if (!sentinelId || args.length !== 2) {
      printUsage(stderr)
      return 1
    }
    return runShow(context, fetchImpl, stdout, stderr, sentinelId)
  }

  if (command === 'pause') {
    const sentinelId = parseNonEmpty(args[1])
    if (!sentinelId || args.length !== 2) {
      printUsage(stderr)
      return 1
    }
    return runStatusUpdate(context, fetchImpl, stdout, stderr, sentinelId, 'paused', 'Paused')
  }

  if (command === 'resume') {
    const sentinelId = parseNonEmpty(args[1])
    if (!sentinelId || args.length !== 2) {
      printUsage(stderr)
      return 1
    }
    return runStatusUpdate(context, fetchImpl, stdout, stderr, sentinelId, 'active', 'Resumed')
  }

  if (command === 'complete') {
    const sentinelId = parseNonEmpty(args[1])
    if (!sentinelId || args.length !== 2) {
      printUsage(stderr)
      return 1
    }
    return runStatusUpdate(context, fetchImpl, stdout, stderr, sentinelId, 'completed', 'Completed')
  }

  if (command === 'cancel') {
    const sentinelId = parseNonEmpty(args[1])
    if (!sentinelId || args.length !== 2) {
      printUsage(stderr)
      return 1
    }
    return runStatusUpdate(context, fetchImpl, stdout, stderr, sentinelId, 'cancelled', 'Cancelled')
  }

  if (command === 'trigger') {
    const sentinelId = parseNonEmpty(args[1])
    if (!sentinelId || args.length !== 2) {
      printUsage(stderr)
      return 1
    }
    return runTrigger(context, fetchImpl, stdout, stderr, sentinelId)
  }

  if (command === 'delete') {
    const sentinelId = parseNonEmpty(args[1])
    if (!sentinelId || args.length !== 2) {
      printUsage(stderr)
      return 1
    }
    return runDelete(context, fetchImpl, stdout, stderr, sentinelId)
  }

  if (command === 'history') {
    const sentinelId = parseNonEmpty(args[1])
    if (!sentinelId) {
      printUsage(stderr)
      return 1
    }
    return runHistory(context, fetchImpl, stdout, stderr, sentinelId, args.slice(2))
  }

  if (command === 'report') {
    const sentinelId = parseNonEmpty(args[1])
    if (!sentinelId) {
      printUsage(stderr)
      return 1
    }
    return runReport(context, fetchImpl, stdout, stderr, sentinelId, args.slice(2))
  }

  if (command === 'memory') {
    const sentinelId = parseNonEmpty(args[1])
    if (!sentinelId || args.length !== 2) {
      printUsage(stderr)
      return 1
    }
    return runMemory(context, fetchImpl, stdout, stderr, sentinelId)
  }

  printUsage(stderr)
  return 1
}
