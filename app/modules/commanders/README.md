# Commander Memory Runtime Contract

Tracking issue: `#464`

This module keeps commander-specific memory artifacts and commander-specific cron state under the same commander durability tree.

## Storage Contract

For commander `<id>`:

- Memory root: `<COMMANDER_DATA_DIR>/<id>/.memory/`
- Commander cron tasks: `<COMMANDER_DATA_DIR>/<id>/.memory/cron/tasks.json`
- Commander cron runs: `<COMMANDER_DATA_DIR>/<id>/.memory/cron/runs.json`

`/api/command-room/*` and the live scheduler/executor now load commander-owned cron tasks from `<COMMANDER_DATA_DIR>/*/.memory/cron/tasks.json` and route run records back into the matching commander-owned `runs.json` when a task has `commanderId`.

`/api/commanders/:id/crons` create/update/delete delegates to the same live command-room scheduler instance, so cron job registration updates immediately without a process restart.

Legacy compatibility: existing commander tasks in `data/command-room/tasks.json` remain manageable via `/api/commanders/:id/crons` (list/update/delete) until explicitly migrated.

## Prompt Contract

Session creation still uses `CommanderAgent` to inject an explicit memory workflow section that teaches one supported interaction model:

- `hammurabi memory find --commander <id> "<query>"`
- `hammurabi memory save --commander <id> "<fact>"`
- `hammurabi memory compact --commander <id>`

Fat heartbeats no longer inject assembled memory layers. They reload the commander-owned `COMMANDER.md` body and append dynamic runtime state (pending quests, rendered heartbeat message, sub-agent results, and optional `HEARTBEAT.md` checklist). That means the commander-owned `COMMANDER.md` template must teach the agent where its `.memory/*` files live and how to read them on demand.

## Architecture Diagram

```text
╔══════════════════════════════════════════════════════════════╗
║ Commander <id> durability tree                               ║
║                                                              ║
║  .memory/                                                    ║
║  ├─ journal/*.md                                             ║
║  ├─ LONG_TERM_MEM.md                                         ║
║  ├─ consolidation-log.md                                     ║
║  └─ cron/                                                    ║
║     ├─ tasks.json   (GET/POST/PATCH/DELETE /:id/crons)       ║
║     └─ runs.json    (lastRun hydration + delete cleanup)     ║
║                                                              ║
║ Command-room scheduler/executor                              ║
║  ├─ reads enabled cron tasks from commander-owned tasks.json ║
║  └─ writes run history to matching commander-owned runs.json ║
╚══════════════════════════════════════════════════════════════╝

Legend:
- `tasks.json` = commander-owned cron definitions
- `runs.json` = commander-owned cron run history
- legacy global task file = backward-compatible fallback for pre-cutover commander tasks
```
