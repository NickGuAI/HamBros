import { useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'

interface LandingPageProps {
  onApiKeySubmit?: (key: string) => void
}

export function LandingPage({ onApiKeySubmit }: LandingPageProps) {
  const { loginWithRedirect, isLoading } = useAuth0()
  const [showApiKey, setShowApiKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleApiKeySubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = apiKey.trim()
    if (!trimmed || !onApiKeySubmit) return
    setSubmitError(null)
    setIsSubmitting(true)
    try {
      // Validate key with an auth-required request
      const { getFullUrl } = await import('@/lib/api-base')
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

  if (showApiKey && onApiKeySubmit) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-washi-aged">
        <div className="card-sumi max-w-md w-full mx-4 p-12 animate-fade-in">
          <h1 className="font-display text-display text-sumi-black mb-2 text-center">
            Hammurabi
          </h1>
          <p className="text-sm font-body text-sumi-diluted mb-6 text-center">
            Sign in with API key (for iOS and when Auth0 redirect fails)
          </p>

          <div className="divider-ink mb-6" />

          <form onSubmit={handleApiKeySubmit} className="space-y-4">
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
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!apiKey.trim() || isSubmitting}
                className="btn-primary flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? 'Verifying...' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={() => { setShowApiKey(false); setApiKey(''); setSubmitError(null) }}
                className="btn-ghost"
              >
                Back
              </button>
            </div>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-washi-aged">
      <div className="card-sumi max-w-md w-full mx-4 p-12 text-center animate-fade-in">
        <h1 className="font-display text-display text-sumi-black mb-2">
          Hammurabi
        </h1>
        <p className="text-sm font-body text-sumi-diluted mb-10">
          Monitoring &amp; Operations Dashboard
        </p>

        <div className="divider-ink mb-10" />

        <button
          onClick={() => void loginWithRedirect()}
          disabled={isLoading}
          className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? 'Loading...' : 'Sign in'}
        </button>

        {onApiKeySubmit && (
          <button
            type="button"
            onClick={() => setShowApiKey(true)}
            className="btn-ghost w-full mt-3 text-sm"
          >
            Or sign in with API key
          </button>
        )}

        <p className="text-whisper text-sumi-mist mt-8 uppercase">
          Authenticated access only
        </p>
      </div>
    </div>
  )
}
