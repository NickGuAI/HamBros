import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useFinishOnboarding,
  useCreateFounderOrgSetup,
  useOnboardingStatus,
  useSeedGaiaCommander,
  useSeedStarterWorkforce,
  useSkipStarterWorkforce,
  verifyPermanentApiKey,
} from '@modules/onboarding/hooks/useFounderOnboarding'
import {
  useApiKeyScopeCatalog,
  useCreateApiKey,
  useRevokeApiKey,
  type CreatedApiKey,
} from '@/hooks/use-api-keys'
import { useAuth } from '@/contexts/AuthContext'
import {
  DEFAULT_FOUNDER_ORG_SETUP_FORM_VALUES,
  validateFounderOrgSetupFormValues,
  type FounderOrgSetupFormValues,
  type FounderOrgSetupValidationErrors,
  type OnboardingReadinessState,
  type OnboardingStepId,
  type ProviderOnboardingReadiness,
} from '@modules/onboarding/contracts'

function parseSetupError(error: unknown): {
  message: string
  fieldErrors: FounderOrgSetupValidationErrors
} {
  if (!(error instanceof Error)) {
    return { message: 'Unable to update onboarding.', fieldErrors: {} }
  }

  const payload = error.message.match(/^Request failed \(\d+\): (.+)$/)?.[1]
  if (!payload) {
    return { message: error.message, fieldErrors: {} }
  }

  try {
    const parsed = JSON.parse(payload) as {
      error?: unknown
      fieldErrors?: unknown
    }
    const fieldErrors = parsed.fieldErrors && typeof parsed.fieldErrors === 'object' && !Array.isArray(parsed.fieldErrors)
      ? Object.fromEntries(Object.entries(parsed.fieldErrors).filter((entry): entry is [keyof FounderOrgSetupValidationErrors, string] => (
          typeof entry[0] === 'string' && typeof entry[1] === 'string'
        ))) as FounderOrgSetupValidationErrors
      : {}
    return {
      message: typeof parsed.error === 'string' ? parsed.error : error.message,
      fieldErrors,
    }
  } catch {
    return { message: error.message, fieldErrors: {} }
  }
}

function formatSetupError(error: unknown): string {
  return parseSetupError(error).message
}

function stateGlyph(state: OnboardingReadinessState | 'complete' | 'current' | 'pending' | 'warning') {
  if (state === 'ready' || state === 'complete') return '✓'
  if (state === 'current') return '◉'
  if (state === 'warning') return '!'
  if (state === 'missing') return '!'
  return '○'
}

function formatTimeToFirstReply(minutes: number | null | undefined): string | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
    return null
  }
  if (minutes < 1) {
    return '<1 min'
  }
  return `${minutes.toFixed(minutes >= 10 ? 0 : 1)} min`
}

function ProviderCard({ provider }: { provider: ProviderOnboardingReadiness }) {
  return (
    <article className="hv-onboarding-provider" data-testid={`provider-card-${provider.id}`}>
      <div>
        <div className="hv-onboarding-provider-title">{provider.label}</div>
        <p>{provider.shortAction}</p>
      </div>
      <div className={`hv-onboarding-badge hv-onboarding-badge-${provider.state}`}>
        {stateGlyph(provider.state)} {provider.state === 'ready' ? 'ready' : provider.state}
      </div>
      {provider.verificationCommand ? (
        <details>
          <summary>Show verification</summary>
          <code>{provider.verificationCommand}</code>
        </details>
      ) : null}
    </article>
  )
}

function InkGuide() {
  return (
    <aside className="hv-onboarding-guide" data-testid="onboarding-ink-guide" aria-label="Onboarding guide">
      <div className="hv-onboarding-guide-seal">墨</div>
      <pre aria-hidden="true">{[
        '        .        ·          .',
        '    ╭──────────────╮',
        '    │    Gaia      │      ·',
        '    │  first guide │',
        '    ╰──────┬───────╯',
        '           │',
        '   brush ──╯     provider marks',
        '',
        '   ✓ instance   ✓ founder',
        '   ◉ commander  ○ providers',
      ].join('\n')}</pre>
      <p>
        Backend-owned setup state flows into this guide. The browser renders readiness; it does not probe the machine.
      </p>
    </aside>
  )
}

function SectionActions({
  onBack,
  onNext,
  nextLabel = 'Continue',
  nextDisabled = false,
  nextTestId,
  secondaryAction,
  secondaryLabel,
  secondaryDisabled = false,
  secondaryTestId,
}: {
  onBack?: () => void
  onNext?: () => void
  nextLabel?: string
  nextDisabled?: boolean
  nextTestId?: string
  secondaryAction?: () => void
  secondaryLabel?: string
  secondaryDisabled?: boolean
  secondaryTestId?: string
}) {
  return (
    <div className="hv-onboarding-actions">
      <button type="button" className="hv-onboarding-button hv-onboarding-button-ghost" onClick={onBack} disabled={!onBack}>
        Back
      </button>
      <div className="hv-onboarding-action-group">
        {secondaryAction ? (
          <button
            type="button"
            className="hv-onboarding-button hv-onboarding-button-ghost"
            onClick={secondaryAction}
            disabled={secondaryDisabled}
            data-testid={secondaryTestId}
          >
            {secondaryLabel ?? 'Skip'}
          </button>
        ) : null}
        {onNext ? (
          <button
            type="button"
            className="hv-onboarding-button hv-onboarding-button-primary"
            onClick={onNext}
            disabled={nextDisabled}
            data-testid={nextTestId}
          >
            {nextLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function FounderOrgSetupPage() {
  const navigate = useNavigate()
  const auth = useAuth()
  const onboarding = useOnboardingStatus()
  const createFounderOrg = useCreateFounderOrgSetup()
  const seedGaia = useSeedGaiaCommander()
  const seedStarterWorkforce = useSeedStarterWorkforce()
  const skipStarterWorkforce = useSkipStarterWorkforce()
  const apiKeyScopeCatalog = useApiKeyScopeCatalog()
  const createApiKey = useCreateApiKey()
  const revokeApiKey = useRevokeApiKey()
  const finishOnboarding = useFinishOnboarding()
  const submissionLockRef = useRef(false)
  const seedGaiaLockRef = useRef(false)
  const seedStarterWorkforceLockRef = useRef(false)
  const skipStarterWorkforceLockRef = useRef(false)
  const credentialActionLockRef = useRef(false)
  const finishLockRef = useRef(false)
  const defaultsAppliedRef = useRef(false)
  const hasEditedRef = useRef(false)
  const [activeStepId, setActiveStepId] = useState<OnboardingStepId | null>(null)
  const [formState, setFormState] = useState<FounderOrgSetupFormValues>(
    () => onboarding.data?.founderSetup.defaultValues ?? DEFAULT_FOUNDER_ORG_SETUP_FORM_VALUES,
  )
  const [errors, setErrors] = useState<FounderOrgSetupValidationErrors>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [createdPermanentKey, setCreatedPermanentKey] = useState<CreatedApiKey | null>(null)
  const [keyCopied, setKeyCopied] = useState(false)

  const status = onboarding.data
  const steps = status?.steps ?? []
  const currentStepId = activeStepId ?? status?.currentStepId ?? 'founder-org'
  const currentStepIndex = Math.max(0, steps.findIndex((step) => step.id === currentStepId))
  const previousStep = currentStepIndex > 0 ? steps[currentStepIndex - 1] : null

  const providerSummary = useMemo(() => {
    if (!status) return []
    return status.providers.slice(0, 4)
  }, [status])

  useEffect(() => {
    if (!status || defaultsAppliedRef.current || hasEditedRef.current) {
      return
    }

    defaultsAppliedRef.current = true
    setFormState(status.founderSetup.defaultValues)
  }, [status])

  useEffect(() => {
    if (activeStepId || !status) {
      return
    }
    setActiveStepId(status.currentStepId)
  }, [activeStepId, status])

  function updateField<K extends keyof FounderOrgSetupFormValues>(key: K, value: FounderOrgSetupFormValues[K]) {
    hasEditedRef.current = true
    setFormState((current) => ({
      ...current,
      [key]: value,
    }))
    setErrors((current) => ({
      ...current,
      [key]: undefined,
    }))
    setActionError(null)
  }

  async function handleFounderSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (submissionLockRef.current) {
      return
    }

    const nextErrors = validateFounderOrgSetupFormValues(formState)
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) {
      return
    }

    submissionLockRef.current = true
    setActionError(null)
    try {
      await createFounderOrg.mutateAsync({
        displayName: formState.orgDisplayName.trim(),
        founder: {
          displayName: formState.founderDisplayName.trim(),
          email: formState.founderEmail.trim(),
        },
      })
      defaultsAppliedRef.current = false
      setActiveStepId('gaia')
    } catch (error) {
      const parsed = parseSetupError(error)
      setErrors((current) => ({ ...current, ...parsed.fieldErrors }))
      setActionError(parsed.message)
    } finally {
      submissionLockRef.current = false
    }
  }

  async function handleSeedGaia() {
    if (seedGaiaLockRef.current) {
      return
    }
    seedGaiaLockRef.current = true
    setActionError(null)
    try {
      await seedGaia.mutateAsync()
      setActiveStepId('starter-workforce')
    } catch (error) {
      setActionError(formatSetupError(error))
    } finally {
      seedGaiaLockRef.current = false
    }
  }

  async function handleSeedStarterWorkforce() {
    if (seedStarterWorkforceLockRef.current) {
      return
    }
    seedStarterWorkforceLockRef.current = true
    setActionError(null)
    try {
      await seedStarterWorkforce.mutateAsync()
      setActiveStepId('providers-machines')
    } catch (error) {
      setActionError(formatSetupError(error))
    } finally {
      seedStarterWorkforceLockRef.current = false
    }
  }

  async function handleSkipStarterWorkforce() {
    if (skipStarterWorkforceLockRef.current) {
      return
    }
    skipStarterWorkforceLockRef.current = true
    setActionError(null)
    try {
      await skipStarterWorkforce.mutateAsync()
      setActiveStepId('providers-machines')
    } catch (error) {
      setActionError(formatSetupError(error))
    } finally {
      skipStarterWorkforceLockRef.current = false
    }
  }

  async function handleCreatePermanentKey() {
    if (credentialActionLockRef.current) return
    const scopes = apiKeyScopeCatalog.data?.defaultBootstrapScopes ?? []
    if (scopes.length === 0) {
      setActionError('The API key scope catalog is not ready. Retry after it loads.')
      return
    }
    credentialActionLockRef.current = true
    setActionError(null)
    setKeyCopied(false)
    try {
      const created = await createApiKey.mutateAsync({
        name: 'Permanent Admin Key',
        scopes,
      })
      setCreatedPermanentKey(created)
    } catch (error) {
      setActionError(formatSetupError(error))
    } finally {
      credentialActionLockRef.current = false
    }
  }

  async function handleCopyPermanentKey() {
    if (!createdPermanentKey) return
    try {
      await navigator.clipboard.writeText(createdPermanentKey.key)
      setKeyCopied(true)
    } catch {
      setActionError('Copy failed. Select the revealed key and save it manually.')
    }
  }

  async function handleUsePermanentKey() {
    if (!createdPermanentKey || credentialActionLockRef.current) return
    credentialActionLockRef.current = true
    setActionError(null)
    try {
      await verifyPermanentApiKey(createdPermanentKey.key)
      if (status?.credentials.authenticatedAs === 'bootstrap' && !auth?.replaceApiKey) {
        throw new Error('This browser cannot switch credentials. Sign in with the permanent key before revoking bootstrap access.')
      }
      auth?.replaceApiKey?.(createdPermanentKey.key)
      await onboarding.refetch()
    } catch (error) {
      setActionError(formatSetupError(error))
    } finally {
      credentialActionLockRef.current = false
    }
  }

  async function handleRevokeBootstrapKeys() {
    if (credentialActionLockRef.current || !status?.credentials.canRevokeBootstrap) return
    credentialActionLockRef.current = true
    setActionError(null)
    try {
      for (const key of status.credentials.activeBootstrapKeys) {
        await revokeApiKey.mutateAsync(key.id)
      }
      await onboarding.refetch()
    } catch (error) {
      setActionError(formatSetupError(error))
    } finally {
      credentialActionLockRef.current = false
    }
  }

  async function handleFinishOnboarding() {
    if (finishLockRef.current || !status?.credentials.ready) return
    finishLockRef.current = true
    setActionError(null)
    try {
      const result = await finishOnboarding.mutateAsync()
      navigate(result.launchTarget, { replace: true })
    } catch (error) {
      setActionError(formatSetupError(error))
    } finally {
      finishLockRef.current = false
    }
  }

  const isSubmitting = createFounderOrg.isPending || submissionLockRef.current
  const isGaiaPending = seedGaia.isPending || seedGaiaLockRef.current
  const isStarterWorkforcePending = seedStarterWorkforce.isPending || seedStarterWorkforceLockRef.current
  const isSkipStarterWorkforcePending = skipStarterWorkforce.isPending || skipStarterWorkforceLockRef.current
  const isCredentialPending = createApiKey.isPending || revokeApiKey.isPending || credentialActionLockRef.current
  const isFinishPending = finishOnboarding.isPending || finishLockRef.current

  if (onboarding.isLoading && !status) {
    return (
      <div className="hv-onboarding-shell" data-testid="onboarding-page">
        <div className="hv-onboarding-loading">Loading first-run guide...</div>
      </div>
    )
  }

  return (
    <div className="hv-onboarding-shell" data-testid="onboarding-page">
      <style>{`
        .hv-onboarding-shell {
          min-height: 100vh;
          background:
            radial-gradient(circle at 18% 18%, var(--hv-ink-wash-02), transparent 26%),
            var(--hv-bg-raised);
          color: var(--hv-fg);
          font-family: var(--hv-font-body);
          padding: clamp(16px, 3vw, 36px);
        }
        .hv-onboarding-frame {
          display: grid;
          grid-template-columns: minmax(250px, 0.68fr) minmax(360px, 1.05fr) minmax(300px, 0.8fr);
          gap: var(--hv-space-4);
          max-width: 1360px;
          margin: 0 auto;
        }
        .hv-onboarding-panel {
          border: 1px solid var(--hv-border-soft);
          background: var(--hv-bg);
          border-radius: var(--hv-radius-carved-lg);
          box-shadow: var(--hv-shadow-rest);
        }
        .hv-onboarding-progress {
          padding: var(--hv-space-5);
        }
        .hv-onboarding-eyebrow {
          color: var(--hv-fg-subtle);
          font-size: var(--hv-text-whisper);
          letter-spacing: var(--hv-track-section);
          text-transform: uppercase;
        }
        .hv-onboarding-title {
          margin: var(--hv-space-2) 0 var(--hv-space-5);
          font-family: var(--hv-font-primary);
          font-size: clamp(34px, 4vw, 54px);
          font-weight: 300;
          line-height: 1;
        }
        .hv-onboarding-step {
          width: 100%;
          display: grid;
          grid-template-columns: 28px 1fr;
          gap: var(--hv-space-2);
          border: 0;
          border-left: 1px solid var(--hv-border-hair);
          background: transparent;
          color: var(--hv-fg-muted);
          cursor: pointer;
          padding: var(--hv-space-3) 0 var(--hv-space-3) var(--hv-space-3);
          text-align: left;
        }
        .hv-onboarding-step[aria-current="step"] {
          color: var(--hv-fg);
          border-left-color: var(--hv-fg);
        }
        .hv-onboarding-step span:first-child {
          font-family: var(--hv-font-mono);
          color: var(--hv-fg);
        }
        .hv-onboarding-step strong {
          display: block;
          font-weight: 500;
        }
        .hv-onboarding-step small {
          color: var(--hv-fg-subtle);
          line-height: var(--hv-leading-normal);
        }
        .hv-onboarding-main {
          min-height: 720px;
          padding: clamp(24px, 4vw, 48px);
        }
        .hv-onboarding-main h2 {
          margin: 0;
          font-family: var(--hv-font-primary);
          font-size: clamp(30px, 3vw, 42px);
          font-weight: 300;
          line-height: 1.08;
        }
        .hv-onboarding-main p {
          color: var(--hv-fg-muted);
          line-height: var(--hv-leading-loose);
        }
        .hv-onboarding-form {
          margin-top: var(--hv-space-5);
          display: grid;
          gap: var(--hv-space-4);
        }
        .hv-onboarding-field {
          display: grid;
          gap: var(--hv-space-2);
        }
        .hv-onboarding-field span {
          color: var(--hv-fg);
          font-size: var(--hv-text-small);
          font-weight: 500;
        }
        .hv-onboarding-field input {
          width: 100%;
          border: 1px solid var(--hv-border-soft);
          background: var(--hv-field-bg);
          color: var(--hv-fg);
          border-radius: var(--hv-radius-carved);
          padding: 13px 15px;
          outline: none;
        }
        .hv-onboarding-field input:focus {
          border-color: var(--hv-field-focus-border);
          box-shadow: 0 0 0 3px var(--hv-ink-wash-02);
        }
        .hv-onboarding-error {
          border: 1px solid var(--hv-accent-danger);
          background: var(--hv-accent-danger-wash);
          color: var(--hv-accent-danger);
          border-radius: var(--hv-radius-carved);
          padding: var(--hv-space-3);
        }
        .hv-onboarding-actions {
          display: flex;
          justify-content: space-between;
          gap: var(--hv-space-3);
          margin-top: var(--hv-space-5);
        }
        .hv-onboarding-action-group {
          display: flex;
          justify-content: flex-end;
          gap: var(--hv-space-3);
          flex-wrap: wrap;
        }
        .hv-onboarding-button {
          min-height: 42px;
          border-radius: var(--hv-radius-carved);
          border: 1px solid var(--hv-border-firm);
          padding: 10px 18px;
          font-weight: 400;
          letter-spacing: var(--hv-track-button);
          cursor: pointer;
        }
        .hv-onboarding-button-primary {
          background: var(--hv-button-primary-bg);
          color: var(--hv-button-primary-fg);
          box-shadow: var(--hv-shadow-block);
        }
        .hv-onboarding-button-ghost {
          background: transparent;
          color: var(--hv-fg-muted);
        }
        .hv-onboarding-button:disabled {
          cursor: not-allowed;
          opacity: 0.45;
          box-shadow: none;
        }
        .hv-onboarding-provider-grid,
        .hv-onboarding-machine-grid,
        .hv-onboarding-workforce-grid {
          display: grid;
          gap: var(--hv-space-3);
          margin-top: var(--hv-space-4);
        }
        .hv-onboarding-provider,
        .hv-onboarding-machine,
        .hv-onboarding-workforce-card,
        .hv-onboarding-receipt-row {
          border: 1px solid var(--hv-border-hair);
          background: var(--hv-bg-raised);
          border-radius: var(--hv-radius-carved);
          padding: var(--hv-space-3);
        }
        .hv-onboarding-provider {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: var(--hv-space-3);
          align-items: start;
        }
        .hv-onboarding-workforce-card {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: var(--hv-space-3);
        }
        .hv-onboarding-workforce-card h3 {
          margin: 0;
          font-family: var(--hv-font-primary);
          font-size: var(--hv-text-title);
          font-weight: 300;
        }
        .hv-onboarding-workforce-card p {
          margin: var(--hv-space-1) 0 0;
          color: var(--hv-fg-muted);
          line-height: var(--hv-leading-normal);
        }
        .hv-onboarding-provider-title {
          color: var(--hv-fg);
          font-weight: 500;
        }
        .hv-onboarding-provider p,
        .hv-onboarding-machine p {
          margin: 3px 0 0;
          font-size: var(--hv-text-small);
        }
        .hv-onboarding-readiness-section {
          margin-top: var(--hv-space-5);
          padding-top: var(--hv-space-4);
          border-top: 1px solid var(--hv-border-soft);
        }
        .hv-onboarding-readiness-section:first-of-type {
          margin-top: var(--hv-space-4);
        }
        .hv-onboarding-readiness-heading {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: var(--hv-space-3);
        }
        .hv-onboarding-readiness-heading h3 {
          margin: 0;
          font-family: var(--hv-font-primary);
          font-size: var(--hv-text-title);
          font-weight: 300;
        }
        .hv-onboarding-readiness-heading span {
          color: var(--hv-fg-subtle);
          font-size: var(--hv-text-small);
        }
        .hv-onboarding-provider details {
          grid-column: 1 / -1;
          color: var(--hv-fg-subtle);
          font-size: var(--hv-text-small);
        }
        .hv-onboarding-provider code {
          display: inline-block;
          margin-top: var(--hv-space-2);
          color: var(--hv-fg);
          background: var(--hv-ink-wash-02);
          border: 1px solid var(--hv-border-hair);
          border-radius: var(--hv-radius-soft);
          padding: 4px 7px;
        }
        .hv-onboarding-muted {
          color: var(--hv-fg-subtle);
          font-size: var(--hv-text-small);
        }
        .hv-onboarding-badge {
          align-self: start;
          border-radius: var(--hv-radius-carved-sm);
          padding: 4px 8px;
          font-size: var(--hv-text-whisper);
          letter-spacing: var(--hv-track-whisper);
          text-transform: uppercase;
        }
        .hv-onboarding-badge-ready {
          background: var(--hv-badge-success-bg);
          color: var(--hv-badge-success-fg);
        }
        .hv-onboarding-badge-warning,
        .hv-onboarding-badge-missing,
        .hv-onboarding-badge-pending {
          background: var(--hv-badge-warning-bg);
          color: var(--hv-badge-warning-fg);
        }
        .hv-onboarding-badge-skipped {
          background: var(--hv-badge-neutral-bg);
          color: var(--hv-badge-neutral-fg);
        }
        .hv-onboarding-guide {
          min-height: 720px;
          padding: var(--hv-space-5);
          border: 1px solid var(--hv-border-soft);
          background: linear-gradient(145deg, var(--hv-bg), var(--hv-bg-raised));
          border-radius: var(--hv-radius-carved-lg);
          box-shadow: var(--hv-shadow-rest);
          position: relative;
          overflow: hidden;
        }
        .hv-onboarding-guide-seal {
          width: 44px;
          height: 44px;
          display: grid;
          place-items: center;
          border-radius: var(--hv-radius-seal);
          background: var(--hv-accent-danger);
          color: var(--hv-fg-inverse);
          font-family: var(--hv-font-primary);
          font-size: 26px;
        }
        .hv-onboarding-guide pre {
          margin-top: var(--hv-space-6);
          color: var(--hv-fg-muted);
          font-family: var(--hv-font-mono);
          font-size: 13px;
          line-height: 1.7;
          animation: hvOnboardingFloat 8s var(--hv-ease-gentle) infinite alternate;
        }
        .hv-onboarding-guide p {
          position: absolute;
          left: var(--hv-space-5);
          right: var(--hv-space-5);
          bottom: var(--hv-space-5);
          color: var(--hv-fg-subtle);
          font-size: var(--hv-text-small);
          line-height: var(--hv-leading-normal);
        }
        .hv-onboarding-loading {
          margin: 20vh auto 0;
          width: min(420px, 90vw);
          border: 1px solid var(--hv-border-soft);
          background: var(--hv-bg);
          border-radius: var(--hv-radius-carved-lg);
          padding: var(--hv-space-5);
          text-align: center;
          color: var(--hv-fg-muted);
        }
        .hv-onboarding-receipt {
          display: grid;
          gap: var(--hv-space-3);
          margin-top: var(--hv-space-5);
        }
        .hv-onboarding-receipt-row {
          display: grid;
          grid-template-columns: 160px 1fr;
          gap: var(--hv-space-3);
        }
        .hv-onboarding-receipt-row span {
          color: var(--hv-fg-subtle);
        }
        .hv-onboarding-receipt-row strong {
          color: var(--hv-fg);
          font-weight: 500;
        }
        .hv-onboarding-gaia-card {
          display: grid;
          grid-template-columns: 84px 1fr;
          gap: var(--hv-space-4);
          align-items: center;
          margin-top: var(--hv-space-5);
          border: 1px solid var(--hv-border-hair);
          background: var(--hv-bg-raised);
          border-radius: var(--hv-radius-carved);
          padding: var(--hv-space-4);
        }
        .hv-onboarding-gaia-avatar {
          width: 84px;
          height: 84px;
          border-radius: 50%;
          object-fit: cover;
          border: 1px solid var(--hv-border-soft);
          background: var(--hv-bg);
        }
        @keyframes hvOnboardingFloat {
          from { transform: translateY(0); }
          to { transform: translateY(10px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .hv-onboarding-guide pre { animation: none; }
        }
        @media (max-width: 1080px) {
          .hv-onboarding-frame {
            grid-template-columns: 1fr;
          }
          .hv-onboarding-main,
          .hv-onboarding-guide {
            min-height: auto;
          }
          .hv-onboarding-progress nav {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: var(--hv-space-2);
          }
          .hv-onboarding-step {
            border: 1px solid var(--hv-border-hair);
            border-radius: var(--hv-radius-carved);
            padding: var(--hv-space-3);
          }
        }
      `}</style>

      <div className="hv-onboarding-frame">
        <aside className="hv-onboarding-panel hv-onboarding-progress" data-testid="onboarding-progress">
          <div className="hv-onboarding-eyebrow">Herd / First Run</div>
          <h1 className="hv-onboarding-title">Welcome to Herd</h1>
          <nav aria-label="First run steps">
            {steps.map((step) => (
              <button
                key={step.id}
                type="button"
                className="hv-onboarding-step"
                aria-current={step.id === currentStepId ? 'step' : undefined}
                onClick={() => setActiveStepId(step.id)}
                data-testid={`onboarding-step-${step.id}`}
              >
                <span>{stateGlyph(step.state)}</span>
                <span>
                  <strong>{step.label}</strong>
                  <small>{step.summary}</small>
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="hv-onboarding-panel hv-onboarding-main" data-testid="onboarding-active-step">
          <div className="hv-onboarding-eyebrow">
            Step {currentStepIndex + 1 || 1} of {steps.length || 5}
          </div>

          {currentStepId === 'founder-org' ? (
            <>
              <h2>Founder and organization</h2>
              <p>Create the local founder profile and organization identity. This still writes through the existing org API.</p>
              <form
                className="hv-onboarding-form"
                onSubmit={handleFounderSubmit}
                data-testid="founder-org-setup-form"
                aria-busy={isSubmitting}
              >
                <label className="hv-onboarding-field">
                  <span>Org display name</span>
                  <input
                    data-testid="org-display-name-input"
                    type="text"
                    value={formState.orgDisplayName}
                    onChange={(event) => updateField('orgDisplayName', event.target.value)}
                    autoComplete="organization"
                    autoFocus
                    disabled={isSubmitting}
                    aria-invalid={Boolean(errors.orgDisplayName)}
                  />
                  {errors.orgDisplayName ? <p className="hv-onboarding-error" role="alert">{errors.orgDisplayName}</p> : null}
                </label>

                <label className="hv-onboarding-field">
                  <span>Founder display name</span>
                  <input
                    data-testid="founder-display-name-input"
                    type="text"
                    value={formState.founderDisplayName}
                    onChange={(event) => updateField('founderDisplayName', event.target.value)}
                    autoComplete="name"
                    disabled={isSubmitting}
                    aria-invalid={Boolean(errors.founderDisplayName)}
                  />
                  {errors.founderDisplayName ? <p className="hv-onboarding-error" role="alert">{errors.founderDisplayName}</p> : null}
                </label>

                <label className="hv-onboarding-field">
                  <span>Founder email</span>
                  <input
                    data-testid="founder-email-input"
                    type="email"
                    value={formState.founderEmail}
                    onChange={(event) => updateField('founderEmail', event.target.value)}
                    autoComplete="email"
                    disabled={isSubmitting}
                    aria-invalid={Boolean(errors.founderEmail)}
                  />
                  {errors.founderEmail ? <p className="hv-onboarding-error" role="alert">{errors.founderEmail}</p> : null}
                </label>

                {actionError ? <div className="hv-onboarding-error" role="alert">{actionError}</div> : null}
                {isSubmitting ? <p className="hv-onboarding-muted" role="status">Saving founder and organization...</p> : null}

                <div className="hv-onboarding-actions">
                  <button type="button" className="hv-onboarding-button hv-onboarding-button-ghost" disabled>
                    Back
                  </button>
                  <button
                    type="submit"
                    data-testid="founder-org-setup-submit"
                    className="hv-onboarding-button hv-onboarding-button-primary"
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? 'Saving...' : 'Save and continue'}
                  </button>
                </div>
              </form>
            </>
          ) : null}

          {currentStepId === 'gaia' ? (
            <section aria-busy={isGaiaPending} data-testid="gaia-onboarding-section">
              <h2>Gaia, mother of commanders</h2>
              <p>
                Seed Gaia as the first commander for onboarding, commander creation, provider setup, and ongoing maintenance.
              </p>
              <div className="hv-onboarding-gaia-card">
                <img
                  className="hv-onboarding-gaia-avatar"
                  src={status?.gaia.avatarUrl ?? '/assets/commanders/gaia-profile.png'}
                  alt="Gaia commander headshot"
                  data-testid="gaia-avatar"
                />
                <div>
                  <div className="hv-onboarding-provider-title">{status?.gaia.displayName ?? 'Gaia'}</div>
                  <p>Bundled onboarding commander profile.</p>
                </div>
              </div>
              <div className="hv-onboarding-receipt">
                <div className="hv-onboarding-receipt-row">
                  <span>Name</span>
                  <strong>{status?.gaia.displayName ?? 'Gaia'}</strong>
                </div>
                <div className="hv-onboarding-receipt-row">
                  <span>Default provider</span>
                  <strong>{status?.gaia.defaultProviderId ?? 'Unavailable'}</strong>
                </div>
                <div className="hv-onboarding-receipt-row">
                  <span>State</span>
                  <strong>{status?.gaia.exists ? 'Ready' : 'Not created yet'}</strong>
                </div>
              </div>
              {actionError ? <div className="hv-onboarding-error" role="alert">{actionError}</div> : null}
              {isGaiaPending ? <p className="hv-onboarding-muted" role="status">Creating Gaia and preparing her onboarding chat...</p> : null}
              <SectionActions
                onBack={() => setActiveStepId(previousStep?.id ?? 'founder-org')}
                onNext={status?.gaia.exists ? () => setActiveStepId('starter-workforce') : handleSeedGaia}
                nextDisabled={isGaiaPending}
                nextLabel={status?.gaia.exists ? 'Continue' : isGaiaPending ? 'Creating...' : 'Create Gaia'}
                nextTestId="seed-gaia-submit"
              />
            </section>
          ) : null}

          {currentStepId === 'starter-workforce' ? (
            <section
              aria-busy={isStarterWorkforcePending || isSkipStarterWorkforcePending}
              data-testid="starter-workforce-onboarding-section"
            >
              <h2>Starter workforce</h2>
              <p>
                Install the bundled commanders that make a fresh Herd instance useful immediately.
                Each package is stored on disk and installed through the backend commander API.
              </p>
              <section className="hv-onboarding-workforce-grid" aria-label="Starter workforce">
                {(status?.starterWorkforce.packages ?? []).map((pkg) => (
                  <article
                    key={pkg.packageId}
                    className="hv-onboarding-workforce-card"
                    data-testid={`starter-workforce-card-${pkg.packageId}`}
                  >
                    <div>
                      <h3>{pkg.displayName}</h3>
                      <p>{pkg.role}</p>
                      <p>{pkg.summary}</p>
                    </div>
                    <div className={`hv-onboarding-badge ${pkg.installed
                      ? 'hv-onboarding-badge-ready'
                      : isStarterWorkforcePending
                        ? 'hv-onboarding-badge-pending'
                        : 'hv-onboarding-badge-skipped'}`}
                    >
                      {pkg.installed
                        ? 'installed'
                        : isStarterWorkforcePending
                          ? 'pending'
                          : status?.starterWorkforce.skipped ? 'skipped' : 'ready'}
                    </div>
                  </article>
                ))}
              </section>
              {actionError ? <div className="hv-onboarding-error" role="alert">{actionError}</div> : null}
              {isStarterWorkforcePending
                ? <p className="hv-onboarding-muted" role="status">Installing starter commander packages...</p>
                : null}
              {isSkipStarterWorkforcePending
                ? <p className="hv-onboarding-muted" role="status">Skipping starter workforce setup...</p>
                : null}
              <SectionActions
                onBack={() => setActiveStepId(previousStep?.id ?? 'gaia')}
                onNext={status?.starterWorkforce.complete ? () => setActiveStepId('providers-machines') : handleSeedStarterWorkforce}
                nextDisabled={isStarterWorkforcePending || isSkipStarterWorkforcePending}
                nextLabel={status?.starterWorkforce.complete ? 'Continue' : isStarterWorkforcePending ? 'Installing...' : 'Install starter workforce'}
                nextTestId="seed-starter-workforce-submit"
                secondaryAction={!status?.starterWorkforce.complete ? handleSkipStarterWorkforce : undefined}
                secondaryDisabled={isStarterWorkforcePending || isSkipStarterWorkforcePending}
                secondaryLabel={isSkipStarterWorkforcePending ? 'Skipping...' : 'Skip for now'}
                secondaryTestId="skip-starter-workforce-submit"
              />
            </section>
          ) : null}

          {currentStepId === 'providers-machines' ? (
            <>
              <h2>Providers and machines</h2>
              <p>
                Provider and machine readiness is reported by the backend. Missing auth can be completed now or later from settings.
              </p>
              {status?.providerExecution ? (
                <section
                  className="hv-onboarding-readiness-section"
                  aria-label="Provider execution mode"
                  data-testid="provider-execution-readiness"
                >
                  <div className="hv-onboarding-readiness-heading">
                    <h3>Execution mode</h3>
                    <span>{status.providerExecution.mode}</span>
                  </div>
                  <p>{status.providerExecution.summary}</p>
                  {status.providerExecution.daemonRequired ? (
                    <p>
                      {status.providerExecution.connectedDaemonCount} connected ·{' '}
                      {status.providerExecution.providerReadyDaemonCount} provider-ready daemon
                      {status.providerExecution.providerReadyDaemonCount === 1 ? '' : 's'}
                    </p>
                  ) : null}
                </section>
              ) : null}
              <section
                className="hv-onboarding-readiness-section"
                aria-label="Provider readiness"
                data-testid="provider-readiness-section"
              >
                <div className="hv-onboarding-readiness-heading">
                  <h3>Provider readiness</h3>
                  <span>CLI and auth</span>
                </div>
                <div className="hv-onboarding-provider-grid">
                  {providerSummary.map((provider) => (
                    <ProviderCard key={provider.id} provider={provider} />
                  ))}
                </div>
              </section>
              <section
                className="hv-onboarding-readiness-section"
                aria-label="Machine readiness"
                data-testid="machine-readiness-section"
              >
                <div className="hv-onboarding-readiness-heading">
                  <h3>Machine readiness</h3>
                  <span>runtime targets</span>
                </div>
                <div className="hv-onboarding-machine-grid">
                  {(status?.machines ?? []).map((machine) => (
                    <article key={machine.id} className="hv-onboarding-machine" data-testid={`machine-card-${machine.id}`}>
                      <div className="hv-onboarding-provider-title">{machine.label}</div>
                      <p>{machine.summary}</p>
                      <p>{machine.envFile ? `env: ${machine.envFile}` : 'no env file configured'}</p>
                    </article>
                  ))}
                </div>
              </section>
              <SectionActions
                onBack={() => setActiveStepId(previousStep?.id ?? 'gaia')}
                onNext={() => setActiveStepId('credentials')}
              />
            </>
          ) : null}

          {currentStepId === 'credentials' ? (
            <>
              <h2>Replace bootstrap access</h2>
              <p>{status?.credentials.summary}</p>
              <section className="hv-onboarding-readiness-section" data-testid="credential-lifecycle-section">
                <div className="hv-onboarding-readiness-heading">
                  <h3>Permanent API key</h3>
                  <span>{status?.credentials.state ?? 'missing'}</span>
                </div>
                <p>
                  Create the permanent admin key, save its one-time value, verify this browser with it,
                  and only then revoke the temporary bootstrap key.
                </p>
                {!createdPermanentKey && !status?.credentials.ready ? (
                  <button
                    type="button"
                    className="hv-onboarding-button hv-onboarding-button-primary"
                    onClick={handleCreatePermanentKey}
                    disabled={isCredentialPending || apiKeyScopeCatalog.isLoading}
                    data-testid="create-permanent-key"
                  >
                    {createApiKey.isPending ? 'Creating...' : 'Create permanent admin key'}
                  </button>
                ) : null}
                {createdPermanentKey ? (
                  <div className="hv-onboarding-receipt" data-testid="permanent-key-reveal">
                    <p><strong>Save this key now. It is shown only once.</strong></p>
                    <code style={{ overflowWrap: 'anywhere' }}>{createdPermanentKey.key}</code>
                    <div className="hv-onboarding-action-group">
                      <button
                        type="button"
                        className="hv-onboarding-button hv-onboarding-button-ghost"
                        onClick={handleCopyPermanentKey}
                        data-testid="copy-permanent-key"
                      >
                        {keyCopied ? 'Copied' : 'Copy key'}
                      </button>
                      <button
                        type="button"
                        className="hv-onboarding-button hv-onboarding-button-primary"
                        onClick={handleUsePermanentKey}
                        disabled={isCredentialPending}
                        data-testid="use-permanent-key"
                      >
                        Verify and use permanent key
                      </button>
                    </div>
                  </div>
                ) : null}
                {(status?.credentials.activeBootstrapKeys.length ?? 0) > 0 ? (
                  <button
                    type="button"
                    className="hv-onboarding-button hv-onboarding-button-primary"
                    onClick={handleRevokeBootstrapKeys}
                    disabled={isCredentialPending || !status?.credentials.canRevokeBootstrap}
                    data-testid="revoke-bootstrap-keys"
                  >
                    Revoke {status?.credentials.activeBootstrapKeys.length ?? 0} bootstrap key
                    {(status?.credentials.activeBootstrapKeys.length ?? 0) === 1 ? '' : 's'}
                  </button>
                ) : null}
              </section>
              {actionError ? <div className="hv-onboarding-error" role="alert">{actionError}</div> : null}
              <SectionActions
                onBack={() => setActiveStepId(previousStep?.id ?? 'providers-machines')}
                onNext={() => setActiveStepId('launch')}
                nextDisabled={!status?.credentials.ready || isCredentialPending}
                nextLabel={status?.credentials.ready ? 'Continue' : 'Complete credential rotation'}
                nextTestId="credential-lifecycle-continue"
              />
            </>
          ) : null}

          {currentStepId === 'launch' || currentStepId === 'instance' ? (
            <>
              <h2>Ready to launch</h2>
              <p>
                This receipt confirms that permanent access is active and temporary bootstrap access is gone.
              </p>
              <div className="hv-onboarding-receipt" data-testid="onboarding-receipt">
                {[
                  ['URL', status?.receipt.url],
                  ['Account', status?.receipt.account],
                  ['Organization', status?.receipt.organization],
                  ['Founder', status?.receipt.founder],
                  ['Commander', status?.receipt.commander],
                  ['Machine', status?.receipt.machine],
                  ['Providers', status?.receipt.providerSummary],
                  ['Time to first reply', formatTimeToFirstReply(status?.timeToFirstReply.elapsedMinutes)],
                ].map(([label, value]) => (
                  <div className="hv-onboarding-receipt-row" key={label}>
                    <span>{label}</span>
                    <strong>{value || 'pending'}</strong>
                  </div>
                ))}
              </div>
              <SectionActions
                onBack={() => setActiveStepId(previousStep?.id ?? 'providers-machines')}
                onNext={handleFinishOnboarding}
                nextDisabled={!status?.credentials.ready || isFinishPending}
                nextLabel={isFinishPending ? 'Finishing...' : 'Open command room'}
                nextTestId="onboarding-launch-submit"
              />
            </>
          ) : null}
        </main>

        <InkGuide />
      </div>
    </div>
  )
}
