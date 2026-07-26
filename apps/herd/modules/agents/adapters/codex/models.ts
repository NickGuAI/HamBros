import type { ProviderModelOption } from '../../providers/provider-adapter.js'

export const DEFAULT_CODEX_MODEL_ID = 'gpt-5.5'

// Conservative registry fallback used only when app-server discovery is
// unavailable. A successful model/list response owns the model set and every
// per-model capability.
const CODEX_FALLBACK_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const

function fallbackModel(
  option: Omit<ProviderModelOption, 'supportsEffort' | 'supportedEffortLevels' | 'defaultEffort'>,
): ProviderModelOption {
  return {
    ...option,
    supportsEffort: true,
    supportedEffortLevels: [...CODEX_FALLBACK_EFFORT_LEVELS],
    defaultEffort: 'xhigh',
  }
}

export const availableModels = [
  fallbackModel({
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 SOL',
    description: 'Frontier Codex model with extended reasoning support.',
  }),
  fallbackModel({
    id: DEFAULT_CODEX_MODEL_ID,
    label: 'GPT-5.5',
    description: 'Frontier Codex model for complex coding and research.',
    default: true,
  }),
  fallbackModel({
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Strong general-purpose Codex model.',
  }),
  fallbackModel({
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'Fast lower-cost Codex model.',
  }),
  fallbackModel({
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    description: 'Coding-optimized Codex model.',
  }),
  fallbackModel({
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    description: 'Ultra-fast Codex model for quick iteration.',
  }),
] satisfies ProviderModelOption[]
