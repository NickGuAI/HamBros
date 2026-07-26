# Quest And Task Artifacts

## Purpose

Map the explicit link between Herd quests and `~/tasks` records, including
artifact validation, file preview authorization, read-only Workspace targets,
and deterministic task-folder lifecycle moves.

## Source Files

- `apps/herd/modules/commanders/quest-store.ts`
- `apps/herd/modules/commanders/quest-artifact-href.ts`
- `apps/herd/modules/commanders/route-parsers.ts`
- `apps/herd/modules/commanders/routes/register-quests.ts`
- `apps/herd/modules/commanders/components/QuestBoard.tsx`
- `packages/herd-cli/src/quests.ts`
- `apps/herd/modules/workspace/routes.ts`
- `apps/herd/modules/workspace/resolver.ts`
- `apps/herd/modules/workspace/capability.ts`
- `apps/herd/modules/workspace/git.ts`
- `apps/herd/modules/workspace/use-workspace.ts`
- `ai-state/claude/skills/create-quests/SKILL.md`
- `ai-state/claude/skills/task-system-maintenance/scripts/task_lifecycle.py`
- `ai-state/claude/skills/task-system-maintenance/scripts/audit.py`
- `agent-skills/pkos/task-system-maintenance/`

## State And Data Flow

```text
task_lifecycle.py
  -> ~/tasks/{proposed,active,completed}/<task>/
  -> task.md + index.html + index.json
  -> rewrite exact task references and quest file-artifact hrefs on move

create-quests / QuestBoard / herd quests
  -> { type, label, href }
  -> commander quest PATCH/store
  -> always-visible artifact chip
       | URL/GitHub -> safe external link
       | file       -> POST /api/workspace/resolve-reference
                              -> ephemeral read-only target
                              -> read-only Workspace APIs
```

Quest lifecycle and task-folder lifecycle are separate:

| Owner | States | Transition authority |
|---|---|---|
| Herd quest board | pending, active, blocked, done, failed | Quest API/CLI |
| `~/tasks` filesystem | proposed, active, completed | `task_lifecycle.py create/move` |

The explicit `file` artifact is the backlink. Do not infer it from task names,
quest instructions, labels, or path substrings. Changing quest status does not
move a task folder automatically.

## Artifact Contract

- Types are `file`, `url`, `github_issue`, and `github_pr`.
- UI, server, and CLI validate hrefs before persistence or navigation.
- URL artifacts require HTTP(S). GitHub issue/PR artifacts require the matching
  `github.com/<owner>/<repo>/issues|pull/<positive-number>` shape.
- File artifacts are resolved by the server; raw filesystem roots are not sent
  to the browser as authority.
- QuestBoard and CLI replacement drop invalid legacy siblings instead of
  writing them back into the store. Direct API create/update rejects an invalid
  artifact payload.
- A successful CLI claim emits `QUEST_CLAIM_HANDOFF` followed by JSON containing
  `questId`, `conversationId`, and the claimed quest artifacts so the worker
  receives the explicit task backlink.

## Workspace Read-Only Boundary

`POST /api/workspace/resolve-reference` requires read access, expands local or
remote `~/`, authorizes the path against the commander/machine or configured
task lifecycle roots, and mints an ephemeral `readOnly: true` target. Tree,
preview, raw, status, and log reads remain available.

All seven target/file/git Workspace mutation routes resolve through the shared
writable-target guard: save, new file, new folder, rename, delete, upload, and
git init. Git init also checks writability in the service itself. A normal
opened Workspace target remains writable; read-only is a property of the
artifact-derived target, not a global Workspace mode. Target-independent
Workspace preferences are outside this guard.

## Task Move Invariant

`task_lifecycle.py move` owns the filesystem move, lifecycle note, generated
index refresh, and exact-path reference rewrite in task files and quest-board
JSON. It must avoid sibling-prefix corruption, preserve nested/binary artifacts,
and roll back partial failures. The tracked `ai-state` skill and checked-out
`agent-skills` submodule carry analogous contract tests.

## External Surfaces

- `GET/POST /api/commanders/:id/quests` and
  `PATCH/DELETE /api/commanders/:id/quests/:questId`, plus claim and note routes.
- `herd quests create|claim|artifact add|artifact remove`.
- `QUEST_CLAIM_HANDOFF <json>` on successful machine-readable CLI claim output.
- QuestBoard artifact chips and file/directory preview modal.
- `POST /api/workspace/resolve-reference` plus the read-only Workspace tree,
  path, file, raw, context, git-status, and git-log APIs.
- `~/tasks/{proposed,active,completed}/`, `~/tasks/index.html`, and
  `~/tasks/index.json`.

## Coupled Modules

- Commander quest store/routes and Command Room QuestBoard presentation.
- Workspace target authorization, ephemeral-target lifecycle, file previews,
  context materialization, and git reads.
- Herd CLI claim/create/artifact contracts.
- `create-quests` and task-system-maintenance tracked runtime skills.
- GehirnSkills submodule copies used for installed skill distribution.

## When Touching This, Also Inspect

- `apps/herd/.dev/playbooks/quest-task-artifact-change.md`
- `apps/herd/.dev/maps/command-room.md`
- `apps/herd/modules/commanders/components/QuestCreateForm.tsx`
- `apps/herd/modules/commanders/__tests__/register-quests.test.ts`
- `apps/herd/modules/agents/__tests__/routes-workspace.test.ts`
- `apps/herd/modules/agents/__tests__/routes-workspace-tilde.test.ts`
- `packages/herd-cli/src/__tests__/quests.test.ts`
- `ai-state/claude/skills/task-system-maintenance/tests/test_task_lifecycle.py`

## Verification

Use the Quest artifacts and task lifecycle bundle in
`apps/herd/.dev/VERIFY.md`. It covers QuestBoard/API/CLI validation,
local/remote tilde resolution, every read-only mutation boundary, task moves and
rollback, index generation, reference rewriting, claim handoff, and both skill
trees.

## Risks

- A UI-only disabled editor is not a security boundary; guard every
  target/file/git write route.
- A task move without quest artifact rewriting strands the execution backlink.
- Rewriting by loose substring can corrupt similarly prefixed sibling tasks.
- Persisting a file reference as an ordinary durable Workspace target grants a
  broader capability than a read-only preview requires.
