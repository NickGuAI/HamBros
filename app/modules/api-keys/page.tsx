import { FormEvent, useMemo, useState } from 'react'
import { AlertTriangle, Copy, KeyRound, LogOut, Trash2 } from 'lucide-react'
import {
  useApiKeys,
  useClearOpenAITranscriptionKey,
  useCreateApiKey,
  useOpenAITranscriptionSettings,
  useRevokeApiKey,
  useSetOpenAITranscriptionKey,
  type CreatedApiKey,
} from '@/hooks/use-api-keys'
import { useAuth } from '@/contexts/AuthContext'
import { timeAgo } from '@/lib/utils'

const AVAILABLE_SCOPES = [
  { value: 'telemetry:read', label: 'Telemetry read' },
  { value: 'telemetry:write', label: 'Telemetry write' },
  { value: 'agents:read', label: 'Agents read' },
  { value: 'agents:write', label: 'Agents write' },
  { value: 'services:read', label: 'Services read' },
  { value: 'services:write', label: 'Services write' },
  { value: 'factory:read', label: 'Factory read' },
  { value: 'factory:write', label: 'Factory write' },
] as const

const ALL_SCOPE_VALUES = AVAILABLE_SCOPES.map((s) => s.value)

export default function ApiKeysPage() {
  const auth = useAuth()
  const [name, setName] = useState('')
  const [selectedScopes, setSelectedScopes] = useState<string[]>([
    ...AVAILABLE_SCOPES.map((scope) => scope.value),
  ])
  const [openAIApiKey, setOpenAIApiKey] = useState('')
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle')

  const {
    data: keys = [],
    isLoading,
    error,
  } = useApiKeys()
  const createMutation = useCreateApiKey()
  const revokeMutation = useRevokeApiKey()
  const { data: transcriptionSettings, error: transcriptionSettingsError } =
    useOpenAITranscriptionSettings()
  const setOpenAIMutation = useSetOpenAITranscriptionKey()
  const clearOpenAIMutation = useClearOpenAITranscriptionKey()

  const sortedKeys = useMemo(
    () =>
      [...keys].sort(
        (left, right) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      ),
    [keys],
  )

  const createError =
    createMutation.error instanceof Error ? createMutation.error.message : null
  const revokeError =
    revokeMutation.error instanceof Error ? revokeMutation.error.message : null
  const transcriptionError =
    (setOpenAIMutation.error instanceof Error
      ? setOpenAIMutation.error.message
      : null) ??
    (clearOpenAIMutation.error instanceof Error
      ? clearOpenAIMutation.error.message
      : null) ??
    (transcriptionSettingsError instanceof Error
      ? transcriptionSettingsError.message
      : null)
  const listError = error instanceof Error ? error.message : null

  async function handleCreateKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedName = name.trim()
    if (!trimmedName) {
      return
    }

    const created = await createMutation.mutateAsync({
      name: trimmedName,
      scopes: selectedScopes,
    })
    setName('')
    setCreatedKey(created)
    setCopyState('idle')
  }

  async function handleCopyKey() {
    if (!createdKey) {
      return
    }

    await navigator.clipboard.writeText(createdKey.key)
    setCopyState('copied')
  }

  async function handleSaveOpenAIKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedKey = openAIApiKey.trim()
    if (!trimmedKey) {
      return
    }

    await setOpenAIMutation.mutateAsync(trimmedKey)
    setOpenAIApiKey('')
  }

  async function handleClearOpenAIKey() {
    const confirmed = window.confirm('Remove the OpenAI transcription key?')
    if (!confirmed) {
      return
    }

    await clearOpenAIMutation.mutateAsync()
  }

  return (
    <div className="px-4 py-6 md:px-10 md:py-10">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="font-display text-display text-sumi-black">Settings</h2>
            <p className="mt-2 text-sm text-sumi-diluted leading-relaxed">
              API keys and account.
            </p>
          </div>
          {auth && (
            <button
              type="button"
              onClick={auth.signOut}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sumi-gray hover:bg-ink-wash hover:text-sumi-black transition-colors text-sm shrink-0"
            >
              <LogOut size={18} />
              Sign out
            </button>
          )}
        </div>
        <p className="mt-4 text-sm text-sumi-diluted leading-relaxed">
          Create scoped keys for agents and scripts. Keys are shown only once at creation time.
        </p>

        <div className="mt-6 md:mt-8 grid gap-6 lg:grid-cols-[360px_1fr]">
          <form onSubmit={handleCreateKey} className="card-sumi p-5 space-y-4 h-fit">
            <div>
              <label className="section-title block mb-2">Key Name</label>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Telemetry Ingest Key"
                className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                required
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="section-title block">Scopes</label>
                <button
                  type="button"
                  className="text-whisper text-sm hover:text-sumi-gray"
                  onClick={() => {
                    setSelectedScopes((current) =>
                      current.length === ALL_SCOPE_VALUES.length ? [] : [...ALL_SCOPE_VALUES],
                    )
                  }}
                >
                  {selectedScopes.length === ALL_SCOPE_VALUES.length ? 'Clear all' : 'Select all'}
                </button>
              </div>
              <div className="space-y-2">
                {AVAILABLE_SCOPES.map((scope) => {
                  const checked = selectedScopes.includes(scope.value)
                  return (
                    <label
                      key={scope.value}
                      className="flex items-center gap-2 text-sm text-sumi-gray"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          setSelectedScopes((current) => {
                            if (event.target.checked) {
                              return [...new Set([...current, scope.value])]
                            }
                            return current.filter((value) => value !== scope.value)
                          })
                        }}
                      />
                      <span>{scope.label}</span>
                    </label>
                  )
                })}
              </div>
            </div>

            <button
              type="submit"
              disabled={createMutation.isPending}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              <KeyRound size={14} />
              {createMutation.isPending ? 'Creating...' : 'Create Key'}
            </button>

            {createError && (
              <div className="flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
                <AlertTriangle size={15} className="mt-0.5" />
                <span>{createError}</span>
              </div>
            )}
          </form>

          <div className="space-y-4">
            <div className="card-sumi p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="section-title">Transcription (OpenAI Realtime)</p>
                  <p className="mt-2 text-sm text-sumi-diluted">
                    Mic input uses this key for live transcription.
                  </p>
                </div>
                <span
                  className={`badge-sumi ${
                    transcriptionSettings?.configured ? 'badge-active' : 'badge-idle'
                  }`}
                >
                  {transcriptionSettings?.configured ? 'Configured' : 'Not configured'}
                </span>
              </div>

              <form className="mt-4 space-y-3" onSubmit={handleSaveOpenAIKey}>
                <input
                  type="password"
                  value={openAIApiKey}
                  onChange={(event) => setOpenAIApiKey(event.target.value)}
                  placeholder={
                    transcriptionSettings?.configured
                      ? 'sk-... (stored)'
                      : 'sk-...'
                  }
                  className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={setOpenAIMutation.isPending}
                    className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {setOpenAIMutation.isPending ? 'Saving...' : 'Save OpenAI Key'}
                  </button>
                  {transcriptionSettings?.configured && (
                    <button
                      type="button"
                      disabled={clearOpenAIMutation.isPending}
                      className="btn-ghost text-accent-vermillion disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={handleClearOpenAIKey}
                    >
                      {clearOpenAIMutation.isPending ? 'Removing...' : 'Remove'}
                    </button>
                  )}
                </div>
              </form>

              {transcriptionSettings?.updatedAt && (
                <p className="mt-3 text-whisper text-sumi-mist">
                  Updated {timeAgo(transcriptionSettings.updatedAt)}
                </p>
              )}

              {transcriptionError && (
                <div className="mt-3 flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
                  <AlertTriangle size={15} className="mt-0.5" />
                  <span>{transcriptionError}</span>
                </div>
              )}
            </div>

            {createdKey && (
              <div className="card-sumi p-5 border border-accent-persimmon/40 bg-accent-persimmon/5">
                <p className="section-title">Copy this key now</p>
                <p className="mt-2 text-sm text-sumi-diluted">
                  This is the only time the raw key is visible.
                </p>
                <code className="mt-3 block rounded-md bg-washi-aged px-3 py-2 text-xs break-all">
                  {createdKey.key}
                </code>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary inline-flex items-center gap-2"
                    onClick={handleCopyKey}
                  >
                    <Copy size={14} />
                    {copyState === 'copied' ? 'Copied' : 'Copy key'}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setCreatedKey(null)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            <div className="card-sumi overflow-hidden">
              <div className="px-5 py-3 border-b border-ink-border bg-washi-aged flex items-center justify-between">
                <span className="font-mono text-sm text-sumi-black">Managed Keys</span>
                <span className="text-whisper text-sumi-mist">{sortedKeys.length} keys</span>
              </div>

              {isLoading ? (
                <div className="p-5 text-sm text-sumi-diluted">Loading keys...</div>
              ) : (
                <div className="divide-y divide-ink-border">
                  {sortedKeys.length === 0 ? (
                    <div className="p-5 text-sm text-sumi-diluted">No API keys yet.</div>
                  ) : (
                    sortedKeys.map((key) => (
                      <div
                        key={key.id}
                        className="p-4 md:p-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                      >
                        <div className="min-w-0">
                          <p className="text-sm text-sumi-black font-medium">{key.name}</p>
                          <p className="mt-1 text-whisper text-sumi-mist font-mono truncate">
                            {key.prefix}...
                          </p>
                          <p className="mt-1 text-whisper text-sumi-mist">
                            Created {timeAgo(key.createdAt)} by {key.createdBy}
                          </p>
                          <p className="text-whisper text-sumi-mist">
                            Last used {key.lastUsedAt ? timeAgo(key.lastUsedAt) : 'never'}
                          </p>
                          <p className="mt-1 text-whisper text-sumi-diluted">
                            {key.scopes.length === 0
                              ? 'No scopes'
                              : `Scopes: ${key.scopes.join(', ')}`}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="btn-ghost inline-flex items-center gap-2 text-accent-vermillion shrink-0 self-start"
                          disabled={revokeMutation.isPending}
                          onClick={() => revokeMutation.mutate(key.id)}
                        >
                          <Trash2 size={14} />
                          Revoke
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {(listError || revokeError) && (
              <div className="flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
                <AlertTriangle size={15} className="mt-0.5" />
                <span>{listError ?? revokeError}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
