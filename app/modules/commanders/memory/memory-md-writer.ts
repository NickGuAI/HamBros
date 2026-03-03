import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface MemoryEntry {
  text: string
  lastSeen: string
  salience: number
}

export interface MemoryUpdateResult {
  factsAdded: number
  lineCount: number
  evicted: string[]
}

function normalizeFact(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function parseLastSeen(line: string): string | null {
  const match = line.match(/<!--\s*last-seen:\s*(\d{4}-\d{2}-\d{2})\s*-->/i)
  return match ? match[1] : null
}

function removeComment(line: string): string {
  return line.replace(/<!--[\s\S]*?-->/g, '').trim()
}

function salienceScore(text: string): number {
  const value = text.toLowerCase()
  if (value.includes('spike') || value.startsWith('doctrine:')) return 3
  if (value.includes('notable') || value.startsWith('avoid:')) return 2
  return 1
}

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(`${dateA}T00:00:00.000Z`).getTime()
  const b = new Date(`${dateB}T00:00:00.000Z`).getTime()
  return Math.floor((b - a) / (24 * 60 * 60 * 1000))
}

function parseEntries(content: string, fallbackLastSeen: string): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('- ')) continue
    const lastSeen = parseLastSeen(line) ?? fallbackLastSeen
    const text = normalizeFact(removeComment(line).replace(/^-+\s*/, ''))
    if (!text) continue
    entries.push({
      text,
      lastSeen,
      salience: salienceScore(text),
    })
  }
  return entries
}

function sortForRetention(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.salience !== b.salience) return b.salience - a.salience
    if (a.lastSeen !== b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen)
    return a.text.localeCompare(b.text)
  })
}

function sortForEviction(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.salience !== b.salience) return a.salience - b.salience
    if (a.lastSeen !== b.lastSeen) return a.lastSeen.localeCompare(b.lastSeen)
    return a.text.localeCompare(b.text)
  })
}

export class MemoryMdWriter {
  private readonly memoryPath: string
  private readonly archiveDir: string
  private readonly now: () => Date
  private readonly maxLines: number

  constructor(
    private readonly memoryRoot: string,
    options: { now?: () => Date; maxLines?: number } = {},
  ) {
    this.memoryPath = path.join(memoryRoot, 'MEMORY.md')
    this.archiveDir = path.join(memoryRoot, 'archive')
    this.now = options.now ?? (() => new Date())
    this.maxLines = options.maxLines ?? 200
  }

  async updateFacts(facts: string[]): Promise<MemoryUpdateResult> {
    const today = toDateKey(this.now())
    let current = '# Commander Memory\n\n'
    try {
      current = await readFile(this.memoryPath, 'utf-8')
    } catch {
      // Use default content.
    }

    const existingEntries = parseEntries(current, today)
    const byKey = new Map<string, MemoryEntry>()
    for (const entry of existingEntries) {
      byKey.set(entry.text.toLowerCase(), entry)
    }

    let factsAdded = 0
    for (const fact of facts) {
      const text = normalizeFact(fact)
      if (!text) continue
      const key = text.toLowerCase()
      const existing = byKey.get(key)
      if (existing) {
        existing.lastSeen = today
        existing.salience = salienceScore(existing.text)
        continue
      }
      byKey.set(key, {
        text,
        lastSeen: today,
        salience: salienceScore(text),
      })
      factsAdded += 1
    }

    const evicted: string[] = []
    let retained = sortForRetention([...byKey.values()])

    // First pass: evict entries not referenced in 30+ days.
    const staleCutoff = 30
    retained = retained.filter((entry) => {
      if (daysBetween(entry.lastSeen, today) < staleCutoff) return true
      evicted.push(`${entry.text} <!-- last-seen: ${entry.lastSeen} -->`)
      return false
    })

    // Second pass: enforce hard line cap (header + blank line + entry lines).
    const maxEntryLines = Math.max(this.maxLines - 3, 0)
    if (retained.length > maxEntryLines) {
      const removable = sortForEviction(retained)
      while (retained.length > maxEntryLines && removable.length > 0) {
        const next = removable.shift()
        if (!next) break
        const idx = retained.findIndex((entry) => entry.text === next.text)
        if (idx === -1) continue
        const [removed] = retained.splice(idx, 1)
        evicted.push(`${removed.text} <!-- last-seen: ${removed.lastSeen} -->`)
      }
    }

    if (evicted.length > 0) {
      await mkdir(this.archiveDir, { recursive: true })
      const archivePath = path.join(this.archiveDir, `MEMORY-archive-${today}.md`)
      let archiveContent = ''
      try {
        archiveContent = await readFile(archivePath, 'utf-8')
      } catch {
        archiveContent = '# MEMORY Archive\n\n'
      }
      const block = [
        `## ${today}`,
        ...evicted.map((line) => `- ${line}`),
        '',
      ].join('\n')
      await writeFile(archivePath, `${archiveContent.trimEnd()}\n\n${block}`, 'utf-8')
    }

    const lines = [
      '# Commander Memory',
      '',
      ...sortForRetention(retained).map(
        (entry) => `- ${entry.text} <!-- last-seen: ${entry.lastSeen} -->`,
      ),
      '',
    ]
    await writeFile(this.memoryPath, lines.join('\n'), 'utf-8')

    return {
      factsAdded,
      lineCount: lines.length,
      evicted,
    }
  }
}
