import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveCommanderPaths } from './paths.js'

export const COMMANDER_PROFILE_FILE = 'profile.json'

/** Optional UI metadata stored at `<commander>/.memory/profile.json` on disk. */
export interface CommanderUiProfile {
  /** CSS color for card border (e.g. `#2d3748`, `rgb(0,0,0)`) */
  borderColor?: string
  /** Accent for agent message rail in chat (e.g. `#38bdf8`) */
  accentColor?: string
  /** Short note for humans / future prompt tuning (not injected into agent by default) */
  speakingTone?: string
  /**
   * Image path relative to commander root (the directory named by commander id).
   * Examples: `avatar.png`, `.memory/avatar.webp`
   */
  avatar?: string
}

const MAX_STRING = 500
const MAX_AVATAR_PATH = 256

function trimString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const t = value.trim()
  if (!t || t.length > MAX_STRING) {
    return undefined
  }
  return t
}

function trimAvatarPath(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const t = value.trim().replace(/\\/g, '/')
  if (!t || t.length > MAX_AVATAR_PATH) {
    return undefined
  }
  if (t.includes('..') || path.isAbsolute(t)) {
    return undefined
  }
  return t
}

function isReasonableCssColor(value: string): boolean {
  if (value.length > 80) {
    return false
  }
  if (/^#[0-9a-f]{3,8}$/i.test(value)) {
    return true
  }
  if (/^rgba?\(/i.test(value)) {
    return true
  }
  if (/^[a-z][a-z0-9-]*$/i.test(value) && value.length <= 40) {
    return true
  }
  return false
}

export function sanitizeUiProfile(raw: unknown): CommanderUiProfile | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const o = raw as Record<string, unknown>
  const borderColor = trimString(o.borderColor)
  const accentColor = trimString(o.accentColor)
  const speakingTone = trimString(o.speakingTone)
  const avatar = trimAvatarPath(o.avatar)

  const out: CommanderUiProfile = {}
  if (borderColor && isReasonableCssColor(borderColor)) {
    out.borderColor = borderColor
  }
  if (accentColor && isReasonableCssColor(accentColor)) {
    out.accentColor = accentColor
  }
  if (speakingTone) {
    out.speakingTone = speakingTone
  }
  if (avatar) {
    out.avatar = avatar
  }
  return Object.keys(out).length > 0 ? out : null
}

export async function readCommanderUiProfile(
  commanderId: string,
  basePath: string,
): Promise<CommanderUiProfile | null> {
  const { memoryRoot } = resolveCommanderPaths(commanderId, basePath)
  const filePath = path.join(memoryRoot, COMMANDER_PROFILE_FILE)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return sanitizeUiProfile(parsed)
  } catch {
    return null
  }
}

/**
 * Resolves avatar to an absolute path under the commander root, or null if invalid / missing.
 */
export async function resolveCommanderAvatarPath(
  commanderId: string,
  basePath: string,
  profile: CommanderUiProfile | null,
): Promise<string | null> {
  const rel = profile?.avatar
  if (!rel) {
    return null
  }
  const { commanderRoot } = resolveCommanderPaths(commanderId, basePath)
  const resolved = path.resolve(commanderRoot, rel)
  const rootWithSep = commanderRoot.endsWith(path.sep) ? commanderRoot : `${commanderRoot}${path.sep}`
  if (!resolved.startsWith(rootWithSep) && resolved !== commanderRoot) {
    return null
  }
  try {
    await access(resolved)
    return resolved
  } catch {
    return null
  }
}

export function profileForApiResponse(
  profile: CommanderUiProfile | null,
): { borderColor?: string; accentColor?: string; speakingTone?: string } | null {
  if (!profile) {
    return null
  }
  const { borderColor, accentColor, speakingTone } = profile
  if (!borderColor && !accentColor && !speakingTone) {
    return null
  }
  return { borderColor, accentColor, speakingTone }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

export async function writeCommanderUiProfile(
  commanderId: string,
  basePath: string,
  profile: CommanderUiProfile,
): Promise<void> {
  const { memoryRoot } = resolveCommanderPaths(commanderId, basePath)
  await mkdir(memoryRoot, { recursive: true })
  const filePath = path.join(memoryRoot, COMMANDER_PROFILE_FILE)
  await writeFile(filePath, JSON.stringify(profile, null, 2), 'utf8')
}

export function mimeTypeForAvatarFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}
