import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import { JournalWriter } from './journal.js'
import type { JournalEntry } from './types.js'
import {
  loadSkillManifests,
  rankMatchingSkills,
  type GHIssue,
  type SkillManifest,
} from './skill-matcher.js'

const DEFAULT_TOKEN_BUDGET = 8_000
const MAX_LONG_TERM_LINES = 200

const PRIORITY_ORDER = [1, 2, 3, 4, 5, 6] as const
const RENDER_ORDER = [2, 1, 3, 4, 5, 6] as const
const LAYER_DROP_ORDER = [6, 5, 4] as const

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

interface RepoRef {
  owner: string
  repo: string
}

interface Layer3Result {
  markdown: string | null
  skills: SkillManifest[]
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function trimLines(content: string, maxLines: number): string {
  const lines = content.split(/\r?\n/)
  if (lines.length <= maxLines) {
    return content.trim()
  }
  const trimmed = lines.slice(0, maxLines).join('\n').trim()
  return `${trimmed}\n\n_...truncated to first ${maxLines} lines._`
}

function indentBulletBody(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function parseRepoRef(task: GHIssue | null): RepoRef | null {
  if (!task) return null

  if (task.owner && task.repo) {
    return { owner: task.owner, repo: task.repo }
  }

  const fromRepository = task.repository?.split('/')
  if (fromRepository && fromRepository.length === 2) {
    const [owner, repo] = fromRepository
    if (owner && repo) return { owner, repo }
  }

  return null
}

function repoSlug(repoRef: RepoRef | null): string | null {
  if (!repoRef) return null
  return `${repoRef.owner}/${repoRef.repo}`
}

function isRepoRelevant(entryRepo: string | null, currentRepo: string | null): boolean {
  if (!entryRepo || !currentRepo) return false
  const normalizedEntry = entryRepo.toLowerCase()
  const normalizedCurrent = currentRepo.toLowerCase()
  return normalizedEntry === normalizedCurrent || normalizedEntry.includes(normalizedCurrent)
}

export class MemoryContextBuilder {
  private readonly memoryRoot: string
  private readonly journal: JournalWriter

  constructor(
    private readonly commanderId: string,
    basePath?: string,
  ) {
    this.memoryRoot = basePath
      ? path.join(basePath, commanderId, '.memory')
      : path.resolve(process.cwd(), 'data', 'commanders', commanderId, '.memory')
    this.journal = new JournalWriter(commanderId, basePath)
  }

  async build(options: ContextBuildOptions): Promise<BuiltContext> {
    const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET
    const task = options.currentTask

    const layer1 = await this.buildLayer1(task)
    const layer2 = await this.buildLayer2()
    const layer3 = await this.buildLayer3(task)
    const layer4 = await this.buildLayer4(task)
    const layer5 = await this.buildLayer5(task)
    const layer6 = this.buildLayer6(options.recentConversation)

    const layers = new Map<number, string>([
      [1, layer1],
      [2, layer2],
    ])
    if (layer3.markdown) layers.set(3, layer3.markdown)
    if (layer4) layers.set(4, layer4)
    if (layer5) layers.set(5, layer5)
    if (layer6) layers.set(6, layer6)

    let injectedSkills = layer3.skills.map((skill) => skill.name)
    let systemPromptSection = this.renderSection(layers)
    let tokenEstimate = estimateTokens(systemPromptSection)

    for (const layerId of LAYER_DROP_ORDER) {
      if (tokenEstimate <= tokenBudget) break
      if (!layers.has(layerId)) continue
      layers.delete(layerId)
      systemPromptSection = this.renderSection(layers)
      tokenEstimate = estimateTokens(systemPromptSection)
    }

    if (tokenEstimate > tokenBudget && layer3.skills.length > 1 && layers.has(3)) {
      const topSkill = layer3.skills[0]
      if (topSkill) {
        layers.set(3, this.renderSkillsLayer([topSkill]))
        injectedSkills = [topSkill.name]
        systemPromptSection = this.renderSection(layers)
        tokenEstimate = estimateTokens(systemPromptSection)
      }
    }

    const layersIncluded = PRIORITY_ORDER.filter((layerId) => layers.has(layerId))

    return {
      systemPromptSection,
      layersIncluded,
      skillsMatched: injectedSkills,
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
    const repo = parseRepoRef(task)
    const repoName = repoSlug(repo) ?? 'unknown/unknown'

    if (task) {
      lines.push(
        `**Issue #${task.number}**: ${task.title} — ${repoName}`,
      )
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
    } else {
      lines.push('_No active task._')
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
    let memoryContent = ''
    try {
      memoryContent = await readFile(memoryPath, 'utf-8')
    } catch {
      // Optional: layer remains with fallback text if memory file is missing.
    }

    const trimmed = trimLines(memoryContent, MAX_LONG_TERM_LINES)
    return [
      '### Long-term Memory',
      trimmed || '_No long-term memory found._',
    ].join('\n')
  }

  private async buildLayer3(task: GHIssue | null): Promise<Layer3Result> {
    if (!task) {
      return { markdown: null, skills: [] }
    }

    const skillsRoot = path.join(this.memoryRoot, 'skills')
    const manifests = await loadSkillManifests(skillsRoot)
    const matchedSkills = rankMatchingSkills(manifests, task)
    if (matchedSkills.length === 0) {
      return { markdown: null, skills: [] }
    }

    return {
      markdown: this.renderSkillsLayer(matchedSkills),
      skills: matchedSkills,
    }
  }

  private renderSkillsLayer(skills: SkillManifest[]): string {
    const lines: string[] = ['### Applicable Skills']
    for (const skill of skills) {
      lines.push('', `#### ${skill.name}`, skill.content)
    }
    return lines.join('\n').trim()
  }

  private async buildLayer4(task: GHIssue | null): Promise<string | null> {
    const repo = parseRepoRef(task)
    if (!repo) return null

    const repoPath = path.join(this.memoryRoot, 'repos', `${repo.owner}_${repo.repo}.md`)
    let content = ''
    try {
      content = await readFile(repoPath, 'utf-8')
    } catch {
      return null
    }

    const trimmed = content.trim()
    if (!trimmed) return null
    return `### Repo Knowledge: ${repo.owner}/${repo.repo}\n${trimmed}`
  }

  private async buildLayer5(task: GHIssue | null): Promise<string | null> {
    const recentEntries = await this.journal.readRecent()
    const currentRepo = repoSlug(parseRepoRef(task))
    const olderSpikes = await this.readOlderRepoSpikes(currentRepo)

    if (recentEntries.length === 0 && olderSpikes.length === 0) {
      return null
    }

    const lines: string[] = ['### Recent Journal (last 2 days)']

    if (recentEntries.length > 0) {
      lines.push(this.formatJournalEntries(recentEntries))
    } else {
      lines.push('_No journal entries in the last 2 days._')
    }

    if (olderSpikes.length > 0) {
      lines.push('', `#### Older SPIKE Entries${currentRepo ? ` (${currentRepo})` : ''}`)
      lines.push(this.formatJournalEntries(olderSpikes))
    }

    return lines.join('\n').trim()
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

  private async readOlderRepoSpikes(currentRepo: string | null): Promise<JournalEntry[]> {
    if (!currentRepo) return []

    let journalEntries: Dirent<string>[]
    try {
      journalEntries = await readdir(path.join(this.memoryRoot, 'journal'), { withFileTypes: true })
    } catch {
      return []
    }

    const today = toDateString(new Date())
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = toDateString(yesterdayDate)

    const dates = journalEntries
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
      .map((entry) => entry.name.replace(/\.md$/, ''))
      .filter((date) => date !== today && date !== yesterday)
      .sort((a, b) => b.localeCompare(a))

    const spikes: JournalEntry[] = []
    for (const date of dates) {
      const dayEntries = await this.journal.readDate(date)
      for (const entry of dayEntries) {
        if (entry.salience !== 'SPIKE') continue
        if (!isRepoRelevant(entry.repo, currentRepo)) continue
        spikes.push(entry)
      }
    }

    return spikes
  }
}
