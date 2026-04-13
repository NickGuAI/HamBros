import { spawn } from 'node:child_process'
import { type HammurabiConfig, normalizeEndpoint, readHammurabiConfig } from './config.js'

interface Writable {
  write(chunk: string): boolean
}

interface MachineConfigPayload {
  id: string
  label: string
  host: string | null
  user?: string
  port?: number
  cwd?: string
}

interface MachineToolStatus {
  ok: boolean
  version: string | null
  raw: string
}

interface MachineHealthPayload {
  machineId: string
  mode: 'local' | 'ssh'
  ssh: {
    ok: boolean
    destination?: string
  }
  tools: Record<'claude' | 'codex' | 'gemini' | 'git' | 'node', MachineToolStatus>
}

interface AddOptions {
  id: string
  label: string
  host: string
  user?: string
  port?: number
  cwd?: string
}

interface BootstrapOptions {
  id: string
  tools: BootstrapTool[]
  configureTelemetry: boolean
  telemetryEndpoint: string
  telemetryApiKey: string
}

interface CommandRunResult {
  stdout: string
  stderr: string
  code: number
}

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandRunResult>

export interface MachinesCliDependencies {
  fetchImpl?: typeof fetch
  readConfig?: () => Promise<HammurabiConfig | null>
  stdout?: Writable
  stderr?: Writable
  runCommand?: CommandRunner
}

const TOOL_PACKAGE_NAMES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
} as const

type BootstrapTool = keyof typeof TOOL_PACKAGE_NAMES

const DEFAULT_BOOTSTRAP_TOOLS: BootstrapTool[] = ['claude', 'codex', 'gemini']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`
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

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  hammurabi machine list\n')
  stdout.write('  hammurabi machine add --id <id> --label <label> --host <host> [--user <user>] [--port <port>] [--cwd <cwd>]\n')
  stdout.write('  hammurabi machine check <id>\n')
  stdout.write('  hammurabi machine remove <id>\n')
  stdout.write('  hammurabi machine bootstrap <id> [--tools claude,codex] [--skip-telemetry]\n')
}

function parseMachines(payload: unknown): MachineConfigPayload[] {
  if (!Array.isArray(payload)) {
    return []
  }

  const machines: MachineConfigPayload[] = []
  for (const entry of payload) {
    if (!isObject(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    const host = entry.host === null
      ? null
      : (typeof entry.host === 'string' && entry.host.trim().length > 0 ? entry.host.trim() : null)
    const user = typeof entry.user === 'string' && entry.user.trim().length > 0 ? entry.user.trim() : undefined
    const port = typeof entry.port === 'number' ? entry.port : undefined
    const cwd = typeof entry.cwd === 'string' && entry.cwd.trim().length > 0 ? entry.cwd.trim() : undefined
    if (!id || !label) continue
    machines.push({ id, label, host, user, port, cwd })
  }
  return machines
}

function parseHealth(payload: unknown): MachineHealthPayload | null {
  if (!isObject(payload)) {
    return null
  }

  const machineId = typeof payload.machineId === 'string' ? payload.machineId.trim() : ''
  const mode = payload.mode === 'local' ? 'local' : (payload.mode === 'ssh' ? 'ssh' : null)
  const ssh = isObject(payload.ssh)
    ? {
      ok: payload.ssh.ok === true,
      destination: typeof payload.ssh.destination === 'string' ? payload.ssh.destination.trim() : undefined,
    }
    : null
  const toolsRaw = isObject(payload.tools) ? payload.tools : null
  if (!machineId || !mode || !ssh || !toolsRaw) {
    return null
  }

  const tools: MachineHealthPayload['tools'] = {
    claude: parseToolStatus(toolsRaw.claude),
    codex: parseToolStatus(toolsRaw.codex),
    gemini: parseToolStatus(toolsRaw.gemini),
    git: parseToolStatus(toolsRaw.git),
    node: parseToolStatus(toolsRaw.node),
  }

  return {
    machineId,
    mode,
    ssh,
    tools,
  }
}

function parseToolStatus(value: unknown): MachineToolStatus {
  if (!isObject(value)) {
    return {
      ok: false,
      version: null,
      raw: 'missing',
    }
  }

  const raw = typeof value.raw === 'string' && value.raw.trim().length > 0 ? value.raw.trim() : 'missing'
  const version = typeof value.version === 'string' && value.version.trim().length > 0
    ? value.version.trim()
    : null

  return {
    ok: value.ok === true,
    version,
    raw,
  }
}

function formatHost(machine: MachineConfigPayload): string {
  return machine.host ?? 'local'
}

function printMachinesTable(stdout: Writable, machines: readonly MachineConfigPayload[]): void {
  if (machines.length === 0) {
    stdout.write('No registered machines.\n')
    return
  }

  const headers = ['ID', 'Label', 'Host', 'Port', 'Cwd']
  const rows = machines.map((machine) => [
    machine.id,
    machine.label,
    formatHost(machine),
    machine.port ? String(machine.port) : '-',
    machine.cwd ?? '-',
  ])
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  )

  const formatRow = (row: readonly string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index])).join('  ')

  stdout.write(`${formatRow(headers)}\n`)
  stdout.write(`${widths.map((width) => '-'.repeat(width)).join('  ')}\n`)
  for (const row of rows) {
    stdout.write(`${formatRow(row)}\n`)
  }
}

function printHealth(stdout: Writable, health: MachineHealthPayload): void {
  stdout.write(`Machine: ${health.machineId}\n`)
  stdout.write(`Mode: ${health.mode}\n`)
  stdout.write(`SSH: ${health.ssh.ok ? 'ok' : 'failed'}`)
  if (health.ssh.destination) {
    stdout.write(` (${health.ssh.destination})`)
  }
  stdout.write('\n')
  for (const tool of ['claude', 'codex', 'git', 'node'] as const) {
    stdout.write(`- ${tool}: ${health.tools[tool].ok ? health.tools[tool].raw : 'missing'}\n`)
  }
}

function parseAddOptions(args: readonly string[]): AddOptions | null {
  let id: string | undefined
  let label: string | undefined
  let host: string | undefined
  let user: string | undefined
  let port: number | undefined
  let cwd: string | undefined

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const rawValue = args[index + 1]
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!value) {
      return null
    }

    if (flag === '--id') {
      id = value
      continue
    }
    if (flag === '--label') {
      label = value
      continue
    }
    if (flag === '--host') {
      host = value
      continue
    }
    if (flag === '--user') {
      user = value
      continue
    }
    if (flag === '--port') {
      const parsed = Number.parseInt(value, 10)
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        return null
      }
      port = parsed
      continue
    }
    if (flag === '--cwd') {
      cwd = value
      continue
    }
    return null
  }

  if (!id || !label || !host) {
    return null
  }
  if (host.includes('@')) {
    return null
  }
  if (cwd && !cwd.startsWith('/')) {
    return null
  }

  return { id, label, host, user, port, cwd }
}

function parseBootstrapToolList(value: string): BootstrapTool[] | null {
  const rawItems = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const tools = rawItems.filter((item): item is BootstrapTool => item === 'claude' || item === 'codex')

  if (tools.length === 0 || tools.length !== rawItems.length) {
    return null
  }

  return [...new Set(tools)]
}

function parseBootstrapOptions(args: readonly string[], config: HammurabiConfig): BootstrapOptions | null {
  const id = args[0]?.trim()
  if (!id) {
    return null
  }

  let tools = [...DEFAULT_BOOTSTRAP_TOOLS]
  let configureTelemetry = true
  let telemetryEndpoint = config.endpoint
  let telemetryApiKey = config.apiKey

  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--skip-telemetry') {
      configureTelemetry = false
      continue
    }

    const value = args[index + 1]?.trim()
    if (!value) {
      return null
    }

    if (flag === '--tools') {
      const parsed = parseBootstrapToolList(value)
      if (!parsed) {
        return null
      }
      tools = parsed
    } else if (flag === '--telemetry-endpoint') {
      telemetryEndpoint = value
    } else if (flag === '--telemetry-api-key') {
      telemetryApiKey = value
    } else {
      return null
    }

    index += 1
  }

  return {
    id,
    tools,
    configureTelemetry,
    telemetryEndpoint,
    telemetryApiKey,
  }
}

function buildSshDestination(machine: MachineConfigPayload & { host: string }): string {
  return machine.user ? `${machine.user}@${machine.host}` : machine.host
}

function buildBootstrapScript(options: BootstrapOptions): string {
  const packages = options.tools.map((tool) => TOOL_PACKAGE_NAMES[tool])
  const scriptLines = [
    'set -eu',
    'PREFIX="$HOME/.hammurabi/tools"',
    'BIN_DIR="$PREFIX/bin"',
    'ensure_path_block() {',
    '  file="$1"',
    '  touch "$file"',
    '  if ! grep -Fq \'export PATH="$HOME/.hammurabi/tools/bin:$PATH"\' "$file"; then',
    '    {',
    "      printf '\\n# >>> hammurabi machine bootstrap >>>\\n'",
    "      printf 'export PATH=\"$HOME/.hammurabi/tools/bin:$PATH\"\\n'",
    "      printf '# <<< hammurabi machine bootstrap <<<\\n'",
    '    } >> "$file"',
    '  fi',
    '}',
    'ensure_path_block "$HOME/.bash_profile"',
    'ensure_path_block "$HOME/.profile"',
    'mkdir -p "$PREFIX"',
    'if ! command -v node >/dev/null 2>&1; then',
    "  echo 'node:missing'",
    '  exit 21',
    'fi',
    'if ! command -v npm >/dev/null 2>&1; then',
    "  echo 'npm:missing'",
    '  exit 22',
    'fi',
    'export PATH="$BIN_DIR:$PATH"',
    `npm install --global --prefix "$PREFIX" ${packages.map((pkg) => shellEscape(pkg)).join(' ')}`,
  ]

  if (options.configureTelemetry) {
    const telemetryJson = JSON.stringify({
      endpoint: normalizeEndpoint(options.telemetryEndpoint),
      apiKey: options.telemetryApiKey.trim(),
      agents: ['claude-code', 'codex'],
      configuredAt: new Date().toISOString(),
    })
    scriptLines.push(
      `printf '%s\\n' ${shellEscape(telemetryJson)} > "$HOME/.hammurabi.json"`,
      "echo 'telemetry:configured'",
    )
  } else {
    scriptLines.push("echo 'telemetry:skipped'")
  }

  for (const tool of options.tools) {
    scriptLines.push(
      `if command -v ${tool} >/dev/null 2>&1; then ${tool} --version | head -n 1 | sed 's/^/installed:${tool}:/'; else echo 'installed:${tool}:missing'; fi`,
    )
  }
  scriptLines.push("echo 'bootstrap:ok'")

  return scriptLines.join('\n')
}

function buildBootstrapRemoteCommand(script: string): string {
  return `exec /bin/bash -lc ${shellEscape(script)}`
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandRunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: CommandRunResult): void => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      resolve(result)
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', (error) => {
      if (timer) {
        clearTimeout(timer)
      }
      reject(error)
    })
    proc.on('close', (code) => {
      finish({
        stdout,
        stderr,
        code: code ?? 1,
      })
    })

    const timer = options.timeoutMs
      ? setTimeout(() => {
        proc.kill('SIGTERM')
      }, options.timeoutMs)
      : null
  })
}

async function fetchMachines(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; data: MachineConfigPayload[] } | { ok: false; response: Response }> {
  const result = await fetchJson(fetchImpl, buildApiUrl(config.endpoint, '/api/agents/machines'), {
    method: 'GET',
    headers: buildAuthHeaders(config, false),
  })
  if (!result.ok) {
    return result
  }
  return {
    ok: true,
    data: parseMachines(result.data),
  }
}

async function fetchMachineHealth(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  machineId: string,
): Promise<{ ok: true; data: MachineHealthPayload } | { ok: false; response: Response } | { ok: true; data: null }> {
  const result = await fetchJson(
    fetchImpl,
    buildApiUrl(config.endpoint, `/api/agents/machines/${encodeURIComponent(machineId)}/health`),
    {
      method: 'GET',
      headers: buildAuthHeaders(config, false),
    },
  )
  if (!result.ok) {
    return result
  }

  const health = parseHealth(result.data)
  if (!health) {
    return {
      ok: true,
      data: null,
    }
  }
  return {
    ok: true,
    data: health,
  }
}

async function runList(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const result = await fetchMachines(config, fetchImpl)
  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(detail ? `Request failed (${result.response.status}): ${detail}\n` : `Request failed (${result.response.status}).\n`)
    return 1
  }

  printMachinesTable(stdout, result.data)
  return 0
}

async function runAdd(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: AddOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const result = await fetchJson(fetchImpl, buildApiUrl(config.endpoint, '/api/agents/machines'), {
    method: 'POST',
    headers: buildAuthHeaders(config, true),
    body: JSON.stringify(options),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(detail ? `Request failed (${result.response.status}): ${detail}\n` : `Request failed (${result.response.status}).\n`)
    return 1
  }

  const machines = parseMachines([result.data])
  const created = machines[0]
  stdout.write(`Registered machine: ${created?.id ?? options.id}\n`)
  if (created) {
    stdout.write(`Host: ${formatHost(created)}\n`)
  }
  return 0
}

async function runCheck(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  machineId: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const result = await fetchMachineHealth(config, fetchImpl, machineId)
  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(detail ? `Request failed (${result.response.status}): ${detail}\n` : `Request failed (${result.response.status}).\n`)
    return 1
  }

  if (!result.data) {
    stderr.write('Health response was empty.\n')
    return 1
  }

  printHealth(stdout, result.data)
  return 0
}

async function runRemove(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  machineId: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const result = await fetchJson(
    fetchImpl,
    buildApiUrl(config.endpoint, `/api/agents/machines/${encodeURIComponent(machineId)}`),
    {
      method: 'DELETE',
      headers: buildAuthHeaders(config, false),
    },
  )

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(detail ? `Request failed (${result.response.status}): ${detail}\n` : `Request failed (${result.response.status}).\n`)
    return 1
  }

  stdout.write(`Removed machine: ${machineId}\n`)
  return 0
}

async function runBootstrap(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  runCommand: CommandRunner,
  options: BootstrapOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const machinesResult = await fetchMachines(config, fetchImpl)
  if (!machinesResult.ok) {
    const detail = await readErrorDetail(machinesResult.response)
    stderr.write(detail ? `Request failed (${machinesResult.response.status}): ${detail}\n` : `Request failed (${machinesResult.response.status}).\n`)
    return 1
  }

  const machine = machinesResult.data.find((entry) => entry.id === options.id)
  if (!machine) {
    stderr.write(`Machine "${options.id}" not found.\n`)
    return 1
  }

  const script = buildBootstrapScript(options)
  const commandResult = machine.host
    ? await runCommand(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        ...(machine.port ? ['-p', String(machine.port)] : []),
        buildSshDestination(machine as MachineConfigPayload & { host: string }),
        buildBootstrapRemoteCommand(script),
      ],
      { timeoutMs: 300_000 },
    )
    : await runCommand('/bin/bash', ['-lc', script], {
      cwd: machine.cwd,
      timeoutMs: 300_000,
    })

  if (commandResult.stdout.trim()) {
    stdout.write(commandResult.stdout.trimEnd() + '\n')
  }
  if (commandResult.code !== 0) {
    if (commandResult.stderr.trim()) {
      stderr.write(commandResult.stderr.trimEnd() + '\n')
    }
    stderr.write(`Bootstrap failed with exit code ${commandResult.code}.\n`)
    return 1
  }

  const healthResult = await fetchMachineHealth(config, fetchImpl, options.id)
  if (!healthResult.ok) {
    const detail = await readErrorDetail(healthResult.response)
    stderr.write(detail ? `Health verification failed (${healthResult.response.status}): ${detail}\n` : `Health verification failed (${healthResult.response.status}).\n`)
    return 1
  }
  if (!healthResult.data) {
    stderr.write('Health verification response was empty.\n')
    return 1
  }

  stdout.write('Service health after bootstrap:\n')
  printHealth(stdout, healthResult.data)
  stdout.write('Manual prerequisites:\n')
  stdout.write('- Remote SSH access must already work from the machine running this CLI.\n')
  stdout.write('- The target must already have Node.js and npm installed.\n')
  stdout.write('- Claude/Codex login state is still manual on the target (`claude login`, `codex login`).\n')
  stdout.write('- Bootstrap writes `~/.hammurabi.json` plus PATH setup; agent-specific OTEL env merges remain manual.\n')
  return 0
}

export async function runMachinesCli(
  args: readonly string[],
  dependencies: MachinesCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const readConfig = dependencies.readConfig ?? readHammurabiConfig
  const runCommand = dependencies.runCommand ?? defaultRunCommand

  const command = args[0]
  if (!command || !['list', 'add', 'check', 'remove', 'bootstrap'].includes(command)) {
    printUsage(stdout)
    return 1
  }

  const config = await readConfig()
  if (!config) {
    stderr.write('Hammurabi config not found. Run `hammurabi onboard` first.\n')
    return 1
  }

  if (command === 'list') {
    if (args.length !== 1) {
      printUsage(stdout)
      return 1
    }
    return runList(config, fetchImpl, stdout, stderr)
  }

  if (command === 'add') {
    const options = parseAddOptions(args.slice(1))
    if (!options) {
      stderr.write('Invalid add arguments. Use --host without user@ and provide absolute --cwd when set.\n')
      printUsage(stdout)
      return 1
    }
    return runAdd(config, fetchImpl, options, stdout, stderr)
  }

  if (command === 'check') {
    const machineId = args[1]?.trim()
    if (!machineId || args.length !== 2) {
      printUsage(stdout)
      return 1
    }
    return runCheck(config, fetchImpl, machineId, stdout, stderr)
  }

  if (command === 'remove') {
    const machineId = args[1]?.trim()
    if (!machineId || args.length !== 2) {
      printUsage(stdout)
      return 1
    }
    return runRemove(config, fetchImpl, machineId, stdout, stderr)
  }

  const options = parseBootstrapOptions(args.slice(1), config)
  if (!options) {
    printUsage(stdout)
    return 1
  }
  return runBootstrap(config, fetchImpl, runCommand, options, stdout, stderr)
}
