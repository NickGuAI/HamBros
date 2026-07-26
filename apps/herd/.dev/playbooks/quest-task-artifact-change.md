# Quest Or Task Artifact Change

1. Identify which state machine changes:
   - quest status/artifacts: Herd quest API/store/CLI;
   - task folder state: `task_lifecycle.py`;
   - file preview capability: Workspace resolver/routes.

2. Preserve the explicit artifact contract. Start with:
   - `apps/herd/modules/commanders/quest-artifact-href.ts`
   - `apps/herd/modules/commanders/routes/register-quests.ts`
   - `packages/herd-cli/src/quests.ts`
   - `apps/herd/modules/commanders/components/QuestBoard.tsx`

3. For file artifacts, inspect the entire capability boundary:
   - `apps/herd/modules/workspace/routes.ts`
   - `apps/herd/modules/workspace/resolver.ts`
   - `apps/herd/modules/workspace/capability.ts`
   - `apps/herd/modules/workspace/git.ts`
   - `apps/herd/modules/workspace/use-workspace.ts`

4. Prove that artifact-derived targets are ephemeral and read-only, all seven
   target/file/git mutation routes reject them, git init repeats the guard, and
   normal Workspace targets remain writable. Workspace preferences are not
   target-scoped and are outside this guard.

5. For task create/move/index behavior, inspect both distributed copies:
   - `ai-state/claude/skills/task-system-maintenance/scripts/task_lifecycle.py`
   - `ai-state/claude/skills/task-system-maintenance/scripts/audit.py`
   - `ai-state/claude/skills/create-quests/SKILL.md`
   - `agent-skills/pkos/task-system-maintenance/`

6. Keep quest and task lifecycle transitions separate. Link them with an
   explicit `file` artifact; do not infer a task from quest text or a shared
   name. A lifecycle move must regenerate indexes and rewrite exact references.

   Preserve CLI claim output as `QUEST_CLAIM_HANDOFF` with `questId`,
   `conversationId`, and artifacts so workers receive the explicit backlink.

7. Run the Quest artifacts and task lifecycle bundle in
   `apps/herd/.dev/VERIFY.md`, then the full gate for any cross-repository
   contract change.

8. Contrarian checks:
   - Can an unsafe legacy artifact survive the next replacement PATCH?
   - Can a read-only target write through any route or direct git helper?
   - Can a task move corrupt a similarly prefixed sibling path?
   - Do the tracked runtime and GehirnSkills submodule contract suites pass?
