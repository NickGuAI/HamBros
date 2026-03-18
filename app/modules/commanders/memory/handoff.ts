import { MemoryRecollection } from './recollection.js'
import type { JournalWriter } from './journal.js'
import type { SalienceLevel } from './types.js'
import type { GHIssue as RecollectionIssue } from './skill-matcher.js'
import { WorkingMemoryStore } from './working-memory.js'

const MAX_SKILL_SUGGESTIONS = 6
const MAX_MEMORY_EXCERPTS = 6

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

export interface SkillSuggestion {
  name: string
  path: string | null
  reason: string
  excerpt: string
}

export interface HandoffPackage {
  taskContext: string
  skillSuggestions: SkillSuggestion[]
  memoryExcerpts: string
  workingMemory: string
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

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function safeSnippet(value: string, maxLen: number = 220): string {
  const compacted = compactText(value)
  if (compacted.length <= maxLen) return compacted
  return `${compacted.slice(0, maxLen - 3)}...`
}

export class SubagentHandoff {
  private readonly recollection: MemoryRecollection
  private readonly workingMemory: WorkingMemoryStore

  constructor(
    private readonly commanderId: string,
    basePath?: string,
  ) {
    this.recollection = new MemoryRecollection(commanderId, basePath)
    this.workingMemory = new WorkingMemoryStore(commanderId, basePath)
  }

  async buildHandoffPackage(task: GHIssue): Promise<HandoffPackage> {
    const recollectionTask = this.toRecollectionIssue(task)
    const recollection = await this.recollection.recall({
      task: recollectionTask,
      cue: this.buildCueText(task),
      topK: 12,
    })

    const skillSuggestions = recollection.hits
      .filter((hit) => hit.type === 'skill')
      .slice(0, MAX_SKILL_SUGGESTIONS)
      .map((hit) => ({
        name: hit.title,
        path: hit.path,
        reason: hit.reason,
        excerpt: hit.excerpt,
      }))

    const memoryExcerpts = recollection.hits
      .filter((hit) => hit.type !== 'skill')
      .slice(0, MAX_MEMORY_EXCERPTS)
      .map((hit) => {
        const header = `[${hit.type}] ${hit.title}${hit.repo ? ` [${hit.repo}]` : ''}`
        const stale = hit.stale && hit.staleReason ? ` | stale: ${hit.staleReason}` : ''
        return `- ${header}\n  - ${hit.excerpt}\n  - reason: ${hit.reason}${stale}`
      })
      .join('\n')

    return {
      taskContext: this.formatTaskContext(task),
      skillSuggestions,
      memoryExcerpts: memoryExcerpts || '_No recollected memory excerpts._',
      workingMemory: await this.workingMemory.render(5),
      sourceCommanderId: this.commanderId,
    }
  }

  formatAsSystemContext(pkg: HandoffPackage): string {
    const skillsSection = pkg.skillSuggestions.length > 0
      ? pkg.skillSuggestions
          .map((skill) => [
            `- **${skill.name}**`,
            `  - path: ${skill.path ?? '_unknown_'}`,
            `  - why: ${skill.reason}`,
            `  - excerpt: ${skill.excerpt}`,
          ].join('\n'))
          .join('\n')
      : '_No skill suggestions found for this task._'

    return [
      `## Handoff from Commander ${pkg.sourceCommanderId}`,
      '',
      '### Task',
      pkg.taskContext.trim() || '_No task context available._',
      '',
      '### Suggested Skills (manual invoke only)',
      skillsSection,
      '',
      '### Working Memory Scratchpad',
      pkg.workingMemory.trim() || '_No working-memory snapshot available._',
      '',
      '### Relevant Memory Recollection',
      pkg.memoryExcerpts.trim() || '_No relevant memory excerpts found._',
      '',
      '### Standing Instructions',
      '- Report key findings back as GH Issue comments as you go',
      '- If you discover new conventions or pitfalls, record them in journal + memory',
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

  private toRecollectionIssue(task: GHIssue): RecollectionIssue {
    const repo = this.resolveRepo(task)
    return {
      number: task.number,
      title: task.title,
      body: task.body,
      comments: this.extractRecentComments(task.comments).map((body) => ({ body })),
      owner: repo.owner ?? undefined,
      repo: repo.name ?? undefined,
      repository: repo.fullName ?? undefined,
    }
  }

  private buildCueText(task: GHIssue): string {
    const comments = this.extractRecentComments(task.comments).join('\n')
    const repo = this.resolveRepo(task).fullName ?? ''
    return [task.title, task.body, comments, repo].join('\n').trim()
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
      .map((comment) => safeSnippet(comment))
      .filter((comment) => comment.length > 0)
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
