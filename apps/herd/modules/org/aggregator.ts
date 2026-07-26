import { aggregateCommanderWorldAgentSource } from '../agents/session/state.js'
import type { Automation } from '../automations/types.js'
import {
  DEFAULT_COMMANDER_AVATAR_URL,
  GAIA_COMMANDER_AVATAR_URL,
} from '../commanders/commander-profile.js'
import { FOUNDER_OPERATOR_NOT_FOUND_ERROR } from '../operators/constants.js'
import type { Operator } from '../operators/types.js'
import type {
  OrgChannelsByProvider,
  OrgNode,
  OrgNodeProfile,
  OrgQuestsInFlight,
  OrgTree,
} from './types.js'

const CHANNEL_SURFACES = new Set(['whatsapp', 'telegram', 'discord'])
const ACTIVE_UI_CHAT_SURFACES = new Set(['ui', 'cli', 'api'])

function zeroChannels(): OrgChannelsByProvider {
  return {
    whatsapp: 0,
    telegram: 0,
    discord: 0,
  }
}

function zeroQuestsInFlight(): OrgQuestsInFlight {
  return {
    active: 0,
    pending: 0,
  }
}

export interface OrgCommanderRecord {
  id: string
  displayName: string
  operatorId: string
  state: string
  created: string
  templateId?: string | null
  replicatedFromCommanderId?: string | null
  activeWorkers?: number
  system?: boolean
  archived?: boolean
  archivedAt?: string
}

export interface OrgConversationRecord {
  surface?: string
  status?: string
  currentTask?: { issueUrl?: string | null } | null
  totalCostUsd?: number
  lastHeartbeat?: string | null
  lastMessageAt?: string
  createdAt?: string
}

export interface OrgQuestRecord {
  status: string
}

export interface BuildOrgTreeDependencies {
  operatorStore: {
    getFounder(): Promise<Operator | null>
  }
  commanderSessionStore: {
    list(): Promise<ReadonlyArray<OrgCommanderRecord>>
  }
  automationStore: {
    list(): Promise<ReadonlyArray<Automation>>
  }
  conversationStore: {
    listByCommander(commanderId: string): Promise<ReadonlyArray<OrgConversationRecord>>
  }
  questStore: {
    list(commanderId: string): Promise<ReadonlyArray<OrgQuestRecord>>
  }
  profileStore: {
    getAvatarUrl(commanderId: string): Promise<string | null>
    getProfile(commanderId: string): Promise<OrgNodeProfile | null>
  }
}

export class OrgOperatorNotFoundError extends Error {
  constructor() {
    super(FOUNDER_OPERATOR_NOT_FOUND_ERROR)
    this.name = 'OrgOperatorNotFoundError'
  }
}

function countChannels(conversations: ReadonlyArray<OrgConversationRecord>): OrgChannelsByProvider {
  return conversations.reduce<OrgChannelsByProvider>((channels, conversation) => {
    if (!conversation.surface || !CHANNEL_SURFACES.has(conversation.surface)) {
      return channels
    }

    channels[conversation.surface as keyof OrgChannelsByProvider] += 1
    return channels
  }, zeroChannels())
}

function countActiveUiChats(conversations: ReadonlyArray<OrgConversationRecord>): number {
  return conversations.filter((conversation) => (
    typeof conversation.surface === 'string'
      && ACTIVE_UI_CHAT_SURFACES.has(conversation.surface)
      && conversation.status === 'active'
  )).length
}

function countQuestsInFlight(quests: ReadonlyArray<OrgQuestRecord>): OrgQuestsInFlight {
  return quests.reduce<OrgQuestsInFlight>((summary, quest) => {
    if (quest.status === 'active') {
      summary.active += 1
    }
    if (quest.status === 'pending') {
      summary.pending += 1
    }
    return summary
  }, zeroQuestsInFlight())
}

function toAutomationNode(automation: Automation): OrgNode {
  return {
    id: automation.id,
    kind: 'automation',
    parentId: automation.parentCommanderId ?? automation.operatorId,
    displayName: automation.name,
    status: automation.status,
    costUsd: 0,
    recentActivityAt: null,
    templateId: automation.templateId ?? null,
    trigger: automation.trigger,
  }
}

function compareCommanderNodes(left: OrgNode, right: OrgNode): number {
  if (left.system === true && right.system !== true) {
    return -1
  }
  if (left.system !== true && right.system === true) {
    return 1
  }
  return 0
}

export async function buildOrgTree({
  operatorStore,
  commanderSessionStore,
  automationStore,
  conversationStore,
  questStore,
  profileStore,
}: BuildOrgTreeDependencies): Promise<OrgTree> {
  const operator = await operatorStore.getFounder()
  if (!operator) {
    throw new OrgOperatorNotFoundError()
  }

  const [commanders, automations] = await Promise.all([
    commanderSessionStore.list(),
    automationStore.list().catch(() => {
      console.error('[org] Automation projection unavailable; returning org without automation data.')
      return []
    }),
  ])

  const commanderNodes = await Promise.all(commanders.map(async (commander) => {
    let conversations: ReadonlyArray<OrgConversationRecord> = []
    try {
      conversations = await conversationStore.listByCommander(commander.id)
    } catch {
      conversations = []
    }

    const [quests, rawAvatarUrl, profile] = await Promise.all([
      questStore.list(commander.id),
      profileStore.getAvatarUrl(commander.id),
      profileStore.getProfile(commander.id),
    ])
    const avatarUrl = commander.templateId === 'gaia-onboarding'
      && rawAvatarUrl === DEFAULT_COMMANDER_AVATAR_URL
      ? GAIA_COMMANDER_AVATAR_URL
      : rawAvatarUrl

    const worldAgentSource = aggregateCommanderWorldAgentSource(conversations)
    const questsInFlight = countQuestsInFlight(quests)
    const activeUiChats = countActiveUiChats(conversations)
    return {
      id: commander.id,
      kind: 'commander',
      parentId: commander.operatorId,
      displayName: commander.displayName,
      avatarUrl,
      profile,
      status: commander.state,
      costUsd: worldAgentSource.totalCostUsd ?? 0,
      recentActivityAt: worldAgentSource.lastUpdatedAt ?? null,
      questsInFlight,
      channels: countChannels(conversations),
      activeUiChats,
      counts: {
        activeQuests: questsInFlight.active,
        activeWorkers: commander.activeWorkers ?? 0,
        activeChats: activeUiChats,
      },
      archived: commander.archived === true,
      archivedAt: commander.archivedAt,
      ...(commander.system === true ? { system: true } : {}),
      templateId: commander.templateId ?? null,
      replicatedFromCommanderId: commander.replicatedFromCommanderId ?? null,
    } satisfies OrgNode
  }))

  return {
    operator,
    orgIdentity: null,
    archivedCommandersCount: 0,
    commanders: commanderNodes.sort(compareCommanderNodes),
    automations: automations.map((automation) => toAutomationNode(automation)),
  }
}
