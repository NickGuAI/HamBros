# Mobile And Desktop UI

## Purpose

Track shared state/hooks and divergent mobile/desktop surfaces so responsive
changes do not accidentally fork backend contracts.

## Source Files

- `apps/herd/modules/command-room/components/CommandRoom.tsx`
- `apps/herd/modules/command-room/components/mobile/MobileCommandRoom.tsx`
- `apps/herd/modules/command-room/components/desktop/SessionsColumn.tsx`
- `apps/herd/modules/agents/page-shell/MobileSessionShell.tsx`
- `apps/herd/modules/agents/page-shell/MobileSessionView.tsx`
- `apps/herd/modules/agents/components/SessionComposer.tsx`
- `apps/herd/modules/agents/page-shell/use-session-draft.ts`
- `apps/herd/modules/commanders/components/AutomationPanel.tsx`
- `apps/herd/modules/automations/MobileAutomations.tsx`
- `apps/herd/modules/workspace/components/WorkspacePanel.tsx`
- `apps/herd/modules/approvals/MobileInbox.tsx`
- `apps/herd/src/hooks/use-is-mobile.ts`
- `apps/herd/src/surfaces/desktop/Shell.tsx`
- `apps/herd/src/surfaces/mobile/MobileShell.tsx`
- `apps/herd/src/surfaces/mobile/MobileNavigationDrawer.tsx`
- `apps/herd/src/lib/api-base.ts`
- `apps/herd/src/styles/hervald/tokens.css`
- `apps/herd/src/lib/hv-tokens.ts`
- `apps/herd/capacitor.config.ts`
- `apps/herd/docs/guides/ios-build-guide.md`

## Owned State/Data

UI surfaces should own presentation state only. Runtime state, allowed actions,
conversation state, queues, and workspace data come from backend hooks/routes.
Visual language is owned by the production Herd/Sumi-e token layer:
`src/styles/hervald/tokens.css` for CSS custom properties and
`src/lib/hv-tokens.ts` for canvas/runtime token reads.

## External Surfaces

- Desktop: `/command-room`
- Mobile: `/command-room`, `/command-room/inbox`, `/command-room/settings`
- Automations: desktop `/automations`, mobile `/automations`, and Command Room
  automation panels
- Shared APIs: `/api/conversations/*`, `/api/agents/sessions/*`,
  `/api/approvals/*`, `/api/workspace/*`

## Coupled Modules

- Conversation hooks and Command Room shell.
- Agents mobile session shell and shared composer.
- Shared AutomationPanel with default, mobile-list, and single-pane
  presentation contracts.
- Workspace panel and context payload.
- Approvals mobile inbox.

## Verification Bundle

```bash
pnpm --filter herd exec vitest run \
  src/surfaces/__tests__/surface-invariants.test.ts \
  src/hooks/__tests__/use-is-mobile.coarse-pointer.test.ts \
  src/lib/__tests__/api-base.test.ts \
  modules/agents/__tests__/MobileSessionShell.test.tsx \
  modules/agents/__tests__/MobileSessionView.test.tsx \
  modules/command-room/__tests__/hervald-routing.test.ts \
  modules/command-room/__tests__/chat-pane.test.ts \
  modules/command-room/components/mobile/__tests__/MobileCommandRoom.test.tsx \
  modules/command-room/components/mobile/__tests__/MobileCommandRoom.workspace.test.tsx \
  modules/command-room/components/desktop/__tests__/CommandRoom-context.test.tsx \
  modules/agents/components/__tests__/SessionComposer.test.tsx \
  modules/commanders/components/__tests__/AutomationPanel.test.tsx \
  modules/automations/__tests__/MobileAutomations.test.tsx \
  modules/workspace/components/__tests__/WorkspacePanel-context.test.tsx \
  modules/settings/__tests__/MobileSettings.test.tsx
```

## Known Risks / Open Questions

- Desktop and mobile may render different controls, but they must consume the
  same backend action rules.
- Avoid solving mobile behavior by hiding a control without checking backend
  sendability/queueability rules.
- Composer Markdown mode grows to 45% of its nearest owning resize root; quick
  mode restores the desktop/mobile compact cap. Every embedding must preserve
  that root rather than size against the whole viewport accidentally.
- Default AutomationPanel presentation swaps list to detail below `md` and
  preserves a split at `md` and above. Explicit mobile-list and single-pane
  presentations stay full-swap at every width.
