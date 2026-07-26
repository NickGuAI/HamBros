import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { MachineConfig, CommanderSessionsInterface } from '../agents/types.js'
import {
  createWorkspaceSshCommandRunner,
  isRemoteMachine,
  LOCAL_MACHINE_ID,
} from '../agents/machines.js'
import type { ConversationStore } from '../commanders/conversation-store.js'
import type { CommanderSessionStore } from '../commanders/store.js'
import { buildConversationSessionName } from '../commanders/routes/conversation-runtime.js'
import {
  resolveWorkspaceRoot,
  WorkspaceError,
} from './resolver.js'
import type { WorkspaceCommandRunner } from './git.js'
import type {
  ResolvedWorkspaceTarget,
  WorkspaceMachineDescriptor,
  WorkspaceTargetDescriptor,
} from './types.js'
import { WorkspaceTargetStore } from './store.js'

export interface WorkspaceMachineDescriptorCapability {
  readMachineRegistry(): Promise<MachineConfig[]>
}

export interface WorkspaceResolverCapability {
  open(input: WorkspaceOpenOptions): Promise<WorkspaceTargetDescriptor>
  resolveTarget(targetId: string): Promise<ResolvedWorkspaceTarget>
}

export interface WorkspaceOpenOptions {
  conversationId?: string | null
  sessionName?: string | null
  commanderId?: string | null
  authorizationConversationId?: string | null
  authorizationSessionName?: string | null
  authorizationCommanderId?: string | null
  hostHint?: string | null
  pathHint?: string | null
  /** Trusted server-only roots; request payloads must never populate this field. */
  authorizationRootHints?: readonly string[] | null
  locationScoped?: boolean | null
  persistTarget?: boolean | null
  readOnly?: boolean | null
}

export interface AuthorizedHostEntry {
  host: string
  rootPathPrefix: string
  label?: string
  machine?: WorkspaceMachineDescriptor
}

function machineToDescriptor(machine: MachineConfig & { host: string }): WorkspaceMachineDescriptor {
  return {
    id: machine.id,
    label: machine.label,
    host: machine.host,
    ...(machine.user ? { user: machine.user } : {}),
    ...(machine.port ? { port: machine.port } : {}),
  }
}

function normalizeHost(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || LOCAL_MACHINE_ID
}

function normalizeConfiguredRootPrefix(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

function isPathWithinPrefix(candidatePath: string, prefix: string): boolean {
  const pathApi = path.posix.isAbsolute(candidatePath) ? path.posix : path
  const relative = pathApi.relative(prefix, candidatePath)
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
}

function sameHost(left: string, right: string): boolean {
  return normalizeHost(left) === normalizeHost(right)
}

function createTargetId(): string {
  return `wt-${randomUUID()}`
}

async function normalizeAuthorizedRootPath(
  rootPath: string | null | undefined,
  isRemote: boolean,
): Promise<string | null> {
  const configuredRoot = normalizeConfiguredRootPrefix(rootPath)
  if (!configuredRoot) {
    return null
  }
  if (isRemote) {
    if (!path.posix.isAbsolute(configuredRoot)) {
      return null
    }
    return path.posix.normalize(configuredRoot)
  }
  if (!path.isAbsolute(configuredRoot)) {
    return null
  }
  try {
    return await realpath(configuredRoot)
  } catch {
    return null
  }
}

function buildRedactedTargetLabel(host: string, authorized?: Pick<AuthorizedHostEntry, 'label'>): string {
  const label = authorized?.label?.trim()
  if (label) {
    return label
  }
  const normalizedHost = normalizeHost(host)
  return normalizedHost === LOCAL_MACHINE_ID
    ? 'Local workspace'
    : `${normalizedHost} workspace`
}

export class AuthorizedHostRegistry {
  constructor(
    private readonly machines: WorkspaceMachineDescriptorCapability,
    private readonly conversations: ConversationStore,
    private readonly sessionsInterface?: CommanderSessionsInterface,
  ) {}

  async allowed(
    conversationId?: string | null,
    additionalRoots: Array<{ host: string; rootPath: string }> = [],
  ): Promise<AuthorizedHostEntry[]> {
    const machines = await this.machines.readMachineRegistry()
    const entries: AuthorizedHostEntry[] = []
    for (const machine of machines) {
      const rootPathPrefix = await normalizeAuthorizedRootPath(machine.cwd, isRemoteMachine(machine))
      if (!rootPathPrefix) {
        continue
      }
      entries.push({
        host: machine.id,
        label: machine.label,
        rootPathPrefix,
        ...(isRemoteMachine(machine) ? { machine: machineToDescriptor(machine) } : {}),
      })
    }

    const normalizedConversationId = typeof conversationId === 'string'
      ? conversationId.trim()
      : ''
    if (normalizedConversationId) {
      const conversation = await this.conversations.get(normalizedConversationId)
      if (conversation) {
        const liveSession = this.sessionsInterface?.getSession(buildConversationSessionName(conversation))
        if (liveSession?.cwd) {
          const host = normalizeHost(liveSession.host)
          const remoteMachine = machines.find(
            (machine): machine is MachineConfig & { host: string } => machine.id === host && isRemoteMachine(machine),
          )
          const rootPathPrefix = await normalizeAuthorizedRootPath(liveSession.cwd, Boolean(remoteMachine))
          if (rootPathPrefix) {
            entries.push({
              host,
              label: machines.find((machine) => machine.id === host)?.label,
              rootPathPrefix,
              ...(remoteMachine ? { machine: machineToDescriptor(remoteMachine) } : {}),
            })
          }
        }
      }
    }

    for (const root of additionalRoots) {
      const host = normalizeHost(root.host)
      const machine = machines.find((entry) => entry.id === host)
      const rootPathPrefix = await normalizeAuthorizedRootPath(root.rootPath, isRemoteMachine(machine))
      if (!rootPathPrefix) {
        continue
      }
      entries.push({
        host,
        label: machine?.label,
        rootPathPrefix,
        ...(isRemoteMachine(machine) ? { machine: machineToDescriptor(machine) } : {}),
      })
    }

    return entries
  }

  async authorize(
    conversationId: string | null | undefined,
    host: string,
    rootPath: string,
    additionalRoots: Array<{ host: string; rootPath: string }> = [],
  ): Promise<AuthorizedHostEntry & { rootPath: string }> {
    const machines = await this.machines.readMachineRegistry()
    const machine = machines.find((entry) => entry.id === normalizeHost(host))
    const resolvedRootPath = await normalizeAuthorizedRootPath(rootPath, isRemoteMachine(machine))
    if (!resolvedRootPath) {
      throw new WorkspaceError(404, 'Workspace root does not exist')
    }
    const allowed = await this.allowed(conversationId, additionalRoots)
    const match = allowed.find((entry) => (
      sameHost(entry.host, host) && isPathWithinPrefix(resolvedRootPath, entry.rootPathPrefix)
    ))
    if (!match) {
      throw new WorkspaceError(403, 'Workspace host is not authorized for this conversation')
    }
    return {
      ...match,
      rootPath: resolvedRootPath,
    }
  }
}

export interface WorkspaceResolverOptions {
  targetStore?: WorkspaceTargetStore
  machineDescriptor: WorkspaceMachineDescriptorCapability
  conversationStore: ConversationStore
  commanderStore: CommanderSessionStore
  sessionsInterface?: CommanderSessionsInterface
  ephemeralTargetTtlMs?: number
  maxEphemeralTargets?: number
  now?: () => number
}

interface EphemeralWorkspaceTarget {
  target: WorkspaceTargetDescriptor
  expiresAtMs: number
}

const DEFAULT_EPHEMERAL_TARGET_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_EPHEMERAL_TARGETS = 512

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

export class WorkspaceResolver implements WorkspaceResolverCapability {
  private readonly targetStore: WorkspaceTargetStore
  private readonly hostRegistry: AuthorizedHostRegistry
  private readonly ephemeralTargets = new Map<string, EphemeralWorkspaceTarget>()
  private readonly ephemeralTargetTtlMs: number
  private readonly maxEphemeralTargets: number
  private readonly now: () => number

  constructor(private readonly options: WorkspaceResolverOptions) {
    this.targetStore = options.targetStore ?? new WorkspaceTargetStore()
    this.hostRegistry = new AuthorizedHostRegistry(
      options.machineDescriptor,
      options.conversationStore,
      options.sessionsInterface,
    )
    this.ephemeralTargetTtlMs = positiveIntegerOrDefault(
      options.ephemeralTargetTtlMs,
      DEFAULT_EPHEMERAL_TARGET_TTL_MS,
    )
    this.maxEphemeralTargets = positiveIntegerOrDefault(
      options.maxEphemeralTargets,
      DEFAULT_MAX_EPHEMERAL_TARGETS,
    )
    this.now = options.now ?? Date.now
  }

  async open(input: WorkspaceOpenOptions): Promise<WorkspaceTargetDescriptor> {
    const sourceKey = this.resolveSourceKey(input)
    const sourceContext = this.resolveSourceContext(input)
    const ownerCommanderId = await this.resolveOwnerCommanderId(input)
    const authorizationConversationId = this.resolveAuthorizationConversationId(input)
    const persistTarget = input.persistTarget !== false
    const readOnly = input.readOnly === true

    const existing = persistTarget ? await this.targetStore.getByKey(sourceKey) : null
    if (existing && !input.hostHint && !input.pathHint) {
      return this.withRedactedLabel(existing)
    }

    const fallback = await this.resolveFallbackTarget(input)
    const host = normalizeHost(input.hostHint ?? fallback.host)
    const rootPath = this.resolveOpenRootPath(input.pathHint, fallback.rootPath)
    const additionalRoots = [
      ...(fallback.authorizesRoot
        ? [{ host: fallback.host, rootPath: fallback.rootPath }]
        : []),
      ...(input.authorizationRootHints ?? [])
        .map(normalizeConfiguredRootPrefix)
        .filter((rootPath): rootPath is string => Boolean(rootPath))
        .map((rootPath) => ({ host, rootPath })),
    ]
    const authorized = await this.hostRegistry.authorize(
      authorizationConversationId || null,
      host,
      rootPath,
      additionalRoots,
    )
    const target: WorkspaceTargetDescriptor = {
      targetId: persistTarget && existing ? existing.targetId : createTargetId(),
      ...(sourceContext.conversationId ? { conversationId: sourceContext.conversationId } : {}),
      ...(sourceContext.sessionName ? { sessionName: sourceContext.sessionName } : {}),
      ...(ownerCommanderId ? { commanderId: ownerCommanderId } : {}),
      label: buildRedactedTargetLabel(host, authorized),
      host,
      rootPath: authorized.rootPath,
      readOnly,
      ...(authorized.machine ? { machine: authorized.machine } : {}),
    }

    if (!persistTarget) {
      const displayTarget = this.withRedactedLabel(target)
      this.storeEphemeralTarget(displayTarget)
      return { ...displayTarget }
    }

    return this.targetStore.saveForKey(sourceKey, target, { ownerCommanderId })
  }

  async resolveTarget(targetId: string): Promise<ResolvedWorkspaceTarget> {
    const normalizedTargetId = targetId.trim()
    if (!normalizedTargetId) {
      throw new WorkspaceError(400, 'targetId query parameter is required')
    }
    const target = this.resolveEphemeralTarget(normalizedTargetId)
      ?? await this.targetStore.getByTargetId(normalizedTargetId)
    if (!target) {
      throw new WorkspaceError(404, 'Workspace target not found')
    }
    const displayTarget = this.withRedactedLabel(target)

    const runner = displayTarget.machine ? createWorkspaceSshCommandRunner({
      id: displayTarget.machine.id,
      label: displayTarget.machine.label,
      host: displayTarget.machine.host,
      user: displayTarget.machine.user,
      port: displayTarget.machine.port,
    }) : undefined
    const workspace = await resolveWorkspaceRoot({
      rootPath: displayTarget.rootPath,
      source: {
        kind: 'target',
        id: displayTarget.targetId,
        label: displayTarget.label,
        host: displayTarget.host === LOCAL_MACHINE_ID ? undefined : displayTarget.host,
        readOnly: displayTarget.readOnly,
      },
      machine: displayTarget.machine,
    }, runner)

    return {
      target: displayTarget,
      workspace,
      ...(runner ? { commandRunner: runner } : {}),
      host: displayTarget.host,
      rootPath: workspace.rootPath,
      ...(displayTarget.machine ? { machine: displayTarget.machine } : {}),
      readOnly: workspace.readOnly,
    }
  }

  private withRedactedLabel(target: WorkspaceTargetDescriptor): WorkspaceTargetDescriptor {
    const label = target.label.trim()
    if (label && !label.includes(target.rootPath)) {
      return {
        ...target,
        label,
      }
    }
    return {
      ...target,
      label: buildRedactedTargetLabel(target.host, {
        label: target.machine?.label,
      }),
    }
  }

  private pruneExpiredEphemeralTargets(nowMs: number): void {
    for (const [targetId, entry] of this.ephemeralTargets) {
      if (entry.expiresAtMs <= nowMs) {
        this.ephemeralTargets.delete(targetId)
      }
    }
  }

  private storeEphemeralTarget(target: WorkspaceTargetDescriptor): void {
    const nowMs = this.now()
    this.pruneExpiredEphemeralTargets(nowMs)
    this.ephemeralTargets.delete(target.targetId)
    while (this.ephemeralTargets.size >= this.maxEphemeralTargets) {
      const oldestTargetId = this.ephemeralTargets.keys().next().value
      if (typeof oldestTargetId !== 'string') {
        break
      }
      this.ephemeralTargets.delete(oldestTargetId)
    }
    this.ephemeralTargets.set(target.targetId, {
      target,
      expiresAtMs: nowMs + this.ephemeralTargetTtlMs,
    })
  }

  private resolveEphemeralTarget(targetId: string): WorkspaceTargetDescriptor | null {
    const nowMs = this.now()
    this.pruneExpiredEphemeralTargets(nowMs)
    const entry = this.ephemeralTargets.get(targetId)
    if (!entry) {
      return null
    }
    this.ephemeralTargets.delete(targetId)
    this.ephemeralTargets.set(targetId, {
      target: entry.target,
      expiresAtMs: nowMs + this.ephemeralTargetTtlMs,
    })
    return entry.target
  }

  private resolveSourceKey(input: {
    conversationId?: string | null
    sessionName?: string | null
    commanderId?: string | null
    hostHint?: string | null
    pathHint?: string | null
    locationScoped?: boolean | null
  }): string {
    const locationScoped = input.locationScoped === true
    const hostHint = typeof input.hostHint === 'string' ? input.hostHint.trim() : ''
    const pathHint = typeof input.pathHint === 'string' ? input.pathHint.trim() : ''
    if (locationScoped && (hostHint || pathHint)) {
      const authKey = [
        typeof input.conversationId === 'string' ? input.conversationId.trim() : '',
        typeof input.sessionName === 'string' ? input.sessionName.trim() : '',
        typeof input.commanderId === 'string' ? input.commanderId.trim() : '',
      ].join(':')
      return `location:${authKey}:${normalizeHost(hostHint)}:${pathHint || '.'}`
    }
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : ''
    if (conversationId) {
      return `conversation:${conversationId}`
    }
    const sessionName = typeof input.sessionName === 'string' ? input.sessionName.trim() : ''
    if (sessionName) {
      return `session:${sessionName}`
    }
    const commanderId = typeof input.commanderId === 'string' ? input.commanderId.trim() : ''
    if (commanderId) {
      return `commander:${commanderId}`
    }
    if (hostHint || pathHint) {
      return `location:${normalizeHost(hostHint)}:${pathHint || '.'}`
    }
    throw new WorkspaceError(400, 'conversationId, sessionName, commanderId, or workspace location is required')
  }

  private async resolveOwnerCommanderId(input: {
    conversationId?: string | null
    sessionName?: string | null
    commanderId?: string | null
  }): Promise<string | null> {
    const commanderId = typeof input.commanderId === 'string' ? input.commanderId.trim() : ''
    if (commanderId) {
      return commanderId
    }

    const conversationId = typeof input.conversationId === 'string'
      ? input.conversationId.trim()
      : ''
    if (conversationId) {
      const conversation = await this.options.conversationStore.get(conversationId)
      if (conversation?.commanderId) {
        return conversation.commanderId
      }
    }

    const sessionName = typeof input.sessionName === 'string' ? input.sessionName.trim() : ''
    if (sessionName) {
      const creator = this.options.sessionsInterface?.getSession(sessionName)?.creator
      const creatorCommanderId = creator?.kind === 'commander' && typeof creator.id === 'string'
        ? creator.id.trim()
        : ''
      if (creatorCommanderId) {
        return creatorCommanderId
      }
    }

    return null
  }

  private resolveSourceContext(input: {
    conversationId?: string | null
    sessionName?: string | null
    commanderId?: string | null
  }): {
    conversationId: string
    sessionName: string
    commanderId: string
  } {
    return {
      conversationId: typeof input.conversationId === 'string' ? input.conversationId.trim() : '',
      sessionName: typeof input.sessionName === 'string' ? input.sessionName.trim() : '',
      commanderId: typeof input.commanderId === 'string' ? input.commanderId.trim() : '',
    }
  }

  private resolveAuthorizationConversationId(input: {
    conversationId?: string | null
    sessionName?: string | null
    authorizationConversationId?: string | null
    authorizationSessionName?: string | null
    authorizationCommanderId?: string | null
  }): string {
    const explicitConversationId = typeof input.authorizationConversationId === 'string'
      ? input.authorizationConversationId.trim()
      : ''
    if (explicitConversationId) {
      return explicitConversationId
    }

    const sourceConversationId = typeof input.conversationId === 'string'
      ? input.conversationId.trim()
      : ''
    if (sourceConversationId) {
      return sourceConversationId
    }

    const authorizationSessionName = typeof input.authorizationSessionName === 'string'
      ? input.authorizationSessionName.trim()
      : ''
    const sourceSessionName = typeof input.sessionName === 'string'
      ? input.sessionName.trim()
      : ''
    const sessionName = authorizationSessionName || sourceSessionName
    if (sessionName) {
      return this.options.sessionsInterface?.getSession(sessionName)?.conversationId?.trim() ?? ''
    }

    return ''
  }

  private async resolveFallbackTarget(input: {
    conversationId?: string | null
    sessionName?: string | null
    commanderId?: string | null
    hostHint?: string | null
    pathHint?: string | null
  }): Promise<{ host: string; rootPath: string; authorizesRoot: boolean }> {
    const sessionName = typeof input.sessionName === 'string' ? input.sessionName.trim() : ''
    if (sessionName) {
      const liveSession = this.options.sessionsInterface?.getSession(sessionName)
      if (!liveSession?.cwd) {
        throw new WorkspaceError(404, `Session "${sessionName}" has no workspace`)
      }
      return {
        host: normalizeHost(liveSession.host),
        rootPath: liveSession.cwd,
        authorizesRoot: true,
      }
    }

    const directCommanderId = typeof input.commanderId === 'string' ? input.commanderId.trim() : ''
    if (directCommanderId) {
      const commander = await this.options.commanderStore.get(directCommanderId)
      if (!commander?.cwd) {
        throw new WorkspaceError(404, `Commander "${directCommanderId}" has no workspace`)
      }
      return {
        host: normalizeHost(commander.remoteOrigin?.machineId),
        rootPath: commander.cwd,
        authorizesRoot: true,
      }
    }

    const hostHint = typeof input.hostHint === 'string' ? input.hostHint.trim() : ''
    const pathHint = typeof input.pathHint === 'string' ? input.pathHint.trim() : ''
    if (hostHint || pathHint) {
      const host = normalizeHost(hostHint)
      const machines = await this.options.machineDescriptor.readMachineRegistry()
      const machine = machines.find((entry) => entry.id === host)
      return {
        host,
        rootPath: normalizeConfiguredRootPrefix(machine?.cwd) ?? homedir(),
        authorizesRoot: false,
      }
    }

    const conversationId = typeof input.conversationId === 'string'
      ? input.conversationId.trim()
      : ''
    if (!conversationId) {
      throw new WorkspaceError(400, 'conversationId, sessionName, commanderId, or workspace location is required')
    }
    const conversation = await this.options.conversationStore.get(conversationId)
    if (!conversation) {
      throw new WorkspaceError(404, `Conversation "${conversationId}" not found`)
    }

    const liveSession = this.options.sessionsInterface?.getSession(buildConversationSessionName(conversation))
    if (liveSession?.cwd) {
      return {
        host: normalizeHost(liveSession.host),
        rootPath: liveSession.cwd,
        authorizesRoot: true,
      }
    }

    const commander = await this.options.commanderStore.get(conversation.commanderId)
    if (commander?.cwd) {
      return {
        host: normalizeHost(commander.remoteOrigin?.machineId),
        rootPath: commander.cwd,
        authorizesRoot: true,
      }
    }

    return {
      host: LOCAL_MACHINE_ID,
      rootPath: homedir(),
      authorizesRoot: true,
    }
  }

  private resolveOpenRootPath(pathHint: string | null | undefined, fallbackRootPath: string): string {
    const hint = typeof pathHint === 'string' ? pathHint.trim() : ''
    if (!hint) {
      return fallbackRootPath
    }
    if (path.isAbsolute(hint) || path.posix.isAbsolute(hint)) {
      return hint
    }
    return path.resolve(fallbackRootPath, hint)
  }
}
