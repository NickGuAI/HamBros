# Evaluation

## 2026-06-21 Initial Generation

Project root: `/home/builder/App/apps/herd`

Output: `/home/builder/App/apps/herd/.dev`

## Files Inspected

- `apps/herd/docs/module-index.xml`
- `apps/herd/src/module-manifest.ts`
- `apps/herd/docs/architecture/agents.md`
- `apps/herd/docs/architecture/command-room.md`
- `apps/herd/docs/architecture/frontend-surfaces.md`
- `apps/herd/docs/features/commanders.md`
- `apps/herd/docs/features/providers.md`
- `apps/herd/docs/concepts/command-room.md`
- `apps/herd/docs/reference/cli.md`
- `apps/herd/docs/troubleshoot.md`
- `apps/herd/package.json`
- `apps/herd/install.sh`
- `apps/herd/server/index.ts`
- `apps/herd/server/db/schema.ts`
- `apps/herd/server/db/readiness.ts`
- `apps/herd/tools/db-ready.ts`
- `apps/herd/tools/migrate-sqlite.ts`
- `apps/herd/modules/agents/session/state.ts`
- `apps/herd/modules/agents/session/sqlite-runtime-store.ts`
- `apps/herd/modules/agents/routes/session-query-routes.ts`
- `apps/herd/modules/agents/routes/session-control-routes.ts`
- `apps/herd/modules/agents/routes-core.ts`
- `apps/herd/modules/agents/websocket.ts`
- `apps/herd/modules/agents/transcript-store.ts`
- `apps/herd/modules/command-room/components/CommandRoom.tsx`
- `apps/herd/modules/command-room/components/mobile/MobileCommandRoom.tsx`
- `apps/herd/modules/conversation/hooks/use-conversations.ts`
- `apps/herd/modules/commanders/routes/conversation-read-model.ts`
- `apps/herd/modules/commanders/routes/conversation-runtime.ts`
- `apps/herd/modules/commanders/routes/conversation-runtime-state.ts`
- `apps/herd/modules/commanders/routes/conversation-websocket.ts`
- `apps/herd/src/surfaces/`
- `apps/herd/src/hooks/use-is-mobile.ts`
- `apps/herd/src/lib/api-base.ts`
- `apps/herd/capacitor.config.ts`
- `packages/herd-cli/src/up.ts`
- `packages/herd-cli/src/doctor.ts`
- `packages/herd-cli/src/session.ts`
- `packages/herd-cli/src/workers.ts`
- `operations/deploy/ec2/install-ec2.sh`
- `operations/deploy/ec2/Caddyfile`
- `operations/deploy/ec2/hervald.service`
- `operations/scripts/launch_herd.sh`
- `operations/sops/SOP-15-release-herd.md`

## Commands Run

```bash
pnpm --filter @gehirn/herd-cli test -- up.test.ts doctor.test.ts workers.test.ts session.test.ts
pnpm --filter @gehirn/herd-cli build
pnpm --filter herd run db:ready -- --source-root ~/.herd --db ~/.herd/herd.sqlite
pnpm --filter herd run docs:check
make -C agent-skills test
make fmt && make test && make lint
find apps/herd/.dev -maxdepth 3 -type f | sort
rg -n "runtime session|Command Room|install|release|CLI|mobile|desktop|agent_runtime_sessions" apps/herd/.dev
```

Result: targeted CLI tests and build passed; SQLite readiness passed; docs guardrail passed; agent skill validation passed; root formatter/test/lint gate passed; fixture files and keyword coverage were inspected.

## Review Roles

- topology/module reviewer: subagent `019eec3d-fc74-7ee3-b7eb-262a69992a25`
  inspected runtime sessions, Command Room, conversation read models, and
  websocket ownership.
- verification/test reviewer: subagent `019eec3e-0de9-74e0-afb2-07eafd4468ce`
  mapped tests and commands for runtime, Command Room, providers, CLI, install,
  release, and mobile/desktop UI.
- release/install/ops reviewer: subagent `019eec3e-1f26-7d23-a8af-5f102f2c71a8`
  mapped installer, EC2 deploy, split-shell launch, public release, CLI, and DB
  readiness coupling.
- contrarian reviewer: performed in the main thread because the subagent
  concurrency limit blocked a fourth explorer.

## Unsupported Assumptions Rejected

- Rejected: Command Room owns durable runtime state. Evidence:
  `apps/herd/docs/module-index.xml` marks Command Room as composed UI and
  browser preference owner only.
- Rejected: Provider registry owns live process state. Evidence:
  `apps/herd/docs/features/providers.md` separates provider registry
  metadata from agents runtime sessions/process handles.
- Rejected: SQLite readiness belongs only to server boot. Evidence:
  `apps/herd/install.sh`, `operations/deploy/ec2/install-ec2.sh`, and
  `operations/scripts/launch_herd.sh` also call `db:ready`.
- Rejected: CLI worker/session status can be treated as a separate lifecycle
  model. Evidence: backend DTOs expose `state`, `allowedActions`, and
  `disabledReasons` from `modules/agents/session/state.ts` and query routes.
- Rejected: browser automation is an existing fixture requirement. Evidence:
  `apps/herd` has `vitest.config.ts` and no `playwright.config.*` under
  the app root.

## Gaps For Human Review

- No browser screenshot pass was run for Command Room/mobile UI because this
  fixture does not change UI rendering.

## 2026-07-06 Runtime Restore Refresh

Project root: `/home/builder/App/apps/herd`

Output: `/home/builder/App/apps/herd/.dev`

Current source head: `f4bb405e3 (HEAD -> dev, origin/dev) Fix Herd runtime restore latency`

## Files Inspected

- `apps/herd/CLAUDE.md`
- `.claude/rules/herd.md`
- `apps/herd/docs/llms.txt`
- `apps/herd/docs/architecture/agents.md`
- `apps/herd/docs/architecture/module-runtime.md`
- `apps/herd/docs/architecture/routes-and-apis.md`
- `apps/herd/docs/troubleshoot.md`
- `apps/herd/.dev/README.md`
- `apps/herd/.dev/ROUTING.md`
- `apps/herd/.dev/COUPLINGS.md`
- `apps/herd/.dev/VERIFY.md`
- `apps/herd/.dev/SOP_INDEX.md`
- `apps/herd/.dev/maps/runtime-sessions.md`
- `apps/herd/.dev/maps/channels.md`
- `apps/herd/.dev/playbooks/sqlite-runtime-session-change.md`
- `apps/herd/.dev/playbooks/channel-impacting-change.md`
- `apps/herd/.dev/learnings/*.md`
- `apps/herd/modules/agents/routes-core.ts`
- `apps/herd/modules/agents/persistence-helpers.ts`
- `apps/herd/modules/agents/session/persistence.ts`
- `apps/herd/modules/agents/session/sqlite-runtime-store.ts`
- `apps/herd/modules/agents/session/__tests__/sqlite-runtime-store.test.ts`
- `apps/herd/server/db/schema.ts`
- `operations/scripts/launch_herd.sh`
- `operations/deploy/ec2/smoke-test.sh`
- `operations/logs/server/herd/latest/launch.log`

## Commands Run

```bash
git fetch origin dev
git log -1 --oneline --decorate
find apps/herd/.dev -maxdepth 3 -type f | sort
find apps/herd/.dev -maxdepth 2 -type f | sort
rg -n "restorePersistedSessionsReady|readSqlitePersistedSessionsState|runtime_state_json|compactRuntimeStateEvents|LEGACY_RUNTIME_EVENTS_STRIP|MAX_RUNTIME_STATE_EMBEDDED_EVENTS|sqlite-runtime-store.test" apps/herd/modules/agents apps/herd/server apps/herd/.dev apps/herd/docs .claude/rules/herd.md
rg -n "Failed to restore persisted session|Unexpected end of JSON input|bubblewrap|ERROR|unhandled|uncaught|crash|restart" operations/logs/server/herd/latest/launch.log
pnpm --filter herd run docs:check
rg -n <deleted 2026-06-23 channel learning filename patterns> apps/herd/.dev .claude/rules/herd.md apps/herd/docs
bash operations/deploy/ec2/smoke-test.sh
curl -fsS -w '\nstatus=%{http_code} total=%{time_total}\n' https://herd.gehirn.ai/api/health
git status --short --branch
```

Result: docs guardrail passed. The superseded channel learning filenames have
no remaining references. Direct-ALB topology passed. Public health returned
`200` on version `f4bb405e3`.

## Review Roles

- topology/module reviewer: performed in the main thread against agents routes,
  persistence helpers, SQLite runtime store, and runtime-session map.
- verification/test reviewer: performed in the main thread against
  `VERIFY.md`, the runtime-session Vitest bundle, `docs:check`, and production
  health/direct-listener probes.
- release/install/ops reviewer: performed in the main thread against
  `operations/scripts/launch_herd.sh`,
  `operations/deploy/ec2/smoke-test.sh`, and the active launch log.
- contrarian reviewer: performed in the main thread. The refresh removed
  duplicate dated channel incident learnings only after confirming the durable
  guidance is already consolidated in `playbooks/channel-impacting-change.md`,
  `maps/channels.md`, and `VERIFY.md`.

## Unsupported Assumptions Rejected

- Rejected: `/api/health` proves agents route responsiveness. Evidence:
  `apps/herd/modules/agents/routes-core.ts` gates agents routes on
  `restorePersistedSessionsReady`, while health does not use that router.
- Rejected: large `runtime_state_json` rows are only a storage-size issue.
  Evidence: `apps/herd/modules/agents/persistence-helpers.ts` calls
  `readSqlitePersistedSessionsState` before provider restore, and
  `apps/herd/modules/agents/session/sqlite-runtime-store.ts` parses each
  projected row.
- Rejected: old per-incident channel learning files must remain because they
  are useful. Evidence: their reusable rules are now in
  `apps/herd/.dev/playbooks/channel-impacting-change.md`,
  `apps/herd/.dev/maps/channels.md`, and
  `apps/herd/.dev/VERIFY.md`; `rg` found no remaining references to the
  deleted filenames.

## Gaps For Human Review

- No browser screenshot pass was run because this refresh only changed `.dev`
  documentation and one path-scoped rule file.
- The new techdebt note records remaining runtime restore follow-ups; it does
  not implement the one-off SQLite compaction or restore telemetry work.

## 2026-07-23 Composer, Automations, And Task Artifacts Refresh

Evaluated worktree: `/home/builder/.factory/atlas-dev-release-20260723/apps/herd`

Output: `/home/builder/.factory/atlas-dev-release-20260723/apps/herd/.dev`

Canonical checkout path: `/home/builder/App/apps/herd/.dev`

Source state evaluated: `dc45546d8b3b883e3b1ac42f62e2515272b52fc0`
(`origin/dev`, release PR #1988 before this documentation-only refresh).

## Files Inspected

- `apps/herd/CLAUDE.md`
- `.claude/rules/herd.md`
- `apps/herd/docs/module-index.xml`
- `apps/herd/docs/architecture/workspace.md`
- `apps/herd/docs/architecture/command-room.md`
- `apps/herd/package.json`
- root `package.json` and `Makefile`
- all core files and affected maps/playbooks under `apps/herd/.dev/`
- `apps/herd/modules/agents/components/SessionComposer.tsx`
- `apps/herd/modules/agents/page-shell/use-session-draft.ts`
- `apps/herd/modules/agents/page-shell/MobileSessionShell.tsx`
- `apps/herd/modules/command-room/components/desktop/CenterColumn.tsx`
- `apps/herd/modules/agents/components/__tests__/SessionComposer.test.tsx`
- `apps/herd/modules/agents/components/session-message-list/__tests__/blocks.test.tsx`
- `apps/herd/modules/commanders/components/AutomationPanel.tsx`
- `apps/herd/modules/automations/page.tsx`
- `apps/herd/modules/automations/MobileAutomations.tsx`
- `apps/herd/modules/automations/hooks/useAutomations.ts`
- `apps/herd/modules/automations/cron-validation.ts`
- `apps/herd/modules/automations/cron-validation.server.ts`
- `apps/herd/modules/automations/scheduler.ts`
- `apps/herd/modules/automations/store.ts`
- `apps/herd/modules/commanders/routes/register-command-room.ts`
- automation panel, page, mobile, cron, scheduler, first-boot, route, org-form,
  and Command Room routing tests named by the Automations bundle in `VERIFY.md`
- `apps/herd/modules/commanders/components/QuestBoard.tsx`
- `apps/herd/modules/commanders/quest-artifact-href.ts`
- `apps/herd/modules/commanders/quest-store.ts`
- `apps/herd/modules/commanders/routes/register-quests.ts`
- `apps/herd/modules/workspace/routes.ts`
- `apps/herd/modules/workspace/resolver.ts`
- `apps/herd/modules/workspace/capability.ts`
- `apps/herd/modules/workspace/git.ts`
- `apps/herd/modules/workspace/use-workspace.ts`
- `packages/herd-cli/src/quests.ts`
- `ai-state/claude/skills/create-quests/SKILL.md`
- `ai-state/claude/skills/task-system-maintenance/SKILL.md`
- `ai-state/claude/skills/task-system-maintenance/scripts/audit.py`
- `ai-state/claude/skills/task-system-maintenance/scripts/task_lifecycle.py`
- the corresponding tracked and submodule contract tests

## Commands Run

All verification commands ran with `OPENAI_API_KEY` removed. No OpenAI API
request was needed for this refresh or its release verification.

```bash
pnpm install --frozen-lockfile --prefer-offline
git submodule update --init agent-skills
env -u OPENAI_API_KEY pnpm --filter herd run build:deps

env -u OPENAI_API_KEY pnpm --filter herd exec vitest run \
  modules/agents/components/__tests__/SessionComposer.test.tsx \
  modules/agents/components/session-message-list/__tests__/blocks.test.tsx

env -u OPENAI_API_KEY pnpm --filter herd exec vitest run \
  modules/automations/__tests__/cron-validation-parity.test.ts \
  modules/automations/__tests__/first-boot.test.ts \
  modules/automations/__tests__/scheduler-lifecycle.test.ts \
  modules/automations/__tests__/AutomationsPage.test.tsx \
  modules/automations/__tests__/MobileAutomations.test.tsx \
  modules/commanders/components/__tests__/AutomationPanel.test.tsx \
  modules/commanders/__tests__/routes.test.ts \
  modules/org/forms/__tests__/helpers.test.ts \
  modules/org/forms/__tests__/useNewAutomationWizardForm.test.tsx \
  modules/command-room/components/desktop/__tests__/CommandRoom-context.test.tsx \
  modules/command-room/__tests__/hervald-routing.test.ts

env -u OPENAI_API_KEY pnpm --filter herd exec vitest run \
  modules/commanders/__tests__/QuestBoard.chips.test.tsx \
  modules/commanders/__tests__/register-quests.test.ts \
  modules/commanders/__tests__/route-parsers.test.ts \
  modules/agents/__tests__/routes-workspace-tilde.test.ts \
  modules/agents/__tests__/routes-workspace.test.ts \
  modules/workspace/__tests__/service.test.ts \
  modules/agents/components/session-message-list/__tests__/blocks.test.tsx

env -u OPENAI_API_KEY pnpm --filter @gehirn/herd-cli exec vitest run \
  src/__tests__/quests.test.ts

env -u OPENAI_API_KEY PYTHONDONTWRITEBYTECODE=1 python3 -m unittest \
  ai-state/claude/skills/context-explore/tests/test_contract.py \
  ai-state/claude/skills/create-quests/tests/test_contract.py \
  ai-state/claude/skills/domain-distill/tests/test_contract.py \
  ai-state/claude/skills/knowledge-search/tests/test_discovery.py \
  ai-state/claude/skills/problem-analysis/tests/test_contract.py \
  ai-state/claude/skills/task-system-maintenance/tests/test_audit.py \
  ai-state/claude/skills/task-system-maintenance/tests/test_task_lifecycle.py \
  ai-state/claude/skills/wide-research/tests/test_contract.py

(cd agent-skills && env -u OPENAI_API_KEY PYTHONDONTWRITEBYTECODE=1 \
  python3 -m unittest \
    commander-ops/context-explore/tests/test_contract.py \
    commander-ops/create-quests/tests/test_contract.py \
    commander-ops/problem-analysis/tests/test_contract.py \
    integrations/wide-research/tests/test_contract.py \
    pkos/domain-distill/tests/test_contract.py \
    pkos/knowledge-search/tests/test_discovery.py \
    pkos/task-system-maintenance/tests/test_audit.py \
    pkos/task-system-maintenance/tests/test_task_lifecycle.py)

env -u OPENAI_API_KEY make fmt
env -u OPENAI_API_KEY make test
env -u OPENAI_API_KEY make lint
env -u OPENAI_API_KEY pnpm --filter herd run build
env -u OPENAI_API_KEY pnpm --filter herd run docs:check
env -u OPENAI_API_KEY make -C agent-skills test
git diff --check
gh pr view 1988 --repo NickGuAI/Herd --json headRefOid,statusCheckRollup
```

Result:

- shared composer: 2 files, 81 tests passed;
- automations: 11 files, 220 tests passed;
- quest/Workspace artifacts: 7 files, 95 tests passed;
- focused quest CLI: 1 file, 38 tests passed;
- tracked runtime skill contracts: 46 tests passed;
- `agent-skills` equivalents: 46 tests passed;
- release full gate at the evaluated source state: 390 test files passed and 1
  skipped; 3,254 tests passed and 13 skipped; build, lint, docs, and submodule
  skill checks passed; the no-op root formatting target completed;
- all four exact-head PR #1988 checks passed before the documentation refresh;
- the docs guardrail and `git diff --check` passed again after editing `.dev`.

Non-blocking output included the existing Node experimental SQLite warning,
Vite browser externalization and source-map warnings, jsdom canvas limitations,
and stale Browserslist data.

## Review Roles

- topology/module reviewer: subagent `devctx_topology` inspected the assembled
  composer, automation, quest, Workspace, CLI, and task-lifecycle seams and
  identified stale paths and incomplete ownership statements.
- verification/test reviewer: subagent `devctx_verify` read the affected tests,
  ran the six focused bundles above, and found that the old CLI “focused” syntax
  actually ran the full CLI suite.
- release/install/ops reviewer: performed in the main thread against project
  rules, package/Makefile scripts, the clean release worktree, exact PR head,
  and live GitHub checks.
- contrarian reviewer: performed in the main thread against capability, state
  ownership, cron-authority, responsive-presentation, and path-rewrite
  boundaries.

## Unsupported Assumptions Rejected

- Rejected: desktop and mobile should own separate composer mode behavior.
  Evidence: every embedding consumes
  `apps/herd/modules/agents/components/SessionComposer.tsx`, while
  `use-session-draft.ts` owns per-session mode persistence and sizing.
- Rejected: automation scope determines layout. Evidence: scope and
  presentation are independent props on `AutomationPanel`; default is adaptive,
  while mobile-list and single-pane are explicit full-swap modes.
- Rejected: browser cron validation can own cron grammar. Evidence:
  `cron-validation.ts` checks draft readiness only; the bounded server guard
  delegates grammar to pinned `node-cron`.
- Rejected: one malformed persisted schedule may abort scheduler startup.
  Evidence: `scheduler.ts` isolates registration per persisted job, and
  first-boot tests keep repair APIs available.
- Rejected: quest status and task-folder state are one lifecycle. Evidence: the
  quest API owns pending/active/blocked/done/failed, while `task_lifecycle.py`
  owns proposed/active/completed and links them only through explicit file
  artifacts.
- Rejected: disabling edit controls makes an artifact preview read-only.
  Evidence: all seven target/file/git Workspace mutation routes use the
  writable-target guard and git initialization repeats it at the service
  boundary; target-independent preferences are a separate route.
- Rejected: `pnpm --filter @gehirn/herd-cli test -- <file>` is focused.
  Evidence: the package script is already `vitest run`; direct execution with
  the exact path is required to select only `quests.test.ts`.

## Gaps For Human Review

- No authenticated browser pass was run. jsdom class assertions do not prove
  final CSS geometry. Manually inspect desktop/mobile `/command-room`,
  `/automations`, Command Room global/commander automation embeddings, composer
  mode sizing/keys, and QuestBoard file/directory previews when visual release
  evidence is required.
- No deployment, production relaunch, live task-folder migration, or mutation
  of existing quest/task records was performed.
