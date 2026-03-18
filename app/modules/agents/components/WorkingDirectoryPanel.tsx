import { useEffect, useRef, useState } from 'react'
import {
  FolderOpen,
  Folder,
  FileText,
  ChevronRight,
  ChevronUp,
  Plus,
  Upload,
  Loader2,
  X,
} from 'lucide-react'
import { useFiles, uploadFiles } from '@/hooks/use-files'
import { cn } from '@/lib/utils'

export function WorkingDirectoryPanel({
  cwd,
  position = 'side',
  variant = 'light',
  onClose,
  onInsertPath,
}: {
  cwd: string
  position?: 'side' | 'compact'
  variant?: 'light' | 'dark'
  onClose?: () => void
  onInsertPath?: (filePath: string) => void
}) {
  const [browsePath, setBrowsePath] = useState(cwd)
  const [isOpen, setIsOpen] = useState(position === 'side')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setBrowsePath(cwd)
  }, [cwd])

  const { data, refetch } = useFiles(browsePath, isOpen)

  async function handleUploadFiles(files: FileList | File[]) {
    if (!files.length) return
    setUploading(true)
    setUploadError(null)
    try {
      await uploadFiles(browsePath, files)
      await refetch()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      void handleUploadFiles(e.target.files)
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      void handleUploadFiles(e.dataTransfer.files)
    }
  }

  function getFullPath(name: string) {
    return `${browsePath}/${name}`.replace(/\/+/g, '/')
  }

  function handleItemDragStart(e: React.DragEvent, name: string) {
    const fullPath = getFullPath(name)
    e.dataTransfer.setData('text/plain', fullPath)
    e.dataTransfer.effectAllowed = 'copy'
  }

  function handleItemClick(name: string, isDirectory: boolean) {
    if (isDirectory) {
      navigateInto(name)
    } else if (onInsertPath) {
      onInsertPath(getFullPath(name))
    }
  }

  function navigateUp() {
    const parent = browsePath.replace(/\/[^/]+$/, '') || '/'
    if (parent.length >= cwd.length) {
      setBrowsePath(parent)
    }
  }

  function navigateInto(dir: string) {
    setBrowsePath(`${browsePath}/${dir}`.replace(/\/+/g, '/'))
  }

  // Compact mode (mobile): collapsible header
  if (position === 'compact') {
    const dark = variant === 'dark'
    return (
      <div
        className={cn(
          'border-b',
          dark ? 'border-white/[0.08] bg-[#242424]' : 'border-ink-border bg-washi-aged',
          isDragOver && (dark ? 'ring-2 ring-inset ring-white/20' : 'ring-2 ring-inset ring-accent-indigo/30'),
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-left"
        >
          <FolderOpen size={14} className={dark ? 'text-white/40 shrink-0' : 'text-sumi-diluted shrink-0'} />
          <span className={cn('font-mono text-xs truncate flex-1', dark ? 'text-white/60' : 'text-sumi-gray')}>{browsePath}</span>
          <ChevronRight
            size={12}
            className={cn(
              'transition-transform duration-200',
              dark ? 'text-white/30' : 'text-sumi-mist',
              isOpen && 'rotate-90',
            )}
          />
        </button>
        {isOpen && (
          <div className="px-4 pb-3">
            <div className={cn(
              'rounded-lg border max-h-40 overflow-y-auto',
              dark ? 'border-white/[0.08] bg-[#1a1a1a]' : 'border-ink-border bg-washi-white',
            )}>
              {data?.files.map((f) => (
                <div
                  key={f.name}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs"
                >
                  {f.isDirectory ? (
                    <button
                      onClick={() => handleItemClick(f.name, true)}
                      className={cn('flex items-center gap-2 flex-1 text-left transition-colors', dark ? 'hover:text-white/90' : 'hover:text-sumi-black')}
                    >
                      <Folder size={12} className={dark ? 'text-white/30 shrink-0' : 'text-sumi-mist shrink-0'} />
                      <span className={cn('font-mono', dark ? 'text-white/60' : 'text-sumi-gray')}>{f.name}/</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => handleItemClick(f.name, false)}
                      className={cn('flex items-center gap-2 flex-1 text-left', dark ? 'hover:text-white/90' : '')}
                    >
                      <FileText size={12} className={dark ? 'text-white/30 shrink-0' : 'text-sumi-mist shrink-0'} />
                      <span className={cn('font-mono', dark ? 'text-white/60' : 'text-sumi-gray')}>{f.name}</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={navigateUp}
                disabled={browsePath === cwd}
                className={cn(
                  'p-1.5 rounded border transition-colors disabled:opacity-30',
                  dark ? 'border-white/[0.08] bg-[#1a1a1a] hover:bg-white/[0.06]' : 'border-ink-border bg-washi-white hover:bg-ink-wash',
                )}
                aria-label="Parent directory"
              >
                <ChevronUp size={12} className={dark ? 'text-white/50' : ''} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInput}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded border text-xs disabled:opacity-60 transition-colors',
                  dark ? 'border-white/[0.08] bg-[#1a1a1a] hover:bg-white/[0.06] text-white/60' : 'border-ink-border bg-washi-white hover:bg-ink-wash',
                )}
              >
                {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                {uploading ? 'Uploading...' : 'Upload File'}
              </button>
            </div>
            {uploadError && (
              <p className="mt-1 text-xs text-accent-vermillion">{uploadError}</p>
            )}
          </div>
        )}
      </div>
    )
  }

  // Side panel mode (desktop)
  return (
    <div
      className={cn(
        'w-64 border-l border-ink-border bg-washi-aged flex flex-col overflow-hidden transition-all duration-300',
        isDragOver && 'ring-2 ring-inset ring-accent-indigo/30 bg-accent-indigo/5',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-ink-border">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen size={14} className="text-sumi-diluted shrink-0" />
          <span className="font-mono text-xs text-sumi-gray truncate">
            {browsePath.split('/').pop() || '/'}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={navigateUp}
            disabled={browsePath === cwd}
            className="p-1 rounded hover:bg-ink-wash transition-colors disabled:opacity-30"
            aria-label="Parent directory"
          >
            <ChevronUp size={12} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-ink-wash transition-colors"
              aria-label="Close panel"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {data?.files.map((f) => (
          <div
            key={f.name}
            draggable
            onDragStart={(e) => handleItemDragStart(e, f.name)}
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-ink-wash transition-colors cursor-grab active:cursor-grabbing"
          >
            {f.isDirectory ? (
              <button
                onClick={() => handleItemClick(f.name, true)}
                className="flex items-center gap-2 flex-1 text-left"
              >
                <Folder size={13} className="text-sumi-mist shrink-0" />
                <span className="font-mono text-xs text-sumi-black truncate">{f.name}</span>
              </button>
            ) : (
              <button
                onClick={() => handleItemClick(f.name, false)}
                className="flex items-center gap-2 flex-1 text-left min-w-0"
              >
                <FileText size={13} className="text-sumi-mist shrink-0" />
                <span className="font-mono text-xs text-sumi-gray truncate">{f.name}</span>
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Upload area */}
      <div className="border-t border-ink-border p-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInput}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-ink-border bg-washi-white hover:bg-ink-wash transition-colors text-xs text-sumi-diluted disabled:opacity-60"
        >
          {uploading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          {uploading ? 'Uploading...' : 'Upload or Drop Files'}
        </button>
        {uploadError && (
          <p className="mt-1 text-xs text-accent-vermillion">{uploadError}</p>
        )}
        {isDragOver && (
          <div className="mt-2 text-center text-xs text-accent-indigo font-medium">
            Drop files here
          </div>
        )}
      </div>
    </div>
  )
}
