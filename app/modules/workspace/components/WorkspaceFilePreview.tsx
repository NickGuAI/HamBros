import { FileCode2, FileImage, FileWarning, Loader2, Pencil, Save, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceFilePreview as WorkspaceFilePreviewData } from '../types'

interface WorkspaceFilePreviewProps {
  selectedPath: string | null
  preview: WorkspaceFilePreviewData | null
  draftContent: string
  error?: string | null
  loading?: boolean
  readOnly?: boolean
  saving?: boolean
  onDraftChange: (value: string) => void
  onSave: () => void
  onRename: () => void
  onDelete: () => void
  onInsertPath?: (path: string) => void
  variant?: 'light' | 'dark'
}

export function WorkspaceFilePreview({
  selectedPath,
  preview,
  draftContent,
  error,
  loading = false,
  readOnly = false,
  saving = false,
  onDraftChange,
  onSave,
  onRename,
  onDelete,
  onInsertPath,
  variant = 'light',
}: WorkspaceFilePreviewProps) {
  const dark = variant === 'dark'

  if (!selectedPath) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center rounded-lg border border-dashed text-sm',
          dark
            ? 'border-white/[0.08] text-white/45'
            : 'border-ink-border text-sumi-diluted',
        )}
      >
        Select a file to preview it
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-sumi-diluted">
        <Loader2 size={16} className="mr-2 animate-spin" />
        Loading preview…
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

  if (!preview) {
    return null
  }

  return (
    <div className={cn('h-full min-h-0 rounded-lg border flex flex-col overflow-hidden', dark ? 'border-white/[0.08] bg-[#1b1b1b]' : 'border-ink-border bg-washi-white')}>
      <div className={cn('flex items-center justify-between gap-3 border-b px-3 py-2', dark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-ink-border bg-washi-aged/60')}>
        <div className="min-w-0">
          <p className={cn('truncate font-mono text-xs', dark ? 'text-white/75' : 'text-sumi-gray')}>
            {preview.path}
          </p>
          <p className={cn('text-whisper', dark ? 'text-white/45' : 'text-sumi-diluted')}>
            {preview.kind} • {preview.size} bytes
          </p>
        </div>
        <div className="flex items-center gap-1">
          {onInsertPath && (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs hover:bg-ink-wash"
              onClick={() => onInsertPath(preview.path)}
            >
              Insert Path
            </button>
          )}
          {!readOnly && (
            <>
              <button type="button" className="rounded-md p-1.5 hover:bg-ink-wash" onClick={onRename} aria-label="Rename file">
                <Pencil size={13} />
              </button>
              <button type="button" className="rounded-md p-1.5 text-accent-vermillion hover:bg-accent-vermillion/10" onClick={onDelete} aria-label="Delete file">
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {preview.kind === 'image' && preview.content && (
        <div className="flex-1 min-h-0 overflow-auto p-4">
          <div className="mb-3 flex items-center gap-2 text-sm text-sumi-diluted">
            <FileImage size={15} />
            Image preview
          </div>
          <img src={preview.content} alt={preview.name} className="max-w-full rounded-lg border border-ink-border" />
        </div>
      )}

      {preview.kind === 'binary' && (
        <div className="flex flex-1 items-center justify-center px-4 text-sm text-sumi-diluted">
          <FileWarning size={16} className="mr-2" />
          Binary file preview is not available
        </div>
      )}

      {preview.kind === 'text' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 text-whisper text-sumi-diluted">
            <div className="flex items-center gap-2">
              <FileCode2 size={13} />
              <span>{preview.truncated ? 'Preview truncated to 256KB' : 'Editable text preview'}</span>
            </div>
            {!readOnly && (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-ink-border px-2 py-1 text-xs hover:bg-ink-wash disabled:opacity-60"
                onClick={onSave}
                disabled={saving}
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Save
              </button>
            )}
          </div>
          <textarea
            className={cn(
              'flex-1 min-h-[14rem] resize-none border-t p-3 font-mono text-xs outline-none',
              dark
                ? 'border-white/[0.08] bg-[#121212] text-white/80'
                : 'border-ink-border bg-washi-white text-sumi-gray',
            )}
            value={draftContent}
            onChange={(event) => onDraftChange(event.target.value)}
            readOnly={readOnly}
          />
        </div>
      )}
    </div>
  )
}
