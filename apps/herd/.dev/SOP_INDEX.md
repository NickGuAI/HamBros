# SOP Index

## Install And Launch

| Source | Why it matters |
|---|---|
| `apps/herd/install.sh` | Local/public installer, hermetic Node/pnpm setup, build, and `db:ready`. |
| `apps/herd/server/routes/install-script.ts` | Serves the public `/install.sh` installer route. |
| `operations/deploy/ec2/install-ec2.sh` | EC2 deploy/install path and service setup. |
| `operations/deploy/ec2/README.md` | Direct-ALB topology, port contract, install, verification, restart, upgrade, and backup runbook. |
| `operations/deploy/ec2/herd.service` | systemd service command/env for the production Node listener. |
| `operations/scripts/launch_herd.sh` | Managed launch path; runs build and SQLite readiness before serving. |
| `apps/herd/server/index.ts` | Server boot fail-closed DB readiness guard. |
| `apps/herd/docs/troubleshoot.md` | Operator remediation for DB readiness/migration failures. |

## Release

| Source | Why it matters |
|---|---|
| `operations/sops/SOP-15-release-herd.md` | Current public Herd release sync process. |
| `operations/sops/scripts/sop-15-sync-herd.sh` | Mirrors source into `releases/herd`. |
| `operations/sops/scripts/check-herd-cleanliness.sh` | Public snapshot cleanliness gate. |
| `apps/herd/public/repo-root/` | Public root assets copied to Herd. |
| `apps/herd/docs/reference/naming.md` | Public naming contract. |

## CLI

| Source | Why it matters |
|---|---|
| `packages/herd-cli/src/index.ts` | Top-level command routing. |
| `apps/herd/herd-cli.mjs` | App-local shim that delegates to `@gehirn/herd-cli`. |
| `packages/herd-cli/src/up.ts` | Foreground and managed local startup. |
| `packages/herd-cli/src/doctor.ts` | Local readiness report. |
| `packages/herd-cli/src/session.ts` | Session list/info/register/heartbeat/events/unregister. |
| `packages/herd-cli/src/workers.ts` | Worker list/status/dispatch/send/kill/cleanup. |
| `packages/herd-cli/src/quests.ts` | Quest create/claim/note/terminal-state commands, explicit artifact add/remove, and machine-readable `QUEST_CLAIM_HANDOFF`. |
| `packages/herd-cli/src/session-contract.ts` | Shared session/worker contract helpers. |
| `apps/herd/docs/reference/cli.md` | Operator-facing CLI reference. |

## Quest Artifacts And Task Lifecycle

| Source | Why it matters |
|---|---|
| `apps/herd/modules/commanders/quest-artifact-href.ts` | Shared UI/server artifact href validation for file, URL, GitHub issue, and GitHub PR types. |
| `apps/herd/modules/commanders/components/QuestBoard.tsx` | Always-visible artifact chips, add/remove UI, and read-only file preview entrypoint. |
| `apps/herd/modules/workspace/routes.ts` | Authenticated reference resolution and the central writable-target gate on every mutation route. |
| `apps/herd/modules/workspace/resolver.ts` | Path containment and read-only workspace invariant. |
| `apps/herd/modules/workspace/git.ts` | Defense-in-depth read-only check for git initialization. |
| `packages/herd-cli/src/quests.ts` | CLI artifact create/add/remove behavior and safe replacement of legacy invalid hrefs. |
| `ai-state/claude/skills/create-quests/SKILL.md` | Creates quest briefs and attaches explicit task artifacts. |
| `ai-state/claude/skills/task-system-maintenance/scripts/task_lifecycle.py` | Deterministic task create/move, index regeneration, and task/quest reference rewriting. |
| `ai-state/claude/skills/task-system-maintenance/scripts/audit.py` | Staleness and backlink audit using explicit file artifacts. |
| `agent-skills/pkos/task-system-maintenance/` | GehirnSkills submodule counterpart; keep behavior and contract tests aligned with the tracked runtime copy. |
| `apps/herd/.dev/playbooks/quest-task-artifact-change.md` | Cross-module review order and contrarian checks for quest/task artifact changes. |

## Channels

| Source | Why it matters |
|---|---|
| `apps/herd/.dev/playbooks/channel-impacting-change.md` | Mandatory critical review SOP and `Channel Critical Review Packet` for WhatsApp, email, Slack, Discord, Telegram, Google Chat, and future external-channel changes. |
| `apps/herd/.dev/maps/channels.md` | Source-backed ownership map for adapter runtime, surface binding, conversation runtime, transcript projection, outbound reply dispatch, and visible transcript rendering. |
| `apps/herd/.dev/learnings/2026-06-24-claude-codex-channel-turn-sequencing.md` | Provider sequencing note for automatic channel replies: Claude/Codex `clientSendId`, provider `turnId`, and Codex `turn/steer` do not line up the same way. |
| `apps/herd/modules/channels/runtime.ts` | Starts enabled channel adapter runtimes and owns inbound provider lifecycle. |
| `apps/herd/modules/channels/resolver.ts` | Resolves inbound channel events to commander and conversation targets. |
| `apps/herd/modules/channels/surface-binding-store.ts` | Persists the external surface to conversation binding used for replies. |
| `apps/herd/modules/commanders/routes/conversation-runtime.ts` | Starts/resumes conversation sessions, installs automatic reply forwarders, projects message pages, and records delivery state. |
| `apps/herd/modules/commanders/channel-dispatchers.ts` | Dispatches assistant replies back to the provider adapter. |
| `apps/herd/modules/agents/messages/history.ts` | Projects transcript events and schema-v2 envelopes into Command Room messages. |
| `apps/herd/modules/agents/components/session-message-list/blocks.tsx` | Renders the visible chat transcript; raw copy success does not prove this layer works. |

## Architecture Docs

| Source | Why it matters |
|---|---|
| `apps/herd/docs/module-index.xml` | Source-backed module ownership and route map. |
| `apps/herd/docs/features/commanders.md` | Commander/conversation/runtime boundary. |
| `apps/herd/docs/features/providers.md` | Provider registry vs runtime boundary. |
| `apps/herd/docs/concepts/command-room.md` | Command Room composition boundary. |
