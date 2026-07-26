import {
  CADENCE_PRESET_TO_CRON,
  DEFAULT_NEW_AUTOMATION_CADENCE_PRESET,
  DEFAULT_NEW_AUTOMATION_TRIGGER,
  listSupportedAutomationProviders,
  NEW_AUTOMATION_CADENCE_PRESET_OPTIONS,
  NEW_AUTOMATION_TRIGGER_OPTIONS,
} from './constants.js'
import type { ProviderRegistryEntry } from '@/types'
import { isAutomationCronExpressionComplete } from '../../automations/cron-validation.js'
import type {
  NewAutomationCadencePreset,
  NewAutomationCommander,
  NewAutomationCreateRequestBody,
  NewAutomationOwner,
  NewAutomationWizardFormErrors,
  NewAutomationWizardFormValues,
  NewAutomationWizardStep,
  OrgFormOption,
} from './types.js'

function normalizeText(value: string): string {
  return value.trim()
}

function normalizeName(value: string): string {
  return normalizeText(value).toLocaleLowerCase()
}

function toOptionSet(options: ReadonlyArray<OrgFormOption>): Set<string> {
  return new Set(options.map((option) => option.value))
}

function commanderExists(commanders: ReadonlyArray<NewAutomationCommander>, commanderId: string): boolean {
  const trimmedCommanderId = normalizeText(commanderId)
  if (!trimmedCommanderId) {
    return false
  }
  return commanders.some((commander) => commander.id === trimmedCommanderId)
}

export function createEmptyNewAutomationWizardErrors(): NewAutomationWizardFormErrors {
  return {
    global: null,
    trigger: null,
    cron: null,
    name: null,
    instruction: null,
  }
}

export function createDefaultNewAutomationWizardValues(
  defaultQuestCommanderId = '',
  defaultAgentType = '',
): NewAutomationWizardFormValues {
  return {
    trigger: DEFAULT_NEW_AUTOMATION_TRIGGER,
    cadencePreset: DEFAULT_NEW_AUTOMATION_CADENCE_PRESET,
    customCron: '',
    questCommanderId: defaultQuestCommanderId,
    name: '',
    instruction: '',
    agentType: defaultAgentType,
  }
}

export function looksLikeCronExpression(expression: string): boolean {
  return isAutomationCronExpressionComplete(expression)
}

export function buildAutomationScheduleFromPreset(
  cadencePreset: NewAutomationCadencePreset,
  customCron: string,
): string | null {
  if (cadencePreset === 'custom') {
    const trimmedCron = normalizeText(customCron)
    return trimmedCron ? trimmedCron : null
  }

  return CADENCE_PRESET_TO_CRON[cadencePreset] ?? null
}

export function validateNewAutomationWizardStep(
  values: NewAutomationWizardFormValues,
  step: NewAutomationWizardStep,
  options: {
    existingAutomationNames: ReadonlyArray<string>
    commanders: ReadonlyArray<NewAutomationCommander>
    providers: readonly ProviderRegistryEntry[]
  },
): NewAutomationWizardFormErrors {
  const errors = createEmptyNewAutomationWizardErrors()
  const validTriggers = toOptionSet(NEW_AUTOMATION_TRIGGER_OPTIONS)
  const validCadencePresets = toOptionSet(NEW_AUTOMATION_CADENCE_PRESET_OPTIONS)
  const validAgentTypes = toOptionSet(listSupportedAutomationProviders(options.providers))

  if (!validTriggers.has(values.trigger)) {
    errors.trigger = 'Select a valid trigger.'
  }

  if (!validAgentTypes.has(values.agentType)) {
    errors.global = 'Agent type must be a supported provider.'
  }

  if (step === 'details' || step === 'review') {
    if (values.trigger === 'schedule') {
      if (!validCadencePresets.has(values.cadencePreset)) {
        errors.global = 'Cadence preset is invalid.'
      } else if (values.cadencePreset === 'custom') {
        const trimmedCron = normalizeText(values.customCron)
        if (!trimmedCron) {
          errors.cron = 'Cron expression is required.'
        } else if (!looksLikeCronExpression(trimmedCron)) {
          errors.cron = 'Cron expression must contain at least five fields.'
        }
      }
    }

    if (values.trigger === 'quest' && values.questCommanderId && !commanderExists(options.commanders, values.questCommanderId)) {
      errors.global = 'Selected commander is no longer available.'
    }

    const trimmedName = normalizeText(values.name)
    if (!trimmedName) {
      errors.name = 'Name is required.'
    } else if (
      options.existingAutomationNames.some(
        (existingName) => normalizeName(existingName) === normalizeName(trimmedName),
      )
    ) {
      errors.name = 'Name already exists for this owner.'
    }

    if (!normalizeText(values.instruction)) {
      errors.instruction = 'Instruction is required.'
    }
  }

  return errors
}

export function buildNewAutomationCreateRequestBody(
  values: NewAutomationWizardFormValues,
  options: {
    existingAutomationNames: ReadonlyArray<string>
    commanders: ReadonlyArray<NewAutomationCommander>
    owner: NewAutomationOwner
    providers: readonly ProviderRegistryEntry[]
  },
): NewAutomationCreateRequestBody | null {
  const errors = validateNewAutomationWizardStep(values, 'review', {
    existingAutomationNames: options.existingAutomationNames,
    commanders: options.commanders,
    providers: options.providers,
  })
  if (Object.values(errors).some((error) => error !== null)) {
    return null
  }

  const body: NewAutomationCreateRequestBody = {
    name: normalizeText(values.name),
    parentCommanderId: options.owner.kind === 'commander' ? options.owner.id : null,
    trigger: values.trigger,
    instruction: normalizeText(values.instruction),
    agentType: values.agentType,
    status: 'active',
  }

  if (values.trigger === 'schedule') {
    const schedule = buildAutomationScheduleFromPreset(values.cadencePreset, values.customCron)
    if (!schedule) {
      return null
    }
    body.schedule = schedule
  }

  if (values.trigger === 'quest') {
    body.questTrigger = {
      event: 'completed',
      ...(normalizeText(values.questCommanderId)
        ? { commanderId: normalizeText(values.questCommanderId) }
        : {}),
    }
  }

  return body
}
