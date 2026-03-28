import { ChevronRight, FileText, Folder, FolderOpen, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceTreeNode } from '../types'

interface WorkspaceTreeProps {
  nodesByParent: Record<string, WorkspaceTreeNode[]>
  expandedPaths: Set<string>
  loadingPaths: Set<string>
  selectedPath: string | null
  variant?: 'light' | 'dark'
  onSelectPath: (path: string) => void
  onToggleDirectory: (path: string) => void
}

function TreeBranch({
  parentPath,
  depth,
  nodesByParent,
  expandedPaths,
  loadingPaths,
  selectedPath,
  variant = 'light',
  onSelectPath,
  onToggleDirectory,
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

        return (
          <div key={node.path}>
            <button
              type="button"
              className={cn(
                'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                dark
                  ? 'hover:bg-white/[0.06]'
                  : 'hover:bg-ink-wash',
                isSelected && (dark ? 'bg-white/[0.08]' : 'bg-ink-wash/80'),
              )}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={() => {
                if (isDirectory) {
                  onToggleDirectory(node.path)
                } else {
                  onSelectPath(node.path)
                }
              }}
              onDoubleClick={() => {
                if (isDirectory) {
                  onSelectPath(node.path)
                }
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
              {isLoading && <Loader2 size={12} className="ml-auto shrink-0 animate-spin text-sumi-diluted" />}
            </button>

            {isDirectory && isExpanded && (
              <TreeBranch
                parentPath={node.path}
                depth={depth + 1}
                nodesByParent={nodesByParent}
                expandedPaths={expandedPaths}
                loadingPaths={loadingPaths}
                selectedPath={selectedPath}
                variant={variant}
                onSelectPath={onSelectPath}
                onToggleDirectory={onToggleDirectory}
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
