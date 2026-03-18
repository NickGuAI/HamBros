import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { GoalsStore } from './goals-store.js'
import { JournalWriter } from './journal.js'
import { MemoryRecollection, type RecollectionHit } from './recollection.js'
import { WorkingMemoryStore } from './working-memory.js'
import type { JournalEntry } from './types.js'
import { type GHIssue } from './skill-matcher.js'
import { resolveCommanderPaths } from '../paths.js'

const DEFAULT_TOKEN_BUDGET = 8_000
const MAX_LONG_TERM_LINES = 200
const MAX_LONG_TERM_NARRATIVE_LINES = 100

const LAYER_GOALS = 1.5
const PRIORITY_ORDER = [1, LAYER_GOALS, 2, 3, 4, 5, 6] as const
const RENDER_ORDER = [2, LAYER_GOALS, 1, 3, 4, 5, 6] as const
const LAYER_DROP_ORDER = [6, 5, 4, 3] as const

export interface Message {
  role: string
  content: string
}

export interface ContextBuildOptions {
  currentTask: GHIssue | null
  recentConversation: Message[]
  tokenBudget?: number
}

export interface BuiltContext {
  systemPromptSection: string
  layersIncluded: number[]
  skillsMatched: string[]
  tokenEstimate: number
}

interface Layer4Result {
  content: string | null
  skillsMatched: string[]
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function trimLines(content: string, maxLines: number): string {
  const lines = content.split(/\r?\n/)
  if (lines.length <= maxLines) {
    return content.trim()
  }
  const trimmed = lines.slice(0, maxLines).join('\n').trim()
  return `${trimmed}\n\n_...truncated to first ${maxLines} lines._`
}

function trimLastLines(content: string, maxLines: number): string {
  const lines = content.split(/\r?\n/)
  if (lines.length <= maxLines) {
    return content.trim()
  }
  const trimmed = lines.slice(-maxLines).join('\n').trim()
  return `${trimmed}\n\n_...truncated to last ${maxLines} lines._`
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function indentBulletBody(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function toRepo(task: GHIssue | null): string | null {
  if (!task) return null
  if (task.owner && task.repo) return `${task.owner}/${task.repo}`
  return task.repository ?? null
}

export class MemoryContextBuilder {
  private readonly memoryRoot: string
  private readonly journal: JournalWriter
  private readonly recollection: MemoryRecollection
  private readonly workingMemory: WorkingMemoryStore
  private readonly goalsStore: GoalsStore

  constructor(
    commanderId: string,
    basePath?: string,
  ) {
    this.memoryRoot = resolveCommanderPaths(commanderId, basePath).memoryRoot
    this.journal = new JournalWriter(commanderId, basePath)
    this.recollection = new MemoryRecollection(commanderId, basePath)
    this.workingMemory = new WorkingMemoryStore(commanderId, basePath)
    this.goalsStore = new GoalsStore(commanderId, basePath)
  }

  async build(options: ContextBuildOptions): Promise<BuiltContext> {
    const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET
    const task = options.currentTask

    const [layer1, layerGoals, layer2, layer3, layer4, layer5] = await Promise.all([
      this.buildLayer1(task),
      this.goalsStore.buildContextSection(),
      this.buildLayer2(),
      this.buildLayer3(),
      this.buildLayer4(task, options.recentConversation),
      this.buildLayer5(),
    ])
    const layer6 = this.buildLayer6(options.recentConversation)

    const layers = new Map<number, string>([
      [1, layer1],
      [2, layer2],
    ])
    if (layerGoals) layers.set(LAYER_GOALS, layerGoals)
    if (layer3) layers.set(3, layer3)
    if (layer4.content) layers.set(4, layer4.content)
    if (layer5) layers.set(5, layer5)
    if (layer6) layers.set(6, layer6)

    let systemPromptSection = this.renderSection(layers)
    let tokenEstimate = estimateTokens(systemPromptSection)

    for (const layerId of LAYER_DROP_ORDER) {
      if (tokenEstimate <= tokenBudget) break
      if (!layers.has(layerId)) continue
      layers.delete(layerId)
      systemPromptSection = this.renderSection(layers)
      tokenEstimate = estimateTokens(systemPromptSection)
    }

    const layersIncluded = PRIORITY_ORDER.filter((layerId) => layers.has(layerId))
    return {
      systemPromptSection,
      layersIncluded,
      skillsMatched: layer4.skillsMatched,
      tokenEstimate,
    }
  }

  private renderSection(layers: Map<number, string>): string {
    const lines: string[] = ['## Commander Memory', '']
    for (const layerId of RENDER_ORDER) {
      const content = layers.get(layerId)
      if (!content) continue
      lines.push(content.trim(), '')
    }
    return lines.join('\n').trim()
  }

  private async buildLayer1(task: GHIssue | null): Promise<string> {
    const lines: string[] = ['### Current Task']
    const repo = toRepo(task) ?? 'unknown/unknown'
    if (!task) {
      lines.push('_No active task._')
    } else {
      lines.push(`**Issue #${task.number}**: ${task.title} — ${repo}`)
      if (task.body?.trim()) {
        lines.push('', task.body.trim())
      }
      const comments = (task.comments ?? [])
        .filter((comment) => comment.body.trim().length > 0)
        .slice(-5)
      if (comments.length > 0) {
        lines.push('', '#### Recent Comments')
        for (const comment of comments) {
          const metaBits = [comment.author, comment.createdAt].filter(
            (value): value is string => typeof value === 'string' && value.trim().length > 0,
          )
          const meta = metaBits.length > 0 ? `${metaBits.join(' • ')}: ` : ''
          lines.push(`- ${meta}${compactText(comment.body)}`)
        }
      }
    }

    const thinIndex = await this.readThinIndex()
    lines.push('', '### Backlog Overview')
    if (thinIndex) {
      lines.push(thinIndex)
    } else {
      lines.push('_No local thin index found._')
    }
    return lines.join('\n').trim()
  }

  private async buildLayer2(): Promise<string> {
    const memoryPath = path.join(this.memoryRoot, 'MEMORY.md')
    const longTermPath = path.join(this.memoryRoot, 'LONG_TERM_MEM.md')
    let memoryContent = ''
    let longTermNarrativeContent = ''
    try {
      memoryContent = await readFile(memoryPath, 'utf-8')
    } catch {
      // Optional layer fallback
    }
    try {
      longTermNarrativeContent = await readFile(longTermPath, 'utf-8')
    } catch {
      // Optional layer fallback
    }

    const factual = trimLines(memoryContent, MAX_LONG_TERM_LINES)
    const narrative = trimLastLines(longTermNarrativeContent, MAX_LONG_TERM_NARRATIVE_LINES)
    const lines = [
      '### Long-term Memory',
      '#### Facts (MEMORY.md)',
      factual || '_No fact memory found._',
      '',
      '#### Narrative (LONG_TERM_MEM.md)',
      narrative || '_No narrative long-term memory found._',
    ]
    return lines.join('\n')
  }

  private async buildLayer3(): Promise<string | null> {
    try {
      return await this.workingMemory.render(6)
    } catch {
      return null
    }
  }

  private async buildLayer4(
    task: GHIssue | null,
    recentConversation: Message[],
  ): Promise<Layer4Result> {
    const cues = recentConversation
      .slice(-4)
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n')
    const recollection = await this.recollection.recall({
      cue: cues,
      task,
      recentConversation,
      topK: 8,
    })

    const contextualHits = recollection.hits.filter((hit) => hit.type !== 'skill')
    if (contextualHits.length === 0) {
      return {
        content: '### Cue-based Recollection\n_No relevant recollections found._',
        skillsMatched: [],
      }
    }

    const lines: string[] = ['### Cue-based Recollection']
    for (const hit of contextualHits) {
      const score = hit.score.toFixed(2)
      const issueSuffix = hit.issueNumber != null ? ` #${hit.issueNumber}` : ''
      const repoSuffix = hit.repo ? ` [${hit.repo}]` : ''
      const salienceSuffix = hit.salience ? ` ${hit.salience}` : ''
      lines.push(`- [${hit.type}] ${hit.title}${issueSuffix}${repoSuffix}${salienceSuffix} (score ${score})`)
      lines.push(`  reason: ${hit.reason}`)
      lines.push(`  excerpt: ${hit.excerpt}`)
      if (hit.stale && hit.staleReason) {
        lines.push(`  stale-signal: ${hit.staleReason}`)
      }
      if (hit.path) {
        lines.push(`  source: ${hit.path}`)
      }
    }

    return {
      content: lines.join('\n'),
      skillsMatched: [],
    }
  }

  private async buildLayer5(): Promise<string | null> {
    const recentEntries = await this.journal.readRecent()
    if (recentEntries.length === 0) {
      return null
    }
    return ['### Recent Journal (last 2 days)', this.formatJournalEntries(recentEntries)].join('\n')
  }

  private buildLayer6(recentConversation: Message[]): string | null {
    const messages = recentConversation
      .filter((message) => typeof message.content === 'string' && message.content.trim().length > 0)
      .slice(-12)
    if (messages.length === 0) return null

    const lines: string[] = ['### Recent Conversation']
    for (const message of messages) {
      const role = message.role?.trim() || 'unknown'
      lines.push(`- ${role}: ${compactText(message.content)}`)
    }
    return lines.join('\n')
  }

  private formatJournalEntries(entries: JournalEntry[]): string {
    const lines: string[] = []
    for (const entry of entries) {
      const ts = entry.timestamp.replace('T', ' ').slice(0, 16)
      const issue = entry.issueNumber != null ? ` (#${entry.issueNumber})` : ''
      const repo = entry.repo ? ` [${entry.repo}]` : ''
      const emoji = entry.salience === 'SPIKE'
        ? '🔴'
        : entry.salience === 'NOTABLE'
          ? '🟡'
          : '⚪'
      lines.push(`- ${ts} ${emoji} ${entry.salience} — ${entry.outcome}${issue}${repo}`)
      if (entry.body.trim()) {
        lines.push(indentBulletBody(entry.body))
      }
    }
    return lines.join('\n')
  }

  private async readThinIndex(): Promise<string | null> {
    const thinIndexPath = path.join(this.memoryRoot, 'backlog', 'thin-index.md')
    let content = ''
    try {
      content = await readFile(thinIndexPath, 'utf-8')
    } catch {
      return null
    }
    const trimmed = content.trim()
    return trimmed || null
  }
}
