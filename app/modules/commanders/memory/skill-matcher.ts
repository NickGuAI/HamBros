import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import * as path from 'node:path'

export interface GHIssueLabel {
  name: string
}

export interface GHIssueComment {
  body: string
  author?: string
  createdAt?: string
}

export interface GHIssue {
  number: number
  title: string
  body?: string | null
  labels?: GHIssueLabel[]
  comments?: GHIssueComment[]
  owner?: string
  repo?: string
  repository?: string
}

export interface SkillAutoMatch {
  labels: string[]
  keywords: string[]
}

export interface SkillManifest {
  name: string
  path: string
  content: string
  autoMatch: SkillAutoMatch
}

interface MatchScore {
  labelMatches: number
  keywordMatches: number
  total: number
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function countIndent(line: string): number {
  const match = line.match(/^\s*/)
  return match ? match[0].length : 0
}

function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return []
  }
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []

  return inner
    .split(',')
    .map((part) => stripQuotes(part))
    .filter((part) => part.length > 0)
}

function normalizeList(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

function parseYamlList(
  lines: string[],
  startIndex: number,
  fieldIndent: number,
  inlineValue: string,
): { values: string[]; nextIndex: number } {
  const trimmed = inlineValue.trim()

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return {
      values: normalizeList(parseInlineList(trimmed)),
      nextIndex: startIndex + 1,
    }
  }

  if (trimmed.length > 0) {
    return {
      values: normalizeList([stripQuotes(trimmed)]),
      nextIndex: startIndex + 1,
    }
  }

  const values: string[] = []
  let index = startIndex + 1
  while (index < lines.length) {
    const raw = lines[index] ?? ''
    const line = raw.trim()
    if (!line) {
      index += 1
      continue
    }
    const indent = countIndent(raw)
    if (indent <= fieldIndent) {
      break
    }
    if (!line.startsWith('- ')) {
      break
    }
    const value = stripQuotes(line.slice(2))
    if (value) values.push(value)
    index += 1
  }

  return {
    values: normalizeList(values),
    nextIndex: index,
  }
}

function extractFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  return match?.[1] ?? ''
}

function parseSkillName(frontmatter: string): string | null {
  if (!frontmatter) return null
  const lines = frontmatter.split(/\r?\n/)
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue
    if (countIndent(rawLine) > 0) continue
    const match = rawLine.match(/^name:\s*(.+)$/)
    if (!match) continue
    const name = stripQuotes(match[1] ?? '')
    if (name) return name
  }
  return null
}

function parseAutoMatch(frontmatter: string): SkillAutoMatch {
  if (!frontmatter) {
    return { labels: [], keywords: [] }
  }

  const lines = frontmatter.split(/\r?\n/)
  const autoMatch: SkillAutoMatch = { labels: [], keywords: [] }
  let index = 0

  while (index < lines.length) {
    const raw = lines[index] ?? ''
    const line = raw.trim()
    if (!line) {
      index += 1
      continue
    }

    if (line !== 'auto-match:') {
      index += 1
      continue
    }

    const autoIndent = countIndent(raw)
    index += 1

    while (index < lines.length) {
      const nestedRaw = lines[index] ?? ''
      const nested = nestedRaw.trim()

      if (!nested) {
        index += 1
        continue
      }

      const nestedIndent = countIndent(nestedRaw)
      if (nestedIndent <= autoIndent) {
        break
      }

      const keyValueMatch = nested.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
      if (!keyValueMatch) {
        index += 1
        continue
      }

      const key = keyValueMatch[1]
      const value = keyValueMatch[2] ?? ''
      if (key === 'labels' || key === 'keywords') {
        const parsed = parseYamlList(lines, index, nestedIndent, value)
        if (key === 'labels') {
          autoMatch.labels = parsed.values
        } else {
          autoMatch.keywords = parsed.values
        }
        index = parsed.nextIndex
        continue
      }

      index += 1
    }
    break
  }

  return autoMatch
}

export function parseSkillManifest(
  content: string,
  filePath: string,
  fallbackName?: string,
): SkillManifest {
  const frontmatter = extractFrontmatter(content)
  const parsedName = parseSkillName(frontmatter)
  const name = parsedName ?? fallbackName ?? path.basename(path.dirname(filePath))
  return {
    name,
    path: filePath,
    content: content.trim(),
    autoMatch: parseAutoMatch(frontmatter),
  }
}

function scoreSkillMatch(skill: SkillManifest, task: GHIssue): MatchScore {
  const taskLabels = new Set(
    (task.labels ?? [])
      .map((label) => label.name.trim().toLowerCase())
      .filter((label) => label.length > 0),
  )

  const taskText = `${task.title}\n${task.body ?? ''}`.toLowerCase()
  const labelMatches = skill.autoMatch.labels.filter((label) =>
    taskLabels.has(label.toLowerCase()),
  ).length
  const keywordMatches = skill.autoMatch.keywords.filter((keyword) =>
    taskText.includes(keyword.toLowerCase()),
  ).length

  return {
    labelMatches,
    keywordMatches,
    total: labelMatches + keywordMatches,
  }
}

export function matchSkill(skill: SkillManifest, task: GHIssue): boolean {
  return scoreSkillMatch(skill, task).total > 0
}

export function rankMatchingSkills(skills: SkillManifest[], task: GHIssue): SkillManifest[] {
  const ranked = skills
    .map((skill) => ({ skill, score: scoreSkillMatch(skill, task) }))
    .filter((entry) => entry.score.total > 0)
    .sort((a, b) => {
      if (b.score.total !== a.score.total) {
        return b.score.total - a.score.total
      }
      if (b.score.labelMatches !== a.score.labelMatches) {
        return b.score.labelMatches - a.score.labelMatches
      }
      if (b.score.keywordMatches !== a.score.keywordMatches) {
        return b.score.keywordMatches - a.score.keywordMatches
      }
      return a.skill.name.localeCompare(b.skill.name)
    })

  return ranked.map((entry) => entry.skill)
}

export async function loadSkillManifests(skillsRoot: string): Promise<SkillManifest[]> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const skills: SkillManifest[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md')
    let content: string
    try {
      content = await readFile(skillPath, 'utf-8')
    } catch {
      continue
    }
    skills.push(parseSkillManifest(content, skillPath, entry.name))
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}
