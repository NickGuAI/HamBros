import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GhCommandRunner {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>
}

export interface GhTasksOptions {
  repo: string
  label?: string
  runner?: GhCommandRunner
}

export interface GhIssueComment {
  body: string
  author?: string
}

export interface GhIssueSummary {
  number: number
  title: string
  body: string
  labels: string[]
  assignees: string[]
  url?: string
}

export interface GhIssueDetails extends GhIssueSummary {
  comments: GhIssueComment[]
}

function defaultCommandRunner(): GhCommandRunner {
  return {
    exec: (command, args) => execFileAsync(command, args),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return value
    .map((entry) => {
      const raw = asRecord(entry)
      if (!raw) return asString(entry)
      return asString(raw.name)
    })
    .filter((label): label is string => Boolean(label))
}

function parseAssignees(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return value
    .map((entry) => {
      const raw = asRecord(entry)
      if (!raw) return asString(entry)
      return asString(raw.login)
    })
    .filter((assignee): assignee is string => Boolean(assignee))
}

function parseComments(value: unknown): GhIssueComment[] {
  if (!Array.isArray(value)) return []

  const comments: GhIssueComment[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      comments.push({ body: entry.trim() })
      continue
    }

    const raw = asRecord(entry)
    if (!raw) continue
    const body = asString(raw.body)?.trim()
    if (!body) continue
    const author = asRecord(raw.author)
    comments.push({
      body,
      author: asString(author?.login) ?? undefined,
    })
  }

  return comments
}

function parseIssueSummary(value: unknown): GhIssueSummary | null {
  const raw = asRecord(value)
  if (!raw) return null

  const number = asNumber(raw.number)
  if (number === null) return null

  return {
    number,
    title: asString(raw.title) ?? '',
    body: asString(raw.body) ?? '',
    labels: parseLabels(raw.labels),
    assignees: parseAssignees(raw.assignees),
    url: asString(raw.url) ?? undefined,
  }
}

function parseIssueDetails(value: unknown): GhIssueDetails | null {
  const summary = parseIssueSummary(value)
  if (!summary) return null
  const raw = asRecord(value)
  if (!raw) return null

  return {
    ...summary,
    comments: parseComments(raw.comments),
  }
}

function validateIssueNumber(issueNumber: number): void {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number "${issueNumber}"`)
  }
}

export class GhTasks {
  private readonly repo: string
  private readonly label: string
  private readonly runner: GhCommandRunner

  constructor(options: GhTasksOptions) {
    const repo = options.repo.trim()
    if (repo.length === 0) {
      throw new Error('GitHub repo is required')
    }

    this.repo = repo
    this.label = options.label?.trim() || 'commander'
    this.runner = options.runner ?? defaultCommandRunner()
  }

  async listAssignedTasks(assignee = '@me'): Promise<GhIssueSummary[]> {
    return this.listOpenLabelledIssues({ assignee })
  }

  async listOpenLabelledTasks(): Promise<GhIssueSummary[]> {
    return this.listOpenLabelledIssues({})
  }

  async discoverNextUnassignedTask(): Promise<GhIssueSummary | null> {
    const issues = await this.listOpenLabelledTasks()
    const unassigned = issues.filter((issue) => issue.assignees.length === 0)
    if (unassigned.length === 0) return null
    return unassigned[0]
  }

  async readTask(issueNumber: number): Promise<GhIssueDetails> {
    validateIssueNumber(issueNumber)

    const payload = await this.runJson([
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      this.repo,
      '--json',
      'number,title,body,labels,assignees,comments,url',
    ])

    const issue = parseIssueDetails(payload)
    if (!issue) {
      throw new Error(`Unable to parse issue #${issueNumber}`)
    }
    return issue
  }

  async assignTask(issueNumber: number, assignee = '@me'): Promise<void> {
    validateIssueNumber(issueNumber)
    await this.run([
      'issue',
      'edit',
      String(issueNumber),
      '--repo',
      this.repo,
      '--add-assignee',
      assignee,
    ])
  }

  async postTaskComment(issueNumber: number, body: string): Promise<void> {
    validateIssueNumber(issueNumber)
    const comment = body.trim()
    if (comment.length === 0) {
      throw new Error('Comment body cannot be empty')
    }

    await this.run([
      'issue',
      'comment',
      String(issueNumber),
      '--repo',
      this.repo,
      '--body',
      comment,
    ])
  }

  async closeTask(issueNumber: number): Promise<void> {
    validateIssueNumber(issueNumber)
    await this.run([
      'issue',
      'close',
      String(issueNumber),
      '--repo',
      this.repo,
    ])
  }

  async startTask(
    issueNumber: number,
    startComment: string,
    assignee = '@me',
  ): Promise<void> {
    await this.assignTask(issueNumber, assignee)
    await this.postTaskComment(issueNumber, startComment)
  }

  async completeTask(issueNumber: number, completionComment: string): Promise<void> {
    await this.postTaskComment(issueNumber, completionComment)
    await this.closeTask(issueNumber)
  }

  private async listOpenLabelledIssues(options: { assignee?: string }): Promise<GhIssueSummary[]> {
    const args = [
      'issue',
      'list',
      '--repo',
      this.repo,
      '--state',
      'open',
      '--label',
      this.label,
      '--json',
      'number,title,body,labels,assignees,url',
    ]
    if (options.assignee) {
      args.push('--assignee', options.assignee)
    }

    const payload = await this.runJson(args)
    if (!Array.isArray(payload)) {
      throw new Error('Unable to parse issue list from gh output')
    }

    return payload
      .map(parseIssueSummary)
      .filter((issue): issue is GhIssueSummary => issue !== null)
      .sort((left, right) => left.number - right.number)
  }

  private async run(args: string[]): Promise<string> {
    const { stdout } = await this.runner.exec('gh', args)
    return stdout
  }

  private async runJson(args: string[]): Promise<unknown> {
    const stdout = await this.run(args)
    const content = stdout.trim()
    if (content.length === 0) return null

    try {
      return JSON.parse(content) as unknown
    } catch {
      throw new Error(`Unable to parse JSON from gh output for command: gh ${args.join(' ')}`)
    }
  }
}
