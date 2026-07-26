# Herd v0.0.9-beta

Herd `v0.0.9-beta` focuses on complete operator workflows: richer session
composition, safer automation and quest handling, self-contained onboarding,
and a production-grade hosted deployment path.

## License

- Herd `v0.0.9-beta` is open source under GNU AGPLv3 (`AGPL-3.0-only`).
- No license purchase is required for commercial use that complies with the
  AGPL.
- A separate paid commercial agreement is available for proprietary or other
  non-AGPL use; see
  [COMMERCIAL-LICENSE.md](https://github.com/NickGuAI/Herd/blob/v0.0.9-beta/COMMERCIAL-LICENSE.md).
- Earlier tagged releases retain the license terms included with those
  releases.

## Highlights

- A two-mode session composer combines fast Enter-to-send chat with a durable
  Markdown editor for multiline work, keyboard shortcuts, attachments, paste
  promotion, and per-session draft restoration.
- Automations now use a responsive master/detail workspace across global and
  commander surfaces, with safer draft behavior and server-authoritative cron
  validation.
- Quest artifacts are explicit task references across the UI, API, and CLI.
  Cross-host task moves retain backlinks, while artifact-backed workspaces stay
  read-only.
- Fresh founder onboarding can seed the starter workforce and default
  housekeeping automations from skills bundled directly in the public
  artifact.
- The Railway image now exercises the full production lifecycle: daemon-only
  provider execution by default, durable state across restart, bootstrap-key
  non-recreation, SQLite backup/upgrade, and graceful `SIGTERM`.
- Credential selection is placement-owned. Local Claude credentials are
  managed globally; Codex and eligible remote credentials remain selectable
  per conversation. Codex effort choices come from live model capabilities.
- The provider catalogue adds Claude Opus 5. The public skill bundle adds
  `growth-analytics`, and the retired Composio MCP default is removed.

## Upgrade and compatibility

Git checkouts can upgrade in place:

```bash
herd update --tag v0.0.9-beta
```

Fresh installs continue to use:

```bash
curl -fsSL https://herd.gehirn.ai/install.sh | bash
```

- Back up the configured Herd data directory before upgrading. JSON-store and
  SQLite readiness checks run before the upgraded service is allowed to start.
- Installer-created archive checkouts can be refreshed by rerunning the pinned
  installer; durable state remains outside the application checkout.
- Legacy per-conversation local Claude pins are ignored or rejected. Choose
  the local Claude credential in Settings; select Codex or eligible remote
  credentials on the conversation.
- Cron schedules are now validated by the server. Invalid or incomplete drafts
  remain local instead of being persisted as runnable jobs.
- Railway deployments must retain their configured durable volume. Hosted
  images default to daemon-only provider execution unless the host is
  intentionally provider-ready.

## Verification

- Full CLI suite plus installer, release-runtime, JSON-store, SQLite-readiness,
  and launch contract tests.
- Application build, documentation checks, public artifact cleanliness, and
  documentation-link validation.
- Enterprise EC2 container smoke and exact Railway production-image lifecycle
  smoke.
- Exact GNU AGPLv3 license checksum, installer byte parity, and release-version
  pin checks.

## Source Traceability

- The public artifact is generated from the merged canonical source through
  SOP-15.
- The GitHub release records the exact canonical-source and public-artifact
  commit IDs used for publication.
