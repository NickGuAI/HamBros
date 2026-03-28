export type WorkspaceSourceKind = 'agent-session' | 'commander' | 'factory-worktree'

export interface WorkspaceSourceDescriptor {
  kind: WorkspaceSourceKind
  id: string
  label: string
  host?: string | null
  readOnly?: boolean
  repo?: {
    owner: string
    repo: string
  }
  branch?: string
}

export interface WorkspaceSummary {
  source: WorkspaceSourceDescriptor
  rootPath: string
  rootName: string
  gitRoot: string | null
  readOnly: boolean
  isRemote: boolean
}

export interface ResolvedWorkspace extends WorkspaceSummary {}

export interface WorkspaceTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  extension?: string
  size?: number
}

export interface WorkspaceTreeResponse {
  workspace: WorkspaceSummary
  parentPath: string
  nodes: WorkspaceTreeNode[]
}

export type WorkspaceFilePreviewKind = 'text' | 'image' | 'binary'

export interface WorkspaceFilePreview {
  workspace: WorkspaceSummary
  path: string
  name: string
  kind: WorkspaceFilePreviewKind
  size: number
  mimeType?: string
  content?: string
  truncated?: boolean
  writable: boolean
}

export interface WorkspaceMutationResult {
  workspace: WorkspaceSummary
  path: string
}

export interface WorkspaceGitStatusEntry {
  path: string
  code: string
}

export interface WorkspaceGitStatus {
  workspace: WorkspaceSummary
  enabled: boolean
  branch: string | null
  ahead: number
  behind: number
  entries: WorkspaceGitStatusEntry[]
}

export interface WorkspaceGitCommit {
  hash: string
  shortHash: string
  author: string
  authoredAt: string
  subject: string
}

export interface WorkspaceGitLog {
  workspace: WorkspaceSummary
  enabled: boolean
  commits: WorkspaceGitCommit[]
}
