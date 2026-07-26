---
name: context-rot-cleanup
description: >
  Examine workspace files for durable context, filter out low-value noise, and
  clean up stale memory or rule files that contribute to context rot.
user-invocable: true
argument-hint: '[ROOT_DIR] [--mode observer|reflector] [--since YYYY-MM-DD|--days N]'
disable-model-invocation: false
allowed-tools: Bash, Read, Write, Edit, Glob
---

# Context Rot Cleanup

Use this skill when a workspace has accumulated logs, notes, memory files, or
agent guidance that may be stale, duplicated, too verbose, or missing durable
lessons. The goal is to preserve only reusable context that is likely to matter
for future work, while deleting or rewriting context that wastes attention.

## Input

`$ARGUMENTS`:
- `ROOT_DIR` - Workspace root to inspect. Default to the current directory.
- `--mode observer` - Append fresh observations only. Do not edit rule files.
- `--mode reflector` - Promote durable observations into rules and clean stale
  memory. Default when the user asks to clean up context rot.
- `--since YYYY-MM-DD` or `--days N` - Observation window. Default to today for
  observer mode and the current active memory horizon for reflector mode.

## Core Rules

- Read the workspace guide first: `AGENTS.md`, `CLAUDE.md`, or the closest
  project-local agent guide under `ROOT_DIR`. If a guide points to routing
  tables or rule indexes, read only the files needed for this cleanup.
- Use scoped filesystem scans (`find`, `ls`, `rg`) inside `ROOT_DIR`. Do not
  rely on a top-level git diff as the only input because workspaces can contain
  nested repositories or untracked context files.
- Prefer evidence from current files over memory. Every retained, promoted, or
  deleted item needs a concrete source path, line, date, commit, or transcript
  reference.
- Treat blog or dated content as current only after reading its metadata. For
  Markdown blog content, parse the `Date` frontmatter/header and ignore old
  posts changed only by formatting.
- Ignore mechanical daily records unless the local guide says otherwise. Include
  explicitly curated personal records, project status files, and memory files
  when they are in scope.
- Keep role isolation strict. Observer mode records observations only; reflector
  mode is the only mode that edits rules, agent guides, or long-term memory.
- Do not preserve weak lessons. If a note is unlikely to be reused in the next
  three months, remove it from durable context or leave it out of new memory.
- Never exfiltrate private data. Do not delete source records, generated logs,
  or user-owned files unless the user explicitly asked for deletion and the
  target file is clearly within the cleanup scope.

## Context Tiers

Use the target workspace's existing tier labels if present. Otherwise classify
items with these plain labels:

- `HIGH` - Hard constraints, reusable methods, architectural decisions, safety
  boundaries, and cross-project lessons.
- `MEDIUM` - Active project state, current technical tradeoffs, near-term
  milestones, and module-specific decisions likely to matter soon.
- `LOW` - Routine task logs, completed todos, transient debugging details, and
  context useful only for the current session or day.

Promote `HIGH` items to durable rules or guides in reflector mode. Keep only
still-active `MEDIUM` items in memory. Drop or summarize `LOW` items unless the
user asked for an audit trail.

## Procedure

1. Resolve `ROOT_DIR`, mode, date window, and the local memory/rules paths.
   Common paths are `contexts/memory/OBSERVATIONS.md`, `rules/`, `AGENTS.md`,
   `CLAUDE.md`, `docs/`, and project-specific knowledge bases.
2. Build a scoped file inventory for candidate Markdown, text, CSV, and config
   files. Exclude dependency directories, build outputs, caches, and known
   mechanical logs.
3. Read candidate files and extract only evidence-backed observations. For each
   candidate, record tier, date or freshness, source path, and why it should
   survive future context loading.
4. In observer mode, append observations to the workspace observation file. Use
   the existing local format; otherwise write:

   ```text
   Date: YYYY-MM-DD
   - [HIGH] <durable observation> (evidence: path:line)
   - [MEDIUM] <active project state> (evidence: path:line)
   ```

5. In reflector mode, compare current observations against rule and memory
   files. Promote durable rules to the narrowest authoritative file, rewrite
   observations to remove promoted or expired entries, and delete duplicated
   context inside memory files when the same fact now lives in a rule.
6. Stop without edits if the scan finds no durable signal. Report that no
   cleanup was warranted instead of creating filler observations.

## Acceptance Criteria

- The cleanup is grounded in files that were actually inspected.
- Observer mode changes only the observation/memory target, never rule files.
- Reflector mode updates the narrowest durable rule or guide and removes stale
  duplicates from memory.
- Blog or dated content is filtered by metadata date, not just file modified
  time.
- Retained context is materially useful for future work; routine logs and
  transient debug details are not promoted.
- The final report lists files examined, files changed, observations added or
  promoted, and any noise explicitly ignored.

## Output

Produce file edits in the target workspace:
- Observer mode: append-only updates to the local observation file, commonly
  `contexts/memory/OBSERVATIONS.md`.
- Reflector mode: surgical edits to rule files, agent guides, and memory files
  that remove stale context and promote durable lessons.

Report a concise walkthrough with:
- Root inspected and date window.
- Number or categories of files examined.
- Files changed.
- Durable observations added or promoted.
- Noise filtered out and any skipped areas with reasons.
