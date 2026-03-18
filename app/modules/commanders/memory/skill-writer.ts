import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveCommanderPaths } from '../paths.js'

export interface SkillManifest {
  name: string
  description: string
  autoMatch: { labels: string[]; keywords: string[] }
  source: 'consolidation' | 'manual'
  frequency: number
  lastSeen: string
}

export interface SkillCreateInput {
  name: string
  title: string
  description: string
  whenToApply: string
  procedure: string
  sourceEpisodes: string[]
  pitfalls: string[]
  autoMatch: { labels: string[]; keywords: string[] }
  frequency: number
  lastSeen: string
  source?: 'consolidation' | 'manual'
}

export interface SkillUpdateInput {
  name: string
  title: string
  description: string
  whenToApply: string
  procedure: string
  sourceEpisodes: string[]
  pitfalls: string[]
  autoMatch: { labels: string[]; keywords: string[] }
  lastSeen: string
}

interface ParsedSkillDocument {
  manifest: SkillManifest
  title: string
  whenToApply: string
  procedure: string
  knownPitfalls: string[]
  sourceEpisodes: string[]
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export class SkillWriter {
  private readonly memoryRoot: string
  private readonly skillsRoot: string

  constructor(commanderId: string, basePath?: string) {
    const resolved = resolveCommanderPaths(commanderId, basePath)
    this.memoryRoot = resolved.memoryRoot
    this.skillsRoot = resolved.skillsRoot
  }

  async loadSkillManifests(): Promise<SkillManifest[]> {
    const skillsDir = this._skillsDir()
    let entries: Dirent<string>[]

    try {
      entries = await readdir(skillsDir, { withFileTypes: true })
    } catch {
      return []
    }

    const manifests: SkillManifest[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      try {
        const skillPath = this._skillPath(entry.name)
        const content = await readFile(skillPath, 'utf-8')
        const parsed = this._parseSkillDocument(content, entry.name)
        manifests.push(parsed.manifest)
      } catch {
        // Skip malformed skills and continue loading others.
      }
    }

    manifests.sort((a, b) => a.name.localeCompare(b.name))
    return manifests
  }

  async createSkill(input: SkillCreateInput): Promise<void> {
    const skillName = this._validateSkillName(input.name)
    const skillPath = this._skillPath(skillName)

    await mkdir(path.dirname(skillPath), { recursive: true })

    const content = this._renderSkillDocument({
      manifest: {
        name: skillName,
        description: input.description.trim(),
        autoMatch: {
          labels: this._dedupe(input.autoMatch.labels),
          keywords: this._dedupe(input.autoMatch.keywords),
        },
        source: input.source ?? 'consolidation',
        frequency: Math.max(0, Math.floor(input.frequency)),
        lastSeen: input.lastSeen.trim(),
      },
      title: input.title.trim() || this._toTitleCase(skillName),
      whenToApply: input.whenToApply.trim(),
      procedure: input.procedure.trim(),
      knownPitfalls: this._dedupe(input.pitfalls),
      sourceEpisodes: this._dedupe(input.sourceEpisodes),
    })

    await this._writeAtomic(skillPath, content)
    await this._syncMemorySkillIndex()
  }

  /**
   * Updates an existing consolidation skill while preserving hand-tuned Procedure steps.
   */
  async updateSkill(input: SkillUpdateInput): Promise<void> {
    const skillName = this._validateSkillName(input.name)
    const skillPath = this._skillPath(skillName)

    let existingContent = ''
    try {
      existingContent = await readFile(skillPath, 'utf-8')
    } catch {
      throw new Error(`Skill not found for update: ${skillName}`)
    }

    const existing = this._parseSkillDocument(existingContent, skillName)
    const mergedEpisodes = this._mergeUnique(existing.sourceEpisodes, input.sourceEpisodes)
    const mergedPitfalls = this._mergeUnique(existing.knownPitfalls, input.pitfalls)

    const nextFrequency =
      existing.manifest.frequency + Math.max(mergedEpisodes.added, 1)

    const content = this._renderSkillDocument({
      manifest: {
        name: existing.manifest.name,
        description: input.description.trim() || existing.manifest.description,
        autoMatch: {
          labels: this._mergeUnique(
            existing.manifest.autoMatch.labels,
            input.autoMatch.labels,
          ).values,
          keywords: this._mergeUnique(
            existing.manifest.autoMatch.keywords,
            input.autoMatch.keywords,
          ).values,
        },
        source: existing.manifest.source,
        frequency: nextFrequency,
        lastSeen: input.lastSeen.trim() || existing.manifest.lastSeen,
      },
      title: existing.title || input.title.trim() || this._toTitleCase(skillName),
      whenToApply: input.whenToApply.trim() || existing.whenToApply,
      procedure: existing.procedure.trim() || input.procedure.trim(),
      knownPitfalls: mergedPitfalls.values,
      sourceEpisodes: mergedEpisodes.values,
    })

    await this._writeAtomic(skillPath, content)
    await this._syncMemorySkillIndex()
  }

  private _skillsDir(): string {
    return this.skillsRoot
  }

  private _skillPath(skillName: string): string {
    return path.join(this._skillsDir(), skillName, 'SKILL.md')
  }

  private _validateSkillName(raw: string): string {
    const normalized = raw.trim().toLowerCase()
    if (!SKILL_NAME_PATTERN.test(normalized)) {
      throw new Error(`Invalid skill name: "${raw}"`)
    }
    return normalized
  }

  private _parseSkillDocument(content: string, fallbackName: string): ParsedSkillDocument {
    const { frontmatter, body } = this._splitFrontmatter(content)
    const parsedFrontmatter = this._parseFrontmatter(frontmatter)

    const manifest: SkillManifest = {
      name: this._validateSkillName(
        typeof parsedFrontmatter.name === 'string' && parsedFrontmatter.name
          ? parsedFrontmatter.name
          : fallbackName,
      ),
      description:
        typeof parsedFrontmatter.description === 'string'
          ? parsedFrontmatter.description
          : '',
      autoMatch: {
        labels: parsedFrontmatter.autoMatch?.labels ?? [],
        keywords: parsedFrontmatter.autoMatch?.keywords ?? [],
      },
      source:
        parsedFrontmatter.source === 'consolidation' ? 'consolidation' : 'manual',
      frequency:
        typeof parsedFrontmatter.frequency === 'number'
          ? parsedFrontmatter.frequency
          : 0,
      lastSeen:
        typeof parsedFrontmatter.lastSeen === 'string'
          ? parsedFrontmatter.lastSeen
          : '',
    }

    return {
      manifest,
      title: this._extractTitle(body) ?? this._toTitleCase(manifest.name),
      whenToApply: this._extractSection(body, 'When to Apply')?.trim() ?? '',
      procedure: this._extractSection(body, 'Procedure')?.trim() ?? '',
      knownPitfalls: this._extractList(this._extractSection(body, 'Known Pitfalls') ?? ''),
      sourceEpisodes: this._extractList(this._extractSection(body, 'Source Episodes') ?? ''),
    }
  }

  private _splitFrontmatter(content: string): { frontmatter: string; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    if (!match) {
      return { frontmatter: '', body: content }
    }

    return {
      frontmatter: match[1],
      body: match[2],
    }
  }

  private _parseFrontmatter(frontmatter: string): {
    name?: string
    description?: string
    source?: string
    frequency?: number
    lastSeen?: string
    autoMatch?: { labels: string[]; keywords: string[] }
  } {
    const result: {
      name?: string
      description?: string
      source?: string
      frequency?: number
      lastSeen?: string
      autoMatch?: { labels: string[]; keywords: string[] }
    } = {}

    if (!frontmatter.trim()) return result

    const lines = frontmatter.split('\n')
    let inAutoMatch = false

    for (const rawLine of lines) {
      if (!rawLine.trim()) continue

      const isIndented = /^\s+/.test(rawLine)
      const line = rawLine.trim()

      if (!isIndented && line === 'auto-match:') {
        inAutoMatch = true
        if (!result.autoMatch) {
          result.autoMatch = { labels: [], keywords: [] }
        }
        continue
      }

      if (!isIndented) {
        inAutoMatch = false
        const [key, value] = this._splitKeyValue(line)
        if (!key) continue

        switch (key) {
          case 'name':
            result.name = this._stripQuotes(value)
            break
          case 'description':
            result.description = this._stripQuotes(value)
            break
          case 'source':
            result.source = this._stripQuotes(value)
            break
          case 'frequency': {
            const parsed = Number.parseInt(this._stripQuotes(value), 10)
            if (Number.isFinite(parsed)) {
              result.frequency = parsed
            }
            break
          }
          case 'last-seen':
            result.lastSeen = this._stripQuotes(value)
            break
          default:
            break
        }
        continue
      }

      if (inAutoMatch && result.autoMatch) {
        const [key, value] = this._splitKeyValue(line)
        if (!key) continue

        if (key === 'labels') {
          result.autoMatch.labels = this._parseInlineArray(value)
        } else if (key === 'keywords') {
          result.autoMatch.keywords = this._parseInlineArray(value)
        }
      }
    }

    return result
  }

  private _splitKeyValue(line: string): [string, string] {
    const idx = line.indexOf(':')
    if (idx === -1) return ['', '']
    return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()]
  }

  private _stripQuotes(value: string): string {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1)
    }
    return value
  }

  private _parseInlineArray(raw: string): string[] {
    const value = raw.trim()
    if (!value.startsWith('[') || !value.endsWith(']')) {
      return []
    }

    const inner = value.slice(1, -1).trim()
    if (!inner) return []

    return this._dedupe(
      inner
        .split(',')
        .map((item) => this._stripQuotes(item.trim()))
        .filter(Boolean),
    )
  }

  private _extractTitle(body: string): string | null {
    const match = body.match(/^#\s+(.+)$/m)
    return match ? match[1].trim() : null
  }

  private _extractSection(body: string, sectionName: string): string | null {
    const sectionHeader = `## ${sectionName}`
    const sectionStart = body.indexOf(sectionHeader)
    if (sectionStart === -1) return null

    const contentStart = body.indexOf('\n', sectionStart)
    if (contentStart === -1) return ''

    const remaining = body.slice(contentStart + 1)
    const nextSection = remaining.indexOf('\n## ')
    if (nextSection === -1) return remaining

    return remaining.slice(0, nextSection)
  }

  private _extractList(sectionContent: string): string[] {
    return this._dedupe(
      sectionContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).trim())
        .filter(Boolean),
    )
  }

  private _renderSkillDocument(input: ParsedSkillDocument): string {
    const frequency = Math.max(0, Math.floor(input.manifest.frequency))
    const lastSeen = input.manifest.lastSeen.trim()
    const episodeCount = input.sourceEpisodes.length

    const sourceEpisodeLines =
      input.sourceEpisodes.length > 0
        ? input.sourceEpisodes.map((episode) => `- ${episode}`)
        : ['- None recorded yet.']

    const pitfallLines =
      input.knownPitfalls.length > 0
        ? input.knownPitfalls.map((pitfall) => `- ${pitfall}`)
        : ['- None recorded yet.']

    const lines: string[] = [
      '---',
      `name: ${input.manifest.name}`,
      `description: ${this._quoteYamlString(input.manifest.description)}`,
      'user-invocable: false',
      'auto-match:',
      `  labels: ${this._formatInlineArray(input.manifest.autoMatch.labels)}`,
      `  keywords: ${this._formatInlineArray(input.manifest.autoMatch.keywords)}`,
      `source: ${input.manifest.source}`,
      `frequency: ${frequency}`,
      `last-seen: ${lastSeen}`,
      '---',
      '',
      `# ${input.title.trim() || this._toTitleCase(input.manifest.name)}`,
      '',
      `Pattern detected across ${episodeCount} similar episodes.`,
      '',
      '## When to Apply',
      '',
      input.whenToApply.trim() || 'Apply this skill when the same failure pattern appears again.',
      '',
      '## Procedure',
      '',
      input.procedure.trim() || '1. Reconstruct the prior successful steps from source episodes.',
      '',
      '## Known Pitfalls',
      '',
      ...pitfallLines,
      '',
      '## Source Episodes',
      '',
      ...sourceEpisodeLines,
      '',
    ]

    return lines.join('\n')
  }

  private _quoteYamlString(value: string): string {
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    return `"${escaped}"`
  }

  private _formatInlineArray(values: string[]): string {
    if (values.length === 0) return '[]'
    return `[${values.map((value) => this._quoteYamlString(value)).join(', ')}]`
  }

  private _toTitleCase(slug: string): string {
    return slug
      .split('-')
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(' ')
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

  private _mergeUnique(existing: string[], incoming: string[]): { values: string[]; added: number } {
    const seen = new Set(existing.map((value) => value.trim().toLowerCase()).filter(Boolean))
    const values = this._dedupe(existing)
    let added = 0

    for (const raw of incoming) {
      const value = raw.trim()
      if (!value) continue
      const key = value.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      values.push(value)
      added += 1
    }

    return { values, added }
  }

  private async _syncMemorySkillIndex(): Promise<void> {
    const manifests = await this.loadSkillManifests()
    const memoryPath = path.join(this.memoryRoot, 'MEMORY.md')
    const section = this._renderMemorySkillIndexSection(manifests.map((manifest) => manifest.name))

    let existing = '# Commander Memory\n\n'
    try {
      existing = await readFile(memoryPath, 'utf-8')
    } catch {
      // Keep default header.
    }

    const sectionPattern = /## Skill Index\s*\n[\s\S]*?<!--\s*commander-skill-index:end\s*-->\s*/m
    const next = sectionPattern.test(existing)
      ? existing.replace(sectionPattern, `${section}\n\n`)
      : `${existing.trimEnd()}\n\n${section}\n`

    if (next === existing) {
      return
    }

    await mkdir(this.memoryRoot, { recursive: true })
    await writeFile(memoryPath, next, 'utf-8')
  }

  private _renderMemorySkillIndexSection(skillNames: string[]): string {
    const lines = skillNames.length > 0
      ? skillNames
          .sort((left, right) => left.localeCompare(right))
          .map((name) => `- \`${name}\` -> \`../skills/${name}/SKILL.md\``)
      : ['- _No skills cataloged yet._']

    return [
      '## Skill Index',
      '<!-- commander-skill-index:start -->',
      ...lines,
      '<!-- commander-skill-index:end -->',
    ].join('\n')
  }

  private async _writeAtomic(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath)
    await mkdir(dir, { recursive: true })

    const tempFilePath = path.join(
      dir,
      `SKILL.md.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )

    await writeFile(tempFilePath, content, 'utf-8')
    await rename(tempFilePath, filePath)
  }
}
