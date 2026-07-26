import { getChannelAdapter } from './registry.js'
import type { CommanderChannelBindingStore } from './store.js'
import { withCommanderRuntimeLaunch } from '../commanders/package-lifecycle-state.js'
import { resolveCommanderDataDir } from '../commanders/paths.js'
import type {
  ChannelRuntime,
  CommanderChannelBinding,
} from './types.js'

interface ManagedRuntime {
  binding: CommanderChannelBinding
  runtime: ChannelRuntime
}

export class ChannelAdapterRuntimeManager {
  private readonly bindingStore: CommanderChannelBindingStore
  private readonly commanderDataDir: string
  private readonly logger: Pick<Console, 'error' | 'warn'>
  private readonly runtimesByScope = new Map<string, ManagedRuntime>()

  constructor(options: {
    bindingStore: CommanderChannelBindingStore
    commanderDataDir?: string
    logger?: Pick<Console, 'error' | 'warn'>
  }) {
    this.bindingStore = options.bindingStore
    this.commanderDataDir = options.commanderDataDir ?? resolveCommanderDataDir()
    this.logger = options.logger ?? console
  }

  async startAll(): Promise<void> {
    const bindings = await this.bindingStore.list()
    for (const binding of bindings) {
      await this.syncBinding(binding)
    }
  }

  async syncBinding(binding: CommanderChannelBinding): Promise<void> {
    const scope = this.scopeForBinding(binding)
    if (!binding.enabled) {
      await this.replaceUnavailableBinding(binding)
      return
    }

    const adapter = getChannelAdapter(binding.provider)
    if (!adapter) {
      return
    }

    try {
      const existing = this.runtimesByScope.get(scope)
      if (existing && existing.binding.id !== binding.id) {
        return
      }
      if (existing) {
        await this.stopScope(scope)
      }
      const runtime = await withCommanderRuntimeLaunch(
        binding.commanderId,
        this.commanderDataDir,
        () => adapter.start(binding),
      )
      this.runtimesByScope.set(scope, { binding, runtime })
    } catch (error) {
      this.logger.warn(
        `[channels] Failed to start ${binding.provider} adapter for ${binding.accountId}:`,
        error,
      )
    }
  }

  async deleteBinding(binding: CommanderChannelBinding | null): Promise<void> {
    if (!binding) {
      return
    }
    await this.replaceUnavailableBinding(binding)
  }

  private async replaceUnavailableBinding(binding: CommanderChannelBinding): Promise<void> {
    const scope = this.scopeForBinding(binding)
    const existing = this.runtimesByScope.get(scope)
    if (existing && existing.binding.id !== binding.id) {
      return
    }
    if (existing) {
      await this.stopScope(scope)
    }
    const replacement = (await this.bindingStore.list()).find((candidate) => (
      candidate.id !== binding.id
      && candidate.enabled
      && this.scopeForBinding(candidate) === scope
    ))
    if (replacement) {
      await this.syncBinding(replacement)
    }
  }

  async shutdown(): Promise<void> {
    const scopes = [...this.runtimesByScope.keys()]
    await Promise.all(scopes.map((scope) => this.stopScope(scope)))
  }

  private async stopScope(scope: string): Promise<void> {
    const managed = this.runtimesByScope.get(scope)
    if (!managed) {
      return
    }
    this.runtimesByScope.delete(scope)
    const adapter = getChannelAdapter(managed.binding.provider)
    if (!adapter) {
      return
    }
    await adapter.stop(managed.runtime).catch((error) => {
      this.logger.error(
        `[channels] Failed to stop ${managed.binding.provider} adapter for ${managed.binding.accountId}:`,
        error,
      )
    })
  }

  private scopeForBinding(binding: CommanderChannelBinding): string {
    return `${binding.provider}:${binding.accountId}`
  }
}
