# New Frontend Integration Package: Existing Herd Backend

## Task

Implement Nick's completed, owner-supplied UI design as a new Herd
frontend while reusing the existing backend, module boundaries, API contracts,
realtime protocols, persistence authorities, and permission model. The agent's
job is frontend integration: connect the supplied components and interactions
to the right existing hooks, functions, modules, routes, events and state.

Nick owns the design. This package does not ask the implementation agent to
design, critique, reinterpret or extend the Figma file. It explains what each
part of the supplied UI must connect to so the delivered behavior is a superset
of the current frontend. If the supplied design has no representation for a
required behavior or state, report the exact integration gap to Nick instead of
silently dropping the behavior or independently redesigning the product.

## Success Criteria

The replacement is complete only when all of these are true:

- every current route, embedded feature, backend capability family, action,
  permission boundary, websocket, and persistence owner is represented;
- the implementation is visually faithful to Nick's supplied design without
  substituting the current frontend's visual system or inventing a new one;
- every current desktop/mobile workflow and quality-of-life behavior below is
  preserved or deliberately improved;
- choices such as providers, models, effort levels, channel fields, modules,
  allowed actions, and disabled reasons come from backend metadata rather than
  duplicated frontend enums;
- conversation, session, queue, approval, workspace, and provider lifecycles
  render backend-owned state without inference from labels, sockets, or names;
- loading, empty, reconnecting, stale, disabled, partial, success, error, retry,
  confirmation, and destructive-action states exist for every relevant flow;
- desktop, responsive mobile web, and the Capacitor iOS wrapper retain access
  to the same underlying capabilities, even where composition differs;
- existing focused tests pass, new UI tests cover the new components, and the
  route/workflow acceptance matrix is proven on desktop and mobile;
- the final parity ledger has no unexplained `missing` or `partial` rows.

## Source Authority And Known Drift

Read sources in this order:

1. `src/module-manifest.ts`, `server/module-manifest.ts`, module-owned routes,
   contracts, hooks, components, and tests;
2. `docs/architecture/*.md` and `docs/features/*.md`;
3. `docs/architecture/indexes/*.xml` as discovery aids only;
4. this `.dev` context as a routing and verification aid only.

Do not copy the generated indexes blindly. At the time of this audit:

- live source routes Settings at `/settings` and redirects legacy `/api-keys`,
  while the generated route index still lists `/api-keys`;
- `/marketplace` and hidden `/eval` exist in `src/module-manifest.ts` but are
  missing from the generated feature index;
- mobile shell chrome is `MobileNavigationDrawer.tsx`; generated docs still
  reference deleted `MobileBottomTabs.tsx`;
- the generated queue feature references deleted `queue-capability.ts` and its
  deleted test;
- live source exposes the `/skills` management UI and package operations even
  though a generated observation calls skills discovery-only.

Run `pnpm --filter herd run docs:check`, but do not treat it as proof that
these generated paths or frontend route descriptions are current.

Audit baseline on 2026-07-18: the local dirty checkout was `1d16b9597`, while
freshly fetched `origin/dev` was `d3ca37819`. The five intervening Herd
commits all change provider/model/effort contracts. This package incorporates
the current remote contract described below, but an implementation agent must
first synchronize to the then-current `dev` head and repeat the manifest and
source audit. Do not implement from the stale local provider files.

## Architecture Contract

```text
╔══════════════════════════════════════════════════════════════════════╗
║ Nick's supplied presentation                                      ║
║ routes · responsive shells · feature views · interaction states    ║
╚═══════════════════════════════╤══════════════════════════════════════╝
                                │ module-owned hooks/contracts
                                ▼
╔══════════════════════════════════════════════════════════════════════╗
║ Existing frontend integration layer                                ║
║ auth fetch · React Query caches · bootstrap · websocket processors  ║
╚═══════════════════════════════╤══════════════════════════════════════╝
                                │ authenticated HTTP + ticketed WS
                                ▼
╔══════════════════════════════════════════════════════════════════════╗
║ Existing Express module runtime                                    ║
║ agents · commanders · conversations · workspace · policies · etc.  ║
╚═══════════════════════════════╤══════════════════════════════════════╝
                                │ owner-specific stores/adapters
                                ▼
╔══════════════════════════════════════════════════════════════════════╗
║ Authoritative state                                                ║
║ SQLite/runtime DTOs · commander files · module stores · providers  ║
╚══════════════════════════════════════════════════════════════════════╝
```

Non-negotiable boundaries:

- `src/surfaces/desktop/**` and `src/surfaces/mobile/**` own chrome and layout
  only. Feature pages and API clients remain module-owned. The mechanical guard
  is `src/surfaces/__tests__/surface-invariants.test.ts`.
- bootstrap navigation from `/api/modules`; bind backend graph metadata through
  `src/module-graph-bindings.ts` rather than hardcoding an independent app map;
- use module hooks/services instead of direct backend calls from shell code;
- keep Command Room a composition surface, not a storage owner;
- use backend `state`, `allowedActions`, `disabledReasons`, capabilities, and
  sendability projections as the UI contract;
- use authenticated HTTP-minted one-time tickets for browser websocket and raw
  file URLs. Never put long-lived API keys or Auth0 tokens in query strings;
- keep DTOs serializable. Never expose or retain processes, sockets, queues,
  timers, provider adapters, secrets, or raw stores in browser state.

## Current Route And Reachability Ledger

Live `src/module-manifest.ts` is authoritative for paths and visibility.

| Route | Surface | Required behavior |
|---|---|---|
| `/welcome` | desktop/mobile, hidden | Mandatory founder/org, Gaia, and starter-workforce onboarding gate. |
| `/org` | desktop/mobile | Founder/org identity, commander organization, hire/edit/archive/restore/replicate/export. |
| `/command-room` | desktop/mobile | Primary commander/conversation operating surface and embedded workflows. |
| `/automations` | desktop/mobile | Automation creation, filters, lifecycle, runs, history, memory, reports. |
| `/marketplace` | desktop/mobile route; desktop nav | Commander packages, details, import, install/hire/open. |
| `/settings` | desktop/mobile route; desktop nav | API keys, provider/service credentials, pairing, account/settings controls. |
| `/command-room/settings` | mobile | Mobile settings, machines, providers, credentials, preferences, profile. |
| `/approvals` | desktop | Pending approvals, decision UI, history and previews. |
| `/command-room/inbox` | mobile | Approval inbox with all/high-risk filtering. |
| `/policies` | desktop/mobile | Scoped action policies and settings. |
| `/channels` | desktop | Descriptor-driven channel setup, pairing, status, configuration, deletion. |
| `/skills` | desktop | Skill discovery, detail, run/schedule/edit/export/create/delete. |
| `/telemetry` | desktop | Cost/token summaries, charts, sessions and call drill-down. |
| `/eval` | desktop, hidden | Internal eval doctor, run/status/report and gated submit workflow. |
| `/rpg` | desktop, hidden | URL-backed Overworld/Party/Quests visualization and control surface over world state, commanders, sessions and quests. |

Preserve legacy redirects `/api-keys` -> `/settings` and
`/command-room/automations` -> `/automations` unless product explicitly retires
them. Preserve unknown-route fallback and the default `/command-room` route.

### Complete Module And Persistence Census

This is the completeness spine for the replacement. Every live manifest module
must have an explicit hookup even when it has no standalone route. `Status` and
`UI` come from `src/module-manifest.ts`; storage mode, keys and sharing come from
`server/module-manifest.ts`. A `none` store means the UI composes another
module's authoritative state; it does not authorize a new frontend store.

| Module | Status / UI reachability | Exact manifest storage contract that must remain intact |
|---|---|---|
| `agents` | public, embedded in Command Room on desktop/mobile | `owned`; ownerModuleId: `agents`; keys: `agent_runtime_sessions`, `agents.machines`, `agents.transcripts`; SQLite plus machine/enrollment/transcript roots |
| `api-keys` | public route `/settings` on desktop/mobile | `owned`; ownerModuleId: `api-keys`; keys: `api-keys.keys`, `api-keys.provider-secrets` |
| `approvals` | public routes `/approvals`, `/command-room/inbox` | `shared`; ownerModuleId: `approvals`; keys: `approvals.pending`, `approvals.audit`; sharedWith: `policies`; implemented by the policies pending/audit store today |
| `automations` | public route `/automations` on desktop/mobile | `owned`; ownerModuleId: `automations`; keys: `automations.definitions`, `automations.runs`, `automations.memory` |
| `channels` | experimental route `/channels`; channel summaries also appear in org/commander flows | `owned`; ownerModuleId: `channels`; keys: `channels.bindings`, `channels.surface-bindings`, `channels.email-attachments`, `channels.whatsapp-auth` |
| `command-room` | public route `/command-room` on desktop/mobile | `none`; ownerModuleId: `command-room`; composed over agents, commanders, conversations, quests, workspace, policies and automations |
| `commanders` | public Marketplace route plus embedded org/Command Room detail | `owned`; ownerModuleId: `commanders`; keys: `commanders.sessions`, `commanders.names`, `commanders.memory`, `commanders.quests`, `commanders.transcripts`; conversation data also shares this root |
| `components` | embedded shared primitives on desktop/mobile | `none`; ownerModuleId: `components` |
| `conversation` | private embedded Command Room components/hooks | `shared`; ownerModuleId: `conversation`; key: `commanders.conversations`; sharedWith: `commanders`; backed by the commander data root today |
| `onboarding` | public hidden route `/welcome` on desktop/mobile | `shared`; ownerModuleId: `onboarding`; sharedWith: `org`, `operators`, `commanders`, `agents`; no independent store |
| `operators` | private hooks embedded in org/settings | `owned`; ownerModuleId: `operators`; keys: `operators.profiles`, `operators.avatars` |
| `org` | public route `/org` on desktop/mobile | `shared`; ownerModuleId: `org`; keys: `org.identity`, `operators.profiles`, `commanders.sessions`, `automations.definitions`; sharedWith: `commanders`, `operators`, `org-identity`, `automations` |
| `org-identity` | private components embedded in org/settings | `owned`; ownerModuleId: `org-identity`; key: `org.identity` |
| `policies` | public route `/policies` on desktop/mobile | `owned`; ownerModuleId: `policies`; keys: `policies.rules`, `approvals.pending`, `approvals.audit`; sharedWith: `approvals` |
| `quests` | private Quest Board embedded in Command Room/commander detail | `shared`; ownerModuleId: `quests`; key: `commanders.quests`; sharedWith: `commanders`; backed by the commander quest store today |
| `rpg` | experimental hidden route `/rpg` on desktop | `none`; ownerModuleId: `rpg`; visualization/control client only |
| `settings` | private mobile route `/command-room/settings`; app settings embedded in `/settings` | `owned`; ownerModuleId: `settings`; key: `settings.app` |
| `skills` | experimental route `/skills`; selectors embedded in composer, policies and automations | `external`; ownerModuleId: `skills`; installed/scaffolded packages under configured Claude/Codex/skill roots |
| `telemetry` | public route `/telemetry` on desktop | `owned`; ownerModuleId: `telemetry`; key: `telemetry.events` |
| `workspace` | private panel/overlay embedded in sessions on desktop/mobile | `owned`; ownerModuleId: `workspace`; keys: `workspace.conversation-targets`, `workspace.preferences` |
| `module-graph` | private, no direct UI; drives bootstrap/navigation | `none`; ownerModuleId: `module-graph`; derived from manifests/provider summaries |
| `realtime` | private, no route UI; voice entrypoint is embedded in composer | `none`; ownerModuleId: `realtime`; stateless proxy; transcription secret remains owned by `api-keys` |
| `eval` | private hidden route `/eval` on desktop | `owned`; ownerModuleId: `eval`; key: `eval.result-manifests` plus run/report/trajectory artifacts |

Do not cache or duplicate the owned/shared records above in a new frontend
authority. React Query/local UI state may project them, but invalidation,
optimistic updates and rollback must converge on the named backend owner.

## Backend Capability Matrix

Each row is an implementation domain, not merely a screen. Exact roots, auth,
parser, and websocket ownership are in
`docs/architecture/routes-and-apis.md`; exact UI/backend ownership is in the
live manifests.

| Domain | Backend/API capability that must remain reachable | Authoritative sources |
|---|---|---|
| Runtime discovery and health | Module/nav/capability graph, mounts, providers, parsers, websockets; build/database/store/runtime/memory health; public installer. | `modules/module-graph/routes.ts`, `server/index.ts`, `server/routes/install-script.ts` |
| Authentication and keys | Auth0/API-key startup, scope catalogue, managed key create/list/revoke, bootstrap-key rotation, mobile pairing/verify, transcription and image-generation service secrets. | `server/middleware/combined-auth.ts`, `server/routes/api-keys.ts`, `server/api-keys/store.ts` |
| Providers and models | Registry metadata, dynamic/static model discovery, freshness/errors/refresh throttling, custom-model support, model-specific effort/adaptive-thinking options, defaults, transports, permission modes and disabled state. | `modules/agents/providers/provider-adapter.ts`, `modules/agents/providers/http-router.ts`, `modules/agents/providers/registry.ts` |
| Provider credentials | Pool snapshots/probe, credential list/add/remove, remote-token capture, guided login, activate/switch, quota refresh, provider reauthentication. | `modules/agents/routes/provider-auth-routes.ts` |
| Agent sessions | Create/list/detail, messages/debug events, immediate send, rich message, pause/resume/archive/kill/sweep, external register/heartbeat/events, directory/file/skill discovery and upload. | `modules/agents/routes/session-*.ts`, `modules/agents/routes/external-session-routes.ts`, `modules/agents/routes/discovery-routes.ts` |
| Workers | Child-worker and commander-worker dispatch with backend-owned creator identity, team state and lifecycle actions. | `modules/agents/routes/session-create-routes.ts`, `modules/commanders/routes/register-workers.ts` |
| Queues | Read waiting/current state, explicit queue intent, reorder, remove, clear, capacity/errors, replay updates. | `modules/agents/routes/session-control-routes.ts`, `modules/agents/message-queue.ts`, `modules/agents/queue-state.ts` |
| Machines and daemon | List/create/delete, enrollment command/token, enroll, launch/Tailscale verification, health, daemon pair/revoke/status, provider auth setup/status, world state. | `modules/agents/routes/machine-world-routes.ts`, `modules/agents/daemon-*.ts` |
| Commander identity | List/detail/create/update, wizard, profile/avatar, start/stop/run-now, heartbeat/log/config, runtime defaults, archive/restore/delete, import/export/replicate, direct collect and follow-up messaging. | `modules/commanders/routes/register-core.ts`, `docs/features/commanders.md` |
| Remote commander registration | Sync-token creation, remote registration and remote state synchronization without conflating remote identity with a local session. | `modules/commanders/routes/register-remote.ts` |
| Commander packages | Package list/detail, required/optional skills, examples/onboarding and one-click install. | `modules/commanders/routes/register-core.ts`, `modules/commanders/packages/` |
| Conversations | Bootstrap/list/detail/create, paginated messages, provider/model/runtime patch, start/send/queue/pause/resume/archive/delete and socket alias. | `modules/commanders/routes/register-conversations.ts`, `modules/commanders/routes/conversation-*.ts` |
| Memory and transcripts | Working-memory read/append/delete, remote sync, export, durable fact capture, commander-scoped semantic transcript search. | `modules/commanders/routes/register-memory.ts`, `modules/commanders/routes/register-transcripts.ts` |
| Quests and tasks | Global/commander lists, next/explicit claim, manual/GitHub-backed create, contract/provider/model fields, status/artifact/note updates and delete; compatibility task routes. | `modules/commanders/routes/register-quests.ts`, `modules/commanders/routes/register-command-room.ts` |
| Channels | Six descriptors (Email, WhatsApp, Google Chat, Telegram, Discord, Slack), binding CRUD, pairing/status, setup guides, allowlists/policy, normalized inbound conversation, progressive/final outbound delivery. | `modules/channels/descriptors.ts`, `modules/channels/route.ts`, `modules/channels/types.ts`, `docs/architecture/channels.md` |
| Workspace | Open authorized target; tree/expand/resolve; preview/raw/download; context materialize; git status/log/init; save/create/rename/delete/upload; preferences. | `modules/workspace/routes.ts`, `docs/features/workspace.md` |
| Policies and approvals | Scoped action-policy/settings read/write, `auto/review/block` resolution, check/poll/decide, pending/history, audit, stream ticket/snapshot/enqueued/resolved. | `modules/policies/routes.ts`, `modules/policies/approvals-routes.ts`, `docs/features/approvals.md` |
| Automations | Schedule/completed-quest/manual triggers, create/filter/detail/update/delete, pause/resume/run, provider/model/skills/workdir/timezone/run limits, history/run report/transcript/memory. | `modules/automations/routes.ts`, `modules/automations/scheduler.ts`, `modules/automations/executor.ts` |
| Onboarding and org | Composite first-run projection; seed Gaia/workforce, skip/finish/receipt/launch target; founder/operator/avatar/org identity and aggregate org read model. | `modules/onboarding/route.ts`, `modules/org/route.ts`, `modules/operators/routes.ts`, `modules/org-identity/route.ts` |
| Settings and skills | Theme/font/composer settings; installed skill discovery/detail, creation prompt, manual create, downloadable ZIP export and delete. | `modules/settings/routes.ts`, `modules/skills/routes.ts` |
| Telemetry | Scan/ingest, sessions/calls/detail/summary, cost/token/model/agent breakdowns, compaction; OTLP JSON logs/metrics/traces. | `modules/telemetry/routes.ts`, `modules/telemetry/otel-receiver.ts` |
| Eval | Auth doctor, list/create/read runs, status, report, artifact manifests and human-gated submit handoff. | `modules/eval/routes.ts` |
| Realtime voice | Transcription config/ticket and authenticated browser audio websocket proxy; service credentials remain API-key-owned. | `server/realtime/proxy.ts`, `modules/realtime/runtime.ts`, `src/hooks/use-openai-transcription.ts` |
| iOS wrapper | Same authenticated web contracts inside Capacitor; no separate feature/backend model. | `ios/README.md`, `capacitor.config.ts`, `src/surfaces/mobile/` |

#### Current provider/model contract

In the validated live source, provider registry model entries own
`supportsEffort`, `supportedEffortLevels`, `defaultEffort` and
`supportsAdaptiveThinking`. Every model selector and runtime editor must consume
those fields from one provider/model catalogue; conversations, standalone
sessions, commanders, workers and automations may not maintain divergent lists.
For the current Codex catalogue, models—including `gpt-5.6-sol`—expose `low`,
`medium`, `high`, and `xhigh`; the default is `xhigh`. Legacy `max` and `ultra` values normalize to
`xhigh` at input boundaries and must never be sent to the Codex API. This is
evidence of the metadata contract, not permission to hardcode those values. See
`apps/herd/modules/agents/adapters/codex/models.ts`,
`modules/agents/providers/provider-adapter.ts` and `modules/agents/effort.ts`.

### Permission And Authentication Contract

The complete API-key catalogue is backend-owned by
`server/api-keys/store.ts`. Render the returned catalogue and selected scopes;
do not copy this list into application enums:

| Scope | Capability boundary |
|---|---|
| `telemetry:read` / `telemetry:write` | telemetry/eval reads versus scan, compaction, OTLP ingest and eval mutations |
| `agents:read` / `agents:write` | agent, provider, workspace, policy and approval reads versus session/send/control/workspace/policy writes; session websocket requires effective write permission |
| `agents:admin` | managed API-key administration and bootstrap-key rotation; deliberately excluded from ordinary mobile-pairing defaults |
| `commanders:read` / `commanders:write` | commander, conversation, onboarding, operator, settings, automation and channel reads versus mutations |
| `commanders:channels:write` | restricted internal channel-ingest boundary; do not substitute ordinary commander write access where this scope is required |
| `org:write` | founder/org identity and org setup mutations |
| `services:read` / `services:write` | provider service-credential visibility versus mutation |
| `skills:read` / `skills:write` | installed-skill discovery versus create, ZIP export and delete operations |

Preserve these authentication exceptions and asymmetries:

- ordinary protected roots use combined Auth0/API-key auth, but Auth0 permission
  sets can intentionally differ from API-key scopes;
- explicitly public health/install endpoints and unauthenticated commander and
  founder avatar image reads remain narrow exceptions; their neighboring
  mutation routes stay protected;
- provider OAuth browser callbacks intentionally bypass combined auth and
  authenticate the redirect with OAuth `state` plus `code`; preserve state
  validation, terminal success/failure handoff and safe return to the initiating
  credential flow;
- skills accepts alternate Auth0 permissions (`skills:*` or the corresponding
  `commanders:*`) while API keys require the exact `skills:*` scope;
- mobile pairing exposes a restricted default scope set and verifies the issued
  credential before persisting it; never grant `agents:admin` implicitly;
- machine enrollment spends a signed `hmre_` enrollment token, daemon websocket
  pairing spends an `hmrd_` token, and neither is an ordinary browser login;
- Google Chat webhook events verify the Google bearer token and webhook audience;
- channel adapter ingest uses the server-only channel/internal boundary;
- approval hooks receive the scoped approval-bridge token only on check/poll;
- browser websocket and raw-file URLs use short-lived one-time tickets minted by
  authenticated HTTP. Long-lived Auth0/API-key credentials never enter URLs.

| Boundary ID | Exact exception/asymmetry | Primary source |
|---|---|---|
| `AUTH-COMBINED` | Ordinary protected routes support Auth0/API keys with route-specific any/all permission semantics. | `server/middleware/combined-auth.ts` |
| `AUTH-PUBLIC-AVATAR` | Commander and founder avatar GETs are public image reads; their mutation neighbors remain protected. | `modules/commanders/routes/register-core.ts`, `modules/operators/routes.ts` |
| `AUTH-OAUTH-CALLBACK` | Provider OAuth callback bypasses combined auth and validates OAuth state/code before completing the initiating flow. | `modules/agents/routes/provider-auth-routes.ts` |
| `AUTH-SKILLS-ANY-OF` | Skills uses exact API-key scopes but accepts the corresponding skills or commanders Auth0 permission. | `modules/skills/routes.ts` |
| `AUTH-MOBILE-PAIRING` | Restricted pairing scope set is verified before the native URL/key pair is committed. | `server/routes/api-keys.ts`, `src/components/ApiKeyLandingPage.tsx` |
| `AUTH-MACHINE-TOKENS` | Signed enrollment and daemon pairing tokens authorize only their machine/daemon contracts. | `modules/agents/routes/machine-world-routes.ts`, `modules/agents/daemon/enrollment-token.ts` |
| `AUTH-GOOGLE-CHAT` | Public webhook URL still requires verified Google bearer token and audience. | `modules/channels/googlechat/auth.ts`, `modules/channels/googlechat/events.ts` |
| `AUTH-INTERNAL-CHANNEL` | Channel ingest uses the narrow server-only internal/channel scope, never a browser key. | `modules/commanders/routes/context.ts` |
| `AUTH-APPROVAL-BRIDGE` | Worker approval hooks receive a scoped bridge token only for approval check/poll. | `modules/policies/approval-bridge-token.ts` |
| `AUTH-ONE-TIME-TICKET` | Browser websocket/raw URLs spend short-lived one-time tickets minted over authenticated HTTP. | `server/auth/transport-tickets.ts` |

### Frontend Integration Entrypoints

Start from these existing hooks and service boundaries. Reuse their query keys,
cache seeding, optimistic updates, ticket minting and event normalization before
creating a new client. Existing components are behavior references, not visual
templates.

| Supplied UI concern | Existing integration entrypoint | Backend owner |
|---|---|---|
| Authenticated requests, token injection and unauthorized recovery | `src/lib/api.ts`, `src/hooks/use-auth-fetch.ts` | combined Auth0/API-key middleware |
| Module graph and navigation | `src/hooks/use-module-graph.ts`, `src/module-graph-bindings.ts` | `module-graph` |
| Session list/actions | `src/hooks/use-agents.ts` | `agents` |
| Session replay/live stream | `src/hooks/use-agent-session-stream.ts` | `agents` websocket |
| Send versus queue dispatch | `src/hooks/send-dispatcher.ts`, `modules/agents/session-queue-api.ts` | `agents` / conversation runtime |
| Provider/model metadata | `src/hooks/use-providers.ts` | agents provider registry |
| Provider credential pools/quota | `src/hooks/use-credential-pools.ts` | agents provider-auth runtime |
| Conversations and bootstrap caches | `modules/conversation/hooks/use-conversations.ts` | `commanders` conversation runtime |
| Conversation runtime model/effort edits | `modules/conversation/hooks/use-conversation-runtime-settings.ts` | commanders conversation runtime |
| Commander detail/actions | `modules/commanders/hooks/useCommander.ts` | `commanders` |
| Org projection/actions | `modules/org/hooks/useOrgTree.ts`, `modules/org/hooks/useOrgActions.ts` | `org` aggregate + domain owners |
| Founder/org identity | `modules/operators/hooks/useFounderProfile.ts`, `modules/org-identity/hooks/useOrgIdentity.ts` | `operators`, `org-identity` |
| Founder onboarding projection/actions | `modules/onboarding/hooks/useFounderOnboarding.ts` | onboarding aggregate |
| Automations | `modules/automations/hooks/useAutomations.ts` | `automations` |
| Channel descriptors/bindings | `modules/channels/hooks/useChannels.ts` | `channels` |
| Approvals and policies | `src/hooks/use-approvals.ts`, `src/hooks/use-action-policies.ts` | `approvals` presentation, `policies` mutation |
| Workspace target/files/context | `modules/workspace/use-workspace.ts` | `workspace` |
| Keys/service credentials | `src/hooks/use-api-keys.ts` | `api-keys` |
| Skills | `src/hooks/use-skills.ts` | `skills` |
| Telemetry | `src/hooks/use-telemetry.ts` | `telemetry` |
| Speech/transcription | `src/hooks/use-openai-transcription.ts`, `src/hooks/use-speech-recognition.ts` | `realtime`, browser speech API |
| Theme and font scale | `src/lib/theme-context.tsx`, `src/hooks/use-font-scale.ts` | `settings` |
| Composer abilities and quick skill slot | `src/hooks/use-composer-abilities.ts`, `src/hooks/use-composer-skill-slots.ts` | `settings.app` |
| Pre-auth and native connection | `src/App.tsx`, `src/components/LandingPage.tsx`, `src/components/ApiKeyLandingPage.tsx` | Auth0/API-key startup, mobile pairing and persisted connection state |
| Standalone-session creation | `modules/agents/components/NewSessionForm.tsx`, `modules/agents/components/new-session-form/` | agents/provider/machine runtime |
| RPG views and controls | `modules/rpg/index.tsx`, `modules/rpg/hooks/use-world-state.ts`, `modules/rpg/use-session-ws.tsx` | agents, commanders and quests |

### Public Root Checklist

The new client may not use every root on every screen, but it must not silently
remove their operator workflows:

```text
/api/health                      /install.sh
/api/modules                     /api/auth
/api/agents                      /api/agents/sessions/:name/ws
/api/agents/daemons/ws           /api/providers
/api/commanders                  /api/commanders/packages
/api/commanders/:id/quests       /api/conversations
/api/conversations/:id/ws        /api/commanders/:id/channels
/api/commanders/channels/googlechat/events
/api/commanders/channel-message  /api/commanders/:id/channel-reply
/api/workspace                   /api/approvals
/api/approvals/stream            /api/action-policies
/api/approval                    /api/onboarding
/api/org                         /api/org/identity
/api/operators                   /api/settings
/api/automations                 /api/telemetry
/v1/logs                        /v1/metrics
/v1/traces                      /api/eval
/api/realtime                    /api/realtime/transcription
/api/skills
```

### Realtime And State Rules

- Agent and conversation sockets hydrate with replay before live events. Do not
  double-count replayed usage or duplicate transcript events.
- Conversation sockets resolve the durable conversation's current session on
  the server. Socket presence is not conversation sendability.
- Conversation cold-open uses the commanders-owned bootstrap projection to
  seed list/detail/message caches. Websocket events patch visible caches;
  polling is reconnect/error fallback, not idle-tab freshness.
- Stream session sockets carry transcript/usage/queue updates and accept message
  input, plan answers and ask-user/MCP elicitation answers. PTY sessions accept
  terminal bytes. External-session sockets replay and follow events but are
  intentionally read-only: the server ignores client input for them.
- Daemon disconnect is transport loss, not proof a child process stopped.
- Pending approval streams begin with a snapshot, then enqueue/resolve events.

### Canonical Event And Client-Command Ledger

Provider adapters normalize stream output into `HerdEvent`; new components
must consume this union instead of branching on raw provider JSON.

| Direction | Contract to preserve | UI responsibility |
|---|---|---|
| server -> client | `planning`, `plan_approval` | show enter/proposed/decision states and interactive approval with timeout/default metadata |
| server -> client | `queue_update` | replace queue projection atomically; preserve priority/current/capacity semantics |
| server -> client | `content_block_start`, `content_block_delta`, `content_block_stop` | assemble text/thinking/tool/image blocks by index without duplicating replay |
| server -> client | `message_delta`, `message_stop` | update usage/cost/stop reason as totals when marked total; finish active streaming state |
| server -> client | `assistant`, `user`, `system`, `agent`, `rate_limit_event`, `tool_use`, `tool_result`, `exit` | render canonical timeline, provider/rate-limit/recovery state, tools and terminal outcome |
| client -> stream | `input` with text, images, `clientSendId`, workspace context | immediate interrupt/send only; materialize authorized context server-side and reconcile optimistic message by `clientSendId` |
| client -> stream | `tool_answer` | answer plan approval, Codex MCP elicitation, or provider ask-user; wait for ack/error and retain retryable input |
| client -> PTY | binary/text terminal input | terminal interaction only; do not present stream-only controls |
| approval stream | initial snapshot, then enqueued/resolved events | hydrate before applying deltas and keep pending badges/inbox synchronized |
| daemon channel | pairing, heartbeat, health and buffered process events | display transport health separately from child-process lifecycle |

Primary types and processors are `src/types/herd-events.ts`,
`modules/agents/websocket.ts`, `src/hooks/use-agent-session-stream.ts` and
`modules/agents/components/use-stream-event-processor.ts`.

## Frontend Workflow And Quality-Of-Life Ledger

### Pre-authentication, recovery and native connection

- Preserve the Auth0 versus API-key startup split, return-to location, loading
  state, typed gateway/auth failure, reconnect and logout/recovery paths.
- Browser API-key entry validates before entering the app and retains actionable
  invalid-key/network errors instead of collapsing them into a blank shell.
- Capacitor/native setup accepts instance URL plus API key, QR scan or pasted
  invitation, normalizes and verifies the remote instance/scopes, then persists
  URL and key atomically only after verification succeeds.
- Clear stale or rejected native credentials, support switching instances, and
  never leave a partially written URL/key pair. Preserve the explicit public
  connection screen when no valid native credential exists.

Behavior references: `src/App.tsx`, `src/components/LandingPage.tsx`,
`src/components/ApiKeyLandingPage.tsx` and their tests.

### Global shell

- Startup loading, typed startup failure, Retry, authenticated bootstrap, and
  forced onboarding before ordinary routes.
- Desktop primary navigation, Ops overflow, breadcrumb, running/pending counts,
  pending-approval link, and optimistic theme toggle with rollback.
- Global bootstrap-key rotation prompt stays safe-area-aware, links directly to
  the rotation flow, persists dismissal per key identity/expiry, reappears for a
  later key and is not duplicated inside Settings.
- Mobile searchable drawer, New session shortcut, graph-driven destinations and
  badges, up to four deduplicated recent conversations, and Settings access.
- Immersive mobile chat hides ordinary shell chrome without hiding approval
  notifications; safe-area/dynamic-viewport behavior remains intact.

### Command Room and session navigation

- Commander/conversation selection; New Chat; provider/model metadata; team,
  worker, automation, quest, identity and workspace access.
- Passive commander selection, empty-state rendering and deep-link resolution
  must never create a conversation. `POST`/auto-start occurs only after the user
  explicitly confirms New Chat/create; cancellation leaves backend state intact.
- Preserve URL-backed commander/conversation/panel selection, browser back/deep
  links and stale-response guards: an older request may never replace the active
  conversation after a fast selection change.
- Backend-owned start/stop/archive/remove/rename and allowed/disabled actions;
  pending-approval highlighting; running/stale/exited grouping; show-exited and
  collapsed-group preferences; auto-refresh/reconnect status; font scaling.
- Desktop global, empty, loading, terminal, retry and chat states.
- Mobile swipeable conversation pages, page dots, adjacent fallback after
  archive/remove, immediately typable cold shell, reconnect strip, transcript
  skeletons and session overflow controls. Mobile history paginates only when
  the reader reaches the top and preserves scroll position; starting, failed,
  stopped and resumable states remain distinct.

Behavior reference: `modules/agents/page-shell/MobileSessionShell.tsx`.

### Standalone session creation and runtime controls

- Standalone create captures provider, backend-discovered model, model-specific
  effort/adaptive-thinking/max-token controls, stream versus PTY transport,
  task, working directory, permission/approval presentation, machine, skills and
  optional resume source.
- Provider metadata owns supported transports, forced transport, disabled
  reason, defaults, model catalogue/freshness, custom-model support, auth mode
  and info banners. Stream supports replay/resume; PTY is terminal-oriented and
  cannot promise restart resume; external sessions are read-only viewers.
- Credential selection follows runtime location and readiness: local Claude does
  not expose a pool selector; remote runtimes offer Automatic plus ready accounts.
  A persisted credential ID that is missing or currently unavailable remains
  visible but disabled so the UI never silently changes the selected identity.
- PTY mode preserves binary/text input and terminal resize messages and omits
  stream-only composer/tool-answer controls.
- Resume locks incompatible provider/transport/runtime fields to the source
  session. Machine selection respects provider readiness and working-directory
  roots; Add Machine preserves enrollment, Tailscale verification, provider auth
  setup/status and launch verification.
- Keep standalone session creation distinct from commander conversation create,
  worker dispatch and scheduled automation creation while sharing the same
  provider/model metadata and validation contracts.

Behavior references: `modules/agents/components/NewSessionForm.tsx`, its
`new-session-form/` sections and `useNewSessionConstraints.ts`.

### Composer, queue and context

- Quick mode uses Enter/Send to interrupt, Shift+Enter for a newline, and
  Tab/Queue for explicit queueing. Markdown mode uses Enter for a newline,
  Cmd/Ctrl+Enter to interrupt, and Tab to queue. Cmd/Ctrl+Shift+M toggles modes;
  multiline paste promotes quick mode to Markdown. A failed interrupt must
  never become queued work implicitly.
- On failed send restore text, images, selected abilities/skills, file paths,
  directory paths and annotations.
- Persist text, image attachments, and composer mode per session; restore only
  that session's draft; flush pending writes on unmount/session rotation; and
  clear the persisted draft only after acknowledged send. Clearing returns to
  quick mode. A failed send keeps the exact draft intact.
- IME-safe keyboard handling; textarea auto-grow capped compactly in quick mode
  and at 45% of the nearest owning resize pane in Markdown mode; image picker and paste,
  PNG/JPEG/GIF/WebP validation, size/count limits and removable previews.
- Microphone transcription, removable context chips, draft-saved feedback,
  Ctrl/Cmd+K workspace access, and visible reasons when the composer is disabled.
- Preserve Add to Chat selection, custom composer abilities, Think Hard and the
  quick skill slot/picker; all selected context must survive failure and session
  rotation with the draft.
- Queue count/capacity, current item, waiting list, reorder/remove/clear and
  queue-current-draft actions. Waiting items remain out of transcript until run.
  If a post-mutation refresh fails, keep the last known-good queue visible and
  surface the refresh error separately instead of blanking accepted state.

Draft reference: `modules/agents/page-shell/use-session-draft.ts`.

### Transcript and agent activity

- Initial jump to bottom; stream-follow only while the reader remains near the
  bottom so reading older messages is never interrupted.
- Structured user/assistant/system/thinking/planning/agent/tool/provider/error
  blocks, running-agent state, collapsed subagent/tool/activity summaries, and
  terminal success/failure state.
- GFM, safe images, workspace-aware links and inline paths, message/code copy
  feedback, raw provider-event inspection without transcript clutter.
- Interactive plan approval and ask-user multi-select/custom responses.
- Typed auth/quota failures with credential recovery, switch/add-account and
  refresh states.
- Immediate sends create one optimistic user bubble keyed by `clientSendId`.
  Replayed/history events must reconcile that bubble rather than append a second
  copy; failure removes or marks only the matching optimistic entry and restores
  its draft/context.

### Workspace

- Desktop browse/expand tree, hidden-file toggle, preview/edit/save, upload and
  download, create file/folder, rename/delete confirmation, git status/log/init,
  Retry/errors/toasts and Add to chat. Desktop does not currently promise file
  search.
- Mobile searchable sheet with Files/Changes/Git Log, preview/download, Retry and
  Add to context. Desktop, mobile and standalone sessions share one `targetId`
  and context-materialization contract.

### Org, onboarding and Marketplace

- Org tree/grid, archived toggle, first-hire empty state, highlighted deep link,
  detail/edit/replicate/archive/restore/delete/export, confirmations and toasts.
- Onboarding progress, validation, Gaia/workforce seed or skip, locked pending
  states, field/server errors and final launch receipt. A completed install or
  explicitly skipped workforce remains complete if provider readiness later
  regresses; ordinary startup must not force the operator back into onboarding.
- Marketplace loading/error/empty states, package details, skills, automations,
  examples/onboarding, Open/Hire, JSON import, install result and cache refresh.

### Gaia-assisted creation and setup

- Commander creation preserves explicit manual, guided-chat and Gaia modes.
  Guided chat uses a ticketed live setup session with reconnect/Retry, inline
  approvals, progressive transcript/state, success handoff and cleanup on cancel
  or completion; it must not leak an orphan setup session.
- Commander, automation and machine/worker surfaces retain their pre-drafted Gaia
  shortcuts. The shortcut supplies context to Gaia but does not silently execute
  creation or bypass the ordinary confirmation, provider/auth and validation
  contracts.
- Nick's Figma may compose these affordances differently, but missing design
  states for live setup, reconnect, approval, failure, cancel and cleanup must be
  escalated rather than dropped.

Behavior references: `modules/commanders/components/CreateCommanderWizard.tsx`,
`modules/commanders/components/WizardChatPanel.tsx`,
`modules/commanders/components/AutomationPanel.tsx` and
`modules/agents/components/new-session-form/AddWorkerWizard.tsx`.

### Approvals, policies, automations and quests

- Approval pending/refresh states, risk/reason/full/raw/semantic preview,
  decision lock, typed notices, audit history, desktop modal/mobile sheet and
  mobile All/High Risk filters.
- Global/commander policies; Skills, Channels, Code & Infra and Default groups;
  inherited/global/override badges; responsive list/detail; optimistic save,
  rollback and refresh.
- URL-backed automation filters; schedule/quest/manual modes; presets; provider,
  model, skills, observation, workdir and run limits; pause/resume/run/delete;
  history/output/report/transcript/memory.
- Quest create/claim/status/note/artifact/delete, provider/model contract and
  worker dispatch/ownership visibility. Preserve per-commander quest-authoring
  draft persistence across unmount, GitHub issue-to-instruction import, source,
  URL, directory, provider, skill and artifact fields, plus dirty-dismiss
  confirmation so an accidental close does not erase a partially authored quest.

Quest authoring reference: `modules/commanders/components/QuestBoard.tsx`.

### Commander identity and runtime administration

- The embedded commander detail/Identity surface retains profile/avatar,
  start/stop/run-now, archive/restore/delete, replicate/import/export and channel
  access plus backend `allowedActions`/disabled reasons.
- Preserve runtime provider/model/effort and max-turn/context/cost controls,
  terminal max-turn state, `COMMANDER.md` preview/edit behavior, heartbeat mode,
  schedule/interval status, logs/monitoring and explicit save/error feedback.
- Conversation runtime edits, commander defaults, worker dispatch and automation
  creation all use the same provider/model capability metadata; inherited values
  remain distinguishable from explicit overrides.

Identity reference: `modules/commanders/components/CommanderIdentityTab.tsx`.

### Channels, skills, settings, telemetry and eval

- Channel UI renders descriptor fields, required/secret/read-only/options,
  setup guides and pairing modes; focuses first invalid field; supports QR/status
  refresh; clears secrets after save; enable/disable/configure/remove and errors.
- Skills search/detail/loading/error Retry, Run, Schedule, Gaia/manual creation,
  edit, downloadable ZIP export and delete confirmation. The backend `archive`
  route builds the export ZIP; it is not a separate user-visible lifecycle state.
- Theme system/light/dark, font scale, account/workspace/app groupings,
  notification timeout, standing-approval expiry, machines/providers/credential
  pools, profile/sign-out and workspace preferences.
- Desktop key/service settings: bootstrap rotation, service credentials, mobile
  pairing QR/copy, scoped key creation/revocation and one-time raw-key display.
- Telemetry period/month selection, retention warning, cost/token/session cards,
  charts, model/agent breakdowns, auto-refresh, drill-down/call history and
  loading/empty/error Retry.
- Eval doctor, run creation/list/status/report and clearly blocked human submit
  state; hidden route remains directly reachable. Benchmark/source/runner filters
  remain URL-backed and the results table remains horizontally overflow-safe.

### RPG experimental surface

- Preserve URL-backed `Overworld`, `Party` and `Quests` views, including direct
  links and browser navigation between them.
- Keep one-second world-state refresh, party/commander/session state, quest CRUD,
  session create/start/stop/kill controls and ticketed session stream commands
  and tool answers.
- Preserve keyboard/proximity player interaction and visible loading/error/empty
  states. RPG remains a visualization/control client over agents, commanders and
  quests; it must not create a separate backend state owner.
- Preserve player and agent positions as separate local browser projections.
  The explicit Reset Positions control clears persisted agent positions only;
  it does not reset the separately persisted player position. Neither projection
  makes RPG a durable backend owner.

Behavior references: `modules/rpg/index.tsx`, `modules/rpg/RpgScene.tsx`,
`modules/rpg/screens/`, `modules/rpg/PlayerSprite.tsx`,
`modules/rpg/hooks/use-world-state.ts` and `modules/rpg/use-session-ws.tsx`.

### Cross-cutting accessibility and interaction safety

- Dialogs, sheets and overlays expose correct dialog semantics, trap focus,
  close on Escape where safe, and restore focus to the triggering control.
- Dynamic status/error/success and streaming changes use appropriate live-region
  semantics without announcing every token delta; icon-only controls have names.
- Preserve logical tab order, visible focus, keyboard activation, disabled
  reasons and non-pointer alternatives for drag/swipe/reorder interactions.
- Interactive mobile controls meet the existing 44px target convention; text
  inputs/selects retain a 16px mobile font floor to avoid iOS auto-zoom; safe
  areas, dynamic viewport and reduced-motion preferences remain usable.
- Destructive actions require confirmation and keep focus/input recoverable when
  the mutation fails.

Behavior references: `src/components/DismissibleOverlay.tsx`, reusable modal and
bottom-sheet primitives, `src/__tests__/mobile-input-autozoom.test.ts` and current
component tests containing `aria-*`, focus and keyboard assertions.

### Critical QoL Invariant Matrix

The structural guard requires each complete row below. The IDs make accidental
deletion detectable; the behavior text and source are still reviewed by a human.

| ID | Invariant the replacement must preserve | Primary behavior evidence |
|---|---|---|
| `QOL-AUTH-RECOVERY` | Auth0 return-to, gateway Retry, typed API-key failures, rejected-credential cleanup and logout recovery. | `src/App.tsx`, `src/components/LandingPage.tsx` |
| `QOL-NATIVE-PAIRING` | Native URL plus QR/invite pairing verifies scopes and atomically persists or clears the connection pair. | `src/components/ApiKeyLandingPage.tsx` |
| `QOL-BOOTSTRAP-ROTATION` | Rotation notice is global, safe-area aware, per-key dismissible, repeatable for a later key and absent inside Settings. | `src/app/BootstrapKeyRotationPrompt.tsx` |
| `QOL-NEW-SESSION` | Explicit standalone create preserves provider/model controls, stream/PTY/external semantics, machine/auth, cwd/task and resume constraints. | `modules/agents/components/NewSessionForm.tsx` |
| `QOL-CONVERSATION-CONFIRM` | Passive selection/render never creates; only explicit confirmed New Chat may post a conversation. | `modules/conversation/components/CreateConversationPanel.tsx` |
| `QOL-CREDENTIAL-SELECT` | Local Claude hides pool selection; remote offers Automatic/ready accounts and preserves missing current IDs as disabled. | `modules/conversation/components/CredentialPoolSelect.tsx` |
| `QOL-SESSION-DRAFT` | Text/image draft is session-scoped, debounced, flushed on lifecycle exit, restored exactly and cleared only after acknowledged send. | `modules/agents/page-shell/use-session-draft.ts` |
| `QOL-OPTIMISTIC-SEND` | One `clientSendId` bubble appears immediately and reconciles with live/replay/history without duplication or lost recovery context. | `src/hooks/use-agent-session-stream.ts`, `modules/agents/components/use-stream-event-processor.ts` |
| `QOL-DEEP-LINK-RACE` | Commander/conversation URL selection survives back/deep links and stale responses cannot overwrite a newer selection. | `modules/command-room/components/CommandRoom.tsx` |
| `QOL-MOBILE-LIFECYCLE` | Mobile distinguishes cold/starting/failed/stopped/resumable/reconnecting and paginates history only at the top without scroll jump. | `modules/agents/page-shell/MobileSessionShell.tsx` |
| `QOL-COMPOSER-CONTEXT` | Add to Chat, abilities, Think Hard, quick skill, images, voice and workspace context survive retry/session rotation as specified. | `modules/agents/components/SessionComposer.tsx`, `src/hooks/use-composer-abilities.ts`, `src/hooks/use-composer-skill-slots.ts` |
| `QOL-QUEUE-RECOVERY` | Explicit interrupt/queue intent, ordering/removal/capacity and last-known-good queue survive a failed refresh. | `modules/command-room/components/CommandRoom.tsx`, `modules/agents/queue-state.ts` |
| `QOL-QUEST-DRAFT` | Quest source/URL/directory/provider/skills/artifacts persist across unmount and dirty dismiss requires confirmation. | `modules/commanders/components/QuestBoard.tsx` |
| `QOL-COMMANDER-IDENTITY` | Identity/runtime/heartbeat/COMMANDER.md/cost/max-turn controls retain inherited versus explicit state and terminal outcomes. | `modules/commanders/components/CommanderIdentityTab.tsx` |
| `QOL-ONBOARDING-RECOVERY` | Completed or deliberately skipped setup stays complete when later provider readiness regresses. | `src/app/AuthenticatedAppRouter.tsx` |
| `QOL-GAIA-SETUP` | Manual/chat/Gaia commander creation and Gaia automation/worker shortcuts preserve ticketed live setup, approvals, reconnect, confirmation and cleanup. | `modules/commanders/components/WizardChatPanel.tsx`, `modules/agents/components/new-session-form/AddWorkerWizard.tsx` |
| `QOL-WORKSPACE` | Shared target/context authority, desktop file/git mutations and mobile-only search preserve errors, Retry and Add to Chat. | `modules/workspace/components/WorkspacePanel.tsx`, `modules/agents/components/WorkspaceOverlay.tsx` |
| `QOL-EVAL-FILTERS` | Hidden eval route remains reachable with URL-backed filters, overflow-safe results and human-gated submit. | `modules/eval/page.tsx` |
| `QOL-RPG` | URL-backed views, polling, keyboard interaction, separate player/agent persistence, agent-only Reset Positions, quest/session controls and ticketed tool answers remain intact. | `modules/rpg/RpgScene.tsx`, `modules/rpg/PlayerSprite.tsx`, `modules/rpg/use-session-ws.tsx` |
| `QOL-ACCESSIBILITY` | Dialog focus trap/Escape/restore, live regions, names, keyboard alternatives, 44px targets and 16px mobile input floor remain intact. | `src/components/DismissibleOverlay.tsx`, `src/__tests__/mobile-input-autozoom.test.ts` |

## Design-To-Backend Hookup Procedure

The design is an external, owner-supplied implementation input. Use this
package to create a hookup ledger before writing integration code:

| Supplied component/interaction | Route/surface | Existing hook/module/API | Event/state contract | Status |
|---|---|---|---|---|
| `<component>` | `<path or embedded surface>` | `<source path + endpoint>` | `<loading/live/error/etc.>` | `connected/gap/blocked` |

Rules:

1. Treat the supplied design as presentation authority and this package as
   backend/integration authority.
2. Map each supplied interaction to the stable hook, module, API, event and
   state owner; old component names are evidence, not a visual template.
3. Reuse existing module hooks/contracts where they remain valid. If a new
   presentation adapter is needed, keep it inside the owning feature module.
4. If a required operational state has no supplied design, mark it `gap` and
   ask Nick for the presentation decision; do not treat absence as removal.
5. Treat desktop and mobile as two compositions over shared contracts. Never
   create a mobile-only backend state model.
6. Do not change backend behavior merely to make a component easier to wire.
   Escalate a genuine contract mismatch with source evidence.

## Implementation Sequence

1. Inventory the supplied components/interactions and complete the hookup
   ledger against this package.
2. Preserve current manifest IDs, paths, route/socket/parser ownership and
   backend contracts. Manifest component bindings may point at replacement
   components when needed; this is not a freeze on the manifest files. Establish
   the new shell behind a reversible integration boundary.
3. Implement Nick's supplied primitives and shells, then connect module-owned
   feature views. Do not move domain hooks into the shell.
4. Port Command Room in vertical workflows: bootstrap/selection, transcript,
   composer/send, queue, workspace, approvals, lifecycle controls, mobile.
5. Port remaining routes and embedded workflows using the ledgers above.
6. Add behavioral tests per workflow and browser-level desktop/mobile evidence.
7. Run the parity gate and remove the old frontend only after every ledger row
   is `connected` and the new UI is proven against the same backend.

## Verification And Acceptance Gate

Start with `.dev/VERIFY.md` for existing focused bundles. At minimum run:

```bash
pnpm --filter herd exec tsx .dev/verify-new-frontend-handoff.ts
pnpm --filter herd run lint
pnpm --filter herd run build
pnpm --filter herd test
pnpm --filter herd run docs:check
```

The structural guard must pass against the implementation branch's `HEAD`. For
this handoff-only audit, the dirty local branch was intentionally left untouched
and the current remote baseline was checked with
`HANDOFF_SOURCE_REF=origin/dev`. That override is audit-only: do not begin UI
implementation until local `HEAD` contains the validated provider/model source.

Add a browser-level route/workflow harness; none is persistently configured in
the app today. Until it exists, capture isolated desktop and mobile evidence for
every route in the reachability ledger, not only Command Room.

The final acceptance packet must include:

- completed design-to-backend hookup ledger with no unexplained gaps;
- passing handoff structural guard: every live module, route, redirect,
  websocket, documented public root, scope and critical QoL anchor is present;
- desktop/mobile route screenshots and exact assertions for each core workflow;
- permission-denied, disabled-action, reconnect/replay and destructive-action
  evidence;
- provider/model/channel variations driven by live descriptors;
- Command Room bootstrap, streaming, queue, workspace, approval and recovery
  evidence;
- successful focused tests plus lint, build, full test and docs checks;
- a diff audit confirming no backend contract was duplicated or bypassed.

## Open Integration Inputs And Decisions

- Nick's final design artifact is intentionally external to this package and is
  expected to arrive with the implementation task. Its absence from the repo is
  not an invitation for the agent to design the frontend.
- Migration method (parallel route, feature flag, branch replacement, or staged
  module swaps): decide before implementation; this brief does not select one.
- Browser test runner and visual-baseline storage: add as part of the UI program.
- If the supplied design does not cover hidden experimental/private routes
  (`/rpg`, `/eval`), ask Nick whether to restyle or retain them. Until that
  decision exists, keep them reachable and behaviorally intact.

## Primary Evidence Index

- Routing and module ownership: `src/module-manifest.ts`,
  `server/module-manifest.ts`, `docs/architecture/module-runtime.md`.
- API/auth/websockets: `docs/architecture/routes-and-apis.md`.
- Frontend composition: `docs/architecture/frontend-surfaces.md`,
  `docs/architecture/command-room.md`.
- Capability discovery: `docs/architecture/indexes/feature-index.xml` and
  `docs/architecture/indexes/route-index.xml`, subject to the drift warnings.
- Providers/sessions: `docs/architecture/agents.md`,
  `modules/agents/providers/provider-adapter.ts`.
- Commanders/conversations: `docs/architecture/commanders.md`,
  `docs/features/commanders.md`.
- Channels: `docs/architecture/channels.md`, `docs/features/channels.md`.
- Workspace: `docs/architecture/workspace.md`, `docs/features/workspace.md`.
- Policies/approvals: `docs/architecture/policies-approvals.md`,
  `docs/features/approvals.md`.
- Verification: `.dev/VERIFY.md`,
  `src/surfaces/__tests__/surface-invariants.test.ts`.
