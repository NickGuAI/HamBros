import { Suspense, lazy, useMemo, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { FOUNDER_SETUP_PATH, type OnboardingStatus } from '@modules/onboarding/contracts'
import { useOnboardingStatus } from '@modules/onboarding/hooks/useFounderOnboarding'
import { bindFrontendGraphToStaticBindings } from '@/module-graph-bindings'
import { useModuleGraph } from '@/hooks/use-module-graph'
import { ModuleGraphProvider } from '@/module-graph-context'
import type { FrontendModuleBinding, FrontendNavItem } from '@/types'
import type { HerdModuleGraphResponse } from '@/types/module-graph-api'
import { Shell } from '@/surfaces/desktop/Shell'
import { useShellCounts } from './use-shell-counts'
import { BootstrapKeyRotationPrompt } from './BootstrapKeyRotationPrompt'

interface ModuleRoute {
  path: string
  Component: LazyExoticComponent<ComponentType>
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-3 w-3 animate-breathe rounded-full bg-sumi-mist" />
    </div>
  )
}

function StartupError({
  error,
  onRetry,
}: {
  error: Error
  onRetry: () => void
}) {
  return (
    <div className="flex h-full w-full items-center justify-center px-4 py-8">
      <div className="card-sumi flex max-w-md flex-col items-center gap-4 p-8 text-center">
        <h1 className="text-xl font-medium text-sumi-black">Herd</h1>
        <p className="text-sm text-sumi-diluted">{error.message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full bg-sumi-black px-4 py-2 text-sm text-washi-white transition-colors hover:bg-sumi-black/90"
        >
          Retry
        </button>
      </div>
    </div>
  )
}

function requiresInitialOnboardingGate(status: OnboardingStatus): boolean {
  return (
    !status.founderSetup.setupComplete ||
    !status.gaia.exists ||
    !status.starterWorkforce.complete ||
    !status.credentials.ready
  )
}

function AppShell({
  children,
  modules,
}: {
  children: ReactNode
  modules: FrontendNavItem[]
}) {
  const shellCounts = useShellCounts()
  return (
    <Shell modules={modules} counts={shellCounts}>
      <BootstrapKeyRotationPrompt />
      {children}
    </Shell>
  )
}

export function AuthenticatedAppRouter({
  componentBindings,
  moduleGraph,
}: {
  componentBindings: FrontendModuleBinding[]
  moduleGraph?: HerdModuleGraphResponse
}) {
  const moduleGraphQuery = useModuleGraph({ enabled: !moduleGraph })
  const graph = moduleGraph ?? moduleGraphQuery.data ?? null
  const boundGraph = useMemo(
    () => (graph ? bindFrontendGraphToStaticBindings(componentBindings, graph) : null),
    [componentBindings, graph],
  )
  const onboardingModule = boundGraph?.routes.find((module) => module.path === FOUNDER_SETUP_PATH)
  const defaultRoutePath = boundGraph?.routes.find((module) => module.routeId === 'command-room.ui')?.path ?? '/command-room'
  const shellModules = useMemo(
    () => boundGraph?.routes.filter((module) => module.path !== FOUNDER_SETUP_PATH) ?? [],
    [boundGraph],
  )
  const shellModuleRoutes = useMemo<ModuleRoute[]>(
    () => shellModules.map((module) => ({
      path: module.path,
      Component: lazy(module.component),
    })),
    [shellModules],
  )
  const OnboardingPage = useMemo(
    () => (onboardingModule ? lazy(onboardingModule.component) : null),
    [onboardingModule],
  )
  const onboarding = useOnboardingStatus()

  if (onboarding.error) {
    return (
      <StartupError
        error={onboarding.error as Error}
        onRetry={() => {
          void onboarding.refetch()
        }}
      />
    )
  }

  if (moduleGraphQuery.error && !moduleGraph) {
    return (
      <StartupError
        error={moduleGraphQuery.error as Error}
        onRetry={() => {
          void moduleGraphQuery.refetch()
        }}
      />
    )
  }

  if (!graph || !boundGraph || onboarding.isLoading || !onboarding.data) {
    return <Loading />
  }

  if (!OnboardingPage) {
    throw new Error(`Onboarding route "${FOUNDER_SETUP_PATH}" is not registered`)
  }

  if (requiresInitialOnboardingGate(onboarding.data)) {
    return (
      <ModuleGraphProvider graph={graph}>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path={`${FOUNDER_SETUP_PATH}/*`} element={<OnboardingPage />} />
            <Route path="*" element={<Navigate to={FOUNDER_SETUP_PATH} replace />} />
          </Routes>
        </Suspense>
      </ModuleGraphProvider>
    )
  }

  return (
    <ModuleGraphProvider graph={graph}>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path={FOUNDER_SETUP_PATH} element={<OnboardingPage />} />
          <Route
            path="/*"
            element={(
              <AppShell modules={boundGraph.nav}>
                <Routes>
                  <Route path="/" element={<Navigate to={defaultRoutePath} replace />} />
                  {boundGraph.redirects.map((redirect) => (
                    <Route
                      key={redirect.id}
                      path={redirect.from}
                      element={<Navigate to={redirect.to} replace />}
                    />
                  ))}
                  {shellModuleRoutes.map((route) => (
                    <Route
                      key={route.path}
                      path={`${route.path}/*`}
                      element={<route.Component />}
                    />
                  ))}
                </Routes>
              </AppShell>
            )}
          />
        </Routes>
      </Suspense>
    </ModuleGraphProvider>
  )
}
