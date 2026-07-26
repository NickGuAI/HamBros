import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Router, type Request, type Response } from 'express'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import type { Auth0TokenVerifier } from '../../server/middleware/auth0.js'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import {
  InMemoryTransportAuthTicketStore,
  readTransportAuthTicketFromUrl,
} from '../../server/auth/transport-tickets.js'
import {
  createWorkspaceFile,
  createWorkspaceFolder,
  createWorkspaceUploadMiddleware,
  deleteWorkspaceEntry,
  getMimeType,
  initWorkspaceGit,
  listWorkspaceTree,
  readWorkspaceFilePreview,
  readWorkspaceGitLog,
  readWorkspaceGitStatus,
  resolveWorkspacePathSelection,
  renameWorkspaceEntry,
  requireWritableWorkspace,
  resolveWorkspacePath,
  resolveWorkspaceUploadDestination,
  saveWorkspaceTextFile,
  toWorkspaceError,
  WorkspaceError,
} from './index.js'
import type { WorkspaceCommandRunner } from './git.js'
import type { WorkspaceResolverCapability } from './capability.js'
import type {
  ResolvedWorkspaceTarget,
  WorkspacePathResolution,
} from './types.js'
import { WorkspacePreferencesStore } from './store.js'
import {
  materializeWorkspaceContextPayload,
  readWorkspaceContextPayload,
} from './context.js'

export interface WorkspaceRouterOptions {
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: Auth0TokenVerifier
  resolver: WorkspaceResolverCapability
  preferencesStore?: WorkspacePreferencesStore
  /** Trusted lifecycle roots available to resolve-reference retries. */
  lifecycleTaskRoots?: readonly string[]
}

const DEFAULT_LIFECYCLE_TASK_ROOTS = [
  '~/tasks',
  '~/PKMS/insights/tasks',
] as const

function sendWorkspaceError(res: Response, error: unknown): void {
  const workspaceError = toWorkspaceError(error)
  res.status(workspaceError.statusCode).json({ error: workspaceError.message })
}

function rejectRawLocationParams(query: Record<string, unknown>): void {
  if (query.host !== undefined || query.rootPath !== undefined) {
    throw new WorkspaceError(400, 'Workspace reads require targetId; host/rootPath are not supported')
  }
}

function readTargetId(query: Record<string, unknown>): string {
  rejectRawLocationParams(query)
  const targetId = typeof query.targetId === 'string' ? query.targetId.trim() : ''
  if (!targetId) {
    throw new WorkspaceError(400, 'targetId query parameter is required')
  }
  return targetId
}

async function resolveWritableWorkspaceTarget(
  options: WorkspaceRouterOptions,
  query: Record<string, unknown>,
): Promise<ResolvedWorkspaceTarget> {
  const resolved = await options.resolver.resolveTarget(readTargetId(query))
  requireWritableWorkspace(resolved.workspace)
  return resolved
}

function readPath(query: Record<string, unknown>): string {
  return typeof query.path === 'string' ? query.path : ''
}

function workspaceRawTicketSubject(targetId: string, requestedPath: string): string {
  return `${targetId}\u0000${requestedPath}`
}

function readBodyPath(body: unknown, key = 'path'): string {
  if (typeof body !== 'object' || body === null) {
    return ''
  }
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function readRequiredBodyPath(body: unknown, key = 'path'): string {
  const targetPath = readBodyPath(body, key).trim()
  if (!targetPath) {
    throw new WorkspaceError(400, `${key} body field is required`)
  }
  return targetPath
}

function readRequiredPath(query: Record<string, unknown>): string {
  const targetPath = readPath(query).trim()
  if (!targetPath) {
    throw new WorkspaceError(400, 'path query parameter is required')
  }
  return targetPath
}

function isDownloadRequested(query: Record<string, unknown>): boolean {
  const value = query.download
  return value === '1' || value === 'true'
}

function safeDownloadFileName(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const fileName = path.basename(normalizedPath).trim()
  const safeName = fileName
    .replace(/[\u0000-\u001f"<>:|?*\\/]+/gu, '_')
    .replace(/^\.+$/u, '')
    .trim()
  return safeName || 'download'
}

function readContent(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return ''
  }
  const content = (body as Record<string, unknown>).content
  return typeof content === 'string' ? content : ''
}

function readBodyString(body: unknown, key: string): string {
  if (typeof body !== 'object' || body === null) {
    return ''
  }
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function readRequiredBodyString(body: unknown, key: string): string {
  const value = readBodyString(body, key).trim()
  if (!value) {
    throw new WorkspaceError(400, `${key} body field is required`)
  }
  return value
}

function readOptionalBodyString(body: unknown, key: string): string | undefined {
  const value = readBodyString(body, key).trim()
  return value || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function redactWorkspaceLabel(
  labelValue: unknown,
  host: string,
  rootPathValue?: unknown,
): string {
  const label = typeof labelValue === 'string' ? labelValue.trim() : ''
  const rootPath = typeof rootPathValue === 'string' ? rootPathValue.trim() : ''
  if (label && (!rootPath || !label.includes(rootPath))) {
    return label
  }
  return host === 'local' ? 'Local workspace' : `${host} workspace`
}

function toPublicWorkspaceSource(
  source: Record<string, unknown>,
  rootPathValue?: unknown,
): Record<string, unknown> {
  const host = typeof source.host === 'string' && source.host.trim()
    ? source.host
    : 'local'
  const targetId = typeof source.id === 'string' ? source.id : ''
  return {
    kind: source.kind,
    id: targetId,
    targetId,
    label: redactWorkspaceLabel(source.label, host, rootPathValue),
    host,
    readOnly: source.readOnly === true,
  }
}

function toPublicWorkspaceSummary(workspace: Record<string, unknown>): Record<string, unknown> {
  const source = isRecord(workspace.source)
    ? workspace.source
    : {}
  return {
    source: toPublicWorkspaceSource(source, workspace.rootPath),
    readOnly: workspace.readOnly === true,
    isRemote: workspace.isRemote === true,
  }
}

function toPublicWorkspaceResponse<T>(value: T): T {
  if (!isRecord(value) || !isRecord(value.workspace)) {
    return value
  }
  return {
    ...value,
    workspace: toPublicWorkspaceSummary(value.workspace),
  } as T
}

function expandLocalAbsoluteWorkspaceReference(requestedPath: string): string | null {
  const trimmedPath = requestedPath.trim()
  if (!trimmedPath) {
    return null
  }
  if (trimmedPath.startsWith('~/')) {
    return path.join(homedir(), trimmedPath.slice(2))
  }
  if (path.isAbsolute(trimmedPath)) {
    return trimmedPath
  }
  return null
}

function normalizeWorkspaceReferencePath(requestedPath: string): string {
  const trimmedPath = requestedPath.trim()
  if (!trimmedPath) {
    throw new WorkspaceError(400, 'path body field is required')
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmedPath)) {
    return trimmedPath
  }

  let parsed: URL
  try {
    parsed = new URL(trimmedPath)
  } catch {
    throw new WorkspaceError(400, 'Invalid workspace reference URI')
  }
  if (parsed.protocol !== 'file:') {
    throw new WorkspaceError(400, 'Unsupported workspace reference URI')
  }
  if (parsed.hostname && parsed.hostname !== 'localhost') {
    throw new WorkspaceError(400, 'Unsupported non-local file URI authority')
  }
  try {
    return fileURLToPath(parsed)
  } catch {
    throw new WorkspaceError(400, 'Invalid file workspace reference URI')
  }
}

function isWorkspaceRootEscape(error: unknown): error is WorkspaceError {
  return error instanceof WorkspaceError
    && error.statusCode === 403
    && error.message === 'Workspace path escapes the workspace root'
}

function pathContainsLocalFile(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function localPathAliasVariant(targetPath: string): string {
  const normalized = path.normalize(targetPath)
  return normalized.startsWith('/private/')
    ? normalized.slice('/private'.length)
    : `/private${normalized}`
}

function isLocalPathAlias(leftPath: string, rightPath: string): boolean {
  const normalizedLeft = path.normalize(leftPath)
  const normalizedRight = path.normalize(rightPath)
  return normalizedLeft === normalizedRight
    || localPathAliasVariant(normalizedLeft) === normalizedRight
    || normalizedLeft === localPathAliasVariant(normalizedRight)
}

async function resolveExternalLocalWorkspaceReference(
  options: WorkspaceRouterOptions,
  resolved: ResolvedWorkspaceTarget,
  requestedPath: string,
): Promise<WorkspacePathResolution | null> {
  if (resolved.workspace.isRemote) {
    return null
  }

  const absolutePath = expandLocalAbsoluteWorkspaceReference(requestedPath)
  if (!absolutePath) {
    return null
  }

  let resolvedAbsolutePath: string
  try {
    resolvedAbsolutePath = await realpath(absolutePath)
  } catch {
    throw new WorkspaceError(404, 'Workspace path not found')
  }

  let targetStat
  try {
    targetStat = await stat(resolvedAbsolutePath)
  } catch {
    throw new WorkspaceError(404, 'Workspace path not found')
  }

  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw new WorkspaceError(400, 'Workspace path must be a file or directory')
  }

  let targetRootPath = targetStat.isDirectory()
    ? (
        isLocalPathAlias(absolutePath, resolvedAbsolutePath)
          ? absolutePath
          : resolvedAbsolutePath
      )
    : path.dirname(absolutePath)
  if (!targetStat.isDirectory()) {
    const resolvedRequestedRoot = await realpath(targetRootPath)
    if (!pathContainsLocalFile(resolvedRequestedRoot, resolvedAbsolutePath)) {
      targetRootPath = path.dirname(resolvedAbsolutePath)
    }
  }
  const target = await options.resolver.open({
    authorizationConversationId: resolved.target.conversationId,
    authorizationSessionName: resolved.target.sessionName,
    authorizationCommanderId: resolved.target.commanderId,
    hostHint: resolved.target.host,
    pathHint: targetRootPath,
    readOnly: resolved.target.readOnly,
  })
  const retargeted = await options.resolver.resolveTarget(target.targetId)
  const selection = await resolveWorkspacePathSelection(
    retargeted.workspace,
    resolvedAbsolutePath,
    retargeted.commandRunner,
  )

  return {
    ...selection,
    targetId: target.targetId,
    targetLabel: redactWorkspaceLabel(target.label, target.host, target.rootPath),
    targetReadOnly: target.readOnly,
  }
}

async function openWorkspaceReferenceTarget(
  options: WorkspaceRouterOptions,
  input: {
    requestedPath: string
    commanderId?: string
    conversationId?: string
    sessionName?: string
    hostHint?: string
    pathHint?: string
  },
  initialTildeRunner?: WorkspaceCommandRunner,
): Promise<WorkspacePathResolution> {
  const requestedPath = normalizeWorkspaceReferencePath(input.requestedPath)
  const normalizedSlashPath = requestedPath.replaceAll('\\', '/')
  const derivedRoot = path.posix.dirname(normalizedSlashPath)
  const candidateRoots: Array<{
    rootPath: string | undefined
    authorizeLifecycleRoots: boolean
  }> = []
  if (input.pathHint?.trim()) {
    candidateRoots.push({ rootPath: input.pathHint, authorizeLifecycleRoots: false })
  }
  candidateRoots.push({ rootPath: undefined, authorizeLifecycleRoots: false })
  if (path.posix.isAbsolute(normalizedSlashPath) || normalizedSlashPath.startsWith('~/')) {
    candidateRoots.push({ rootPath: derivedRoot, authorizeLifecycleRoots: true })
  }

  let lastError: unknown = null
  let tildeRunner = initialTildeRunner
  for (const candidate of candidateRoots) {
    try {
      const pathHint = await expandWorkspaceBoundaryTildeReference(candidate.rootPath, tildeRunner)
      const authorizationRootHints = candidate.authorizeLifecycleRoots
        ? (await Promise.all(
          (options.lifecycleTaskRoots ?? DEFAULT_LIFECYCLE_TASK_ROOTS)
            .map((rootPath) => expandWorkspaceBoundaryTildeReference(rootPath, tildeRunner)),
        )).filter((rootPath): rootPath is string => Boolean(rootPath))
        : undefined
      const target = await options.resolver.open({
        conversationId: input.conversationId,
        sessionName: input.sessionName,
        commanderId: input.commanderId,
        hostHint: input.hostHint,
        pathHint,
        authorizationRootHints,
        locationScoped: Boolean(pathHint),
        persistTarget: false,
        readOnly: true,
      })
      const resolved = await options.resolver.resolveTarget(target.targetId)
      if (
        !initialTildeRunner
        && input.pathHint?.trim().startsWith('~/')
        && resolved.commandRunner
      ) {
        return openWorkspaceReferenceTarget(options, input, resolved.commandRunner)
      }
      tildeRunner = resolved.commandRunner
      const targetPath = await expandWorkspaceBoundaryTildeReference(requestedPath, resolved.commandRunner)
      const selectionPath = candidate.authorizeLifecycleRoots
        ? path.posix.relative(candidate.rootPath ?? derivedRoot, normalizedSlashPath)
        : targetPath
      const selection = await resolveWorkspacePathSelection(
        resolved.workspace,
        selectionPath,
        resolved.commandRunner,
      )
      return {
        ...selection,
        targetId: target.targetId,
        targetLabel: redactWorkspaceLabel(target.label, target.host, target.rootPath),
        targetReadOnly: target.readOnly,
      }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new WorkspaceError(404, 'Workspace path not found')
}

async function expandWorkspaceBoundaryTildeReference(
  requestedPath: string | undefined,
  runner?: WorkspaceCommandRunner,
): Promise<string | undefined> {
  if (!requestedPath?.startsWith('~/')) {
    return requestedPath
  }
  if (runner) {
    return expandRemoteTildeReference(requestedPath, runner)
  }
  return path.join(homedir(), requestedPath.slice(2))
}

async function expandRemoteTildeReference(
  requestedPath: string,
  runner?: WorkspaceCommandRunner,
): Promise<string> {
  if (!runner || !requestedPath.startsWith('~/')) {
    return requestedPath
  }
  const script = 'printf "%s\\n" "$HOME/${1#\\~/}"'
  const { stdout } = await runner.exec('bash', ['-lc', script, '--', requestedPath])
  const expanded = stdout.trim()
  return expanded || requestedPath
}

async function readRemoteRawFile(
  filePath: string,
  runner: WorkspaceCommandRunner,
): Promise<Buffer> {
  const { stdout } = await runner.exec('bash', ['-lc', 'base64 < "$1"', '--', filePath])
  return Buffer.from(stdout.replace(/\s+/g, ''), 'base64')
}

function runUploadMiddleware(req: Request, res: Response, destinationPath: string): Promise<void> {
  const middleware = createWorkspaceUploadMiddleware(destinationPath).array('files')
  return new Promise((resolve, reject) => {
    middleware(req, res, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

export function createWorkspaceRouter(options: WorkspaceRouterOptions): Router {
  const router = Router()
  const preferencesStore = options.preferencesStore ?? new WorkspacePreferencesStore()
  const rawTickets = new InMemoryTransportAuthTicketStore()
  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:read'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })
  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })
  const requireRawReadAccess: typeof requireReadAccess = (req, res, next) => {
    try {
      const targetId = readTargetId(req.query)
      const requestedPath = readRequiredPath(req.query)
      const url = new URL(req.originalUrl || req.url, `http://${req.headers.host ?? 'localhost'}`)
      if (
        rawTickets.consume(
          readTransportAuthTicketFromUrl(url),
          'workspace.raw',
          { subject: workspaceRawTicketSubject(targetId, requestedPath) },
        )
      ) {
        req.user = { id: 'transport-ticket', email: 'system' }
        req.authMode = 'api-key'
        next()
        return
      }
    } catch {
      // Fall through to normal auth. That preserves auth failures for missing
      // credentials instead of turning them into workspace validation errors.
    }

    requireReadAccess(req, res, next)
  }

  router.post('/open', requireReadAccess, async (req, res) => {
    try {
      const conversationId = typeof req.body?.conversationId === 'string'
        ? req.body.conversationId
        : ''
      const sessionName = typeof req.body?.sessionName === 'string'
        ? req.body.sessionName
        : ''
      const commanderId = typeof req.body?.commanderId === 'string'
        ? req.body.commanderId
        : ''
      const target = await options.resolver.open({
        conversationId,
        sessionName,
        commanderId,
        hostHint: typeof req.body?.hostHint === 'string' ? req.body.hostHint : undefined,
        pathHint: typeof req.body?.pathHint === 'string' ? req.body.pathHint : undefined,
      })
      res.json({
        targetId: target.targetId,
        label: target.label,
        host: target.host,
        readOnly: target.readOnly,
      })
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/tree', requireReadAccess, async (req, res) => {
    try {
      const resolved = await options.resolver.resolveTarget(readTargetId(req.query))
      res.json(toPublicWorkspaceResponse(await listWorkspaceTree(
        resolved.workspace,
        readPath(req.query),
        resolved.commandRunner,
      )))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/expand', requireReadAccess, async (req, res) => {
    try {
      const resolved = await options.resolver.resolveTarget(readTargetId(req.query))
      res.json(toPublicWorkspaceResponse(await listWorkspaceTree(
        resolved.workspace,
        readPath(req.query),
        resolved.commandRunner,
      )))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/resolve-path', requireReadAccess, async (req, res) => {
    try {
      const resolved = await options.resolver.resolveTarget(readTargetId(req.query))
      const requestedPath = readRequiredPath(req.query)
      try {
        res.json(toPublicWorkspaceResponse(await resolveWorkspacePathSelection(
          resolved.workspace,
          requestedPath,
          resolved.commandRunner,
        )))
      } catch (error) {
        const retargetedSelection = isWorkspaceRootEscape(error)
          ? await resolveExternalLocalWorkspaceReference(options, resolved, requestedPath)
          : null
        if (retargetedSelection) {
          res.json(toPublicWorkspaceResponse(retargetedSelection))
          return
        }
        throw error
      }
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/resolve-reference', requireReadAccess, async (req, res) => {
    try {
      res.json(toPublicWorkspaceResponse(await openWorkspaceReferenceTarget(options, {
        requestedPath: readRequiredBodyString(req.body, 'path'),
        commanderId: readOptionalBodyString(req.body, 'commanderId'),
        conversationId: readOptionalBodyString(req.body, 'conversationId'),
        sessionName: readOptionalBodyString(req.body, 'sessionName'),
        hostHint: readOptionalBodyString(req.body, 'hostHint'),
        pathHint: readOptionalBodyString(req.body, 'pathHint'),
      })))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/file', requireReadAccess, async (req, res) => {
    try {
      const resolved = await options.resolver.resolveTarget(readTargetId(req.query))
      res.json(toPublicWorkspaceResponse(await readWorkspaceFilePreview(
        resolved.workspace,
        readRequiredPath(req.query),
        resolved.commandRunner,
      )))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/raw-ticket', requireReadAccess, (req, res) => {
    try {
      const targetId = readRequiredBodyString(req.body, 'targetId')
      const requestedPath = readRequiredBodyPath(req.body)
      res.json(rawTickets.issue('workspace.raw', {
        subject: workspaceRawTicketSubject(targetId, requestedPath),
      }))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/raw', requireRawReadAccess, async (req, res) => {
    try {
      const resolved = await options.resolver.resolveTarget(readTargetId(req.query))
      const requestedPath = readRequiredPath(req.query)
      const { absolutePath } = await resolveWorkspacePath(
        resolved.workspace,
        requestedPath,
        { expectFile: true },
        resolved.commandRunner,
      )
      const mimeType = getMimeType(absolutePath)
      if (mimeType) {
        res.type(mimeType)
      }
      if (isDownloadRequested(req.query)) {
        res.attachment(safeDownloadFileName(requestedPath || absolutePath))
      }
      if (resolved.workspace.isRemote) {
        if (!resolved.commandRunner) {
          throw new WorkspaceError(501, 'Remote workspace browsing is not supported yet')
        }
        res.send(await readRemoteRawFile(absolutePath, resolved.commandRunner))
        return
      }
      createReadStream(absolutePath).on('error', (error) => {
        sendWorkspaceError(res, error)
      }).pipe(res)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/context/materialize', requireReadAccess, async (req, res) => {
    try {
      const targetId = readRequiredBodyString(req.body, 'targetId')
      const context = readWorkspaceContextPayload({
        ...(isRecord(req.body) ? req.body : {}),
        targetId,
      })
      res.json(await materializeWorkspaceContextPayload({
        resolver: options.resolver,
        context,
      }))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/git/status', requireReadAccess, async (req, res) => {
    try {
      const resolved = await options.resolver.resolveTarget(readTargetId(req.query))
      res.json(toPublicWorkspaceResponse(
        await readWorkspaceGitStatus(resolved.workspace, resolved.commandRunner),
      ))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/git/log', requireReadAccess, async (req, res) => {
    try {
      const resolved = await options.resolver.resolveTarget(readTargetId(req.query))
      const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 15
      res.json(toPublicWorkspaceResponse(await readWorkspaceGitLog(
        resolved.workspace,
        Number.isFinite(limit) ? limit : 15,
        resolved.commandRunner,
      )))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.put('/file', requireWriteAccess, async (req, res) => {
    try {
      const resolved = await resolveWritableWorkspaceTarget(options, req.query)
      res.json(toPublicWorkspaceResponse(await saveWorkspaceTextFile(
        resolved.workspace,
        readRequiredBodyPath(req.body),
        readContent(req.body),
      )))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/new-file', requireWriteAccess, async (req, res) => {
    try {
      const resolved = await resolveWritableWorkspaceTarget(options, req.query)
      res.json(toPublicWorkspaceResponse(
        await createWorkspaceFile(resolved.workspace, readRequiredBodyPath(req.body)),
      ))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/new-folder', requireWriteAccess, async (req, res) => {
    try {
      const resolved = await resolveWritableWorkspaceTarget(options, req.query)
      res.json(toPublicWorkspaceResponse(
        await createWorkspaceFolder(resolved.workspace, readRequiredBodyPath(req.body)),
      ))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/rename', requireWriteAccess, async (req, res) => {
    try {
      const resolved = await resolveWritableWorkspaceTarget(options, req.query)
      res.json(toPublicWorkspaceResponse(await renameWorkspaceEntry(
        resolved.workspace,
        readRequiredBodyPath(req.body, 'fromPath'),
        readRequiredBodyPath(req.body, 'toPath'),
      )))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.delete('/path', requireWriteAccess, async (req, res) => {
    try {
      const resolved = await resolveWritableWorkspaceTarget(options, req.query)
      res.json(toPublicWorkspaceResponse(
        await deleteWorkspaceEntry(resolved.workspace, readRequiredPath(req.query)),
      ))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/upload', requireWriteAccess, async (req, res) => {
    try {
      const resolved = await resolveWritableWorkspaceTarget(options, req.query)
      const destination = await resolveWorkspaceUploadDestination(
        resolved.workspace,
        readPath(req.query),
      )
      await runUploadMiddleware(req, res, destination.absolutePath)
      const uploaded = (req.files as Express.Multer.File[] | undefined)?.map((file) => file.filename) ?? []
      res.json({ uploaded, path: destination.relativePath })
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/git/init', requireWriteAccess, async (req, res) => {
    try {
      const resolved = await resolveWritableWorkspaceTarget(options, req.query)
      res.json({ output: await initWorkspaceGit(resolved.workspace, resolved.commandRunner) })
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/preferences', requireReadAccess, async (_req, res) => {
    try {
      res.json(await preferencesStore.get())
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.put('/preferences', requireWriteAccess, async (req, res) => {
    try {
      res.json(await preferencesStore.update({
        panelDefault: req.body?.panelDefault,
      }))
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  return router
}
