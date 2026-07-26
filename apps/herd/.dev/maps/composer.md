# Shared Session Composer

## Purpose

Map the one composer used by desktop Command Room, mobile Command Room, and
standalone mobile sessions. Mode, keyboard, draft, queue, and resize behavior
must stay shared even though each embedding owns its send/queue callbacks.

## Source Files

- `apps/herd/modules/agents/components/SessionComposer.tsx`
- `apps/herd/modules/agents/page-shell/use-session-draft.ts`
- `apps/herd/modules/agents/page-shell/MobileSessionShell.tsx`
- `apps/herd/modules/agents/page-shell/MobileSessionView.tsx`
- `apps/herd/modules/command-room/components/desktop/CenterColumn.tsx`
- `apps/herd/modules/command-room/components/mobile/MobileChatView.tsx`
- `apps/herd/modules/command-room/components/CommandRoom.tsx`
- `apps/herd/modules/agents/components/session-message-list/blocks.tsx`
- `apps/herd/src/index.css`

## Ownership And Flow

```text
embedding surface
  -> backend-owned sendReady/disabled + queue snapshot
  -> SessionComposer
       -> useSessionDraft(sessionName, variant)
       -> localStorage: text + images + quick/markdown mode
       -> onSend(payload) or onQueue(payload)
  -> embedding surface owns API mutation and success/failure result
```

The composer owns draft presentation and persistence. It does not decide
whether a backend session can send, resume, or queue. The embedding supplies
those rules and the callbacks. A rejected send restores the exact text, mode,
images, selected abilities, and Workspace context snapshot.

## Mode Contract

| Behavior | Quick | Markdown |
|---|---|---|
| Enter | Send | Newline |
| Shift+Enter | Newline | Newline |
| Cmd/Ctrl+Enter | Send | Send |
| Tab | Queue when available | Queue when available |
| Height | Desktop 120px / mobile 148px cap | 45% of nearest composer resize root, never below compact cap |

- Cmd/Ctrl+Shift+M toggles the mode.
- Multiline paste promotes quick mode to Markdown without changing the text.
- IME composition and the immediate composition-end race cannot send or queue.
- Mode persists per `sessionName`; clearing the draft returns to quick mode.
- Markdown is an editing mode, not a second preview pane or a different payload
  contract.

## External Surfaces

- Desktop and mobile `/command-room` composer embeddings.
- Standalone mobile agent-session composer embedding.
- `/api/conversations/:id/message` for conversation-bound sends.
- `/api/agents/sessions/:name/send` for standalone sends and
  `POST /api/agents/sessions/:name/message?queue=true` for queue submission.
- Per-session `herd:draft:*`, `herd:draft-images:*`, and
  `herd:draft-mode:*` browser storage keys.

## Coupled Modules

- Command Room conversation read/send state and standalone agent session state.
- Agent queue snapshots/mutations and message image constraints.
- Workspace file, directory, and annotation context payloads.
- Settings-owned composer abilities/skill slots and transcription hooks.
- Shared transcript Markdown rendering for visible sent content.

## When Touching This, Also Inspect

- `apps/herd/.dev/maps/command-room.md`
- `apps/herd/.dev/maps/mobile-desktop-ui.md`
- `apps/herd/.dev/playbooks/command-room-change.md`
- `apps/herd/modules/agents/queue-state.ts`
- `apps/herd/modules/agents/queue-mutation.ts`
- `apps/herd/modules/workspace/use-workspace.ts`
- the Channels bundle in `apps/herd/.dev/VERIFY.md` when changing shared
  Markdown rendering, session send/resume, or transcript-visible content.

## Verification

Use the Session Composer bundle in `apps/herd/.dev/VERIFY.md`. It directly
covers `SessionComposer.test.tsx` and shared Markdown rendering in
`session-message-list/__tests__/blocks.test.tsx`. Add the Mobile/desktop UI
bundle when an embedding or resize root changes.

## Risks

- Implementing mode keys in an embedding forks desktop/mobile behavior.
- Sizing against `window.innerHeight` when an owning pane exists makes the
  Markdown editor overflow nested Command Room surfaces.
- Clearing local text before an async send is accepted can lose draft context;
  preserve and restore the complete snapshot on failure.
- Keyboard tests must include IME and repeated-send races, not only ordinary
  Enter events.
