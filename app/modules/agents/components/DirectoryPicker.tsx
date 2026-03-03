import { useEffect, useState } from 'react'
import { ChevronRight, ChevronUp, Folder, FolderOpen } from 'lucide-react'
import { useDirectories } from '@/hooks/use-agents'

export function DirectoryPicker({
  value,
  onChange,
  host,
}: {
  value: string
  onChange: (dir: string) => void
  host?: string
}) {
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined)
  const [isOpen, setIsOpen] = useState(false)
  const [homeDir, setHomeDir] = useState<string | undefined>(undefined)
  const { data } = useDirectories(browsePath, isOpen, host)

  // Reset browse state when host changes
  const [prevHost, setPrevHost] = useState(host)
  if (host !== prevHost) {
    setPrevHost(host)
    setBrowsePath(undefined)
    setHomeDir(undefined)
  }

  // Capture the home directory from the initial (default) response
  useEffect(() => {
    if (data?.parent && homeDir === undefined && browsePath === undefined) {
      setHomeDir(data.parent)
    }
  }, [data?.parent, homeDir, browsePath])

  const canGoUp = Boolean(homeDir && data?.parent && data.parent !== homeDir)

  function handleSelect(dir: string) {
    onChange(dir)
    setIsOpen(false)
  }

  function handleBrowse(dir: string) {
    setBrowsePath(dir)
  }

  function handleGoUp() {
    if (canGoUp && data?.parent) {
      const parent = data.parent.replace(/\/[^/]+$/, '') || '/'
      setBrowsePath(parent)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="flex-1 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          placeholder="~ (home directory)"
        />
        <button
          type="button"
          onClick={() => {
            setIsOpen((c) => !c)
            if (!isOpen && value) {
              setBrowsePath(value)
            }
          }}
          className="p-2 rounded-lg border border-ink-border bg-washi-aged hover:bg-ink-wash transition-colors"
          aria-label="Browse directories"
        >
          <FolderOpen size={16} className="text-sumi-diluted" />
        </button>
      </div>

      {isOpen && (
        <div className="mt-2 rounded-lg border border-ink-border bg-washi-aged max-h-48 overflow-y-auto">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-border bg-ink-wash">
            <button
              type="button"
              onClick={handleGoUp}
              disabled={!canGoUp}
              className="p-1 rounded hover:bg-washi-aged transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              aria-label="Go to parent directory"
            >
              <ChevronUp size={14} className="text-sumi-diluted" />
            </button>
            <span className="font-mono text-xs text-sumi-gray truncate">
              {data?.parent ?? '~'}
            </span>
          </div>
          {data?.directories.length === 0 ? (
            <div className="px-3 py-3 text-xs text-sumi-mist">No subdirectories</div>
          ) : (
            data?.directories.map((dir) => (
              <div key={dir} className="flex items-center">
                <button
                  type="button"
                  onClick={() => handleSelect(dir)}
                  className="flex-1 flex items-center gap-2 px-3 py-2 text-left hover:bg-ink-wash transition-colors"
                >
                  <Folder size={14} className="text-sumi-mist shrink-0" />
                  <span className="font-mono text-xs text-sumi-black truncate">
                    {dir.split('/').pop()}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => handleBrowse(dir)}
                  className="px-2 py-2 text-sumi-mist hover:text-sumi-black transition-colors"
                  aria-label={`Browse into ${dir.split('/').pop()}`}
                >
                  <ChevronRight size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <p className="mt-1 text-whisper text-sumi-mist">
        Leave empty to use the home directory
      </p>
    </div>
  )
}
