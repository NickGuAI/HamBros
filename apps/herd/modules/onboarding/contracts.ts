import type { OrgIdentity } from '../org-identity/types.js'
import type { Operator } from '../operators/types.js'

export const FOUNDER_SETUP_PATH = '/welcome'
export const FOUNDER_SETUP_COMPLETED_PATH = '/org'
export const FOUNDER_SETUP_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export const FOUNDER_DISPLAY_NAME_MAX_LENGTH = 120

export interface FounderOrgSetupFormValues {
  orgDisplayName: string
  founderDisplayName: string
  founderEmail: string
}

export interface FounderOrgSetupValidationErrors {
  orgDisplayName?: string
  founderDisplayName?: string
  founderEmail?: string
}

export const DEFAULT_FOUNDER_ORG_SETUP_FORM_VALUES: FounderOrgSetupFormValues = {
  orgDisplayName: '',
  founderDisplayName: '',
  founderEmail: '',
}

export interface FounderOrgSetupRequest {
  displayName: string
  founder: {
    displayName: string
    email: string
  }
}

export interface FounderOrgSetupResponse {
  operator: Operator
  orgIdentity: OrgIdentity
  nextRoute: string
}

export interface FounderSetupStatus {
  setupComplete: boolean
  defaultValues: FounderOrgSetupFormValues
  validationErrors: FounderOrgSetupValidationErrors
  nextRoute: string
}

export type OnboardingStepId =
  | 'instance'
  | 'founder-org'
  | 'gaia'
  | 'starter-workforce'
  | 'providers-machines'
  | 'credentials'
  | 'launch'

export type OnboardingStepState = 'complete' | 'current' | 'pending' | 'warning'

export interface OnboardingStep {
  id: OnboardingStepId
  label: string
  state: OnboardingStepState
  summary: string
}

export type OnboardingReadinessState =
  | 'ready'
  | 'warning'
  | 'missing'
  | 'skipped'

export interface ProviderOnboardingReadiness {
  id: string
  label: string
  cliBinaryName: string | null
  installed: boolean | null
  authConfigured: boolean | null
  authMode: 'env' | 'login' | 'not-required' | 'missing' | 'unknown'
  state: OnboardingReadinessState
  shortAction: string
  verificationCommand: string | null
  envSourceKey: string | null
}

export interface MachineOnboardingReadiness {
  id: string
  label: string
  transport: 'local' | 'ssh' | 'daemon'
  state: OnboardingReadinessState
  envFile: string | null
  cwd: string | null
  summary: string
}

export interface ProviderExecutionOnboardingStatus {
  mode: 'host-or-daemon' | 'daemon-only'
  hostExecutionAllowed: boolean
  daemonRequired: boolean
  state: OnboardingReadinessState
  registeredDaemonCount: number
  connectedDaemonCount: number
  providerReadyDaemonCount: number
  readyProviderIds: string[]
  summary: string
}

export type OnboardingCredentialAuth = 'bootstrap' | 'permanent' | 'auth0' | 'unknown'

export interface OnboardingBootstrapKeyStatus {
  id: string
  name: string
  expiresAt: string | null
}

export interface OnboardingCredentialStatus {
  ready: boolean
  state: OnboardingReadinessState
  activePermanentKeyCount: number
  activeBootstrapKeys: OnboardingBootstrapKeyStatus[]
  authenticatedAs: OnboardingCredentialAuth
  canRevokeBootstrap: boolean
  summary: string
}

export interface GaiaOnboardingStatus {
  commanderId: string | null
  displayName: string
  avatarUrl: string
  exists: boolean
  conversationId: string | null
  defaultProviderId: string | null
}

export interface StarterCommanderPackageStatus {
  packageId: string
  displayName: string
  role: string
  summary: string
  installed: boolean
  commanderId: string | null
}

export interface StarterWorkforceOnboardingStatus {
  packages: StarterCommanderPackageStatus[]
  installedCount: number
  totalCount: number
  skipped: boolean
  complete: boolean
}

export interface OnboardingReceipt {
  url: string
  account: string
  organization: string | null
  founder: string | null
  commander: string | null
  machine: string | null
  providerSummary: string
}

export interface OnboardingFirstReplyMetric {
  installStartedAt: string | null
  firstReplyAt: string | null
  elapsedMs: number | null
  elapsedMinutes: number | null
}

export interface OnboardingStatus {
  currentStepId: OnboardingStepId
  steps: OnboardingStep[]
  founderSetup: FounderSetupStatus
  gaia: GaiaOnboardingStatus
  starterWorkforce: StarterWorkforceOnboardingStatus
  providers: ProviderOnboardingReadiness[]
  machines: MachineOnboardingReadiness[]
  providerExecution: ProviderExecutionOnboardingStatus
  credentials: OnboardingCredentialStatus
  receipt: OnboardingReceipt
  timeToFirstReply: OnboardingFirstReplyMetric
  launchTarget: string
}

export interface SeedGaiaOnboardingResponse {
  gaia: GaiaOnboardingStatus
  status: OnboardingStatus
}

export interface SeedStarterWorkforceOnboardingResponse {
  starterWorkforce: StarterWorkforceOnboardingStatus
  status: OnboardingStatus
}

export interface SkipStarterWorkforceOnboardingResponse {
  starterWorkforce: StarterWorkforceOnboardingStatus
  status: OnboardingStatus
}

export interface FinishOnboardingResponse {
  launchTarget: string
  status: OnboardingStatus
}

export function validateFounderOrgSetupFormValues(
  state: FounderOrgSetupFormValues,
): FounderOrgSetupValidationErrors {
  const orgDisplayName = state.orgDisplayName.trim()
  const founderDisplayName = state.founderDisplayName.trim()
  const founderEmail = state.founderEmail.trim()
  const errors: FounderOrgSetupValidationErrors = {}

  if (!orgDisplayName) {
    errors.orgDisplayName = 'Org display name is required.'
  }

  if (!founderDisplayName) {
    errors.founderDisplayName = 'Founder display name is required.'
  } else if (founderDisplayName.length > FOUNDER_DISPLAY_NAME_MAX_LENGTH) {
    errors.founderDisplayName = `Founder display name must be ${FOUNDER_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`
  }

  if (!founderEmail) {
    errors.founderEmail = 'Founder email is required.'
  } else if (!FOUNDER_SETUP_EMAIL_PATTERN.test(founderEmail)) {
    errors.founderEmail = 'Founder email must be a valid email address.'
  }

  return errors
}
