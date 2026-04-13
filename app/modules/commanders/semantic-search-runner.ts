import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { isObject, parseTrimmedString } from './route-parsers.js'

const execFileAsync = promisify(execFile)

const KNOWLEDGE_SEARCH_SCRIPT_PATH = '/home/ec2-user/App/agent-skills/pkos/knowledge-search/knowledge_search.py'
const KAIZEN_OS_ENV_PATH = '/home/ec2-user/App/apps/kaizen_os/app/.env'

export const DEFAULT_SEMANTIC_SEARCH_TOP_K = 10

export interface SemanticSearchResult {
  score: number
  text: string
  source_file: string
  section_header: string
  chunk_index: number
}

export type SemanticSearchRunner = (
  query: string,
  topK: number,
) => Promise<SemanticSearchResult[]>

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

    return parseTrimmedString(stripOptionalQuotes(value))
  }

  return null
}

async function resolveGeminiApiKey(envFilePath = KAIZEN_OS_ENV_PATH): Promise<string | null> {
  const explicit = parseTrimmedString(process.env.GEMINI_API_KEY)
  if (explicit) {
    return explicit
  }

  try {
    const envFile = await readFile(envFilePath, 'utf8')
    return parseEnvAssignment(envFile, 'GEMINI_API_KEY')
  } catch {
    return null
  }
}

function parseSemanticSearchResults(stdout: string): SemanticSearchResult[] {
  let parsed: unknown

  try {
    parsed = JSON.parse(stdout) as unknown
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

export async function runSemanticSearchScript(
  query: string,
  topK: number,
  envFilePath = KAIZEN_OS_ENV_PATH,
): Promise<SemanticSearchResult[]> {
  await access(KNOWLEDGE_SEARCH_SCRIPT_PATH)

  const apiKey = await resolveGeminiApiKey(envFilePath)
  if (!apiKey) {
    throw new Error(`GEMINI_API_KEY not found in environment or ${envFilePath}`)
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
