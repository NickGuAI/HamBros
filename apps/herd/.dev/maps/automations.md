# Automations

## Purpose

Map the shared global/commander automation control surface and its server-owned
schedule/runtime contracts. The UI must not fork list/detail behavior or become
the semantic cron authority.

## Source Files

- `apps/herd/modules/commanders/components/AutomationPanel.tsx`
- `apps/herd/modules/automations/hooks/useAutomations.ts`
- `apps/herd/modules/automations/page.tsx`
- `apps/herd/modules/automations/MobileAutomations.tsx`
- `apps/herd/modules/command-room/components/CommandRoom.tsx`
- `apps/herd/modules/commanders/components/CommanderDetailPanel.tsx`
- `apps/herd/modules/automations/cron-validation.ts`
- `apps/herd/modules/automations/cron-validation.server.ts`
- `apps/herd/modules/automations/scheduler.ts`
- `apps/herd/modules/automations/store.ts`
- `apps/herd/modules/automations/routes.ts`
- `apps/herd/modules/commanders/routes/register-command-room.ts`

## Ownership And Flow

```text
/automations              MobileAutomations              Command Room
      \                         |                            /
       +---------------- AutomationPanel ------------------+
                         | scope + presentation
                         v
                 useAutomations hooks/API
                         v
                 store <-> scheduler
                         |
                         v
        bounded-work guard -> pinned node-cron grammar
```

`AutomationPanel` owns shared selection, search, trigger/status filters,
list/detail presentation, editing, actions, history, and run-detail rendering.
Hooks and server routes own persistence and mutation. Scheduler/store own jobs
and run state.

## Presentation Matrix

| Presentation | Narrower than `md` | `md` and wider | Typical consumer |
|---|---|---|---|
| `default` | List → detail full swap with Back | Split list + detail with Close | `/automations`, global center, commander detail |
| `mobile-list` | Full swap | Full swap | `MobileAutomations.tsx` |
| `single-pane` | Full swap | Full swap | Command Room single-pane automation tab |

Scope (`global` or `commander`) selects data; it does not select presentation.
Consumers must not duplicate selection/filter/detail state.

## Cron Authority And Recovery

- Browser `isAutomationCronExpressionComplete` only decides whether a draft has
  at least five non-empty fields. It intentionally does not decide grammar.
- Server `isAutomationCronValidationBounded` rejects zero-step input and caps
  range-expansion work before calling pinned `node-cron` 4.2.1.
- `node-cron` remains the semantic validator. Keep top-level automation routes,
  commander compatibility routes, and org-form browser readiness aligned with
  this division of authority.
- Scheduler initialization registers persisted jobs independently. One invalid
  schedule is skipped without disabling valid jobs, listing, pause, repair,
  resume, or delete APIs.

## External Surfaces

- Desktop and mobile `/automations`.
- Command Room global and commander automation embeddings.
- Commander detail and schedule-only automation embeddings.
- `/api/automations` list/create and `/:id` detail/update/delete APIs.
- `/api/automations/:id/run`, `/:id/history`, and `/:id/runs/:key` run APIs.
- Commander compatibility automation routes registered through
  `modules/commanders/routes/register-command-room.ts`.

## Coupled Modules

- Commanders for scope, compatibility routes, and Command Room embedding.
- Agents/providers/machines for runtime selection and execution.
- Org automation forms for browser-side schedule readiness.
- Quest events for quest-triggered automation scheduling.
- Skill discovery and run artifacts/report rendering.

## When Touching This, Also Inspect

- `apps/herd/.dev/maps/command-room.md`
- `apps/herd/.dev/maps/mobile-desktop-ui.md`
- `apps/herd/modules/automations/executor.ts`
- `apps/herd/modules/automations/types.ts`
- `apps/herd/modules/commanders/components/automation-schedule.ts`
- `apps/herd/modules/org/forms/helpers.ts`
- `apps/herd/modules/org/forms/constants.ts`

## Verification

Use the Automations bundle in `apps/herd/.dev/VERIFY.md`. It covers the
shared panel and each embedding, cron browser/server parity, compatibility-route
errors, scheduler resource bounds, and invalid persisted-schedule isolation.

## Risks

- A second list/detail implementation drifts on filters, actions, and history.
- Treating a responsive breakpoint as a scope rule breaks embedded consumers.
- Reimplementing cron grammar in the browser diverges from the pinned runtime.
- Throwing on the first invalid persisted schedule can make the repair API
  unavailable on first boot.
