import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import multer from 'multer'
import {
  requireWritableWorkspace,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
  WorkspaceError,
} from './resolver.js'
import type {
  ResolvedWorkspace,
  WorkspaceFilePreview,
  WorkspaceMutationResult,
} from './types.js'

const TEXT_PREVIEW_LIMIT_BYTES = 256 * 1024
const IMAGE_PREVIEW_LIMIT_BYTES = 5 * 1024 * 1024
const FILE_NAME_PATTERN = /^[a-zA-Z0-9._\- ]+$/
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  css: 'text/css',
  gif: 'image/gif',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  png: 'image/png',
  py: 'text/x-python',
  svg: 'image/svg+xml',
  ts: 'text/plain',
  tsx: 'text/plain',
  txt: 'text/plain',
  webp: 'image/webp',
  yml: 'text/yaml',
  yaml: 'text/yaml',
}

function getExtension(filePath: string): string {
  return path.extname(filePath).replace(/^\./, '').toLowerCase()
}

function getMimeType(filePath: string): string | undefined {
  const extension = getExtension(filePath)
  return MIME_TYPES_BY_EXTENSION[extension]
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024))
  for (const byte of sample) {
    if (byte === 0) {
      return true
    }
  }
  return false
}

async function readBufferPreview(filePath: string, size: number): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const bytesToRead = Math.min(size, TEXT_PREVIEW_LIMIT_BYTES)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function toMutationResult(
  workspace: ResolvedWorkspace,
  absolutePath: string,
): WorkspaceMutationResult {
  return {
    workspace,
    path: toWorkspaceRelativePath(workspace, absolutePath),
  }
}

export async function readWorkspaceFilePreview(
  workspace: ResolvedWorkspace,
  relativePath: string,
): Promise<WorkspaceFilePreview> {
  const { absolutePath, relativePath: normalizedRelativePath } = await resolveWorkspacePath(
    workspace,
    relativePath,
    { expectFile: true },
  )
  const fileStat = await stat(absolutePath)
  const extension = getExtension(absolutePath)
  const mimeType = getMimeType(absolutePath)

  if (IMAGE_EXTENSIONS.has(extension) && fileStat.size <= IMAGE_PREVIEW_LIMIT_BYTES) {
    const buffer = await readFile(absolutePath)
    return {
      workspace,
      path: normalizedRelativePath,
      name: path.basename(absolutePath),
      kind: 'image',
      size: fileStat.size,
      mimeType,
      content: `data:${mimeType ?? 'application/octet-stream'};base64,${buffer.toString('base64')}`,
      writable: !workspace.readOnly,
    }
  }

  const buffer = await readBufferPreview(absolutePath, fileStat.size)
  if (isLikelyBinary(buffer)) {
    return {
      workspace,
      path: normalizedRelativePath,
      name: path.basename(absolutePath),
      kind: 'binary',
      size: fileStat.size,
      mimeType,
      writable: !workspace.readOnly,
    }
  }

  return {
    workspace,
    path: normalizedRelativePath,
    name: path.basename(absolutePath),
    kind: 'text',
    size: fileStat.size,
    mimeType,
    content: buffer.toString('utf8'),
    truncated: fileStat.size > buffer.length,
    writable: !workspace.readOnly,
  }
}

export async function saveWorkspaceTextFile(
  workspace: ResolvedWorkspace,
  relativePath: string,
  content: string,
): Promise<WorkspaceMutationResult> {
  requireWritableWorkspace(workspace)
  const { absolutePath } = await resolveWorkspacePath(workspace, relativePath, { allowMissing: true })
  await writeFile(absolutePath, content, 'utf8')
  return toMutationResult(workspace, absolutePath)
}

export async function createWorkspaceFile(
  workspace: ResolvedWorkspace,
  relativePath: string,
): Promise<WorkspaceMutationResult> {
  requireWritableWorkspace(workspace)
  const { absolutePath } = await resolveWorkspacePath(workspace, relativePath, { allowMissing: true })
  const existing = await stat(absolutePath).catch(() => null)
  if (existing) {
    throw new WorkspaceError(409, 'Workspace file already exists')
  }
  await writeFile(absolutePath, '', 'utf8')
  return toMutationResult(workspace, absolutePath)
}

export async function createWorkspaceFolder(
  workspace: ResolvedWorkspace,
  relativePath: string,
): Promise<WorkspaceMutationResult> {
  requireWritableWorkspace(workspace)
  const { absolutePath } = await resolveWorkspacePath(workspace, relativePath, { allowMissing: true })
  const existing = await stat(absolutePath).catch(() => null)
  if (existing) {
    throw new WorkspaceError(409, 'Workspace folder already exists')
  }
  await mkdir(absolutePath, { recursive: false })
  return toMutationResult(workspace, absolutePath)
}

export async function renameWorkspaceEntry(
  workspace: ResolvedWorkspace,
  fromPath: string,
  toPath: string,
): Promise<WorkspaceMutationResult> {
  requireWritableWorkspace(workspace)
  const { absolutePath: sourceAbsolutePath } = await resolveWorkspacePath(workspace, fromPath)
  const { absolutePath: targetAbsolutePath } = await resolveWorkspacePath(workspace, toPath, {
    allowMissing: true,
  })
  const existing = await stat(targetAbsolutePath).catch(() => null)
  if (existing) {
    throw new WorkspaceError(409, 'Destination already exists')
  }
  await rename(sourceAbsolutePath, targetAbsolutePath)
  return toMutationResult(workspace, targetAbsolutePath)
}

export async function deleteWorkspaceEntry(
  workspace: ResolvedWorkspace,
  relativePath: string,
): Promise<WorkspaceMutationResult> {
  requireWritableWorkspace(workspace)
  if (!relativePath.trim()) {
    throw new WorkspaceError(400, 'Cannot delete the workspace root')
  }
  const { absolutePath } = await resolveWorkspacePath(workspace, relativePath)
  await rm(absolutePath, { recursive: true, force: false })
  return toMutationResult(workspace, absolutePath)
}

export function createWorkspaceUploadMiddleware(
  destinationPath: string,
  maxFiles = 5,
  maxFileSizeBytes = 10 * 1024 * 1024,
) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, destinationPath),
      filename: (_req, file, cb) => {
        if (!FILE_NAME_PATTERN.test(file.originalname)) {
          cb(new Error('Invalid filename'), '')
          return
        }
        cb(null, file.originalname)
      },
    }),
    limits: { fileSize: maxFileSizeBytes, files: maxFiles },
  })
}

export async function resolveWorkspaceUploadDestination(
  workspace: ResolvedWorkspace,
  relativePath: string | undefined | null,
): Promise<{ absolutePath: string; relativePath: string }> {
  const { absolutePath } = await resolveWorkspacePath(workspace, relativePath, {
    expectDirectory: true,
  })

  return {
    absolutePath,
    relativePath: toWorkspaceRelativePath(workspace, absolutePath),
  }
}
