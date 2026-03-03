import { useState, type FormEvent } from 'react'
import type { CommanderCreateInput } from '../hooks/useCommander'

const HOST_PATTERN = /^[a-zA-Z0-9_-]+$/

export function CreateCommanderForm({
  onAdd,
  isPending,
}: {
  onAdd: (input: CommanderCreateInput) => Promise<void>
  isPending: boolean
}) {
  const [host, setHost] = useState('')
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [label, setLabel] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    const trimmedHost = host.trim()
    const trimmedOwner = owner.trim()
    const trimmedRepo = repo.trim()

    if (!trimmedHost || !trimmedOwner || !trimmedRepo) {
      setActionError('Host, owner, and repo are required.')
      return
    }

    if (!HOST_PATTERN.test(trimmedHost)) {
      setActionError('Host must only contain letters, numbers, hyphens, and underscores.')
      return
    }

    setActionError(null)
    try {
      const input: CommanderCreateInput = {
        host: trimmedHost,
        taskSource: {
          owner: trimmedOwner,
          repo: trimmedRepo,
          ...(label.trim() ? { label: label.trim() } : {}),
        },
      }
      await onAdd(input)
      setHost('')
      setOwner('')
      setRepo('')
      setLabel('')
    } catch (caughtError) {
      if (caughtError instanceof Error && caughtError.message.includes('(409)')) {
        setActionError(`Host "${host.trim()}" already exists.`)
      } else {
        setActionError(caughtError instanceof Error ? caughtError.message : 'Failed to create commander.')
      }
    }
  }

  const inputClass =
    'w-full rounded-lg border border-ink-border px-3 py-2 text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20'

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="rounded-lg border border-dashed border-ink-border p-3 space-y-2"
    >
      <p className="text-sm text-sumi-gray">New commander</p>

      <input
        value={host}
        onChange={(event) => setHost(event.target.value)}
        placeholder="host (e.g. my-agent-1)"
        className={inputClass}
      />

      <div className="grid grid-cols-2 gap-2">
        <input
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder="github owner"
          className={inputClass}
        />
        <input
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
          placeholder="repo"
          className={inputClass}
        />
      </div>

      <input
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="label (optional)"
        className={inputClass}
      />

      {actionError && <p className="text-sm text-accent-vermillion">{actionError}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg border border-ink-border px-3 py-1.5 text-sm hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? 'Creating...' : '+ Create'}
        </button>
      </div>
    </form>
  )
}
