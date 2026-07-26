import { formatStoredApiKeyUnauthorizedMessage } from './api-key-recovery.js'
import { type HerdConfig, normalizeEndpoint, readHerdConfig } from './config.js'
import { fetchJson as fetchJsonStrict } from './http-json.js'

interface QuestSummary {
  id: string
  status: string
  title: string
  artifactCount: number
  claimedByConversationId: string | null
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
  config: HerdConfig
  commanderId: string
}

export interface QuestsCliDependencies {
  fetchImpl?: typeof fetch
  readConfig?: () => Promise<HerdConfig | null>
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
  artifacts?: QuestArtifact[]
}

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  herd quests list [--commander <id>] [--conversation <id>]\n')
  stdout.write(
    '  herd quests create [--commander <id>] (--instruction "<text>" | --issue <url>) [--cwd <path>] [--mode <mode>] [--agent <type>] [--skills <s1,s2>] [--source <source>] [--note "<text>"] [--artifact-type <type> --artifact-label <label> --artifact-href <href>]\n',
  )
  stdout.write('  herd quests delete <id> [--commander <id>]\n')
  stdout.write('  herd quests claim <id> [--commander <id>] [--conversation <id>]\n')
  stdout.write('  herd quests note <id> [--commander <id>] "<text>"\n')
  stdout.write('  herd quests done <id> [--commander <id>] --note "<text>"\n')
  stdout.write('  herd quests fail <id> [--commander <id>] --note "<text>"\n')
  stdout.write('  herd quests artifact add <id> [--commander <id>] --type <type> --label <label> --href <href>\n')
  stdout.write('  herd quests artifact remove <id> [--commander <id>] <href>\n')
  stdout.write('\nOptions:\n')
  stdout.write('  --commander <id>  Commander ID. Defaults to HERD_COMMANDER_ID.\n')
}

function resolveCommanderId(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

interface QuestGlobalOptions {
  args: string[]
  commanderId: string | null
}

function parseQuestGlobalOptions(args: readonly string[]): QuestGlobalOptions | null {
  const strippedArgs: string[] = []
  let commanderId: string | null = null

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--commander') {
      if (commanderId !== null) {
        return null
      }

      commanderId = resolveCommanderId(args[index + 1])
      if (!commanderId) {
        return null
      }

      index += 1
      continue
    }

    if (arg?.startsWith('--commander=')) {
      if (commanderId !== null) {
        return null
      }

      commanderId = resolveCommanderId(arg.slice('--commander='.length))
      if (!commanderId) {
        return null
      }

      continue
    }

    strippedArgs.push(arg)
  }

  return { args: strippedArgs, commanderId }
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

function parseConversationId(value: string | undefined): string | null {
  const conversationId = value?.trim() ?? ''
  return conversationId.length > 0 ? conversationId : null
}

function parseClaimOptions(
  args: readonly string[],
): {
  questId: string
  conversationId: string | null
} | null {
  const questId = parseQuestId(args[1])
  if (!questId) {
    return null
  }

  if (args.length === 2) {
    return { questId, conversationId: null }
  }

  if (args.length === 4 && args[2] === '--conversation') {
    const conversationId = parseConversationId(args[3])
    if (!conversationId) {
      return null
    }
    return { questId, conversationId }
  }

  return null
}

function parseListOptions(args: readonly string[]): { conversationId: string | null } | null {
  if (args.length === 1) {
    return { conversationId: null }
  }

  if (args.length === 3 && args[1] === '--conversation') {
    const conversationId = parseConversationId(args[2])
    if (!conversationId) {
      return null
    }
    return { conversationId }
  }

  return null
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

function isValidQuestArtifactHref(type: QuestArtifactType, href: string): boolean {
  if (type === 'file') {
    return href.trim().length > 0
  }

  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  if (type === 'url') {
    return true
  }

  if (!['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())) {
    return false
  }

  const [owner, repo, resource, number, ...remainder] = parsed.pathname
    .split('/')
    .filter(Boolean)
  if (!owner || !repo || remainder.length > 0 || !/^[1-9]\d*$/u.test(number ?? '')) {
    return false
  }

  return type === 'github_issue'
    ? resource === 'issues'
    : resource === 'pull'
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
  if (!isValidQuestArtifactHref(type, href)) {
    return null
  }

  return { type, label, href }
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

function extractClaimHolder(payload: unknown): string | null {
  if (!isObject(payload)) {
    return null
  }

  const claimedBy = payload.claimedBy
  if (typeof claimedBy === 'string' && claimedBy.trim().length > 0) {
    return claimedBy.trim()
  }

  const directHolder = payload.claimedByConversationId
  if (typeof directHolder === 'string' && directHolder.trim().length > 0) {
    return directHolder.trim()
  }

  const holder = payload.holder
  if (typeof holder === 'string' && holder.trim().length > 0) {
    return holder.trim()
  }

  const existingClaimHolder = payload.existingClaimHolder
  if (typeof existingClaimHolder === 'string' && existingClaimHolder.trim().length > 0) {
    return existingClaimHolder.trim()
  }

  const claimHolder = payload.claimHolder
  if (typeof claimHolder === 'string' && claimHolder.trim().length > 0) {
    return claimHolder.trim()
  }

  if (isObject(payload.quest)) {
    const nestedHolder = payload.quest.claimedByConversationId
    if (typeof nestedHolder === 'string' && nestedHolder.trim().length > 0) {
      return nestedHolder.trim()
    }
  }

  return null
}

function extractClaimedQuest(payload: unknown): Record<string, unknown> | null {
  if (!isObject(payload)) {
    return null
  }
  if (isObject(payload.quest)) {
    return payload.quest
  }
  if (typeof payload.id === 'string') {
    return payload
  }
  return null
}

function extractErrorDetail(payload: unknown): string | null {
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

  return null
}

async function writeClaimConflict(
  stderr: Writable,
  response: Response,
  questId: string,
): Promise<void> {
  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.toLowerCase().includes('application/json')

  if (isJson) {
    try {
      const payload = (await response.json()) as unknown
      const holder = extractClaimHolder(payload)
      const detail = extractErrorDetail(payload)

      if (holder) {
        stderr.write(`Quest ${questId} is already claimed by ${holder}.\n`)
        return
      }

      stderr.write(
        detail
          ? `Quest ${questId} could not be claimed: ${detail}\n`
          : `Quest ${questId} is already claimed.\n`,
      )
      return
    } catch {
      stderr.write(`Quest ${questId} is already claimed.\n`)
      return
    }
  }

  const detail = await readErrorDetail(response)
  stderr.write(
    detail
      ? `Quest ${questId} could not be claimed: ${detail}\n`
      : `Quest ${questId} is already claimed.\n`,
  )
}

async function writeRequestFailure(
  stderr: Writable,
  response: Response,
  context: CommandContext,
): Promise<void> {
  if (response.status === 401) {
    stderr.write(
      `${formatStoredApiKeyUnauthorizedMessage({ endpoint: context.config.endpoint })}\n`,
    )
    return
  }

  const detail = await readErrorDetail(response)
  stderr.write(
    detail
      ? `Request failed (${response.status}): ${detail}\n`
      : `Request failed (${response.status}).\n`,
  )
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

function safeQuestArtifactsForReplacement(artifacts: readonly QuestArtifact[]): QuestArtifact[] {
  return artifacts.filter((artifact) => isValidQuestArtifactHref(artifact.type, artifact.href))
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
    const claimedByConversationId =
      typeof entry.claimedByConversationId === 'string'
        ? parseConversationId(entry.claimedByConversationId)
        : null

    if (!id || !status) {
      continue
    }

    quests.push({
      id,
      status,
      title: title.length > 0 ? title : '(untitled)',
      artifactCount,
      claimedByConversationId,
    })
  }

  return quests
}

function ownershipLabel(quest: QuestSummary, callingConversationId: string | null): string {
  if (quest.claimedByConversationId === null) {
    return '[unclaimed]'
  }

  if (callingConversationId && quest.claimedByConversationId === callingConversationId) {
    return '[MINE]'
  }

  return `[claimed by ${quest.claimedByConversationId.slice(0, 8)}]`
}

function printQuestSection(
  stdout: Writable,
  title: string,
  quests: readonly QuestSummary[],
  callingConversationId: string | null,
): void {
  stdout.write(`${title}:\n`)
  for (const quest of quests) {
    const artifactSuffix =
      quest.artifactCount > 0 ? ` [${quest.artifactCount} artifacts]` : ''
    stdout.write(
      `- ${quest.id} ${ownershipLabel(quest, callingConversationId)} ${quest.title}${artifactSuffix}\n`,
    )
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
  explicitCommanderId: string | null,
): Promise<CommandContext | null> {
  const readConfig = dependencies.readConfig ?? readHerdConfig
  const config = await readConfig()
  if (!config) {
    stderr.write('Herd config not found. Run `herd onboard` first.\n')
    return null
  }

  const commanderId = resolveCommanderId(
    explicitCommanderId ?? dependencies.commanderId ?? process.env.HERD_COMMANDER_ID,
  )
  if (!commanderId) {
    stderr.write('HERD_COMMANDER_ID is required. Pass --commander <id> or set HERD_COMMANDER_ID.\n')
    return null
  }

  return { config, commanderId }
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  return fetchJsonStrict(fetchImpl, url, init)
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
  let artifactType: QuestArtifactType | null = null
  let artifactLabel: string | null = null
  let artifactHref: string | null = null

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
      flag !== '--note' &&
      flag !== '--artifact-type' &&
      flag !== '--artifact-label' &&
      flag !== '--artifact-href'
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
    } else if (flag === '--artifact-type') {
      artifactType = parseQuestArtifactType(value)
      if (!artifactType) {
        return null
      }
    } else if (flag === '--artifact-label') {
      artifactLabel = value
    } else if (flag === '--artifact-href') {
      artifactHref = value
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
  if (artifactType || artifactLabel || artifactHref) {
    if (!artifactType || !artifactLabel || !artifactHref) {
      return null
    }
    if (!isValidQuestArtifactHref(artifactType, artifactHref)) {
      return null
    }
    options.artifacts = [{ type: artifactType, label: artifactLabel, href: artifactHref }]
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
  if (options.artifacts) {
    payload.artifacts = options.artifacts
  }

  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify(payload),
  })

  if (!result.ok) {
    await writeRequestFailure(stderr, result.response, context)
    return 1
  }

  const data = isObject(result.data) ? result.data : null
  const id = typeof data?.id === 'string' && data.id.trim().length > 0 ? data.id : null
  if (!id) {
    stderr.write('Quest create response was malformed: expected a JSON object with a string id.\n')
    return 1
  }
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
    await writeRequestFailure(stderr, result.response, context)
    return 1
  }

  stdout.write(`Quest ${questId} deleted.\n`)
  return 0
}

async function runList(
  context: CommandContext,
  fetchImpl: typeof fetch,
  explicitConversationId: string | null,
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
    await writeRequestFailure(stderr, result.response, context)
    return 1
  }

  const quests = parseQuestListPayload(result.data)
  const callingConversationId = resolveCallingConversation(explicitConversationId)
  const pending = quests.filter((quest) => quest.status === 'pending')
  const active = quests.filter((quest) => quest.status === 'active')

  if (pending.length === 0 && active.length === 0) {
    stdout.write('No pending or active quests.\n')
    return 0
  }

  if (pending.length > 0) {
    printQuestSection(stdout, 'Pending quests', pending, callingConversationId)
  }

  if (active.length > 0) {
    if (pending.length > 0) {
      stdout.write('\n')
    }
    printQuestSection(stdout, 'Active quests', active, callingConversationId)
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
    await writeRequestFailure(stderr, result.response, context)
    return 1
  }

  if (status === 'active') {
    stdout.write(`Quest ${questId} marked active.\n`)
    return 0
  }

  stdout.write(`Quest ${questId} marked ${status}.\n`)
  return 0
}

function resolveCallingConversation(explicitConversationId: string | null): string | null {
  return (
    explicitConversationId
    ?? parseConversationId(process.env.HERD_CONVERSATION_ID)
    ?? parseConversationId(process.env.HERD_COMMANDER_RUNTIME_CONVERSATION_ID)
  )
}

function resolveClaimConversationId(explicitConversationId: string | null): string | null {
  return resolveCallingConversation(explicitConversationId)
}

async function runClaim(
  context: CommandContext,
  fetchImpl: typeof fetch,
  questId: string,
  explicitConversationId: string | null,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const conversationId = resolveClaimConversationId(explicitConversationId)
  if (!conversationId) {
    stderr.write(
      'Claiming a quest requires --conversation <id>, HERD_CONVERSATION_ID, or HERD_COMMANDER_RUNTIME_CONVERSATION_ID.\n',
    )
    return 1
  }

  const url = buildApiUrl(
    context.config.endpoint,
    `/api/commanders/${encodeURIComponent(context.commanderId)}/quests/${encodeURIComponent(
      questId,
    )}/claim`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(context.config, true),
    body: JSON.stringify({ conversationId }),
  })

  if (!result.ok) {
    if (result.response.status === 409) {
      await writeClaimConflict(stderr, result.response, questId)
      return 1
    }

    await writeRequestFailure(stderr, result.response, context)
    return 1
  }

  stdout.write(`Quest ${questId} claimed.\n`)
  const claimedQuest = extractClaimedQuest(result.data)
  if (claimedQuest) {
    stdout.write(`QUEST_CLAIM_HANDOFF ${JSON.stringify({
      questId,
      conversationId,
      artifacts: parseQuestArtifacts(claimedQuest.artifacts),
    })}\n`)
  }
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
    await writeRequestFailure(stderr, result.response, context)
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
    await writeRequestFailure(stderr, result.response, context)
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
  if (artifacts.some((artifact) => !isValidQuestArtifactHref(artifact.type, artifact.href))) {
    stderr.write('Cannot update quest artifacts: an artifact href is invalid for its type.\n')
    return false
  }
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
    await writeRequestFailure(stderr, result.response, context)
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

  const nextArtifacts = [...safeQuestArtifactsForReplacement(quest.artifacts), artifact]
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
  const remainingArtifacts = quest.artifacts.filter((artifact) => artifact.href !== normalizedHref)
  if (remainingArtifacts.length === quest.artifacts.length) {
    stderr.write(`No artifact found for href "${normalizedHref}".\n`)
    return 1
  }

  const nextArtifacts = safeQuestArtifactsForReplacement(remainingArtifacts)
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

  const globalOptions = parseQuestGlobalOptions(args)
  if (!globalOptions) {
    printUsage(stdout)
    return 1
  }

  const commandArgs = globalOptions.args
  const command = commandArgs[0]
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

  const context = await resolveCommandContext(dependencies, stderr, globalOptions.commanderId)
  if (!context) {
    return 1
  }

  if (command === 'list') {
    const listOptions = parseListOptions(commandArgs)
    if (!listOptions) {
      printUsage(stdout)
      return 1
    }
    return runList(context, fetchImpl, listOptions.conversationId, stdout, stderr)
  }

  if (command === 'create') {
    const createOptions = parseCreateOptions(commandArgs.slice(1))
    if (!createOptions) {
      printUsage(stdout)
      return 1
    }
    return runCreate(context, fetchImpl, createOptions, stdout, stderr)
  }

  if (command === 'delete') {
    const questId = parseQuestId(commandArgs[1])
    if (!questId || commandArgs.length !== 2) {
      printUsage(stdout)
      return 1
    }
    return runDelete(context, fetchImpl, questId, stdout, stderr)
  }

  if (command === 'claim') {
    const claimOptions = parseClaimOptions(commandArgs)
    if (!claimOptions) {
      printUsage(stdout)
      return 1
    }
    return runClaim(
      context,
      fetchImpl,
      claimOptions.questId,
      claimOptions.conversationId,
      stdout,
      stderr,
    )
  }

  if (command === 'note') {
    const questId = parseQuestId(commandArgs[1])
    const text = commandArgs[2]?.trim() ?? ''
    if (!questId || text.length === 0 || commandArgs.length !== 3) {
      printUsage(stdout)
      return 1
    }
    return runPostNote(context, fetchImpl, questId, text, stdout, stderr)
  }

  if (command === 'done' || command === 'fail') {
    const questId = parseQuestId(commandArgs[1])
    const note = parseNoteOption(commandArgs.slice(2))
    if (!questId || !note) {
      printUsage(stdout)
      return 1
    }
    const status = command === 'done' ? 'done' : 'failed'
    return runPatchStatus(context, fetchImpl, questId, status, note, stdout, stderr)
  }

  if (command === 'artifact') {
    const subCommand = commandArgs[1]
    const questId = parseQuestId(commandArgs[2])
    if (!questId) {
      printUsage(stdout)
      return 1
    }

    if (subCommand === 'add') {
      const parsed = parseArtifactAddOptions(commandArgs.slice(3))
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
      const href = commandArgs[3]?.trim() ?? ''
      if (href.length === 0 || commandArgs.length !== 4) {
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
