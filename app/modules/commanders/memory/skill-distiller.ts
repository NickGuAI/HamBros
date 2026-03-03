import type { JournalEntry } from './types.js'
import { SkillWriter, type SkillManifest } from './skill-writer.js'

const MIN_SKILL_FREQUENCY = 3

export interface ParsedDebrief {
  timestamp?: string
  issueNumber?: number | null
  sustain?: string[]
  sustainItems?: string[]
  doctrineUpdates?: string[]
  doctrine?: string[]
}

export interface DistillerInput {
  journalEntries: JournalEntry[]
  parsedDebriefs: ParsedDebrief[]
}

export interface DistillerReport {
  skillsCreated: string[]
  skillsUpdated: string[]
  patternsDetected: number
  patternsBelowThreshold: number
}

export interface PatternEpisode {
  id?: string
  issueNumber?: number | null
  summary: string
  date?: string
}

export interface DistilledPattern {
  id: string
  name: string
  triggers: string[]
  steps: string[]
  sourceEpisodes: PatternEpisode[]
  confidence: number
  frequency?: number
  pitfalls?: string[]
  labels?: string[]
  keywords?: string[]
  whenToApply?: string
  description?: string
}

export interface SkillDistillerOptions {
  basePath?: string
  now?: () => Date
  model?: string
  detectPatterns?: (input: DistillerInput) => Promise<DistilledPattern[]>
}

interface ClaudeQueryMessageTextBlock {
  type?: unknown
  text?: unknown
}

interface ClaudeQueryMessage {
  type?: unknown
  message?: {
    content?: ClaudeQueryMessageTextBlock[]
  }
  content_block?: {
    type?: unknown
    text?: unknown
  }
  delta?: {
    text?: unknown
  }
  result?: unknown
}

export class SkillDistiller {
  private readonly writer: SkillWriter
  private readonly now: () => Date
  private readonly model?: string
  private readonly detectPatternsImpl: (input: DistillerInput) => Promise<DistilledPattern[]>

  constructor(
    commanderId: string,
    options: SkillDistillerOptions = {},
  ) {
    this.writer = new SkillWriter(commanderId, options.basePath)
    this.now = options.now ?? (() => new Date())
    this.model = options.model
    this.detectPatternsImpl = options.detectPatterns ?? ((input) => this._detectPatternsViaLlm(input))
  }

  async run(input: DistillerInput): Promise<DistillerReport> {
    const detectedPatterns = await this.detectPatternsImpl(input)
    const patterns = detectedPatterns.map((pattern) => this._normalizePattern(pattern)).filter(Boolean)

    const existingSkills = await this.loadExistingSkills()
    const existingByName = new Map(existingSkills.map((skill) => [skill.name, skill]))

    const skillsCreated: string[] = []
    const skillsUpdated: string[] = []
    let patternsBelowThreshold = 0

    for (const pattern of patterns) {
      if (!pattern) continue

      const frequency = this._resolveFrequency(pattern)
      if (frequency < MIN_SKILL_FREQUENCY) {
        patternsBelowThreshold += 1
        continue
      }

      const skillName = this._toSkillName(pattern.id || pattern.name)
      const episodes = this._dedupe(this._buildEpisodeLines(pattern.sourceEpisodes))
      const pitfalls = this._dedupe(pattern.pitfalls ?? [])
      const autoMatch = this._buildAutoMatch(pattern)
      const lastSeen = this.now().toISOString().slice(0, 10)
      const title = this._toHeading(pattern.name || skillName)

      const skillInput = {
        name: skillName,
        title,
        description: this._buildDescription(pattern, skillName),
        whenToApply: this._buildWhenToApply(pattern),
        procedure: this._formatProcedure(pattern.steps),
        sourceEpisodes: episodes,
        pitfalls,
        autoMatch,
        lastSeen,
      }

      if (existingByName.has(skillName)) {
        await this.writer.updateSkill(skillInput)
        skillsUpdated.push(skillName)
        continue
      }

      await this.writer.createSkill({
        ...skillInput,
        frequency,
        source: 'consolidation',
      })
      skillsCreated.push(skillName)
      existingByName.set(skillName, {
        name: skillName,
        description: skillInput.description,
        autoMatch,
        source: 'consolidation',
        frequency,
        lastSeen,
      })
    }

    return {
      skillsCreated,
      skillsUpdated,
      patternsDetected: patterns.length,
      patternsBelowThreshold,
    }
  }

  async loadExistingSkills(): Promise<SkillManifest[]> {
    return this.writer.loadSkillManifests()
  }

  private async _detectPatternsViaLlm(input: DistillerInput): Promise<DistilledPattern[]> {
    if (input.journalEntries.length === 0 && input.parsedDebriefs.length === 0) {
      return []
    }

    const prompt = this._buildPrompt(input)

    let sdkModule: unknown
    try {
      sdkModule = await import('@anthropic-ai/claude-agent-sdk')
    } catch (error) {
      throw new Error(
        `Failed to load @anthropic-ai/claude-agent-sdk for pattern detection: ${String(error)}`,
      )
    }

    const query = (sdkModule as {
      query?: (input: {
        prompt: string
        options?: Record<string, unknown>
      }) => AsyncIterable<unknown>
    }).query

    if (typeof query !== 'function') {
      throw new Error('Claude Agent SDK did not expose a query() function')
    }

    const stream = query({
      prompt,
      options: {
        cwd: process.cwd(),
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        ...(this.model ? { model: this.model } : {}),
      },
    })

    let rawText = ''
    for await (const message of stream) {
      rawText += this._extractTextFromClaudeMessage(message)
    }

    const parsed = this._parsePatternArray(rawText)
    return parsed
      .map((entry, index) => this._coercePattern(entry, index))
      .filter((entry): entry is DistilledPattern => Boolean(entry))
  }

  private _buildPrompt(input: DistillerInput): string {
    const payload = {
      journalEntries: input.journalEntries.map((entry) => ({
        timestamp: entry.timestamp,
        issueNumber: entry.issueNumber,
        repo: entry.repo,
        outcome: entry.outcome,
        salience: entry.salience,
        body: entry.body,
      })),
      parsedDebriefs: input.parsedDebriefs.map((debrief) => ({
        timestamp: debrief.timestamp ?? '',
        issueNumber: debrief.issueNumber ?? null,
        sustain: this._coerceStringArray(debrief.sustain ?? debrief.sustainItems ?? []),
        doctrineUpdates: this._coerceStringArray(debrief.doctrineUpdates ?? debrief.doctrine ?? []),
      })),
    }

    return [
      'You are identifying reusable execution skills from commander memory data.',
      'Analyze the inputs and find recurring action patterns (intent-level, not exact phrase matching).',
      'A valid pattern should represent a procedure that repeats across journal entries and/or debrief sustain/doctrine sections.',
      'Return ONLY JSON, no prose and no markdown fences.',
      'JSON schema:',
      '[{',
      '  "id": "kebab-case-id",',
      '  "name": "Human Readable Name",',
      '  "triggers": ["when this applies"],',
      '  "steps": ["step 1", "step 2"],',
      '  "sourceEpisodes": [{"issueNumber": 123, "summary": "...", "date": "YYYY-MM-DD"}],',
      '  "confidence": 0.0,',
      '  "frequency": 3,',
      '  "pitfalls": ["common mistake"],',
      '  "labels": ["bug", "auth"],',
      '  "keywords": ["token", "refresh"],',
      '  "whenToApply": "Short applicability sentence",',
      '  "description": "One sentence summary"',
      '}]',
      '',
      'Input data:',
      JSON.stringify(payload, null, 2),
    ].join('\n')
  }

  private _extractTextFromClaudeMessage(rawMessage: unknown): string {
    const message = rawMessage as ClaudeQueryMessage
    const chunks: string[] = []

    if (message.type === 'assistant') {
      const blocks = Array.isArray(message.message?.content) ? message.message?.content : []
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          chunks.push(block.text)
        }
      }
    }

    if (message.type === 'content_block_delta' && typeof message.delta?.text === 'string') {
      chunks.push(message.delta.text)
    }

    if (message.type === 'content_block_start' && message.content_block?.type === 'text') {
      if (typeof message.content_block.text === 'string') {
        chunks.push(message.content_block.text)
      }
    }

    if (message.type === 'result' && typeof message.result === 'string') {
      chunks.push(message.result)
    }

    return chunks.join('')
  }

  private _parsePatternArray(rawText: string): unknown[] {
    const candidates: string[] = []

    const fencedBlocks = [...rawText.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    for (const block of fencedBlocks) {
      if (typeof block[1] === 'string' && block[1].trim()) {
        candidates.push(block[1].trim())
      }
    }

    const firstBracket = rawText.indexOf('[')
    const lastBracket = rawText.lastIndexOf(']')
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      candidates.push(rawText.slice(firstBracket, lastBracket + 1).trim())
    }

    candidates.push(rawText.trim())

    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        const parsed = JSON.parse(candidate)
        if (Array.isArray(parsed)) {
          return parsed
        }
      } catch {
        // Try next candidate.
      }
    }

    throw new Error('Pattern detector returned non-JSON output')
  }

  private _coercePattern(raw: unknown, index: number): DistilledPattern | null {
    if (!raw || typeof raw !== 'object') {
      return null
    }

    const value = raw as Record<string, unknown>

    const name = this._asNonEmptyString(value.name)
    const id = this._toSkillName(this._asNonEmptyString(value.id) ?? name ?? `pattern-${index + 1}`)

    const sourceEpisodesRaw = Array.isArray(value.sourceEpisodes) ? value.sourceEpisodes : []
    const sourceEpisodes = sourceEpisodesRaw
      .map((episode) => this._coerceEpisode(episode))
      .filter((episode): episode is PatternEpisode => Boolean(episode))

    return {
      id,
      name: name ?? this._toHeading(id),
      triggers: this._coerceStringArray(value.triggers),
      steps: this._coerceStringArray(value.steps),
      sourceEpisodes,
      confidence: this._asNumber(value.confidence) ?? 0,
      frequency: this._asNumber(value.frequency) ?? undefined,
      pitfalls: this._coerceStringArray(value.pitfalls),
      labels: this._coerceStringArray(value.labels),
      keywords: this._coerceStringArray(value.keywords),
      whenToApply: this._asNonEmptyString(value.whenToApply),
      description: this._asNonEmptyString(value.description),
    }
  }

  private _coerceEpisode(raw: unknown): PatternEpisode | null {
    if (typeof raw === 'string') {
      const summary = raw.trim()
      if (!summary) return null
      return { summary }
    }

    if (!raw || typeof raw !== 'object') {
      return null
    }

    const value = raw as Record<string, unknown>
    const summary =
      this._asNonEmptyString(value.summary) ??
      this._asNonEmptyString(value.body) ??
      this._asNonEmptyString(value.outcome)

    if (!summary) return null

    return {
      id: this._asNonEmptyString(value.id),
      issueNumber: this._asNumber(value.issueNumber) ?? this._asNumber(value.issue) ?? null,
      summary,
      date: this._normalizeDateString(this._asNonEmptyString(value.date) ?? this._asNonEmptyString(value.timestamp)),
    }
  }

  private _resolveFrequency(pattern: DistilledPattern): number {
    const fromPattern = typeof pattern.frequency === 'number' ? Math.floor(pattern.frequency) : 0
    if (fromPattern > 0) {
      return fromPattern
    }
    return pattern.sourceEpisodes.length
  }

  private _buildDescription(pattern: DistilledPattern, skillName: string): string {
    if (pattern.description && pattern.description.trim().length > 0) {
      return pattern.description.trim()
    }

    const triggerText = pattern.triggers[0]
    if (triggerText) {
      return `Handle recurring pattern: ${triggerText}`
    }

    return `Reusable procedure for ${this._toHeading(skillName)}`
  }

  private _buildWhenToApply(pattern: DistilledPattern): string {
    if (pattern.whenToApply && pattern.whenToApply.trim().length > 0) {
      return pattern.whenToApply.trim()
    }

    if (pattern.triggers.length > 0) {
      return `Apply when: ${pattern.triggers.join('; ')}`
    }

    return 'Apply when the same problem pattern appears in multiple episodes.'
  }

  private _formatProcedure(steps: string[]): string {
    const cleanedSteps = this._dedupe(steps)
    if (cleanedSteps.length === 0) {
      return '1. Reconstruct the winning sequence from source episodes.\n2. Apply the sequence in the current issue.\n3. Verify outcome and add a regression check.'
    }

    return cleanedSteps.map((step, index) => `${index + 1}. ${step}`).join('\n')
  }

  private _buildAutoMatch(pattern: DistilledPattern): { labels: string[]; keywords: string[] } {
    const explicitLabels = this._dedupe(pattern.labels ?? [])
    const explicitKeywords = this._dedupe(pattern.keywords ?? [])

    const derivedTokens = this._dedupe(
      [pattern.name, ...pattern.triggers]
        .flatMap((value) => value.split(/[^a-zA-Z0-9]+/g))
        .map((token) => token.toLowerCase())
        .filter((token) => token.length >= 3),
    )

    const labels = explicitLabels.length > 0 ? explicitLabels : derivedTokens.slice(0, 3)
    const keywords =
      explicitKeywords.length > 0 ? explicitKeywords : derivedTokens.slice(0, 8)

    return {
      labels,
      keywords,
    }
  }

  private _buildEpisodeLines(episodes: PatternEpisode[]): string[] {
    return episodes
      .map((episode) => {
        const summary = episode.summary.trim()
        if (!summary) return ''

        const dateSuffix = episode.date ? ` (${episode.date})` : ''

        if (episode.issueNumber != null) {
          return `Issue #${episode.issueNumber}: ${summary}${dateSuffix}`
        }

        if (episode.id) {
          return `${episode.id}: ${summary}${dateSuffix}`
        }

        return `${summary}${dateSuffix}`
      })
      .filter(Boolean)
  }

  private _normalizePattern(pattern: DistilledPattern): DistilledPattern | null {
    const skillName = this._toSkillName(pattern.id || pattern.name)
    if (!skillName) return null

    return {
      ...pattern,
      id: skillName,
      name: pattern.name?.trim() || this._toHeading(skillName),
      triggers: this._dedupe(pattern.triggers ?? []),
      steps: this._dedupe(pattern.steps ?? []),
      sourceEpisodes: pattern.sourceEpisodes ?? [],
      pitfalls: this._dedupe(pattern.pitfalls ?? []),
      labels: this._dedupe(pattern.labels ?? []),
      keywords: this._dedupe(pattern.keywords ?? []),
      whenToApply: pattern.whenToApply?.trim(),
      description: pattern.description?.trim(),
    }
  }

  private _toSkillName(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  private _toHeading(value: string): string {
    return value
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
      .join(' ')
  }

  private _asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  private _asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10)
      if (Number.isFinite(parsed)) return parsed
    }
    return undefined
  }

  private _coerceStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return this._dedupe(
      value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean),
    )
  }

  private _normalizeDateString(value: string | undefined): string | undefined {
    if (!value) return undefined
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value

    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return undefined
    return parsed.toISOString().slice(0, 10)
  }

  private _dedupe(values: string[]): string[] {
    const result: string[] = []
    const seen = new Set<string>()

    for (const raw of values) {
      const value = raw.trim()
      if (!value) continue

      const key = value.toLowerCase()
      if (seen.has(key)) continue

      seen.add(key)
      result.push(value)
    }

    return result
  }
}
