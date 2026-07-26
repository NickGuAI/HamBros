# Couplings

## Runtime Session Ownership

```text
server/db/schema.ts
  -> agent_runtime_sessions
  -> modules/agents/session/sqlite-runtime-store.ts
  -> modules/agents/session/state.ts
  -> modules/agents/routes/session-query-routes.ts
  -> modules/commanders/routes/conversation-read-model.ts
  -> UI + CLI consumers
```

State owner: SQLite/backend runtime session helpers.

Startup gate:

- `apps/herd/modules/agents/routes-core.ts` waits on
  `restorePersistedSessionsReady` before serving agents routes.
- `apps/herd/modules/agents/persistence-helpers.ts` reads SQLite
  persisted sessions before restoring provider sessions.
- `apps/herd/modules/agents/session/sqlite-runtime-store.ts` must keep
  `runtime_state_json` bounded because this read sits on the first
  `/api/agents/*` request after restart.

Consumers:

- UI: `apps/herd/modules/command-room/components/CommandRoom.tsx`,
  `apps/herd/modules/conversation/hooks/use-conversations.ts`,
  `apps/herd/modules/agents/components/*`.
- CLI: `packages/herd-cli/src/session.ts`,
  `packages/herd-cli/src/workers.ts`,
  `packages/herd-cli/src/up.ts`,
  `packages/herd-cli/src/doctor.ts`.
- Install/release: `apps/herd/install.sh`,
  `operations/deploy/ec2/install-ec2.sh`,
  `operations/scripts/launch_herd.sh`,
  `operations/sops/SOP-15-release-herd.md`.
- Transcripts: `apps/herd/modules/agents/transcript-store.ts` stores
  session transcript files alongside runtime session metadata.

Risk: if UI/CLI derives lifecycle instead of rendering backend `state`,
`allowedActions`, and `disabledReasons`, operators can see conflicting state.
Risk: if persisted replay events grow inside `runtime_state_json`, the agents
route startup gate can pin heap and turn post-restart UI clicks into minutes of
latency even though `/api/health` is already green.

## Command Room Composition

```text
command-room/CommandRoom.tsx
  -> commanders hooks/routes
  -> conversation hooks/routes
  -> agents sessions/queues/websockets
  -> workspace panel/context
  -> approvals + automations + quests
```

Command Room and its shared components own browser-local presentation and draft
state only. That includes per-session composer text/images/mode in
`localStorage` and the in-progress QuestBoard form in `sessionStorage`. Durable
data lives in:

- commanders: `apps/herd/modules/commanders/conversation-store.ts`,
  `modules/commanders/store.ts`, `modules/commanders/quest-store.ts`.
- agents: `apps/herd/modules/agents/runtime.ts`,
  `modules/agents/session/state.ts`.
- workspace: `apps/herd/modules/workspace/*`.
- approvals/policies: `apps/herd/modules/approvals/*`,
  `apps/herd/modules/policies/*`.

Risk: changing Command Room without checking route read models can produce UI
state that passes component tests but disagrees with backend action rules.

Conversation-bound chat and standalone agent chat use different send lanes:

- conversation messages: `/api/conversations/:id/message`, read model and
  websocket alias under `apps/herd/modules/commanders/routes/`.
- standalone sessions: `/api/agents/sessions/:name/send`,
  `/api/agents/sessions/:name/ws`, and queue endpoints under
  `apps/herd/modules/agents/`.

## Shared Session Composer

```text
desktop/mobile session shell
  -> SessionComposer.tsx
  -> use-session-draft.ts
  -> per-session text + images + quick/markdown mode in localStorage
  -> send or queue callbacks owned by the embedding surface
```

The shared composer owns presentation and draft persistence, not backend
sendability. Its `disabled`, `sendReady`, queue snapshot, and callbacks come
from the embedding session or conversation surface.

Behavior contract:

- quick mode: Enter sends, Shift+Enter inserts a newline, and Tab queues when
  queueing is available;
- Markdown mode: Enter inserts a newline, Cmd/Ctrl+Enter sends, and Tab queues;
- Cmd/Ctrl+Shift+M toggles modes, multiline paste promotes quick to Markdown,
  and IME composition must never send or queue;
- the draft mode persists per session and clearing a draft restores quick mode;
- Markdown height follows the owning pane while quick mode keeps the desktop or
  mobile compact cap.

Risk: forking key or draft behavior in a shell creates desktop/mobile drift.
Change `SessionComposer.tsx` and `use-session-draft.ts` once, then prove both
variants through the shared component tests.

## Automation Control And Runtime

```text
global automations page / commander Command Room / mobile surface
  -> commanders/components/AutomationPanel.tsx
  -> automations/hooks/useAutomations.ts
  -> commander compatibility routes + automation routes
  -> automations store + scheduler
  -> cron-validation.server.ts
  -> pinned node-cron semantic validator
```

`AutomationPanel` is the shared list/detail implementation. Scope selects
global or commander data; presentation selects default, mobile-list, or
single-pane behavior. Default presentation swaps list to detail below `md` and
keeps the split layout at `md` and above. Explicit mobile-list and single-pane
embeddings use full-swap navigation.

The browser may keep incomplete cron drafts local, but complete expressions are
authoritatively accepted or rejected by the server. The server guard bounds
range expansion and rejects zero-step input before `node-cron`; `node-cron`
still owns cron grammar. Startup must isolate an invalid persisted schedule so
valid jobs and repair APIs remain available.

Risk: duplicating list/detail state in a consumer or promoting browser cron
parsing to semantic authority causes surface drift. Risk: letting one invalid
persisted record abort scheduler registration makes the repair route
unreachable.

## Quest Artifacts, Workspace References, And Task Lifecycle

```text
task_lifecycle.py create/move
  -> ~/tasks/{proposed,active,completed}/<task>/
  -> index.html + index.json + rewritten task/quest references

create-quests / herd quests artifact add|remove
  -> explicit {type, label, href} on quest PATCH
  -> QuestBoard always-visible artifact chip
  -> file artifact: POST /api/workspace/resolve-reference
  -> ephemeral read-only Workspace target
  -> tree/file/raw reads allowed; all mutations denied
```

Contract owners:

- artifact href shape: `apps/herd/modules/commanders/quest-artifact-href.ts`
  and `packages/herd-cli/src/quests.ts`;
- artifact storage/update: commander quest routes/store;
- file opening and authorization: Workspace resolver/routes;
- task folder state, indexes, and reference rewrites:
  `ai-state/claude/skills/task-system-maintenance/scripts/task_lifecycle.py`;
- task-to-quest creation workflow:
  `ai-state/claude/skills/create-quests/SKILL.md`.

File artifacts are intentionally not converted into a second durable Workspace
registration. Reference resolution mints an ephemeral `readOnly: true` target,
expands local or remote `~/`, and authorizes against configured lifecycle roots.
The public response must not expose raw host roots. All seven target/file/git
Workspace mutations use the shared writable-target guard, and git
initialization repeats the guard at the service boundary. Workspace preferences
are not target-scoped and do not use this guard.

Risk: treating artifact labels or path conventions as type authority bypasses
the explicit contract. Risk: moving a task folder without rewriting quest
artifact hrefs breaks the backlink. Risk: guarding only editor controls leaves
write routes or git initialization available against a read-only target.

Task-folder lifecycle (`proposed`, `active`, `completed`) and quest lifecycle
(`pending`, `active`, `blocked`, `done`, `failed`) are separate state machines.
Their relationship is the explicit file artifact, not a shared name, prose
mention, or inferred path. A quest status change does not move a task folder;
`task_lifecycle.py move` owns that transition and the required reference/index
rewrite.

## Channel Conversation Surface

```text
external provider event
  -> modules/channels/<provider>/adapter.ts
  -> /api/commanders/channel-message
  -> modules/channels/resolver.ts
  -> commanders conversation + surface binding
  -> conversation runtime / provider session
  -> transcript JSONL
  -> durable channelReplyIntent
  -> automatic channel reply forwarder / reconciler
  -> latest channelReplyDelivery
  -> modules/commanders/channel-dispatchers.ts
  -> external provider

same transcript JSONL
  -> mapStreamEventsToMessages
  -> /api/conversations/:id/messages
  -> Command Room ChatPane
  -> SessionMessageList / MarkdownContent
  -> visible user transcript
```

State owners:

- channels owns account bindings, provider runtimes, surface bindings, inbound
  normalization, and provider-specific outbound send.
- commanders owns conversation records, `channelMeta`, `lastRoute`,
  `channelReplyIntents`, `channelReplyDelivery`, and conversation runtime routes.
- agents owns session events, transcript storage, message projection, and shared
  chat rendering components.

Risk: channel tests can prove raw outbound delivery while the user-facing
Command Room transcript is still wrong. Always verify both raw transport and
visible rendered transcript, especially for short assistant replies that pass
through Markdown rendering.

## Provider Runtime Coupling

```text
adapters/<provider>
  -> provider registry metadata
  -> agents session create/restore
  -> provider context persistence
  -> Command Room/provider selectors
  -> commander conversation defaults
```

Primary files:

- `apps/herd/modules/agents/providers/registry.ts`
- `apps/herd/modules/agents/providers/provider-adapter.ts`
- `apps/herd/modules/agents/adapters/claude/`
- `apps/herd/modules/agents/adapters/codex/`
- `apps/herd/modules/agents/adapters/gemini/`
- `apps/herd/modules/agents/adapters/opencode/`
- `apps/herd/modules/agents/providers/provider-context-normalization.ts`
- `apps/herd/modules/agents/providers/provider-session-context.ts`
- `apps/herd/modules/commanders/components/ProviderModelSelect.tsx`

Risk: provider registry metadata can change without changing live runtime
behavior; verify both registry/API and session runtime paths.

## Install, Launch, Release, CLI

```text
install.sh / install-ec2.sh
  -> pnpm build
  -> pnpm run db:ready
  -> launch_herd.sh
  -> server/index.ts boot readiness
  -> CLI up/doctor/status output
  -> SOP-15 public release sync
```

Primary files:

- `apps/herd/install.sh`
- `operations/deploy/ec2/install-ec2.sh`
- `operations/scripts/launch_herd.sh`
- `apps/herd/server/index.ts`
- `packages/herd-cli/src/up.ts`
- `packages/herd-cli/src/doctor.ts`
- `apps/herd/docs/reference/cli.md`
- `operations/sops/SOP-15-release-herd.md`
- `operations/deploy/ec2/README.md`
- `operations/deploy/ec2/herd.service`

Risk: a change can work on EC2 but miss the public Herd release mirror, or work
in managed launch but fail in foreground CLI startup.

Contrarian risks from source review:

- public product branding is Herd while source/service/package names still use
  Herd/Herd; SOP-15 sanitizes public output.
- public docs may use `HERD_DATA_DIR/herd.sqlite`, while implementation defaults
  to `HERD_DATA_DIR/herd.sqlite`.
- endpoint roles appear across the EC2 installer, launch scripts, tests, and
  SOPs: production/ALB/CLI `20001`, loopback development API `20009`.
