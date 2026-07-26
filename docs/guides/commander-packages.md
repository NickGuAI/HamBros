# Commander Packages [Spec v1]

Commander packages are the product unit for bundled Herd employees. A package
defines the commander identity, required skills, onboarding guide, examples, and
safe memory seed. The backend owns package loading and installation; frontend
surfaces only render package state and call install APIs.

Portable commander bundles are a separate publish format for user-exported
commanders. Bundles include runtime memory, commander-scoped automations, and
embedded skill directories. See [Commander Bundles](commander-bundles.md).

## Package Layout

Bundled packages live under
`apps/herd/modules/commanders/packages/bundled/<package-id>/`.

```text
commander-package/
├─ package.json
├─ COMMANDER.md
├─ skills.manifest.json
├─ memory-seed.md
├─ onboarding.md
├─ examples/
└─ assets/
```

`package.json` contains package metadata: schema version, id, version,
displayName, host, role, summary, description, provider defaults, effort,
context mode, and UI profile defaults.

`COMMANDER.md` is product-safe identity and operating style. It must not contain
private operator memory, private file paths, private issue history, or
organization-specific claims.

`skills.manifest.json` names required and optional skill dependencies. Skills are
dependencies; the commander package is the user-facing unit.

`memory-seed.md`, `onboarding.md`, and `examples/` provide safe first-run
context and examples that the user can inspect before install.

## Bundled Workforce

The default Herd workforce contains:

- `engineering-manager`: Asina, an engineering manager for issue triage, code
  investigation, review, orchestration, and release follow-through.
- `research-intelligence-analyst`: Einstein, a research analyst for web
  research, knowledge search, domain distillation, and reports.
- `general-assistant`: Alfred, a general assistant for meeting prep, scheduling,
  daily support, inbox/doc triage, and follow-through.

## API

- `GET /api/commanders/packages` lists bundled packages with install state.
- `GET /api/commanders/packages/:packageId` returns one package.
- `POST /api/commanders/packages/:packageId/install` installs the package
  idempotently. Existing non-archived commanders with the same `templateId` are
  returned instead of duplicated.
- `POST /api/onboarding/actions/seed-starter-workforce` installs the bundled
  starter workforce during first-run onboarding.

## Install Behavior

Installation creates a normal commander session, default conversation, display
name, profile, `COMMANDER.md` identity section, and an inspectable `.package/`
snapshot under the installed commander's data directory.

Package writes are serialized by commander data directory, including direct
package installs and onboarding workforce batches. Installation writes
`.package/install-state.json` atomically as its final commit marker. Read-side
installed status requires the package session, deterministic default
conversation, exact package-owned preset automations, matching package
snapshot, and a complete matching marker. A structurally complete legacy
install without a marker remains readable and adopts a marker on the next
explicit install; partial legacy state is reconciled and rebuilt. User changes
to preset automation runtime status do not invalidate an otherwise complete
install.

If installation fails after creation begins, rollback removes preset
automations, the default conversation, display-name metadata, the commander
session, and commander files. Cleanup failures are reported with their failed
operation instead of being silently discarded. Cleanup validates the package
and install IDs before mutation and never sweeps non-package automations or
user-created conversations; unrelated child state blocks destructive parent
cleanup.

The backend resolves duplicate hosts and display names before creation. The UI
does not assemble identity, skills, memory, or package rules.
