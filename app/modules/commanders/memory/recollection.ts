import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { resolveCommanderPaths } from '../paths.js'
import type { JournalEntry, SalienceLevel } from './types.js'
import { JournalWriter } from './journal.js'
import {
  AssociationStore,
  toJournalNodeId,
  toSkillNodeId,
  type SkillAssociationInput,
} from './associations.js'
import { parseSkillManifest, type GHIssue } from './skill-matcher.js'

const DEFAULT_TOP_K = 8
const MAX_MEMORY_BLOCKS = 40
const MAX_JOURNAL_FILES = 180
const MAX_KEYWORDS = 32
const TERM_MIN_LENGTH = 3
const STALE_SPIKE_DAYS = 45
const STALE_SPIKE_REHEARSAL_FLOOR = 2
const SPIKE_REPO_DRIFT_THRESHOLD = 8

const TERM_STOPWORDS = new Set([
  'after',
  'again',
  'before',
  'build',
  'issue',
  'just',
  'only',
  'over',
  'should',
  'this',
  'that',
  'their',
  'there',
  'these',
  'those',
  'with',
  'without',
])

export type RecollectionHitType = 'journal' | 'skill' | 'memory'

export interface RecollectionQuery {
  cue?: string
  task?: GHIssue | null
  recentConversation?: Array<{ role: string; content: string }>
  topK?: number
}

export interface RecollectionHit {
  id: string
  type: RecollectionHitType
  title: string
  excerpt: string
  score: number
  reason: string
  stale: boolean
  staleReason: string | null
  path: string | null
  repo: string | null
  issueNumber: number | null
  salience: SalienceLevel | null
}

export interface RecollectionResult {
  hits: RecollectionHit[]
  queryTerms: string[]
}

interface RecollectionCandidate {
  id: string
  type: RecollectionHitType
  nodeId: string | null
  title: string
  excerpt: string
  corpus: string
  timestamp: string | null
  path: string | null
  repo: string | null
  issueNumber: number | null
  salience: SalienceLevel | null
}

interface RecollectionOptions {
  now?: () => Date
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function safeSnippet(value: string, maxLen: number = 260): string {
  const compacted = compactText(value)
  if (compacted.length <= maxLen) return compacted
  return `${compacted.slice(0, maxLen - 3)}...`
}

function toRepo(task: GHIssue | null | undefined): string | null {
  if (!task) return null
  if (task.owner && task.repo) return `${task.owner}/${task.repo}`
  if (task.repository) return task.repository
  return null
}

function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9._/-]+/g) ?? []
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const token of raw) {
    if (token.length < TERM_MIN_LENGTH) continue
    if (TERM_STOPWORDS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
    if (tokens.length >= MAX_KEYWORDS) break
  }
  return tokens
}

function dayDiff(from: string | null, to: string): number {
  if (!from) return 0
  const fromDate = new Date(from).getTime()
  const toDate = new Date(to).getTime()
  if (!Number.isFinite(fromDate) || !Number.isFinite(toDate)) return 0
  return Math.max(0, Math.floor((toDate - fromDate) / (24 * 60 * 60 * 1000)))
}

function scoreLexical(corpus: string, terms: string[]): number {
  if (terms.length === 0) return 0
  const normalized = corpus.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (!normalized.includes(term)) continue
    score += 1
    if (normalized.includes(`${term}/`) || normalized.includes(`/${term}`)) {
      score += 0.2
    }
  }
  return score
}

function extractMemoryBlocks(content: string): string[] {
  return content
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .slice(0, MAX_MEMORY_BLOCKS)
}

export class MemoryRecollection {
  private readonly memoryRoot: string
  private readonly skillsRoot: string
  private readonly journal: JournalWriter
  private readonly associations: AssociationStore
  private readonly now: () => Date

  constructor(
    commanderId: string,
    basePath?: string,
    options: RecollectionOptions = {},
  ) {
    const resolved = resolveCommanderPaths(commanderId, basePath)
    this.memoryRoot = resolved.memoryRoot
    this.skillsRoot = resolved.skillsRoot
    this.journal = new JournalWriter(commanderId, basePath)
    this.associations = new AssociationStore(commanderId, basePath, { now: options.now })
    this.now = options.now ?? (() => new Date())
  }

  async recall(query: RecollectionQuery): Promise<RecollectionResult> {
    const topK = Math.max(1, query.topK ?? DEFAULT_TOP_K)
    const cue = this.buildCueText(query)
    const queryTerms = tokenize(cue)
    const repo = toRepo(query.task)
    const issueNumber = query.task?.number ?? null

    const [journalCandidates, memoryCandidates, skillCandidates] = await Promise.all([
      this.readJournalCandidates(),
      this.readMemoryCandidates(),
      this.readSkillCandidates(),
    ])

    const allCandidates = [...journalCandidates, ...memoryCandidates, ...skillCandidates]
    if (allCandidates.length === 0) {
      return { hits: [], queryTerms }
    }

    const nodeIds = allCandidates
      .map((candidate) => candidate.nodeId)
      .filter((nodeId): nodeId is string => Boolean(nodeId))

    const associationCue = {
      text: cue,
      repo,
      issueNumber,
    }

    const [associationScores, relatedNodeIds, graph] = await Promise.all([
      this.associations.scoreNodesForCue(nodeIds, associationCue),
      this.associations.relatedNodeIdsForCue(associationCue, topK * 5),
      this.associations.getGraphSnapshot(),
    ])
    const relatedSet = new Set(relatedNodeIds)

    const nowIso = this.now().toISOString()
    const scored = allCandidates
      .map((candidate) => {
        const lexical = scoreLexical(candidate.corpus, queryTerms)
        const association = candidate.nodeId ? (associationScores.get(candidate.nodeId) ?? 0) : 0
        const relatedBoost = candidate.nodeId && relatedSet.has(candidate.nodeId) ? 1.2 : 0
        if (lexical === 0 && association === 0 && relatedBoost === 0) {
          return null
        }

        const node = candidate.nodeId ? graph.nodes[candidate.nodeId] : undefined
        const seenCount = node?.seenCount ?? 0
        const rehearsalBoost = 1 + Math.log2(seenCount + 1) / 3
        const ageDays = dayDiff(candidate.timestamp, nowIso)
        const decayFloor = candidate.type === 'skill' ? 0.75 : 0.45
        const decay = Math.max(decayFloor, Math.exp(-ageDays / 65))
        const salienceBoost = candidate.salience === 'SPIKE'
          ? 1.5
          : candidate.salience === 'NOTABLE'
            ? 0.8
            : 0

        const staleAssessment = this.assessSpikeStaleness({
          candidate,
          seenCount,
          journalCandidates,
          nowIso,
          repo,
        })

        let score = (lexical + association + relatedBoost + salienceBoost) * decay * rehearsalBoost
        if (staleAssessment.stale) {
          score *= 0.55
        }

        const reasonParts = [
          lexical > 0 ? `lexical ${lexical.toFixed(1)}` : null,
          association > 0 ? `associative ${association.toFixed(1)}` : null,
          seenCount > 0 ? `rehearsed ${seenCount}x` : null,
        ].filter((part): part is string => Boolean(part))

        return {
          hit: this.toHit(candidate, score, reasonParts.join(', ') || 'context match', staleAssessment),
          nodeId: candidate.nodeId,
          type: candidate.type,
          skillInput: candidate.type === 'skill'
            ? ({
                name: candidate.title,
                path: candidate.path ?? '',
                description: candidate.excerpt,
                keywords: queryTerms.slice(0, 8),
              } satisfies SkillAssociationInput)
            : null,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.hit.score - a.hit.score)
      .slice(0, topK)

    const touchedNodeIds = scored
      .map((entry) => entry.nodeId)
      .filter((nodeId): nodeId is string => Boolean(nodeId))
    const touchedSkills = scored
      .filter((entry) => entry.type === 'skill' && entry.skillInput)
      .map((entry) => entry.skillInput as SkillAssociationInput)

    if (touchedNodeIds.length > 0) {
      await this.associations.touch(touchedNodeIds)
    }
    for (const skillInput of touchedSkills) {
      await this.associations.upsertSkill(skillInput)
    }

    return {
      hits: scored.map((entry) => entry.hit),
      queryTerms,
    }
  }

  private buildCueText(query: RecollectionQuery): string {
    const task = query.task
    const comments = (task?.comments ?? [])
      .slice(-3)
      .map((comment) => comment.body.trim())
      .filter((comment) => comment.length > 0)
      .join('\n')
    const conversation = (query.recentConversation ?? [])
      .slice(-4)
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n')

    return [
      query.cue ?? '',
      task?.title ?? '',
      task?.body ?? '',
      comments,
      toRepo(task) ?? '',
      conversation,
    ]
      .join('\n')
      .trim()
  }

  private async readJournalCandidates(): Promise<RecollectionCandidate[]> {
    const journalDir = path.join(this.memoryRoot, 'journal')
    let entries: Dirent<string>[]
    try {
      entries = await readdir(journalDir, { withFileTypes: true })
    } catch {
      return []
    }

    const dates = entries
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
      .map((entry) => entry.name.replace(/\.md$/, ''))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, MAX_JOURNAL_FILES)

    const candidates: RecollectionCandidate[] = []
    for (const date of dates) {
      const dayEntries = await this.journal.readDate(date)
      for (const entry of dayEntries) {
        const text = `${entry.outcome}\n${entry.body}`
        candidates.push({
          id: `journal:${entry.timestamp}`,
          type: 'journal',
          nodeId: toJournalNodeId(entry),
          title: entry.outcome,
          excerpt: safeSnippet(entry.body || entry.outcome),
          corpus: `${text}\n${entry.repo ?? ''}\n${entry.issueNumber ?? ''}`,
          timestamp: entry.timestamp,
          path: path.join(journalDir, `${date}.md`),
          repo: entry.repo,
          issueNumber: entry.issueNumber,
          salience: entry.salience,
        })
      }
    }

    return candidates
  }

  private async readMemoryCandidates(): Promise<RecollectionCandidate[]> {
    const memoryPath = path.join(this.memoryRoot, 'MEMORY.md')
    let content = ''
    try {
      content = await readFile(memoryPath, 'utf-8')
    } catch {
      return []
    }

    const blocks = extractMemoryBlocks(content)
    return blocks.map((block, index) => {
      const firstLine = block.split('\n').find((line) => line.trim().length > 0) ?? `Memory block ${index + 1}`
      return {
        id: `memory:${index}`,
        type: 'memory',
        nodeId: null,
        title: safeSnippet(firstLine, 80),
        excerpt: safeSnippet(block),
        corpus: block,
        timestamp: null,
        path: memoryPath,
        repo: null,
        issueNumber: null,
        salience: null,
      }
    })
  }

  private async readSkillCandidates(): Promise<RecollectionCandidate[]> {
    const skillFiles = await this.collectSkillFiles(this.skillsRoot)
    const candidates: RecollectionCandidate[] = []
    for (const skillPath of skillFiles) {
      let content = ''
      try {
        content = await readFile(skillPath, 'utf-8')
      } catch {
        continue
      }
      if (!content.trim()) continue

      const manifest = parseSkillManifest(content, skillPath)
      const summary = content
        .split('\n')
        .filter((line) => line.trim().length > 0 && !line.trim().startsWith('---'))
        .slice(0, 12)
        .join('\n')

      candidates.push({
        id: `skill:${manifest.name}`,
        type: 'skill',
        nodeId: toSkillNodeId(manifest.name),
        title: manifest.name,
        excerpt: safeSnippet(summary),
        corpus: `${manifest.name}\n${content}\n${manifest.autoMatch.labels.join(' ')} ${manifest.autoMatch.keywords.join(' ')}`,
        timestamp: null,
        path: skillPath,
        repo: null,
        issueNumber: null,
        salience: null,
      })
    }
    return candidates
  }

  private async collectSkillFiles(root: string): Promise<string[]> {
    let entries: Dirent<string>[]
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const files: string[] = []
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await this.collectSkillFiles(fullPath)))
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.toLowerCase() === 'skill.md') {
        files.push(fullPath)
      }
    }
    return files
  }

  private assessSpikeStaleness(args: {
    candidate: RecollectionCandidate
    seenCount: number
    journalCandidates: RecollectionCandidate[]
    nowIso: string
    repo: string | null
  }): { stale: boolean; staleReason: string | null } {
    const { candidate, seenCount, journalCandidates, nowIso, repo } = args
    if (candidate.type !== 'journal' || candidate.salience !== 'SPIKE') {
      return { stale: false, staleReason: null }
    }

    const ageDays = dayDiff(candidate.timestamp, nowIso)
    const staleReasons: string[] = []
    if (ageDays >= STALE_SPIKE_DAYS && seenCount < STALE_SPIKE_REHEARSAL_FLOOR) {
      staleReasons.push(`aged ${ageDays}d with low rehearsal`)
    }

    if (candidate.repo) {
      const newerSameRepo = journalCandidates.filter((entry) =>
        entry.type === 'journal' &&
        entry.repo?.toLowerCase() === candidate.repo?.toLowerCase() &&
        entry.timestamp &&
        candidate.timestamp &&
        entry.timestamp > candidate.timestamp).length
      if (newerSameRepo >= SPIKE_REPO_DRIFT_THRESHOLD) {
        staleReasons.push(`repo activity drift (${newerSameRepo} newer entries)`)
      }
    }

    if (repo && candidate.repo && candidate.repo.toLowerCase() !== repo.toLowerCase()) {
      staleReasons.push('different repo context')
    }

    if (staleReasons.length === 0) {
      return { stale: false, staleReason: null }
    }

    return {
      stale: true,
      staleReason: staleReasons.join('; '),
    }
  }

  private toHit(
    candidate: RecollectionCandidate,
    score: number,
    reason: string,
    staleAssessment: { stale: boolean; staleReason: string | null },
  ): RecollectionHit {
    return {
      id: candidate.id,
      type: candidate.type,
      title: candidate.title,
      excerpt: candidate.excerpt,
      score: Number(score.toFixed(3)),
      reason,
      stale: staleAssessment.stale,
      staleReason: staleAssessment.staleReason,
      path: candidate.path,
      repo: candidate.repo,
      issueNumber: candidate.issueNumber,
      salience: candidate.salience,
    }
  }
}
