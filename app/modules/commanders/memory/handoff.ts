import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { JournalWriter } from './journal.js'
import type { SalienceLevel } from './types.js'

const MAX_MEMORY_EXCERPT_LINES = 50
const TITLE_KEYWORD_MIN_LEN = 4
const TITLE_KEYWORD_STOPWORDS = new Set([
  'this',
  'that',
  'with',
  'from',
  'into',
  'when',
  'then',
  'than',
  'issue',
  'split',
  'build',
  'create',
  'update',
  'after',
  'before',
  'under',
  'over',
  'about',
  'where',
  'while',
  'there',
  'their',
  'would',
  'could',
  'should',
])

const MANUAL_HELP_TRIGGERS = [
  'manual help',
  'manual intervention',
  'human help',
  'human intervention',
  'needed help',
  'needed manual',
  'asked for help',
  'required help',
]

export const SPIKE_TRIGGERS = [
  'never seen before',
  'unexpected',
  'unusual',
  'race condition',
  'data loss',
  'security',
  'breaking change',
  'migration required',
  'architecture decision',
  'fundamental issue',
]

export interface GHIssueComment {
  body: string
  author?: string
}

export interface GHIssue {
  number: number
  title: string
  body: string
  comments?: Array<GHIssueComment | string>
  repo?: string
  repoOwner?: string
  repoName?: string
}

export interface SkillContent {
  name: string
  fullContent: string
}

export interface HandoffPackage {
  taskContext: string
  repoKnowledge: string
  matchedSkills: SkillContent[]
  memoryExcerpts: string
  sourceCommanderId: string
}

export interface SubagentResult {
  status: 'SUCCESS' | 'PARTIAL' | 'BLOCKED'
  finalComment: string
  filesChanged: number
  durationMin: number
  subagentSessionId: string
}

interface RepoRef {
  owner: string | null
  name: string | null
  fullName: string | null
}

export class SubagentHandoff {
  private readonly memoryRoot: string

  constructor(
    private readonly commanderId: string,
    basePath?: string,
  ) {
    this.memoryRoot = basePath
      ? path.join(basePath, commanderId, '.memory')
      : path.resolve(process.cwd(), 'data', 'commanders', commanderId, '.memory')
  }

  async buildHandoffPackage(task: GHIssue): Promise<HandoffPackage> {
    const [repoKnowledge, matchedSkills, memoryExcerpts] = await Promise.all([
      this.readRepoKnowledge(task),
      this.readMatchedSkills(task),
      this.extractMemoryExcerpts(task),
    ])

    return {
      taskContext: this.formatTaskContext(task),
      repoKnowledge,
      matchedSkills,
      memoryExcerpts,
      sourceCommanderId: this.commanderId,
    }
  }

  formatAsSystemContext(pkg: HandoffPackage): string {
    const skillsSection = pkg.matchedSkills.length
      ? pkg.matchedSkills
          .map((skill) => `#### ${skill.name}\n${skill.fullContent.trim()}`)
          .join('\n\n')
      : '_No applicable skills found._'

    return [
      `## Handoff from Commander ${pkg.sourceCommanderId}`,
      '',
      '### Task',
      pkg.taskContext.trim() || '_No task context available._',
      '',
      '### What I Know About This Repo',
      pkg.repoKnowledge.trim() || '_No repo knowledge cache available._',
      '',
      '### Applicable Skills',
      skillsSection,
      '',
      '### Relevant Memory',
      pkg.memoryExcerpts.trim() || '_No relevant memory excerpts found._',
      '',
      '### Standing Instructions',
      '- Report key findings back as GH Issue comments as you go',
      '- If you discover new conventions or pitfalls for this repo, note them explicitly',
      '- Tag your final status: SUCCESS | PARTIAL | BLOCKED',
    ].join('\n')
  }

  async processCompletion(
    task: GHIssue,
    subagentResult: SubagentResult,
    journal: JournalWriter,
  ): Promise<void> {
    const repo = this.resolveRepo(task)
    const salience = this.deriveCompletionSalience(subagentResult)
    const body = [
      `- Sub-agent session: \`${subagentResult.subagentSessionId}\``,
      `- Status: \`${subagentResult.status}\``,
      `- Files changed: ${subagentResult.filesChanged}`,
      '',
      '### Final Comment',
      subagentResult.finalComment.trim() || '_No final comment provided._',
    ].join('\n')

    await journal.append({
      timestamp: new Date().toISOString(),
      issueNumber: task.number,
      repo: repo.fullName,
      outcome: `Sub-agent completion: ${subagentResult.status}`,
      durationMin: subagentResult.durationMin,
      salience,
      body,
    })
  }

  private resolveRepo(task: GHIssue): RepoRef {
    if (task.repoOwner && task.repoName) {
      return {
        owner: task.repoOwner,
        name: task.repoName,
        fullName: `${task.repoOwner}/${task.repoName}`,
      }
    }

    if (!task.repo) {
      return { owner: null, name: null, fullName: null }
    }

    const [owner, name] = task.repo.split('/')
    if (!owner || !name) {
      return { owner: null, name: task.repo, fullName: task.repo }
    }

    return { owner, name, fullName: `${owner}/${name}` }
  }

  private formatTaskContext(task: GHIssue): string {
    const comments = this.extractRecentComments(task.comments)
    const lines: string[] = [`**Issue #${task.number}**: ${task.title}`, '']
    lines.push(task.body?.trim() ? task.body.trim() : '_No issue body provided._')

    if (comments.length > 0) {
      lines.push('', '**Recent Comments**')
      for (const comment of comments) {
        lines.push(`- ${comment}`)
      }
    }

    return lines.join('\n')
  }

  private extractRecentComments(
    comments: Array<GHIssueComment | string> | undefined,
  ): string[] {
    if (!comments?.length) return []

    return comments
      .slice(-3)
      .map((comment) => {
        if (typeof comment === 'string') return comment.trim()
        const body = comment.body.trim()
        if (!comment.author) return body
        return `${comment.author}: ${body}`
      })
      .filter((comment) => comment.length > 0)
  }

  private async readRepoKnowledge(task: GHIssue): Promise<string> {
    const repo = this.resolveRepo(task)
    if (!repo.owner || !repo.name) return ''

    const repoFile = `${repo.owner}_${repo.name}`.replace(/[^\w.-]/gu, '_')
    const repoPath = path.join(this.memoryRoot, 'repos', `${repoFile}.md`)
    try {
      return await readFile(repoPath, 'utf-8')
    } catch {
      return ''
    }
  }

  private async readMatchedSkills(task: GHIssue): Promise<SkillContent[]> {
    const skillsRoot = path.join(this.memoryRoot, 'skills')
    const skillFiles = await this.collectSkillFiles(skillsRoot)
    if (skillFiles.length === 0) return []

    const repo = this.resolveRepo(task)
    const taskText = `${task.title}\n${task.body}\n${repo.fullName ?? ''}`.toLowerCase()
    const titleKeywords = this.extractTitleKeywords(task.title)
    const skills: SkillContent[] = []

    for (const skillPath of skillFiles) {
      let fullContent = ''
      try {
        fullContent = await readFile(skillPath, 'utf-8')
      } catch {
        continue
      }
      if (!fullContent.trim()) continue

      const skillName = path.basename(path.dirname(skillPath))
      if (!this.isSkillMatch(skillName, fullContent, taskText, titleKeywords)) continue

      skills.push({ name: skillName, fullContent })
    }

    return skills
  }

  private async collectSkillFiles(root: string): Promise<string[]> {
    const files: string[] = []
    let entries: Dirent<string>[]
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return files
    }

    for (const entry of entries) {
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await this.collectSkillFiles(fullPath)))
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.toLowerCase() === 'skill.md') files.push(fullPath)
    }
    return files
  }

  private isSkillMatch(
    skillName: string,
    fullContent: string,
    taskText: string,
    titleKeywords: string[],
  ): boolean {
    const skillNameLower = skillName.toLowerCase()
    if (taskText.includes(skillNameLower)) return true

    const contentLower = fullContent.toLowerCase()
    for (const keyword of titleKeywords) {
      if (skillNameLower.includes(keyword) || contentLower.includes(keyword)) {
        return true
      }
    }
    return false
  }

  private async extractMemoryExcerpts(task: GHIssue): Promise<string> {
    const memoryPath = path.join(this.memoryRoot, 'MEMORY.md')
    let content = ''
    try {
      content = await readFile(memoryPath, 'utf-8')
    } catch {
      return ''
    }
    if (!content.trim()) return ''

    const lines = content.split(/\r?\n/u)
    const selected = new Set<number>()
    const repo = this.resolveRepo(task)
    const repoName = (repo.name ?? '').toLowerCase()
    const repoFullName = (repo.fullName ?? '').toLowerCase()
    const titleKeywords = this.extractTitleKeywords(task.title)

    const firstHeaderIndex = lines.findIndex((line) => /^#{1,6}\s+\S/u.test(line))
    if (firstHeaderIndex >= 0) {
      let endIndex = lines.length
      for (let i = firstHeaderIndex + 1; i < lines.length; i++) {
        if (/^#{1,6}\s+\S/u.test(lines[i])) {
          endIndex = i
          break
        }
      }
      for (let i = firstHeaderIndex; i < endIndex; i++) {
        selected.add(i)
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const normalizedLine = lines[i].toLowerCase()
      if (repoFullName && normalizedLine.includes(repoFullName)) selected.add(i)
      if (repoName && normalizedLine.includes(repoName)) selected.add(i)
      if (titleKeywords.some((keyword) => normalizedLine.includes(keyword))) selected.add(i)
    }

    const excerptLines = [...selected]
      .sort((a, b) => a - b)
      .slice(0, MAX_MEMORY_EXCERPT_LINES)
      .map((i) => lines[i])

    return excerptLines.join('\n').trim()
  }

  private extractTitleKeywords(title: string): string[] {
    const seen = new Set<string>()
    const rawWords = title.toLowerCase().match(/[a-z0-9-]+/gu) ?? []
    for (const word of rawWords) {
      if (word.length < TITLE_KEYWORD_MIN_LEN) continue
      if (TITLE_KEYWORD_STOPWORDS.has(word)) continue
      if (seen.has(word)) continue
      seen.add(word)
    }
    return [...seen]
  }

  private deriveCompletionSalience(result: SubagentResult): SalienceLevel {
    const finalComment = result.finalComment.toLowerCase()
    if (this.hasSpikeContent(finalComment)) return 'SPIKE'
    if (result.status === 'SUCCESS') return 'ROUTINE'
    return 'NOTABLE'
  }

  private hasSpikeContent(finalComment: string): boolean {
    return (
      SPIKE_TRIGGERS.some((trigger) => finalComment.includes(trigger)) ||
      MANUAL_HELP_TRIGGERS.some((trigger) => finalComment.includes(trigger))
    )
  }
}
