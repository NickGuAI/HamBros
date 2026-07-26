# CLI Contract Change

1. Start with command router:
   - `packages/herd-cli/src/index.ts`

2. Inspect command file:
   - startup/readiness: `packages/herd-cli/src/up.ts`,
     `packages/herd-cli/src/doctor.ts`
   - sessions: `packages/herd-cli/src/session.ts`
   - workers: `packages/herd-cli/src/workers.ts`
   - quests/artifacts: `packages/herd-cli/src/quests.ts`
   - shared contracts: `packages/herd-cli/src/session-contract.ts`
   - app shim: `apps/herd/herd-cli.mjs`

3. Check server DTO source before changing output:
   - `apps/herd/modules/agents/types.ts`
   - `apps/herd/modules/agents/routes/session-query-routes.ts`
   - `apps/herd/modules/agents/session/state.ts`
   - for quests: `apps/herd/modules/commanders/quest-store.ts`,
     `apps/herd/modules/commanders/quest-artifact-href.ts`, and
     `apps/herd/modules/commanders/routes/register-quests.ts`

4. For quest artifact changes, also inspect task lifecycle ownership:
   - `ai-state/claude/skills/create-quests/SKILL.md`
   - `ai-state/claude/skills/task-system-maintenance/scripts/task_lifecycle.py`
   - `agent-skills/pkos/task-system-maintenance/`

   Preserve `QUEST_CLAIM_HANDOFF` as the machine-readable claim contract with
   `questId`, `conversationId`, and artifacts intact.

5. Preserve API-only behavior:
   - `dispatch`, `send`, `kill`, `register`, `heartbeat`, `events`, and
     `unregister` should call backend APIs, not local runtime files.

6. Verify:

```bash
pnpm --filter @gehirn/herd-cli exec vitest run \
  src/__tests__/up.test.ts \
  src/__tests__/doctor.test.ts \
  src/__tests__/workers.test.ts \
  src/__tests__/session.test.ts
pnpm --filter @gehirn/herd-cli test
pnpm --filter @gehirn/herd-cli exec vitest run src/__tests__/quests.test.ts
```

7. Update operator docs when visible output changes:
   - `apps/herd/docs/reference/cli.md`
