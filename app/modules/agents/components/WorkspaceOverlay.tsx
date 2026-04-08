import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, FolderOpen, GitBranch, GitCommitHorizontal, Loader2, Plus, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceFilePreview as WorkspaceFilePreviewData, WorkspaceTreeNode } from '../../workspace/types'
import {
  fetchWorkspaceExpandedTree,
  fetchWorkspaceTree,
  getWorkspaceSourceKey,
  useWorkspaceFilePreview,
  useWorkspaceGitLog,
  useWorkspaceGitStatus,
  type WorkspaceSource,
} from '../../workspace/use-workspace'
import { WorkspaceFilePreview } from '../../workspace/components/WorkspaceFilePreview'
import { WorkspaceTree } from '../../workspace/components/WorkspaceTree'

interface WorkspaceOverlayProps {
  open: boolean
  onClose: () => void
  onSelectFile: (filePath: string) => void
  source: WorkspaceSource
}

type OverlayTab = 'files' | 'changes' | 'log'

function findNodeByPath(
  nodesByParent: Record<string, WorkspaceTreeNode[]>,
  path: string | null,
): WorkspaceTreeNode | null {
  if (!path) {
    return null
  }

  for (const nodes of Object.values(nodesByParent)) {
    const match = nodes.find((node) => node.path === path)
    if (match) {
      return match
    }
  }

  return null
}

interface PreviewPopupProps {
  open: boolean
  selectedPath: string | null
  preview: WorkspaceFilePreviewData | null
  draftContent: string
  loading: boolean
  error: string | null
  onClose: () => void
}

function PreviewPopup({
  open,
  selectedPath,
  preview,
  draftContent,
  loading,
  error,
  onClose,
}: PreviewPopupProps) {
  const desktopPanelRef = useRef<HTMLDivElement>(null)
  const mobilePanelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }
      if (
        desktopPanelRef.current?.contains(target) ||
        mobilePanelRef.current?.contains(target)
      ) {
        return
      }
      onClose()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
    }
  }, [open, onClose])

  if (!open || !selectedPath) {
    return null
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] md:pointer-events-none">
      <div className="absolute inset-0 bg-sumi-black/30 md:bg-sumi-black/15" />

      <div className="hidden md:flex absolute inset-0 items-center justify-center p-5">
        <div
          ref={desktopPanelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Workspace file preview"
          className="pointer-events-auto flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-ink-border bg-washi-white shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-ink-border px-3 py-2">
            <span className="font-mono text-xs text-sumi-gray">Preview</span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-sumi-diluted hover:bg-ink-wash transition-colors"
              aria-label="Close preview"
            >
              <X size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 p-3">
            <WorkspaceFilePreview
              selectedPath={selectedPath}
              preview={preview}
              draftContent={draftContent}
              loading={loading}
              error={error}
              readOnly
            />
          </div>
        </div>
      </div>

      <div className="md:hidden absolute inset-x-0 bottom-0 px-2 pb-2 pt-8">
        <div
          ref={mobilePanelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Workspace file preview"
          className="flex max-h-[90dvh] min-h-[50dvh] flex-col overflow-hidden rounded-2xl border border-ink-border bg-washi-white shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-ink-border px-3 py-2">
            <span className="font-mono text-xs text-sumi-gray">Preview</span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-sumi-diluted hover:bg-ink-wash transition-colors"
              aria-label="Close preview"
            >
              <X size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 p-2">
            <WorkspaceFilePreview
              selectedPath={selectedPath}
              preview={preview}
              draftContent={draftContent}
              loading={loading}
              error={error}
              readOnly
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

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
  const [addedPaths, setAddedPaths] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const addFeedbackTimersRef = useRef<number[]>([])
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedNode = useMemo(
    () => findNodeByPath(nodesByParent, selectedPath),
    [nodesByParent, selectedPath],
  )

  const previewQuery = useWorkspaceFilePreview(
    source,
    selectedNode?.type === 'file' ? selectedNode.path : null,
    open && activeTab === 'files',
  )
  const gitStatusQuery = useWorkspaceGitStatus(source, open && activeTab === 'changes')
  const gitLogQuery = useWorkspaceGitLog(source, open && activeTab === 'log')

  const clearAddFeedbackTimers = useCallback(() => {
    for (const timerId of addFeedbackTimersRef.current) {
      window.clearTimeout(timerId)
    }
    addFeedbackTimersRef.current = []
  }, [])

  // Auto-focus search on open
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus())
    } else {
      setQuery('')
      setSelectedPath(null)
      setAddedPaths(new Set())
      clearAddFeedbackTimers()
    }
  }, [open, clearAddFeedbackTimers])

  // Reset tree when source changes
  useEffect(() => {
    setNodesByParent({})
    setExpandedPaths(new Set())
    setLoadingPaths(new Set())
    setAddedPaths(new Set())
    setSelectedPath(null)
    setActiveTab('files')
    clearAddFeedbackTimers()
  }, [sourceKey, clearAddFeedbackTimers])

  useEffect(() => () => clearAddFeedbackTimers(), [clearAddFeedbackTimers])

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

  function handlePreviewPath(path: string) {
    setSelectedPath(path)
  }

  function handleAddPath(path: string, knownType?: WorkspaceTreeNode['type']) {
    const nodeType = knownType ?? findNodeByPath(nodesByParent, path)?.type
    const isDirectory = nodeType === 'directory'
    onSelectFile(isDirectory ? `${path}/` : path)
    setAddedPaths((prev) => new Set(prev).add(path))

    const timerId = window.setTimeout(() => {
      setAddedPaths((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }, 1200)
    addFeedbackTimersRef.current.push(timerId)
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

  const selectedPreviewPath =
    activeTab === 'files' && selectedNode?.type === 'file' ? selectedPath : null
  const closePreview = useCallback(() => {
    setSelectedPath(null)
  }, [])

  // Escape to close
  useEffect(() => {
    if (!open) {
      return
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (selectedPreviewPath) {
          closePreview()
          return
        }
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, selectedPreviewPath, closePreview])

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
              <div className="flex h-full min-h-[200px] flex-col gap-3 overflow-y-auto">
                {filteredNodesByParent[''] ? (
                  <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-ink-border bg-washi-white p-2">
                    <WorkspaceTree
                      nodesByParent={filteredNodesByParent}
                      expandedPaths={expandedPaths}
                      loadingPaths={loadingPaths}
                      addedPaths={addedPaths}
                      selectedPath={selectedPath}
                      onSelectPath={handlePreviewPath}
                      onToggleDirectory={(path) => void handleToggleDirectory(path)}
                      onAddPath={handleAddPath}
                      selectDirectoriesOnClick={false}
                    />
                  </div>
                ) : (
                  <div className="flex flex-1 items-center justify-center py-8 text-sm text-sumi-diluted">
                    <Loader2 size={16} className="mr-2 animate-spin" />
                    Loading workspace...
                  </div>
                )}
              </div>
            )}

            {activeTab === 'changes' && (
              <div className="h-full min-h-[200px] overflow-y-auto">
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
                          <div
                            key={entry.path}
                            className={cn(
                              'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                              addedPaths.has(entry.path) ? 'bg-emerald-50' : 'hover:bg-ink-wash',
                            )}
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
                            <button
                              type="button"
                              className={cn(
                                'ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors',
                                addedPaths.has(entry.path)
                                  ? 'text-emerald-700 bg-emerald-100 hover:bg-emerald-200'
                                  : 'text-sumi-diluted hover:bg-ink-wash',
                              )}
                              onClick={() => handleAddPath(entry.path, 'file')}
                              aria-label={addedPaths.has(entry.path) ? `Added ${entry.path}` : `Add ${entry.path} to context`}
                            >
                              {addedPaths.has(entry.path) ? <Check size={11} /> : <Plus size={11} />}
                              {addedPaths.has(entry.path) ? 'Added' : 'Add'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}

            {activeTab === 'log' && (
              <div className="h-full min-h-[200px] overflow-y-auto">
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

      <PreviewPopup
        open={activeTab === 'files' && Boolean(selectedPreviewPath)}
        selectedPath={selectedPreviewPath}
        preview={previewQuery.data ?? null}
        draftContent={previewQuery.data?.kind === 'text' ? previewQuery.data.content ?? '' : ''}
        loading={previewQuery.isLoading || previewQuery.isFetching}
        error={previewQuery.error instanceof Error ? previewQuery.error.message : null}
        onClose={closePreview}
      />
    </>,
    document.body,
  )
}
