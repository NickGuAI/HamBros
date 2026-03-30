import type { AgentCallSettings, AgentEvent } from './types'

/**
 * Adapter for Claude Code CLI via @anthropic-ai/claude-agent-sdk.
 * Dynamically imports the SDK to avoid hard dependency.
 */
export async function* runClaude(
  prompt: string,
  settings: AgentCallSettings = {},
): AsyncGenerator<AgentEvent> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')

  const options: Record<string, unknown> = {
    ...(settings.model && { model: settings.model }),
    ...(settings.systemPrompt && { systemPrompt: settings.systemPrompt }),
    ...(settings.sessionId && { resume: settings.sessionId }),
    ...(settings.cwd && { cwd: settings.cwd }),
    ...(settings.maxTurns && { maxTurns: settings.maxTurns }),
    ...(settings.maxBudgetUsd && { maxBudgetUsd: settings.maxBudgetUsd }),
    ...(settings.tools && { allowedTools: settings.tools }),
    ...(settings.disallowedTools && { disallowedTools: settings.disallowedTools }),
    ...(settings.mcpServers && { mcpServers: settings.mcpServers }),
  }

  // Passive mode: bypass all permission checks
  if (settings.passive) {
    options.permissionMode = 'bypassPermissions'
    options.allowDangerouslySkipPermissions = true
  }

  const stream = sdk.query({ prompt, options })

  try {
    for await (const msg of stream) {
      const typed = msg as Record<string, unknown>

      // Session init
      if (typed.type === 'system' && typed.subtype === 'init') {
        yield {
          type: 'session',
          sessionId: typed.session_id as string,
          raw: msg,
        }
        continue
      }

      // Assistant message — extract text and tool_use blocks
      if (typed.type === 'assistant') {
        const message = typed.message as { content?: Array<Record<string, unknown>> } | undefined
        const content = message?.content
        if (content) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              yield { type: 'text', content: block.text as string, raw: msg }
            } else if (block.type === 'tool_use') {
              yield {
                type: 'tool_use',
                toolName: block.name as string,
                toolInput: block.input,
                raw: msg,
              }
            }
          }
        }
        continue
      }

      // Result — extract usage and cost
      if (typed.type === 'result') {
        const usage = typed.usage as Record<string, number> | undefined
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            costUsd: (typed.total_cost_usd as number) ?? 0,
          },
          raw: msg,
        }
        continue
      }
    }

    yield { type: 'done' }
  } catch (err) {
    yield { type: 'error', content: String(err) }
  }
}
