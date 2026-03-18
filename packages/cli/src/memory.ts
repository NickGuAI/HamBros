import { type HammurabiConfig, normalizeEndpoint, readHammurabiConfig } from './config.js'

interface Writable {
  write(chunk: string): boolean
}

export interface MemoryCliDependencies {
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
  stdout.write('  hammurabi memory compact --commander <id>\n')
  stdout.write('  hammurabi memory find --commander <id> "<query>" [--top <k>]\n')
  stdout.write('  hammurabi memory save --commander <id> "<fact>" [--fact "<another>"]\n')
}

function parseNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
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

interface CompactOptions {
  commanderId: string
}

interface FindOptions {
  commanderId: string
  query: string
  topK?: number
}

interface SaveOptions {
  commanderId: string
  facts: string[]
}

function parseCompactOptions(args: readonly string[]): CompactOptions | null {
  if (args.length !== 2 || args[0] !== '--commander') {
    return null
  }

  const commanderId = parseNonEmpty(args[1])
  if (!commanderId) {
    return null
  }

  return { commanderId }
}

function parseFindOptions(args: readonly string[]): FindOptions | null {
  let commanderId: string | undefined
  let query: string | undefined
  let topK: number | undefined

  let index = 0
  while (index < args.length) {
    const flag = args[index]
    if (flag === '--commander') {
      commanderId = parseNonEmpty(args[index + 1]) ?? undefined
      if (!commanderId) return null
      index += 2
      continue
    }

    if (flag === '--top') {
      const raw = parseNonEmpty(args[index + 1])
      if (!raw) return null
      const parsed = parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed < 1) return null
      topK = parsed
      index += 2
      continue
    }

    // positional argument = query
    if (!query && !flag?.startsWith('--')) {
      query = parseNonEmpty(flag) ?? undefined
      index += 1
      continue
    }

    return null
  }

  if (!commanderId || !query) {
    return null
  }

  return { commanderId, query, topK }
}

function parseSaveOptions(args: readonly string[]): SaveOptions | null {
  let commanderId: string | undefined
  const facts: string[] = []

  let index = 0
  while (index < args.length) {
    const flag = args[index]
    if (flag === '--commander') {
      commanderId = parseNonEmpty(args[index + 1]) ?? undefined
      if (!commanderId) return null
      index += 2
      continue
    }

    if (flag === '--fact') {
      const fact = parseNonEmpty(args[index + 1])
      if (!fact) return null
      facts.push(fact)
      index += 2
      continue
    }

    // positional argument = first fact
    if (!flag?.startsWith('--')) {
      const fact = parseNonEmpty(flag)
      if (fact) {
        facts.push(fact)
      }
      index += 1
      continue
    }

    return null
  }

  if (!commanderId || facts.length === 0) {
    return null
  }

  return { commanderId, facts }
}

async function runCompact(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: CompactOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    config.endpoint,
    `/api/commanders/${encodeURIComponent(options.commanderId)}/memory/compact`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(config, true),
    body: JSON.stringify({}),
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
  const factsExtracted = typeof data.factsExtracted === 'number' ? data.factsExtracted : 0
  const memoryMdLineCount = typeof data.memoryMdLineCount === 'number' ? data.memoryMdLineCount : 0
  const entriesCompressed = isObject(data.entriesCompressed) ? data.entriesCompressed : {}
  const spike = typeof entriesCompressed.spike === 'number' ? entriesCompressed.spike : 0
  const notable = typeof entriesCompressed.notable === 'number' ? entriesCompressed.notable : 0
  const routine = typeof entriesCompressed.routine === 'number' ? entriesCompressed.routine : 0
  const entriesDeleted = typeof data.entriesDeleted === 'number' ? data.entriesDeleted : 0
  const debrifsProcessed = typeof data.debrifsProcessed === 'number' ? data.debrifsProcessed : 0
  const idleDay = data.idleDay === true

  stdout.write('Consolidation complete.\n')
  stdout.write(`  facts extracted: ${factsExtracted}\n`)
  stdout.write(`  MEMORY.md lines: ${memoryMdLineCount}\n`)
  stdout.write(`  compressed: spike=${spike}, notable=${notable}, routine=${routine}\n`)
  stdout.write(`  deleted entries: ${entriesDeleted}\n`)
  stdout.write(`  debriefs processed: ${debrifsProcessed}\n`)
  stdout.write(`  idle day: ${idleDay ? 'yes' : 'no'}\n`)
  return 0
}

interface RecollectionHit {
  type: string
  score: number
  title: string
  excerpt: string
  reason: string
}

async function runFind(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: FindOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    config.endpoint,
    `/api/commanders/${encodeURIComponent(options.commanderId)}/memory/recall`,
  )
  const body: Record<string, unknown> = { cue: options.query }
  if (options.topK !== undefined) {
    body.topK = options.topK
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

  const data = isObject(result.data) ? result.data : {}
  const hits = Array.isArray(data.hits) ? data.hits : []
  const queryTerms = Array.isArray(data.queryTerms)
    ? data.queryTerms.filter((t: unknown): t is string => typeof t === 'string')
    : []

  const termsStr = queryTerms.length > 0 ? queryTerms.join(', ') : '(none)'
  stdout.write(`Hits (${hits.length} found, query terms: ${termsStr}):\n`)

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i] as unknown
    if (!isObject(hit)) continue

    const h: RecollectionHit = {
      type: typeof hit.type === 'string' ? hit.type : 'unknown',
      score: typeof hit.score === 'number' ? hit.score : 0,
      title: typeof hit.title === 'string' ? hit.title : '(untitled)',
      excerpt: typeof hit.excerpt === 'string' ? hit.excerpt : '',
      reason: typeof hit.reason === 'string' ? hit.reason : '',
    }

    const paddedType = `[${h.type}]`.padEnd(10)
    stdout.write(`${i + 1}. ${paddedType} ${h.score.toFixed(3)} — ${h.title}\n`)
    if (h.excerpt) {
      stdout.write(`   excerpt: "${h.excerpt}"\n`)
    }
    if (h.reason) {
      stdout.write(`   reason: ${h.reason}\n`)
    }
  }

  return 0
}

async function runSave(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: SaveOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const url = buildApiUrl(
    config.endpoint,
    `/api/commanders/${encodeURIComponent(options.commanderId)}/memory/facts`,
  )
  const result = await fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: buildAuthHeaders(config, true),
    body: JSON.stringify({ facts: options.facts }),
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
  const factsAdded = typeof data.factsAdded === 'number' ? data.factsAdded : 0
  const lineCount = typeof data.lineCount === 'number' ? data.lineCount : 0
  const evicted = Array.isArray(data.evicted) ? data.evicted.length : 0

  stdout.write(`Saved ${factsAdded} facts to MEMORY.md (${lineCount} total lines, ${evicted} evicted).\n`)
  return 0
}

export async function runMemoryCli(
  args: readonly string[],
  dependencies: MemoryCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const readConfig = dependencies.readConfig ?? readHammurabiConfig

  const command = args[0]
  if (!command || (command !== 'compact' && command !== 'find' && command !== 'save')) {
    printUsage(stdout)
    return 1
  }

  const config = await readConfig()
  if (!config) {
    stderr.write('Hammurabi config not found. Run `hammurabi onboard` first.\n')
    return 1
  }

  if (command === 'compact') {
    const compactOptions = parseCompactOptions(args.slice(1))
    if (!compactOptions) {
      printUsage(stdout)
      return 1
    }
    return runCompact(config, fetchImpl, compactOptions, stdout, stderr)
  }

  if (command === 'find') {
    const findOptions = parseFindOptions(args.slice(1))
    if (!findOptions) {
      printUsage(stdout)
      return 1
    }
    return runFind(config, fetchImpl, findOptions, stdout, stderr)
  }

  const saveOptions = parseSaveOptions(args.slice(1))
  if (!saveOptions) {
    printUsage(stdout)
    return 1
  }
  return runSave(config, fetchImpl, saveOptions, stdout, stderr)
}
