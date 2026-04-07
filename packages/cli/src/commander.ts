import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const COMMANDER_FILENAME = 'COMMANDER.md'
const MEMORY_HEADER = '# Commander Memory\n\n'
const DEFAULT_REMOTE_POLL_INTERVAL_MS = 15_000
const ISO_DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const COMMANDER_TEMPLATE = `---
# heartbeat fire interval in milliseconds (default: 300000 = 5 min)
heartbeat.interval: 900000
#
# override the default heartbeat message sent to the agent
heartbeat.message: "Check your quest board. What is your current task? Post a progress note, then continue or pick up the next quest."
#
# max agent turns per session start (1–10, default: 3)
# maxTurns: 3
#
# context delivery mode: "fat" (full) or "thin" (3000-token budget)
contextMode: fat
#
# System prompt: add text below the closing --- to replace the default Commander prompt.
---

You are [NAME], engineering commander for Gehirn / Pioneering Minds AI.
Workspace: [WORKSPACE_CWD]

## Quest Board (your primary work queue)

\`\`\`
hambros quests list
hambros quests claim <quest-id>
hambros quests note <quest-id> "<progress text>"
hambros quests done <quest-id> --note "<summary>"
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
hambros memory find --commander [COMMANDER_ID] "<query>"
hambros memory save --commander [COMMANDER_ID] "<fact>"
hambros memory compact --commander [COMMANDER_ID]
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
- Use \`cat\` when you know the file you need; use \`hambros memory find\` when you need recall.
- Save durable facts, not transient chatter.
- Compact after major work or context pressure.
`

interface Writable {
  write(chunk: string): boolean
}

interface RemoteQuest {
  id: string
  instruction: string
}

export interface RemoteMemoryExportPayload {
  memoryMd: string
  journal: Record<string, string>
  repos: Record<string, string>
  skills: Record<string, string>
}

export interface RemoteJournalEntry {
  timestamp: string
  issueNumber: number | null
  repo: string | null
  outcome: string
  durationMin: number | null
  salience: 'SPIKE' | 'NOTABLE' | 'ROUTINE'
  body: string
}

export interface CommanderCliDependencies {
  cwd?: string
  fileExists?: (path: string) => boolean
  writeFile?: (path: string, content: string) => void
  fetchImpl?: typeof fetch
  commanderId?: string | null
  sleep?: (ms: number) => Promise<void>
  maxPolls?: number
  stdout?: Writable
  stderr?: Writable
}

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  hambros commander init\n')
  stdout.write('  hambros commander init --remote <server-url> --token <sync-token> [--commander <id>] [--poll-interval <seconds>] [--once]\n')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseNonEmpty(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/g, '')
}

function renderCommanderTemplate(cwd: string): string {
  return COMMANDER_TEMPLATE.split('[WORKSPACE_CWD]').join(cwd)
}

function parsePositiveInteger(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) {
    return null
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null
  }
  return parsed
}

function buildApiUrl(endpoint: string, apiPath: string): string {
  return new URL(apiPath, `${normalizeEndpoint(endpoint)}/`).toString()
}

function buildRemoteAuthHeaders(token: string, includeJsonContentType: boolean): HeadersInit {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  }
  if (includeJsonContentType) {
    headers['content-type'] = 'application/json'
  }
  return headers
}

function parseStringMap(raw: unknown): Record<string, string> | null {
  if (!isObject(raw)) {
    return null
  }

  const parsed: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const safeKey = key.trim()
    if (!safeKey || typeof value !== 'string') {
      return null
    }
    parsed[safeKey] = value
  }

  return parsed
}

function parseRemoteMemoryExportPayload(payload: unknown): RemoteMemoryExportPayload | null {
  if (!isObject(payload)) {
    return null
  }

  const memoryMd = typeof payload.memoryMd === 'string' ? payload.memoryMd : MEMORY_HEADER
  const journal = parseStringMap(payload.journal)
  const repos = parseStringMap(payload.repos)
  const skills = parseStringMap(payload.skills)
  if (!journal || !repos || !skills) {
    return null
  }

  return { memoryMd, journal, repos, skills }
}

function parseRemoteQuest(payload: unknown): RemoteQuest | null {
  if (!isObject(payload)) {
    return null
  }

  const id = parseNonEmpty(typeof payload.id === 'string' ? payload.id : null)
  const instruction = parseNonEmpty(
    typeof payload.instruction === 'string' ? payload.instruction : null,
  )
  if (!id || !instruction) {
    return null
  }

  return {
    id,
    instruction,
  }
}

function resolveSafeRelativePath(root: string, relativePath: string): string | null {
  const trimmed = relativePath.trim().replace(/\\/g, '/')
  if (!trimmed || trimmed.startsWith('/')) {
    return null
  }

  const segments = trimmed
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    return null
  }

  const candidate = resolve(root, ...segments)
  const normalizedRoot = resolve(root)
  const rootPrefix = normalizedRoot.endsWith(sep)
    ? normalizedRoot
    : `${normalizedRoot}${sep}`
  if (!candidate.startsWith(rootPrefix)) {
    return null
  }

  return candidate
}

function writeMappedFiles(baseDir: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const resolved = resolveSafeRelativePath(baseDir, relativePath)
    if (!resolved) {
      throw new Error(`Invalid snapshot path: ${relativePath}`)
    }
    mkdirSync(resolve(resolved, '..'), { recursive: true })
    writeFileSync(resolved, content, 'utf8')
  }
}

function collectSnapshotFiles(baseDir: string): Record<string, string> {
  const files: Record<string, string> = {}
  if (!existsSync(baseDir)) {
    return files
  }

  const walk = (relativeDir: string): void => {
    const absoluteDir = relativeDir.length > 0 ? join(baseDir, relativeDir) : baseDir
    const entries = readdirSync(absoluteDir, { withFileTypes: true })

    for (const entry of entries) {
      const nextRelative = relativeDir.length > 0
        ? `${relativeDir}/${entry.name}`
        : entry.name
      if (entry.isDirectory()) {
        walk(nextRelative)
        continue
      }
      if (!entry.isFile()) {
        continue
      }

      const absoluteFilePath = join(baseDir, nextRelative)
      files[nextRelative] = readFileSync(absoluteFilePath, 'utf8')
    }
  }

  walk('')
  return files
}

function scaffoldLocalSnapshot(cwd: string, snapshot: RemoteMemoryExportPayload): void {
  const memoryRoot = join(cwd, '.memory')
  const journalRoot = join(memoryRoot, 'journal')
  const reposRoot = join(memoryRoot, 'repos')
  const skillsRoot = join(cwd, 'skills')

  mkdirSync(memoryRoot, { recursive: true })
  mkdirSync(journalRoot, { recursive: true })
  mkdirSync(reposRoot, { recursive: true })
  mkdirSync(skillsRoot, { recursive: true })

  writeFileSync(join(memoryRoot, 'MEMORY.md'), snapshot.memoryMd || MEMORY_HEADER, 'utf8')
  for (const [dateKey, content] of Object.entries(snapshot.journal)) {
    if (!ISO_DATE_KEY_PATTERN.test(dateKey)) {
      continue
    }
    writeFileSync(join(journalRoot, `${dateKey}.md`), content, 'utf8')
  }

  writeMappedFiles(reposRoot, snapshot.repos)
  writeMappedFiles(skillsRoot, snapshot.skills)
}

function collectLocalMemorySnapshot(cwd: string): {
  memoryMd: string
  repos: Record<string, string>
  skills: Record<string, string>
} {
  const memoryRoot = join(cwd, '.memory')
  const memoryPath = join(memoryRoot, 'MEMORY.md')
  const reposRoot = join(memoryRoot, 'repos')
  const skillsRoot = join(cwd, 'skills')

  let memoryMd = MEMORY_HEADER
  if (existsSync(memoryPath)) {
    memoryMd = readFileSync(memoryPath, 'utf8')
  }

  return {
    memoryMd,
    repos: collectSnapshotFiles(reposRoot),
    skills: collectSnapshotFiles(skillsRoot),
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

export async function fetchRemoteMemoryExport(
  fetchImpl: typeof fetch,
  remoteUrl: string,
  commanderId: string,
  token: string,
): Promise<RemoteMemoryExportPayload> {
  const response = await fetchImpl(
    buildApiUrl(
      remoteUrl,
      `/api/commanders/${encodeURIComponent(commanderId)}/memory/export`,
    ),
    {
      method: 'GET',
      headers: buildRemoteAuthHeaders(token, false),
    },
  )

  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(
      detail
        ? `Memory export failed (${response.status}): ${detail}`
        : `Memory export failed (${response.status})`,
    )
  }

  const payload = parseRemoteMemoryExportPayload((await response.json()) as unknown)
  if (!payload) {
    throw new Error('Memory export payload is invalid')
  }

  return payload
}

async function claimNextRemoteQuest(
  fetchImpl: typeof fetch,
  remoteUrl: string,
  commanderId: string,
  token: string,
): Promise<RemoteQuest | null> {
  const response = await fetchImpl(
    buildApiUrl(remoteUrl, `/api/commanders/${encodeURIComponent(commanderId)}/quests/next`),
    {
      method: 'GET',
      headers: buildRemoteAuthHeaders(token, false),
    },
  )

  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(
      detail
        ? `Quest claim failed (${response.status}): ${detail}`
        : `Quest claim failed (${response.status})`,
    )
  }

  const payload = (await response.json()) as unknown
  if (!isObject(payload)) {
    throw new Error('Quest claim payload is invalid')
  }
  if (payload.quest === null) {
    return null
  }

  const quest = parseRemoteQuest(payload.quest)
  if (!quest) {
    throw new Error('Quest claim payload is missing quest details')
  }

  return quest
}

export async function postRemoteJournal(
  fetchImpl: typeof fetch,
  remoteUrl: string,
  commanderId: string,
  token: string,
  entry: RemoteJournalEntry,
): Promise<void> {
  const date = entry.timestamp.slice(0, 10)
  const response = await fetchImpl(
    buildApiUrl(
      remoteUrl,
      `/api/commanders/${encodeURIComponent(commanderId)}/memory/journal`,
    ),
    {
      method: 'POST',
      headers: buildRemoteAuthHeaders(token, true),
      body: JSON.stringify({
        date,
        entries: [entry],
      }),
    },
  )

  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(
      detail
        ? `Journal sync failed (${response.status}): ${detail}`
        : `Journal sync failed (${response.status})`,
    )
  }
}

async function putRemoteMemorySync(
  fetchImpl: typeof fetch,
  remoteUrl: string,
  commanderId: string,
  token: string,
  snapshot: {
    memoryMd: string
    repos: Record<string, string>
    skills: Record<string, string>
  },
): Promise<void> {
  const response = await fetchImpl(
    buildApiUrl(
      remoteUrl,
      `/api/commanders/${encodeURIComponent(commanderId)}/memory/sync`,
    ),
    {
      method: 'PUT',
      headers: buildRemoteAuthHeaders(token, true),
      body: JSON.stringify(snapshot),
    },
  )

  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(
      detail
        ? `Memory sync failed (${response.status}): ${detail}`
        : `Memory sync failed (${response.status})`,
    )
  }
}

async function runRemoteInit(
  args: readonly string[],
  deps: CommanderCliDependencies,
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const cwd = deps.cwd ?? process.cwd()
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  }))

  let remoteUrl: string | null = null
  let token: string | null = null
  let commanderIdArg: string | null = null
  let pollIntervalMs = DEFAULT_REMOTE_POLL_INTERVAL_MS
  let once = false

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--once') {
      once = true
      continue
    }

    const value = args[index + 1]
    if (!value) {
      printUsage(stdout)
      return 1
    }

    if (flag === '--remote') {
      remoteUrl = parseNonEmpty(value)
    } else if (flag === '--token') {
      token = parseNonEmpty(value)
    } else if (flag === '--commander') {
      commanderIdArg = parseNonEmpty(value)
    } else if (flag === '--poll-interval') {
      const seconds = parsePositiveInteger(parseNonEmpty(value))
      if (!seconds) {
        stderr.write('--poll-interval must be a positive integer (seconds).\n')
        return 1
      }
      pollIntervalMs = seconds * 1000
    } else {
      printUsage(stdout)
      return 1
    }

    index += 1
  }

  if (!remoteUrl || !token) {
    stderr.write('--remote and --token are required for remote init.\n')
    return 1
  }

  const commanderId = parseNonEmpty(
    commanderIdArg ?? deps.commanderId ?? process.env.HAMMURABI_COMMANDER_ID,
  )
  if (!commanderId) {
    stderr.write('--commander or HAMMURABI_COMMANDER_ID is required for remote init.\n')
    return 1
  }

  try {
    const snapshot = await fetchRemoteMemoryExport(fetchImpl, remoteUrl, commanderId, token)
    scaffoldLocalSnapshot(cwd, snapshot)
    stdout.write(`Bootstrapped remote memory for commander ${commanderId}.\n`)
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const maxPolls = Number.isFinite(deps.maxPolls)
    ? Math.max(0, Math.floor(deps.maxPolls as number))
    : Number.POSITIVE_INFINITY
  let polls = 0

  while (polls < maxPolls) {
    let quest: RemoteQuest | null
    try {
      quest = await claimNextRemoteQuest(fetchImpl, remoteUrl, commanderId, token)
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }

    if (!quest) {
      if (once) {
        stdout.write('No pending quests.\n')
        return 0
      }
      await sleep(pollIntervalMs)
      polls += 1
      continue
    }

    const timestamp = new Date().toISOString()
    const journalEntry = {
      timestamp,
      issueNumber: null,
      repo: null,
      outcome: `Claimed quest ${quest.id}`,
      durationMin: null,
      salience: 'NOTABLE' as const,
      body: [
        '### Remote Quest',
        quest.instruction,
      ].join('\n\n'),
    }

    try {
      await postRemoteJournal(fetchImpl, remoteUrl, commanderId, token, journalEntry)
      const snapshot = collectLocalMemorySnapshot(cwd)
      await putRemoteMemorySync(fetchImpl, remoteUrl, commanderId, token, snapshot)
      stdout.write(`Claimed and synced quest ${quest.id}.\n`)
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }

    if (once) {
      return 0
    }
    polls += 1
    await sleep(pollIntervalMs)
  }

  return 0
}

export async function runCommanderCli(
  args: readonly string[],
  deps: CommanderCliDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const cwd = deps.cwd ?? process.cwd()
  const fileExists = deps.fileExists ?? existsSync
  const writeFile = deps.writeFile ?? ((path: string, content: string) => writeFileSync(path, content, 'utf8'))

  const subcommand = args[0]

  if (subcommand !== 'init') {
    printUsage(stdout)
    return 1
  }

  const hasRemoteFlag = args.includes('--remote') || args.includes('--token')
  if (hasRemoteFlag) {
    return runRemoteInit(args.slice(1), deps)
  }

  if (args.length !== 1) {
    printUsage(stdout)
    return 1
  }

  const targetPath = join(cwd, COMMANDER_FILENAME)

  if (fileExists(targetPath)) {
    stderr.write(`Error: ${COMMANDER_FILENAME} already exists in this directory. Refusing to overwrite.\n`)
    return 1
  }

  writeFile(targetPath, renderCommanderTemplate(cwd))
  stdout.write(`Created ${COMMANDER_FILENAME}\n`)

  return 0
}
