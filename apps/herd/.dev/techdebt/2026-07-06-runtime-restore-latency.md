# 2026-07-06 Runtime Restore Latency

Status: mitigated on `dev` in `f4bb405e3`; not fully retired.

Issue: `https://github.com/NickGuAI/Herd/issues/1924`

## Symptom

After a server restart, Command Room and mobile UI clicks could take minutes to
receive a response. `/api/health` stayed fast and green, which made the problem
look like frontend click latency or global app lag.

## Root Cause

Agents routes wait on persisted session restore before serving protected
`/api/agents/*` requests:

- `apps/herd/modules/agents/routes-core.ts`
- `apps/herd/modules/agents/persistence-helpers.ts`
- `apps/herd/modules/agents/session/persistence.ts`

The SQLite restore reader selected and parsed full `runtime_state_json` values
from non-archived `agent_runtime_sessions` rows:

- `apps/herd/modules/agents/session/sqlite-runtime-store.ts`
- `apps/herd/server/db/schema.ts`

Legacy rows had full replay `events` arrays embedded in `runtime_state_json`.
The production database had roughly 548 MB of non-archived runtime JSON across
25 rows; one active row was about 370 MB and contained about 89k events. The
first agents request after restart therefore paid the JSON parse and heap cost
before the router called `next()`.

```text
Command Room boot
      |
      v
/api/agents/sessions
      |
      v
routes-core restore gate
      |
      v
readSqlitePersistedSessionsState
      |
      v
parse huge runtime_state_json events
      |
      v
UI appears frozen
```

## Shipped Fix

`apps/herd/modules/agents/session/sqlite-runtime-store.ts` now:

- bounds future embedded replay fallback events with
  `MAX_RUNTIME_STATE_EMBEDDED_EVENTS` and
  `MAX_RUNTIME_STATE_EMBEDDED_EVENTS_BYTES`;
- stores only a small tail of replay events in `runtime_state_json`;
- strips oversized legacy `events` payloads in the SQLite projection before
  Node parses `runtime_state_json`.

The restore path still keeps session metadata and lets
`apps/herd/modules/agents/session/persistence.ts` prefer transcript tails
for replay when available.

Regression coverage:

- `apps/herd/modules/agents/session/__tests__/sqlite-runtime-store.test.ts`

Measured against the same live database during the fix:

```text
before: readSqlitePersistedSessionsState ~= 5427ms, RSS ~= 2099MB, heap ~= 1908MB
after:  readSqlitePersistedSessionsState = 793ms, RSS = 146MB, heapUsed = 46MB
```

## Remaining Work

1. Legacy oversized SQLite rows are still physically large until rewritten,
   archived, or compacted by an operator tool. The read path is protected, but
   storage bloat remains.
2. Restore duration and row-size risk are not surfaced as a first-class health
   metric. Add bounded logging or telemetry around persisted-session restore
   count, elapsed time, and stripped legacy payload count.
3. The SQL projection strips only the legacy object shapes currently produced by
   Herd, where `events` appears either as the only key or as the final key.
   A future cleanup should use a safer structured rewrite or one-time
   compaction tool rather than more string projection cases.
4. Resolved 2026-07-10: production now owns the ALB target port `20001`
   directly, and the EC2 smoke test verifies API and document routes without a
   Caddy split-shell dependency.
5. Current launch logs still include Codex sidecar bubblewrap configuration
   warnings. They do not block the restore-latency fix, but they add noise to
   restart review and should be handled separately.

## Retirement Criteria

- A one-off compaction or archival path rewrites existing oversized
  `runtime_state_json` rows, and its dry-run/output is captured in an ops note.
- Persisted restore logs or telemetry show bounded restore count, elapsed time,
  and stripped payload count on restart.
- `VERIFY.md` and this techdebt note agree on the runtime-session restore gate.
- The production relaunch path verifies the direct Node listener and records
  the ALB/direct-listener health result.
