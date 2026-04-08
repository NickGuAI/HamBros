import { type HammurabiConfig, normalizeEndpoint, readHammurabiConfig } from './config.js'

interface Writable {
  write(chunk: string): boolean
}

export interface SessionCliDependencies {
  fetchImpl?: typeof fetch
  readConfig?: () => Promise<HammurabiConfig | null>
  stdout?: Writable
  stderr?: Writable
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

      const error = payload.error
      if (typeof error === 'string' && error.trim().length > 0) {
        return error.trim()
      }

      const message = payload.message
      if (typeof message === 'string' && message.trim().length > 0) {
        return message.trim()
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

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  hammurabi session register --name <name> --machine <machine> [--cwd <path>] [--agent claude|codex|openclaw] [--task <text>]\n')
  stdout.write('  hammurabi session heartbeat --name <name>\n')
  stdout.write('  hammurabi session events --name <name> --events \'[{"type":"..."}]\'\n')
  stdout.write('  hammurabi session unregister --name <name>\n')
}

function parseFlag(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return undefined
  return args[idx + 1]
}

async function runRegister(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  args: readonly string[],
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const name = parseFlag(args, '--name')
  const machine = parseFlag(args, '--machine')
  const cwd = parseFlag(args, '--cwd')
  const agentType = parseFlag(args, '--agent')
  const task = parseFlag(args, '--task')

  if (!name) {
    stderr.write('--name is required\n')
    return 1
  }
  if (!machine) {
    stderr.write('--machine is required\n')
    return 1
  }

  const url = buildApiUrl(config.endpoint, '/api/agents/sessions/register')
  const body: Record<string, unknown> = { name, machine }
  if (cwd) body.cwd = cwd
  if (agentType) body.agentType = agentType
  if (task) body.task = task

  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(config, true),
    body: JSON.stringify(body),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Register failed (${result.response.status}): ${detail}\n`
        : `Register failed (${result.response.status}).\n`,
    )
    return 1
  }

  const data = result.data
  if (isObject(data)) {
    stdout.write(`Registered session "${data.name}" from ${data.machine}\n`)
  } else {
    stdout.write('Session registered.\n')
  }
  return 0
}

async function runHeartbeat(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  args: readonly string[],
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const name = parseFlag(args, '--name')
  if (!name) {
    stderr.write('--name is required\n')
    return 1
  }

  const url = buildApiUrl(config.endpoint, `/api/agents/sessions/${encodeURIComponent(name)}/heartbeat`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(config, true),
    body: JSON.stringify({}),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Heartbeat failed (${result.response.status}): ${detail}\n`
        : `Heartbeat failed (${result.response.status}).\n`,
    )
    return 1
  }

  stdout.write(`Heartbeat sent for "${name}".\n`)
  return 0
}

async function runEvents(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  args: readonly string[],
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const name = parseFlag(args, '--name')
  const eventsStr = parseFlag(args, '--events')

  if (!name) {
    stderr.write('--name is required\n')
    return 1
  }
  if (!eventsStr) {
    stderr.write('--events is required (JSON array)\n')
    return 1
  }

  let events: unknown[]
  try {
    const parsed = JSON.parse(eventsStr) as unknown
    if (!Array.isArray(parsed)) {
      stderr.write('--events must be a JSON array\n')
      return 1
    }
    events = parsed
  } catch {
    stderr.write('--events must be valid JSON\n')
    return 1
  }

  const url = buildApiUrl(config.endpoint, `/api/agents/sessions/${encodeURIComponent(name)}/events`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(config, true),
    body: JSON.stringify({ events }),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Events push failed (${result.response.status}): ${detail}\n`
        : `Events push failed (${result.response.status}).\n`,
    )
    return 1
  }

  const data = result.data
  const accepted = isObject(data) && typeof data.accepted === 'number' ? data.accepted : 0
  stdout.write(`Pushed ${accepted} event(s) to "${name}".\n`)
  return 0
}

async function runUnregister(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  args: readonly string[],
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const name = parseFlag(args, '--name')
  if (!name) {
    stderr.write('--name is required\n')
    return 1
  }

  const url = buildApiUrl(config.endpoint, `/api/agents/sessions/${encodeURIComponent(name)}`)
  const result = await fetchJson(fetchImpl, url, {
    method: 'DELETE',
    headers: buildAuthHeaders(config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Unregister failed (${result.response.status}): ${detail}\n`
        : `Unregister failed (${result.response.status}).\n`,
    )
    return 1
  }

  stdout.write(`Session "${name}" unregistered.\n`)
  return 0
}

export async function runSessionCli(
  args: readonly string[],
  deps: SessionCliDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const fetchImpl = deps.fetchImpl ?? fetch
  const readConfig = deps.readConfig ?? readHammurabiConfig

  const subcommand = args[0]

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printUsage(stdout)
    return subcommand ? 0 : 1
  }

  const config = await readConfig()
  if (!config) {
    stderr.write('Not configured. Run: hammurabi onboard\n')
    return 1
  }

  switch (subcommand) {
    case 'register':
      return runRegister(config, fetchImpl, args.slice(1), stdout, stderr)
    case 'heartbeat':
      return runHeartbeat(config, fetchImpl, args.slice(1), stdout, stderr)
    case 'events':
      return runEvents(config, fetchImpl, args.slice(1), stdout, stderr)
    case 'unregister':
      return runUnregister(config, fetchImpl, args.slice(1), stdout, stderr)
    default:
      stderr.write(`Unknown session subcommand: ${subcommand}\n`)
      printUsage(stderr)
      return 1
  }
}
