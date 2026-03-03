import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface ParsedDebrief {
  date: string
  sessionTopic: string
  doctrineUpdates: string[]
  sustainPatterns: string[]
  improveRootCauses: string[]
  evalCases: string[]
  risks: string[]
}

type SectionKey = 'doctrine' | 'sustain' | 'improve' | 'eval' | 'risks'

const SECTION_ALIASES: Record<SectionKey, string[]> = {
  doctrine: ['DOCTRINE UPDATES', 'DOCTRINE UPDATE', 'DOCTRINE'],
  sustain: ['SUSTAIN', 'SUSTAIN PATTERNS'],
  improve: ['IMPROVE', 'IMPROVEMENTS', 'IMPROVE ROOT CAUSES'],
  eval: ['EVAL UPDATES', 'EVAL UPDATE', 'EVAL', 'EVALUATION UPDATES'],
  risks: ['RISKS', 'RISK'],
}

function normalizeHeading(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sectionFromHeading(heading: string): SectionKey | null {
  const normalized = normalizeHeading(heading)
  const key = (Object.keys(SECTION_ALIASES) as SectionKey[]).find((candidate) =>
    SECTION_ALIASES[candidate].some((alias) => normalized === alias || normalized.startsWith(`${alias} `)),
  )
  return key ?? null
}

function cleanItem(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .replace(/^[-*>]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripLinePrefix(rawLine: string): string {
  return rawLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^>\s*/, '')
    .trim()
}

function parseSectionLine(
  rawLine: string,
): { section: SectionKey | null; inlineItem: string } | null {
  const stripped = stripLinePrefix(rawLine)
  if (!stripped) return null

  const strongLabel = stripped.match(/^(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*(.*)$/)
  if (strongLabel) {
    const [, label, inlineItem] = strongLabel
    return {
      section: sectionFromHeading(label),
      inlineItem: inlineItem.trim(),
    }
  }

  const colonIdx = stripped.indexOf(':')
  if (colonIdx > 0) {
    const label = stripped.slice(0, colonIdx).trim()
    const inlineItem = stripped.slice(colonIdx + 1).trim()
    const section = sectionFromHeading(label)
    const hasLetters = /[A-Za-z]/.test(label)
    const isUpperLabel = hasLetters && label === label.toUpperCase()
    if (section || isUpperLabel) {
      return { section, inlineItem }
    }
  }

  const section = sectionFromHeading(stripped)
  if (section) {
    return { section, inlineItem: '' }
  }

  return null
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    output.push(value)
  }
  return output
}

export class DebriefParser {
  // Find and parse all debrief files for a given date
  async parseForDate(date: string, debriefDir: string): Promise<ParsedDebrief[]> {
    let files: string[]
    try {
      files = await readdir(debriefDir)
    } catch {
      return []
    }
    const dayFiles = files
      .filter((name) => name.startsWith(`${date}-`) && name.endsWith('.md'))
      .sort()
    const parsed = await Promise.all(
      dayFiles.map(async (name) => {
        const content = await readFile(path.join(debriefDir, name), 'utf-8')
        return this.parseOne(content, date)
      }),
    )
    return parsed
  }

  private parseOne(content: string, date: string): ParsedDebrief {
    const doctrineUpdates: string[] = []
    const sustainPatterns: string[] = []
    const improveRootCauses: string[] = []
    const evalCases: string[] = []
    const risks: string[] = []

    const lines = content.split(/\r?\n/)
    let currentSection: SectionKey | null = null
    let sessionTopic = this.extractSessionTopic(lines)

    for (const rawLine of lines) {
      const headingMatch = rawLine.match(/^#{1,6}\s+(.+)$/)
      if (headingMatch) {
        const heading = headingMatch[1].trim()
        const detected = sectionFromHeading(heading)
        if (detected) {
          currentSection = detected
          continue
        }
        currentSection = null
        if (!sessionTopic) {
          sessionTopic = this.topicFromHeading(heading)
        }
        continue
      }

      const sectionLine = parseSectionLine(rawLine)
      if (sectionLine) {
        currentSection = sectionLine.section
        if (!currentSection) {
          continue
        }
        const inlineItem = cleanItem(sectionLine.inlineItem)
        if (inlineItem) {
          this.addSectionItem(
            currentSection,
            inlineItem,
            doctrineUpdates,
            sustainPatterns,
            improveRootCauses,
            evalCases,
            risks,
          )
        }
        continue
      }

      if (!currentSection) continue
      const item = cleanItem(rawLine)
      if (!item) continue
      this.addSectionItem(
        currentSection,
        item,
        doctrineUpdates,
        sustainPatterns,
        improveRootCauses,
        evalCases,
        risks,
      )
    }

    return {
      date,
      sessionTopic: sessionTopic || 'Untitled Session',
      doctrineUpdates: dedupe(doctrineUpdates),
      sustainPatterns: dedupe(sustainPatterns),
      improveRootCauses: dedupe(improveRootCauses),
      evalCases: dedupe(evalCases),
      risks: dedupe(risks),
    }
  }

  private extractSessionTopic(lines: string[]): string {
    for (const line of lines) {
      const match = line.match(/^\s*(?:Session Topic|Topic)\s*:\s*(.+)\s*$/i)
      if (match) return match[1].trim()
    }
    return ''
  }

  private topicFromHeading(heading: string): string {
    return heading.replace(/^(HOTWASH|AAR|DEBRIEF)\s*[:\-]\s*/i, '').trim()
  }

  private addSectionItem(
    section: SectionKey,
    item: string,
    doctrineUpdates: string[],
    sustainPatterns: string[],
    improveRootCauses: string[],
    evalCases: string[],
    risks: string[],
  ): void {
    if (section === 'doctrine') {
      doctrineUpdates.push(item)
      return
    }
    if (section === 'sustain') {
      sustainPatterns.push(item)
      return
    }
    if (section === 'improve') {
      const cause = this.extractRootCause(item)
      if (cause) improveRootCauses.push(cause)
      return
    }
    if (section === 'eval') {
      evalCases.push(item)
      return
    }
    risks.push(item)
  }

  private cleanCause(value: string): string {
    return value
      .replace(/^[:\-–—\s]+/, '')
      .trim()
  }

  private extractRootCause(value: string): string {
    const compact = value.replace(/\s+/g, ' ').trim()
    if (!compact) return ''

    const rootCauseMatch = compact.match(/root cause\s*[:\-]\s*(.+)$/i)
    if (rootCauseMatch) return this.cleanCause(rootCauseMatch[1])

    const arrowParts = compact
      .split(/\s*(?:=>|->|→)\s*/)
      .map((part) => part.trim())
      .filter(Boolean)
    if (arrowParts.length > 1) {
      return this.cleanCause(arrowParts[arrowParts.length - 1])
    }

    const enabledMatch = compact.match(/enabled by\s+(.+?)(?:[.;]|$)/i)
    if (enabledMatch) return this.cleanCause(enabledMatch[1])

    const becauseMatches = [...compact.matchAll(/\bbecause\s+(.+?)(?:[.;]|$)/gi)]
    if (becauseMatches.length > 0) {
      return this.cleanCause(becauseMatches[becauseMatches.length - 1][1])
    }

    const causedByMatch = compact.match(/\bcaused by\s+(.+?)(?:[.;]|$)/i)
    if (causedByMatch) return this.cleanCause(causedByMatch[1])

    return this.cleanCause(compact)
  }
}
