import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react'
import { LandingPage } from '@/components/LandingPage'
import { ApiKeyLandingPage } from '@/components/ApiKeyLandingPage'
import { AuthProvider } from '@/contexts/AuthContext'
import { AuthenticatedAppRouter } from '@/app/AuthenticatedAppRouter'
import { moduleComponentBindings } from '@/module-registry'
import {
  AuthRecoveryRequiredError,
  setAccessTokenResolver,
  setAuthMode,
  setUnauthorizedHandler,
} from '@/lib/api'
import {
  clearStoredInstanceUrl,
  getStoredInstanceUrl,
  isCapacitorNative,
} from '@/lib/api-base'
import { isAuthGatewayHealthy, resolveAuthReturnTo } from '@/lib/auth-build-guard'
import { ThemeProvider } from '@/lib/theme-context'
import { useFontScale } from '@/hooks/use-font-scale'

const API_KEY_STORAGE = 'herd_api_key'
const DEFAULT_SIGN_IN_PATH = '/command-room'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      retry: 1,
    },
  },
})

function Loading() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
    </div>
  )
}

function AppFrame({
  signOut,
  replaceApiKey,
  user,
}: {
  signOut: () => void
  replaceApiKey?: (apiKey: string) => void
  user?: {
    name?: string | null
    email?: string | null
    picture?: string | null
  }
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <FontScaleRoot />
        <BrowserRouter>
          <AuthProvider signOut={signOut} replaceApiKey={replaceApiKey} user={user}>
            <AuthenticatedAppRouter componentBindings={moduleComponentBindings} />
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

function FontScaleRoot() {
  useFontScale({ applyToDocument: true })
  return null
}

function AuthTokenBridge() {
  const { getAccessTokenSilently, isAuthenticated, loginWithRedirect } = useAuth0()
  const authRecoveryInFlightRef = useRef(false)
  const [authRecoveryUnavailable, setAuthRecoveryUnavailable] = useState(false)

  const recoverAuthSession = useCallback(() => {
    if (!isAuthenticated || authRecoveryInFlightRef.current) {
      return
    }

    authRecoveryInFlightRef.current = true
    setAuthRecoveryUnavailable(false)

    void (async () => {
      const gatewayHealthy = await isAuthGatewayHealthy()
      if (!gatewayHealthy) {
        setAuthRecoveryUnavailable(true)
        authRecoveryInFlightRef.current = false
        return
      }

      const returnTo = resolveAuthReturnTo()
      await loginWithRedirect({ appState: { returnTo } })
    })()
      .catch(() => {
        authRecoveryInFlightRef.current = false
        setAuthRecoveryUnavailable(true)
      })
  }, [isAuthenticated, loginWithRedirect])

  useEffect(() => {
    if (!isAuthenticated) {
      authRecoveryInFlightRef.current = false
      setAuthRecoveryUnavailable(false)
      setAccessTokenResolver(null)
      setUnauthorizedHandler(null)
      setAuthMode('anonymous')
      return
    }

    setAuthMode('auth0')
    setAccessTokenResolver(async () => {
      try {
        return await getAccessTokenSilently()
      } catch (error) {
        throw new AuthRecoveryRequiredError('Auth0 session expired; sign in again.', {
          authMode: 'auth0',
          cause: error,
        })
      }
    })
    setUnauthorizedHandler((event) => {
      if (event.authMode === 'auth0') {
        recoverAuthSession()
      }
    })

    return () => {
      setAccessTokenResolver(null)
      setUnauthorizedHandler(null)
      setAuthMode('anonymous')
    }
  }, [getAccessTokenSilently, isAuthenticated, recoverAuthSession])

  if (!isAuthenticated || !authRecoveryUnavailable) {
    return null
  }

  return (
    <div
      role="status"
      data-testid="auth-recovery-unavailable"
      className="font-body"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 'calc(18px + env(safe-area-inset-bottom, 0px))',
        zIndex: 10000,
        transform: 'translateX(-50%)',
        width: 'min(92vw, 460px)',
        border: '1px solid var(--hv-border-firm)',
        borderRadius: 'var(--hv-radius-carved)',
        background: 'var(--hv-bg)',
        boxShadow: 'var(--hv-shadow-block)',
        color: 'var(--hv-fg)',
        padding: '12px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <p style={{ margin: 0, flex: 1, fontSize: 13, lineHeight: 1.45 }}>
          Herd is reconnecting. Sign-in recovery will resume after the gateway is healthy.
        </p>
        <button
          type="button"
          onClick={recoverAuthSession}
          style={{
            border: '1px solid var(--hv-border-firm)',
            borderRadius: 'var(--hv-radius-carved-sm)',
            background: 'var(--hv-button-primary-bg)',
            color: 'var(--hv-button-primary-fg)',
            cursor: 'pointer',
            fontSize: 12,
            padding: '7px 10px',
          }}
        >
          Retry
        </button>
      </div>
    </div>
  )
}

function AuthGuard({
  onApiKeySubmit,
}: {
  onApiKeySubmit: (key: string) => void
}) {
  const { isLoading, isAuthenticated } = useAuth0()

  if (isLoading) {
    return <Loading />
  }

  if (!isAuthenticated) {
    return <LandingPage onApiKeySubmit={onApiKeySubmit} />
  }

  return <Auth0AppFrame />
}

function Auth0AppFrame() {
  const { logout, user } = useAuth0()
  const signOut = useCallback(() => {
    logout({ logoutParams: { returnTo: window.location.origin } })
  }, [logout])
  return <AppFrame signOut={signOut} user={user} />
}

export default function App() {
  const domain = import.meta.env.VITE_AUTH0_DOMAIN?.trim() ?? ''
  const audience = import.meta.env.VITE_AUTH0_AUDIENCE?.trim() ?? ''
  const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID?.trim() ?? ''
  const auth0Enabled = Boolean(domain && audience && clientId)

  const [apiKey, setApiKeyState] = useState<string | null>(() => {
    const storedKey = typeof localStorage !== 'undefined' ? localStorage.getItem(API_KEY_STORAGE) : null
    // On native we need both an API key AND a stored instance URL. A key without
    // a URL is a stale upgrade artifact from the hardcoded-backend build; drop it
    // so the Connect screen takes over.
    if (storedKey && isCapacitorNative() && getStoredInstanceUrl() === null) {
      localStorage.removeItem(API_KEY_STORAGE)
      return null
    }
    if (storedKey) {
      setAuthMode('api-key')
      setAccessTokenResolver(() => Promise.resolve(storedKey))
    }
    return storedKey
  })

  function handleApiKeySubmit(key: string) {
    const trimmed = key.trim()
    if (!trimmed) return
    localStorage.setItem(API_KEY_STORAGE, trimmed)
    setAuthMode('api-key')
    setAccessTokenResolver(() => Promise.resolve(trimmed))
    if (typeof window !== 'undefined') {
      const { pathname } = window.location
      const onDefaultEntryPath = !pathname || pathname === '/' || pathname === '/welcome'
      if (onDefaultEntryPath) {
        window.history.replaceState({}, document.title, DEFAULT_SIGN_IN_PATH)
      }
    }
    setApiKeyState(trimmed)
  }

  function handleApiKeyReplace(key: string) {
    const trimmed = key.trim()
    if (!trimmed) return
    localStorage.setItem(API_KEY_STORAGE, trimmed)
    setAuthMode('api-key')
    setAccessTokenResolver(() => Promise.resolve(trimmed))
    setApiKeyState(trimmed)
  }

  const handleSignOut = useCallback(() => {
    localStorage.removeItem(API_KEY_STORAGE)
    clearStoredInstanceUrl()
    setAccessTokenResolver(null)
    setAuthMode('anonymous')
    setApiKeyState(null)
  }, [])

  useEffect(() => {
    if (!apiKey) {
      return
    }

    setAuthMode('api-key')
    setAccessTokenResolver(() => Promise.resolve(apiKey))
    setUnauthorizedHandler((event) => {
      if (event.authMode === 'api-key') {
        handleSignOut()
      }
    })
    return () => {
      setAccessTokenResolver(null)
      setUnauthorizedHandler(null)
      setAuthMode('anonymous')
    }
  }, [apiKey, handleSignOut])

  // API key auth: bypass Auth0, use stored key for all requests
  if (apiKey) {
    return <AppFrame signOut={handleSignOut} replaceApiKey={handleApiKeyReplace} />
  }

  // Capacitor: Auth0 checkSession hangs in WebView (iframe/cookie restrictions).
  // Skip Auth0 and use API key only.
  if (!auth0Enabled || isCapacitorNative()) {
    if (apiKey) {
      return <AppFrame signOut={handleSignOut} replaceApiKey={handleApiKeyReplace} />
    }
    return (
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ApiKeyLandingPage onApiKeySubmit={handleApiKeySubmit} />
        </BrowserRouter>
      </QueryClientProvider>
    )
  }

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      // Herd is an operations console expected to survive idle tabs and
      // reloads. Refresh-token rotation plus explicit local cache gives the
      // Auth0 SDK a durable recovery path instead of relying only on iframe
      // silent auth, which browsers can block after inactivity.
      cacheLocation="localstorage"
      useRefreshTokens
      useRefreshTokensFallback
      onRedirectCallback={(appState) => {
        const returnTo = typeof appState?.returnTo === 'string'
          ? appState.returnTo
          : DEFAULT_SIGN_IN_PATH
        window.history.replaceState({}, document.title, returnTo)
      }}
      authorizationParams={{
        audience,
        scope: 'openid profile email offline_access',
        // Auth0 callback URL must match the dashboard whitelist exactly.
        // Keep this static at the origin; post-login routing to a specific
        // app path is handled by `onRedirectCallback` reading
        // `appState.returnTo` (set by `loginWithRedirect({ appState })` in
        // LandingPage). See issue #1425.
        redirect_uri: window.location.origin,
      }}
    >
      <AuthTokenBridge />
      <AuthGuard onApiKeySubmit={handleApiKeySubmit} />
    </Auth0Provider>
  )
}
