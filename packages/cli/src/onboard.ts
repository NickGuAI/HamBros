import {
  createHammurabiConfig,
  defaultConfigPath,
  type HammurabiAgent,
  writeHammurabiConfig,
} from './config.js'
import { buildClaudeCodeOtelEnv, mergeClaudeCodeEnv } from './claude-settings.js'
import { buildCodexOtelConfig, mergeCodexOtelConfig } from './codex-settings.js'
import { buildCursorOtelEnv, mergeCursorEnv } from './cursor-settings.js'
import {
  closePromptResources,
  promptMultiSelect,
  promptSecret,
  promptText,
} from './prompts.js'
import { validateTelemetryWriteKey } from './validate.js'

const DEFAULT_ENDPOINT = 'https://hammurabi.gehirn.ai'
const DEFAULT_AGENTS: readonly HammurabiAgent[] = [
  'claude-code',
  'codex',
  'terminal-cri',
]

interface AgentInstruction {
  id: HammurabiAgent
  label: string
  lines: readonly string[]
}

const AGENT_INSTRUCTIONS: readonly AgentInstruction[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    lines: [
      'Set standard OTEL env vars in ~/.claude/settings.json under env:',
      '  CLAUDE_CODE_ENABLE_TELEMETRY=1',
      '  OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>',
      '  OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
      '  OTEL_EXPORTER_OTLP_HEADERS=x-hammurabi-api-key=<KEY>',
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    lines: [
      'Set [otel] exporter in ~/.codex/config.toml:',
      '  [otel]',
      '  log_user_prompt = true',
      '  exporter = { otlp-http = { endpoint = "<endpoint>/v1/logs", protocol = "json", headers = { "x-hammurabi-api-key" = "<KEY>" } } }',
    ],
  },
  {
    id: 'terminal-cri',
    label: 'Terminal CRI',
    lines: ['Already integrated. Hammurabi agents read ~/.hammurabi.json directly; no extra setup is required.'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    lines: [
      'Set OTEL env vars in Cursor User settings.json under terminal.integrated.env:',
      '  OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>',
      '  OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
      '  OTEL_EXPORTER_OTLP_HEADERS=x-hammurabi-api-key=<KEY>',
    ],
  },
  {
    id: 'anti-gravity',
    label: 'Anti-Gravity',
    lines: [
      'Export standard OTEL env vars in your shell profile or Anti-Gravity config:',
      '  OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint>',
      '  OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
      '  OTEL_EXPORTER_OTLP_HEADERS=x-hammurabi-api-key=<KEY>',
    ],
  },
]

function printUsage(): void {
  process.stdout.write('Usage: hammurabi onboard\n')
}

function printSelectedAgentInstructions(
  endpoint: string,
  apiKey: string,
  agents: readonly HammurabiAgent[],
  autoConfigured: ReadonlySet<HammurabiAgent>,
): void {
  process.stdout.write('\nAgent setup instructions:\n')

  let hasManualAgents = false

  for (const selectedAgent of agents) {
    const instruction = AGENT_INSTRUCTIONS.find((candidate) => candidate.id === selectedAgent)
    if (!instruction) {
      continue
    }

    process.stdout.write(`\n[${instruction.label}]\n`)
    if (autoConfigured.has(selectedAgent)) {
      process.stdout.write('- Auto-configured.\n')
    } else {
      hasManualAgents = true
      for (const line of instruction.lines) {
        const formatted = line
          .replace('<endpoint>', endpoint)
          .replace('<KEY>', apiKey.slice(0, 8) + '...')
        process.stdout.write(`- ${formatted}\n`)
      }
    }
  }

  if (hasManualAgents) {
    process.stdout.write('\nOTEL environment variables:\n')
    process.stdout.write(`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}\n`)
    process.stdout.write('OTEL_EXPORTER_OTLP_PROTOCOL=http/json\n')
    process.stdout.write('OTEL_EXPORTER_OTLP_HEADERS=x-hammurabi-api-key=<your-api-key>\n')
  }
}

export async function runCli(args: readonly string[]): Promise<number> {
  try {
    const command = args[0]
    if (command && command !== 'onboard') {
      printUsage()
      return 1
    }

    process.stdout.write('Hammurabi onboard\n')
    process.stdout.write('Configure agents to send telemetry to your Hammurabi instance.\n\n')

    const endpoint = await promptText('Hammurabi endpoint', {
      defaultValue: DEFAULT_ENDPOINT,
      required: true,
    })
    const apiKey = await promptSecret('API key', { required: true })

    process.stdout.write('\nValidating API key via OTEL endpoint...\n')
    const validation = await validateTelemetryWriteKey({
      endpoint,
      apiKey,
    })

    if (!validation.ok) {
      process.stderr.write(`Validation failed: ${validation.message}\n`)
      if (validation.validationUrl) {
        process.stderr.write(`Validation URL: ${validation.validationUrl}\n`)
      }
      return 1
    }

    process.stdout.write('Validation successful.\n\n')

    const agents = await promptMultiSelect<HammurabiAgent>(
      'Select agents to connect:',
      AGENT_INSTRUCTIONS.map((instruction) => ({
        value: instruction.id,
        label: instruction.label,
      })),
      DEFAULT_AGENTS,
    )
    const config = createHammurabiConfig({
      endpoint,
      apiKey,
      agents,
    })

    await writeHammurabiConfig(config)

    const autoConfigured = new Set<HammurabiAgent>()

    if (config.agents.includes('claude-code')) {
      try {
        await mergeClaudeCodeEnv(buildClaudeCodeOtelEnv(config.endpoint, config.apiKey))
        autoConfigured.add('claude-code')
      } catch {
        // Non-fatal — user can still configure manually
      }
    }

    if (config.agents.includes('codex')) {
      try {
        await mergeCodexOtelConfig(buildCodexOtelConfig(config.endpoint, config.apiKey))
        autoConfigured.add('codex')
      } catch {
        // Non-fatal — user can still configure manually
      }
    }

    if (config.agents.includes('cursor')) {
      try {
        await mergeCursorEnv(buildCursorOtelEnv(config.endpoint, config.apiKey))
        autoConfigured.add('cursor')
      } catch {
        // Non-fatal — user can still configure manually
      }
    }

    process.stdout.write(`\nSaved config: ${defaultConfigPath()}\n`)
    printSelectedAgentInstructions(config.endpoint, config.apiKey, config.agents, autoConfigured)
    process.stdout.write('\nOnboarding complete.\n')

    return 0
  } finally {
    closePromptResources()
  }
}
