import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, GitBranch, GitCommitHorizontal, Loader2, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceTreeNode } from '../../workspace/types'
import {
  fetchWorkspaceExpandedTree,
  fetchWorkspaceTree,
  getWorkspaceSourceKey,
  useWorkspaceGitLog,
  useWorkspaceGitStatus,
  type WorkspaceSource,
} from '../../workspace/use-workspace'
import { WorkspaceTree } from '../../workspace/components/WorkspaceTree'

interface WorkspaceOverlayProps {
  open: boolean
  onClose: () => void
  onSelectFile: (filePath: string) => void
  source: WorkspaceSource
}

type OverlayTab = 'files' | 'changes' | 'log'

export function WorkspaceOverlay({
  open,
  onClose,
  onSelectFile,
  source,
}: WorkspaceOverlayProps) {
  const sourceKey = getWorkspaceSourceKey(source)
  const [activeTab, setActiveTab] = useState<OverlayTab>('files')
  const [query, setQuery] = useState('')
  const [nodesByParent, setNodesByParent] = useState<Record<string, WorkspaceTreeNode[]>>({})
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const gitStatusQuery = useWorkspaceGitStatus(source, open && activeTab === 'changes')
  const gitLogQuery = useWorkspaceGitLog(source, open && activeTab === 'log')

  // Auto-focus search on open
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus())
    } else {
      setQuery('')
      setSelectedPath(null)
    }
  }, [open])

  // Reset tree when source changes
  useEffect(() => {
    setNodesByParent({})
    setExpandedPaths(new Set())
    setLoadingPaths(new Set())
    setSelectedPath(null)
    setActiveTab('files')
  }, [sourceKey])

  // Load root directory on open
  useEffect(() => {
    if (!open || nodesByParent['']) {
      return
    }
    void loadDirectory('')
  }, [open, sourceKey])

  async function loadDirectory(parentPath = '', expand = false): Promise<void> {
    setLoadingPaths((prev) => new Set(prev).add(parentPath))
    try {
      const response = expand
        ? await fetchWorkspaceExpandedTree(source, parentPath)
        : await fetchWorkspaceTree(source, parentPath)
      setNodesByParent((prev) => ({
        ...prev,
        [response.parentPath]: response.nodes,
      }))
    } catch {
      // Silently fail — user can retry by collapsing/expanding
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev)
        next.delete(parentPath)
        return next
      })
    }
  }

  async function handleToggleDirectory(relativePath: string): Promise<void> {
    const isExpanded = expandedPaths.has(relativePath)
    if (isExpanded) {
      setExpandedPaths((prev) => {
        const next = new Set(prev)
        next.delete(relativePath)
        return next
      })
      return
    }

    setExpandedPaths((prev) => new Set(prev).add(relativePath))
    if (!nodesByParent[relativePath]) {
      await loadDirectory(relativePath, true)
    }
  }

  function handleSelectPath(path: string) {
    setSelectedPath(path)
    // Check if this is a directory so we can suffix with '/'
    let isDir = false
    for (const nodes of Object.values(nodesByParent)) {
      const node = nodes.find((n) => n.path === path)
      if (node) {
        isDir = node.type === 'directory'
        break
      }
    }
    onSelectFile(isDir ? `${path}/` : path)
    onClose()
  }

  // Filter file nodes by search query
  const filteredNodesByParent = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return nodesByParent
    }

    // Collect all file nodes that match, preserving their parent structure
    const matchingPaths = new Set<string>()
    for (const [parent, nodes] of Object.entries(nodesByParent)) {
      for (const node of nodes) {
        if (node.name.toLowerCase().includes(normalizedQuery)) {
          matchingPaths.add(parent)
        }
      }
    }

    const result: Record<string, WorkspaceTreeNode[]> = {}
    for (const [parent, nodes] of Object.entries(nodesByParent)) {
      if (matchingPaths.has(parent) || parent === '') {
        result[parent] = nodes.filter(
          (n) =>
            n.type === 'directory' ||
            n.name.toLowerCase().includes(normalizedQuery),
        )
      }
    }
    return result
  }, [nodesByParent, query])

  // Escape to close
  useEffect(() => {
    if (!open) {
      return
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) {
    return null
  }

  const gitStatus = gitStatusQuery.data
  const gitLog = gitLogQuery.data

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[9998] bg-sumi-black/50"
        onClick={onClose}
      />

      {/* Mobile: bottom sheet / Desktop: centered modal */}
      <div className="fixed inset-0 z-[9999] flex items-end md:items-center justify-center md:p-5">
        <div
          className={cn(
            'w-full bg-washi-white overflow-hidden flex flex-col',
            'max-h-[85dvh] rounded-t-2xl md:rounded-xl md:max-w-2xl',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Mobile handle */}
          <div className="md:hidden flex justify-center pt-2 pb-1">
            <div className="w-8 h-1 rounded-full bg-ink-border" />
          </div>

          {/* Header with search */}
          <div className="px-4 pt-2 pb-3 border-b border-ink-border">
            <div className="flex items-center gap-2 mb-3">
              <FolderOpen size={14} className="text-sumi-diluted shrink-0" />
              <span className="flex-1 font-mono text-xs text-sumi-gray truncate">
                Workspace
              </span>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-ink-wash transition-colors"
                aria-label="Close workspace"
              >
                <X size={14} className="text-sumi-diluted" />
              </button>
            </div>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-sumi-mist"
              />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                placeholder="Search files..."
                aria-label="Search workspace files"
              />
            </div>
            <div className="flex gap-1 mt-2">
              {([
                { key: 'files', label: 'Files' },
                { key: 'changes', label: 'Changes' },
                { key: 'log', label: 'Git Log' },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs transition-colors',
                    activeTab === tab.key
                      ? 'bg-sumi-black text-washi-aged'
                      : 'hover:bg-ink-wash text-sumi-diluted',
                  )}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            {activeTab === 'files' && (
              <div className="min-h-[200px]">
                {filteredNodesByParent[''] ? (
                  <WorkspaceTree
                    nodesByParent={filteredNodesByParent}
                    expandedPaths={expandedPaths}
                    loadingPaths={loadingPaths}
                    selectedPath={selectedPath}
                    onSelectPath={handleSelectPath}
                    onToggleDirectory={(path) => void handleToggleDirectory(path)}
                  />
                ) : (
                  <div className="flex items-center justify-center py-8 text-sm text-sumi-diluted">
                    <Loader2 size={16} className="mr-2 animate-spin" />
                    Loading workspace...
                  </div>
                )}
              </div>
            )}

            {activeTab === 'changes' && (
              <div className="min-h-[200px]">
                {gitStatusQuery.isLoading || gitStatusQuery.isFetching ? (
                  <div className="flex items-center justify-center py-8 text-sm text-sumi-diluted">
                    <Loader2 size={16} className="mr-2 animate-spin" />
                    Loading git status...
                  </div>
                ) : gitStatusQuery.error ? (
                  <div className="rounded-lg border border-accent-vermillion/30 bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
                    {gitStatusQuery.error instanceof Error ? gitStatusQuery.error.message : 'Failed to load git status'}
                  </div>
                ) : gitStatus && !gitStatus.enabled ? (
                  <div className="flex flex-col items-center justify-center py-8 text-sm text-sumi-diluted">
                    <GitBranch size={18} className="mb-2" />
                    Git is not initialized
                  </div>
                ) : gitStatus ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-sumi-diluted">
                      <GitBranch size={12} />
                      <span className="font-mono">{gitStatus.branch ?? 'detached'}</span>
                      {gitStatus.ahead > 0 && (
                        <span className="text-emerald-600">+{gitStatus.ahead}</span>
                      )}
                      {gitStatus.behind > 0 && (
                        <span className="text-accent-vermillion">-{gitStatus.behind}</span>
                      )}
                    </div>
                    {gitStatus.entries.length === 0 ? (
                      <p className="text-sm text-sumi-diluted py-4 text-center">
                        Working tree clean
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {gitStatus.entries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-ink-wash transition-colors"
                            onClick={() => {
                              onSelectFile(entry.path)
                              onClose()
                            }}
                          >
                            <span className={cn(
                              'font-mono text-[10px] w-5 shrink-0 text-center',
                              entry.code.includes('M') && 'text-amber-500',
                              entry.code.includes('A') && 'text-emerald-500',
                              entry.code.includes('D') && 'text-accent-vermillion',
                              entry.code.includes('?') && 'text-sumi-mist',
                            )}>
                              {entry.code.trim()}
                            </span>
                            <span className="font-mono text-sumi-gray truncate">
                              {entry.path}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}

            {activeTab === 'log' && (
              <div className="min-h-[200px]">
                {gitLogQuery.isLoading || gitLogQuery.isFetching ? (
                  <div className="flex items-center justify-center py-8 text-sm text-sumi-diluted">
                    <Loader2 size={16} className="mr-2 animate-spin" />
                    Loading git log...
                  </div>
                ) : gitLogQuery.error ? (
                  <div className="rounded-lg border border-accent-vermillion/30 bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
                    {gitLogQuery.error instanceof Error ? gitLogQuery.error.message : 'Failed to load git log'}
                  </div>
                ) : gitLog && !gitLog.enabled ? (
                  <div className="flex flex-col items-center justify-center py-8 text-sm text-sumi-diluted">
                    <GitBranch size={18} className="mb-2" />
                    Git is not initialized
                  </div>
                ) : gitLog ? (
                  <div className="space-y-1">
                    {gitLog.commits.length === 0 ? (
                      <p className="text-sm text-sumi-diluted py-4 text-center">
                        No commits yet
                      </p>
                    ) : (
                      gitLog.commits.map((commit) => (
                        <div
                          key={commit.hash}
                          className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs"
                        >
                          <GitCommitHorizontal size={12} className="text-sumi-mist shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sumi-black truncate">{commit.subject}</p>
                            <p className="text-sumi-diluted font-mono text-[10px]">
                              {commit.shortHash} &middot; {commit.author}
                            </p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
