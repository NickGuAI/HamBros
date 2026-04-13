import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { resolveCommanderPaths } from '../paths.js'
import {
  searchCommanderTranscriptIndex,
  type TranscriptSearchHit,
} from '../transcript-index.js'
import type { SalienceLevel } from './types.js'
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
const MIN_EXTERNAL_VECTOR_SCRIPT_CANDIDATES = 32
const STALE_SPIKE_DAYS = 45
const STALE_SPIKE_REHEARSAL_FLOOR = 2
const SPIKE_REPO_DRIFT_THRESHOLD = 8

const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7
const DEFAULT_HYBRID_BM25_WEIGHT = 0.3
const DEFAULT_HYBRID_MIN_SCORE = 0.35
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 6
const MIN_HYBRID_CANDIDATES = 24
const LOCAL_VECTOR_DIMENSION = 256
const BM25_K1 = 1.2
const BM25_B = 0.75
const FTS_DB_NAME = 'commander-memory-fts.sqlite'
const VECTOR_CANDIDATES_FILE = 'commander-memory-candidates.json'
const MAX_VECTOR_TEXT_CHARS = 8_000
const MAX_VECTOR_SCRIPT_BUFFER = 50 * 1024 * 1024

const MEMORY_VECTOR_INDEX_SCRIPT_PATH = path.resolve(
  process.cwd(),
  'scripts',
  'commander-memory-index.py',
)

const execFileAsync = promisify(execFile)

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

export type RecollectionHitType = 'journal' | 'skill' | 'memory' | 'transcript'

export interface RecollectionQuery {
  cue?: string
  task?: GHIssue | null
  recentConversation?: Array<{ role: string; content: string }>
  topK?: number
}

export interface RecollectionHit {
  id: string
  type: RecollectionHitType
  attribution: string
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

export interface HybridSearchCandidate {
  id: string
  type: RecollectionHitType
  title: string
  excerpt: string
  corpus: string
  path: string | null
}

interface RecollectionCandidate extends HybridSearchCandidate {
  nodeId: string | null
  timestamp: string | null
  repo: string | null
  issueNumber: number | null
  salience: SalienceLevel | null
}

export interface HybridScoreWeights {
  vector: number
  bm25: number
}

export interface HybridFoundationScore {
  id: string
  vectorScore: number
  bm25Score: number
  hybridScore: number
}

export interface HybridTextRankInput {
  cue: string
  queryTerms?: string[]
  entries: Array<{
    id: string
    corpus: string
  }>
  topK?: number
  weights?: Partial<HybridScoreWeights>
  minScore?: number
}

export interface HybridSearchInput {
  cue: string
  queryTerms: string[]
  candidates: HybridSearchCandidate[]
  topK: number
}

interface VectorCandidatePayload {
  id: string
  hash: string
  title: string
  type: RecollectionHitType
  path: string | null
  text: string
}

interface VectorScriptSearchHit {
  id: string
  score: number
}

export type TranscriptSearchRunner = (query: string, topK: number) => Promise<TranscriptSearchHit[]>
export type HybridSearchRunner = (
  input: HybridSearchInput,
) => Promise<Map<string, HybridFoundationScore>>

export interface RecollectionOptions {
  now?: () => Date
  transcriptSearch?: TranscriptSearchRunner
  hybridSearch?: HybridSearchRunner
  hybridWeights?: Partial<HybridScoreWeights>
  minHybridScore?: number
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

function tokenizeDocument(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9._/-]+/g) ?? []
  return raw.filter((token) => token.length >= TERM_MIN_LENGTH && !TERM_STOPWORDS.has(token))
}

function scoreSkillLexical(corpus: string, terms: string[]): number {
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

function dayDiff(from: string | null, to: string): number {
  if (!from) return 0
  const fromDate = new Date(from).getTime()
  const toDate = new Date(to).getTime()
  if (!Number.isFinite(fromDate) || !Number.isFinite(toDate)) return 0
  return Math.max(0, Math.floor((toDate - fromDate) / (24 * 60 * 60 * 1000)))
}

function extractMemoryBlocks(content: string): string[] {
  const rawBlocks = content
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)

  const mergedBlocks: string[] = []
  for (let index = 0; index < rawBlocks.length; index += 1) {
    const block = rawBlocks[index]
    const lines = block.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    const isHeadingOnlyBlock =
      lines.length === 1 &&
      /^#{1,6}\s+/.test(lines[0] ?? '')

    if (isHeadingOnlyBlock && index + 1 < rawBlocks.length) {
      mergedBlocks.push(`${block}\n\n${rawBlocks[index + 1]}`)
      index += 1
      continue
    }

    mergedBlocks.push(block)
  }

  return mergedBlocks.slice(0, MAX_MEMORY_BLOCKS)
}

function stemToken(token: string): string {
  if (token.length <= 4) return token
  if (token.endsWith('ing') && token.length > 6) return token.slice(0, -3)
  if (token.endsWith('ed') && token.length > 5) return token.slice(0, -2)
  if (token.endsWith('es') && token.length > 5) return token.slice(0, -2)
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1)
  return token
}

function stableTokenHash(text: string): number {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

function buildHashedVector(text: string, dimension: number = LOCAL_VECTOR_DIMENSION): Float64Array {
  const vector = new Float64Array(dimension)
  const tokens = tokenizeDocument(text).map(stemToken)

  for (const token of tokens) {
    const slot = stableTokenHash(token) % dimension
    vector[slot] += 1
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const bigram = `${tokens[index]}:${tokens[index + 1]}`
    const slot = stableTokenHash(bigram) % dimension
    vector[slot] += 0.5
  }

  return vector
}

function cosineSimilarity(left: Float64Array, right: Float64Array): number {
  if (left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function normalizeScoreMap(scores: Map<string, number>): Map<string, number> {
  if (scores.size === 0) return scores
  const max = Math.max(...scores.values())
  if (!Number.isFinite(max) || max <= 0) {
    return new Map(Array.from(scores.keys(), (id) => [id, 0]))
  }
  return new Map(
    Array.from(scores.entries(), ([id, score]) => [
      id,
      Number((score / max).toFixed(4)),
    ]),
  )
}

function resolveHybridWeights(input?: Partial<HybridScoreWeights>): HybridScoreWeights {
  const vector = input?.vector ?? DEFAULT_HYBRID_VECTOR_WEIGHT
  const bm25 = input?.bm25 ?? DEFAULT_HYBRID_BM25_WEIGHT
  const total = vector + bm25
  if (!Number.isFinite(total) || total <= 0) {
    return {
      vector: DEFAULT_HYBRID_VECTOR_WEIGHT,
      bm25: DEFAULT_HYBRID_BM25_WEIGHT,
    }
  }
  return {
    vector: Number((vector / total).toFixed(4)),
    bm25: Number((bm25 / total).toFixed(4)),
  }
}

function computeInMemoryBm25Scores(
  entries: Array<{ id: string; corpus: string }>,
  queryTerms: string[],
): Map<string, number> {
  if (entries.length === 0 || queryTerms.length === 0) {
    return new Map()
  }

  const docTermFreq = new Map<string, Map<string, number>>()
  const docLength = new Map<string, number>()
  const docFreq = new Map<string, number>()

  for (const entry of entries) {
    const tokens = tokenizeDocument(entry.corpus)
    docLength.set(entry.id, tokens.length)

    const termFreq = new Map<string, number>()
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1)
    }
    docTermFreq.set(entry.id, termFreq)

    for (const term of termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    }
  }

  const docCount = entries.length
  const avgLength = Math.max(
    1,
    Array.from(docLength.values()).reduce((sum, current) => sum + current, 0) / docCount,
  )

  const rawScores = new Map<string, number>()

  for (const entry of entries) {
    const termFreq = docTermFreq.get(entry.id)
    if (!termFreq) continue

    const currentLength = docLength.get(entry.id) ?? 0
    let score = 0

    for (const term of queryTerms) {
      const frequency = termFreq.get(term) ?? 0
      if (frequency <= 0) continue

      const docsWithTerm = docFreq.get(term) ?? 0
      const idf = Math.log(1 + (docCount - docsWithTerm + 0.5) / (docsWithTerm + 0.5))
      const numerator = frequency * (BM25_K1 + 1)
      const denominator =
        frequency + BM25_K1 * (1 - BM25_B + BM25_B * (currentLength / avgLength))

      score += idf * (numerator / Math.max(denominator, 1e-9))
    }

    if (score > 0) {
      rawScores.set(entry.id, score)
    }
  }

  return normalizeScoreMap(rawScores)
}

function computeLocalVectorScores(
  entries: Array<{ id: string; corpus: string }>,
  cue: string,
  topK: number,
): Map<string, number> {
  const queryVector = buildHashedVector(cue)
  const scored = entries
    .map((entry) => ({
      id: entry.id,
      score: cosineSimilarity(queryVector, buildHashedVector(entry.corpus)),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, topK))

  return normalizeScoreMap(new Map(scored.map((entry) => [entry.id, entry.score])))
}

function combineHybridScores(args: {
  entryIds: string[]
  bm25Scores: Map<string, number>
  vectorScores: Map<string, number>
  weights: HybridScoreWeights
  minScore: number
  topK: number
}): Map<string, HybridFoundationScore> {
  const {
    entryIds,
    bm25Scores,
    vectorScores,
    weights,
    minScore,
    topK,
  } = args

  const scored = entryIds
    .map((id) => {
      const bm25Score = bm25Scores.get(id) ?? 0
      const vectorScore = vectorScores.get(id) ?? 0
      const hybridScore = (vectorScore * weights.vector) + (bm25Score * weights.bm25)
      return {
        id,
        bm25Score,
        vectorScore,
        hybridScore,
      }
    })
    .filter((entry) => entry.hybridScore > 0 && entry.hybridScore >= minScore)
    .sort((left, right) => right.hybridScore - left.hybridScore)
    .slice(0, Math.max(1, topK))

  return new Map(
    scored.map((entry) => [
      entry.id,
      {
        id: entry.id,
        bm25Score: Number(entry.bm25Score.toFixed(4)),
        vectorScore: Number(entry.vectorScore.toFixed(4)),
        hybridScore: Number(entry.hybridScore.toFixed(4)),
      },
    ]),
  )
}

function candidateHash(candidate: Pick<HybridSearchCandidate, 'id' | 'corpus' | 'title' | 'path' | 'type'>): string {
  return createHash('sha1')
    .update([
      candidate.id,
      candidate.type,
      candidate.title,
      candidate.path ?? '',
      candidate.corpus,
    ].join('\n'))
    .digest('hex')
}

function buildFtsQuery(terms: string[]): string {
  const safeTerms = terms
    .map((term) => term.replace(/"/g, '""').trim())
    .filter((term) => term.length > 0)
  if (safeTerms.length === 0) {
    return ''
  }
  return safeTerms.map((term) => `"${term}"`).join(' OR ')
}

function parseVectorSearchResults(stdout: string): VectorScriptSearchHit[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  const hits: VectorScriptSearchHit[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }

    const entryRecord = entry as Record<string, unknown>
    const rawId = entryRecord.id
    const rawScore = entryRecord.score
    const id: string | null = typeof rawId === 'string'
      ? rawId
      : null
    const score: number | null = typeof rawScore === 'number'
      ? rawScore
      : null

    if (id === null || score === null || !Number.isFinite(score)) {
      continue
    }

    hits.push({ id, score })
  }

  return hits
}

function toVectorPayload(candidates: HybridSearchCandidate[]): VectorCandidatePayload[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    hash: candidateHash(candidate),
    title: candidate.title,
    type: candidate.type,
    path: candidate.path,
    text: candidate.corpus.slice(0, MAX_VECTOR_TEXT_CHARS),
  }))
}

export function rankHybridTextEntries(input: HybridTextRankInput): Map<string, HybridFoundationScore> {
  if (input.entries.length === 0) {
    return new Map()
  }

  const queryTerms = input.queryTerms && input.queryTerms.length > 0
    ? input.queryTerms
    : tokenize(input.cue)
  const bm25Scores = computeInMemoryBm25Scores(input.entries, queryTerms)
  const vectorScores = computeLocalVectorScores(
    input.entries,
    input.cue,
    input.topK ?? input.entries.length,
  )
  const weights = resolveHybridWeights(input.weights)

  return combineHybridScores({
    entryIds: input.entries.map((entry) => entry.id),
    bm25Scores,
    vectorScores,
    weights,
    minScore: Math.max(0, input.minScore ?? 0),
    topK: input.topK ?? input.entries.length,
  })
}

export class MemoryRecollection {
  private readonly memoryRoot: string
  private readonly skillsRoot: string
  private readonly journal: JournalWriter
  private readonly associations: AssociationStore
  private readonly now: () => Date
  private readonly transcriptSearch: TranscriptSearchRunner
  private readonly hybridSearch: HybridSearchRunner
  private readonly hybridWeights: HybridScoreWeights
  private readonly minHybridScore: number
  private readonly indexRoot: string
  private readonly bm25DbPath: string
  private readonly vectorCandidatesPath: string

  private vectorScriptEnabled: boolean | null = null

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
    this.transcriptSearch = options.transcriptSearch ?? (async () => [])
    this.hybridWeights = resolveHybridWeights(options.hybridWeights)
    this.minHybridScore = Math.max(0, options.minHybridScore ?? DEFAULT_HYBRID_MIN_SCORE)
    this.hybridSearch = options.hybridSearch ?? ((input) => this.defaultHybridSearch(input))
    this.indexRoot = path.join(this.memoryRoot, '.index')
    this.bm25DbPath = path.join(this.indexRoot, FTS_DB_NAME)
    this.vectorCandidatesPath = path.join(this.indexRoot, VECTOR_CANDIDATES_FILE)
  }

  async recall(query: RecollectionQuery): Promise<RecollectionResult> {
    const topK = Math.max(1, query.topK ?? DEFAULT_TOP_K)
    const cue = this.buildCueText(query)
    const queryTerms = tokenize(cue)
    const repo = toRepo(query.task)
    const issueNumber = query.task?.number ?? null

    const [journalCandidates, memoryCandidates, skillCandidates, transcriptHits] = await Promise.all([
      this.readJournalCandidates(),
      this.readMemoryCandidates(),
      this.readSkillCandidates(),
      this.searchTranscriptHits(cue, topK),
    ])

    const allCandidates = [...journalCandidates, ...memoryCandidates, ...skillCandidates]
    if (allCandidates.length === 0 && transcriptHits.length === 0) {
      return { hits: [], queryTerms }
    }

    const foundationCandidates = allCandidates.filter((candidate) => candidate.type !== 'skill')
    const foundationScores = await this.hybridSearch({
      cue,
      queryTerms,
      candidates: foundationCandidates,
      topK: Math.max(topK * DEFAULT_HYBRID_CANDIDATE_MULTIPLIER, MIN_HYBRID_CANDIDATES),
    })

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
    const lexicalHits = allCandidates
      .map((candidate) => {
        const foundation = foundationScores.get(candidate.id)
        const foundationScore = foundation
          ? foundation.hybridScore
          : candidate.type === 'skill'
            ? scoreSkillLexical(candidate.corpus, queryTerms)
            : 0
        const association = candidate.nodeId ? (associationScores.get(candidate.nodeId) ?? 0) : 0
        const relatedBoost = candidate.nodeId && relatedSet.has(candidate.nodeId) ? 1.2 : 0
        if (foundationScore === 0 && association === 0 && relatedBoost === 0) {
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

        let score = (foundationScore + association + relatedBoost + salienceBoost) * decay * rehearsalBoost
        if (staleAssessment.stale) {
          score *= 0.55
        }

        const reasonParts = [
          foundation
            ? `hybrid ${foundation.hybridScore.toFixed(3)} (vector ${foundation.vectorScore.toFixed(3)}, bm25 ${foundation.bm25Score.toFixed(3)})`
            : foundationScore > 0
              ? `lexical ${foundationScore.toFixed(1)}`
              : null,
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

    const scored = [...lexicalHits, ...transcriptHits.map((hit) => ({
      hit,
      nodeId: null,
      type: 'transcript' as const,
      skillInput: null,
    }))]
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

  async refreshHybridIndex(): Promise<void> {
    const [journalCandidates, memoryCandidates] = await Promise.all([
      this.readJournalCandidates(),
      this.readMemoryCandidates(),
    ])
    const candidates = [...journalCandidates, ...memoryCandidates]
    await this.syncHybridIndexes(candidates)
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
    const sources = [
      {
        fileName: 'MEMORY.md',
        idPrefix: 'memory:facts',
        fallbackTitle: 'Memory block',
      },
      {
        fileName: 'LONG_TERM_MEM.md',
        idPrefix: 'memory:long-term',
        fallbackTitle: 'Narrative block',
      },
    ] as const

    const candidates: RecollectionCandidate[] = []

    for (const source of sources) {
      const memoryPath = path.join(this.memoryRoot, source.fileName)
      let content = ''
      try {
        content = await readFile(memoryPath, 'utf-8')
      } catch {
        continue
      }

      const blocks = extractMemoryBlocks(content)
      for (const [index, block] of blocks.entries()) {
        const firstLine = block.split('\n').find((line) => line.trim().length > 0) ?? `${source.fallbackTitle} ${index + 1}`
        candidates.push({
          id: `${source.idPrefix}:${index}`,
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
        })
      }
    }

    return candidates
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

  private async defaultHybridSearch(
    input: HybridSearchInput,
  ): Promise<Map<string, HybridFoundationScore>> {
    if (input.candidates.length === 0) {
      return new Map()
    }

    await this.syncHybridIndexes(input.candidates)

    const bm25Scores = this.searchBm25Index(input.queryTerms, input.topK)
    const vectorScores = await this.searchVectorIndex(input.cue, input.topK, input.candidates)

    return combineHybridScores({
      entryIds: input.candidates.map((candidate) => candidate.id),
      bm25Scores,
      vectorScores,
      weights: this.hybridWeights,
      minScore: this.minHybridScore,
      topK: input.topK,
    })
  }

  private async syncHybridIndexes(candidates: HybridSearchCandidate[]): Promise<void> {
    await mkdir(this.indexRoot, { recursive: true })
    this.syncBm25Index(candidates)
    await this.syncVectorIndex(candidates)
  }

  private openBm25Db(): DatabaseSync {
    const db = new DatabaseSync(this.bm25DbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA busy_timeout = 3000;')
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS memory_docs (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        corpus TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_docs_fts USING fts5(
        id UNINDEXED,
        corpus
      );
      `,
    )
    return db
  }

  private syncBm25Index(candidates: HybridSearchCandidate[]): void {
    const db = this.openBm25Db()
    try {
      const existingRows = db.prepare('SELECT id, hash FROM memory_docs').all() as Array<{
        id?: unknown
        hash?: unknown
      }>
      const existingById = new Map<string, string>()
      for (const row of existingRows) {
        if (typeof row.id === 'string' && typeof row.hash === 'string') {
          existingById.set(row.id, row.hash)
        }
      }

      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
      const deleteDocStmt = db.prepare('DELETE FROM memory_docs WHERE id = ?')
      const deleteFtsStmt = db.prepare('DELETE FROM memory_docs_fts WHERE id = ?')

      for (const existingId of existingById.keys()) {
        if (!candidateById.has(existingId)) {
          deleteDocStmt.run(existingId)
          deleteFtsStmt.run(existingId)
        }
      }

      const upsertDocStmt = db.prepare(
        `
          INSERT INTO memory_docs (id, hash, corpus)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            hash = excluded.hash,
            corpus = excluded.corpus
        `,
      )
      const insertFtsStmt = db.prepare('INSERT INTO memory_docs_fts (id, corpus) VALUES (?, ?)')

      for (const candidate of candidates) {
        const hash = candidateHash(candidate)
        if (existingById.get(candidate.id) === hash) {
          continue
        }

        deleteFtsStmt.run(candidate.id)
        upsertDocStmt.run(candidate.id, hash, candidate.corpus)
        insertFtsStmt.run(candidate.id, candidate.corpus)
      }
    } finally {
      db.close()
    }
  }

  private searchBm25Index(queryTerms: string[], topK: number): Map<string, number> {
    if (queryTerms.length === 0) {
      return new Map()
    }

    const query = buildFtsQuery(queryTerms)
    if (!query) {
      return new Map()
    }

    const db = this.openBm25Db()
    try {
      const rows = db.prepare(
        `
          SELECT id, bm25(memory_docs_fts) AS rank
          FROM memory_docs_fts
          WHERE memory_docs_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `,
      ).all(query, Math.max(1, topK)) as Array<{ id?: unknown; rank?: unknown }>

      const rawScores = new Map<string, number>()
      for (const [index, row] of rows.entries()) {
        if (typeof row.id !== 'string') continue
        const rank = typeof row.rank === 'number' ? row.rank : 0
        const score = Number.isFinite(rank) ? Math.max(0, -rank) : 0
        if (score > 0) {
          rawScores.set(row.id, score)
          continue
        }
        rawScores.set(row.id, rows.length - index)
      }

      return normalizeScoreMap(rawScores)
    } catch {
      return new Map()
    } finally {
      db.close()
    }
  }

  private async syncVectorIndex(candidates: HybridSearchCandidate[]): Promise<void> {
    if (candidates.length < MIN_EXTERNAL_VECTOR_SCRIPT_CANDIDATES) {
      return
    }

    const payload = toVectorPayload(candidates)
    await writeFile(this.vectorCandidatesPath, JSON.stringify(payload), 'utf-8')

    if (!(await this.canUseVectorScript())) {
      return
    }

    try {
      await this.runVectorScript([
        'sync',
        '--index-root',
        this.indexRoot,
        '--candidates-file',
        this.vectorCandidatesPath,
        '--json',
      ])
    } catch {
      this.vectorScriptEnabled = false
    }
  }

  private async searchVectorIndex(
    cue: string,
    topK: number,
    candidates: HybridSearchCandidate[],
  ): Promise<Map<string, number>> {
    if (candidates.length < MIN_EXTERNAL_VECTOR_SCRIPT_CANDIDATES) {
      return computeLocalVectorScores(
        candidates.map((candidate) => ({ id: candidate.id, corpus: candidate.corpus })),
        cue,
        topK,
      )
    }

    const candidateIds = new Set(candidates.map((candidate) => candidate.id))

    if (await this.canUseVectorScript()) {
      try {
        const stdout = await this.runVectorScript([
          'search',
          '--index-root',
          this.indexRoot,
          '--top-k',
          String(Math.max(1, topK)),
          '--query',
          cue,
          '--json',
        ])

        const parsed = parseVectorSearchResults(stdout)
        const rawScores = new Map<string, number>()
        for (const hit of parsed) {
          if (!candidateIds.has(hit.id)) continue
          rawScores.set(hit.id, Math.max(0, hit.score))
        }

        if (rawScores.size > 0) {
          return normalizeScoreMap(rawScores)
        }
      } catch {
        this.vectorScriptEnabled = false
      }
    }

    return computeLocalVectorScores(
      candidates.map((candidate) => ({ id: candidate.id, corpus: candidate.corpus })),
      cue,
      topK,
    )
  }

  private async canUseVectorScript(): Promise<boolean> {
    if (this.vectorScriptEnabled !== null) {
      return this.vectorScriptEnabled
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim()
    if (!apiKey) {
      this.vectorScriptEnabled = false
      return false
    }

    try {
      await access(MEMORY_VECTOR_INDEX_SCRIPT_PATH)
      this.vectorScriptEnabled = true
      return true
    } catch {
      this.vectorScriptEnabled = false
      return false
    }
  }

  private async runVectorScript(args: string[]): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY?.trim()
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not found in environment')
    }

    const result = await execFileAsync(
      'python3',
      [MEMORY_VECTOR_INDEX_SCRIPT_PATH, ...args],
      {
        env: {
          ...process.env,
          GEMINI_API_KEY: apiKey,
        },
        maxBuffer: MAX_VECTOR_SCRIPT_BUFFER,
      },
    )

    return result.stdout
  }

  private async searchTranscriptHits(cue: string, topK: number): Promise<RecollectionHit[]> {
    try {
      const hits = await this.transcriptSearch(cue, topK)
      return hits.map((hit) => this.toTranscriptHit(hit))
    } catch {
      return []
    }
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
      attribution: candidate.type,
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

  private toTranscriptHit(hit: TranscriptSearchHit): RecollectionHit {
    const datePrefix = hit.timestamp ? hit.timestamp.slice(0, 10) : hit.transcriptId
    return {
      id: `transcript:${hit.transcriptId}:${hit.turnNumber}:${hit.messageIndex}`,
      type: 'transcript',
      attribution: `transcript: ${datePrefix} turn ${hit.turnNumber}`,
      title: safeSnippet(hit.text, 80),
      excerpt: safeSnippet(hit.text),
      score: Number(hit.score.toFixed(3)),
      reason: `semantic ${hit.score.toFixed(3)}`,
      stale: false,
      staleReason: null,
      path: hit.sourceFile,
      repo: null,
      issueNumber: null,
      salience: null,
    }
  }
}

export function createCommanderMemoryRecollection(
  commanderId: string,
  basePath?: string,
  options: RecollectionOptions = {},
): MemoryRecollection {
  const transcriptSearch = options.transcriptSearch ?? ((query: string, topK: number) =>
    searchCommanderTranscriptIndex(query, topK, {
      commanderId,
      basePath,
    }))

  return new MemoryRecollection(commanderId, basePath, {
    ...options,
    transcriptSearch,
  })
}

export async function syncCommanderMemoryHybridIndex(
  commanderId: string,
  basePath?: string,
  options: RecollectionOptions = {},
): Promise<void> {
  const recollection = createCommanderMemoryRecollection(commanderId, basePath, options)
  await recollection.refreshHybridIndex()
}
