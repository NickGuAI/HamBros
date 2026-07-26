import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveCommanderPaths } from './paths.js'
import { ensureCommanderVisualProfile } from './commander-visual-profile.js'
import { withCommanderMutation } from './child-mutation-coordinator.js'
import {
  DEFAULT_COMMANDER_PORTRAIT_STYLE_ID,
  parseCommanderPortraitStyleId,
  type CommanderPortraitStyleId,
} from './portrait-styles.js'

export const COMMANDER_PROFILE_FILE = 'profile.json'
export const DEFAULT_COMMANDER_AVATAR_URL = '/assets/commanders/atlas-profile.jpg'
export const GAIA_COMMANDER_AVATAR_URL = '/assets/commanders/gaia-profile.png'
export const LEGACY_GAIA_COMMANDER_AVATAR_URL = '/assets/commanders/gaia-profile.svg'
export const ASINA_COMMANDER_AVATAR_URL = '/assets/commanders/asina-profile.svg'
export const ALFRED_COMMANDER_AVATAR_URL = '/assets/commanders/alfred-profile.svg'
export const EINSTEIN_COMMANDER_AVATAR_URL = '/assets/commanders/einstein-profile.svg'
const BUNDLED_COMMANDER_AVATAR_PATTERN = /^\/assets\/commanders\/[a-z0-9][a-z0-9._-]*\.(?:gif|jpe?g|png|svg|webp)$/iu
const STOCK_COMMANDER_AVATAR_URL_BY_TEMPLATE_ID: Readonly<Record<string, string>> = {
  'engineering-manager': ASINA_COMMANDER_AVATAR_URL,
  'general-assistant': ALFRED_COMMANDER_AVATAR_URL,
  'research-intelligence-analyst': EINSTEIN_COMMANDER_AVATAR_URL,
}

/** Optional UI metadata stored at `<commander>/.memory/profile.json` on disk. */
export interface CommanderUiProfile {
  /** Short note for humans / future prompt tuning (not injected into agent by default) */
  speakingTone?: string
  /**
   * Image path relative to commander root, or a bundled `/assets/commanders/*` URL.
   * Examples: `avatar.png`, `.memory/avatar.webp`, `/assets/commanders/gaia-profile.png`
   */
  avatar?: string
  /** Built-in art direction used for generated commander headshots. */
  portraitStyleId?: CommanderPortraitStyleId
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
  if (BUNDLED_COMMANDER_AVATAR_PATTERN.test(t)) {
    return t
  }
  if (t.includes('..') || path.isAbsolute(t)) {
    return undefined
  }
  return t
}

function isBundledCommanderAvatarUrl(value: string): boolean {
  return BUNDLED_COMMANDER_AVATAR_PATTERN.test(value)
}

function normalizeBundledCommanderAvatarUrl(value: string): string {
  return value === LEGACY_GAIA_COMMANDER_AVATAR_URL ? GAIA_COMMANDER_AVATAR_URL : value
}

export function resolveDefaultCommanderAvatarUrl(options: {
  host?: string | null
  templateId?: string | null
}): string {
  if (options.host?.trim().toLowerCase() === 'gaia') {
    return GAIA_COMMANDER_AVATAR_URL
  }
  const templateId = options.templateId?.trim().toLowerCase()
  return (templateId && STOCK_COMMANDER_AVATAR_URL_BY_TEMPLATE_ID[templateId])
    ?? DEFAULT_COMMANDER_AVATAR_URL
}

export function sanitizeUiProfile(raw: unknown): CommanderUiProfile | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const o = raw as Record<string, unknown>
  const speakingTone = trimString(o.speakingTone)
  const avatar = trimAvatarPath(o.avatar)
  const portraitStyleId = parseCommanderPortraitStyleId(o.portraitStyleId)

  const out: CommanderUiProfile = {}
  if (speakingTone) {
    out.speakingTone = speakingTone
  }
  if (avatar) {
    out.avatar = normalizeBundledCommanderAvatarUrl(avatar)
  }
  if (portraitStyleId) {
    out.portraitStyleId = portraitStyleId
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
  if (isBundledCommanderAvatarUrl(rel)) {
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

export async function resolveCommanderAvatarUrl(
  commanderId: string,
  basePath: string,
  profile: CommanderUiProfile | null,
  options: { defaultAvatarUrl?: string | null } = {},
): Promise<string> {
  const rel = profile?.avatar
  if (rel && isBundledCommanderAvatarUrl(rel)) {
    return rel
  }
  const avatarPath = await resolveCommanderAvatarPath(commanderId, basePath, profile)
  return avatarPath
    ? `/api/commanders/${encodeURIComponent(commanderId)}/avatar`
    : options.defaultAvatarUrl ?? DEFAULT_COMMANDER_AVATAR_URL
}

export function profileForApiResponse(
  commanderId: string,
  profile: CommanderUiProfile | null,
): {
  speakingTone?: string
  portraitStyleId: CommanderPortraitStyleId
} {
  const cleanProfile = ensureCommanderVisualProfile(
    profile,
  )
  return {
    portraitStyleId: cleanProfile.portraitStyleId ?? DEFAULT_COMMANDER_PORTRAIT_STYLE_ID,
    ...(cleanProfile.speakingTone ? { speakingTone: cleanProfile.speakingTone } : {}),
  }
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
  lifecycleScope: string,
): Promise<void> {
  await withCommanderMutation(commanderId, lifecycleScope, async () => {
    const { memoryRoot } = resolveCommanderPaths(commanderId, basePath)
    await mkdir(memoryRoot, { recursive: true })
    const filePath = path.join(memoryRoot, COMMANDER_PROFILE_FILE)
    await writeFile(filePath, JSON.stringify(profile, null, 2), 'utf8')
  })
}

function avatarExtensionForMimeType(mimeType: string): string {
  const extMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }

  return extMap[mimeType] ?? '.bin'
}

/** Writes the avatar and profile reference as one commander mutation. */
export async function writeCommanderAvatarBytes(
  commanderId: string,
  basePath: string,
  bytes: Uint8Array,
  mimeType: string,
  profilePatch: Partial<CommanderUiProfile> = {},
  lifecycleScope = basePath,
): Promise<void> {
  await withCommanderMutation(commanderId, lifecycleScope, async () => {
    const avatarFileName = `avatar${avatarExtensionForMimeType(mimeType)}`
    const { commanderRoot } = resolveCommanderPaths(commanderId, basePath)
    await mkdir(commanderRoot, { recursive: true })
    await writeFile(path.join(commanderRoot, avatarFileName), bytes)

    const existing = await readCommanderUiProfile(commanderId, basePath)
    await writeCommanderUiProfile(commanderId, basePath, {
      ...ensureCommanderVisualProfile(existing),
      ...profilePatch,
      avatar: avatarFileName,
    } satisfies CommanderUiProfile, lifecycleScope)
  })
}

export function mimeTypeForAvatarFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}
