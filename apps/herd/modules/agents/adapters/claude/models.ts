import type { ProviderModelOption } from '../../providers/provider-adapter.js'

export const availableModels = [
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    description: 'Most capable Claude model for demanding reasoning and long-horizon agentic work.',
    aliases: ['opus'],
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    description: 'Creative Claude model for nuanced reasoning and literary-quality generation.',
    aliases: ['fable'],
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    description: 'Previous-generation Opus model for complex coding work.',
    aliases: ['opus[1m]'],
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    description: 'Balanced Claude model for most commander and worker sessions.',
    default: true,
    aliases: ['sonnet'],
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    description: 'Pinned Opus 4.6 full model ID.',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    description: 'Fast Claude option for lighter tasks.',
    aliases: ['haiku'],
    supportsEffort: false,
    supportsAdaptiveThinking: false,
  },
] satisfies ProviderModelOption[]
