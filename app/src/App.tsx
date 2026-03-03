import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react'
import { LandingPage } from '@/components/LandingPage'
import { ApiKeyLandingPage } from '@/components/ApiKeyLandingPage'
import { Shell } from '@/components/Shell'
import { AuthProvider } from '@/contexts/AuthContext'
import { modules } from '@/module-registry'
import { setAccessTokenResolver } from '@/lib/api'
import { isCapacitorNative } from '@/lib/api-base'

const API_KEY_STORAGE = 'hambros_api_key'

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

// Build lazy components from module registry
const moduleRoutes = modules.map((mod) => ({
  path: mod.path,
  Component: lazy(mod.component),
}))

function AppFrame({ signOut }: { signOut: () => void }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider signOut={signOut}>
          <Shell modules={modules}>
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/" element={<Navigate to="/agents" replace />} />
                {moduleRoutes.map((route) => (
                  <Route
                    key={route.path}
                    path={route.path}
                    element={<route.Component />}
                  />
                ))}
              </Routes>
            </Suspense>
          </Shell>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

function AuthTokenBridge() {
  const { getAccessTokenSilently, isAuthenticated } = useAuth0()

  useEffect(() => {
    setAccessTokenResolver(async () => {
      if (!isAuthenticated) {
        return null
      }

      try {
        return await getAccessTokenSilently()
      } catch {
        return null
      }
    })

    return () => {
      setAccessTokenResolver(null)
    }
  }, [getAccessTokenSilently, isAuthenticated])

  return null
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
  const { logout } = useAuth0()
  const signOut = useCallback(() => {
    logout({ logoutParams: { returnTo: window.location.origin } })
  }, [logout])
  return <AppFrame signOut={signOut} />
}

export default function App() {
  const domain = import.meta.env.VITE_AUTH0_DOMAIN?.trim() ?? ''
  const audience = import.meta.env.VITE_AUTH0_AUDIENCE?.trim() ?? ''
  const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID?.trim() ?? ''
  const auth0Enabled = Boolean(domain && audience && clientId)

  const [apiKey, setApiKeyState] = useState<string | null>(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem(API_KEY_STORAGE) : null,
  )

  function handleApiKeySubmit(key: string) {
    const trimmed = key.trim()
    if (!trimmed) return
    localStorage.setItem(API_KEY_STORAGE, trimmed)
    setApiKeyState(trimmed)
  }

  const handleSignOut = useCallback(() => {
    localStorage.removeItem(API_KEY_STORAGE)
    setApiKeyState(null)
  }, [])

  useEffect(() => {
    if (apiKey) {
      setAccessTokenResolver(() => Promise.resolve(apiKey))
      return () => setAccessTokenResolver(null)
    }
  }, [apiKey])

  // API key auth: bypass Auth0, use stored key for all requests
  if (apiKey) {
    return <AppFrame signOut={handleSignOut} />
  }

  // Capacitor: Auth0 checkSession hangs in WebView (iframe/cookie restrictions).
  // Skip Auth0 and use API key only.
  if (!auth0Enabled || isCapacitorNative()) {
    if (apiKey) {
      return <AppFrame signOut={handleSignOut} />
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
      authorizationParams={{
        audience,
        redirect_uri: window.location.origin,
      }}
    >
      <AuthTokenBridge />
      <AuthGuard onApiKeySubmit={handleApiKeySubmit} />
    </Auth0Provider>
  )
}
