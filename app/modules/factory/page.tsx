import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Warehouse,
  GitBranch,
  GitCommitHorizontal,
  Plus,
  Trash2,
  Play,
  AlertTriangle,
  ChevronRight,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import {
  useFactoryRepos,
  useFactoryWorktrees,
  useCloneRepo,
  useDeleteRepo,
  useCreateWorktree,
  useDeleteWorktree,
  useSyncRepo,
} from '@/hooks/use-factory'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-is-mobile'
import type { FactoryRepo } from '@/types'

function RepoCard({
  repo,
  selected,
  onSelect,
  onDelete,
  onSync,
  isSyncing,
}: {
  repo: FactoryRepo
  selected: boolean
  onSelect: () => void
  onDelete: () => void
  onSync: () => void
  isSyncing: boolean
}) {
  return (
    <div
      className={cn(
        'w-full text-left p-5 card-sumi transition-all duration-300 ease-gentle',
        selected && 'ring-1 ring-sumi-black/10 shadow-ink-md',
      )}
    >
      <div className="flex items-start justify-between">
        <button onClick={onSelect} className="flex items-center gap-3 flex-1 text-left">
          <Warehouse size={18} className="text-sumi-diluted" />
          <span className="font-mono text-sm text-sumi-black">
            {repo.owner}/{repo.repo}
          </span>
          <ChevronRight
            size={16}
            className={cn(
              'text-sumi-mist transition-transform duration-300',
              selected && 'rotate-90 text-sumi-gray',
            )}
          />
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSync()
            }}
            disabled={isSyncing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-sumi-gray hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            aria-label="Sync with remote"
          >
            <RefreshCw size={12} className={isSyncing ? 'animate-spin' : ''} />
            Sync
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="p-1.5 rounded-lg text-sumi-mist hover:text-accent-vermillion hover:bg-accent-vermillion/10 transition-colors"
            aria-label="Delete repo"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {repo.commitHash && (
        <div className="mt-2 flex items-center gap-1.5 text-whisper text-sumi-diluted font-mono">
          <GitCommitHorizontal size={12} />
          <span>{repo.commitHash}</span>
        </div>
      )}
      <div className="mt-1 text-whisper text-sumi-diluted font-mono truncate">
        {repo.path}
      </div>
    </div>
  )
}

function WorktreeSection({
  owner,
  repo,
}: {
  owner: string
  repo: string
}) {
  const navigate = useNavigate()
  const { data: worktrees, isLoading } = useFactoryWorktrees(owner, repo)
  const createWorktree = useCreateWorktree(owner, repo)
  const deleteWorktree = useDeleteWorktree(owner, repo)
  const [feature, setFeature] = useState('')
  const [showNewForm, setShowNewForm] = useState(false)

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = feature.trim()
    if (!trimmed) return

    try {
      await createWorktree.mutateAsync(trimmed)
      setFeature('')
      setShowNewForm(false)
    } catch {
      // error handled by mutation state
    }
  }

  function handleStartAgent(worktreePath: string, featureName: string) {
    const params = new URLSearchParams({ cwd: worktreePath, name: `factory-${featureName}` })
    navigate(`/agents?${params}`)
  }

  function handleDelete(featureName: string) {
    const confirmed = window.confirm(`Delete worktree "${featureName}"?`)
    if (confirmed) {
      deleteWorktree.mutate(featureName)
    }
  }

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="section-title flex items-center gap-2">
          <GitBranch size={14} />
          Worktrees for {owner}/{repo}
        </h3>
        <button
          type="button"
          onClick={() => setShowNewForm((c) => !c)}
          className="btn-ghost inline-flex items-center gap-1.5 text-xs"
        >
          <Plus size={12} />
          {showNewForm ? 'Close' : 'New Feature'}
        </button>
      </div>

      {showNewForm && (
        <form onSubmit={handleCreate} className="card-sumi p-4 mb-4 space-y-3">
          <div>
            <label className="section-title block mb-2">Feature Name</label>
            <input
              value={feature}
              onChange={(e) => setFeature(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
              placeholder="fix-auth-bug"
              required
              pattern="[a-zA-Z0-9_-]+"
              title="Alphanumeric, underscore, and hyphen only"
            />
          </div>

          {createWorktree.error && (
            <div className="flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
              <AlertTriangle size={15} className="mt-0.5" />
              <span>{createWorktree.error instanceof Error ? createWorktree.error.message : 'Failed to create worktree'}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={createWorktree.isPending}
            className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {createWorktree.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {createWorktree.isPending ? 'Creating...' : 'Create Worktree'}
          </button>
        </form>
      )}

      {deleteWorktree.error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
          <AlertTriangle size={15} className="mt-0.5" />
          <span>{deleteWorktree.error instanceof Error ? deleteWorktree.error.message : 'Failed to delete worktree'}</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8">
          <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
        </div>
      ) : worktrees?.length === 0 ? (
        <div className="text-center py-8 text-sumi-diluted text-sm">
          No worktrees yet
        </div>
      ) : (
        <div className="space-y-3">
          {worktrees?.map((wt) => (
            <div key={wt.feature} className="card-sumi p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-mono text-sm text-sumi-black">{wt.feature}</div>
                  <div className="mt-1 text-whisper text-sumi-diluted">
                    branch: {wt.branch}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleStartAgent(wt.path, wt.feature)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg text-xs bg-sumi-black text-washi-aged hover:bg-sumi-gray transition-colors"
                  >
                    <Play size={12} />
                    Start Agent
                  </button>
                  <button
                    onClick={() => handleDelete(wt.feature)}
                    className="p-1.5 rounded-lg text-sumi-mist hover:text-accent-vermillion hover:bg-accent-vermillion/10 transition-colors"
                    aria-label={`Delete worktree ${wt.feature}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function FactoryPage() {
  const isMobile = useIsMobile()
  const { data: repos, isLoading } = useFactoryRepos()
  const cloneRepo = useCloneRepo()
  const deleteRepo = useDeleteRepo()
  const syncRepo = useSyncRepo()
  const [selectedRepo, setSelectedRepo] = useState<{ owner: string; repo: string } | null>(null)
  const [showCloneForm, setShowCloneForm] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')

  async function handleClone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = repoUrl.trim()
    if (!trimmed) return

    try {
      await cloneRepo.mutateAsync(trimmed)
      setRepoUrl('')
      setShowCloneForm(false)
    } catch {
      // error handled by mutation state
    }
  }

  function handleDeleteRepo(owner: string, repo: string) {
    const confirmed = window.confirm(`Delete ${owner}/${repo} and all worktrees?`)
    if (!confirmed) return

    if (selectedRepo?.owner === owner && selectedRepo?.repo === repo) {
      setSelectedRepo(null)
    }
    deleteRepo.mutate({ owner, repo })
  }

  function handleSyncRepo(owner: string, repo: string) {
    syncRepo.mutate({ owner, repo })
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 md:px-6 md:py-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-display text-sumi-black">Factory</h2>
          <p className="mt-2 text-sm text-sumi-diluted leading-relaxed">
            Manage GitHub repos and git worktrees for isolated feature development
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowCloneForm((c) => !c)
            cloneRepo.reset()
          }}
          className="btn-ghost inline-flex items-center gap-1.5"
        >
          <Plus size={14} />
          {showCloneForm ? 'Close' : 'Clone Repo'}
        </button>
      </div>

      {isMobile ? (
        <>
          <div
            className={cn('sheet-backdrop', showCloneForm && 'visible')}
            onClick={() => setShowCloneForm(false)}
          />
          <div className={cn('sheet', showCloneForm && 'visible')}>
            <div className="sheet-handle">
              <div className="sheet-handle-bar" />
            </div>
            <div className="px-5 pb-4">
              <h3 className="font-display text-heading text-sumi-black mb-4">Clone Repository</h3>
              <form onSubmit={handleClone} className="space-y-3">
                <div>
                  <label className="section-title block mb-2">GitHub URL</label>
                  <input
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                    placeholder="https://github.com/owner/repo"
                    required
                  />
                </div>

                {cloneRepo.error && (
                  <div className="flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
                    <AlertTriangle size={15} className="mt-0.5" />
                    <span>{cloneRepo.error instanceof Error ? cloneRepo.error.message : 'Failed to clone repository'}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={cloneRepo.isPending}
                  className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
                >
                  {cloneRepo.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {cloneRepo.isPending ? 'Cloning...' : 'Clone'}
                </button>
              </form>
            </div>
          </div>
        </>
      ) : (
        showCloneForm && (
          <form onSubmit={handleClone} className="mt-5 card-sumi p-4 space-y-3">
            <div>
              <label className="section-title block mb-2">GitHub URL</label>
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                placeholder="https://github.com/owner/repo"
                required
              />
            </div>

            {cloneRepo.error && (
              <div className="flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
                <AlertTriangle size={15} className="mt-0.5" />
                <span>{cloneRepo.error instanceof Error ? cloneRepo.error.message : 'Failed to clone repository'}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={cloneRepo.isPending}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {cloneRepo.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {cloneRepo.isPending ? 'Cloning...' : 'Clone'}
            </button>
          </form>
        )
      )}

      {deleteRepo.error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
          <AlertTriangle size={15} className="mt-0.5" />
          <span>{deleteRepo.error instanceof Error ? deleteRepo.error.message : 'Failed to delete repository'}</span>
        </div>
      )}

      <div className="mt-6 space-y-3">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
          </div>
        ) : repos?.length === 0 ? (
          <div className="text-center py-12 text-sumi-diluted text-sm">
            No repos cloned yet
          </div>
        ) : (
          repos?.map((repo) => (
            <RepoCard
              key={`${repo.owner}/${repo.repo}`}
              repo={repo}
              selected={selectedRepo?.owner === repo.owner && selectedRepo?.repo === repo.repo}
              onSelect={() =>
                setSelectedRepo(
                  selectedRepo?.owner === repo.owner && selectedRepo?.repo === repo.repo
                    ? null
                    : { owner: repo.owner, repo: repo.repo },
                )
              }
              onDelete={() => handleDeleteRepo(repo.owner, repo.repo)}
              onSync={() => handleSyncRepo(repo.owner, repo.repo)}
              isSyncing={syncRepo.isPending && syncRepo.variables?.owner === repo.owner && syncRepo.variables?.repo === repo.repo}
            />
          ))
        )}
      </div>

      {selectedRepo && (
        <WorktreeSection owner={selectedRepo.owner} repo={selectedRepo.repo} />
      )}

      {repos && (
        <div className="mt-6 py-3 border-t border-ink-border">
          <p className="text-whisper text-sumi-mist">
            {repos.length} repo{repos.length !== 1 ? 's' : ''} &middot; auto-refreshing
          </p>
        </div>
      )}
    </div>
  )
}
