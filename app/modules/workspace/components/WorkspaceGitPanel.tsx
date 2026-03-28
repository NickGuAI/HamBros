import { GitBranch, GitCommitHorizontal, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceGitLog, WorkspaceGitStatus } from '../types'

interface WorkspaceGitPanelProps {
  status: WorkspaceGitStatus | null
  log: WorkspaceGitLog | null
  loading?: boolean
  error?: string | null
  readOnly?: boolean
  onInit?: () => void
  initializing?: boolean
  variant?: 'light' | 'dark'
}

export function WorkspaceGitPanel({
  status,
  log,
  loading = false,
  error,
  readOnly = false,
  onInit,
  initializing = false,
  variant = 'light',
}: WorkspaceGitPanelProps) {
  const dark = variant === 'dark'

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-sumi-diluted">
        <Loader2 size={16} className="mr-2 animate-spin" />
        Loading Git status…
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-accent-vermillion/30 bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
        {error}
      </div>
    )
  }

  if (!status || !log) {
    return null
  }

  if (!status.enabled) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center rounded-lg border border-dashed px-4 text-center',
          dark
            ? 'border-white/[0.08] text-white/45'
            : 'border-ink-border text-sumi-diluted',
        )}
      >
        <GitBranch size={18} className="mb-3" />
        <p className="text-sm">Git is not initialized for this workspace</p>
        {!readOnly && onInit && (
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-ink-border px-3 py-1.5 text-xs hover:bg-ink-wash disabled:opacity-60"
            onClick={onInit}
            disabled={initializing}
          >
            {initializing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Initialize Git
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className={cn('min-h-0 rounded-lg border overflow-hidden', dark ? 'border-white/[0.08] bg-[#1b1b1b]' : 'border-ink-border bg-washi-white')}>
        <header className={cn('border-b px-3 py-2', dark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-ink-border bg-washi-aged/60')}>
          <p className="section-title flex items-center gap-2">
            <GitBranch size={13} />
            Pending Changes
          </p>
          <p className="mt-1 font-mono text-xs text-sumi-diluted">
            {status.branch ?? 'detached'} • +{status.ahead} / -{status.behind}
          </p>
        </header>
        <div className="max-h-[20rem] overflow-auto p-3 space-y-2">
          {status.entries.length === 0 ? (
            <p className="text-sm text-sumi-diluted">Working tree is clean.</p>
          ) : (
            status.entries.map((entry) => (
              <div key={`${entry.code}:${entry.path}`} className="rounded-md border border-ink-border px-3 py-2">
                <p className="font-mono text-xs text-sumi-black">{entry.path}</p>
                <p className="mt-1 text-whisper text-sumi-diluted">status: {entry.code}</p>
              </div>
            ))
          )}
        </div>
      </section>

      <section className={cn('min-h-0 rounded-lg border overflow-hidden', dark ? 'border-white/[0.08] bg-[#1b1b1b]' : 'border-ink-border bg-washi-white')}>
        <header className={cn('border-b px-3 py-2', dark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-ink-border bg-washi-aged/60')}>
          <p className="section-title flex items-center gap-2">
            <GitCommitHorizontal size={13} />
            Recent Commits
          </p>
        </header>
        <div className="max-h-[20rem] overflow-auto p-3 space-y-2">
          {log.commits.length === 0 ? (
            <p className="text-sm text-sumi-diluted">No commits yet.</p>
          ) : (
            log.commits.map((commit) => (
              <div key={commit.hash} className="rounded-md border border-ink-border px-3 py-2">
                <p className="font-mono text-xs text-sumi-black">{commit.shortHash}</p>
                <p className="mt-1 text-sm text-sumi-gray">{commit.subject}</p>
                <p className="mt-1 text-whisper text-sumi-diluted">
                  {commit.author} • {new Date(commit.authoredAt).toLocaleString()}
                </p>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
