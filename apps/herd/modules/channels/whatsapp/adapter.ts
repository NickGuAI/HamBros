import { randomUUID } from 'node:crypto'
import type { CommanderChannelBindingStore } from '../store.js'
import { checkAccountInboundPolicy } from '../policy.js'
import { effectiveBindingCommanderId } from '../binding-routing.js'
import { ChannelDropStatusStore, buildChannelLastDrop, readDroppedChannelResponse } from '../drop-status.js'
import type {
  ChannelAdapter,
  ChannelInboundDecision,
  ChannelInboundEvent,
  ChannelLastDrop,
  ChannelOutboundMessageRef,
  ChannelOutboundPayload,
  ChannelPairingChallenge,
  ChannelPairingInput,
  ChannelPairingResponse,
  ChannelPairingStatus,
  ChannelRuntime,
  CommanderChannelBinding,
} from '../types.js'
import { CommanderChannelBindingConflictError } from '../store.js'
import type { Conversation } from '../../commanders/conversation-store.js'
import { withCommanderRuntimeLaunch } from '../../commanders/package-lifecycle-state.js'
import { parseWhatsAppChannelConfig, type WhatsAppChannelConfig } from './config.js'
import { BaileysWhatsAppTransport } from './baileys-transport.js'
import type {
  WhatsAppPairingSession,
  WhatsAppRuntimeStatus,
  WhatsAppTransport,
  WhatsAppTransportRuntime,
} from './transport.js'

interface WhatsAppRuntime extends ChannelRuntime<WhatsAppChannelConfig> {
  transportRuntime: WhatsAppTransportRuntime
  lastDrop?: ChannelLastDrop
}

interface PendingPairing {
  commanderId: string
  displayName: string
  config: WhatsAppChannelConfig
  session: WhatsAppPairingSession
  cleanupTimer?: NodeJS.Timeout
}

interface WhatsAppChannelMessagePayload {
  provider: 'whatsapp'
  accountId: string
  chatType: string
  peerId: string
  displayName: string
  message: string
  mode: 'followup'
  commanderId?: string
  groupId?: string
  threadId?: string
  audio?: {
    buffer: string
    mimeType: string
    durationMs?: number
  }
  rawTimestamp: string | number
  rawSourceId: string
  metadata?: Record<string, unknown>
}

export interface WhatsAppChannelAdapterOptions {
  bindingStore: CommanderChannelBindingStore
  internalToken: string
  dataDir: string
  apiBaseUrl?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  transport?: WhatsAppTransport
  logger?: Pick<Console, 'warn' | 'error' | 'log'>
}

function resolveApiBaseUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.HERD_API_BASE_URL?.trim()
  if (explicit) {
    return explicit.replace(/\/+$/u, '')
  }
  const port = env.PORT?.trim() || '20001'
  return `http://127.0.0.1:${port}`
}

function normalizeAccountId(raw: string | undefined): string {
  const normalized = raw?.trim()
  if (normalized) {
    const sanitized = normalized
      .replace(/\s+/gu, '-')
      .replace(/[^a-zA-Z0-9._@:+-]+/gu, '')
      .slice(0, 120)
    if (sanitized) {
      return sanitized
    }
  }
  return `wa-${randomUUID().slice(0, 8)}`
}

function formatInboundMessage(event: ChannelInboundEvent): string {
  const lines: string[] = []
  if (event.text?.trim()) {
    lines.push(event.text.trim())
  }
  for (const media of event.media ?? []) {
    const label = media.filename ?? media.metadata?.type ?? 'media'
    const descriptor = [label, media.mimeType].filter(Boolean).join(' · ')
    lines.push(`[media attached: ${descriptor}]`)
  }
  return lines.join('\n').trim()
}

function statusForStoppedBinding(binding: CommanderChannelBinding, config: WhatsAppChannelConfig): WhatsAppRuntimeStatus {
  return {
    provider: 'whatsapp',
    accountId: binding.accountId,
    transport: config.transport,
    state: binding.enabled ? 'disconnected' : 'stopped',
    connected: false,
  }
}

function statusInstructions(status: WhatsAppRuntimeStatus): string {
  if (status.connected || status.state === 'connected') {
    return 'WhatsApp is connected. Completing the channel binding.'
  }
  if (status.state === 'pairing') {
    return status.lastError?.includes('restart')
      ? 'WhatsApp accepted the scan and is reconnecting. Keep WhatsApp open until it connects.'
      : 'Open WhatsApp, go to Linked Devices, and scan this QR code.'
  }
  if (status.state === 'logged-out') {
    return 'WhatsApp reported this session is logged out. Start pairing again to scan a fresh QR code.'
  }
  if (status.state === 'disconnected') {
    return 'WhatsApp is not connected yet. Keep WhatsApp open, or restart pairing if it does not recover.'
  }
  if (status.state === 'error' && status.lastError) {
    return status.lastError
  }
  return 'Waiting for WhatsApp pairing status.'
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function whatsappMentionedBot(event: ChannelInboundEvent): boolean {
  const metadata = metadataRecord(event.metadata)
  const whatsapp = metadataRecord(metadata.whatsapp)
  return metadata.mentionedBot === true || whatsapp.mentionedBot === true
}

export class WhatsAppChannelAdapter implements ChannelAdapter<WhatsAppChannelConfig> {
  readonly provider = 'whatsapp' as const
  readonly capabilities = {
    voiceNotes: true,
    media: true,
    threading: false,
    typingIndicators: false,
    presence: false,
    reactions: false,
    supportsMessageEdit: true,
    markdownDialect: 'whatsapp' as const,
  }

  private readonly bindingStore: CommanderChannelBindingStore
  private readonly internalToken: string
  private readonly dataDir: string
  private readonly apiBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly transport: WhatsAppTransport
  private readonly logger: Pick<Console, 'warn' | 'error' | 'log'>
  private readonly dropStatusStore: ChannelDropStatusStore
  private readonly runtimesByAccount = new Map<string, WhatsAppRuntime>()
  private readonly lastDropsByAccount = new Map<string, ChannelLastDrop>()
  private readonly pendingPairings = new Map<string, PendingPairing>()

  constructor(options: WhatsAppChannelAdapterOptions) {
    this.bindingStore = options.bindingStore
    this.internalToken = options.internalToken
    this.dataDir = options.dataDir
    this.apiBaseUrl = (options.apiBaseUrl ?? resolveApiBaseUrl(options.env ?? process.env)).replace(/\/+$/u, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.transport = options.transport ?? new BaileysWhatsAppTransport()
    this.logger = options.logger ?? console
    this.dropStatusStore = new ChannelDropStatusStore(this.dataDir)
  }

  normalizeInbound(payload: unknown): ChannelInboundEvent {
    const raw = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const accountId = typeof raw.accountId === 'string' ? raw.accountId : 'default'
    const peerId = typeof raw.peerId === 'string' ? raw.peerId : typeof raw.from === 'string' ? raw.from : 'unknown'
    return {
      provider: 'whatsapp',
      accountId,
      chatType: raw.chatType === 'group' ? 'group' : 'direct',
      peerId,
      peerDisplayName: typeof raw.displayName === 'string' ? raw.displayName : peerId,
      ...(typeof raw.groupId === 'string' ? { groupId: raw.groupId } : {}),
      ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
      ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
      ...(raw.metadata && typeof raw.metadata === 'object' ? { metadata: { ...raw.metadata } } : {}),
      rawTimestamp: typeof raw.rawTimestamp === 'number' || typeof raw.rawTimestamp === 'string'
        ? raw.rawTimestamp
        : new Date().toISOString(),
      rawSourceId: typeof raw.rawSourceId === 'string' ? raw.rawSourceId : `${accountId}:${peerId}:${Date.now()}`,
    }
  }

  async start(binding: CommanderChannelBinding): Promise<WhatsAppRuntime> {
    const config = parseWhatsAppChannelConfig(binding.config, binding.accountId, this.dataDir)
    if (config.transport !== 'baileys') {
      throw new Error(`Unsupported WhatsApp transport "${config.transport}" for runtime start`)
    }
    const existing = this.runtimesByAccount.get(binding.accountId)
    if (existing) {
      await existing.transportRuntime.stop().catch(() => undefined)
      this.runtimesByAccount.delete(binding.accountId)
    }

    const transportRuntime = await this.transport.start({
      accountId: binding.accountId,
      config,
      handlers: {
        onInbound: (event) => this.forwardInbound(event),
        onStatus: (status) => {
          this.logger.log?.(`[channels/whatsapp] ${binding.accountId}: ${status.state}`)
        },
      },
    })
    const runtime: WhatsAppRuntime = {
      provider: 'whatsapp',
      accountId: binding.accountId,
      commanderId: binding.commanderId,
      config,
      accountBinding: binding,
      transportRuntime,
    }
    this.runtimesByAccount.set(binding.accountId, runtime)
    return runtime
  }

  async stop(runtime: ChannelRuntime<WhatsAppChannelConfig>): Promise<void> {
    const active = this.runtimesByAccount.get(runtime.accountId)
    this.runtimesByAccount.delete(runtime.accountId)
    await active?.transportRuntime.stop()
  }

  async beginPairing(input: ChannelPairingInput): Promise<ChannelPairingChallenge> {
    await this.pruneExpiredPairings()
    const accountId = normalizeAccountId(input.accountId)
    const config = parseWhatsAppChannelConfig(
      {
        ...input.config,
        transport: 'baileys',
      },
      accountId,
      this.dataDir,
    )
    const challengeId = randomUUID()
    const outcome = await withCommanderRuntimeLaunch(input.commanderId, this.dataDir, async () => {
      let session: WhatsAppPairingSession | null = null
      try {
        session = await this.transport.beginPairing({
          challengeId,
          accountId,
          config,
          handlers: {
            onInbound: () => undefined,
          },
        })
        const cleanupTimer = this.schedulePairingCleanup(challengeId, session.expiresAt)
        this.pendingPairings.set(challengeId, {
          commanderId: input.commanderId,
          displayName: input.displayName?.trim() || `WhatsApp ${accountId}`,
          config,
          session,
          cleanupTimer,
        })
        return {
          ok: true as const,
          challenge: {
            provider: 'whatsapp' as const,
            commanderId: input.commanderId,
            kind: session.qrCode ? 'qr' as const : 'connected' as const,
            id: challengeId,
            accountId,
            expiresAt: session.expiresAt,
            ...(session.qrCode ? { qrCode: session.qrCode } : {}),
            ...(session.qrDataUrl ? { url: session.qrDataUrl } : {}),
            instructions: session.qrCode
              ? 'Open WhatsApp, go to Linked Devices, and scan this QR code.'
              : 'WhatsApp is already connected for this account.',
            metadata: {
              transport: 'baileys',
              status: session.status,
              authStateDir: config.baileys.authStateDir,
            },
          },
        }
      } catch (error) {
        this.clearPendingPairing(challengeId)
        await session?.runtime.stop().catch(() => undefined)
        // The transport may have mutated an existing auth directory before
        // throwing. Resolve inside the coordinator so the generation advances,
        // then rethrow after ownership is released; stale cleanup receipts must
        // never remain valid when rollback cannot prove every side effect gone.
        return { ok: false as const, error }
      }
    })
    if (!outcome.ok) {
      throw outcome.error
    }
    return outcome.challenge
  }

  async completePairing(
    challenge: ChannelPairingChallenge,
    response: ChannelPairingResponse,
  ): Promise<CommanderChannelBinding> {
    const challengeId = response.challengeId ?? challenge.id
    if (!challengeId) {
      throw new Error('Pairing challenge id is required')
    }
    const pending = this.pendingPairings.get(challengeId)
    if (!pending) {
      throw new Error(`WhatsApp pairing challenge "${challengeId}" was not found or expired`)
    }
    this.assertPairingOwner(challenge, pending)

    const expiresAt = Date.parse(pending.session.expiresAt)
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      await this.expirePairing(challengeId)
      throw new Error(`WhatsApp pairing challenge "${challengeId}" expired`)
    }

    const status = pending.session.runtime.status()
    if (!status.connected && status.state !== 'connected') {
      throw new Error('WhatsApp account is not connected yet; scan the QR code and wait for the pairing status to connect.')
    }

    const config = parseWhatsAppChannelConfig(
      {
        ...pending.config,
        ...response.config,
      },
      pending.session.accountId,
      this.dataDir,
    )
    try {
      const binding = await this.bindingStore.create({
        commanderId: pending.commanderId,
        provider: 'whatsapp',
        accountId: pending.session.accountId,
        displayName: response.displayName?.trim() || pending.displayName,
        enabled: true,
        config,
      })
      this.clearPendingPairing(challengeId)
      await pending.session.runtime.stop().catch(() => undefined)
      return binding
    } catch (error) {
      this.clearPendingPairing(challengeId)
      await pending.session.runtime.stop().catch(() => undefined)
      if (error instanceof CommanderChannelBindingConflictError) {
        throw error
      }
      throw error
    }
  }

  async getPairingStatus(challenge: ChannelPairingChallenge): Promise<ChannelPairingStatus> {
    await this.pruneExpiredPairings()
    const challengeId = challenge.id
    if (!challengeId) {
      throw new Error('Pairing challenge id is required')
    }
    const pending = this.pendingPairings.get(challengeId)
    if (!pending) {
      throw new Error(`WhatsApp pairing challenge "${challengeId}" was not found or expired`)
    }
    this.assertPairingOwner(challenge, pending)

    const expiresAt = Date.parse(pending.session.expiresAt)
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      await this.expirePairing(challengeId)
      throw new Error(`WhatsApp pairing challenge "${challengeId}" expired`)
    }

    const status = pending.session.runtime.status()
    return {
      provider: 'whatsapp',
      commanderId: pending.commanderId,
      kind: status.connected || status.state === 'connected'
        ? 'connected'
        : status.qrCode || status.qrDataUrl
          ? 'qr'
          : status.state,
      id: challengeId,
      accountId: pending.session.accountId,
      expiresAt: pending.session.expiresAt,
      state: status.state,
      connected: status.connected || status.state === 'connected',
      ...(status.qrCode ? { qrCode: status.qrCode } : {}),
      ...(status.qrDataUrl ? { url: status.qrDataUrl } : {}),
      instructions: statusInstructions(status),
      metadata: {
        transport: 'baileys',
        status,
        authStateDir: pending.config.baileys.authStateDir,
      },
    }
  }

  async send(
    runtime: ChannelRuntime<WhatsAppChannelConfig>,
    conversation: Conversation,
    payload: ChannelOutboundPayload,
  ): Promise<{ success: true; rawResponse?: unknown } | { success: false; error: string; rawResponse?: unknown }> {
    try {
      const binding = await this.resolveBinding(runtime, conversation)
      const config = parseWhatsAppChannelConfig(binding.config, binding.accountId, this.dataDir)
      const activeRuntime = await this.ensureRuntime(binding, config)
      const peerId = conversation.lastRoute?.to ?? activeRuntime.surfaceBinding?.peerId ?? runtime.surfaceBinding?.peerId
      if (!peerId) {
        throw new Error(`No WhatsApp peer id for conversation "${conversation.id}"`)
      }
      const result = await activeRuntime.transportRuntime.send(peerId, payload, {
        sendTextWithVoiceNote: config.baileys.sendTextWithVoiceNote,
      })
      return {
        success: true,
        rawResponse: result?.rawResponse,
        ...(result?.messageRef ? { messageRef: result.messageRef } : {}),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send WhatsApp message',
      }
    }
  }

  async editMessage(
    runtime: ChannelRuntime<WhatsAppChannelConfig>,
    conversation: Conversation,
    messageRef: ChannelOutboundMessageRef,
    payload: ChannelOutboundPayload,
  ): Promise<{ success: true; rawResponse?: unknown; messageRef?: ChannelOutboundMessageRef } | { success: false; error: string; rawResponse?: unknown }> {
    try {
      const binding = await this.resolveBinding(runtime, conversation)
      const config = parseWhatsAppChannelConfig(binding.config, binding.accountId, this.dataDir)
      const activeRuntime = await this.ensureRuntime(binding, config)
      const peerId = conversation.lastRoute?.to ?? messageRef.peerId ?? activeRuntime.surfaceBinding?.peerId ?? runtime.surfaceBinding?.peerId
      if (!peerId) {
        throw new Error(`No WhatsApp peer id for conversation "${conversation.id}"`)
      }
      if (!activeRuntime.transportRuntime.edit) {
        throw new Error('WhatsApp transport does not support message editing')
      }
      const result = await activeRuntime.transportRuntime.edit(peerId, messageRef, payload)
      return {
        success: true,
        rawResponse: result.rawResponse,
        ...(result.messageRef ? { messageRef: result.messageRef } : { messageRef }),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to edit WhatsApp message',
      }
    }
  }

  async checkInboundAllowed(
    runtime: ChannelRuntime<WhatsAppChannelConfig>,
    event: ChannelInboundEvent,
  ): Promise<ChannelInboundDecision> {
    const binding = await this.resolveBindingForEvent(runtime, event)
    return this.checkInboundAllowedForBinding(binding, event)
  }

  private checkInboundAllowedForBinding(
    binding: CommanderChannelBinding,
    event: ChannelInboundEvent,
  ): ChannelInboundDecision {
    const decision = checkAccountInboundPolicy(binding, event)
    if (!decision.allowed) {
      return decision
    }
    return this.checkMentionAllowedForBinding(binding, event)
  }

  private checkMentionAllowedForBinding(
    binding: CommanderChannelBinding,
    event: ChannelInboundEvent,
  ): ChannelInboundDecision {
    const config = parseWhatsAppChannelConfig(binding.config, binding.accountId, this.dataDir)
    if (event.chatType !== 'direct' && config.requireMention) {
      return whatsappMentionedBot(event) ? { allowed: true } : { allowed: false, reason: 'mention-required' }
    }
    return { allowed: true }
  }

  async getStatus(binding: CommanderChannelBinding): Promise<WhatsAppRuntimeStatus> {
    const runtime = this.runtimesByAccount.get(binding.accountId)
    const persistedDrops = await this.dropStatusStore.read('whatsapp', binding.accountId)
    const lastDrop = runtime?.lastDrop ?? this.lastDropsByAccount.get(binding.accountId) ?? persistedDrops.lastDrop
    if (runtime) {
      return {
        ...runtime.transportRuntime.status(),
        ...(lastDrop ? { lastDrop } : {}),
        dropCount: persistedDrops.dropCount,
        recentDrops: persistedDrops.recentDrops,
      }
    }
    const config = parseWhatsAppChannelConfig(binding.config, binding.accountId, this.dataDir)
    return {
      ...statusForStoppedBinding(binding, config),
      ...(lastDrop ? { lastDrop } : {}),
      dropCount: persistedDrops.dropCount,
      recentDrops: persistedDrops.recentDrops,
    }
  }

  private async ensureRuntime(
    binding: CommanderChannelBinding,
    config: WhatsAppChannelConfig,
  ): Promise<WhatsAppRuntime> {
    const runtime = this.runtimesByAccount.get(binding.accountId)
    if (runtime) {
      return runtime
    }
    if (!binding.enabled) {
      throw new Error(`WhatsApp binding "${binding.displayName}" is disabled`)
    }
    if (config.transport !== 'baileys') {
      throw new Error(`Unsupported WhatsApp transport "${config.transport}" for outbound send`)
    }
    return this.start(binding)
  }

  private async forwardInbound(event: ChannelInboundEvent): Promise<void> {
    const runtime = this.runtimesByAccount.get(event.accountId)
    const binding = runtime
      ? await this.resolveBindingForEvent(runtime, event).catch(() => null)
      : null
    if (binding) {
      const decision = this.checkMentionAllowedForBinding(binding, event)
      if (!decision.allowed) {
        await this.recordDroppedInbound(event.accountId, event, decision.reason ?? 'policy-denied')
        return
      }
    }
    const message = formatInboundMessage(event)
    const payload: WhatsAppChannelMessagePayload = {
      provider: 'whatsapp',
      accountId: event.accountId,
      chatType: event.chatType,
      peerId: event.peerId,
      displayName: event.peerDisplayName ?? event.peerId,
      message,
      mode: 'followup',
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.threadId ? { threadId: event.threadId } : {}),
      ...(event.audio ? {
        audio: {
          buffer: event.audio.buffer.toString('base64'),
          mimeType: event.audio.mimeType,
          ...(event.audio.durationMs !== undefined ? { durationMs: event.audio.durationMs } : {}),
        },
      } : {}),
      rawTimestamp: event.rawTimestamp,
      rawSourceId: event.rawSourceId,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    }
    let response = await this.postInboundPayload(payload)
    if (response.status === 409) {
      const runtime = this.runtimesByAccount.get(event.accountId)
      const binding = runtime
        ? await this.resolveBindingForEvent(runtime, event).catch(() => null)
        : null
      if (binding) {
        response = await this.postInboundPayload({
          ...payload,
          commanderId: effectiveBindingCommanderId(binding),
        })
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 409) {
        await this.recordDroppedInbound(event.accountId, event, 'binding-resolution', `${response.status} ${text}`)
      } else {
        await this.recordDroppedInbound(event.accountId, event, 'ingest-failed', `${response.status} ${text}`)
      }
      this.logger.warn(`[channels/whatsapp] Failed to ingest WhatsApp message ${event.rawSourceId}: ${response.status} ${text}`)
      return
    }
    const droppedReason = await readDroppedChannelResponse(response)
    if (droppedReason) {
      await this.recordDroppedInbound(event.accountId, event, droppedReason)
    }
  }

  private async recordDroppedInbound(
    accountId: string,
    event: ChannelInboundEvent,
    reason: string,
    detail?: string,
  ): Promise<void> {
    const at = new Date().toISOString()
    const lastDrop = buildChannelLastDrop(event, reason, at, detail)
    this.lastDropsByAccount.set(accountId, lastDrop)
    const runtime = this.runtimesByAccount.get(accountId)
    if (runtime) {
      runtime.lastDrop = lastDrop
    }
    await this.dropStatusStore.record(event, reason, detail).catch((error) => {
      this.logger.warn(`[channels/whatsapp] Failed to persist dropped WhatsApp message ${event.rawSourceId}:`, error)
    })
    this.logger.warn(
      `[channels/whatsapp] Dropped WhatsApp message ${event.rawSourceId}: inbound denied ${reason} (${event.chatType} ${event.peerId})`,
    )
  }

  private postInboundPayload(payload: WhatsAppChannelMessagePayload): Promise<Response> {
    return this.fetchImpl(`${this.apiBaseUrl}/api/commanders/channel-message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-herd-internal-token': this.internalToken,
      },
      body: JSON.stringify(payload),
    })
  }

  private async resolveBinding(
    runtime: ChannelRuntime<WhatsAppChannelConfig>,
    conversation: Conversation,
  ): Promise<CommanderChannelBinding> {
    const bindings = await this.bindingStore.listByCommander(conversation.commanderId)
    const binding = bindings.find((candidate) => (
      candidate.provider === 'whatsapp'
      && candidate.accountId === runtime.accountId
      && candidate.enabled
    ))
    if (!binding) {
      throw new Error(`No WhatsApp channel binding for commander "${conversation.commanderId}" and account "${runtime.accountId}"`)
    }
    return binding
  }

  private async resolveBindingForEvent(
    runtime: ChannelRuntime<WhatsAppChannelConfig>,
    event: ChannelInboundEvent,
  ): Promise<CommanderChannelBinding> {
    const bindings = (await this.bindingStore.list()).filter((candidate) => (
      candidate.provider === 'whatsapp'
      && candidate.accountId === event.accountId
      && candidate.enabled
    ))
    const binding = bindings.length === 1
      ? bindings[0]
      : bindings.find((candidate) => candidate.commanderId === runtime.commanderId)
    if (!binding) {
      throw new Error(`No unambiguous WhatsApp channel binding for account "${event.accountId}"`)
    }
    return binding
  }

  private schedulePairingCleanup(challengeId: string, expiresAt: string): NodeJS.Timeout | undefined {
    const expiryMs = Date.parse(expiresAt)
    if (!Number.isFinite(expiryMs)) {
      return undefined
    }
    const delayMs = Math.max(0, expiryMs - Date.now())
    const timer = setTimeout(() => {
      void this.expirePairing(challengeId)
    }, delayMs)
    timer.unref?.()
    return timer
  }

  private clearPendingPairing(challengeId: string): PendingPairing | undefined {
    const pending = this.pendingPairings.get(challengeId)
    if (!pending) {
      return undefined
    }
    if (pending.cleanupTimer) {
      clearTimeout(pending.cleanupTimer)
    }
    this.pendingPairings.delete(challengeId)
    return pending
  }

  private async expirePairing(challengeId: string): Promise<void> {
    const pending = this.clearPendingPairing(challengeId)
    if (!pending) {
      return
    }
    await pending.session.runtime.stop().catch((error) => {
      this.logger.warn(`[channels/whatsapp] Failed to stop expired pairing ${challengeId}:`, error)
    })
  }

  private async pruneExpiredPairings(): Promise<void> {
    const now = Date.now()
    const expired = [...this.pendingPairings.entries()]
      .filter(([, pending]) => {
        const expiresAt = Date.parse(pending.session.expiresAt)
        return Number.isFinite(expiresAt) && now > expiresAt
      })
      .map(([challengeId]) => challengeId)
    await Promise.all(expired.map((challengeId) => this.expirePairing(challengeId)))
  }

  private assertPairingOwner(challenge: ChannelPairingChallenge, pending: PendingPairing): void {
    const commanderId = challenge.commanderId?.trim()
    if (commanderId && commanderId !== pending.commanderId) {
      throw new Error(`WhatsApp pairing challenge "${challenge.id}" does not belong to commander "${commanderId}"`)
    }
  }
}
