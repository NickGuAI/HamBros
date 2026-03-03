import { useState } from 'react'
import { getFullUrl } from '@/lib/api-base'

/**
 * API-key-only landing page. Used when Auth0 is disabled or when running in
 * Capacitor (where Auth0 checkSession hangs in the WebView).
 */
export function ApiKeyLandingPage({
  onApiKeySubmit,
}: {
  onApiKeySubmit: (key: string) => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = apiKey.trim()
    if (!trimmed) return
    setSubmitError(null)
    setIsSubmitting(true)
    try {
      const res = await fetch(getFullUrl('/api/services/list'), {
        headers: { 'X-Hammurabi-Api-Key': trimmed },
      })
      if (!res.ok) {
        setSubmitError('Invalid API key or insufficient scopes. Check key and try again.')
        return
      }
      onApiKeySubmit(trimmed)
    } catch {
      setSubmitError('Connection failed. Check network and try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-washi-aged">
      <div className="card-sumi max-w-md w-full mx-4 p-12 animate-fade-in">
        <h1 className="font-display text-display text-sumi-black mb-2 text-center">
          Hammurabi
        </h1>
        <p className="text-sm font-body text-sumi-diluted mb-6 text-center">
          Sign in with API key
        </p>

        <div className="divider-ink mb-6" />

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            placeholder="Paste your API key (hmrb_...)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-4 py-3 rounded-lg border border-ink-border bg-washi-white text-sumi-black placeholder:text-sumi-mist focus:outline-none focus:ring-2 focus:ring-sumi-black/10"
            autoComplete="off"
            autoFocus
            disabled={isSubmitting}
          />
          {submitError && (
            <p className="text-sm text-accent-vermillion" role="alert">
              {submitError}
            </p>
          )}
          <button
            type="submit"
            disabled={!apiKey.trim() || isSubmitting}
            className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Verifying...' : 'Sign in'}
          </button>
        </form>

        <p className="text-whisper text-sumi-mist mt-8 uppercase text-center">
          Authenticated access only
        </p>
      </div>
    </div>
  )
}
