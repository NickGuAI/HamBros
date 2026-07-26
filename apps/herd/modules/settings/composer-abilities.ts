export type ComposerAbilitySource = 'default' | 'custom'

export interface ComposerAbilityDefinition {
  id: string
  label: string
  prompt: string
  enabled: boolean
}

export interface ComposerAbility extends ComposerAbilityDefinition {
  source: ComposerAbilitySource
}

export interface ComposerAbilitySettings {
  defaultAbilities: ComposerAbilityDefinition[]
  customAbilities: ComposerAbilityDefinition[]
  customAbilitiesEnabled: boolean
}

export type ComposerAbilitySettingsPatch = Partial<ComposerAbilitySettings>

interface NormalizedComposerAbilityPatch {
  ok: true
  patch: ComposerAbilitySettingsPatch
}

interface InvalidComposerAbilityPatch {
  ok: false
  error: string
}

const THINK_HARD_PROMPT = [
  'Think ultra hard internally before responding.',
  'Use a deep-think capability if one is available in this runtime.',
  'Do not reveal private chain-of-thought; give a concise user-visible answer unless the user asks for detail.',
].join(' ')

export const DEFAULT_COMPOSER_ABILITIES: readonly ComposerAbilityDefinition[] = Object.freeze([
  Object.freeze({
    id: 'think-hard',
    label: 'Think Hard',
    prompt: THINK_HARD_PROMPT,
    enabled: true,
  }),
])

const DEFAULT_ABILITY_IDS = new Set(DEFAULT_COMPOSER_ABILITIES.map((ability) => ability.id))
const RETIRED_DEFAULT_ABILITY_IDS = new Set(['create-quests'])
const RESERVED_ABILITY_IDS = new Set([...DEFAULT_ABILITY_IDS, ...RETIRED_DEFAULT_ABILITY_IDS])
const COMPOSER_ABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u
const MAX_CUSTOM_ABILITIES = 12
const MAX_ABILITY_LABEL_LENGTH = 40
const MAX_ABILITY_PROMPT_LENGTH = 4_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cloneAbility(ability: ComposerAbilityDefinition): ComposerAbilityDefinition {
  return {
    id: ability.id,
    label: ability.label,
    prompt: ability.prompt,
    enabled: ability.enabled,
  }
}

export function cloneComposerAbilitySettings(settings: ComposerAbilitySettings): ComposerAbilitySettings {
  return {
    defaultAbilities: settings.defaultAbilities.map(cloneAbility),
    customAbilities: settings.customAbilities.map(cloneAbility),
    customAbilitiesEnabled: settings.customAbilitiesEnabled,
  }
}

export function getDefaultComposerAbilitySettings(): ComposerAbilitySettings {
  return {
    defaultAbilities: DEFAULT_COMPOSER_ABILITIES.map(cloneAbility),
    customAbilities: [],
    customAbilitiesEnabled: false,
  }
}

function normalizeAbilityDefinition(
  value: unknown,
  options: {
    source: ComposerAbilitySource
    seenIds: Set<string>
    allowDefaultIds: boolean
  },
): { ability: ComposerAbilityDefinition } | { error: string } {
  if (!isRecord(value)) {
    return { error: 'composer ability must be an object' }
  }

  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!COMPOSER_ABILITY_ID_PATTERN.test(id)) {
    return { error: 'composer ability id must be a kebab-case string up to 64 characters' }
  }
  if (options.seenIds.has(id)) {
    return { error: `composer ability id "${id}" is duplicated` }
  }
  if (options.source === 'default' && !DEFAULT_ABILITY_IDS.has(id)) {
    return { error: `default composer ability "${id}" is not supported` }
  }
  if (options.source === 'custom' && RESERVED_ABILITY_IDS.has(id)) {
    return { error: `custom composer ability "${id}" conflicts with a default ability` }
  }
  if (!options.allowDefaultIds && RESERVED_ABILITY_IDS.has(id)) {
    return { error: `composer ability "${id}" is reserved for defaults` }
  }

  const label = typeof value.label === 'string' ? value.label.trim() : ''
  if (label.length === 0 || label.length > MAX_ABILITY_LABEL_LENGTH) {
    return { error: `composer ability "${id}" label must be 1-${MAX_ABILITY_LABEL_LENGTH} characters` }
  }

  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : ''
  if (prompt.length === 0 || prompt.length > MAX_ABILITY_PROMPT_LENGTH) {
    return { error: `composer ability "${id}" prompt must be 1-${MAX_ABILITY_PROMPT_LENGTH} characters` }
  }

  if (typeof value.enabled !== 'boolean') {
    return { error: `composer ability "${id}" enabled must be a boolean` }
  }

  options.seenIds.add(id)
  return {
    ability: {
      id,
      label,
      prompt,
      enabled: value.enabled,
    },
  }
}

function normalizeAbilityArray(
  value: unknown,
  source: ComposerAbilitySource,
): { abilities: ComposerAbilityDefinition[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: `composerAbilities.${source === 'default' ? 'defaultAbilities' : 'customAbilities'} must be an array` }
  }
  if (source === 'custom' && value.length > MAX_CUSTOM_ABILITIES) {
    return { error: `composerAbilities.customAbilities cannot contain more than ${MAX_CUSTOM_ABILITIES} abilities` }
  }

  const seenIds = new Set<string>()
  const abilities: ComposerAbilityDefinition[] = []
  for (const item of value) {
    const normalized = normalizeAbilityDefinition(item, {
      source,
      seenIds,
      allowDefaultIds: source === 'default',
    })
    if ('error' in normalized) {
      return normalized
    }
    abilities.push(normalized.ability)
  }
  return { abilities }
}

function normalizePersistedAbilityArray(value: unknown, source: ComposerAbilitySource): ComposerAbilityDefinition[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seenIds = new Set<string>()
  const abilities: ComposerAbilityDefinition[] = []
  for (const item of value) {
    const normalized = normalizeAbilityDefinition(item, {
      source,
      seenIds,
      allowDefaultIds: source === 'default',
    })
    if ('ability' in normalized) {
      abilities.push(normalized.ability)
    }
  }
  return abilities
}

function mergeDefaultAbilities(abilities: ComposerAbilityDefinition[]): ComposerAbilityDefinition[] {
  const byId = new Map(DEFAULT_COMPOSER_ABILITIES.map((ability) => [ability.id, cloneAbility(ability)]))
  for (const ability of abilities) {
    if (DEFAULT_ABILITY_IDS.has(ability.id)) {
      byId.set(ability.id, cloneAbility(ability))
    }
  }
  return DEFAULT_COMPOSER_ABILITIES.map((ability) => byId.get(ability.id) ?? cloneAbility(ability))
}

export function normalizePersistedComposerAbilitySettings(value: unknown): ComposerAbilitySettings {
  const fallback = getDefaultComposerAbilitySettings()
  if (!isRecord(value)) {
    return fallback
  }

  return {
    defaultAbilities: mergeDefaultAbilities(normalizePersistedAbilityArray(value.defaultAbilities, 'default')),
    customAbilities: normalizePersistedAbilityArray(value.customAbilities, 'custom').slice(0, MAX_CUSTOM_ABILITIES),
    customAbilitiesEnabled: typeof value.customAbilitiesEnabled === 'boolean'
      ? value.customAbilitiesEnabled
      : fallback.customAbilitiesEnabled,
  }
}

export function isPersistedComposerAbilitySettingsValid(value: unknown): boolean {
  if (!isRecord(value) || typeof value.customAbilitiesEnabled !== 'boolean') {
    return false
  }
  return !('error' in normalizeAbilityArray(value.defaultAbilities, 'default'))
    && !('error' in normalizeAbilityArray(value.customAbilities, 'custom'))
}

export function normalizeComposerAbilitySettingsPatch(
  value: unknown,
): NormalizedComposerAbilityPatch | InvalidComposerAbilityPatch {
  if (!isRecord(value)) {
    return { ok: false, error: 'composerAbilities must be an object' }
  }

  const patch: ComposerAbilitySettingsPatch = {}

  if (Object.prototype.hasOwnProperty.call(value, 'customAbilitiesEnabled')) {
    if (typeof value.customAbilitiesEnabled !== 'boolean') {
      return { ok: false, error: 'composerAbilities.customAbilitiesEnabled must be a boolean' }
    }
    patch.customAbilitiesEnabled = value.customAbilitiesEnabled
  }

  if (Object.prototype.hasOwnProperty.call(value, 'defaultAbilities')) {
    const normalized = normalizeAbilityArray(value.defaultAbilities, 'default')
    if ('error' in normalized) {
      return { ok: false, error: normalized.error }
    }
    patch.defaultAbilities = mergeDefaultAbilities(normalized.abilities)
  }

  if (Object.prototype.hasOwnProperty.call(value, 'customAbilities')) {
    const normalized = normalizeAbilityArray(value.customAbilities, 'custom')
    if ('error' in normalized) {
      return { ok: false, error: normalized.error }
    }
    patch.customAbilities = normalized.abilities
  }

  if (
    patch.customAbilitiesEnabled === undefined
    && patch.defaultAbilities === undefined
    && patch.customAbilities === undefined
  ) {
    return { ok: false, error: 'composerAbilities patch must include a supported composer ability field' }
  }

  return { ok: true, patch }
}

export function mergeComposerAbilitySettingsPatch(
  current: ComposerAbilitySettings,
  patch: ComposerAbilitySettingsPatch,
): ComposerAbilitySettings {
  return {
    defaultAbilities: patch.defaultAbilities
      ? mergeDefaultAbilities(patch.defaultAbilities)
      : current.defaultAbilities.map(cloneAbility),
    customAbilities: patch.customAbilities
      ? patch.customAbilities.map(cloneAbility)
      : current.customAbilities.map(cloneAbility),
    customAbilitiesEnabled: patch.customAbilitiesEnabled ?? current.customAbilitiesEnabled,
  }
}

export function resolveEnabledComposerAbilities(settings: ComposerAbilitySettings): ComposerAbility[] {
  return [
    ...settings.defaultAbilities
      .filter((ability) => ability.enabled)
      .map((ability) => ({ ...ability, source: 'default' as const })),
    ...settings.customAbilities
      .filter((ability) => ability.enabled)
      .map((ability) => ({ ...ability, source: 'custom' as const })),
  ]
}

export function applyComposerAbilitiesToText(
  text: string,
  abilities: readonly Pick<ComposerAbilityDefinition, 'label' | 'prompt'>[],
): string {
  const trimmedText = text.trim()
  if (abilities.length === 0) {
    return trimmedText
  }

  const abilityInstructions = abilities
    .map((ability) => `- ${ability.label}: ${ability.prompt}`)
    .join('\n')

  return [
    '[Composer abilities]',
    'Apply these prompt actions to the user message before responding:',
    abilityInstructions,
    '',
    '[User message]',
    trimmedText,
  ].join('\n')
}

export function createCustomComposerAbility(
  label: string,
  prompt: string,
  existingIds: readonly string[],
  now: () => number = Date.now,
): ComposerAbilityDefinition | null {
  const normalizedLabel = label.trim()
  const normalizedPrompt = prompt.trim()
  if (
    normalizedLabel.length === 0
    || normalizedLabel.length > MAX_ABILITY_LABEL_LENGTH
    || normalizedPrompt.length === 0
    || normalizedPrompt.length > MAX_ABILITY_PROMPT_LENGTH
  ) {
    return null
  }

  const slug = normalizedLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32) || 'custom'
  const reservedIds = new Set([...existingIds, ...RESERVED_ABILITY_IDS])
  let id = `custom-${slug}`
  let suffix = 1
  while (reservedIds.has(id)) {
    suffix += 1
    id = `custom-${slug}-${suffix}`
  }

  if (!COMPOSER_ABILITY_ID_PATTERN.test(id)) {
    id = `custom-${now().toString(36)}`
  }

  return {
    id,
    label: normalizedLabel,
    prompt: normalizedPrompt,
    enabled: true,
  }
}
