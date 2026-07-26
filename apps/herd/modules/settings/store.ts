import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveModuleDataDir } from '../data-dir.js'
import { withJsonStoreSchema } from '../json-store-schema.js'
import type { AppSettings, AppTheme } from './types.js'
import {
  cloneComposerAbilitySettings,
  getDefaultComposerAbilitySettings,
  isPersistedComposerAbilitySettingsValid,
  mergeComposerAbilitySettingsPatch,
  normalizePersistedComposerAbilitySettings,
  type ComposerAbilitySettingsPatch,
} from './composer-abilities.js'
import {
  cloneComposerSkillSlotSettings,
  getDefaultComposerSkillSlotSettings,
  isPersistedComposerSkillSlotSettingsValid,
  mergeComposerSkillSlotSettingsPatch,
  normalizePersistedComposerSkillSlotSettings,
  type ComposerSkillSlotSettingsPatch,
} from './composer-skill-slots.js'

export const APP_FONT_SCALE_MIN = 0.8
export const APP_FONT_SCALE_MAX = 1.6
export const APP_FONT_SCALE_STEP = 0.1
export const DEFAULT_APP_FONT_SCALE = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    composerAbilities: cloneComposerAbilitySettings(settings.composerAbilities),
    composerSkillSlots: cloneComposerSkillSlotSettings(settings.composerSkillSlots),
  }
}

export function normalizeAppTheme(value: unknown): AppTheme | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null
}

function roundAppFontScale(value: number): number {
  return Math.round(value * 10) / 10
}

function clampAppFontScale(value: number): number {
  return Math.min(APP_FONT_SCALE_MAX, Math.max(APP_FONT_SCALE_MIN, value))
}

export function normalizeAppFontScale(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  if (value < APP_FONT_SCALE_MIN || value > APP_FONT_SCALE_MAX) {
    return null
  }
  return roundAppFontScale(value)
}

function normalizePersistedAppFontScale(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return clampAppFontScale(roundAppFontScale(value))
}

function defaultSettings(now: () => Date): AppSettings {
  return {
    theme: 'light',
    fontScale: DEFAULT_APP_FONT_SCALE,
    composerAbilities: getDefaultComposerAbilitySettings(),
    composerSkillSlots: getDefaultComposerSkillSlotSettings(),
    updatedAt: now().toISOString(),
  }
}

function parsePersistedSettings(raw: unknown, now: () => Date): AppSettings {
  const fallback = defaultSettings(now)
  if (!isRecord(raw)) {
    return fallback
  }

  return {
    theme: normalizeAppTheme(raw.theme) ?? fallback.theme,
    fontScale: normalizePersistedAppFontScale(raw.fontScale) ?? fallback.fontScale,
    composerAbilities: normalizePersistedComposerAbilitySettings(raw.composerAbilities),
    composerSkillSlots: normalizePersistedComposerSkillSlotSettings(raw.composerSkillSlots),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.trim().length > 0
      ? raw.updatedAt.trim()
      : fallback.updatedAt,
  }
}

export function isPersistedAppSettingsValid(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false
  }
  const knownFieldPresent = [
    'theme',
    'fontScale',
    'composerAbilities',
    'composerSkillSlots',
    'updatedAt',
  ].some((field) => Object.prototype.hasOwnProperty.call(raw, field))
  if (!knownFieldPresent) {
    return false
  }
  return (raw.theme === undefined || normalizeAppTheme(raw.theme) !== null)
    && (raw.fontScale === undefined || normalizeAppFontScale(raw.fontScale) !== null)
    && (
      raw.composerAbilities === undefined
      || isPersistedComposerAbilitySettingsValid(raw.composerAbilities)
    )
    && (
      raw.composerSkillSlots === undefined
      || isPersistedComposerSkillSlotSettingsValid(raw.composerSkillSlots)
    )
    && (
      raw.updatedAt === undefined
      || (typeof raw.updatedAt === 'string' && raw.updatedAt.trim().length > 0)
    )
}

export function defaultAppSettingsStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveModuleDataDir('settings', env), 'app-settings.json')
}

export class AppSettingsStore {
  private readonly filePath: string
  private readonly now: () => Date
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: { filePath?: string; now?: () => Date } = {}) {
    this.filePath = path.resolve(options.filePath ?? defaultAppSettingsStorePath())
    this.now = options.now ?? (() => new Date())
  }

  async get(): Promise<AppSettings> {
    const persisted = await this.readFromDisk()
    if (persisted) {
      return cloneSettings(persisted)
    }

    const created = defaultSettings(this.now)
    await this.writeToDisk(created)
    return cloneSettings(created)
  }

  async update(input: Partial<Pick<AppSettings, 'theme' | 'fontScale'>> & {
    composerAbilities?: ComposerAbilitySettingsPatch
    composerSkillSlots?: ComposerSkillSlotSettingsPatch
  }): Promise<AppSettings> {
    return this.withMutationLock(async () => {
      const current = await this.readFromDisk() ?? defaultSettings(this.now)
      const theme = input.theme === undefined
        ? current.theme
        : normalizeAppTheme(input.theme) ?? current.theme
      const fontScale = input.fontScale === undefined
        ? current.fontScale
        : normalizeAppFontScale(input.fontScale) ?? current.fontScale
      const composerAbilities = input.composerAbilities === undefined
        ? current.composerAbilities
        : mergeComposerAbilitySettingsPatch(current.composerAbilities, input.composerAbilities)
      const composerSkillSlots = input.composerSkillSlots === undefined
        ? current.composerSkillSlots
        : mergeComposerSkillSlotSettingsPatch(current.composerSkillSlots, input.composerSkillSlots)
      const next: AppSettings = {
        ...current,
        theme,
        fontScale,
        composerAbilities,
        composerSkillSlots,
        updatedAt: this.now().toISOString(),
      }

      await this.writeToDisk(next)
      return cloneSettings(next)
    })
  }

  private async readFromDisk(): Promise<AppSettings | null> {
    let rawFile: string
    try {
      rawFile = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawFile) as unknown
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid app settings JSON at "${this.filePath}": ${detail}`)
    }

    return parsePersistedSettings(parsed, this.now)
  }

  private async writeToDisk(settings: AppSettings): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(
      this.filePath,
      `${JSON.stringify(withJsonStoreSchema({ ...cloneSettings(settings) }), null, 2)}\n`,
      'utf8',
    )
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
