import type { CSSProperties } from 'react'
import type { AgentType } from '@/types'
import type { ConversationCredentialSelectionMode } from '@modules/commanders/conversation-credential-selection.js'
import {
  credentialPoolCredentialOptionLabel,
  isCredentialPoolCredentialSelectable,
  isCredentialPoolProvider,
  useCredentialPool,
} from '@/hooks/use-credential-pools'

export function CredentialPoolSelect({
  provider,
  credentialSelectionMode,
  value,
  currentCredentialPoolId,
  onChange,
  disabled = false,
  dataTestId,
  className,
  style,
}: {
  provider: AgentType | null | undefined
  credentialSelectionMode: ConversationCredentialSelectionMode
  value: string | null
  currentCredentialPoolId?: string | null
  onChange: (credentialPoolId: string | null) => void
  disabled?: boolean
  dataTestId: string
  className?: string
  style?: CSSProperties
}) {
  const poolQuery = useCredentialPool(
    credentialSelectionMode === 'per-conversation' ? provider : null,
  )
  if (
    credentialSelectionMode !== 'per-conversation'
    || !isCredentialPoolProvider(provider)
  ) {
    return null
  }
  const readinessHost = provider === 'claude' ? 'remote' : undefined

  const credentials = poolQuery.data?.credentials ?? []
  const knownIds = new Set(credentials.map((credential) => credential.id))
  const missingSelectedId = value && !knownIds.has(value) ? value : null
  const missingCurrentId = currentCredentialPoolId
    && !knownIds.has(currentCredentialPoolId)
    && currentCredentialPoolId !== missingSelectedId
    ? currentCredentialPoolId
    : null

  return (
    <select
      className={className}
      data-testid={dataTestId}
      value={value ?? ''}
      onChange={(event) => onChange(event.currentTarget.value || null)}
      disabled={disabled}
      aria-label="Credential"
      aria-busy={poolQuery.isFetching || undefined}
      style={style}
    >
      <option value="">Automatic</option>
      {missingSelectedId ? (
        <option value={missingSelectedId} disabled>
          Selected credential ({missingSelectedId}) · unavailable
        </option>
      ) : null}
      {missingCurrentId ? (
        <option value={missingCurrentId} disabled>
          Current credential ({missingCurrentId}) · unavailable
        </option>
      ) : null}
      {credentials.map((credential) => (
        <option
          key={credential.id}
          value={credential.id}
          disabled={!isCredentialPoolCredentialSelectable(provider, credential, readinessHost)}
        >
          {credentialPoolCredentialOptionLabel(provider, credential, readinessHost)}
        </option>
      ))}
    </select>
  )
}
