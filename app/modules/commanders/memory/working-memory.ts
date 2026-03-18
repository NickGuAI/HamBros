import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveCommanderPaths } from '../paths.js'

const WORKING_MEMORY_VERSION = 1
const MAX_FILES = 24
const MAX_CHECKPOINTS = 40
const MAX_SUMMARY_CHARS = 280
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000

export type WorkingMemorySource = 'start' | 'message' | 'heartbeat' | 'stop' | 'flush' | 'system'

export interface WorkingMemoryEntry {
  timestamp: string
  source: WorkingMemorySource
  summary: string
  issueNumber: number | null
  repo: string | null
  tags: string[]
}

export interface WorkingMemoryState {
  version: number
  updatedAt: string
  activeHypothesis: string | null
  filesInFocus: string[]
  checkpoints: WorkingMemoryEntry[]
}

export interface WorkingMemoryUpdate {
  source: WorkingMemorySource
  summary: string
  issueNumber?: number | null
  repo?: string | null
  hypothesis?: string | null
  files?: string[]
  tags?: string[]
}

interface WorkingMemoryOptions {
  now?: () => Date
}

function compactText(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function defaultState(nowIso: string): WorkingMemoryState {
  return {
    version: WORKING_MEMORY_VERSION,
    updatedAt: nowIso,
    activeHypothesis: null,
    filesInFocus: [],
    checkpoints: [],
  }
}

function normalizeTags(tags: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase()
    if (!normalized) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

export class WorkingMemoryStore {
  private readonly memoryRoot: string
  private readonly jsonPath: string
  private readonly markdownPath: string
  private readonly now: () => Date

  constructor(
    commanderId: string,
    basePath?: string,
    options: WorkingMemoryOptions = {},
  ) {
    this.memoryRoot = resolveCommanderPaths(commanderId, basePath).memoryRoot
    this.jsonPath = path.join(this.memoryRoot, 'working-memory.json')
    this.markdownPath = path.join(this.memoryRoot, 'working-memory.md')
    this.now = options.now ?? (() => new Date())
  }

  async ensure(): Promise<void> {
    const state = await this.readState()
    await this.writeState(state)
  }

  async readState(): Promise<WorkingMemoryState> {
    const nowIso = this.now().toISOString()
    try {
      const raw = await readFile(this.jsonPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<WorkingMemoryState>
      if (!parsed || typeof parsed !== 'object') {
        return defaultState(nowIso)
      }
      if (parsed.version !== WORKING_MEMORY_VERSION) {
        return defaultState(nowIso)
      }
      const checkpoints = Array.isArray(parsed.checkpoints)
        ? parsed.checkpoints.filter((entry) =>
          entry &&
          typeof entry === 'object' &&
          typeof entry.timestamp === 'string' &&
          typeof entry.source === 'string' &&
          typeof entry.summary === 'string')
        : []

      return {
        version: WORKING_MEMORY_VERSION,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso,
        activeHypothesis:
          typeof parsed.activeHypothesis === 'string' && parsed.activeHypothesis.trim()
            ? parsed.activeHypothesis.trim()
            : null,
        filesInFocus: Array.isArray(parsed.filesInFocus)
          ? parsed.filesInFocus
              .filter((entry): entry is string => typeof entry === 'string')
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
              .slice(0, MAX_FILES)
          : [],
        checkpoints: checkpoints.map((entry) => ({
          timestamp: entry.timestamp as string,
          source: entry.source as WorkingMemorySource,
          summary: compactText(entry.summary as string).slice(0, MAX_SUMMARY_CHARS),
          issueNumber:
            typeof entry.issueNumber === 'number' && Number.isInteger(entry.issueNumber)
              ? entry.issueNumber
              : null,
          repo: typeof entry.repo === 'string' && entry.repo.trim() ? entry.repo.trim() : null,
          tags: Array.isArray(entry.tags)
            ? normalizeTags(entry.tags.filter((tag): tag is string => typeof tag === 'string'))
            : [],
        })),
      }
    } catch {
      return defaultState(nowIso)
    }
  }

  async update(input: WorkingMemoryUpdate): Promise<void> {
    const summary = compactText(input.summary).slice(0, MAX_SUMMARY_CHARS)
    if (!summary) return

    const state = await this.readState()
    const nowIso = this.now().toISOString()
    const checkpoint: WorkingMemoryEntry = {
      timestamp: nowIso,
      source: input.source,
      summary,
      issueNumber:
        typeof input.issueNumber === 'number' && Number.isInteger(input.issueNumber)
          ? input.issueNumber
          : null,
      repo: typeof input.repo === 'string' && input.repo.trim() ? input.repo.trim() : null,
      tags: normalizeTags(input.tags ?? []),
    }

    const last = state.checkpoints[state.checkpoints.length - 1]
    const duplicate =
      last &&
      last.source === checkpoint.source &&
      compactText(last.summary) === checkpoint.summary &&
      Math.abs(new Date(checkpoint.timestamp).getTime() - new Date(last.timestamp).getTime()) <= DUPLICATE_WINDOW_MS

    if (!duplicate) {
      state.checkpoints.push(checkpoint)
      if (state.checkpoints.length > MAX_CHECKPOINTS) {
        state.checkpoints = state.checkpoints.slice(-MAX_CHECKPOINTS)
      }
    }

    const nextHypothesis = compactText(input.hypothesis ?? '')
    if (nextHypothesis) {
      state.activeHypothesis = nextHypothesis.slice(0, MAX_SUMMARY_CHARS)
    }

    const files = normalizeTags((input.files ?? []).map((file) => file.replace(/\\/g, '/')))
    if (files.length > 0) {
      const merged = [...state.filesInFocus, ...files]
      state.filesInFocus = normalizeTags(merged).slice(-MAX_FILES)
    }

    state.updatedAt = nowIso
    await this.writeState(state)
  }

  async render(maxCheckpoints: number = 8): Promise<string> {
    const state = await this.readState()
    const lines: string[] = ['### Working Memory Scratchpad']

    if (state.activeHypothesis) {
      lines.push(`- Active hypothesis: ${state.activeHypothesis}`)
    } else {
      lines.push('- Active hypothesis: _none_')
    }

    if (state.filesInFocus.length > 0) {
      lines.push(`- Files in focus: ${state.filesInFocus.join(', ')}`)
    } else {
      lines.push('- Files in focus: _none tracked_')
    }

    if (state.checkpoints.length === 0) {
      lines.push('', '_No recent scratchpad checkpoints._')
      return lines.join('\n')
    }

    lines.push('', '#### Recent Checkpoints')
    const checkpoints = state.checkpoints.slice(-Math.max(1, maxCheckpoints))
    for (const entry of checkpoints) {
      const issueSuffix = entry.issueNumber != null ? ` #${entry.issueNumber}` : ''
      const repoSuffix = entry.repo ? ` [${entry.repo}]` : ''
      const tagsSuffix = entry.tags.length > 0 ? ` {${entry.tags.join(', ')}}` : ''
      lines.push(
        `- ${entry.timestamp.replace('T', ' ').slice(0, 16)} (${entry.source})${issueSuffix}${repoSuffix}${tagsSuffix}: ${entry.summary}`,
      )
    }
    return lines.join('\n')
  }

  private async writeState(state: WorkingMemoryState): Promise<void> {
    await mkdir(this.memoryRoot, { recursive: true })
    await writeFile(this.jsonPath, JSON.stringify(state, null, 2), 'utf-8')
    await writeFile(this.markdownPath, `${await this.renderFromState(state)}\n`, 'utf-8')
  }

  private async renderFromState(state: WorkingMemoryState): Promise<string> {
    const lines: string[] = ['# Working Memory', '']
    lines.push(`Updated: ${state.updatedAt}`)
    lines.push(
      `Active hypothesis: ${state.activeHypothesis ?? '_none_'}`,
      '',
      '## Files In Focus',
    )
    if (state.filesInFocus.length === 0) {
      lines.push('- _none_')
    } else {
      for (const file of state.filesInFocus) {
        lines.push(`- ${file}`)
      }
    }

    lines.push('', '## Checkpoints')
    if (state.checkpoints.length === 0) {
      lines.push('- _none_')
    } else {
      for (const entry of state.checkpoints) {
        const issue = entry.issueNumber != null ? ` #${entry.issueNumber}` : ''
        const repo = entry.repo ? ` [${entry.repo}]` : ''
        const tags = entry.tags.length > 0 ? ` {${entry.tags.join(', ')}}` : ''
        lines.push(`- ${entry.timestamp} (${entry.source})${issue}${repo}${tags} ${entry.summary}`)
      }
    }

    return lines.join('\n').trim()
  }
}

/**
 * Lightweight working-memory facade for append/read/clear workflows.
 * It intentionally reuses the WorkingMemoryStore backing so existing
 * context-builder and route integrations stay consistent.
 */
export class WorkingMemory {
  private readonly memoryRoot: string
  private readonly markdownPath: string
  private readonly jsonPath: string
  private readonly now: () => Date
  private readonly store: WorkingMemoryStore

  constructor(
    commanderId: string,
    basePath?: string,
    options: WorkingMemoryOptions = {},
  ) {
    this.memoryRoot = resolveCommanderPaths(commanderId, basePath).memoryRoot
    this.markdownPath = path.join(this.memoryRoot, 'working-memory.md')
    this.jsonPath = path.join(this.memoryRoot, 'working-memory.json')
    this.now = options.now ?? (() => new Date())
    this.store = new WorkingMemoryStore(commanderId, basePath, options)
  }

  async append(note: string): Promise<void> {
    const summary = compactText(note).slice(0, MAX_SUMMARY_CHARS)
    if (!summary) return
    await this.store.update({
      source: 'system',
      summary,
      tags: ['observation'],
    })
  }

  async read(): Promise<string> {
    try {
      return await readFile(this.markdownPath, 'utf-8')
    } catch {
      return ''
    }
  }

  async clear(): Promise<void> {
    await mkdir(this.memoryRoot, { recursive: true })
    const state = defaultState(this.now().toISOString())
    await writeFile(this.jsonPath, JSON.stringify(state, null, 2), 'utf-8')
    await writeFile(this.markdownPath, '', 'utf-8')
  }
}
