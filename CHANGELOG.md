# Changelog

All notable Herd release changes are recorded here for operators upgrading an
installed checkout. `RELEASE_NOTES.md`, when present in the release process,
continues to be the GitHub release body; this file ships in the public artifact.

## Unreleased

- No unreleased changes.

## v0.0.11-beta — 2026-07-26

- Kept the prior durable SQLite row while a restored credential-recovery
  session is represented only by a transient provider process without a
  resume identifier.
- Transferred runtime-session persistence ownership only after a replacement
  has a durable provider resume identifier or daemon handle, while preserving
  normal authoritative deletion after that transition completes.

## v0.0.10-beta — 2026-07-26

- Made runtime-session restoration part of server readiness. Health now remains
  non-ready until persisted agent sessions have finished their startup restore,
  so installer and deployment handoffs cannot terminate a partially restored
  first boot.
- Preserved durable SQLite rows that have not yet been claimed by an in-memory
  runtime, including sessions that are dormant for the current execution mode
  or temporarily cannot resume. Once hydrated, rows return to normal
  authoritative lifecycle deletion.
- Made graceful shutdown wait for startup restoration and flush a complete
  final runtime snapshot before provider teardown.

## v0.0.9-beta — 2026-07-26

- Added a two-mode session composer. Quick mode keeps Enter-to-send, while
  Markdown mode supports multiline editing, explicit send shortcuts, durable
  per-session drafts, attachments, and paste-driven mode promotion.
- Rebuilt automations as a responsive master/detail workspace with shared
  global and commander views, safer draft handling, and server-authoritative
  cron validation.
- Made quest artifacts first-class task references across the UI, API, and CLI.
  Task lifecycle operations now preserve explicit backlinks across hosts, and
  artifact-backed workspaces are enforced as read-only.
- Bundled the default automation housekeeping skills and starter workforce so
  fresh installations can complete founder onboarding without depending on an
  internal skills checkout.
- Added the Railway production deployment lane with daemon-only provider
  execution by default, durable-volume readiness checks, restart persistence,
  bootstrap non-recreation, SQLite upgrade coverage, and graceful shutdown.
- Made credential selection placement-owned: local Claude credentials are
  managed globally, while Codex and eligible remote credentials remain
  conversation-selectable. Codex effort options now come from live model
  capabilities instead of hard-coded defaults.
- Added Claude Opus 5 to the provider catalogue, bundled the
  `growth-analytics` skill, and removed the retired Composio MCP default.
- Hardened first-run transactions, durable JSON-store writes, archived
  commander filtering, workspace boundaries, and release/install readiness.

## v0.0.8-beta — 2026-07-18

- Relicensed the current public release line under GNU AGPLv3
  (`AGPL-3.0-only`). No license purchase is required for AGPL-compliant
  commercial use; a separate paid commercial agreement is available for
  proprietary or other non-AGPL use. Earlier tagged releases retain the terms
  shipped with those releases.
- Unified the Codex model catalogue across conversations and credentials.
  Supported Codex models expose `low`, `medium`, `high`, and `max` effort;
  `ultra` is available only for `gpt-5.6-sol`.
- Made benchmark adapters explicit external inputs. Adapter-backed bootstrap
  and run commands require an absolute `--adapter-root`; run also requires a
  validated `--adapter-module`, and the canonical runner is
  `herd-orchestrated`.
- Improved provider credential selection and recovery, including Claude OAuth
  continuity, credential-pool readiness, quota refresh behavior, and resumable
  conversations after authentication recovery.
- Preserved queued and in-flight conversation send intent across runtime
  transitions, and carried approval-policy context through worker handoffs.
- Grouped sub-agent transcript activity for a clearer operator view.
- Simplified the enterprise EC2 lane so the production Node server serves the
  UI, API, and WebSockets directly on ALB target port `20001`; removed the Caddy
  split shell and reserved `20009` for the loopback development API.

## v0.0.7-beta — 2026-07-06

- Republished the Herd public artifact from source snapshot `2c4cfb6f2`
  so the release tag and installer default point at the latest available
  `main` state.
- Added explicit release-history traceability through the public release commit
  and changelog so operators can verify which source snapshot produced the
  pinned artifact.

## v0.0.6-beta — 2026-07-06

- Added first-run runtime defaults for global rules and shared commander
  knowledge so fresh Herd installs start with workspace routing, doctrine,
  skill routing, and shared learnings files.
- Added default operator housekeeping automations for memory consolidation and
  context hygiene after founder setup, with required public skills bundled in
  the release artifact.
- Improved command-room and mobile settings smoothness with updated mobile
  navigation, workspace preview handling, transcription reliability, credential
  readiness, and provider-auth surfaces from the latest integration batch.
- Finished the enterprise EC2 release lane: `herd.service`, `HERD_*` runtime
  environment, private `PORT=20009`, Caddy shell on `:20001`, split-shell smoke
  tests, and public release guardrails.
- Tightened public artifact checks so Herd release sync fails if runtime
  defaults, housekeeping skills, EC2 deploy assets, public docs, or installer
  pins drift.

## v0.0.5-beta — 2026-07-05

- Added `herd update` for in-place release upgrades. It fetches a release tag,
  rebuilds the checkout, runs JSON-store and SQLite readiness checks, and
  restarts the installed service when the platform service manager is available.
- Added `schemaVersion` to the JSON data stores under the Herd data directory:
  commanders, API keys, policies, automations, operators, settings, and
  machines. Boot now migrates legacy stores or refuses unsupported versions with
  an explicit readiness error.
- Changed `herd onboard` defaults to use the local installed instance instead
  of a hosted endpoint. It derives the port from the installed app `.env` and
  falls back to `http://127.0.0.1:20001`.
- Added Linux user-systemd autostart for fresh local installs, alongside the
  existing macOS launchd service.
- Expanded uninstall and enterprise upgrade documentation with service, data
  directory, toolchain, and rollback steps.
