import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { HERD_MODULE_GRAPH } from '../src/module-manifest.ts'
import { HERD_MODULE_MANIFESTS } from '../server/module-manifest.ts'
import { API_KEY_SCOPES } from '../server/api-keys/store.ts'

const devDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(devDir, '..')
const repoRoot = resolve(projectRoot, '../..')
const sourceRef = process.env.HANDOFF_SOURCE_REF?.trim() || 'HEAD'
const handoff = readFileSync(resolve(devDir, 'NEW_FRONTEND_HANDOFF.md'), 'utf8')
const routesDoc = readFileSync(resolve(projectRoot, 'docs/architecture/routes-and-apis.md'), 'utf8')
const missing: string[] = []

function requireText(group: string, value: string): void {
  if (!handoff.includes(value)) {
    missing.push(`${group}: ${value}`)
  }
}

for (const module of HERD_MODULE_GRAPH) {
  requireText('module', `| \`${module.id}\``)
  for (const route of module.ui.routes) {
    requireText('frontend route row', `| \`${route.path}\` |`)
  }
  for (const redirect of module.ui.redirects ?? []) {
    const targetRoute = HERD_MODULE_GRAPH
      .flatMap((entry) => entry.ui.routes)
      .find((route) => route.id === redirect.toRouteId)
    const target = redirect.toPath ?? targetRoute?.path
    requireText(
      'frontend redirect contract',
      target ? `\`${redirect.from}\` -> \`${target}\`` : `\`${redirect.from}\``,
    )
  }
}

for (const manifest of HERD_MODULE_MANIFESTS) {
  const moduleRow = handoff
    .split('\n')
    .find((line) => line.startsWith(`| \`${manifest.graph.id}\``))
  const storage = manifest.server.storage
  if (!moduleRow?.includes(`\`${storage.kind}\``)) {
    missing.push(
      `storage mode: ${manifest.graph.id} -> ${storage.kind}`,
    )
  }
  if (!moduleRow?.includes(`ownerModuleId: \`${storage.ownerModuleId}\``)) {
    missing.push(`storage owner: ${manifest.graph.id} -> ${storage.ownerModuleId}`)
  }
  for (const key of storage.keys ?? []) {
    if (!moduleRow?.includes(`\`${key}\``)) {
      missing.push(`storage key: ${manifest.graph.id} -> ${key}`)
    }
  }
  for (const sharedModule of storage.sharedWith ?? []) {
    if (!moduleRow?.includes(`\`${sharedModule}\``)) {
      missing.push(`storage sharing: ${manifest.graph.id} -> ${sharedModule}`)
    }
  }
  for (const websocket of manifest.server.websockets) {
    requireText('websocket', websocket.path)
  }
}

for (const scope of API_KEY_SCOPES) {
  requireText('API-key scope', `\`${scope}\``)
}

const criticalAuthRows = [
  ['AUTH-COMBINED', 'server/middleware/combined-auth.ts'],
  ['AUTH-PUBLIC-AVATAR', 'modules/operators/routes.ts'],
  ['AUTH-OAUTH-CALLBACK', 'modules/agents/routes/provider-auth-routes.ts'],
  ['AUTH-SKILLS-ANY-OF', 'modules/skills/routes.ts'],
  ['AUTH-MOBILE-PAIRING', 'server/routes/api-keys.ts'],
  ['AUTH-MACHINE-TOKENS', 'modules/agents/routes/machine-world-routes.ts'],
  ['AUTH-GOOGLE-CHAT', 'modules/channels/googlechat/auth.ts'],
  ['AUTH-INTERNAL-CHANNEL', 'modules/commanders/routes/context.ts'],
  ['AUTH-APPROVAL-BRIDGE', 'modules/policies/approval-bridge-token.ts'],
  ['AUTH-ONE-TIME-TICKET', 'server/auth/transport-tickets.ts'],
] as const
for (const [id, evidence] of criticalAuthRows) {
  const row = handoff
    .split('\n')
    .find((line) => line.startsWith(`| \`${id}\` |`))
  const contract = row?.split('|')[2]?.trim() ?? ''
  if (!row || !row.includes(`\`${evidence}\``) || contract.length < 45) {
    missing.push(`critical auth row: ${id} with ${evidence}`)
  }
}

const currentStateTable = routesDoc
  .slice(routesDoc.indexOf('## Current State'), routesDoc.indexOf('## Websocket Roots'))
const documentedTableRoots = currentStateTable
  .split('\n')
  .filter((line) => line.startsWith('| `/'))
  .flatMap((line) => {
    const firstCell = line.split('|')[1] ?? ''
    return [...firstCell.matchAll(/`(\/[^`]+)`/g)].map((match) => match[1])
  })
const publicRoots = ['/api/health', '/install.sh', ...documentedTableRoots]
for (const publicRoot of publicRoots) {
  const checklistStart = handoff.indexOf('### Public Root Checklist')
  const checklistFenceStart = handoff.indexOf('```text', checklistStart)
  const checklistFenceEnd = handoff.indexOf('```', checklistFenceStart + 7)
  const checklistTokens = new Set(
    handoff
      .slice(checklistFenceStart + 7, checklistFenceEnd)
      .split(/\s+/)
      .filter(Boolean),
  )
  if (!checklistTokens.has(publicRoot)) {
    missing.push(`documented public root: ${publicRoot}`)
  }
}

const criticalQolRows = [
  ['QOL-AUTH-RECOVERY', 'src/App.tsx'],
  ['QOL-NATIVE-PAIRING', 'src/components/ApiKeyLandingPage.tsx'],
  ['QOL-BOOTSTRAP-ROTATION', 'src/app/BootstrapKeyRotationPrompt.tsx'],
  ['QOL-NEW-SESSION', 'modules/agents/components/NewSessionForm.tsx'],
  ['QOL-CONVERSATION-CONFIRM', 'modules/conversation/components/CreateConversationPanel.tsx'],
  ['QOL-CREDENTIAL-SELECT', 'modules/conversation/components/CredentialPoolSelect.tsx'],
  ['QOL-SESSION-DRAFT', 'modules/agents/page-shell/use-session-draft.ts'],
  ['QOL-OPTIMISTIC-SEND', 'clientSendId'],
  ['QOL-DEEP-LINK-RACE', 'modules/command-room/components/CommandRoom.tsx'],
  ['QOL-MOBILE-LIFECYCLE', 'modules/agents/page-shell/MobileSessionShell.tsx'],
  ['QOL-COMPOSER-CONTEXT', 'src/hooks/use-composer-abilities.ts'],
  ['QOL-QUEUE-RECOVERY', 'modules/agents/queue-state.ts'],
  ['QOL-QUEST-DRAFT', 'modules/commanders/components/QuestBoard.tsx'],
  ['QOL-COMMANDER-IDENTITY', 'modules/commanders/components/CommanderIdentityTab.tsx'],
  ['QOL-ONBOARDING-RECOVERY', 'src/app/AuthenticatedAppRouter.tsx'],
  ['QOL-GAIA-SETUP', 'modules/commanders/components/WizardChatPanel.tsx'],
  ['QOL-WORKSPACE', 'modules/workspace/components/WorkspacePanel.tsx'],
  ['QOL-EVAL-FILTERS', 'modules/eval/page.tsx'],
  ['QOL-RPG', 'modules/rpg/RpgScene.tsx'],
  ['QOL-ACCESSIBILITY', 'src/components/DismissibleOverlay.tsx'],
] as const

for (const [id, evidence] of criticalQolRows) {
  const row = handoff
    .split('\n')
    .find((line) => line.startsWith(`| \`${id}\` |`))
  const invariant = row?.split('|')[2]?.trim() ?? ''
  if (!row || !row.includes(`\`${evidence}\``) || invariant.length < 50) {
    missing.push(`critical QoL row: ${id} with ${evidence}`)
  }
}

const rpgInvariantRow = handoff
  .split('\n')
  .find((line) => line.startsWith('| `QOL-RPG` |'))
for (const evidence of [
  'modules/rpg/RpgScene.tsx',
  'modules/rpg/PlayerSprite.tsx',
  'modules/rpg/use-session-ws.tsx',
]) {
  if (!rpgInvariantRow?.includes(`\`${evidence}\``)) {
    missing.push(`QOL-RPG evidence: ${evidence}`)
  }
}

const localCitations = [...new Set(
  [...handoff.matchAll(/`((?:src|server|modules|docs|ios)\/[^`]+)`/g)]
    .map((match) => match[1])
    .filter((citation) => !citation.includes('*') && !citation.includes(':') && !citation.includes('|')),
)]
for (const citation of localCitations) {
  if (!existsSync(resolve(projectRoot, citation))) {
    missing.push(`missing cited source: ${citation}`)
  }
}

for (const providerContract of ['supportedEffortLevels', 'gpt-5.6-sol', 'xhigh']) {
  requireText('provider/model contract', `\`${providerContract}\``)
}

function readSourceAtRef(relativePath: string): string | null {
  try {
    return execFileSync(
      'git',
      ['-C', repoRoot, 'show', `${sourceRef}:apps/herd/${relativePath}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch {
    missing.push(`audited source unavailable: ${sourceRef}:${relativePath}`)
    return null
  }
}

const codexModelsSource = readSourceAtRef('modules/agents/adapters/codex/models.ts')
const effortSource = readSourceAtRef('modules/agents/effort.ts')
const providerSourceChecks = [
  ['Codex catalogue includes GPT-5.6 SOL', codexModelsSource?.includes("id: 'gpt-5.6-sol'")],
  ['Codex model effort is low through xhigh', codexModelsSource?.includes("['low', 'medium', 'high', 'xhigh']")],
  ['model default effort is xhigh', codexModelsSource?.includes("defaultEffort: 'xhigh'")],
  ['provider effort type is low through xhigh', effortSource?.includes("['low', 'medium', 'high', 'xhigh']")],
  [
    'legacy max and ultra efforts normalize to xhigh',
    effortSource?.includes("max: 'xhigh'") && effortSource.includes("ultra: 'xhigh'"),
  ],
] as const
for (const [label, present] of providerSourceChecks) {
  if (!present) {
    missing.push(`provider/model source at ${sourceRef}: ${label}`)
  }
}

let sourceSha = sourceRef
try {
  sourceSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', sourceRef], {
    encoding: 'utf8',
  }).trim()
} catch {
  missing.push(`audited source ref unavailable: ${sourceRef}`)
}

if (missing.length > 0) {
  console.error('New frontend handoff is structurally incomplete:')
  for (const item of missing) {
    console.error(`- ${item}`)
  }
  process.exitCode = 1
} else {
  console.log(
    `Handoff structural coverage passed against ${sourceRef}@${sourceSha}: `
      + `${HERD_MODULE_GRAPH.length} modules, `
      + `${publicRoots.length} documented roots, ${API_KEY_SCOPES.length} scopes, `
      + `${criticalAuthRows.length} auth boundaries, `
      + `${criticalQolRows.length} critical QoL invariants, `
      + `${localCitations.length} source citations.`,
  )
}
