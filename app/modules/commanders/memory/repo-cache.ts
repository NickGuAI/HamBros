import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { type Dirent } from 'node:fs'
import * as path from 'node:path'
import { type JournalEntry } from './types.js'

export interface ParsedDebrief {
  doctrineUpdates?: string[] | string | null
  improveRootCauses?: string[] | string | null
}

type SectionName =
  | 'Structure'
  | 'Toolchain'
  | 'Conventions'
  | 'Key Files'
  | 'Pitfalls'
  | 'Open Questions'

interface CacheState {
  title: string
  lastUpdated: string
  tasksCompleted: number
  mayBeStale: boolean
  sections: Record<SectionName, string[]>
}

const SECTION_ORDER: SectionName[] = [
  'Structure',
  'Toolchain',
  'Conventions',
  'Key Files',
  'Pitfalls',
  'Open Questions',
]

const METADATA_PATTERN =
  /<!--\s*last-updated:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*tasks-completed:\s*(\d+)\s*-->/
const STALE_FLAG = '<!-- may be stale -->'
const GITHUB_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export class RepoCacheManager {
  private readonly memoryRoot: string

  constructor(
    private readonly commanderId: string,
    basePath?: string,
  ) {
    this.memoryRoot = basePath
      ? path.join(basePath, commanderId, '.memory')
      : path.resolve(process.cwd(), 'data', 'commanders', commanderId, '.memory')
  }

  async read(owner: string, repo: string): Promise<string> {
    const filePath = this.cachePath(owner, repo)
    try {
      return await readFile(filePath, 'utf-8')
    } catch {
      return ''
    }
  }

  async updateFromConsolidation(
    owner: string,
    repo: string,
    journalEntries: JournalEntry[],
    debriefs: ParsedDebrief[],
  ): Promise<void> {
    const cachePath = this.cachePath(owner, repo)
    const reposDir = path.dirname(cachePath)
    await mkdir(reposDir, { recursive: true })

    const existing = await this.read(owner, repo)
    const targetRepo = `${owner}/${repo}`.toLowerCase()
    const relevantEntries = journalEntries.filter(
      (entry) => entry.repo == null || entry.repo.toLowerCase() === targetRepo,
    )
    const hasWork = relevantEntries.length > 0 || debriefs.some(hasDebriefContent)

    if (!existing && !hasWork) {
      return
    }

    const state = existing
      ? parseCache(existing, owner, repo)
      : emptyCache(owner, repo)

    const extracted = extractFacts(relevantEntries, debriefs)
    const dedupCorpus = { value: existing || renderCache(state) }

    for (const fact of extracted.toolchain) {
      appendFact(state, 'Toolchain', fact, dedupCorpus)
    }
    for (const fact of extracted.conventions) {
      appendFact(state, 'Conventions', fact, dedupCorpus)
    }
    for (const fact of extracted.keyFiles) {
      appendFact(state, 'Key Files', fact, dedupCorpus)
    }
    for (const fact of extracted.pitfalls) {
      appendFact(state, 'Pitfalls', fact, dedupCorpus)
    }
    for (const fact of extracted.openQuestions) {
      appendFact(state, 'Open Questions', fact, dedupCorpus)
    }

    const now = new Date()
    const stale = isStale(state.lastUpdated, now)
    if (stale && !hasWork) {
      state.mayBeStale = true
    } else {
      state.mayBeStale = false
    }

    if (stale && hasWork) {
      for (const fact of extractRevalidatedToolchain(relevantEntries)) {
        appendFact(state, 'Toolchain', fact, dedupCorpus)
      }
    }

    if (hasWork) {
      state.lastUpdated = isoDate(now)
      state.tasksCompleted += 1
    }

    const nextContent = renderCache(state)
    if (nextContent !== existing) {
      await writeFile(cachePath, nextContent, 'utf-8')
    }
  }

  async listCachedRepos(): Promise<string[]> {
    const reposDir = path.join(this.memoryRoot, 'repos')
    let entries: Array<Dirent<string>>
    try {
      entries = await readdir(reposDir, { withFileTypes: true })
    } catch {
      return []
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => filenameToRepo(entry.name))
      .sort()
  }

  cachePath(owner: string, repo: string): string {
    validateRepoSegment(owner, 'owner')
    validateRepoSegment(repo, 'repo')
    return path.join(this.memoryRoot, 'repos', `${owner}_${repo}.md`)
  }
}

function emptyCache(owner: string, repo: string): CacheState {
  const sections = SECTION_ORDER.reduce<Record<SectionName, string[]>>(
    (acc, section) => {
      acc[section] = []
      return acc
    },
    {
      Structure: [],
      Toolchain: [],
      Conventions: [],
      'Key Files': [],
      Pitfalls: [],
      'Open Questions': [],
    },
  )

  return {
    title: `${owner}/${repo}`,
    lastUpdated: isoDate(new Date()),
    tasksCompleted: 0,
    mayBeStale: false,
    sections,
  }
}

function parseCache(content: string, owner: string, repo: string): CacheState {
  const state = emptyCache(owner, repo)
  const titleMatch = content.match(/^#\s+([^\n]+)/m)
  if (titleMatch?.[1]) {
    state.title = titleMatch[1].trim()
  }

  const metadataMatch = content.match(METADATA_PATTERN)
  if (metadataMatch) {
    state.lastUpdated = metadataMatch[1]
    state.tasksCompleted = parseInt(metadataMatch[2], 10)
  }

  state.mayBeStale = content.includes(STALE_FLAG)

  for (const section of SECTION_ORDER) {
    state.sections[section] = parseSectionItems(content, section)
  }
  return state
}

function parseSectionItems(content: string, section: SectionName): string[] {
  const pattern = new RegExp(
    `## ${escapeRegExp(section)}\\n([\\s\\S]*?)(?=\\n## [^\\n]+\\n|$)`,
  )
  const match = content.match(pattern)
  if (!match?.[1]) return []
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}

function renderCache(state: CacheState): string {
  const lines: string[] = [
    `# ${state.title}`,
    `<!-- last-updated: ${state.lastUpdated} | tasks-completed: ${state.tasksCompleted} -->`,
    '',
  ]

  if (state.mayBeStale) {
    lines.push(STALE_FLAG, '')
  }

  for (const section of SECTION_ORDER) {
    lines.push(`## ${section}`)
    for (const item of state.sections[section]) {
      lines.push(`- ${item}`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function appendFact(
  state: CacheState,
  section: SectionName,
  fact: string,
  dedupCorpus: { value: string },
): void {
  const normalized = normalizeFact(fact)
  if (!normalized) return
  if (dedupCorpus.value.includes(normalized)) return
  state.sections[section].push(normalized)
  dedupCorpus.value += `\n${normalized}`
}

function extractFacts(
  journalEntries: JournalEntry[],
  debriefs: ParsedDebrief[],
): {
  toolchain: string[]
  conventions: string[]
  keyFiles: string[]
  pitfalls: string[]
  openQuestions: string[]
} {
  const toolchain: string[] = []
  const conventions: string[] = []
  const keyFiles: string[] = []
  const pitfalls: string[] = []
  const openQuestions: string[] = []

  for (const entry of journalEntries) {
    const candidates = extractCandidates([entry.outcome, entry.body].join('\n'))
    if (entry.salience === 'SPIKE') {
      for (const candidate of candidates) {
        if (isPitfallFact(candidate)) {
          pitfalls.push(candidate)
          continue
        }
        if (isConventionFact(candidate)) {
          conventions.push(candidate)
        }
        if (candidate.includes('?')) {
          openQuestions.push(candidate)
        }
      }
      continue
    }

    if (entry.salience === 'NOTABLE') {
      for (const candidate of candidates) {
        if (isKeyFileFact(candidate)) {
          keyFiles.push(candidate)
        }
        if (isToolchainFact(candidate)) {
          toolchain.push(candidate)
        }
      }
    }
  }

  for (const debrief of debriefs) {
    for (const update of toList(debrief.doctrineUpdates)) {
      conventions.push(update)
    }
    for (const rootCause of toList(debrief.improveRootCauses)) {
      pitfalls.push(rootCause)
    }
  }

  return { toolchain, conventions, keyFiles, pitfalls, openQuestions }
}

function extractCandidates(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
}

function extractRevalidatedToolchain(entries: JournalEntry[]): string[] {
  const seen = new Set<string>()
  for (const entry of entries) {
    const candidates = extractCandidates([entry.outcome, entry.body].join('\n'))
    for (const candidate of candidates) {
      const normalized = normalizeFact(candidate)
      if (!normalized) continue
      if (!isToolchainFact(normalized)) continue
      seen.add(normalized)
    }
  }
  return [...seen]
}

function normalizeFact(fact: string): string | null {
  const cleaned = fact
    .replace(/^\d+\.\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;]+$/, '')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

function toList(value: ParsedDebrief['doctrineUpdates']): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean)
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()]
  }
  return []
}

function hasDebriefContent(debrief: ParsedDebrief): boolean {
  return toList(debrief.doctrineUpdates).length > 0 || toList(debrief.improveRootCauses).length > 0
}

function isStale(lastUpdated: string, now: Date): boolean {
  const last = new Date(`${lastUpdated}T00:00:00.000Z`)
  if (Number.isNaN(last.getTime())) return false
  return now.getTime() - last.getTime() > THIRTY_DAYS_MS
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function filenameToRepo(filename: string): string {
  const stem = filename.replace(/\.md$/, '')
  const splitAt = stem.indexOf('_')
  if (splitAt <= 0 || splitAt >= stem.length - 1) return stem
  return `${stem.slice(0, splitAt)}/${stem.slice(splitAt + 1)}`
}

function validateRepoSegment(value: string, label: string): void {
  if (!value || !GITHUB_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid repository ${label}: ${value}`)
  }
}

function isPitfallFact(value: string): boolean {
  return /\b(pitfall|gotcha|fail|failure|error|race condition|bug|type errors?|breaks?|loses|must run)\b/i.test(
    value,
  )
}

function isConventionFact(value: string): boolean {
  return /\b(convention|pattern|naming|routes?\.ts|filenames?|always|never|should|use|must)\b/i.test(
    value,
  )
}

function isKeyFileFact(value: string): boolean {
  return /(`[^`\n]*\/[^`\n]*`|\b[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\b)/.test(value)
}

function isToolchainFact(value: string): boolean {
  return /\b(npm|pnpm|yarn|bun|vitest|jest|pytest|cargo|go test|make|tsc|build command|test runner)\b/i.test(
    value,
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
