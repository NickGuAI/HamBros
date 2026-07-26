---
name: commander-memory-cleanup
description: >
  Distill Herd commander memory, clean stale MEMORY.md entries, promote
  durable commander lessons into LONG_TERM_MEM.md, and propose shared-knowledge
  updates through a review gate. Use for periodic commander memory cleanup.
user-invocable: true
argument-hint: '[commander-id|commander-dir] [--mode observer|reflector] [--since YYYY-MM-DD|--days N]'
disable-model-invocation: false
allowed-tools: Bash, Read, Write, Edit, Glob
---

# Commander Memory Cleanup

Clean a Herd commander's memory without adding a new compact API, CLI
command, or fixed script-first flow. The skill is the implementation mechanism:
the agent reads evidence, decides what is durable, rewrites the memory files,
and reports exactly what changed.

## Goal

Keep commander memory useful by separating active operational facts from
distilled durable knowledge, while preserving progressive memory discovery.

## Inputs

- `commander-id` or `commander-dir`: defaults to `$HERD_COMMANDER_ID` or
  the current `~/.herd/commander/<id>` directory.
- `--mode observer`: collect evidence and recommendations only; do not edit
  memory files.
- `--mode reflector`: clean `MEMORY.md` and rewrite `LONG_TERM_MEM.md`.
  This is the default for scheduled memory consolidation.
- `--since YYYY-MM-DD` or `--days N`: optional freshness window for transcript
  and run-report review. If omitted, use the active memory horizon implied by
  the current files.

## Files And Sources

Required commander-local files:

- `COMMANDER.md` - identity and operating style. Do not stuff durable memory here.
- `.memory/MEMORY.md` - current high-signal operational facts.
- `.memory/LONG_TERM_MEM.md` - durable knowledge grouped by domain/topic.
- `.memory/working-memory.md` - transient scratch state; read only when relevant.

Optional evidence:

- `herd quests list --commander <id>`
- `herd commander transcripts search --commander <id> "<query>"`
- `~/.herd/automations/*/runs/*`
- source files, reports, and docs named by memory entries
- `~/.herd/global-rules/USER.md`
- `~/.herd/shared-knowledge/{DOCTRINES.md,COMMANDER_GUIDE.md,LEARNINGS.md}`

## Cleanup Rules

- Preserve only facts that are likely to matter for future work.
- `MEMORY.md` is for current, searchable operational state: active constraints,
  live handoffs, owner boundaries, current file paths, and warnings that should
  affect the next task.
- `LONG_TERM_MEM.md` is for distilled knowledge: reusable lessons, domain
  patterns, durable client-delivery rules, and historical decisions grouped by
  topic. Do not copy raw quest logs into it.
- `COMMANDER.md` stays focused on role identity, scope, voice, and operating
  style. Move tactical facts out unless they are part of the commander's identity.
- Remove or summarize completed quest narratives, expired dates, duplicate
  entries, superseded strategy, and stale run-count chatter.
- Never copy secrets, bearer tokens, API keys, private credentials, or raw
  personal data into cleaned memory, shared docs, or reports.
- Promote cross-commander lessons only to the narrowest shared surface, and only
  after a review gate. Shared doctrine/global routing changes require explicit
  review in the report; do not silently mutate them during broad automation runs.

## Procedure

1. Load the commander scope: read `COMMANDER.md`, `USER.md`, and the shared
   doctrine/guide files needed to resolve authority conflicts.
2. Inventory memory: inspect `MEMORY.md`, `LONG_TERM_MEM.md`, and targeted
   evidence named by entries. Use grep/search by date, topic, person, issue, or
   file path instead of full-loading unrelated logs.
3. Classify entries:
   - `KEEP-MEMORY`: current operational fact that should remain in `MEMORY.md`.
   - `PROMOTE-LONGTERM`: durable commander-specific lesson for `LONG_TERM_MEM.md`.
   - `PROPOSE-SHARED`: cross-commander lesson that needs review before editing
     `DOCTRINES.md`, `COMMANDER_GUIDE.md`, `LEARNINGS.md`, or global rules.
   - `DROP`: stale, duplicated, superseded, secret-bearing, or low-value noise.
4. In observer mode, stop after the classification report.
5. In reflector mode, rewrite `MEMORY.md` and `LONG_TERM_MEM.md` using concise
   headings and bullet points. Keep provenance dates or source paths when they
   help future verification.
6. Verify the result: check file readability, search for forbidden secret/token
   patterns, confirm `COMMANDER.md` did not absorb tactical memory, and review
   the diff before reporting.

## Acceptance Criteria

- `MEMORY.md` contains only current high-signal operational facts and cleanup
  policy notes.
- `LONG_TERM_MEM.md` is grouped by domain/topic and reads like distilled
  commander knowledge, not a chronological quest journal.
- `COMMANDER.md` remains identity and operating style only.
- The report lists files read, entries kept/promoted/dropped, proposed shared
  updates, verification performed, and any unresolved uncertainty.
- The workflow never invokes or depends on `herd memory compact`; memory
  cleanup remains skill-driven and progressively discovered.

## Output

For reflector runs, edit the commander-local memory files in place and return a
short report:

- commander id/name
- files examined and changed
- memory entries kept, promoted, dropped, or proposed for shared review
- verification commands and results
- blockers or facts that need operator confirmation
