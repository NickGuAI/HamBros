# SQLite Runtime Session Change

1. Start with:
   - `apps/herd/server/db/schema.ts`
   - `apps/herd/server/db/readiness.ts`
   - `apps/herd/modules/agents/session/sqlite-runtime-store.ts`
   - `apps/herd/modules/agents/session/state.ts`
   - `apps/herd/modules/agents/persistence-helpers.ts`
   - `apps/herd/modules/agents/routes-core.ts`

2. Check API projections:
   - `apps/herd/modules/agents/routes/session-query-routes.ts`
   - `apps/herd/modules/agents/routes/session-control-routes.ts`
   - `apps/herd/modules/commanders/routes/conversation-read-model.ts`
   - `apps/herd/modules/agents/types.ts`

3. Check operator paths:
   - `apps/herd/tools/db-ready.ts`
   - `apps/herd/tools/migrate-sqlite.ts`
   - `apps/herd/install.sh`
   - `operations/deploy/ec2/install-ec2.sh`
   - `operations/scripts/launch_herd.sh`
   - `packages/herd-cli/src/up.ts`
   - `packages/herd-cli/src/doctor.ts`

4. Verify:

```bash
pnpm --filter herd exec vitest run \
  server/__tests__/sqlite-readiness.test.ts \
  server/__tests__/sqlite-migration.test.ts \
  server/__tests__/launch-state-reset.test.ts \
  modules/agents/session/__tests__/sqlite-runtime-store.test.ts \
  modules/agents/session/__tests__/persistence.test.ts \
  modules/agents/__tests__/session/state.test.ts \
  modules/agents/__tests__/routes-session-control.test.ts \
  modules/agents/__tests__/websocket.test.ts

pnpm --filter @gehirn/herd-cli exec vitest run \
  src/__tests__/up.test.ts \
  src/__tests__/doctor.test.ts \
  src/__tests__/workers.test.ts \
  src/__tests__/session.test.ts
pnpm --filter herd run db:ready -- --source-root ~/.herd --db ~/.herd/herd.sqlite
```

5. Update docs:
   - `apps/herd/docs/troubleshoot.md`
   - `apps/herd/docs/reference/cli.md`
   - this `.dev` map if ownership or commands changed.

6. If the change can affect post-restart latency, launch locally or on the EC2
   service with `operations/scripts/launch_herd.sh`, inspect
   `operations/logs/server/herd/latest/launch.log`, and probe a protected
   agents route. `/api/health` alone does not prove the agents restore gate is
   clear.
