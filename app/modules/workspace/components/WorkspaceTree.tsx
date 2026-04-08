import { Check, ChevronRight, FileText, Folder, FolderOpen, Loader2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceTreeNode } from '../types'

interface WorkspaceTreeProps {
  nodesByParent: Record<string, WorkspaceTreeNode[]>
  expandedPaths: Set<string>
  loadingPaths: Set<string>
  addedPaths?: Set<string>
  selectedPath: string | null
  variant?: 'light' | 'dark'
  onSelectPath: (path: string) => void
  onToggleDirectory: (path: string) => void
  onAddPath?: (path: string) => void
  selectDirectoriesOnClick?: boolean
}

function TreeBranch({
  parentPath,
  depth,
  nodesByParent,
  expandedPaths,
  loadingPaths,
  addedPaths,
  selectedPath,
  variant = 'light',
  onSelectPath,
  onToggleDirectory,
  onAddPath,
  selectDirectoriesOnClick = true,
}: WorkspaceTreeProps & {
  parentPath: string
  depth: number
}) {
  const nodes = nodesByParent[parentPath] ?? []
  const dark = variant === 'dark'

  return (
    <>
      {nodes.map((node) => {
        const isDirectory = node.type === 'directory'
        const isExpanded = expandedPaths.has(node.path)
        const isSelected = selectedPath === node.path
        const isLoading = loadingPaths.has(node.path)
        const isAdded = addedPaths?.has(node.path) ?? false

        return (
          <div key={node.path}>
            <div className="flex w-full items-center gap-1">
              <button
                type="button"
                className={cn(
                  'flex-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  dark
                    ? 'hover:bg-white/[0.06]'
                    : 'hover:bg-ink-wash',
                  isSelected && (dark ? 'bg-white/[0.08]' : 'bg-ink-wash/80'),
                  isAdded && 'ring-1 ring-emerald-500/40',
                )}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                onClick={() => {
                  if (isDirectory) {
                    if (selectDirectoriesOnClick) {
                      onSelectPath(node.path)
                    }
                    onToggleDirectory(node.path)
                    return
                  }
                  onSelectPath(node.path)
                }}
              >
                {isDirectory ? (
                  <>
                    <ChevronRight
                      size={12}
                      className={cn(
                        'shrink-0 transition-transform',
                        dark ? 'text-white/40' : 'text-sumi-mist',
                        isExpanded && 'rotate-90',
                      )}
                    />
                    {isExpanded ? (
                      <FolderOpen size={13} className={dark ? 'text-white/50' : 'text-sumi-diluted'} />
                    ) : (
                      <Folder size={13} className={dark ? 'text-white/50' : 'text-sumi-diluted'} />
                    )}
                  </>
                ) : (
                  <>
                    <span className="w-3 shrink-0" />
                    <FileText size={13} className={dark ? 'text-white/40' : 'text-sumi-diluted'} />
                  </>
                )}
                <span className={cn('font-mono truncate', dark ? 'text-white/75' : 'text-sumi-gray')}>
                  {node.name}
                </span>
              </button>

              {onAddPath && (
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors',
                    isAdded
                      ? 'text-emerald-700 bg-emerald-100 hover:bg-emerald-200'
                      : 'text-sumi-diluted hover:bg-ink-wash',
                  )}
                  onClick={(event) => {
                    event.stopPropagation()
                    onAddPath(node.path)
                  }}
                  aria-label={isAdded ? `Added ${node.path}` : `Add ${node.path} to context`}
                >
                  {isAdded ? <Check size={11} /> : <Plus size={11} />}
                  {isAdded ? 'Added' : 'Add'}
                </button>
              )}

              {isLoading && <Loader2 size={12} className="shrink-0 animate-spin text-sumi-diluted" />}
            </div>

            {isDirectory && isExpanded && (
              <TreeBranch
                parentPath={node.path}
                depth={depth + 1}
                nodesByParent={nodesByParent}
                expandedPaths={expandedPaths}
                loadingPaths={loadingPaths}
                addedPaths={addedPaths}
                selectedPath={selectedPath}
                variant={variant}
                onSelectPath={onSelectPath}
                onToggleDirectory={onToggleDirectory}
                onAddPath={onAddPath}
                selectDirectoriesOnClick={selectDirectoriesOnClick}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

export function WorkspaceTree(props: WorkspaceTreeProps) {
  const rootNodes = props.nodesByParent[''] ?? []
  const dark = props.variant === 'dark'

  if (rootNodes.length === 0) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center rounded-lg border border-dashed text-sm',
          dark
            ? 'border-white/[0.08] text-white/45'
            : 'border-ink-border text-sumi-diluted',
        )}
      >
        Workspace is empty
      </div>
    )
  }

  return <TreeBranch {...props} parentPath="" depth={0} />
}
