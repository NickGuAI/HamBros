import { type HammurabiConfig, normalizeEndpoint, readHammurabiConfig } from './config.js'

interface QuestSummary {
  id: string
  status: string
  title: string
  artifactCount: number
}

type QuestArtifactType = 'github_issue' | 'github_pr' | 'url' | 'file'

interface QuestArtifact {
  type: QuestArtifactType
  label: string
  href: string
}

interface QuestDetails {
  id: string
  artifacts: QuestArtifact[]
}

interface Writable {
  write(chunk: string): boolean
}

interface CommandContext {
  config: HammurabiConfig
  commanderId: string
}

export interface QuestsCliDependencies {
  fetchImpl?: typeof fetch
  readConfig?: () => Promise<HammurabiConfig | null>
  commanderId?: string | null
  stdout?: Writable
  stderr?: Writable
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface CreateOptions {
  instruction?: string
  contract?: {
    cwd?: string
    permissionMode?: string
    agentType?: string
    skillsToUse?: string[]
  }
  source?: string
  githubIssueUrl?: string
  note?: string
}

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  hambros quests list\n')
  stdout.write(
    '  hambros quests create (--instruction "<text>" | --issue <url>) [--cwd <path>] [--mode <mode>] [--agent <type>] [--skills <s1,s2>] [--source <source>] [--note "<text>"]\n',
  )
  stdout.write('  hambros quests delete <id>\n')
  stdout.write('  hambros quests claim <id>\n')
  stdout.write('  hambros quests note <id> "<text>"\n')
  stdout.write('  hambros quests done <id> --note "<text>"\n')
  stdout.write('  hambros quests fail <id> --note "<text>"\n')
  stdout.write('  hambros quests artifact add <id> --type <type> --label <label> --href <href>\n')
  stdout.write('  hambros quests artifact remove <id> <href>\n')
}

function resolveCommanderId(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseQuestId(value: string | undefined): string | null {
  const id = value?.trim() ?? ''
  return id.length > 0 ? id : null
}

function parseNoteOption(args: readonly string[]): string | null {
  if (args.length !== 2 || args[0] !== '--note') {
    return null
  }

  const note = args[1]?.trim() ?? ''
  return note.length > 0 ? note : null
}

function parseQuestArtifactType(value: unknown): QuestArtifactType | null {
  if (
    value === 'github_issue' ||
    value === 'github_pr' ||
    value === 'url' ||
    value === 'file'
  ) {
    return value
  }
  return null
}

function parseArtifactAddOptions(
  args: readonly string[],
): { type: QuestArtifactType; label: string; href: string } | null {
  if (args.length !== 6) {
    return null
  }

  let type: QuestArtifactType | null = null
  let label: string | null = null
  let href: string | null = null
  const seen = new Set<string>()

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]?.trim() ?? ''
    if (!flag || seen.has(flag) || value.length === 0) {
      return null
    }
    seen.add(flag)

    if (flag === '--type') {
      type = parseQuestArtifactType(value)
      if (!type) {
        return null
      }
      continue
    }

    if (flag === '--label') {
      label = value
      continue
    }

    if (flag === '--href') {
      href = value
      continue
    }

    return null
  }

  if (!type || !label || !href) {
    return null
  }

  return { type, label, href }
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

function parseQuestArtifacts(payload: unknown): QuestArtifact[] {
  if (!Array.isArray(payload)) {
    return []
  }

  const artifacts: QuestArtifact[] = []
  for (const entry of payload) {
    if (!isObject(entry)) {
      continue
    }

    const type = parseQuestArtifactType(entry.type)
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    const href = typeof entry.href === 'string' ? entry.href.trim() : ''
    if (!type || !label || !href) {
      continue
    }

    artifacts.push({ type, label, href })
  }

  return artifacts
}

function parseQuestListPayload(payload: unknown): QuestSummary[] {
  const rawQuests = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.quests)
      ? payload.quests
      : []

  const quests: QuestSummary[] = []
  for (const entry of rawQuests) {
    if (!isObject(entry)) {
      continue
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const status = typeof entry.status === 'string' ? entry.status.trim().toLowerCase() : ''
    const titleRaw =
      typeof entry.title === 'string'
        ? entry.title
        : typeof entry.name === 'string'
          ? entry.name
          : typeof entry.instruction === 'string'
            ? entry.instruction
          : ''
    const title = titleRaw.trim()
    const artifactCount = parseQuestArtifacts(entry.artifacts).length

    if (!id || !status) {
      continue
    }

    quests.push({
      id,
      status,
      title: title.length > 0 ? title : '(untitled)',
      artifactCount,
    })
  }

  return quests
}

function printQuestSection(stdout: Writable, title: string, quests: readonly QuestSummary[]): void {
  stdout.write(`${title}:\n`)
  for (const quest of quests) {
    const artifactSuffix =
      quest.artifactCount > 0 ? ` [${quest.artifactCount} artifacts]` : ''
    stdout.write(`- ${quest.id}: ${quest.title}${artifactSuffix}\n`)
  }
}

function parseQuestDetailsListPayload(payload: unknown): QuestDetails[] {
  const rawQuests = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.quests)
      ? payload.quests
      : []

  const quests: QuestDetails[] = []
  for (const entry of rawQuests) {
    if (!isObject(entry)) {
      continue
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) {
      continue
    }

    quests.push({
      id,
      artifacts: parseQuestArtifacts(entry.artifacts),
    })
  }

  return quests
}

async function resolveCommandContext(
  dependencies: QuestsCliDependencies,
  stderr: Writable,
): Promise<CommandContext | null> {
  const readConfig = dependencies.readConfig ?? readHammurabiConfig
  const config = await readConfig()
  if (!config) {
    stderr.write('HamBros config not found. Run `hambros init` first.\n')
    return null
  }

  const commanderId = resolveCommanderId(
    dependencies.commanderId ?? process.env.HAMMURABI_COMMANDER_ID,
  )
  if (!commanderId) {
    stderr.write('HAMMURABI_COMMANDER_ID is required.\n')
    return null
  }

  return { config, commanderId }
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

function parseCreateOptions(args: readonly string[]): CreateOptions | null {
  let instruction: string | undefined
  let cwd: string | undefined
  let permissionMode: string | undefined
  let agentType: string | undefined
  let skillsToUse: string[] = []
  let hasSkillsOption = false
  let hasContractOverride = false
  let source: string | undefined
  let githubIssueUrl: string | undefined
  let note: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]?.trim()

    if (
      flag !== '--instruction' &&
      flag !== '--cwd' &&
      flag !== '--mode' &&
      flag !== '--agent' &&
      flag !== '--skills' &&
      flag !== '--source' &&
      flag !== '--issue' &&
      flag !== '--note'
    ) {
      return null
    }
    if (!value) {
      return null
    }

    if (flag === '--instruction') {
      instruction = value
    } else if (flag === '--cwd') {
      cwd = value
      hasContractOverride = true
    } else if (flag === '--mode') {
      permissionMode = value
      hasContractOverride = true
    } else if (flag === '--agent') {
      agentType = value
      hasContractOverride = true
    } else if (flag === '--skills') {
      hasSkillsOption = true
      hasContractOverride = true
      skillsToUse = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    } else if (flag === '--source') {
      source = value
    } else if (flag === '--issue') {
      githubIssueUrl = value
    } else if (flag === '--note') {
      note = value
    }

    index += 1
  }

  if (!instruction && !githubIssueUrl) {
    return null
  }

  const options: CreateOptions = {}
  if (instruction) {
    options.instruction = instruction
  }
  if (source) {
    options.source = source
  }
  if (githubIssueUrl) {
    options.githubIssueUrl = githubIssueUrl
  }
  if (note) {
    options.note = note
  }

  if (hasContractOverride) {
    const contract: {
      cwd?: string
      permissionMode?: string
      agentType?: string
      skillsToUse?: string[]
    } = {}
    if (cwd) {
      contract.cwd = cwd
    }
    if (permissionMode) {
      contract.permissionMode = permissionMode
    }
    if (agentType) {
      contract.agentType = agentType
    }
    if (hasSkillsOption) {
      contract.skillsToUse = skillsToUse
    }
    options.contract = contract
  }

  return options
}

async function runCreate(
  context: CommandContext,
  fetchImpl: typeof fetch,
  options: CreateOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    context.config.endpoint,
    `/api/commanders/${encodeURIComponent(context.commanderId)}/quests`,
  )
  const payload: Record<string, unknown> = {}
  if (options.instruction) {
    payload.instruction = options.instruction
  }
  if (options.contract) {
    payload.contract = options.contract
  }
  if (options.source) {
    payload.source = options.source
  }
  if (options.githubIssueUrl) {
    payload.githubIssueUrl = options.githubIssueUrl
  }
  if (options.note) {
    payload.note = options.note
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
  const id = typeof data.id === 'string' ? data.id : '(unknown)'
  stdout.write(`Quest created: ${id}\n`)
  return 0
}

async function runDelete(
  context: CommandContext,
  fetchImpl: typeof fetch,
  questId: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    context.config.endpoint,
    `/api/commanders/${encodeURIComponent(context.commanderId)}/quests/${encodeURIComponent(questId)}`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'DELETE',
    headers: buildAuthHeaders(context.config, false),
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

  stdout.write(`Quest ${questId} deleted.\n`)
  return 0
}

async function runList(
  context: CommandContext,
  fetchImpl: typeof fetch,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    context.config.endpoint,
    `/api/commanders/${encodeURIComponent(context.commanderId)}/quests`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'GET',
    headers: buildAuthHeaders(context.config, false),
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

  const quests = parseQuestListPayload(result.data)
  const pending = quests.filter((quest) => quest.status === 'pending')
  const active = quests.filter((quest) => quest.status === 'active')

  if (pending.length === 0 && active.length === 0) {
    stdout.write('No pending or active quests.\n')
    return 0
  }

  if (pending.length > 0) {
    printQuestSection(stdout, 'Pending quests', pending)
  }

  if (active.length > 0) {
    if (pending.length > 0) {
      stdout.write('\n')
    }
    printQuestSection(stdout, 'Active quests', active)
  }

  return 0
}

async function runPatchStatus(
  context: CommandContext,
  fetchImpl: typeof fetch,
  questId: string,
  status: 'active' | 'done' | 'failed',
  note: string | null,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    context.config.endpoint,
    `/api/commanders/${encodeURIComponent(context.commanderId)}/quests/${encodeURIComponent(
      questId,
    )}`,
  )
  const payload = note === null ? { status } : { status, note }
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

  if (status === 'active') {
    stdout.write(`Quest ${questId} marked active.\n`)
    return 0
  }

  stdout.write(`Quest ${questId} marked ${status}.\n`)
  return 0
}

async function runPostNote(
  context: CommandContext,
  fetchImpl: typeof fetch,
  questId: string,
  text: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    context.config.endpoint,
    `/api/commanders/${encodeURIComponent(context.commanderId)}/quests/${encodeURIComponent(
      questId,
    )}/notes`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify({ note: text }),
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

  stdout.write(`Note added to quest ${questId}.\n`)
  return 0
}

async function fetchQuestDetails(
  context: CommandContext,
  fetchImpl: typeof fetch,
  questId: string,
  stderr: Writable,
): Promise<QuestDetails | null> {
  const url = buildApiUrl(
    context.config.endpoint,
    `/api/commanders/${encodeURIComponent(context.commanderId)}/quests`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'GET',
    headers: buildAuthHeaders(context.config, false),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Request failed (${result.response.status}): ${detail}\n`
        : `Request failed (${result.response.status}).\n`,
    )
    return null
  }

  const quests = parseQuestDetailsListPayload(result.data)
  const quest = quests.find((entry) => entry.id === questId)
  if (!quest) {
    stderr.write(`Quest "${questId}" not found.\n`)
    return null
  }

  return quest
}

async function patchQuestArtifacts(
  context: CommandContext,
  fetchImpl: typeof fetch,
  questId: string,
  artifacts: QuestArtifact[],
  stderr: Writable,
): Promise<boolean> {
  const url = buildApiUrl(
    context.config.endpoint,
    `/api/commanders/${encodeURIComponent(context.commanderId)}/quests/${encodeURIComponent(
      questId,
    )}`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'PATCH',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify({ artifacts }),
  })

  if (!result.ok) {
    const detail = await readErrorDetail(result.response)
    stderr.write(
      detail
        ? `Request failed (${result.response.status}): ${detail}\n`
        : `Request failed (${result.response.status}).\n`,
    )
    return false
  }

  return true
}

async function runArtifactAdd(
  context: CommandContext,
  fetchImpl: typeof fetch,
  questId: string,
  artifact: QuestArtifact,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const quest = await fetchQuestDetails(context, fetchImpl, questId, stderr)
  if (!quest) {
    return 1
  }

  const nextArtifacts = [...quest.artifacts, artifact]
  const patched = await patchQuestArtifacts(context, fetchImpl, questId, nextArtifacts, stderr)
  if (!patched) {
    return 1
  }

  stdout.write(`Artifact added to quest ${questId}.\n`)
  return 0
}

async function runArtifactRemove(
  context: CommandContext,
  fetchImpl: typeof fetch,
  questId: string,
  href: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const quest = await fetchQuestDetails(context, fetchImpl, questId, stderr)
  if (!quest) {
    return 1
  }

  const normalizedHref = href.trim()
  const nextArtifacts = quest.artifacts.filter((artifact) => artifact.href !== normalizedHref)
  if (nextArtifacts.length === quest.artifacts.length) {
    stderr.write(`No artifact found for href "${normalizedHref}".\n`)
    return 1
  }

  const patched = await patchQuestArtifacts(context, fetchImpl, questId, nextArtifacts, stderr)
  if (!patched) {
    return 1
  }

  stdout.write(`Artifact removed from quest ${questId}.\n`)
  return 0
}

export async function runQuestsCli(
  args: readonly string[],
  dependencies: QuestsCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  const fetchImpl = dependencies.fetchImpl ?? fetch

  const command = args[0]
  if (!command) {
    printUsage(stdout)
    return 1
  }

  const isKnownCommand =
    command === 'list' ||
    command === 'create' ||
    command === 'delete' ||
    command === 'claim' ||
    command === 'note' ||
    command === 'done' ||
    command === 'fail' ||
    command === 'artifact'
  if (!isKnownCommand) {
    printUsage(stdout)
    return 1
  }

  const context = await resolveCommandContext(dependencies, stderr)
  if (!context) {
    return 1
  }

  if (command === 'list') {
    if (args.length !== 1) {
      printUsage(stdout)
      return 1
    }
    return runList(context, fetchImpl, stdout, stderr)
  }

  if (command === 'create') {
    const createOptions = parseCreateOptions(args.slice(1))
    if (!createOptions) {
      printUsage(stdout)
      return 1
    }
    return runCreate(context, fetchImpl, createOptions, stdout, stderr)
  }

  if (command === 'delete') {
    const questId = parseQuestId(args[1])
    if (!questId || args.length !== 2) {
      printUsage(stdout)
      return 1
    }
    return runDelete(context, fetchImpl, questId, stdout, stderr)
  }

  if (command === 'claim') {
    const questId = parseQuestId(args[1])
    if (!questId || args.length !== 2) {
      printUsage(stdout)
      return 1
    }
    return runPatchStatus(context, fetchImpl, questId, 'active', null, stdout, stderr)
  }

  if (command === 'note') {
    const questId = parseQuestId(args[1])
    const text = args[2]?.trim() ?? ''
    if (!questId || text.length === 0 || args.length !== 3) {
      printUsage(stdout)
      return 1
    }
    return runPostNote(context, fetchImpl, questId, text, stdout, stderr)
  }

  if (command === 'done' || command === 'fail') {
    const questId = parseQuestId(args[1])
    const note = parseNoteOption(args.slice(2))
    if (!questId || !note) {
      printUsage(stdout)
      return 1
    }
    const status = command === 'done' ? 'done' : 'failed'
    return runPatchStatus(context, fetchImpl, questId, status, note, stdout, stderr)
  }

  if (command === 'artifact') {
    const subCommand = args[1]
    const questId = parseQuestId(args[2])
    if (!questId) {
      printUsage(stdout)
      return 1
    }

    if (subCommand === 'add') {
      const parsed = parseArtifactAddOptions(args.slice(3))
      if (!parsed) {
        printUsage(stdout)
        return 1
      }
      return runArtifactAdd(
        context,
        fetchImpl,
        questId,
        { type: parsed.type, label: parsed.label, href: parsed.href },
        stdout,
        stderr,
      )
    }

    if (subCommand === 'remove') {
      const href = args[3]?.trim() ?? ''
      if (href.length === 0 || args.length !== 4) {
        printUsage(stdout)
        return 1
      }
      return runArtifactRemove(context, fetchImpl, questId, href, stdout, stderr)
    }

    printUsage(stdout)
    return 1
  }

  printUsage(stdout)
  return 1
}
