import type { AgentCallSettings, AgentEvent } from './types'

/**
 * Adapter for OpenAI Codex CLI via @openai/codex-sdk.
 * Dynamically imports the SDK to avoid hard dependency.
 */
export async function* runCodex(
  prompt: string,
  settings: AgentCallSettings = {},
): AsyncGenerator<AgentEvent> {
  const sdk = await import('@openai/codex-sdk')

  // Build thread options (model, approval policy, sandbox mode)
  const threadOptions: Record<string, unknown> = {
    ...(settings.model && { model: settings.model }),
  }

  // Passive mode: full automation, no approval prompts
  if (settings.passive) {
    threadOptions.approvalPolicy = 'never'
    threadOptions.sandboxMode = 'workspace-write'
  }

  const codex = new sdk.Codex()
  const thread = settings.sessionId
    ? codex.resumeThread(settings.sessionId, threadOptions as Parameters<typeof codex.resumeThread>[1])
    : codex.startThread(threadOptions as Parameters<typeof codex.startThread>[0])

  const runOptions: Record<string, unknown> = {}
  if (settings.cwd) {
    runOptions.workingDirectory = settings.cwd
  }

  try {
    const { events } = await thread.runStreamed(prompt, runOptions)

    // Emit thread ID as session
    yield { type: 'session', sessionId: thread.id ?? undefined }

    for await (const event of events) {
      const typed = event as Record<string, unknown>

      if (typed.type === 'item.completed') {
        const item = typed.item as Record<string, unknown> | undefined
        if (!item) continue

        if (item.type === 'agent_message') {
          yield {
            type: 'text',
            content: (item.text ?? item.content ?? '') as string,
            raw: event,
          }
        } else if (item.type === 'command' || item.type === 'mcp_tool_call') {
          yield {
            type: 'tool_use',
            toolName: (item.name ?? item.command ?? 'command') as string,
            toolInput: item.args ?? item.input,
            raw: event,
          }
          if (item.output !== undefined) {
            yield {
              type: 'tool_result',
              toolOutput: String(item.output),
              raw: event,
            }
          }
        } else if (item.type === 'file_change') {
          yield {
            type: 'tool_use',
            toolName: 'file_change',
            toolInput: { path: item.path, action: item.action },
            raw: event,
          }
        }
        continue
      }

      if (typed.type === 'turn.completed') {
        const usage = typed.usage as Record<string, number> | undefined
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage?.input_tokens ?? usage?.inputTokens ?? 0,
            outputTokens: usage?.output_tokens ?? usage?.outputTokens ?? 0,
            costUsd: usage?.total_cost_usd ?? usage?.costUsd ?? 0,
          },
          raw: event,
        }
        continue
      }

      if (typed.type === 'turn.failed') {
        yield {
          type: 'error',
          content: (typed.error as string) ?? 'Codex turn failed',
          raw: event,
        }
        continue
      }
    }

    yield { type: 'done' }
  } catch (err) {
    yield { type: 'error', content: String(err) }
  }
}
