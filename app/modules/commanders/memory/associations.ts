import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { JournalEntry } from './types.js'
import { resolveCommanderPaths } from '../paths.js'

const GRAPH_VERSION = 1
const TOKEN_MIN_LENGTH = 3
const MAX_CONCEPT_TOKENS = 24
const STALE_STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'before',
  'being',
  'build',
  'during',
  'from',
  'have',
  'issue',
  'only',
  'over',
  'should',
  'this',
  'that',
  'their',
  'there',
  'these',
  'those',
  'through',
  'under',
  'with',
  'without',
])

export type AssociationNodeKind = 'journal' | 'skill' | 'memory' | 'concept'
export type AssociationEdgeKind = 'repo' | 'issue' | 'keyword' | 'label' | 'salience'

export interface AssociationNode {
  id: string
  kind: AssociationNodeKind
  label: string
  createdAt: string
  updatedAt: string
  lastSeen: string | null
  seenCount: number
  meta?: Record<string, string | number | boolean | null>
}

export interface AssociationEdge {
  from: string
  to: string
  kind: AssociationEdgeKind
  weight: number
  updatedAt: string
}

export interface AssociationGraph {
  version: number
  nodes: Record<string, AssociationNode>
  edges: AssociationEdge[]
}

export interface AssociationCue {
  text: string
  repo?: string | null
  issueNumber?: number | null
}

export interface SkillAssociationInput {
  name: string
  path: string
  description: string
  labels?: string[]
  keywords?: string[]
  lastSeen?: string
}

interface AssociationStoreOptions {
  now?: () => Date
}

function compactText(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function safeSlug(input: string): string {
  const compacted = compactText(input).toLowerCase()
  return compacted
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function tokenize(input: string): string[] {
  const tokens = input.toLowerCase().match(/[a-z0-9._-]+/g) ?? []
  const unique: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token.length < TOKEN_MIN_LENGTH) continue
    if (STALE_STOPWORDS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    unique.push(token)
    if (unique.length >= MAX_CONCEPT_TOKENS) break
  }
  return unique
}

function edgeKey(edge: Pick<AssociationEdge, 'from' | 'to' | 'kind'>): string {
  return `${edge.from}::${edge.to}::${edge.kind}`
}

function toConceptNodeId(kind: 'repo' | 'issue' | 'keyword' | 'label' | 'salience', value: string): string {
  return `concept:${kind}:${safeSlug(value)}`
}

export function toJournalNodeId(entry: JournalEntry): string {
  return `journal:${safeSlug(entry.timestamp)}:${safeSlug(entry.outcome)}`
}

export function toSkillNodeId(skillName: string): string {
  return `skill:${safeSlug(skillName)}`
}

function defaultGraph(): AssociationGraph {
  return {
    version: GRAPH_VERSION,
    nodes: {},
    edges: [],
  }
}

function parseRepoFromText(text: string): string | null {
  const match = text.match(/\b([a-z0-9._-]+\/[a-z0-9._-]+)\b/i)
  return match?.[1] ? match[1].toLowerCase() : null
}

export class AssociationStore {
  private readonly memoryRoot: string
  private readonly graphPath: string
  private readonly now: () => Date

  constructor(
    commanderId: string,
    basePath?: string,
    options: AssociationStoreOptions = {},
  ) {
    this.memoryRoot = resolveCommanderPaths(commanderId, basePath).memoryRoot
    this.graphPath = path.join(this.memoryRoot, 'associations.json')
    this.now = options.now ?? (() => new Date())
  }

  async ensure(): Promise<void> {
    await mkdir(this.memoryRoot, { recursive: true })
    const graph = await this.readGraph()
    await this.writeGraph(graph)
  }

  async upsertJournalEntry(entry: JournalEntry): Promise<string> {
    const nowIso = this.now().toISOString()
    const nodeId = toJournalNodeId(entry)
    const graph = await this.readGraph()

    this.upsertNode(graph, {
      id: nodeId,
      kind: 'journal',
      label: compactText(entry.outcome) || 'journal-entry',
      createdAt: entry.timestamp || nowIso,
      updatedAt: nowIso,
      lastSeen: null,
      seenCount: 0,
      meta: {
        timestamp: entry.timestamp,
        repo: entry.repo,
        issueNumber: entry.issueNumber,
        salience: entry.salience,
      },
    })

    const cueConcepts = this.cueConceptIds({
      text: `${entry.outcome}\n${entry.body}`,
      repo: entry.repo,
      issueNumber: entry.issueNumber,
    })

    for (const conceptId of cueConcepts) {
      this.ensureConceptNode(graph, conceptId, nowIso)
      this.upsertEdge(graph, {
        from: nodeId,
        to: conceptId,
        kind: this.kindForConcept(conceptId),
        weight: conceptId.startsWith('concept:issue:') ? 3 : conceptId.startsWith('concept:repo:') ? 2.5 : 1,
        updatedAt: nowIso,
      })
    }

    const salienceConcept = toConceptNodeId('salience', entry.salience.toLowerCase())
    this.ensureConceptNode(graph, salienceConcept, nowIso)
    this.upsertEdge(graph, {
      from: nodeId,
      to: salienceConcept,
      kind: 'salience',
      weight: 1.2,
      updatedAt: nowIso,
    })

    await this.writeGraph(graph)
    return nodeId
  }

  async upsertSkill(input: SkillAssociationInput): Promise<string> {
    const nowIso = this.now().toISOString()
    const nodeId = toSkillNodeId(input.name)
    const graph = await this.readGraph()
    const lastSeen = input.lastSeen?.trim() || toDateString(this.now())

    this.upsertNode(graph, {
      id: nodeId,
      kind: 'skill',
      label: input.name,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastSeen,
      seenCount: 0,
      meta: {
        path: input.path,
        description: compactText(input.description).slice(0, 240),
      },
    })

    const labelConcepts = (input.labels ?? []).map((label) => toConceptNodeId('label', label))
    const keywordConcepts = (input.keywords ?? []).map((keyword) => toConceptNodeId('keyword', keyword))
    const parsedRepo = parseRepoFromText(input.description)
    const repoConcepts = parsedRepo ? [toConceptNodeId('repo', parsedRepo)] : []
    const textConcepts = this.cueConceptIds({
      text: input.description,
      repo: parsedRepo,
      issueNumber: null,
    }).filter((conceptId) => conceptId.startsWith('concept:keyword:'))

    const concepts = [...new Set([...labelConcepts, ...keywordConcepts, ...repoConcepts, ...textConcepts])]
    for (const conceptId of concepts) {
      this.ensureConceptNode(graph, conceptId, nowIso)
      const kind = this.kindForConcept(conceptId)
      this.upsertEdge(graph, {
        from: nodeId,
        to: conceptId,
        kind,
        weight: kind === 'label' ? 2 : kind === 'repo' ? 1.5 : 1.1,
        updatedAt: nowIso,
      })
    }

    await this.writeGraph(graph)
    return nodeId
  }

  async touch(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return
    const graph = await this.readGraph()
    const seen = new Set<string>()
    const nowIso = this.now().toISOString()

    for (const nodeId of nodeIds) {
      if (seen.has(nodeId)) continue
      seen.add(nodeId)
      const node = graph.nodes[nodeId]
      if (!node) continue
      node.lastSeen = nowIso
      node.updatedAt = nowIso
      node.seenCount = Math.max(0, node.seenCount) + 1
    }

    await this.writeGraph(graph)
  }

  async scoreNodeForCue(nodeId: string, cue: AssociationCue): Promise<number> {
    const graph = await this.readGraph()
    return this.computeCueScore(graph, nodeId, cue)
  }

  async scoreNodesForCue(
    nodeIds: string[],
    cue: AssociationCue,
  ): Promise<Map<string, number>> {
    const graph = await this.readGraph()
    const scores = new Map<string, number>()
    for (const nodeId of nodeIds) {
      scores.set(nodeId, this.computeCueScore(graph, nodeId, cue))
    }
    return scores
  }

  async relatedNodeIdsForCue(cue: AssociationCue, limit: number = 24): Promise<string[]> {
    const graph = await this.readGraph()
    const concepts = new Set(this.cueConceptIds(cue))
    if (concepts.size === 0) return []

    const candidateScores = new Map<string, number>()

    for (const edge of graph.edges) {
      const cueConcept = concepts.has(edge.to)
      if (!cueConcept) continue
      const node = graph.nodes[edge.from]
      if (!node || node.kind === 'concept') continue
      candidateScores.set(edge.from, (candidateScores.get(edge.from) ?? 0) + edge.weight)
    }

    return [...candidateScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([nodeId]) => nodeId)
  }

  async getNode(nodeId: string): Promise<AssociationNode | null> {
    const graph = await this.readGraph()
    return graph.nodes[nodeId] ?? null
  }

  async getGraphSnapshot(): Promise<AssociationGraph> {
    return this.readGraph()
  }

  private computeCueScore(graph: AssociationGraph, nodeId: string, cue: AssociationCue): number {
    const cueConcepts = new Set(this.cueConceptIds(cue))
    if (cueConcepts.size === 0) return 0

    let score = 0
    for (const edge of graph.edges) {
      if (edge.from === nodeId && cueConcepts.has(edge.to)) {
        score += edge.weight
      }
      if (edge.to === nodeId && cueConcepts.has(edge.from)) {
        score += edge.weight
      }
    }
    return score
  }

  private cueConceptIds(cue: AssociationCue): string[] {
    const concepts: string[] = []
    const textTokens = tokenize(cue.text)
    for (const token of textTokens) {
      concepts.push(toConceptNodeId('keyword', token))
    }
    if (cue.repo && cue.repo.trim()) {
      concepts.push(toConceptNodeId('repo', cue.repo.toLowerCase()))
      const [owner, repo] = cue.repo.split('/')
      if (owner && repo) {
        concepts.push(toConceptNodeId('keyword', owner.toLowerCase()))
        concepts.push(toConceptNodeId('keyword', repo.toLowerCase()))
      }
    }
    if (cue.issueNumber != null && Number.isInteger(cue.issueNumber) && cue.issueNumber > 0) {
      concepts.push(toConceptNodeId('issue', String(cue.issueNumber)))
    }
    return [...new Set(concepts)]
  }

  private kindForConcept(conceptId: string): AssociationEdgeKind {
    if (conceptId.startsWith('concept:repo:')) return 'repo'
    if (conceptId.startsWith('concept:issue:')) return 'issue'
    if (conceptId.startsWith('concept:label:')) return 'label'
    if (conceptId.startsWith('concept:salience:')) return 'salience'
    return 'keyword'
  }

  private ensureConceptNode(
    graph: AssociationGraph,
    conceptId: string,
    nowIso: string,
  ): void {
    if (graph.nodes[conceptId]) return
    const [, , ...rawLabel] = conceptId.split(':')
    graph.nodes[conceptId] = {
      id: conceptId,
      kind: 'concept',
      label: rawLabel.join(':').replace(/-/g, ' '),
      createdAt: nowIso,
      updatedAt: nowIso,
      lastSeen: null,
      seenCount: 0,
    }
  }

  private upsertNode(graph: AssociationGraph, node: AssociationNode): void {
    const existing = graph.nodes[node.id]
    if (!existing) {
      graph.nodes[node.id] = node
      return
    }
    graph.nodes[node.id] = {
      ...existing,
      ...node,
      createdAt: existing.createdAt || node.createdAt,
      seenCount: Math.max(existing.seenCount ?? 0, node.seenCount ?? 0),
      meta: {
        ...(existing.meta ?? {}),
        ...(node.meta ?? {}),
      },
    }
  }

  private upsertEdge(graph: AssociationGraph, edge: AssociationEdge): void {
    const key = edgeKey(edge)
    const index = graph.edges.findIndex((candidate) => edgeKey(candidate) === key)
    if (index === -1) {
      graph.edges.push(edge)
      return
    }

    const existing = graph.edges[index]
    if (!existing) {
      graph.edges.push(edge)
      return
    }

    graph.edges[index] = {
      ...existing,
      weight: Math.max(existing.weight, edge.weight),
      updatedAt: edge.updatedAt,
    }
  }

  private async readGraph(): Promise<AssociationGraph> {
    try {
      const raw = await readFile(this.graphPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<AssociationGraph>
      if (!parsed || typeof parsed !== 'object') {
        return defaultGraph()
      }
      if (parsed.version !== GRAPH_VERSION) {
        return defaultGraph()
      }
      const nodes = parsed.nodes && typeof parsed.nodes === 'object'
        ? parsed.nodes as Record<string, AssociationNode>
        : {}
      const edges = Array.isArray(parsed.edges)
        ? parsed.edges.filter((edge) =>
          typeof edge?.from === 'string' &&
          typeof edge?.to === 'string' &&
          typeof edge?.kind === 'string' &&
          typeof edge?.weight === 'number')
        : []
      return {
        version: GRAPH_VERSION,
        nodes,
        edges,
      }
    } catch {
      return defaultGraph()
    }
  }

  private async writeGraph(graph: AssociationGraph): Promise<void> {
    await mkdir(this.memoryRoot, { recursive: true })
    await writeFile(this.graphPath, JSON.stringify(graph, null, 2), 'utf-8')
  }
}
