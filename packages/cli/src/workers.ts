import { type HammurabiConfig, normalizeEndpoint, readHammurabiConfig } from './config.js'

interface Writable {
  write(chunk: string): boolean
}

interface DispatchOptions {
  parentSession: string
  issueUrl?: string
  task?: string
  branch?: string
  machine?: string
  agentType?: 'claude' | 'codex'
  workerType?: 'factory' | 'agent'
}

interface SendOptions {
  sessionName: string
  text: string
}

interface AgentSessionSummary {
  name: string
  sessionType?: string
  cwd?: string
  host?: string
}

interface WorkerSessionStatus {
  name: string
  completed: boolean
  status?: string
}

export interface WorkersCliDependencies {
  fetchImpl?: typeof fetch
  readConfig?: () => Promise<HammurabiConfig | null>
  stdout?: Writable
  stderr?: Writable
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  hambros workers list\n')
  stdout.write(
    '  hambros workers dispatch --session <name> [--type factory|agent] [--issue <url>] [--task <text>] [--branch <name>] [--machine <id>] [--agent claude|codex]\n',
  )
  stdout.write('  hambros workers kill <name>\n')
  stdout.write('  hambros workers status <session-name>\n')
  stdout.write('  hambros workers send <session-name> "<text>"\n')
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

function parseSessionName(value: string | undefined): string | null {
  const name = value?.trim() ?? ''
  return name.length > 0 ? name : null
}

async function runKill(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  sessionName: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    config.endpoint,
    `/api/agents/sessions/${encodeURIComponent(sessionName)}`,
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

  stdout.write(`Session ${sessionName} killed.\n`)
  return 0
}

function parseDispatchOptions(args: readonly string[]): DispatchOptions | null {
  let parentSession: string | undefined
  let issueUrl: string | undefined
  let task: string | undefined
  let branch: string | undefined
  let machine: string | undefined
  let agentType: 'claude' | 'codex' | undefined
  let workerType: 'factory' | 'agent' | undefined

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]?.trim()

    if (
      flag !== '--session' &&
      flag !== '--issue' &&
      flag !== '--task' &&
      flag !== '--branch' &&
      flag !== '--machine' &&
      flag !== '--agent' &&
      flag !== '--type'
    ) {
      return null
    }
    if (!value) {
      return null
    }

    if (flag === '--session') {
      parentSession = value
    } else if (flag === '--issue') {
      issueUrl = value
    } else if (flag === '--task') {
      task = value
    } else if (flag === '--branch') {
      branch = value
    } else if (flag === '--machine') {
      machine = value
    } else if (flag === '--agent') {
      if (value !== 'claude' && value !== 'codex') {
        return null
      }
      agentType = value
    } else if (flag === '--type') {
      if (value !== 'factory' && value !== 'agent') {
        return null
      }
      workerType = value
    }

    index += 1
  }

  if (!parentSession) {
    return null
  }

  if ((workerType ?? 'factory') !== 'agent' && !issueUrl && !branch) {
    return null
  }

  return {
    parentSession,
    issueUrl,
    task,
    branch,
    machine,
    agentType,
    workerType,
  }
}

function parseSendOptions(args: readonly string[]): SendOptions | null {
  const sessionName = parseSessionName(args[0])
  const text = args[1]?.trim() ?? ''

  if (!sessionName || text.length === 0 || args.length !== 2) {
    return null
  }

  return {
    sessionName,
    text,
  }
}

function parseSessions(payload: unknown): AgentSessionSummary[] {
  const raw = Array.isArray(payload)
    ? payload
    : (isObject(payload) && Array.isArray(payload.sessions) ? payload.sessions : [])

  const sessions: AgentSessionSummary[] = []
  for (const entry of raw) {
    if (!isObject(entry)) {
      continue
    }

    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!name) {
      continue
    }

    const sessionType = typeof entry.sessionType === 'string' ? entry.sessionType.trim() : undefined
    const cwd = typeof entry.cwd === 'string' ? entry.cwd.trim() : undefined
    const host = typeof entry.host === 'string' ? entry.host.trim() : undefined

    sessions.push({
      name,
      sessionType,
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
      host: host && host.length > 0 ? host : undefined,
    })
  }

  return sessions
}

function parseWorkerStatus(payload: unknown): WorkerSessionStatus | null {
  if (!isObject(payload)) {
    return null
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  const status = typeof payload.status === 'string' ? payload.status.trim() : ''
  const completed =
    typeof payload.completed === 'boolean' ? payload.completed : status.toLowerCase() === 'completed'

  if (!name && !status) {
    return null
  }

  return {
    name: name.length > 0 ? name : '(unknown)',
    completed,
    status: status.length > 0 ? status : undefined,
  }
}

function resolveWorkerSessionType(sessionName: string): 'factory' | 'agent' | null {
  if (sessionName.startsWith('factory-')) {
    return 'factory'
  }
  if (sessionName.startsWith('agent-')) {
    return 'agent'
  }
  return null
}

async function runList(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(config.endpoint, '/api/agents/sessions')
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

  const workers = parseSessions(result.data).filter((session) => (
    session.sessionType === 'stream' && resolveWorkerSessionType(session.name) !== null
  ))

  if (workers.length === 0) {
    stdout.write('No active workers.\n')
    return 0
  }

  const hasAgentWorkers = workers.some((worker) => resolveWorkerSessionType(worker.name) === 'agent')
  stdout.write(hasAgentWorkers ? 'Active workers:\n' : 'Active factory workers:\n')
  for (const worker of workers) {
    const type = resolveWorkerSessionType(worker.name) ?? 'factory'
    const host = worker.host ? ` host=${worker.host}` : ''
    const cwd = worker.cwd ? ` cwd=${worker.cwd}` : ''
    const typeLabel = hasAgentWorkers ? ` type=${type}` : ''
    stdout.write(`- ${worker.name}${host}${cwd}${typeLabel}\n`)
  }

  return 0
}

async function runDispatch(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: DispatchOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(config.endpoint, '/api/agents/sessions/dispatch-worker')
  const body: Record<string, string> = {
    parentSession: options.parentSession,
  }
  if (options.issueUrl) {
    body.issueUrl = options.issueUrl
  }
  if (options.task) {
    body.task = options.task
  }
  if (options.branch) {
    body.branch = options.branch
  }
  if (options.machine) {
    body.machine = options.machine
  }
  if (options.agentType) {
    body.agentType = options.agentType
  }
  if (options.workerType) {
    body.workerType = options.workerType
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
  const name = typeof payload.name === 'string' ? payload.name : '(unknown)'
  const workerType = typeof payload.workerType === 'string' ? payload.workerType : undefined
  const branch = typeof payload.branch === 'string' ? payload.branch : undefined
  const worktree = typeof payload.worktree === 'string' ? payload.worktree : undefined
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined

  stdout.write(`Worker dispatched: ${name}\n`)
  if (workerType) {
    stdout.write(`Type: ${workerType}\n`)
  }
  if (branch) {
    stdout.write(`Branch: ${branch}\n`)
  }
  if (worktree) {
    stdout.write(`Worktree: ${worktree}\n`)
  }
  if (cwd) {
    stdout.write(`Cwd: ${cwd}\n`)
  }
  return 0
}

async function runStatus(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  sessionName: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    config.endpoint,
    `/api/agents/sessions/${encodeURIComponent(sessionName)}`,
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

  const summary = parseWorkerStatus(result.data)
  if (!summary) {
    stderr.write('Request succeeded but response was malformed.\n')
    return 1
  }

  const lifecycleStatus = summary.completed ? 'completed' : 'running'
  stdout.write(`session: ${summary.name}\n`)
  stdout.write(`status: ${lifecycleStatus}\n`)

  if (summary.completed && summary.status && summary.status !== lifecycleStatus) {
    stdout.write(`result: ${summary.status}\n`)
  }

  return 0
}

async function runSend(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: SendOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    config.endpoint,
    `/api/agents/sessions/${encodeURIComponent(options.sessionName)}/send`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(config, true),
    body: JSON.stringify({ text: options.text }),
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
  const sent = typeof payload.sent === 'boolean' ? payload.sent : false
  stdout.write(`sent: ${sent}\n`)

  return 0
}

export async function runWorkersCli(
  args: readonly string[],
  dependencies: WorkersCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const readConfig = dependencies.readConfig ?? readHammurabiConfig

  const command = args[0]
  if (!command || (command !== 'list' && command !== 'dispatch' && command !== 'kill' && command !== 'status' && command !== 'send')) {
    printUsage(stdout)
    return 1
  }

  const config = await readConfig()
  if (!config) {
    stderr.write('HamBros config not found. Run `hambros init` first.\n')
    return 1
  }

  if (command === 'list') {
    if (args.length !== 1) {
      printUsage(stdout)
      return 1
    }
    return runList(config, fetchImpl, stdout, stderr)
  }

  if (command === 'kill') {
    const sessionName = parseSessionName(args[1])
    if (!sessionName || args.length !== 2) {
      printUsage(stdout)
      return 1
    }
    return runKill(config, fetchImpl, sessionName, stdout, stderr)
  }

  if (command === 'dispatch') {
    const dispatchOptions = parseDispatchOptions(args.slice(1))
    if (!dispatchOptions) {
      printUsage(stdout)
      return 1
    }
    return runDispatch(config, fetchImpl, dispatchOptions, stdout, stderr)
  }

  if (command === 'status') {
    const sessionName = parseSessionName(args[1])
    if (!sessionName || args.length !== 2) {
      printUsage(stdout)
      return 1
    }
    return runStatus(config, fetchImpl, sessionName, stdout, stderr)
  }

  const sendOptions = parseSendOptions(args.slice(1))
  if (!sendOptions) {
    printUsage(stdout)
    return 1
  }

  return runSend(config, fetchImpl, sendOptions, stdout, stderr)
}
