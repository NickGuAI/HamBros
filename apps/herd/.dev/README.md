# Herd .dev Context

This directory is the code-grounded maintenance map for Herd. Use it before
changing runtime sessions, Command Room, the shared session composer,
automations, quest/task artifacts, installer/release/CLI behavior, providers,
or mobile/desktop UI.

It is not a second source of truth. The source of truth remains the code and
docs cited in each file.

```text
+---------------------------+
| Start with README/ROUTING |
+-------------+-------------+
              |
              v
+---------------------------+
| Read the relevant map     |
| maps/*.md                 |
+-------------+-------------+
              |
              v
+---------------------------+
| Follow the playbook       |
| playbooks/*.md            |
+-------------+-------------+
              |
              v
+---------------------------+
| Prove with VERIFY.md      |
| and record in EVALUATION  |
+---------------------------+
```

## Files

| File | Use |
|---|---|
| `ROUTING.md` | Start here when touching a subsystem. |
| `COUPLINGS.md` | Cross-module dependencies and ownership boundaries. |
| `VERIFY.md` | Verification bundles by change type. |
| `SOP_INDEX.md` | Install, release, CLI, and ops source pointers. |
| `EVALUATION.md` | Evidence used to generate and check this directory. |
| `maps/` | Source-backed subsystem maps. |
| `playbooks/` | Change-specific runbooks. |
| `techdebt/` | Current unresolved debt and shipped mitigations that future work must not forget. |

## High-Risk Boundaries

- Runtime session state is owned by SQLite/backend DTOs, not by UI inference:
  `apps/herd/server/db/schema.ts`,
  `apps/herd/modules/agents/session/sqlite-runtime-store.ts`,
  `apps/herd/modules/agents/session/state.ts`.
- Agents routes wait for persisted session restore before serving
  `/api/agents/*`:
  `apps/herd/modules/agents/routes-core.ts`,
  `apps/herd/modules/agents/persistence-helpers.ts`,
  `apps/herd/modules/agents/session/persistence.ts`. Keep
  `runtime_state_json` small enough to read at restart. Oversized replay events
  in SQLite rows can make the first protected agents request look like UI click
  latency even while `/api/health` stays fast.
- Command Room composes data from agents, commanders, conversations, workspace,
  approvals, automations, and settings:
  `apps/herd/modules/command-room/components/CommandRoom.tsx`,
  `apps/herd/docs/module-index.xml`.
- Desktop and mobile session surfaces share one composer and one per-session
  draft owner. Quick and Markdown modes, keyboard semantics, draft-mode
  persistence, IME guards, queueing, and responsive height all meet in
  `apps/herd/modules/agents/components/SessionComposer.tsx` and
  `apps/herd/modules/agents/page-shell/use-session-draft.ts`.
- Automation list/detail behavior is shared across the global page, commander
  Command Room, and mobile surfaces through
  `apps/herd/modules/commanders/components/AutomationPanel.tsx`. Cron
  grammar belongs to pinned `node-cron`; the server-owned resource guard and
  scheduler isolation live in
  `apps/herd/modules/automations/cron-validation.server.ts` and
  `apps/herd/modules/automations/scheduler.ts`.
- Quest artifacts are explicit `{ type, label, href }` records. File artifacts
  cross into Workspace through authenticated, ephemeral, read-only targets;
  all seven target/file/git mutation routes must retain the shared
  writable-target guard in
  `apps/herd/modules/workspace/routes.ts` and
  `apps/herd/modules/workspace/resolver.ts`. Task lifecycle moves must
  rewrite those file references through
  `ai-state/claude/skills/task-system-maintenance/scripts/task_lifecycle.py`.
- Channel-impacting changes are cross-surface changes even when the edited file
  is not under `modules/channels/*`. Session create/resume, queue/send,
  conversation read models, transcript projection, shared chat rendering, and
  Markdown behavior can all break WhatsApp/email/etc. A successful external send
  is not enough: inspect inbound adapter/runtime, surface binding, conversation
  metadata, automatic reply dispatch, transcript projection, delivery status,
  and visible Command Room rendering before declaring done. Evidence must trace
  the same external peer, same `conversationId`, and same assistant reply text
  across transcript JSONL, message API, provider delivery, desktop UI, mobile
  UI, copy/export, delivery status, and provider runtime health after relaunch.
  Follow `playbooks/channel-impacting-change.md` and paste its `Channel
  Critical Review Packet` into the issue or PR before merge, relaunch signoff,
  or final handoff.
- Install/release/CLI changes must stay aligned across
  `apps/herd/install.sh`, `operations/deploy/ec2/install-ec2.sh`,
  `operations/scripts/launch_herd.sh`,
  `operations/sops/SOP-15-release-herd.md`, and
  `packages/herd-cli/src/`.
- Production UI styling uses the Herd/Sumi-e token implementation in
  `apps/herd/src/styles/hervald/tokens.css` and
  `apps/herd/src/lib/hv-tokens.ts`. Use `--hv-*` tokens from those files
  for app UI; `docs/design-systems/sumi-e/` is reference material, not the
  runtime stylesheet.

## Update Triggers

Update this directory when any of these change:

- SQLite schema, runtime-session DTOs, migration/readiness scripts, or session
  control/query routes.
- Persisted-session restore, transcript replay fallback, `runtime_state_json`
  payload shape, or agents route startup gates.
- Command Room routing, shared composer mode/key behavior, conversation
  websocket behavior, workspace context, or queue behavior.
- Automation list/detail presentation, filtering, editing, run history, cron
  validation, scheduler registration, or persisted-schedule recovery.
- Quest artifact contracts, artifact href validation, Workspace reference
  resolution/read-only enforcement, quest CLI artifact commands, or
  `~/tasks` lifecycle create/move/index/reference rewriting.
- Channel provider adapters, channel bindings, surface binding resolution,
  inbound external messages, automatic outbound replies, channel-visible
  transcripts, or channel management UI.
- Installer, launch, EC2 deploy, public release sync, CLI onboarding/up/doctor,
  worker/session CLI output, or docs commands.
- Provider registry/adapters, provider auth, machine auth, model selection, or
  provider context persistence.
- Mobile/desktop split, shared hooks, or UI tests that encode responsive
  behavior.
- New production incidents that leave mitigations or follow-up work should add
  or update a file under `techdebt/`.
