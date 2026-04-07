import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { type HammurabiConfig, normalizeEndpoint, readHammurabiConfig } from './config.js'
import {
  fetchRemoteMemoryExport,
  postRemoteJournal,
  type RemoteJournalEntry,
} from './commander.js'

interface Writable {
  write(chunk: string): boolean
}

const execFileAsync = promisify(execFile)
const KNOWLEDGE_SEARCH_SCRIPT_PATH = '/home/ec2-user/App/agent-skills/pkos/knowledge-search/knowledge_search.py'
const KAIZEN_OS_ENV_PATH = '/home/ec2-user/App/apps/kaizen_os/app/.env'
const DEFAULT_SEMANTIC_TOP_K = 10

interface SemanticSearchResult {
  score: number
  text: string
  source_file: string
  section_header: string
  chunk_index: number
}

type SemanticSearchRunner = (query: string, topK: number) => Promise<SemanticSearchResult[]>

export interface MemoryCliDependencies {
  fetchImpl?: typeof fetch
  readConfig?: () => Promise<HammurabiConfig | null>
  runSemanticSearch?: SemanticSearchRunner
  stdout?: Writable
  stderr?: Writable
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function printUsage(stdout: Writable): void {
  stdout.write('Usage:\n')
  stdout.write('  hambros memory compact --commander <id>\n')
  stdout.write('  hambros memory find --commander <id> "<query>" [--top <k>] [--semantic]\n')
  stdout.write('  hambros memory save --commander <id> "<fact>" [--fact "<another>"]\n')
  stdout.write('  hambros memory export --commander <id>\n')
  stdout.write(
    '  hambros memory journal --commander <id> --body "<text>" [--timestamp <iso>] [--outcome "<text>"] [--salience SPIKE|NOTABLE|ROUTINE] [--issue-number <n>] [--repo <name>] [--duration-min <n>]\n',
  )
}

function parseNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

function stripOptionalQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function parseEnvAssignment(fileContents: string, key: string): string | null {
  for (const rawLine of fileContents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match || match[1] !== key) {
      continue
    }

    let value = match[2]?.trim() ?? ''
    if (!value) {
      return null
    }

    const isQuoted = (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    )
    if (!isQuoted) {
      value = value.split(/\s+#/, 1)[0]?.trim() ?? ''
    }

    return parseNonEmpty(stripOptionalQuotes(value))
  }

  return null
}

async function resolveGeminiApiKey(): Promise<string | null> {
  const explicit = parseNonEmpty(process.env.GEMINI_API_KEY)
  if (explicit) {
    return explicit
  }

  try {
    const envFile = await readFile(KAIZEN_OS_ENV_PATH, 'utf8')
    return parseEnvAssignment(envFile, 'GEMINI_API_KEY')
  } catch {
    return null
  }
}

function parseSemanticSearchResults(stdout: string): SemanticSearchResult[] {
  let parsed: unknown

  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error(
      `knowledge_search.py returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error('knowledge_search.py returned an unexpected payload')
  }

  return parsed.flatMap((entry) => {
    if (!isObject(entry)) {
      return []
    }

    const score = typeof entry.score === 'number' ? entry.score : null
    const text = typeof entry.text === 'string' ? entry.text : null
    const sourceFile = typeof entry.source_file === 'string' ? entry.source_file : null
    const sectionHeader = typeof entry.section_header === 'string' ? entry.section_header : null
    const chunkIndex = typeof entry.chunk_index === 'number' ? entry.chunk_index : 0

    if (score === null || text === null || sourceFile === null || sectionHeader === null) {
      return []
    }

    return [{
      score,
      text,
      source_file: sourceFile,
      section_header: sectionHeader,
      chunk_index: chunkIndex,
    }]
  })
}

async function runKnowledgeSearchScript(query: string, topK: number): Promise<SemanticSearchResult[]> {
  await access(KNOWLEDGE_SEARCH_SCRIPT_PATH)

  const apiKey = await resolveGeminiApiKey()
  if (!apiKey) {
    throw new Error(`GEMINI_API_KEY not found in environment or ${KAIZEN_OS_ENV_PATH}`)
  }

  const result = await execFileAsync(
    'python3',
    [
      KNOWLEDGE_SEARCH_SCRIPT_PATH,
      query,
      '--top-k',
      String(topK),
      '--json',
    ],
    {
      env: {
        ...process.env,
        GEMINI_API_KEY: apiKey,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  )

  return parseSemanticSearchResults(result.stdout)
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
  semantic?: boolean
}

interface SaveOptions {
  commanderId: string
  facts: string[]
}

interface ExportOptions {
  commanderId: string
}

interface JournalOptions {
  commanderId: string
  entry: RemoteJournalEntry
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
  let semantic = false

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

    if (flag === '--semantic') {
      semantic = true
      index += 1
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

  return { commanderId, query, topK, semantic }
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

function parseExportOptions(args: readonly string[]): ExportOptions | null {
  if (args.length !== 2 || args[0] !== '--commander') {
    return null
  }

  const commanderId = parseNonEmpty(args[1])
  if (!commanderId) {
    return null
  }

  return { commanderId }
}

function parsePositiveInteger(value: string | undefined): number | null {
  const raw = parseNonEmpty(value)
  if (!raw || !/^\d+$/.test(raw)) {
    return null
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null
  }
  return parsed
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  const raw = parseNonEmpty(value)
  if (!raw || !/^\d+$/.test(raw)) {
    return null
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }
  return parsed
}

function parseIsoTimestamp(value: string | undefined): string | null {
  const raw = parseNonEmpty(value)
  if (!raw) {
    return null
  }
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toISOString()
}

function parseSalience(value: string | undefined): RemoteJournalEntry['salience'] | null {
  const normalized = parseNonEmpty(value)?.toUpperCase()
  if (normalized === 'SPIKE' || normalized === 'NOTABLE' || normalized === 'ROUTINE') {
    return normalized
  }
  return null
}

function parseJournalOptions(args: readonly string[]): JournalOptions | null {
  let commanderId: string | undefined
  let timestamp: string | undefined
  let issueNumber: number | null = null
  let repo: string | null = null
  let outcome = 'Manual journal append'
  let durationMin: number | null = null
  let salience: RemoteJournalEntry['salience'] = 'NOTABLE'
  let body: string | undefined

  for (let index = 0; index < args.length; ) {
    const flag = args[index]
    const value = args[index + 1]

    if (!value) {
      return null
    }

    if (flag === '--commander') {
      commanderId = parseNonEmpty(value) ?? undefined
      if (!commanderId) {
        return null
      }
      index += 2
      continue
    }

    if (flag === '--body') {
      body = parseNonEmpty(value) ?? undefined
      if (!body) {
        return null
      }
      index += 2
      continue
    }

    if (flag === '--timestamp') {
      timestamp = parseIsoTimestamp(value) ?? undefined
      if (!timestamp) {
        return null
      }
      index += 2
      continue
    }

    if (flag === '--outcome') {
      outcome = parseNonEmpty(value) ?? ''
      if (!outcome) {
        return null
      }
      index += 2
      continue
    }

    if (flag === '--salience') {
      const parsed = parseSalience(value)
      if (!parsed) {
        return null
      }
      salience = parsed
      index += 2
      continue
    }

    if (flag === '--issue-number') {
      const parsed = parsePositiveInteger(value)
      if (parsed === null) {
        return null
      }
      issueNumber = parsed
      index += 2
      continue
    }

    if (flag === '--repo') {
      repo = parseNonEmpty(value)
      if (!repo) {
        return null
      }
      index += 2
      continue
    }

    if (flag === '--duration-min') {
      const parsed = parseNonNegativeInteger(value)
      if (parsed === null) {
        return null
      }
      durationMin = parsed
      index += 2
      continue
    }

    return null
  }

  if (!commanderId || !body) {
    return null
  }

  return {
    commanderId,
    entry: {
      timestamp: timestamp ?? new Date().toISOString(),
      issueNumber,
      repo,
      outcome,
      durationMin,
      salience,
      body,
    },
  }
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

function writeLexicalHits(
  stdout: Writable,
  hits: unknown[],
  queryTerms: string[],
): void {
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
}

function shortenHomePath(filePath: string): string {
  const homePath = homedir()
  return filePath.startsWith(homePath)
    ? `~${filePath.slice(homePath.length)}`
    : filePath
}

function formatSemanticExcerpt(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) {
    return compact
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`
}

function writeSemanticHits(
  stdout: Writable,
  results: SemanticSearchResult[],
): void {
  stdout.write('=== Knowledge Index (semantic search) ===\n')

  if (results.length === 0) {
    stdout.write('No semantic results found.\n')
    return
  }

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    stdout.write(`${index + 1}. [${(result.score * 100).toFixed(1)}%] ${result.section_header}\n`)
    stdout.write(`   Source: ${shortenHomePath(result.source_file)}\n`)
    stdout.write(`   ${formatSemanticExcerpt(result.text)}\n`)
  }
}

async function runFind(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: FindOptions,
  runSemanticSearch: SemanticSearchRunner,
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

  if (options.semantic) {
    stdout.write('=== Commander Memory (cue-based recall) ===\n')
  }

  writeLexicalHits(stdout, hits, queryTerms)

  if (!options.semantic) {
    return 0
  }

  try {
    const semanticResults = await runSemanticSearch(options.query, options.topK ?? DEFAULT_SEMANTIC_TOP_K)
    stdout.write('\n')
    writeSemanticHits(stdout, semanticResults)
  } catch (error) {
    stderr.write(
      `Warning: semantic search skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    )
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

async function runExport(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: ExportOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  try {
    const payload = await fetchRemoteMemoryExport(
      fetchImpl,
      config.endpoint,
      options.commanderId,
      config.apiKey,
    )
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function runJournal(
  config: HammurabiConfig,
  fetchImpl: typeof fetch,
  options: JournalOptions,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  try {
    await postRemoteJournal(
      fetchImpl,
      config.endpoint,
      options.commanderId,
      config.apiKey,
      options.entry,
    )
    stdout.write(`Journal entry appended for ${options.entry.timestamp.slice(0, 10)}.\n`)
    return 0
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function runMemoryCli(
  args: readonly string[],
  dependencies: MemoryCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const readConfig = dependencies.readConfig ?? readHammurabiConfig
  const runSemanticSearch = dependencies.runSemanticSearch ?? runKnowledgeSearchScript

  const command = args[0]
  if (
    !command ||
    (command !== 'compact' &&
      command !== 'find' &&
      command !== 'save' &&
      command !== 'export' &&
      command !== 'journal')
  ) {
    printUsage(stdout)
    return 1
  }

  const config = await readConfig()
  if (!config) {
    stderr.write('HamBros config not found. Run `hambros init` first.\n')
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
    return runFind(config, fetchImpl, findOptions, runSemanticSearch, stdout, stderr)
  }

  if (command === 'export') {
    const exportOptions = parseExportOptions(args.slice(1))
    if (!exportOptions) {
      printUsage(stdout)
      return 1
    }
    return runExport(config, fetchImpl, exportOptions, stdout, stderr)
  }

  if (command === 'journal') {
    const journalOptions = parseJournalOptions(args.slice(1))
    if (!journalOptions) {
      printUsage(stdout)
      return 1
    }
    return runJournal(config, fetchImpl, journalOptions, stdout, stderr)
  }

  const saveOptions = parseSaveOptions(args.slice(1))
  if (!saveOptions) {
    printUsage(stdout)
    return 1
  }
  return runSave(config, fetchImpl, saveOptions, stdout, stderr)
}
