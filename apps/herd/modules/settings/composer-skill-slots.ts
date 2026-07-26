export interface ComposerSkillSlot {
  id: string
  skillName: string | null
}

export interface ComposerSkillSlotSettings {
  slots: ComposerSkillSlot[]
}

export type ComposerSkillSlotSettingsPatch = Partial<ComposerSkillSlotSettings>

interface NormalizedComposerSkillSlotPatch {
  ok: true
  patch: ComposerSkillSlotSettingsPatch
}

interface InvalidComposerSkillSlotPatch {
  ok: false
  error: string
}

const DEFAULT_SLOT_ID = 'primary'
const DEFAULT_SLOT_IDS = new Set([DEFAULT_SLOT_ID])
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cloneSlot(slot: ComposerSkillSlot): ComposerSkillSlot {
  return {
    id: slot.id,
    skillName: slot.skillName,
  }
}

export function cloneComposerSkillSlotSettings(
  settings: ComposerSkillSlotSettings,
): ComposerSkillSlotSettings {
  return {
    slots: settings.slots.map(cloneSlot),
  }
}

export function getDefaultComposerSkillSlotSettings(): ComposerSkillSlotSettings {
  return {
    slots: [{
      id: DEFAULT_SLOT_ID,
      skillName: null,
    }],
  }
}

function normalizeSkillName(value: unknown): { skillName: string | null } | { error: string } {
  if (value === null || value === undefined) {
    return { skillName: null }
  }

  if (typeof value !== 'string') {
    return { error: 'composer skill slot skillName must be a string or null' }
  }

  const skillName = value.trim().replace(/^\/+/u, '')
  if (skillName.length === 0) {
    return { skillName: null }
  }
  if (!SKILL_NAME_PATTERN.test(skillName)) {
    return { error: 'composer skill slot skillName must be a valid skill name' }
  }

  return { skillName }
}

function normalizeSlot(value: unknown): { slot: ComposerSkillSlot } | { error: string } {
  if (!isRecord(value)) {
    return { error: 'composer skill slot must be an object' }
  }

  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!DEFAULT_SLOT_IDS.has(id)) {
    return { error: `composer skill slot "${id}" is not supported` }
  }

  const skillName = normalizeSkillName(value.skillName)
  if ('error' in skillName) {
    return skillName
  }

  return {
    slot: {
      id,
      skillName: skillName.skillName,
    },
  }
}

function mergeSlots(slots: ComposerSkillSlot[]): ComposerSkillSlot[] {
  const byId = new Map(getDefaultComposerSkillSlotSettings().slots.map((slot) => [slot.id, cloneSlot(slot)]))
  for (const slot of slots) {
    byId.set(slot.id, cloneSlot(slot))
  }
  return getDefaultComposerSkillSlotSettings().slots.map((slot) => byId.get(slot.id) ?? cloneSlot(slot))
}

function normalizeSlotArray(value: unknown): { slots: ComposerSkillSlot[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: 'composerSkillSlots.slots must be an array' }
  }

  const seenIds = new Set<string>()
  const slots: ComposerSkillSlot[] = []
  for (const item of value) {
    const normalized = normalizeSlot(item)
    if ('error' in normalized) {
      return normalized
    }
    if (seenIds.has(normalized.slot.id)) {
      return { error: `composer skill slot "${normalized.slot.id}" is duplicated` }
    }
    seenIds.add(normalized.slot.id)
    slots.push(normalized.slot)
  }

  return { slots: mergeSlots(slots) }
}

function normalizePersistedSlotArray(value: unknown): ComposerSkillSlot[] {
  if (!Array.isArray(value)) {
    return getDefaultComposerSkillSlotSettings().slots
  }

  const slots: ComposerSkillSlot[] = []
  for (const item of value) {
    const normalized = normalizeSlot(item)
    if ('slot' in normalized) {
      slots.push(normalized.slot)
    }
  }

  return mergeSlots(slots)
}

export function normalizePersistedComposerSkillSlotSettings(value: unknown): ComposerSkillSlotSettings {
  if (!isRecord(value)) {
    return getDefaultComposerSkillSlotSettings()
  }

  return {
    slots: normalizePersistedSlotArray(value.slots),
  }
}

export function isPersistedComposerSkillSlotSettingsValid(value: unknown): boolean {
  return isRecord(value) && !('error' in normalizeSlotArray(value.slots))
}

export function normalizeComposerSkillSlotSettingsPatch(
  value: unknown,
): NormalizedComposerSkillSlotPatch | InvalidComposerSkillSlotPatch {
  if (!isRecord(value)) {
    return { ok: false, error: 'composerSkillSlots must be an object' }
  }

  const patch: ComposerSkillSlotSettingsPatch = {}
  if (Object.prototype.hasOwnProperty.call(value, 'slots')) {
    const normalized = normalizeSlotArray(value.slots)
    if ('error' in normalized) {
      return { ok: false, error: normalized.error }
    }
    patch.slots = normalized.slots
  }

  if (patch.slots === undefined) {
    return { ok: false, error: 'composerSkillSlots patch must include slots' }
  }

  return { ok: true, patch }
}

export function mergeComposerSkillSlotSettingsPatch(
  current: ComposerSkillSlotSettings,
  patch: ComposerSkillSlotSettingsPatch,
): ComposerSkillSlotSettings {
  return {
    slots: patch.slots ? mergeSlots(patch.slots) : current.slots.map(cloneSlot),
  }
}

export function getPrimaryComposerSkillName(settings: ComposerSkillSlotSettings): string | null {
  return settings.slots.find((slot) => slot.id === DEFAULT_SLOT_ID)?.skillName ?? null
}

export function setPrimaryComposerSkillName(
  settings: ComposerSkillSlotSettings,
  skillName: string | null,
): ComposerSkillSlotSettings {
  const normalized = normalizeSkillName(skillName)
  return mergeComposerSkillSlotSettingsPatch(settings, {
    slots: [{
      id: DEFAULT_SLOT_ID,
      skillName: 'skillName' in normalized ? normalized.skillName : null,
    }],
  })
}
