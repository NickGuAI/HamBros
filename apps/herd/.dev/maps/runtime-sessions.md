# Runtime Sessions

## Purpose

Track agent runtime sessions in SQLite and expose backend-computed runtime
state/actions to UI, API, and CLI consumers.

## Source Files

- `apps/herd/server/db/schema.ts`
- `apps/herd/server/db/readiness.ts`
- `apps/herd/server/db/migrations.ts`
- `apps/herd/tools/db-ready.ts`
- `apps/herd/tools/migrate-sqlite.ts`
- `apps/herd/modules/agents/session/sqlite-runtime-store.ts`
- `apps/herd/modules/agents/session/state.ts`
- `apps/herd/modules/agents/session/auto-rotation.ts`
- `apps/herd/modules/agents/commander-interface.ts`
- `apps/herd/modules/agents/provider-errors.ts`
- `apps/herd/modules/agents/routes-core.ts`
- `apps/herd/modules/agents/routes/session-query-routes.ts`
- `apps/herd/modules/agents/routes/session-control-routes.ts`
- `apps/herd/modules/agents/websocket.ts`
- `apps/herd/modules/agents/transcript-store.ts`
- `apps/herd/modules/commanders/routes/conversation-runtime.ts`
- `apps/herd/modules/commanders/routes/conversation-read-model.ts`
- `apps/herd/modules/commanders/routes/conversation-websocket.ts`
- `apps/herd/modules/agents/types.ts`
- `packages/herd-cli/src/session-contract.ts`
- `packages/herd-cli/src/session.ts`
- `packages/herd-cli/src/workers.ts`

## Owned State/Data

- `agent_runtime_sessions` table in `${HERD_DATA_DIR}/herd.sqlite`.
- Runtime state values: `active`, `paused`, `archived`.
- Provider resume JSON and runtime payload JSON in SQLite rows.
- Runtime payload JSON may include a small bounded replay fallback, but full
  transcript replay belongs in transcript storage. The current store strips
  oversized legacy `events` payloads before JSON parsing and bounds future
  embedded replay events in
  `apps/herd/modules/agents/session/sqlite-runtime-store.ts`.
- Credential-pool ids are runtime attribution for local Claude, not selection
  authority. `CredentialPoolState.active` owns the one global local-Claude
  account; coordinated hot-swap preserves native resume context across account
  changes. Codex and remote/isolated runtime homes still clear native resume
  context when replacement crosses homes.
- Schema migrations in `schema_migrations`.
- Session transcript files under the agents data directory.

## External Surfaces

- `/api/agents/sessions`
- `/api/agents/sessions/:name`
- `/api/agents/sessions/:name/send`
- `/api/agents/sessions/:name/ws`
- `/api/conversations/:id/ws` as a conversation-owned websocket alias to the
  underlying agent session websocket.
- `herd sessions list/info`
- `herd workers list/status`
- `herd up`
- `herd doctor`

## Coupled Modules

- Commanders/conversations: conversation routes bind commander conversation
  state to agent runtime sessions.
- Command Room: renders backend state/actions.
- Conversations: read model exposes runtime state, websocket readiness,
  sendability, and allowed actions.
- Providers: provide resume context and runtime teardown behavior.
- Install/release/CLI: readiness and migration commands must stay aligned.
- Commanders/memory: prior-conversation bootstrap is the fallback continuity
  mechanism after isolated runtime resume context is cleared or unavailable.

## Restart Restore Path

```text
first /api/agents/* request after restart
        |
        v
routes-core restorePersistedSessionsReady gate
        |
        v
persistence-helpers readSqlitePersistedSessionsState
        |
        v
sqlite-runtime-store projects bounded runtime_state_json
        |
        v
session/persistence resolves transcript replay tails
        |
        v
provider restore / exited-session recovery
```

`/api/health` does not pass through the agents route gate, so it can be healthy
while the first Command Room or mobile agents request waits on restore. Treat
large SQLite `runtime_state_json` rows as a startup-latency risk, not only a
storage-size concern.

## When Touching This, Also Inspect

- `apps/herd/install.sh`
- `operations/deploy/ec2/install-ec2.sh`
- `operations/scripts/launch_herd.sh`
- `apps/herd/server/index.ts`
- `apps/herd/docs/troubleshoot.md`
- `apps/herd/docs/reference/cli.md`

## Verification Bundle

```bash
pnpm --filter herd exec vitest run \
  server/__tests__/sqlite-readiness.test.ts \
  server/__tests__/sqlite-migration.test.ts \
  server/__tests__/launch-state-reset.test.ts \
  modules/agents/session/__tests__/sqlite-runtime-store.test.ts \
  modules/agents/session/__tests__/persistence.test.ts \
  modules/agents/__tests__/session/state.test.ts \
  modules/agents/__tests__/routes-session-control.test.ts \
  modules/agents/__tests__/websocket.test.ts \
  modules/agents/__tests__/send-route.test.ts \
  modules/agents/__tests__/queue-state.test.ts \
  modules/agents/__tests__/queue-mutation.test.ts

pnpm --filter @gehirn/herd-cli exec vitest run \
  src/__tests__/up.test.ts \
  src/__tests__/doctor.test.ts \
  src/__tests__/workers.test.ts \
  src/__tests__/session.test.ts
pnpm --filter herd run db:ready -- --source-root ~/.herd --db ~/.herd/herd.sqlite
```

## Known Risks / Open Questions

- UI/CLI must not infer authoritative session lifecycle when backend `state` is
  present.
- Install paths must fail with the app-provided remediation command when SQLite
  migration is required.
- A `resume_not_found` provider error is recoverable once by clearing stored
  provider context and spawning from transcript bootstrap; it must not grow into
  a background retry scheduler.
- The shipped restore-latency mitigation still leaves legacy oversized SQLite
  rows physically large until they are rewritten or archived. See
  `apps/herd/.dev/techdebt/2026-07-06-runtime-restore-latency.md`.
