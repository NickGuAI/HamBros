# Command Room

## Purpose

Command Room is the primary desktop/mobile operating shell. It composes
commanders, conversations, agents, workspace, approvals, automations, quests,
provider selection, and settings.

## Source Files

- `apps/herd/modules/command-room/components/CommandRoom.tsx`
- `apps/herd/modules/command-room/components/mobile/MobileCommandRoom.tsx`
- `apps/herd/modules/command-room/route-metadata.ts`
- `apps/herd/modules/conversation/hooks/use-conversations.ts`
- `apps/herd/modules/commanders/routes/conversation-runtime.ts`
- `apps/herd/modules/commanders/routes/conversation-read-model.ts`
- `apps/herd/modules/commanders/routes/conversation-runtime-state.ts`
- `apps/herd/modules/commanders/routes/conversation-websocket.ts`
- `apps/herd/modules/agents/websocket.ts`
- `apps/herd/modules/agents/components/SessionComposer.tsx`
- `apps/herd/modules/agents/page-shell/use-session-draft.ts`
- `apps/herd/modules/agents/components/session-message-list/render-items.ts`
- `apps/herd/modules/agents/messages/stream-event-machine.ts`
- `apps/herd/modules/agents/queue-state.ts`
- `apps/herd/modules/workspace/use-workspace.ts`
- `apps/herd/modules/workspace/routes.ts`
- `apps/herd/modules/commanders/components/AutomationPanel.tsx`
- `apps/herd/modules/commanders/components/QuestBoard.tsx`
- `apps/herd/src/module-manifest.ts`
- `apps/herd/docs/architecture/command-room.md`
- `apps/herd/docs/architecture/frontend-surfaces.md`

## Owned State/Data

Command Room owns browser preferences such as workspace panel state. Shared
components also own local draft state: the session composer persists
per-session text/images/mode in `localStorage`, and QuestBoard persists its
in-progress create form in `sessionStorage`. Durable conversation, commander,
runtime session, workspace, quest, approval, and automation data are owned by
their modules.

## External Surfaces

- `/command-room`
- `/command-room/inbox`
- `/command-room/settings`
- `/api/conversations/:id`
- `/api/commanders/:id/conversations/bootstrap`
- `/api/conversations/:id/messages`
- `/api/conversations/:id/ws`
- `/api/agents/sessions/:name/ws`
- `/api/conversations/:id/message`
- `/api/agents/sessions/:name/send`
- `/api/commanders/:id/quests`
- `/api/workspace/resolve-reference`

## Coupled Modules

- `commanders`: commander identity, conversations, quest board, heartbeat.
- `conversation`: hooks and embedded UI metadata.
- `agents`: sessions, queue, transcript, websocket.
- `workspace`: file tree, git panel, context insertion, and read-only artifact
  reference targets.
- `approvals`, `settings`, `providers`.
- `automations`: one shared global/commander list-detail panel; default
  presentation is adaptive, while Command Room single-pane is an explicit
  full-swap embedding.
- `commanders`: quest artifacts render as chips; file artifacts resolve through
  Workspace rather than opening raw filesystem paths in the browser.

## When Touching This, Also Inspect

- `apps/herd/docs/module-index.xml`
- `apps/herd/docs/concepts/command-room.md`
- `apps/herd/docs/features/commanders.md`
- `apps/herd/modules/command-room/__tests__/backend-owned-contract-guardrails.test.ts`

## Verification Bundle

```bash
pnpm --filter herd exec vitest run \
  modules/command-room/__tests__/chat-pane.test.ts \
  modules/command-room/__tests__/backend-owned-contract-guardrails.test.ts \
  modules/command-room/components/desktop/__tests__/CommandRoom.chat-start.test.tsx \
  modules/command-room/components/mobile/__tests__/MobileCommandRoom.conversations.test.tsx \
  modules/conversation/__tests__/use-conversations-message.test.tsx \
  modules/conversation/__tests__/use-conversations-start-stop.test.tsx \
  modules/agents/__tests__/MobileSessionShell.test.tsx \
  modules/agents/components/__tests__/SessionComposer.test.tsx \
  modules/commanders/components/__tests__/AutomationPanel.test.tsx \
  modules/commanders/__tests__/QuestBoard.chips.test.tsx
```

## Known Risks / Open Questions

- Sending/queueing availability must come from backend read models and action
  fields, not raw session-name or websocket guesses.
- Commander selection and cold-open use the one-shot conversation bootstrap
  projection. Keep pushed WebSocket list deltas updating both legacy list caches
  and bootstrap projection caches; otherwise idle tabs stop refreshing.
- Mobile and desktop share data but have divergent surfaces; test both when a
  shared hook changes.
- Conversation-bound chat and standalone session chat use different endpoints;
  check both when changing composer behavior.
- Quick and Markdown composer modes share the same send/queue callbacks but
  intentionally differ in Enter behavior and height. Keep the mode contract in
  the shared composer/draft hook, not in desktop or mobile consumers.
- AutomationPanel has three presentation contracts. Do not infer layout from
  scope: `default` is adaptive, `mobile-list` and `single-pane` are full-swap.
- Artifact file previews must remain read-only even when the commander's normal
  Workspace target is writable.
- Sub-agent activity groups correlate by durable transcript ids. Header counts
  must distinguish owners from nested tool calls, and provider-runtime
  boundaries must settle prior running rows in the stream state machine rather
  than through viewport or websocket inference.
