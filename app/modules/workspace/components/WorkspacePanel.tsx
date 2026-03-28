import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, GitBranch, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceTreeNode } from '../types'
import {
  fetchWorkspaceExpandedTree,
  fetchWorkspaceTree,
  getWorkspaceSourceKey,
  useWorkspaceActions,
  useWorkspaceFilePreview,
  useWorkspaceGitLog,
  useWorkspaceGitStatus,
  type WorkspaceSource,
} from '../use-workspace'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { WorkspaceGitPanel } from './WorkspaceGitPanel'
import { WorkspaceToolbar } from './WorkspaceToolbar'
import { WorkspaceTree } from './WorkspaceTree'

function getParentPath(relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean)
  segments.pop()
  return segments.join('/')
}

function joinWorkspacePath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name
}

function findNode(
  nodesByParent: Record<string, WorkspaceTreeNode[]>,
  relativePath: string | null,
): WorkspaceTreeNode | null {
  if (!relativePath) {
    return null
  }

  for (const nodes of Object.values(nodesByParent)) {
    const match = nodes.find((node) => node.path === relativePath)
    if (match) {
      return match
    }
  }

  return null
}

export function WorkspacePanel({
  source,
  position = 'embedded',
  variant = 'light',
  onClose,
  onInsertPath,
  refreshToken = 0,
}: {
  source: WorkspaceSource
  position?: 'side' | 'compact' | 'embedded'
  variant?: 'light' | 'dark'
  onClose?: () => void
  onInsertPath?: (path: string) => void
  refreshToken?: number
}) {
  const dark = variant === 'dark'
  const sourceKey = getWorkspaceSourceKey(source)
  const actions = useWorkspaceActions(source)
  const [isOpen, setIsOpen] = useState(position !== 'compact')
  const [activeTab, setActiveTab] = useState<'files' | 'changes'>('files')
  const [nodesByParent, setNodesByParent] = useState<Record<string, WorkspaceTreeNode[]>>({})
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [draftContent, setDraftContent] = useState('')
  const [isInitializingGit, setIsInitializingGit] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const previewQuery = useWorkspaceFilePreview(
    source,
    selectedPath && findNode(nodesByParent, selectedPath)?.type === 'file' ? selectedPath : null,
    isOpen && activeTab === 'files',
  )
  const gitStatusQuery = useWorkspaceGitStatus(source, isOpen && activeTab === 'changes')
  const gitLogQuery = useWorkspaceGitLog(source, isOpen && activeTab === 'changes')

  const selectedNode = useMemo(() => findNode(nodesByParent, selectedPath), [nodesByParent, selectedPath])
  const currentDirectoryPath = useMemo(() => {
    if (!selectedNode) {
      return ''
    }
    return selectedNode.type === 'directory'
      ? selectedNode.path
      : getParentPath(selectedNode.path)
  }, [selectedNode])

  useEffect(() => {
    setNodesByParent({})
    setExpandedPaths(new Set())
    setLoadingPaths(new Set())
    setSelectedPath(null)
    setDraftContent('')
    setPanelError(null)
    setActiveTab('files')
  }, [sourceKey])

  useEffect(() => {
    const nextContent = previewQuery.data?.kind === 'text'
      ? previewQuery.data.content ?? ''
      : ''
    setDraftContent(nextContent)
  }, [previewQuery.data?.content, previewQuery.data?.kind])

  async function loadDirectory(parentPath = '', expand = false): Promise<void> {
    setLoadingPaths((prev) => new Set(prev).add(parentPath))
    setPanelError(null)
    try {
      const response = expand
        ? await fetchWorkspaceExpandedTree(source, parentPath)
        : await fetchWorkspaceTree(source, parentPath)
      setNodesByParent((prev) => ({
        ...prev,
        [response.parentPath]: response.nodes,
      }))
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : 'Failed to load workspace')
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev)
        next.delete(parentPath)
        return next
      })
    }
  }

  async function refreshWorkspace(): Promise<void> {
    const pathsToRefresh = new Set(['', ...expandedPaths])
    await Promise.all([...pathsToRefresh].map((path) => loadDirectory(path, path !== '')))
    const refreshTasks: Array<Promise<unknown>> = []
    if (selectedPath && selectedNode?.type === 'file') {
      refreshTasks.push(previewQuery.refetch())
    }
    if (activeTab === 'changes') {
      refreshTasks.push(gitStatusQuery.refetch(), gitLogQuery.refetch())
    }
    if (refreshTasks.length > 0) {
      await Promise.all(refreshTasks)
    }
  }

  useEffect(() => {
    if (!isOpen) {
      return
    }
    if (!nodesByParent['']) {
      void loadDirectory('')
    }
  }, [isOpen, nodesByParent, sourceKey])

  useEffect(() => {
    if (!isOpen) {
      return
    }
    void refreshWorkspace()
  }, [refreshToken])

  async function runBusyTask(label: string, task: () => Promise<void>): Promise<void> {
    setBusyLabel(label)
    setPanelError(null)
    try {
      await task()
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : 'Workspace action failed')
    } finally {
      setBusyLabel(null)
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

  function promptForName(label: string): string | null {
    if (typeof window === 'undefined') {
      return null
    }
    const value = window.prompt(label)
    return value?.trim() || null
  }

  async function handleCreateFile(): Promise<void> {
    const name = promptForName('New file name')
    if (!name) {
      return
    }
    await runBusyTask('Creating file…', async () => {
      const nextPath = joinWorkspacePath(currentDirectoryPath, name)
      await actions.createFile(nextPath)
      setSelectedPath(nextPath)
      await refreshWorkspace()
    })
  }

  async function handleCreateFolder(): Promise<void> {
    const name = promptForName('New folder name')
    if (!name) {
      return
    }
    await runBusyTask('Creating folder…', async () => {
      const nextPath = joinWorkspacePath(currentDirectoryPath, name)
      await actions.createFolder(nextPath)
      setExpandedPaths((prev) => new Set(prev).add(nextPath))
      await refreshWorkspace()
    })
  }

  async function handleSave(): Promise<void> {
    if (!selectedPath) {
      return
    }
    await runBusyTask('Saving file…', async () => {
      await actions.saveFile(selectedPath, draftContent)
      await previewQuery.refetch()
    })
  }

  async function handleRename(): Promise<void> {
    if (!selectedNode) {
      return
    }
    const nextName = promptForName(`Rename ${selectedNode.name} to`)
    if (!nextName || nextName === selectedNode.name) {
      return
    }
    await runBusyTask('Renaming…', async () => {
      const nextPath = joinWorkspacePath(getParentPath(selectedNode.path), nextName)
      await actions.renamePath(selectedNode.path, nextPath)
      setSelectedPath(nextPath)
      await refreshWorkspace()
    })
  }

  async function handleDelete(): Promise<void> {
    if (!selectedNode || typeof window === 'undefined') {
      return
    }
    const confirmed = window.confirm(`Delete "${selectedNode.path}"?`)
    if (!confirmed) {
      return
    }
    await runBusyTask('Deleting…', async () => {
      await actions.deletePath(selectedNode.path)
      setSelectedPath(null)
      await refreshWorkspace()
    })
  }

  async function handleUpload(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) {
      return
    }
    await runBusyTask('Uploading…', async () => {
      await actions.uploadFiles(currentDirectoryPath, files)
      await refreshWorkspace()
    })
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  async function handleInitGit(): Promise<void> {
    setIsInitializingGit(true)
    try {
      await actions.initGit()
      await refreshWorkspace()
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : 'Failed to initialize Git')
    } finally {
      setIsInitializingGit(false)
    }
  }

  const compactHeader = (
    <button
      type="button"
      onClick={() => setIsOpen((prev) => !prev)}
      className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
    >
      <FolderOpen size={14} className={dark ? 'text-white/40' : 'text-sumi-diluted'} />
      <span className={cn('flex-1 truncate font-mono text-xs', dark ? 'text-white/70' : 'text-sumi-gray')}>
        Workspace
      </span>
      <span className={cn('text-whisper', dark ? 'text-white/35' : 'text-sumi-mist')}>
        {isOpen ? 'Hide' : 'Show'}
      </span>
    </button>
  )

  const panelBody = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className={cn('flex items-center justify-between gap-3 border-b px-3 py-2.5', dark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-ink-border bg-washi-aged/60')}>
        <div className="min-w-0">
          <p className={cn('font-mono text-xs uppercase tracking-wide', dark ? 'text-white/45' : 'text-sumi-diluted')}>
            Workspace
          </p>
          <p className={cn('truncate text-sm', dark ? 'text-white/80' : 'text-sumi-black')}>
            {sourceKey}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={cn('rounded-md px-2 py-1 text-xs transition-colors', activeTab === 'files' ? 'bg-sumi-black text-washi-aged' : 'hover:bg-ink-wash text-sumi-diluted')}
            onClick={() => setActiveTab('files')}
          >
            Files
          </button>
          <button
            type="button"
            className={cn('rounded-md px-2 py-1 text-xs transition-colors', activeTab === 'changes' ? 'bg-sumi-black text-washi-aged' : 'hover:bg-ink-wash text-sumi-diluted')}
            onClick={() => setActiveTab('changes')}
          >
            <span className="inline-flex items-center gap-1">
              <GitBranch size={12} />
              Changes
            </span>
          </button>
          {onClose && (
            <button type="button" className="rounded-md p-1.5 hover:bg-ink-wash" onClick={onClose} aria-label="Close workspace">
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {panelError && (
        <div className="border-b border-accent-vermillion/20 bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
          {panelError}
        </div>
      )}

      {activeTab === 'files' ? (
        <>
          <WorkspaceToolbar
            readOnly={Boolean(source.readOnly)}
            currentDirectoryPath={currentDirectoryPath}
            selectedPath={selectedPath}
            busyLabel={busyLabel}
            variant={variant}
            onRefresh={() => void refreshWorkspace()}
            onUpload={() => fileInputRef.current?.click()}
            onNewFile={() => void handleCreateFile()}
            onNewFolder={() => void handleCreateFolder()}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => void handleUpload(event.target.files)}
          />
          <div className={cn('grid flex-1 min-h-0 gap-3 p-3', position === 'embedded' ? 'xl:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]' : 'grid-cols-1')}>
            <div className={cn('min-h-0 overflow-auto rounded-lg border', dark ? 'border-white/[0.08] bg-[#1b1b1b]' : 'border-ink-border bg-washi-white')}>
              {nodesByParent[''] ? (
                <div className="p-2">
                  <WorkspaceTree
                    nodesByParent={nodesByParent}
                    expandedPaths={expandedPaths}
                    loadingPaths={loadingPaths}
                    selectedPath={selectedPath}
                    onSelectPath={setSelectedPath}
                    onToggleDirectory={(path) => void handleToggleDirectory(path)}
                    variant={variant}
                  />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-sumi-diluted">
                  <Loader2 size={16} className="mr-2 animate-spin" />
                  Loading workspace…
                </div>
              )}
            </div>
            <div className="min-h-0">
              <WorkspaceFilePreview
                selectedPath={selectedPath}
                preview={previewQuery.data ?? null}
                draftContent={draftContent}
                loading={previewQuery.isLoading || previewQuery.isFetching}
                error={previewQuery.error instanceof Error ? previewQuery.error.message : null}
                readOnly={Boolean(source.readOnly)}
                saving={busyLabel === 'Saving file…'}
                onDraftChange={setDraftContent}
                onSave={() => void handleSave()}
                onRename={() => void handleRename()}
                onDelete={() => void handleDelete()}
                onInsertPath={onInsertPath}
                variant={variant}
              />
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 min-h-0 p-3">
          <WorkspaceGitPanel
            status={gitStatusQuery.data ?? null}
            log={gitLogQuery.data ?? null}
            loading={gitStatusQuery.isLoading || gitStatusQuery.isFetching || gitLogQuery.isLoading || gitLogQuery.isFetching}
            error={
              (gitStatusQuery.error instanceof Error ? gitStatusQuery.error.message : null) ??
              (gitLogQuery.error instanceof Error ? gitLogQuery.error.message : null)
            }
            readOnly={Boolean(source.readOnly)}
            onInit={source.readOnly ? undefined : () => void handleInitGit()}
            initializing={isInitializingGit}
            variant={variant}
          />
        </div>
      )}
    </div>
  )

  if (position === 'compact') {
    return (
      <div className={cn('border-b', dark ? 'border-white/[0.08] bg-[#242424]' : 'border-ink-border bg-washi-aged')}>
        {compactHeader}
        {isOpen && <div className="h-[32rem] max-h-[70vh]">{panelBody}</div>}
      </div>
    )
  }

  return (
    <div
      className={cn(
        position === 'side'
          ? 'w-80 border-l'
          : 'h-full min-h-[28rem] rounded-xl border',
        dark
          ? 'border-white/[0.08] bg-[#242424]'
          : 'border-ink-border bg-washi-aged',
      )}
    >
      {panelBody}
    </div>
  )
}
