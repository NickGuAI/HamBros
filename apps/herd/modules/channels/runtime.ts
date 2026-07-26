import { createCommanderChannelsRouter } from './route.js'
import { EmailChannelAdapter } from './email/adapter.js'
import { DiscordChannelAdapter } from './discord/adapter.js'
import { GoogleChatChannelAdapter } from './googlechat/adapter.js'
import { SlackChannelAdapter } from './slack/adapter.js'
import { TelegramChannelAdapter } from './telegram/adapter.js'
import { WhatsAppChannelAdapter } from './whatsapp/adapter.js'
import { replaceChannelAdapter } from './registry.js'
import { ChannelAdapterRuntimeManager } from './runtime-manager.js'
import { CommanderChannelBindingStore } from './store.js'
import { CommanderSecretsStore } from '../commanders/secrets-store.js'
import type {
  ModuleRouteRegistration,
  ModuleRuntimeContext,
} from '../../server/module-runtime.js'

export function createChannelsFoundation(context: ModuleRuntimeContext): null {
  context.capabilities.provide('channels.bindings', 'channels', new CommanderChannelBindingStore())
  return null
}

export function createChannelsRuntime(context: ModuleRuntimeContext): ModuleRouteRegistration {
  const { capabilities, internalToken, options } = context
  const bindingStore = capabilities.consume('channels.bindings', 'channels')
  const commanderDataDir = capabilities.consume('commanders.data-dir', 'channels')
  const secretsStore = new CommanderSecretsStore({ dataDir: commanderDataDir })
  replaceChannelAdapter(new EmailChannelAdapter({
    bindingStore,
    secretsStore,
    internalToken,
    dataDir: commanderDataDir,
  }))
  replaceChannelAdapter(new WhatsAppChannelAdapter({
    bindingStore,
    internalToken,
    dataDir: commanderDataDir,
  }))
  replaceChannelAdapter(new GoogleChatChannelAdapter({
    bindingStore,
    secretsStore,
    internalToken,
    dataDir: commanderDataDir,
  }))
  replaceChannelAdapter(new TelegramChannelAdapter({
    bindingStore,
    secretsStore,
    internalToken,
  }))
  replaceChannelAdapter(new DiscordChannelAdapter({
    bindingStore,
    secretsStore,
    internalToken,
  }))
  replaceChannelAdapter(new SlackChannelAdapter({
    bindingStore,
    secretsStore,
    internalToken,
  }))
  const runtimeManager = new ChannelAdapterRuntimeManager({ bindingStore, commanderDataDir })
  const channels = createCommanderChannelsRouter({
    store: bindingStore,
    apiKeyStore: options.apiKeyStore,
    auth0Domain: options.auth0Domain,
    auth0Audience: options.auth0Audience,
    auth0ClientId: options.auth0ClientId,
    internalToken,
    sessionStore: capabilities.consume('commanders.store', 'channels'),
    secretsStore,
    dataDir: commanderDataDir,
    onBindingCreated: (binding) => runtimeManager.syncBinding(binding),
    onBindingUpdated: (binding) => runtimeManager.syncBinding(binding),
    onBindingDeleted: (binding) => runtimeManager.deleteBinding(binding),
  })

  capabilities.provide('channels.ingest', 'channels', channels)
  if (options.initializeChannelRuntimes !== false) {
    void runtimeManager.startAll().catch((error) => {
      console.error('[channels] Failed to start channel runtimes:', error)
    })
  }

  return {
    name: 'channels',
    routeIds: ['channels.api'],
    router: channels,
    shutdown: () => runtimeManager.shutdown(),
  }
}
