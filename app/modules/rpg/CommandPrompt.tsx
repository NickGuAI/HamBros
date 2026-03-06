import { useState, type FormEvent } from 'react'

interface CommandPromptProps {
  selectedAgentId?: string
  disabled?: boolean
  onSubmit: (text: string) => boolean
}

export function CommandPrompt({ selectedAgentId, disabled = false, onSubmit }: CommandPromptProps) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const text = value.trim()
    if (!text) {
      return
    }

    const ok = onSubmit(text)
    if (!ok) {
      setError('Failed to send input. Select a connected stream agent.')
      return
    }

    setValue('')
    setError(null)
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 p-3">
      <form
        onSubmit={send}
        className="mx-auto flex max-w-5xl flex-col gap-2 rounded-xl border border-white/20 bg-black/60 p-2 backdrop-blur-[2px]"
      >
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-white/75">
            command prompt
          </p>
          <p className="truncate font-mono text-[10px] text-white/60">
            {selectedAgentId ? `target ${selectedAgentId}` : 'select a stream agent'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Give your party a new order..."
            disabled={disabled || !selectedAgentId}
            className="h-10 flex-1 rounded-md border border-white/20 bg-black/50 px-3 text-sm text-white placeholder:text-white/35 focus:border-emerald-300/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
          />
          <button
            type="submit"
            disabled={disabled || !selectedAgentId || value.trim().length === 0}
            className="h-10 rounded-md border border-emerald-300/35 bg-emerald-300/15 px-4 font-mono text-xs uppercase tracking-[0.08em] text-emerald-100 transition enabled:hover:bg-emerald-300/25 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Send
          </button>
        </div>

        {error ? <p className="px-1 text-xs text-red-300">{error}</p> : null}
      </form>
    </div>
  )
}
